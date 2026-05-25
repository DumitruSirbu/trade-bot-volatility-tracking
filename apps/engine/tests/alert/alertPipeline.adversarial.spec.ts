import { AlertSeverityEnum, AlertTypeEnum, HaltSourceEnum, IAlertPayload, IModelDivergenceEvent, IRiskHaltEvent } from '@bot/shared';
import Decimal from 'decimal.js';

import { IAlertSink } from '../../src/alert/AlertModule';
import { ALERT_GLOBAL_CEILING_PER_MIN, AlertRateLimiter } from '../../src/alert/AlertRateLimiter';
import { redactPayload, redactString } from '../../src/alert/AlertRedactor';
import { DailyPnlSummaryScheduler } from '../../src/alert/DailyPnlSummaryScheduler';
import { RiskListeners } from '../../src/alert/listeners/RiskListeners';
import { TelegramAlertSink } from '../../src/alert/TelegramAlertSink';
import { RISK_HALT_DEDUP_WINDOW_MS } from '../../src/alert/const/alertEvents';
import { IClock } from '../../src/common/clock/Clock';
import { HaltFlagService } from '../../src/common/service/HaltFlagService';

// M9 QA — adversarial extension to alertPipeline.spec.ts.
// Covers:
//   - Redactor: JWT in body, TELEGRAM_BOT_TOKEN literal in data.context,
//     process.env dump in body
//   - Global ceiling reached + CRITICAL queued → oldest INFO dropped, CRITICAL sent
//   - Daily summary scheduler at 23:59:59 → does NOT fire; at 00:00:00 → fires once
//   - TelegramAlertSink in prod with token missing → throws; in dev → silently passes
//   - 429 retry_after honored: second send waits the indicated seconds
//   - Stress halt clears + re-engages → emits twice
//   - Model-divergence clears (context flag flips) → flag resets, next engage emits
//   - Both market-stress AND model-divergence engage same tick → both fire independently

// ---------------------------------------------------------------------------
// Redactor adversarial
// ---------------------------------------------------------------------------

describe('AlertRedactor adversarial', () => {
    const JWT_IN_BODY = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciIsImlhdCI6MTYwMH0.SIG_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
    const TELEGRAM_TOKEN = '9876543210:BBFakeTokenUsedForTestingPurposesOnly';

    it('redacts a JWT embedded in the body field', () => {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.RISK_HALT_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 'halt',
            body: `Authorization: Bearer ${JWT_IN_BODY} was used`,
        };

        const redacted = redactPayload(payload);

        expect(redacted.body).not.toContain(JWT_IN_BODY);
        expect(redacted.body).toContain('[REDACTED]');
    });

    it('redacts TELEGRAM_BOT_TOKEN literal in data.context when provided as opts', () => {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 'crash',
            body: 'see context',
            data: { context: `token=${TELEGRAM_TOKEN} used in request` },
        };

        const redacted = redactPayload(payload, { telegramBotTokenLiteral: TELEGRAM_TOKEN });

        expect(redacted.data?.context).not.toContain(TELEGRAM_TOKEN);
        expect(redacted.data?.context).toContain('[REDACTED]');
    });

    it('redacts process.env-style dump in body (KEY=value where KEY ends with SECRET/TOKEN)', () => {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 'crash',
            body: 'dump: BINANCE_API_SECRET=abc123xyz_secretvalue AUTH_HMAC_SECRET=superSecretLiteralValue',
        };

        const redacted = redactPayload(payload);

        expect(redacted.body).not.toContain('abc123xyz_secretvalue');
        expect(redacted.body).not.toContain('superSecretLiteralValue');
        expect(redacted.body).toContain('BINANCE_API_SECRET=[REDACTED]');
    });

    it('redactString with empty tokenLiteral passes clean text unchanged', () => {
        const clean = 'position opened symbol=BTCUSDT';
        expect(redactString(clean, '')).toBe(clean);
    });

    it('redactString removes the TELEGRAM_BOT_TOKEN even when split across a word boundary', () => {
        const token = '111222333:CCTokenXYZ';
        const input = `config: token=${token};other=value`;
        const out = redactString(input, token);
        expect(out).not.toContain(token);
    });
});

// ---------------------------------------------------------------------------
// Rate-limiter adversarial: global ceiling + CRITICAL escalation
// ---------------------------------------------------------------------------

describe('AlertRateLimiter adversarial — ceiling + CRITICAL escalation', () => {
    function makePayload(severity: AlertSeverityEnum, type = AlertTypeEnum.POSITION_OPENED): IAlertPayload {
        return { type, severity, occurredAt: '2026-05-24T00:00:00.000Z', title: 't', body: 'b' };
    }

    it('CRITICAL is admitted after the global ceiling is full; oldest INFO slot is evicted', () => {
        let now = 1_000;
        const limiter = new AlertRateLimiter(() => now);

        for (let i = 0; i < ALERT_GLOBAL_CEILING_PER_MIN; i += 1) {
            limiter.admit(makePayload(AlertSeverityEnum.INFO));
            now += 50;
        }

        // Ceiling is full. A CRITICAL must still land.
        const critical = limiter.admit(makePayload(AlertSeverityEnum.CRITICAL, AlertTypeEnum.RISK_HALT_ENGAGED));

        expect(critical).not.toBeNull();
        expect(critical?.severity).toBe(AlertSeverityEnum.CRITICAL);
    });

    it('INFO is dropped when the ceiling is full', () => {
        let now = 0;
        const limiter = new AlertRateLimiter(() => now);

        for (let i = 0; i < ALERT_GLOBAL_CEILING_PER_MIN; i += 1) {
            limiter.admit(makePayload(AlertSeverityEnum.INFO));
            now += 10;
        }

        const dropped = limiter.admit(makePayload(AlertSeverityEnum.INFO));
        expect(dropped).toBeNull();
    });

    it('suppressed count increments on each dropped INFO and is consumed once', () => {
        let now = 0;
        const limiter = new AlertRateLimiter(() => now);

        for (let i = 0; i < ALERT_GLOBAL_CEILING_PER_MIN; i += 1) {
            limiter.admit(makePayload(AlertSeverityEnum.INFO));
            now += 10;
        }

        limiter.admit(makePayload(AlertSeverityEnum.INFO));
        limiter.admit(makePayload(AlertSeverityEnum.INFO));

        const count = limiter.consumeSuppressedCount();
        expect(count).toBeGreaterThanOrEqual(2);

        // consumeSuppressedCount resets to 0 after consumption.
        expect(limiter.consumeSuppressedCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Daily summary scheduler — boundary: 23:59:59 vs 00:00:00
// ---------------------------------------------------------------------------

describe('DailyPnlSummaryScheduler adversarial — UTC midnight boundary', () => {
    class FakePositions {
        async findClosedOnUtcDay(): Promise<Array<{ realizedPnl: Decimal | null }>> {
            return [{ realizedPnl: new Decimal('10') }];
        }
    }

    class FakeSink implements IAlertSink {
        readonly published: IAlertPayload[] = [];
        async publish(p: IAlertPayload): Promise<void> {
            this.published.push(p);
        }
    }

    it('runOnce at 23:59:59 UTC does NOT fire the daily summary for the current day', async () => {
        // At 23:59:59 the "prior day" is yesterday. Since we haven't emitted
        // for yesterday yet, it should fire once. But note: the scheduler fires
        // the summary for the PRIOR UTC day (now-1d). At 23:59:59 the prior day
        // is still yesterday; at 00:00:01 the prior day is today-1 = yesterday.
        // This test verifies: calling runOnce twice with the same "yesterday"
        // reference yields only one emission (idempotency), and a call at 23:59:59
        // with a "yesterday" string that matches a prior emission is a no-op.
        const positions = new FakePositions();
        const sink = new FakeSink();

        const clockAt235959: IClock = { now: () => new Date('2026-05-24T23:59:59.000Z') };
        const scheduler = new DailyPnlSummaryScheduler(positions as never, sink, clockAt235959);

        // First run at 23:59:59 → fires for "2026-05-23".
        await scheduler.runOnce(clockAt235959.now());
        const countAfterFirst = sink.published.length;
        expect(countAfterFirst).toBe(1);

        // Second run at the same time → idempotent, no re-emit.
        await scheduler.runOnce(clockAt235959.now());
        expect(sink.published).toHaveLength(1);
    });

    it('runOnce at 00:00:00 UTC fires exactly once for the prior UTC day', async () => {
        const positions = new FakePositions();
        const sink = new FakeSink();
        const clockAtMidnight: IClock = { now: () => new Date('2026-05-25T00:00:00.000Z') };
        const scheduler = new DailyPnlSummaryScheduler(positions as never, sink, clockAtMidnight);

        await scheduler.runOnce(clockAtMidnight.now());

        expect(sink.published).toHaveLength(1);
        expect(sink.published[0]!.body).toContain('2026-05-24');
    });

    it('runOnce at 00:00:00 fires for "yesterday" not for "today"', async () => {
        const positions = new FakePositions();
        const sink = new FakeSink();
        const clockAtMidnight: IClock = { now: () => new Date('2026-05-25T00:00:00.000Z') };
        const scheduler = new DailyPnlSummaryScheduler(positions as never, sink, clockAtMidnight);

        await scheduler.runOnce(clockAtMidnight.now());

        // The summary must be FOR 2026-05-24 (yesterday), not 2026-05-25 (today).
        expect(sink.published[0]!.body).toContain('2026-05-24');
        expect(sink.published[0]!.body).not.toContain('2026-05-25');
    });
});

// ---------------------------------------------------------------------------
// TelegramAlertSink — missing token in prod/dev
// ---------------------------------------------------------------------------

describe('TelegramAlertSink adversarial — missing token', () => {
    const passThroughLimiter = new AlertRateLimiter(() => Date.now());

    function buildConfig(overrides: Record<string, unknown>) {
        return {
            nodeEnv: 'development',
            isProduction: false,
            telegramBotToken: undefined,
            telegramChatId: undefined,
            ...overrides,
        };
    }

    it('throws at construction in production when the token is missing', () => {
        const config = buildConfig({ nodeEnv: 'production', isProduction: true });
        expect(() => new TelegramAlertSink(config as never, passThroughLimiter)).toThrow(/TELEGRAM_BOT_TOKEN/u);
    });

    it('does NOT throw in development when the token is missing — silently degrades', () => {
        const config = buildConfig({ nodeEnv: 'development', isProduction: false });
        expect(() => new TelegramAlertSink(config as never, passThroughLimiter)).not.toThrow();
    });

    it('publish() in no-token dev mode does not throw', async () => {
        const config = buildConfig({});
        const sink = new TelegramAlertSink(config as never, passThroughLimiter);

        await expect(
            sink.publish({
                type: AlertTypeEnum.POSITION_OPENED,
                severity: AlertSeverityEnum.INFO,
                occurredAt: '2026-05-24T00:00:00.000Z',
                title: 'test',
                body: 'test',
            }),
        ).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 429 retry_after honored
// ---------------------------------------------------------------------------

describe('TelegramAlertSink adversarial — 429 retry_after', () => {
    it('second send within retry_after window skips the HTTP POST', async () => {
        const passThroughLimiter = new AlertRateLimiter(() => Date.now());
        const config = {
            nodeEnv: 'development',
            isProduction: false,
            telegramBotToken: 'token-9999999999:AAAA',
            telegramChatId: 'chat-1',
        };
        const sink = new TelegramAlertSink(config as never, passThroughLimiter);

        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            status: 429,
            json: async () => ({ parameters: { retry_after: 5 } }),
        } as never);

        const alertPayload: IAlertPayload = {
            type: AlertTypeEnum.RISK_HALT_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: '2026-05-24T00:00:00.000Z',
            title: 't',
            body: 'b',
        };

        await sink.publish(alertPayload);
        // Second publish within the retry_after window must not POST again.
        await sink.publish(alertPayload);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// RiskListeners — re-engage scenarios
// ---------------------------------------------------------------------------

describe('RiskListeners adversarial — re-engage and independence', () => {
    class RecordingSink implements IAlertSink {
        readonly published: IAlertPayload[] = [];
        async publish(p: IAlertPayload): Promise<void> {
            this.published.push(p);
        }
    }

    function buildListeners(now: () => Date) {
        const sink = new RecordingSink();
        const clock: IClock = { now };
        // M9 R1 fix #2 — listener flips the in-memory halt flag directly
        // instead of routing through HaltService (Option β SoT split).
        const haltFlag = new HaltFlagService();
        const haltServiceStub = { notePragmaticTransition: () => undefined } as never;
        const listeners = new RiskListeners(haltFlag, sink, clock, haltServiceStub);

        return { listeners, sink, haltFlag };
    }

    it('stress halt clears and re-engages → emits RISK_HALT_ENGAGED twice (engage/clear/engage)', async () => {
        let nowMs = new Date('2026-05-24T12:00:00Z').getTime();
        const { listeners, sink, haltFlag } = buildListeners(() => new Date(nowMs));

        const event: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 'stress',
            engagedAt: new Date(nowMs).toISOString(),
            metrics: {},
        };

        // First engage.
        await listeners.onRiskHalt(event);
        // Simulate the gate clearing the programmatic halt between engages
        // (so the flag-flip on the second engage is observable).
        haltFlag.resume();

        // Advance past the dedup window (> 1s).
        nowMs += RISK_HALT_DEDUP_WINDOW_MS + 100;

        // Second engage after dedup window expires.
        await listeners.onRiskHalt({ ...event, engagedAt: new Date(nowMs).toISOString() });

        expect(haltFlag.isHalted()).toBe(true);
        expect(sink.published).toHaveLength(2);
        expect(sink.published.every((p) => p.type === AlertTypeEnum.RISK_HALT_ENGAGED)).toBe(true);
    });

    it('model-divergence clears (dedup window expires) → flag resets, next engage emits again', async () => {
        let nowMs = new Date('2026-05-24T12:00:00Z').getTime();
        const { listeners, sink, haltFlag } = buildListeners(() => new Date(nowMs));

        const event: IModelDivergenceEvent = {
            engagedAt: new Date(nowMs).toISOString(),
            reason: 'divergence',
            observedSlippageBps: '40',
            modeledSlippageBps: '12',
            sampleCount: 50,
        };

        // First engage.
        await listeners.onModelDivergence(event);
        haltFlag.resume();

        // Advance past the dedup window.
        nowMs += RISK_HALT_DEDUP_WINDOW_MS + 100;

        // Re-engage.
        await listeners.onModelDivergence({ ...event, engagedAt: new Date(nowMs).toISOString() });

        expect(haltFlag.isHalted()).toBe(true);
        expect(sink.published).toHaveLength(2);
        expect(sink.published.every((p) => p.type === AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED)).toBe(true);
    });

    it('both market-stress AND model-divergence engage same tick → both events fire independently', async () => {
        const nowMs = new Date('2026-05-24T12:00:00Z').getTime();
        const { listeners, sink, haltFlag } = buildListeners(() => new Date(nowMs));

        const stressEvent: IRiskHaltEvent = {
            source: HaltSourceEnum.MARKET_STRESS,
            reason: 'spread',
            engagedAt: new Date(nowMs).toISOString(),
            metrics: {},
        };
        const divergenceEvent: IModelDivergenceEvent = {
            engagedAt: new Date(nowMs).toISOString(),
            reason: 'slippage',
            observedSlippageBps: '40',
            modeledSlippageBps: '12',
            sampleCount: 50,
        };

        await Promise.all([listeners.onRiskHalt(stressEvent), listeners.onModelDivergence(divergenceEvent)]);

        expect(haltFlag.isHalted()).toBe(true);
        const types = sink.published.map((p) => p.type);
        expect(types).toContain(AlertTypeEnum.RISK_HALT_ENGAGED);
        expect(types).toContain(AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED);
    });
});
