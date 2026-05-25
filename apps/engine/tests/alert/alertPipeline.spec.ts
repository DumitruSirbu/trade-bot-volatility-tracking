import {
    AlertSeverityEnum,
    AlertTypeEnum,
    ExitReasonEnum,
    HaltSourceEnum,
    HaltStateEnum,
    IAlertPayload,
    IModelDivergenceEvent,
    IRiskHaltEvent,
    PositionSideEnum,
} from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';

import { IAlertSink, NoopAlertSink } from '../../src/alert/AlertModule';
import { ALERT_GLOBAL_CEILING_PER_MIN, AlertRateLimiter } from '../../src/alert/AlertRateLimiter';
import { redactPayload, redactString } from '../../src/alert/AlertRedactor';
import { DailyPnlSummaryScheduler } from '../../src/alert/DailyPnlSummaryScheduler';
import { RiskListeners } from '../../src/alert/listeners/RiskListeners';
import { TelegramAlertSink } from '../../src/alert/TelegramAlertSink';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { HALT_CHANGED_EVENT, IHaltChangedEvent } from '../../src/control/const/controlEvents';
import { IClock } from '../../src/common/clock/Clock';
import { HaltService } from '../../src/control/HaltService';

// M9 W6 adversarial pipeline coverage. No DB, no real Telegram — every
// boundary is faked so the suite is deterministic + fast. Covers:
//
//   - Redactor: JWT in reason, env-dump in body.data, TELEGRAM_BOT_TOKEN
//     literal appearing anywhere.
//   - Rate-limiter: 30/min boundary (30th passes, 31st coalesced),
//     per-symbol 10s coalesce keeps-latest, ceiling+CRITICAL evicts oldest.
//   - DailyPnlSummaryScheduler: emits once per UTC day, idempotent if the
//     same day's clock tick repeats inside the same boot.
//   - TelegramAlertSink: missing token in production throws at construction,
//     missing token in dev degrades silently, 429 honours retry_after,
//     network failure logged + dropped.
//   - RiskListeners: M4 event → engageHalt called once + RISK_HALT_ENGAGED
//     alert fired + redactor applied; double-emit within 1s coalesced.
//   - HaltService bus emit: halt + resume each fire HALT_CHANGED_EVENT once.

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

describe('AlertRedactor', () => {
    const JWT_SAMPLE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIiLCJpYXQiOjE2MDAwMDAwMDB9.abcdefghijklmnopqrst';
    const TELEGRAM_TOKEN_LITERAL = '1234567890:AAFakeTokenLiteralDoNotLog';

    it('redacts a JWT-shaped substring inside the body', () => {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.RISK_HALT_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 'halt',
            body: `auth failed with token=${JWT_SAMPLE}`,
        };

        const redacted = redactPayload(payload);

        expect(redacted.body).toContain('[REDACTED]');
        expect(redacted.body).not.toContain(JWT_SAMPLE);
    });

    it('redacts process.env-shaped key=value dumps in data values', () => {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 'crash',
            body: 'see data',
            data: {
                stack: 'AUTH_SIGNING_SECRET=supersecretliteralvalueGoesHere1234567890ABCDEF',
            },
        };

        const redacted = redactPayload(payload);

        expect(redacted.data?.stack).toContain('AUTH_SIGNING_SECRET=[REDACTED]');
        expect(redacted.data?.stack).not.toContain('supersecretliteralvalue');
    });

    it('redacts the TELEGRAM_BOT_TOKEN literal anywhere it appears', () => {
        const out = redactString(`leaked here: ${TELEGRAM_TOKEN_LITERAL} mid-text`, TELEGRAM_TOKEN_LITERAL);

        expect(out).not.toContain(TELEGRAM_TOKEN_LITERAL);
        expect(out).toContain('[REDACTED]');
    });

    it('passes a short clean string through unchanged', () => {
        expect(redactString('symbol=BTCUSDT side=long', '')).toBe('symbol=BTCUSDT side=long');
    });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe('AlertRateLimiter', () => {
    function buildPayload(type: AlertTypeEnum, severity: AlertSeverityEnum, symbol?: string): IAlertPayload {
        return {
            type,
            severity,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 't',
            body: 'b',
            data: symbol === undefined ? undefined : { symbol },
        };
    }

    it('admits exactly 30 messages in a minute and coalesces the 31st when not per-symbol', () => {
        let now = 1_000;
        const limiter = new AlertRateLimiter(() => now);

        let admittedCount = 0;
        // POSITION_OPENED is not per-symbol coalescing.
        for (let i = 0; i < ALERT_GLOBAL_CEILING_PER_MIN; i += 1) {
            const out = limiter.admit(buildPayload(AlertTypeEnum.POSITION_OPENED, AlertSeverityEnum.INFO));
            if (out !== null) {
                admittedCount += 1;
            }
            now += 100;
        }

        expect(admittedCount).toBe(ALERT_GLOBAL_CEILING_PER_MIN);

        const over = limiter.admit(buildPayload(AlertTypeEnum.POSITION_OPENED, AlertSeverityEnum.INFO));
        expect(over).toBeNull();
        expect(limiter.consumeSuppressedCount()).toBeGreaterThan(0);
    });

    it('coalesces repeats of ORDER_REJECTED_TERMINAL per symbol within the 10s window', () => {
        let now = 5_000;
        const limiter = new AlertRateLimiter(() => now);

        const first = limiter.admit(buildPayload(AlertTypeEnum.ORDER_REJECTED_TERMINAL, AlertSeverityEnum.WARN, 'BTCUSDT'));
        expect(first).not.toBeNull();

        // Two repeats inside 10s window — should be suppressed.
        now += 1_000;
        expect(limiter.admit(buildPayload(AlertTypeEnum.ORDER_REJECTED_TERMINAL, AlertSeverityEnum.WARN, 'BTCUSDT'))).toBeNull();
        now += 1_000;
        expect(limiter.admit(buildPayload(AlertTypeEnum.ORDER_REJECTED_TERMINAL, AlertSeverityEnum.WARN, 'BTCUSDT'))).toBeNull();

        // After the window expires, a new emission is admitted again.
        now += 15_000;
        const after = limiter.admit(buildPayload(AlertTypeEnum.ORDER_REJECTED_TERMINAL, AlertSeverityEnum.WARN, 'BTCUSDT'));
        expect(after).not.toBeNull();
    });

    it('admits a CRITICAL even when the global ceiling is full, evicting an older slot', () => {
        let now = 10_000;
        const limiter = new AlertRateLimiter(() => now);

        for (let i = 0; i < ALERT_GLOBAL_CEILING_PER_MIN; i += 1) {
            limiter.admit(buildPayload(AlertTypeEnum.POSITION_OPENED, AlertSeverityEnum.INFO));
            now += 10;
        }

        const critical = limiter.admit(buildPayload(AlertTypeEnum.RISK_HALT_ENGAGED, AlertSeverityEnum.CRITICAL));

        expect(critical).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Daily PnL scheduler
// ---------------------------------------------------------------------------

describe('DailyPnlSummaryScheduler', () => {
    class FakePositions {
        constructor(private readonly rows: Array<{ realizedPnl: Decimal | null }>) {}

        async findClosedOnUtcDay(): Promise<Array<{ realizedPnl: Decimal | null }>> {
            return this.rows;
        }
    }

    class FakeSink implements IAlertSink {
        readonly published: IAlertPayload[] = [];
        async publish(p: IAlertPayload): Promise<void> {
            this.published.push(p);
        }
    }

    it('emits one DAILY_PNL_SUMMARY for the prior UTC day and is idempotent within the day', async () => {
        const positions = new FakePositions([
            { realizedPnl: new Decimal('12.50') },
            { realizedPnl: new Decimal('-5.00') },
            { realizedPnl: new Decimal('3.25') },
        ]);
        const sink = new FakeSink();
        const clock: IClock = { now: () => new Date('2026-05-24T00:00:00.000Z') };

        const scheduler = new DailyPnlSummaryScheduler(positions as never, sink, clock);

        await scheduler.runOnce(clock.now());
        await scheduler.runOnce(clock.now());

        expect(sink.published).toHaveLength(1);
        const payload = sink.published[0]!;
        expect(payload.type).toBe(AlertTypeEnum.DAILY_PNL_SUMMARY);
        expect(payload.body).toContain('2026-05-23');
        expect(payload.body).toContain('trades 3');
        expect(payload.body).toContain('2W/1L');
    });
});

// ---------------------------------------------------------------------------
// TelegramAlertSink
// ---------------------------------------------------------------------------

describe('TelegramAlertSink', () => {
    interface IFakeConfig {
        nodeEnv: string;
        isProduction: boolean;
        telegramBotToken: string | undefined;
        telegramChatId: string | undefined;
    }

    function buildConfig(overrides: Partial<IFakeConfig>): IFakeConfig {
        return {
            nodeEnv: 'development',
            isProduction: false,
            telegramBotToken: undefined,
            telegramChatId: undefined,
            ...overrides,
        };
    }

    const passThroughLimiter = new AlertRateLimiter(() => Date.now());

    it('throws at construction in production when the token is missing', () => {
        const config = buildConfig({ nodeEnv: 'production', isProduction: true });

        expect(() => new TelegramAlertSink(config as never, passThroughLimiter)).toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    it('degrades to noop in non-production when the token is missing — publish does not throw', async () => {
        const config = buildConfig({});
        const sink = new TelegramAlertSink(config as never, passThroughLimiter);

        await expect(
            sink.publish({
                type: AlertTypeEnum.POSITION_OPENED,
                severity: AlertSeverityEnum.INFO,
                occurredAt: '2026-05-24T00:00:00.000Z',
                title: 't',
                body: 'b',
            }),
        ).resolves.toBeUndefined();
    });

    it('honours retry_after on 429 by deferring the next send', async () => {
        const config = buildConfig({
            isProduction: false,
            telegramBotToken: 'token-1234567890ABC',
            telegramChatId: 'chat-42',
        });
        const sink = new TelegramAlertSink(config as never, passThroughLimiter);

        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            status: 429,
            json: async () => ({ parameters: { retry_after: 2 } }),
        } as never);

        await sink.publish({
            type: AlertTypeEnum.RISK_HALT_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 't',
            body: 'b',
        });

        // Second call within the retry-after window must skip the POST.
        await sink.publish({
            type: AlertTypeEnum.RISK_HALT_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 't',
            body: 'b',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockRestore();
    });

    it('logs and drops a network failure without throwing', async () => {
        const config = buildConfig({
            isProduction: false,
            telegramBotToken: 'token-1234567890ABC',
            telegramChatId: 'chat-42',
        });
        const sink = new TelegramAlertSink(config as never, passThroughLimiter);

        const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

        await expect(
            sink.publish({
                type: AlertTypeEnum.RISK_HALT_ENGAGED,
                severity: AlertSeverityEnum.CRITICAL,
                occurredAt: '2026-05-24T00:00:00.000Z',
                title: 't',
                body: 'b',
            }),
        ).resolves.toBeUndefined();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// RiskListeners
// ---------------------------------------------------------------------------

describe('RiskListeners', () => {
    class RecordingSink implements IAlertSink {
        readonly published: IAlertPayload[] = [];
        async publish(p: IAlertPayload): Promise<void> {
            this.published.push(p);
        }
    }

    function buildListeners(now: () => Date): { listeners: RiskListeners; sink: RecordingSink; haltFlag: HaltFlagService } {
        const sink = new RecordingSink();
        const clock: IClock = { now };
        // M9 R1 fix #2: listener now flips the in-memory halt flag directly
        // rather than calling HaltService.engageHalt (Option β SoT split).
        const haltFlag = new HaltFlagService();
        // M9 R2 — listener notes the in-memory transition on HaltService so
        // the read-API reports the right source; stubbed here as a no-op.
        const haltServiceStub = { notePragmaticTransition: () => undefined } as never;
        const listeners = new RiskListeners(haltFlag, sink, clock, haltServiceStub);

        return { listeners, sink, haltFlag };
    }

    it('flips the halt flag and fires a RISK_HALT_ENGAGED alert once on a programmatic halt', async () => {
        const now = new Date('2026-05-24T12:00:00Z');
        const { listeners, sink, haltFlag } = buildListeners(() => now);

        const event: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 'spread widened',
            engagedAt: now.toISOString(),
            metrics: { spreadBps: '120' },
        };

        await listeners.onRiskHalt(event);

        expect(haltFlag.isHalted()).toBe(true);
        expect(haltFlag.getReason()).toContain(HaltSourceEnum.MARKET_STRESS);
        expect(sink.published).toHaveLength(1);
        expect(sink.published[0]!.type).toBe(AlertTypeEnum.RISK_HALT_ENGAGED);
    });

    it('coalesces a repeat risk halt from the same source within 1s', async () => {
        let nowMs = new Date('2026-05-24T12:00:00Z').getTime();
        const { listeners, sink } = buildListeners(() => new Date(nowMs));

        const event: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 'spread widened',
            engagedAt: new Date(nowMs).toISOString(),
            metrics: {},
        };

        await listeners.onRiskHalt(event);
        nowMs += 500; // still inside the 1s dedup window
        await listeners.onRiskHalt(event);

        expect(sink.published).toHaveLength(1);
    });

    it('fires POSITION_CLOSED alert with realized PnL on the close event', async () => {
        const now = new Date('2026-05-24T12:00:00Z');
        const { listeners, sink } = buildListeners(() => now);

        await listeners.onPositionClosed({
            positionId: 42,
            symbol: 'BTCUSDT',
            side: PositionSideEnum.LONG,
            exitReason: ExitReasonEnum.STOP_LOSS,
            realizedPnl: new Decimal('-12.50') as never,
            closedAt: now,
        });

        expect(sink.published).toHaveLength(1);
        expect(sink.published[0]!.type).toBe(AlertTypeEnum.POSITION_CLOSED);
        expect(sink.published[0]!.body).toContain('BTCUSDT');
    });

    it('fires MODEL_DIVERGENCE_ENGAGED alert with sample data and flips the flag when divergence trips', async () => {
        const now = new Date('2026-05-24T12:00:00Z');
        const { listeners, sink, haltFlag } = buildListeners(() => now);

        const event: IModelDivergenceEvent = {
            engagedAt: now.toISOString(),
            reason: 'observed > 2x modeled',
            observedSlippageBps: '40',
            modeledSlippageBps: '12',
            sampleCount: 50,
        };

        await listeners.onModelDivergence(event);

        expect(haltFlag.isHalted()).toBe(true);
        expect(sink.published[0]!.type).toBe(AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED);
    });
});

// ---------------------------------------------------------------------------
// HaltService bus emit
// ---------------------------------------------------------------------------

describe('HaltService HALT_CHANGED_EVENT', () => {
    // Minimal hand-rolled fakes mirroring the shape HaltService exercises.
    function fakeAuditRow(
        id: string,
        action: 'halt' | 'resume',
    ): {
        id: string;
        occurredAt: string;
        actorSub: string;
        actorJti: string;
        sourceIp: null;
        action: 'halt' | 'resume';
        reason: string;
        flattenRequested: boolean;
        previousState: 'running' | 'halted';
        newState: 'running' | 'halted';
        correlationEventId: null;
    } {
        return {
            id,
            occurredAt: '2026-05-24T12:00:00.000Z',
            actorSub: 'op',
            actorJti: 'jti',
            sourceIp: null,
            action,
            reason: 'x',
            flattenRequested: false,
            previousState: action === 'halt' ? 'running' : 'halted',
            newState: action === 'halt' ? 'halted' : 'running',
            correlationEventId: null,
        };
    }

    it('emits HALT_CHANGED_EVENT once on halt and once on resume', async () => {
        const auditRepo = {
            appendOperator: jest
                .fn<Promise<ReturnType<typeof fakeAuditRow>>, [unknown]>()
                .mockResolvedValueOnce(fakeAuditRow('1', 'halt'))
                .mockResolvedValueOnce(fakeAuditRow('2', 'resume')),
        };

        let halted = false;
        const haltFlag = {
            isHalted: (): boolean => halted,
            halt: jest.fn((_: string) => {
                halted = true;
            }),
            resume: jest.fn(() => {
                halted = false;
            }),
            getReason: (): string => 'x',
        };

        const sink: IAlertSink = new NoopAlertSink();

        const flatten = {
            flattenAllOpen: jest.fn().mockResolvedValue({ requestedSymbols: [] }),
        };

        const events = new EventEmitter2();
        const captured: IHaltChangedEvent[] = [];
        events.on(HALT_CHANGED_EVENT, (e: IHaltChangedEvent) => captured.push(e));

        const service = new HaltService(auditRepo as never, haltFlag as never, sink, flatten as never, events);

        const now = new Date('2026-05-24T12:00:00.000Z');
        await service.engageHalt({
            source: HaltSourceEnum.OPERATOR,
            reason: 'x',
            actorSub: 'op',
            actorJti: 'jti',
            sourceIp: null,
            flatten: false,
            correlationEventId: null,
            now,
        });

        await service.resume({
            source: HaltSourceEnum.OPERATOR,
            reason: 'x',
            actorSub: 'op',
            actorJti: 'jti',
            sourceIp: null,
            correlationEventId: null,
            now,
        });

        expect(captured).toHaveLength(2);
        expect(captured[0]!.action).toBe('HALT');
        expect(captured[0]!.state).toBe(HaltStateEnum.HALTED);
        expect(captured[1]!.action).toBe('RESUME');
        expect(captured[1]!.state).toBe(HaltStateEnum.RUNNING);
    });
});
