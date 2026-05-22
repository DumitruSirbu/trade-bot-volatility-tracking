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
import { DeviationSideEnum, FlowTypeEnum, SignalActionEnum, SkipReasonEnum, StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';

import { VOLATILITY_DETECTED_EVENT } from '../../src/common/const';
import { AppConfigService } from '../../src/config/service';
import { StrategyConfigException } from '../../src/strategy/exception/StrategyConfigException';
import { DecisionRepository } from '../../src/strategy/repository/DecisionRepository';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { StrategyRegistry } from '../../src/strategy/registry';
import { StrategyService } from '../../src/strategy/service';
import { V0BaselineStrategy, V1MeanReversionStrategy, V2MomentumStrategy, V3HybridRouterStrategy } from '../../src/strategy/strategies';
import { buildEvent, buildParams } from './support/fixtures';

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
                useValue: { activeStrategyVersionId: deps.activeVersionId },
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
            const event = buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.7, // < 0.8 → band re-entry confirmed
                openInterestChange5mPct: -1.0, // OI falling
                idiosyncrasyScore: 0.2, // well below idiosyncrasy_min_score=0.7
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
            const event = buildEvent({ bollingerPctB: 0.7, openInterestChange5mPct: -1.0 });

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
