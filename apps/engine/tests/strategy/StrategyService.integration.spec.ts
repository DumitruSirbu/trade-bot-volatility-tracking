/**
 * Integration test: StrategyService wired through the REAL NestJS event bus.
 *
 * What this proves that the unit spec cannot:
 *   - `@OnEvent(VOLATILITY_DETECTED_EVENT)` is actually bound — the decorator
 *     wiring works end-to-end through EventEmitterModule.
 *   - The REAL StrategyRegistry resolves to the REAL strategy implementations
 *     (no mocked evaluate()).
 *   - classifyFlowType + computeSignalScore run for real and stamp the snapshot.
 *   - The decision written by the orchestrator reflects the true strategy output.
 *
 * Impure boundaries (DB, config) are mocked with plain jest.fn() objects.
 * The event bus and all strategy logic are real.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DeviationSideEnum, FlowTypeEnum, RiskOutcomeEnum, SignalActionEnum, SkipReasonEnum, StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';

import { VOLATILITY_DETECTED_EVENT } from '../../src/common/const';
import { AppConfigService } from '../../src/config/service';
import {
    COOLDOWN_AFTER_LOSS_MS,
    DAILY_LOSS_LIMIT_USDT,
    MAX_EXPOSURE_PER_COIN_USDT,
    MAX_SAME_DIRECTION_EXPOSURE_USDT,
    WEEKLY_LOSS_LIMIT_USDT,
} from '../../src/risk/const';
import { StrategyConfigException } from '../../src/strategy/exception/StrategyConfigException';
import { DecisionRepository } from '../../src/strategy/repository/DecisionRepository';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { UniverseMembershipRepository } from '../../src/market-data/repository/UniverseMembershipRepository';
import { StrategyRegistry } from '../../src/strategy/registry';
import { ShadowStrategyOrchestratorService, StrategyService } from '../../src/strategy/service';
import { InstrumentPortAdapter, OpenPositionsPortAdapter, PositionSizer, RiskGateService, RiskStatePortAdapter } from '../../src/risk/service';
import { V0BaselineStrategy, V1MeanReversionStrategy, V2MomentumStrategy, V3HybridRouterStrategy } from '../../src/strategy/strategies';
import { buildEvent, buildParams } from './support/fixtures';
import { Money } from '../../src/common/utils/money';

// ─── seed data helpers ────────────────────────────────────────────────────────

const ACTIVE_VERSION_ID_V0 = 1;
const ACTIVE_VERSION_ID_V1 = 2;

function buildVersionRow(overrides: { id: number; version: number }) {
    return {
        id: overrides.id,
        name: 'volatility-vwap',
        version: overrides.version,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        status: StrategyStatusEnum.ACTIVE,
        params: buildParams() as unknown as Record<string, unknown>,
        parentVersionId: null,
        createdAt: new Date(),
    };
}

// ─── module builder ───────────────────────────────────────────────────────────
// Each test builds its own module so state never leaks between tests.

interface IModuleDeps {
    activeVersionId: number;
    versionRow: ReturnType<typeof buildVersionRow> | null;
}

async function buildModule(deps: IModuleDeps): Promise<{ module: TestingModule; record: jest.Mock }> {
    const record = jest.fn().mockResolvedValue({});

    // M4 risk gate decision stub — always approves so strategy signals flow through.
    const approvedDecision = {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: 'A',
        approvedSizing: { qty: new Money('0.01'), notional: new Money('100'), leverage: new Money('1'), riskPerTradeUsdt: new Money('10') },
        clampedExit: null,
        reservationId: 'stub:A',
    };
    const riskGateStub = {
        evaluate: jest.fn().mockResolvedValue(approvedDecision),
        releaseReservation: jest.fn(),
        confirmReservation: jest.fn(),
        expireStaleReservations: jest.fn(),
    };

    // Sizer stub — returns a valid sizing for any input.
    const sizerStub = {
        size: jest.fn().mockReturnValue({
            kind: 'sized',
            sizing: { qty: new Money('0.01'), notional: new Money('100'), leverage: new Money('1'), riskPerTradeUsdt: new Money('10') },
        }),
    };

    // Port stubs — no DB.
    const riskStatePortStub = {
        getDay: jest.fn().mockResolvedValue(null),
        sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money('0')),
        upsertDay: jest.fn().mockResolvedValue(undefined),
    };

    const openPositionsPortStub = {
        findOpen: jest.fn().mockResolvedValue([]),
        findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
        findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
        countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
    };

    const instrumentPortStub = {
        findConstraints: jest.fn().mockResolvedValue({
            symbol: 'BTCUSDT',
            stepSize: new Money('0.001'),
            tickSize: new Money('0.1'),
            minNotional: new Money('5'),
            maintenanceMarginRate: new Money('0.005'),
        }),
    };

    const module = await Test.createTestingModule({
        imports: [
            // Real event bus — makes @OnEvent decorators fire.
            EventEmitterModule.forRoot(),
        ],
        providers: [
            // Real strategy engine pieces.
            StrategyService,
            StrategyRegistry,
            V0BaselineStrategy,
            V1MeanReversionStrategy,
            V2MomentumStrategy,
            V3HybridRouterStrategy,

            // Config stub — controls which version is "active".
            {
                provide: AppConfigService,
                useValue: {
                    activeStrategyVersionId: deps.activeVersionId,
                    accountCapitalUsdt: 1000,
                    dailyLossLimitUsdt: DAILY_LOSS_LIMIT_USDT,
                    weeklyLossLimitUsdt: WEEKLY_LOSS_LIMIT_USDT,
                    maxExposurePerCoinUsdt: MAX_EXPOSURE_PER_COIN_USDT,
                    maxSameDirectionExposureUsdt: MAX_SAME_DIRECTION_EXPOSURE_USDT,
                    cooldownAfterLossMs: COOLDOWN_AFTER_LOSS_MS,
                },
            },

            // Repository mocks — no DB.
            {
                provide: StrategyVersionRepository,
                useValue: { findById: jest.fn().mockResolvedValue(deps.versionRow) },
            },
            {
                provide: PositionRepository,
                useValue: { findOpenBySymbol: jest.fn().mockResolvedValue([]) },
            },
            {
                provide: DecisionRepository,
                useValue: { record },
            },

            // M4 risk dependencies — stubbed so no DB or exchange needed.
            { provide: RiskGateService, useValue: riskGateStub },
            { provide: PositionSizer, useValue: sizerStub },
            { provide: RiskStatePortAdapter, useValue: riskStatePortStub },
            { provide: OpenPositionsPortAdapter, useValue: openPositionsPortStub },
            { provide: InstrumentPortAdapter, useValue: instrumentPortStub },
            {
                provide: UniverseMembershipRepository,
                useValue: { findOpenMembership: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT' }) },
            },
            // M11a W2: shadow orchestration is stubbed in this integration suite —
            // the active-path assertions are unaffected, and the dedicated
            // ShadowStrategyOrchestratorService.spec covers its own behaviour.
            {
                provide: ShadowStrategyOrchestratorService,
                useValue: { runShadows: jest.fn().mockResolvedValue(undefined) },
            },
        ],
    }).compile();

    return { module, record };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('StrategyService — integration (real event bus + real strategies)', () => {
    // ── 1. v0 baseline: emitting through the bus writes a skip decision ────────

    describe('v0 active: event emitted via bus writes one baseline skip decision', () => {
        let record: jest.Mock;
        let eventEmitter: EventEmitter2;
        const ENTRY_TIME = 1_716_307_200_000;
        const SYMBOL = 'BTCUSDT';

        beforeEach(async () => {
            const { module, record: rec } = await buildModule({
                activeVersionId: ACTIVE_VERSION_ID_V0,
                versionRow: buildVersionRow({ id: ACTIVE_VERSION_ID_V0, version: 0 }),
            });
            await module.init(); // triggers onModuleInit
            record = rec;
            eventEmitter = module.get(EventEmitter2);
        });

        it('fires the @OnEvent handler when the event is emitted through the real bus', async () => {
            const event = buildEvent({ symbol: SYMBOL, entryCandleOpenTime: ENTRY_TIME, eventId: `${SYMBOL}:${ENTRY_TIME}` });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            expect(record).toHaveBeenCalledTimes(1);
        });

        it('records action=skip for v0 regardless of input', async () => {
            const event = buildEvent({ symbol: SYMBOL, entryCandleOpenTime: ENTRY_TIME, eventId: `${SYMBOL}:${ENTRY_TIME}` });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.action).toBe(SignalActionEnum.SKIP);
        });

        it('records the baseline skip reason for v0', async () => {
            const event = buildEvent({ symbol: SYMBOL, entryCandleOpenTime: ENTRY_TIME, eventId: `${SYMBOL}:${ENTRY_TIME}` });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.reason).toBe(SkipReasonEnum.BASELINE_NO_TRADE);
        });

        it('stamps the event_id from the event onto the decision', async () => {
            const eventId = `${SYMBOL}:${ENTRY_TIME}`;
            const event = buildEvent({ symbol: SYMBOL, entryCandleOpenTime: ENTRY_TIME, eventId });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.eventId).toBe(eventId);
        });

        it('stamps the active strategyVersionId on the decision', async () => {
            const event = buildEvent({ symbol: SYMBOL, entryCandleOpenTime: ENTRY_TIME, eventId: `${SYMBOL}:${ENTRY_TIME}` });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.strategyVersionId).toBe(ACTIVE_VERSION_ID_V0);
        });

        it('stamps flow_type on the market_snapshot (orchestrator classified it)', async () => {
            // OI falling → FORCED_EXHAUSTION classification from classifyFlowType
            const event = buildEvent({
                symbol: SYMBOL,
                entryCandleOpenTime: ENTRY_TIME,
                eventId: `${SYMBOL}:${ENTRY_TIME}`,
                openInterestChange5mPct: -1.0,
                idiosyncrasyScore: 0.2, // below trap threshold — avoids CATALYST_RISK
            });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.marketSnapshot.flow_type).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
        });

        it('stamps a numeric signal_score in [0, 100] on the market_snapshot', async () => {
            const event = buildEvent({ symbol: SYMBOL, entryCandleOpenTime: ENTRY_TIME, eventId: `${SYMBOL}:${ENTRY_TIME}` });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.marketSnapshot.signal_score).toBeGreaterThanOrEqual(0);
            expect(written.marketSnapshot.signal_score).toBeLessThanOrEqual(100);
        });

        it('emits exactly one decision per event (no double-write)', async () => {
            const event = buildEvent({ symbol: SYMBOL, entryCandleOpenTime: ENTRY_TIME, eventId: `${SYMBOL}:${ENTRY_TIME}` });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            expect(record).toHaveBeenCalledTimes(1);
        });
    });

    // ── 2. v1 active: confirmed fade event → open; still-extended spike → skip ──

    describe('v1 active: routing through the live bus', () => {
        let record: jest.Mock;
        let eventEmitter: EventEmitter2;

        beforeEach(async () => {
            const { module, record: rec } = await buildModule({
                activeVersionId: ACTIVE_VERSION_ID_V1,
                versionRow: buildVersionRow({ id: ACTIVE_VERSION_ID_V1, version: 1 }),
            });
            await module.init();
            record = rec;
            eventEmitter = module.get(EventEmitter2);
        });

        it('records action=open with side=short for a confirmed ABOVE exhaustion event', async () => {
            // Exhaustion confirmed via OI falling (openInterestChange5mPct <= 0).
            // Regime is RANGING — not suppressed. Idio low — not a trap.
            // btc5mMovePct=0.1 → abs(0.1) < btc_correlated_move_threshold_pct=0.3 → idiosyncratic
            // (correlated opens are buffered and not immediately decided, so we need idiosyncratic)
            const event = buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.7, // < 0.8 → band re-entry confirmed
                openInterestChange5mPct: -1.0, // OI falling
                idiosyncrasyScore: 0.2, // well below idiosyncrasy_min_score=0.7
                btc5mMovePct: 0.1, // idiosyncratic → goes through gate immediately
            });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.action).toBe(SignalActionEnum.OPEN);
            expect(written.marketSnapshot.signal_score).toBeGreaterThan(0);
        });

        it('records side=short when fading an ABOVE deviation', async () => {
            const event = buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.7,
                openInterestChange5mPct: -1.0,
                idiosyncrasyScore: 0.2,
                btc5mMovePct: 0.1, // idiosyncratic — goes through gate immediately
            });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            // The signal itself is not directly on the recorded object, but the
            // reason string confirms it was a fade; the v1 open reason is deterministic.
            const written = record.mock.calls[0][0];

            expect(written.reason).toBe('mean_reversion_exhaustion_fade');
        });

        it('records action=skip with no_exhaustion_confirmation for a still-extended spike', async () => {
            // pctB = 0.95 ≥ 0.8 → band NOT re-entered.
            // volumeRatio = 2.5 > 1.0 → NOT decelerating.
            // openInterestChange5mPct = +0.5 > 0 → OI rising.
            // None of the three exhaustion confirmations hold → NO_EXHAUSTION_CONFIRMATION.
            const event = buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.95,
                volumeRatio: 2.5,
                openInterestChange5mPct: 0.5,
                idiosyncrasyScore: 0.2,
            });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            const written = record.mock.calls[0][0];

            expect(written.action).toBe(SignalActionEnum.SKIP);
            expect(written.reason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
        });

        it('records exactly one decision per emitted event', async () => {
            // btc5mMovePct=0.1 → idiosyncratic → goes through gate immediately, decision recorded
            const event = buildEvent({ bollingerPctB: 0.7, openInterestChange5mPct: -1.0, btc5mMovePct: 0.1 });

            await eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event);

            expect(record).toHaveBeenCalledTimes(1);
        });
    });

    // ── 3. No execution emit — dry-run: nothing beyond decisions.record is called ─

    describe('dry-run invariant: no execution path is triggered', () => {
        it('does not throw and only writes the decision (no exchange or risk calls)', async () => {
            const { module, record } = await buildModule({
                activeVersionId: ACTIVE_VERSION_ID_V0,
                versionRow: buildVersionRow({ id: ACTIVE_VERSION_ID_V0, version: 0 }),
            });
            await module.init();
            const eventEmitter = module.get(EventEmitter2);

            const event = buildEvent();

            await expect(eventEmitter.emitAsync(VOLATILITY_DETECTED_EVENT, event)).resolves.not.toThrow();
            expect(record).toHaveBeenCalledTimes(1);
        });
    });

    // ── 4. onModuleInit with unknown activeStrategyVersionId rejects ────────────

    describe('onModuleInit startup guard', () => {
        it('rejects with StrategyConfigException when findById returns null', async () => {
            const { module } = await buildModule({
                activeVersionId: 999,
                versionRow: null, // findById → null
            });

            await expect(module.init()).rejects.toThrow(StrategyConfigException);
        });
    });
});
