import { FlowTypeEnum, PositionSideEnum, SignalActionEnum, SignalTypeEnum, SkipReasonEnum, StrategyDirectionEnum } from '@bot/shared';

import { StrategyConfigException } from '../../../src/strategy/exception/StrategyConfigException';
import { StrategyService } from '../../../src/strategy/service/StrategyService';
import { ISignal, IStrategyInput } from '../../../src/strategy/interface';
import { buildEvent, buildParams } from '../support/fixtures';

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
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: PositionSideEnum.SHORT,
        signalScore: 72,
        flowType: FlowTypeEnum.FORCED_EXHAUSTION,
        reason: 'mean_reversion_exhaustion_fade',
        proposedExit: null,
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

// Build plain mocks for all service dependencies
function buildMocks() {
    const config = {
        activeStrategyVersionId: 1,
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

    return { config, strategyVersions, positions, decisions, registry, strategyImpl };
}

function buildService(mocks: ReturnType<typeof buildMocks>): StrategyService {
    return new StrategyService(mocks.config as any, mocks.registry as any, mocks.strategyVersions as any, mocks.positions as any, mocks.decisions as any);
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

    describe('onVolatilityDetected — happy path', () => {
        async function setupAndTrigger(signal: ISignal, eventOverrides: Partial<ReturnType<typeof buildEvent>> = {}) {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 7 }));
            mocks.strategyImpl.evaluate.mockReturnValue(signal);
            const service = buildService(mocks);
            await service.onModuleInit();

            const event = buildEvent({ ...eventOverrides });
            await service.onVolatilityDetected(event);

            return { mocks, event };
        }

        it('writes exactly one decision per trigger', async () => {
            const { mocks } = await setupAndTrigger(makeSkipSignal());

            expect(mocks.decisions.record).toHaveBeenCalledTimes(1);
        });

        it('stamps the event eventId on the recorded decision', async () => {
            const { mocks } = await setupAndTrigger(makeSkipSignal(), {
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

        it('stamps the signal action on the recorded decision', async () => {
            const { mocks } = await setupAndTrigger(makeOpenSignal());

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.action).toBe(SignalActionEnum.OPEN);
        });

        it('stamps the signal reason on the recorded decision', async () => {
            const { mocks } = await setupAndTrigger(makeOpenSignal());

            const recorded = mocks.decisions.record.mock.calls[0][0];

            expect(recorded.reason).toBe('mean_reversion_exhaustion_fade');
        });

        it('stamps the signal signalType on the recorded decision', async () => {
            const { mocks } = await setupAndTrigger(makeSkipSignal());

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

            // The evaluate call receives a stamped event with flowType set
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
            const CANDLE_INTERVAL_MS = 5 * 60 * 1_000; // 5m in ms
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

    describe('onVolatilityDetected — no execution emit (dry-run)', () => {
        it('does not call any exchange or execution method', async () => {
            const mocks = buildMocks();
            mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
            const service = buildService(mocks);
            await service.onModuleInit();

            await service.onVolatilityDetected(buildEvent());

            // Only decisions.record and positions.findOpenBySymbol should be called
            // (no exchange/risk calls)
            expect(mocks.decisions.record).toHaveBeenCalledTimes(1);
            expect(mocks.positions.findOpenBySymbol).toHaveBeenCalledTimes(1);
        });
    });
});
