import {
    FlowTypeEnum,
    OrderIntentActionEnum,
    PositionSideEnum,
    RejectReasonEnum,
    RiskOutcomeEnum,
    SignalActionEnum,
    SignalTypeEnum,
    SkipReasonEnum,
    StrategyDirectionEnum,
} from '@bot/shared';

import { StrategyConfigException } from '../../../src/strategy/exception/StrategyConfigException';
import { StrategyService } from '../../../src/strategy/service/StrategyService';
import { ISignal, IStrategyInput } from '../../../src/strategy/interface';
import { buildEvent, buildParams } from '../support/fixtures';
import { Money } from '../../../src/common/utils/money';
import { buildSizing, buildProposedExit } from '../../risk/support/fixtures';
import {
    COOLDOWN_AFTER_LOSS_MS,
    DAILY_LOSS_LIMIT_USDT,
    MAX_EXPOSURE_PER_COIN_USDT,
    MAX_SAME_DIRECTION_EXPOSURE_USDT,
    WEEKLY_LOSS_LIMIT_USDT,
} from '../../../src/risk/const';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSkipSignal(): ISignal {
    return {
        action: SignalActionEnum.SKIP,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: SkipReasonEnum.BASELINE_NO_TRADE,
        tradeSide: null,
        signalScore: 55,
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        reason: SkipReasonEnum.BASELINE_NO_TRADE,
        proposedExit: null,
    };
}

function makeOpenSignal(): ISignal {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: PositionSideEnum.SHORT,
        signalScore: 72,
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        reason: 'mean_reversion_exhaustion_fade',
        proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
    };
}

function buildValidParams() {
    return buildParams();
}

function buildVersionRow(
    overrides: Partial<{
        id: number;
        name: string;
        version: number;
        direction: StrategyDirectionEnum;
        params: Record<string, unknown>;
    }> = {},
) {
    return {
        id: 1,
        name: 'volatility-vwap',
        version: 0,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        params: buildValidParams() as unknown as Record<string, unknown>,
        ...overrides,
    };
}

// Build plain mocks for all service dependencies (updated for M4 constructor)
function buildMocks() {
    const config = {
        activeStrategyVersionId: 1,
        accountCapitalUsdt: 1000,
        dailyLossLimitUsdt: DAILY_LOSS_LIMIT_USDT,
        weeklyLossLimitUsdt: WEEKLY_LOSS_LIMIT_USDT,
        maxExposurePerCoinUsdt: MAX_EXPOSURE_PER_COIN_USDT,
        maxSameDirectionExposureUsdt: MAX_SAME_DIRECTION_EXPOSURE_USDT,
        cooldownAfterLossMs: COOLDOWN_AFTER_LOSS_MS,
    };

    const strategyVersions = {
        findById: jest.fn(),
    };

    const positions = {
        findOpenBySymbol: jest.fn().mockResolvedValue([]),
    };

    const decisions = {
        record: jest.fn().mockResolvedValue({}),
    };

    const events = {
        emit: jest.fn(),
    };

    const strategyImpl = {
        name: 'volatility-vwap',
        version: 0,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        evaluate: jest.fn().mockReturnValue(makeSkipSignal()),
    };

    const registry = {
        resolve: jest.fn().mockReturnValue({
            strategy: strategyImpl,
            params: buildValidParams(),
        }),
    };

    // M4 risk dependencies
    const approvedDecision = {
        outcome: RiskOutcomeEnum.APPROVED,
        rejectReason: null,
        approvedSlot: 'A',
        approvedSizing: buildSizing(),
        clampedExit: buildProposedExit(),
        reservationId: 'test-event:A',
    };

    const riskGate = {
        evaluate: jest.fn().mockResolvedValue(approvedDecision),
        releaseReservation: jest.fn(),
        confirmReservation: jest.fn(),
        expireStaleReservations: jest.fn(),
    };

    const sizer = {
        size: jest.fn().mockReturnValue({ kind: 'sized', sizing: buildSizing() }),
    };

    const riskStatePort = {
        getDay: jest.fn().mockResolvedValue(null),
        sumRealizedPnlBetween: jest.fn().mockResolvedValue(new Money('0')),
        upsertDay: jest.fn().mockResolvedValue(undefined),
    };

    const openPositionsPort = {
        findOpen: jest.fn().mockResolvedValue([]),
        findClosedOnUtcDay: jest.fn().mockResolvedValue([]),
        findLastCloseForSymbol: jest.fn().mockResolvedValue(null),
        countOpenedOnUtcDayForSymbol: jest.fn().mockResolvedValue(0),
    };

    const instrumentPort = {
        findConstraints: jest.fn().mockResolvedValue({
            symbol: 'BTCUSDT',
            stepSize: new Money('0.001'),
            tickSize: new Money('0.1'),
            minNotional: new Money('5'),
            maintenanceMarginRate: new Money('0.005'),
        }),
    };

    const universe = {
        findOpenMembership: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT' }), // in universe
    };

    return {
        config,
        strategyVersions,
        positions,
        decisions,
        events,
        registry,
        strategyImpl,
        riskGate,
        sizer,
        riskStatePort,
        openPositionsPort,
        instrumentPort,
        universe,
    };
}

function buildService(mocks: ReturnType<typeof buildMocks>): StrategyService {
    return new StrategyService(
        mocks.config as any,
        mocks.registry as any,
        mocks.strategyVersions as any,
        mocks.positions as any,
        mocks.decisions as any,
        mocks.events as any,
        mocks.riskGate as any,
        mocks.sizer as any,
        mocks.riskStatePort as any,
        mocks.openPositionsPort as any,
        mocks.instrumentPort as any,
        mocks.universe as any,
    );
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('StrategyService', () => {
    describe('onModuleInit — startup validation', () => {
        it('resolves the active strategy when version row exists', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            const service = buildService(mocks);

            await expect(service.onModuleInit()).resolves.not.toThrow();
            expect(mocks.registry.resolve).toHaveBeenCalledWith('volatility-vwap', 0, expect.anything());
        });

        it('throws StrategyConfigException when version row is not found', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(null);
            const service = buildService(mocks);

            await expect(service.onModuleInit()).rejects.toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException when findById returns null for the configured id', async () => {
            const mocks = buildMocks();
            mocks.config.activeStrategyVersionId = 99;
            mocks.strategyVersions.findById.mockResolvedValue(null);
            const service = buildService(mocks);

            await expect(service.onModuleInit()).rejects.toThrow(StrategyConfigException);
        });
    });

    describe('onVolatilityDetected — skip signal path', () => {
        async function setupAndTriggerSkip(eventOverrides: Partial<ReturnType<typeof buildEvent>> = {}) {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 7 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeSkipSignal());
            const service = buildService(mocks);
            await service.onModuleInit();

            const event = buildEvent({ ...eventOverrides });
            await service.onVolatilityDetected(event);

            return { mocks, event };
        }

        it('writes exactly one decision per trigger', async () => {
            const { mocks } = await setupAndTriggerSkip();

            expect(mocks.decisions.record).toHaveBeenCalledTimes(1);
        });

        it('stamps the event eventId on the recorded decision', async () => {
            const { mocks } = await setupAndTriggerSkip({
                symbol: 'ETHUSDT',
                entryCandleOpenTime: 1_716_307_200_000,
                eventId: 'ETHUSDT:1716307200000',
            });

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.eventId).toBe('ETHUSDT:1716307200000');
        });

        it('stamps the active strategyVersionId on the recorded decision', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 42 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeSkipSignal());
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(buildEvent());

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.strategyVersionId).toBe(42);
        });

        it('stamps the signal action on the recorded decision for a skip', async () => {
            const { mocks } = await setupAndTriggerSkip();

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.action).toBe(SignalActionEnum.SKIP);
        });

        it('stamps the signal reason on the recorded decision', async () => {
            const { mocks } = await setupAndTriggerSkip();

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.reason).toBe(SkipReasonEnum.BASELINE_NO_TRADE);
        });

        it('stamps the signal signalType on the recorded decision', async () => {
            const { mocks } = await setupAndTriggerSkip();

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.signalType).toBe(SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS);
        });

        it('classifies flow_type once and stamps it on the snapshot before strategy runs', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            const service = buildService(mocks);
            await service.onModuleInit();

            const event = buildEvent({ openInterestChange5mPct: -1.0 }); // FORCED_EXHAUSTION
            await service.onVolatilityDetected(event);

            const evaluateArg: IStrategyInput = mocks.strategyImpl.evaluate.mock.calls[0][0];

            expect(evaluateArg.event.flowType).toBeDefined();
            expect(Object.values(FlowTypeEnum)).toContain(evaluateArg.event.flowType);
        });

        it('stamps signal_score on the snapshot before strategy runs', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(buildEvent());

            const evaluateArg: IStrategyInput = mocks.strategyImpl.evaluate.mock.calls[0][0];

            expect(evaluateArg.snapshot.signal_score).toBeGreaterThanOrEqual(0);
            expect(evaluateArg.snapshot.signal_score).toBeLessThanOrEqual(100);
        });

        it('passes null openPosition when no position is open', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            mocks.positions.findOpenBySymbol.mockResolvedValue([]);
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(buildEvent());

            const evaluateArg: IStrategyInput = mocks.strategyImpl.evaluate.mock.calls[0][0];

            expect(evaluateArg.openPosition).toBeNull();
        });

        it('sets nowMs = entryCandleOpenTime + CANDLE_INTERVAL_MS (deterministic clock)', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            const service = buildService(mocks);
            await service.onModuleInit();

            const entryCandleOpenTime = 1_716_307_200_000;
            const CANDLE_INTERVAL_MS = 5 * 60 * 1_000;
            await service.onVolatilityDetected(buildEvent({ entryCandleOpenTime }));

            const evaluateArg: IStrategyInput = mocks.strategyImpl.evaluate.mock.calls[0][0];

            expect(evaluateArg.nowMs).toBe(entryCandleOpenTime + CANDLE_INTERVAL_MS);
        });

        it('event_id on the recorded decision equals ${symbol}:${entryCandleOpenTime}', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            const service = buildService(mocks);
            await service.onModuleInit();

            const symbol = 'SOLUSDT';
            const entryCandleOpenTime = 1_716_400_000_000;
            const event = buildEvent({ symbol, entryCandleOpenTime, eventId: `${symbol}:${entryCandleOpenTime}` });

            await service.onVolatilityDetected(event);

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.eventId).toBe(`${symbol}:${entryCandleOpenTime}`);
        });
    });

    describe('onVolatilityDetected — ADD onto existing position (out of scope)', () => {
        it('records a skip with OUT_OF_SCOPE when an OPEN signal fires but a position is already open', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            // Simulate an existing open position for the symbol
            mocks.positions.findOpenBySymbol.mockResolvedValue([
                {
                    id: 1,
                    symbol: 'BTCUSDT',
                    side: PositionSideEnum.SHORT,
                    entryPrice: new Money('30000'),
                    qty: new Money('0.01'),
                    entryNotional: new Money('300'),
                    strategyVersionId: 1,
                    positionSlot: 'A',
                    openedAt: new Date(),
                    timeStopAt: null,
                },
            ]);
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            const recorded = mocks.decisions.record.mock.calls[0][0];
            expect(recorded.action).toBe(SignalActionEnum.SKIP);
            expect(recorded.reason).toBe(SkipReasonEnum.OUT_OF_SCOPE);
        });

        it('does NOT call riskGate when OPEN onto existing position (short-circuited before gate)', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            mocks.positions.findOpenBySymbol.mockResolvedValue([
                {
                    id: 1,
                    symbol: 'BTCUSDT',
                    side: PositionSideEnum.SHORT,
                    entryPrice: new Money('30000'),
                    qty: new Money('0.01'),
                    entryNotional: new Money('300'),
                    strategyVersionId: 1,
                    positionSlot: 'A',
                    openedAt: new Date(),
                    timeStopAt: null,
                },
            ]);
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
        });
    });

    describe('onVolatilityDetected — open signal path (gate wiring)', () => {
        it('calls riskGate.evaluate for an idiosyncratic OPEN signal', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            // Idiosyncratic correlation (btc5mMovePct below threshold)
            const event = buildEvent({
                btc5mMovePct: 0.1, // below btc_correlated_move_threshold_pct=0.3 → idiosyncratic
                bidAskSpreadPct: 0.05,
            });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            expect(mocks.riskGate.evaluate).toHaveBeenCalledTimes(1);
        });

        it('records the gate-approved action on the decision (open)', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            const recorded = mocks.decisions.record.mock.calls[0][0];
            expect(recorded.action).toBe(OrderIntentActionEnum.OPEN);
        });

        it('emits order.intent.approved event when gate approves', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            expect(mocks.events.emit).toHaveBeenCalledTimes(1);
        });

        it('does NOT emit order.intent.approved when gate rejects', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            mocks.riskGate.evaluate.mockResolvedValue({
                outcome: RiskOutcomeEnum.REJECTED,
                rejectReason: RejectReasonEnum.GLOBAL_HALT,
                approvedSlot: null,
                approvedSizing: null,
                clampedExit: null,
                reservationId: null,
            });
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            expect(mocks.events.emit).not.toHaveBeenCalled();
        });

        it('records the rejectReason as the decision reason when gate rejects', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            mocks.riskGate.evaluate.mockResolvedValue({
                outcome: RiskOutcomeEnum.REJECTED,
                rejectReason: RejectReasonEnum.MARKET_STRESS,
                approvedSlot: null,
                approvedSizing: null,
                clampedExit: null,
                reservationId: null,
            });
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            const recorded = mocks.decisions.record.mock.calls[0][0];
            expect(recorded.reason).toBe(RejectReasonEnum.MARKET_STRESS);
        });

        it('does NOT call riskGate for a correlated OPEN in the same bar (buffered)', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            // BTC large move → correlated
            const event = buildEvent({ btc5mMovePct: 1.5 }); // above btc_correlated_move_threshold_pct=0.3
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            // Correlated open is buffered, not immediately gated
            expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
            // No decision written yet for buffered correlated
            expect(mocks.decisions.record).not.toHaveBeenCalled();
        });
    });

    describe('onVolatilityDetected — BTC-correlated same-bar single-candidate flush', () => {
        it('flushes the previous bar and gates the highest-scoring candidate when a new bar arrives', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            const service = buildService(mocks);
            await service.onModuleInit();

            const BAR_1 = 1_716_307_200_000;
            const BAR_2 = BAR_1 + 5 * 60_000; // next bar

            const openSignalHigh: ISignal = { ...makeOpenSignal(), signalScore: 90 };
            const openSignalLow: ISignal = { ...makeOpenSignal(), signalScore: 40 };

            // First event in bar 1 — high score
            mocks.strategyImpl.evaluate.mockReturnValue(openSignalHigh);
            await service.onVolatilityDetected(
                buildEvent({
                    symbol: 'ETHUSDT',
                    entryCandleOpenTime: BAR_1,
                    eventId: `ETHUSDT:${BAR_1}`,
                    btc5mMovePct: 1.5, // correlated
                }),
            );

            // Second event in bar 1 — low score
            mocks.strategyImpl.evaluate.mockReturnValue(openSignalLow);
            await service.onVolatilityDetected(
                buildEvent({
                    symbol: 'SOLUSDT',
                    entryCandleOpenTime: BAR_1,
                    eventId: `SOLUSDT:${BAR_1}`,
                    btc5mMovePct: 1.5, // correlated
                }),
            );

            // Neither gated yet (still bar 1)
            expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();

            // Event from bar 2 triggers flush of bar 1
            mocks.strategyImpl.evaluate.mockReturnValue(makeSkipSignal());
            await service.onVolatilityDetected(
                buildEvent({
                    symbol: 'BTCUSDT',
                    entryCandleOpenTime: BAR_2,
                    eventId: `BTCUSDT:${BAR_2}`,
                    btc5mMovePct: 0.0, // idiosyncratic — goes straight through
                }),
            );

            // Gate called exactly once (for the best bar-1 correlated candidate)
            expect(mocks.riskGate.evaluate).toHaveBeenCalledTimes(1);
            // 3 decisions: best correlated gated (1) + rejected non-best (1) + bar-2 skip (1)
            expect(mocks.decisions.record).toHaveBeenCalledTimes(3);
        });

        it('the worst correlated candidate is rejected with btc_correlated_not_best_candidate', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            const service = buildService(mocks);
            await service.onModuleInit();

            const BAR_1 = 1_716_307_200_000;
            const BAR_2 = BAR_1 + 5 * 60_000;

            const highSignal: ISignal = { ...makeOpenSignal(), signalScore: 80 };
            const lowSignal: ISignal = { ...makeOpenSignal(), signalScore: 30 };

            mocks.strategyImpl.evaluate.mockReturnValue(highSignal);
            await service.onVolatilityDetected(buildEvent({ symbol: 'ETHUSDT', entryCandleOpenTime: BAR_1, eventId: `ETHUSDT:${BAR_1}`, btc5mMovePct: 1.5 }));

            mocks.strategyImpl.evaluate.mockReturnValue(lowSignal);
            await service.onVolatilityDetected(buildEvent({ symbol: 'SOLUSDT', entryCandleOpenTime: BAR_1, eventId: `SOLUSDT:${BAR_1}`, btc5mMovePct: 1.5 }));

            // Flush bar 1
            mocks.strategyImpl.evaluate.mockReturnValue(makeSkipSignal());
            await service.onVolatilityDetected(buildEvent({ symbol: 'BTCUSDT', entryCandleOpenTime: BAR_2, eventId: `BTCUSDT:${BAR_2}`, btc5mMovePct: 0 }));

            // Find the rejection decision
            const allCalls = mocks.decisions.record.mock.calls.map((c: any[]) => c[0]);
            const rejected = allCalls.find((d: any) => d.reason === RejectReasonEnum.BTC_CORRELATED_NOT_BEST_CANDIDATE);

            expect(rejected).toBeDefined();
        });
    });

    describe('onVolatilityDetected — open signal with below-min-notional sizing', () => {
        it('records a skip with MOVE_OUT_OF_BAND when the sizer returns below_min_notional', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            mocks.sizer.size.mockReturnValue({ kind: 'below_min_notional' });
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            const recorded = mocks.decisions.record.mock.calls[0][0];
            expect(recorded.action).toBe(SignalActionEnum.SKIP);
            expect(recorded.reason).toBe(SkipReasonEnum.MOVE_OUT_OF_BAND);
        });

        it('does NOT call the risk gate when sizer returns below_min_notional', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 1 }));
            mocks.strategyImpl.evaluate.mockReturnValue(makeOpenSignal());
            mocks.sizer.size.mockReturnValue({ kind: 'below_min_notional' });
            const event = buildEvent({ btc5mMovePct: 0.1 });
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(event);

            expect(mocks.riskGate.evaluate).not.toHaveBeenCalled();
        });
    });

    describe('onVolatilityDetected — dry-run: no exchange emission on skip', () => {
        it('does not emit any event for a skip signal', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            mocks.strategyImpl.evaluate.mockReturnValue(makeSkipSignal());
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(buildEvent());

            expect(mocks.events.emit).not.toHaveBeenCalled();
            expect(mocks.decisions.record).toHaveBeenCalledTimes(1);
        });
    });
});
