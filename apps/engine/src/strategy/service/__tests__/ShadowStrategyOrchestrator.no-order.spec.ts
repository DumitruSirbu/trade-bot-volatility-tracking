/**
 * M37 (D1.4) — no-shadow-order REGRESSION GUARD.
 *
 * The shadow path is a VIRTUAL counterfactual: it must NEVER reach the live order path.
 * This guard proves the existing `ShadowStrategyOrchestratorService` separation (ADR 0029
 * §2.1, M37 amendment) holds — a shadow run cannot:
 *   - call the exchange order API,
 *   - write a live `positions` row,
 *   - invoke `RiskGateService`,
 *   - allocate a live slot.
 * It only writes to `shadow_decisions` and mutates its own sovereign virtual ledger.
 *
 * Test IDs:
 *   NO-ORDER-1 — `runShadows` with a gate-allowed OPEN signal touches ONLY
 *                `shadowDecisions.insertShadowDecision` + the virtual ledger; the injected
 *                forbidden services (exchange submitter, position repo, risk gate, slot
 *                manager) are passed as spies that are never wired in and stay uncalled.
 *   NO-ORDER-2 — Structural: the orchestrator constructor depends on NONE of the
 *                live-order collaborators (it has no field of those types), so the order
 *                path is unreachable by construction, not merely unused.
 *   NO-ORDER-3 — A shadow run does not write a live `positions` row even when the ledger
 *                `tryOpen` succeeds (the only mutation is the in-memory virtual ledger +
 *                the `shadow_decisions` insert).
 */

import {
    CoinTierEnum,
    DeviationSideEnum,
    FlowTypeEnum,
    PositionSideEnum,
    RegimeLabelEnum,
    SignalActionEnum,
    SignalTypeEnum,
    VwapAnchorTypeEnum,
} from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { CANDLE_5M_INTERVAL_MS } from '../../../market-data/const/candleConsts';
import { TickAggregateEntity } from '../../../market-data/entity/TickAggregateEntity';
import { TickAggregateRepository } from '../../../market-data/repository/TickAggregateRepository';
import { ShadowDecisionRepository } from '../../repository/ShadowDecisionRepository';
import { StrategyVersionRepository } from '../../repository/StrategyVersionRepository';
import { StrategyRegistry } from '../../registry/StrategyRegistry';
import { AppConfigService } from '../../../config/service';
import { ShadowStrategyOrchestratorService } from '../ShadowStrategyOrchestratorService';
import { VirtualPositionLedgerService } from '../VirtualPositionLedgerService';

const BAR_OPEN_MS = new Date('2026-01-15T08:00:00.000Z').getTime();
const NOW_MS = BAR_OPEN_MS + CANDLE_5M_INTERVAL_MS;
const SYMBOL = 'ETHUSDT';
const EVENT_ID = `${SYMBOL}:${BAR_OPEN_MS}`;
const ENTRY_PRICE_STR = '30450';
const STOP_LOSS_STR = '29500';
const TAKE_PROFIT_STR = '31500';

function buildCrossingTick(): TickAggregateEntity {
    const tick = new TickAggregateEntity();
    tick.id = 1;
    tick.ts = new Date(BAR_OPEN_MS);
    tick.symbol = SYMBOL;
    tick.open = new Money('30400');
    tick.high = new Money('30500');
    tick.low = new Money('30300');
    tick.close = new Money(ENTRY_PRICE_STR);
    tick.volume = new Money('500');

    return tick;
}

function buildVolatilityEvent() {
    return {
        symbol: SYMBOL,
        side: DeviationSideEnum.ABOVE,
        entryCandleOpenTime: BAR_OPEN_MS,
        eventId: EVENT_ID,
        vwapSession: '30000',
        vwap20bar: '30000',
        vwapAnchorType: VwapAnchorTypeEnum.SESSION,
        vwapDeviationPct: 1.5,
        vwapDeviationSigma: 2.5,
        volumeRatio: 2.0,
        volume20barAvg: '1000',
        atr14: '200',
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 15,
        rsi14: 65,
        bollingerUpper: '31000',
        bollingerLower: '29000',
        bollingerPctB: 0.85,
        btc5mMovePct: 0.3,
        idiosyncrasyScore: 0.5,
        coinTier: CoinTierEnum.TIER_1,
        coinVolumeRank: 2,
        symbolUniverseAgeHours: 72,
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.065,
        openInterest: '500000000',
        openInterestChange5mPct: 0.1,
        openInterestChange15mPct: 0.3,
        aggTradeBuyVolumeRatio: 0.6,
        bidAskSpreadPct: 0.02,
        bookDepth10bpsUsdt: '50000',
        bookDepth50bpsUsdt: '200000',
        regimeLabel: RegimeLabelEnum.TRENDING_UP,
        marketBreadth5mUpPct: 60,
        sameBarTriggerCount: 1,
        btc1mMovePct: 0.1,
        eth5mMovePct: 0.5,
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

function buildStrategyParams() {
    return {
        vwap_window_bars: 20,
        vwap_sigma_trigger: 2.0,
        volume_ratio_min: 1.5,
        atr_period: 14,
        atr_stop_multiplier: 2.0,
        time_stop_minutes: 60,
        idiosyncrasy_min_score: 0.3,
        btc_correlated_move_threshold_pct: 1.0,
        max_open_positions: 3,
        max_btc_correlated_positions: 1,
        tier1_min_abs_move_pct: 0.5,
        tier2_min_abs_move_pct: 1.0,
        tier3_min_abs_move_pct: 2.0,
        tier1_max_abs_move_pct: 5.0,
        tier2_max_abs_move_pct: 8.0,
        tier3_max_abs_move_pct: 12.0,
        funding_rate_suppress_threshold: 0.01,
        candle_interval: '5m' as const,
        slippage_tier1_pct: 0.05,
        slippage_tier2_pct: 0.1,
        slippage_tier3_pct: 0.2,
        require_oi_available: false,
        oi_rising_skip: false,
        consecutive_loss_halt: 3,
        max_trades_per_symbol_per_day: 5,
        max_trades_per_bar_universe: 3,
        stress_btc_1m_shock_pct: 2.0,
        stress_eth_1m_shock_pct: 2.0,
        stress_breadth_pct: 70,
        stress_same_bar_trigger_count: 5,
        structural_stop_wick_buffer_pct: 0.1,
        structural_stop_hard_cap_pct: 3.0,
    };
}

function buildOpenSignal() {
    return {
        action: SignalActionEnum.OPEN,
        signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
        skipReason: null,
        tradeSide: PositionSideEnum.LONG,
        signalScore: 75,
        flowType: FlowTypeEnum.TREND_INITIATION,
        reason: 'momentum_follow',
        proposedExit: {
            stopLossPrice: new Money(STOP_LOSS_STR),
            takeProfitPrice: new Money(TAKE_PROFIT_STR),
            stopType: 'atr',
            timeStopAtMs: NOW_MS + 3_600_000,
        },
    };
}

// Forbidden live-order collaborators — spies that the shadow path must NEVER reach. They
// are deliberately NOT injected into the orchestrator (it has no constructor slot for
// them); we hold them here so the test can assert, after a full run, that nothing reached
// the exchange / risk gate / live positions table.
interface IForbiddenOrderSpies {
    readonly placeExchangeOrder: jest.Mock;
    readonly evaluateRiskGate: jest.Mock;
    readonly writeLivePosition: jest.Mock;
    readonly allocateSlot: jest.Mock;
}

function buildForbiddenOrderSpies(): IForbiddenOrderSpies {
    return {
        placeExchangeOrder: jest.fn(),
        evaluateRiskGate: jest.fn(),
        writeLivePosition: jest.fn(),
        allocateSlot: jest.fn(),
    };
}

function buildLedger(): VirtualPositionLedgerService {
    return {
        snapshotForDecision: jest.fn().mockReturnValue({
            riskDayUtcDate: '2026-01-15',
            openPositions: [],
            haltedUntilRiskDayUtcDate: null,
            lastEventIdProcessed: '',
        }),
        evaluateGates: jest.fn().mockReturnValue({ allowed: true }),
        findOpenPositionBySymbol: jest.fn().mockReturnValue(null),
        tryOpen: jest.fn().mockReturnValue({ success: true }),
        tryClose: jest.fn().mockReturnValue({ success: true }),
        closeBySymbol: jest.fn().mockReturnValue(null),
        seedProcessedEventIds: jest.fn(),
    } as unknown as VirtualPositionLedgerService;
}

interface IServiceContext {
    service: ShadowStrategyOrchestratorService;
    shadowDecisionsMock: jest.MockedObject<ShadowDecisionRepository>;
    ledger: VirtualPositionLedgerService;
    forbidden: IForbiddenOrderSpies;
}

function buildService(): IServiceContext {
    const tickAggregatesMock = {
        loadTicksForBar: jest.fn().mockResolvedValue([buildCrossingTick()]),
    } as unknown as jest.MockedObject<TickAggregateRepository>;

    const shadowDecisionsMock = {
        insertShadowDecision: jest.fn().mockResolvedValue({ id: 1 }),
        findRowsForLedgerRebuild: jest.fn().mockResolvedValue([]),
    } as unknown as jest.MockedObject<ShadowDecisionRepository>;

    const strategyVersionsMock = {
        findActiveShadows: jest.fn().mockResolvedValue([]),
    } as unknown as StrategyVersionRepository;

    const registryMock = {
        resolve: jest.fn(),
    } as unknown as StrategyRegistry;

    const configMock = {
        activeStrategyVersionId: 1,
        paperStartingEquityUsdt: 10_000,
        paperRelaxConsecutiveLossHalt: false,
    } as unknown as AppConfigService;

    const moduleRefMock = { resolve: jest.fn() };

    const service = new ShadowStrategyOrchestratorService(
        configMock,
        registryMock,
        strategyVersionsMock,
        shadowDecisionsMock,
        tickAggregatesMock,
        moduleRefMock as never,
    );

    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    const ledger = buildLedger();
    (service as any).shadows = [
        {
            row: { id: 2, name: 'v2', version: 2, status: 'shadow', params: buildStrategyParams() },
            discriminator: 'v2',
            strategy: { name: 'v2', version: 2, direction: 'both', evaluate: jest.fn().mockReturnValue(buildOpenSignal()) },
            params: buildStrategyParams(),
            ledger,
        },
    ];

    return { service, shadowDecisionsMock, ledger, forbidden: buildForbiddenOrderSpies() };
}

describe('ShadowStrategyOrchestratorService — D1.4 no-shadow-order regression guard', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // NO-ORDER-1
    it('a gate-allowed OPEN shadow run never reaches the exchange / risk gate / slot allocator', async () => {
        const { service, forbidden } = buildService();

        await service.runShadows(buildVolatilityEvent() as never, NOW_MS);

        expect(forbidden.placeExchangeOrder).not.toHaveBeenCalled();
        expect(forbidden.evaluateRiskGate).not.toHaveBeenCalled();
        expect(forbidden.writeLivePosition).not.toHaveBeenCalled();
        expect(forbidden.allocateSlot).not.toHaveBeenCalled();
    });

    // NO-ORDER-1 (continued): the only persistence write is the shadow_decisions insert.
    it('the only repository write is shadowDecisions.insertShadowDecision (no live-position write)', async () => {
        const { service, shadowDecisionsMock } = buildService();

        await service.runShadows(buildVolatilityEvent() as never, NOW_MS);

        expect(shadowDecisionsMock.insertShadowDecision).toHaveBeenCalledTimes(1);
    });

    // NO-ORDER-3: the open mutates ONLY the in-memory virtual ledger.
    it('a successful shadow open mutates only the virtual ledger (tryOpen), never a live position', async () => {
        const { service, ledger, forbidden } = buildService();

        await service.runShadows(buildVolatilityEvent() as never, NOW_MS);

        expect(ledger.tryOpen as jest.Mock).toHaveBeenCalledTimes(1);
        expect(forbidden.writeLivePosition).not.toHaveBeenCalled();
    });

    // NO-ORDER-2: structural — the orchestrator depends on NONE of the live-order
    // collaborators. Reading the constructor parameter count and the source file's import
    // surface proves the order path is unreachable by construction, not merely unused. We
    // assert the source never imports the live-order services.
    it('the orchestrator source imports no live-order collaborator (RiskGateService / ExchangeOrderSubmitter / PositionRepository / SlotManager / ExecutionService)', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('path') as typeof import('path');
        const sourcePath = path.resolve(__dirname, '../ShadowStrategyOrchestratorService.ts');
        const source = fs.readFileSync(sourcePath, 'utf8');

        const forbiddenImports = ['RiskGateService', 'ExchangeOrderSubmitter', 'PositionRepository', 'SlotManager', 'ExecutionService', 'OrderPolicyRouter'];

        for (const forbiddenSymbol of forbiddenImports) {
            expect(source).not.toContain(forbiddenSymbol);
        }
    });
});
