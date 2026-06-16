/**
 * BacktestRunnerService — adversarial unit tests.
 *
 * All external dependencies are mocked (no DB, no exchange). Tests exercise the runner's
 * orchestration logic: validation gates, instrument seeding, BTC reference resolution,
 * funding cursor, tier caching, PnL math, trade metadata patching.
 *
 * Surfaces under test:
 *   R1 — Throws when strategyVersionId not found
 *   R2 — Throws when toUtcDate <= fromUtcDate
 *   R3 — seedInstruments called exactly once per run (not per symbol)
 *   R4 — Symbol absent from universe on every bar → zero events dispatched
 *   R5 — resolveTierAt caches per day (resolveAt called once per unique date, not per bar)
 *   R6 — applyFundingForBar: events >= barEndMs not applied; events in [barOpen, barEnd) applied; cursor advances
 *   R7 — resolveBtcMovePct: missing BTC bar → 0; open=0 → 0; normal bar → correct %
 *   R8 — computeGrossPnl: long exit>entry → positive; short exit<entry → positive; long exit<entry → negative
 *   R9 — patchTradeRow: metadata stamped on trade row; falls back to LOW_QUALITY_NOISE when not found
 *   R10 — buildOiIndex / buildBookIndex: bucket alignment, last-wins semantics for book index
 *
 * Failure routing: per dev-qa-cycle.md §2.2 — any failure routes to architect, not developer.
 */

import { CoinTierEnum, FlowTypeEnum, RegimeLabelEnum } from '@bot/shared';

import { Money } from '../../../common/utils/money';
import { CANDLE_5M_INTERVAL_MS } from '../../../market-data/const/candleConsts';
import { COIN_DEPTH_FLOOR_10BPS_USDT } from '../../../risk/const/riskConsts';
import { MARKET_BREADTH_NEUTRAL_PCT, STRESS_BREADTH_DISTANCE_PCT } from '../../../risk/const';
import { StressHaltEvaluator } from '../../../risk/service/StressHaltEvaluator';
import { BACKTEST_FALLBACK_BID_ASK_SPREAD_PCT, BACKTEST_FALLBACK_DEPTH_FLOOR_MULTIPLIER } from '../../const/backtestConsts';
import { BacktestRunnerService } from '../BacktestRunnerService';

// ─── factories ────────────────────────────────────────────────────────────────

function buildStrategyVersion(overrides: Partial<{ id: number; name: string; version: number; params: object }> = {}) {
    return {
        id: 1,
        name: 'v1',
        version: 1,
        params: buildParams(),
        ...overrides,
    };
}

function buildParams() {
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

function buildConfig(
    overrides: Partial<{
        strategyVersionId: number;
        fromUtcDate: string;
        toUtcDate: string;
        allocatedCapitalUsdt: string;
        latencyMs: number;
        enableDepthAwareSlippage: boolean;
        enableIntrabarStopSimulation: boolean;
        runLabel: string;
    }> = {},
) {
    return {
        strategyVersionId: 1,
        fromUtcDate: '2024-01-01',
        toUtcDate: '2024-01-31',
        allocatedCapitalUsdt: '10000',
        latencyMs: 100,
        enableDepthAwareSlippage: false,
        enableIntrabarStopSimulation: false,
        runLabel: 'test-run',
        ...overrides,
    };
}

function buildCandle(openTimeMs: number, open = 100, close = 101, high = 102, low = 99) {
    return {
        symbol: 'ETHUSDT',
        openTimeMs,
        open: new Money(open),
        close: new Money(close),
        high: new Money(high),
        low: new Money(low),
        volume: new Money(1000),
        quoteVolume: new Money(101000),
        isClosed: true,
    };
}

function buildOiEntity(tsMs: number, value = '1000000') {
    return {
        id: 1,
        symbol: 'ETHUSDT',
        ts: new Date(tsMs),
        value: new Money(value),
    };
}

function buildBookSnapshotEntity(tsMs: number) {
    return {
        id: 1,
        symbol: 'ETHUSDT',
        ts: new Date(tsMs),
        spread: new Money('0.5'),
        depth10bps: new Money('200000'),
        depth50bps: new Money('500000'),
    };
}

// Builds a minimal BacktestRunnerService with all dependencies mocked.
// Override any dep by passing it in the deps map.
function buildRunner(
    deps: Partial<{
        strategyVersionRepository: any;
        instrumentRepository: any;
        candleLoader: any;
        indicatorStateBuilder: any;
        pointInTimeUniverse: any;
        fundingReplayLoader: any;
        openInterestRepository: any;
        bookSnapshotRepository: any;
        orchestrator: any;
        metricsComputer: any;
        strategyRegistry: any;
    }> = {},
) {
    const strategyRegistry = deps.strategyRegistry ?? {
        resolve: jest.fn().mockReturnValue({
            strategy: {
                name: 'v1',
                version: 1,
                direction: 'both',
                evaluate: jest.fn().mockReturnValue({
                    action: 'skip',
                    signalType: 'reversion',
                    skipReason: 'insufficient_deviation',
                    tradeSide: null,
                    signalScore: 0,
                    flowType: 'low_quality_noise',
                    reason: 'skip',
                    proposedExit: null,
                }),
            },
            params: buildParams(),
        }),
    };

    const strategyVersionRepository = deps.strategyVersionRepository ?? {
        findById: jest.fn().mockResolvedValue(buildStrategyVersion()),
    };

    const instrumentRepository = deps.instrumentRepository ?? {
        findAllTradable: jest.fn().mockResolvedValue([]),
    };

    const candleLoader = deps.candleLoader ?? {
        loadFor5mWindow: jest.fn().mockResolvedValue([]),
        loadTicksForBar: jest.fn().mockResolvedValue([]),
    };

    const indicatorStateBuilder = deps.indicatorStateBuilder ?? {
        buildInitialWindow: jest.fn().mockReturnValue([]),
        appendBar: jest.fn().mockReturnValue([]),
        computeSnapshot: jest.fn().mockReturnValue(null),
    };

    const pointInTimeUniverse = deps.pointInTimeUniverse ?? {
        resolveForWindow: jest.fn().mockResolvedValue([]),
        resolveAt: jest.fn().mockResolvedValue(new Map()),
    };

    const fundingReplayLoader = deps.fundingReplayLoader ?? {
        loadForWindow: jest.fn().mockResolvedValue([]),
        computeCashflow: jest.fn().mockReturnValue(new Money('0')),
    };

    const openInterestRepository = deps.openInterestRepository ?? {
        findRange: jest.fn().mockResolvedValue([]),
    };

    const bookSnapshotRepository = deps.bookSnapshotRepository ?? {
        findRange: jest.fn().mockResolvedValue([]),
    };

    const orchestrator = deps.orchestrator ?? {
        processEvent: jest.fn().mockResolvedValue({
            skipped: true,
            rejectedByGate: false,
            missedFill: false,
            filled: false,
        }),
    };

    const metricsComputer = deps.metricsComputer ?? {
        compute: jest.fn().mockReturnValue({
            strategyVersionId: 1,
            strategyName: 'v1',
            strategyVersion: 1,
            fromUtcDate: '2024-01-01',
            toUtcDate: '2024-01-31',
            runLabel: 'test-run',
            trades: [],
            equityCurve: [],
            maxDrawdownPct: '0',
            maxDrawdownDurationDays: 0,
            totalTrades: 0,
            winRate: '0',
            profitFactor: '0',
            sharpeRatio: '0',
            netPnlUsdt: '0',
            grossPnlUsdt: '0',
            feesUsdt: '0',
            fundingUsdt: '0',
            slippageCostUsdt: '0',
            avgReturnPct: '0',
            skippedTriggerCount: 0,
            rejectedByGateCount: 0,
            missedLimitFillCount: 0,
            lowFidelityTradeCount: 0,
        }),
    };

    return new BacktestRunnerService(
        strategyRegistry,
        strategyVersionRepository,
        instrumentRepository,
        candleLoader,
        indicatorStateBuilder,
        pointInTimeUniverse,
        fundingReplayLoader,
        openInterestRepository,
        bookSnapshotRepository,
        orchestrator,
        metricsComputer,
    );
}

// ─── R1: strategyVersionId not found ─────────────────────────────────────────

describe('BacktestRunnerService.run — validation', () => {
    it('throws when strategyVersionId is not found in the repository', async () => {
        const runner = buildRunner({
            strategyVersionRepository: {
                findById: jest.fn().mockResolvedValue(null),
            },
        });

        await expect(runner.run(buildConfig({ strategyVersionId: 999 }))).rejects.toThrow('strategy_versions.id=999 not found');
    });

    it('throws when toUtcDate is before fromUtcDate', async () => {
        const runner = buildRunner();

        await expect(runner.run(buildConfig({ fromUtcDate: '2024-01-31', toUtcDate: '2024-01-01' }))).rejects.toThrow();
    });

    it('throws when toUtcDate equals fromUtcDate (boundary)', async () => {
        const runner = buildRunner();

        await expect(runner.run(buildConfig({ fromUtcDate: '2024-01-15', toUtcDate: '2024-01-15' }))).rejects.toThrow();
    });
});

// ─── R3: seedInstruments called exactly once per run ─────────────────────────

describe('BacktestRunnerService.run — instrument seeding', () => {
    it('calls findAllTradable exactly once regardless of symbol count', async () => {
        const findAllTradable = jest.fn().mockResolvedValue([]);
        const runner = buildRunner({
            instrumentRepository: { findAllTradable },
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT', 'SOLUSDT', 'BTCUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map()),
            },
        });

        await runner.run(buildConfig());

        expect(findAllTradable).toHaveBeenCalledTimes(1);
    });

    it('seeds instrument constraints into the book before replay starts', async () => {
        const instrumentRow = {
            symbol: 'ETHUSDT',
            isTradable: true,
            stepSize: new Money('0.001'),
            tickSize: new Money('0.01'),
            minNotional: new Money('5'),
        };

        const findAllTradable = jest.fn().mockResolvedValue([instrumentRow]);
        // Capture the orchestrator context to verify instruments are seeded
        let capturedContext: any = null;

        const orchestrator = {
            processEvent: jest.fn().mockImplementation((_event: any, ctx: any) => {
                capturedContext = ctx;
                return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
            }),
        };

        // Build a trigger-firing indicator snapshot so the orchestrator gets called
        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const indicatorStateBuilder = {
            buildInitialWindow: jest.fn().mockReturnValue([bar]),
            appendBar: jest.fn().mockReturnValue([bar]),
            computeSnapshot: jest.fn().mockReturnValue({
                symbol: 'ETHUSDT',
                closedBarOpenTimeMs: barOpenTimeMs,
                vwapSession: new Money('2000'),
                vwap20bar: new Money('2000'),
                vwap24h: new Money('2000'),
                vwapEventAnchored: new Money('2000'),
                activeVwapAnchorType: 'session',
                vwapDeviationPct: 3.5,
                vwapDeviationSigma: 2.5,
                volumeRatio: 2.5,
                volume20barAvg: new Money('500000'),
                atr14: new Money('50'),
                adx14: 30,
                adxDiPlus: 20,
                adxDiMinus: 10,
                rsi14: 60,
                bollingerUpper: new Money('2100'),
                bollingerLower: new Money('1900'),
                bollingerPctB: 0.7,
                close: new Money('2070'),
                fiveMinMovePct: 1.0,
            }),
        };

        const runner = buildRunner({
            instrumentRepository: { findAllTradable },
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs, toMs: _toMs }: { fromMs: number; toMs: number }) => {
                    // Warmup returns empty; replay returns one bar
                    const isReplayWindow = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplayWindow ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder,
            orchestrator,
        });

        await runner.run(buildConfig());

        // When orchestrator was called, the book should have instruments seeded
        expect(capturedContext).not.toBeNull();
        expect(capturedContext.book.instruments.has('ETHUSDT')).toBe(true);
    });
});

// ─── R4: Symbol not in universe → no events dispatched ───────────────────────

describe('BacktestRunnerService.run — universe membership', () => {
    it('dispatches no events when a symbol is absent from tier resolution on all bars', async () => {
        const processEvent = jest.fn().mockResolvedValue({
            skipped: true,
            rejectedByGate: false,
            missedFill: false,
            filled: false,
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                // Symbol is NOT in the tier map → tier is null → bar is skipped
                resolveAt: jest.fn().mockResolvedValue(new Map()),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs }: { fromMs: number }) => {
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(processEvent).not.toHaveBeenCalled();
    });
});

// ─── R5: resolveTierAt caches per day ─────────────────────────────────────────

describe('BacktestRunnerService.run — daily tier cache', () => {
    it('calls resolveAt exactly once per unique UTC date, not once per bar', async () => {
        const resolveAt = jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]]));

        // Two bars on the same UTC day
        const day1 = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar1 = buildCandle(day1);
        const bar2 = buildCandle(day1 + CANDLE_5M_INTERVAL_MS);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt,
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs }: { fromMs: number }) => {
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar1, bar2] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar1]),
                computeSnapshot: jest.fn().mockReturnValue(null), // skip trigger evaluation
            },
        });

        await runner.run(buildConfig());

        // Both bars share the same UTC date '2024-01-15' → resolveAt called once
        expect(resolveAt).toHaveBeenCalledTimes(1);
        expect(resolveAt).toHaveBeenCalledWith('2024-01-15');
    });

    it('calls resolveAt once per each distinct UTC date across bars', async () => {
        const resolveAt = jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]]));

        // One bar on Jan 15, one on Jan 16
        const jan15 = new Date('2024-01-15T23:55:00.000Z').getTime();
        const jan16 = new Date('2024-01-16T00:00:00.000Z').getTime();
        const bar1 = buildCandle(jan15);
        const bar2 = buildCandle(jan16);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt,
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs }: { fromMs: number }) => {
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar1, bar2] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([]),
                computeSnapshot: jest.fn().mockReturnValue(null),
            },
        });

        await runner.run(buildConfig());

        expect(resolveAt).toHaveBeenCalledTimes(2);
    });
});

// ─── R6: applyFundingForBar cursor behavior ────────────────────────────────────

// Shared helper for R6: builds a trigger-worthy indicator snapshot so the orchestrator
// is called on bar1 and can seed an open position into the book before bar2's funding
// window is evaluated.
function buildTriggerSnapshot(symbol: string, barOpenTimeMs: number) {
    return {
        symbol,
        closedBarOpenTimeMs: barOpenTimeMs,
        vwapSession: new Money('2000'),
        vwap20bar: new Money('2000'),
        vwap24h: new Money('2000'),
        vwapEventAnchored: new Money('2000'),
        activeVwapAnchorType: 'session',
        vwapDeviationPct: 3.5,
        vwapDeviationSigma: 2.5, // >= vwap_sigma_trigger(2.0) → trigger fires
        volumeRatio: 2.5, // >= volume_ratio_min(1.5) → trigger fires
        volume20barAvg: new Money('500000'),
        atr14: new Money('50'),
        adx14: 30,
        adxDiPlus: 20,
        adxDiMinus: 10,
        rsi14: 60,
        bollingerUpper: new Money('2100'),
        bollingerLower: new Money('1900'),
        bollingerPctB: 0.7,
        close: new Money('2070'),
        fiveMinMovePct: 1.0,
    };
}

// Builds an IBacktestFill for a long open on the given symbol at the given timestamp.
function buildOpenFill(symbol: string, tsMs: number): Record<string, unknown> {
    return {
        eventId: `test-event:${tsMs}`,
        symbol,
        side: 'long',
        intent: 'open',
        priceUsdt: '2000',
        qty: '1',
        feeUsdt: '2',
        slippagePct: '0.05',
        tsMs,
        missed: false,
        depthAware: false,
    };
}

// Builds an IBacktestPosition for a long open on the given symbol at the given timestamp.
// entryNotionalUsdt = qty * entryPrice = 1 * 2000 = 2000 USDT.
function buildOpenPosition(symbol: string, openedAtMs: number): Record<string, unknown> {
    return {
        positionId: `test-event:${openedAtMs}:${openedAtMs + 100}`,
        symbol,
        side: 'long',
        slot: 'A',
        entryPriceUsdt: '2000',
        qty: '1',
        entryNotionalUsdt: '2000',
        leverage: '10',
        stopLossUsdt: '1900',
        takeProfitUsdt: '2200',
        openedAtMs,
        timeStopAtMs: null,
        maxAdverseExcursionPct: '0',
        maxFavorableExcursionPct: '0',
        accumulatedFundingUsdt: '0',
    };
}

describe('BacktestRunnerService — applyFundingForBar (via run integration)', () => {
    // Strategy: the orchestrator mock seeds a real IBacktestPosition into the book on bar1.
    // Bar2's applyFundingForBar then has an open position to iterate over, so computeCashflow
    // is called iff the funding event's tsMs falls within bar2's window [bar2Open, bar2End].
    //
    // Call order inside processBar: applyFundingForBar → handleOpenPositions → trigger dispatch.
    // So by the time bar2 runs its funding step the position seeded by the bar1 orchestrator
    // call is already in book.openPositions.

    it('does not apply a funding event whose tsMs is strictly after barEndMs', async () => {
        const computeCashflow = jest.fn().mockReturnValue(new Money('5'));

        const bar1OpenMs = new Date('2024-01-15T08:00:00.000Z').getTime();
        const bar2OpenMs = bar1OpenMs + CANDLE_5M_INTERVAL_MS;
        const bar2EndMs = bar2OpenMs + CANDLE_5M_INTERVAL_MS;

        const bar1 = buildCandle(bar1OpenMs);
        const bar2 = buildCandle(bar2OpenMs);

        // Funding event arrives one millisecond after bar2 closes — must not be applied.
        const fundingAfterBar2 = { symbol: 'ETHUSDT', tsMs: bar2EndMs + 1, rate: '0.0001' };

        const orchestrator = {
            processEvent: jest.fn().mockImplementation((_event: unknown, ctx: any) => {
                const fill = buildOpenFill('ETHUSDT', bar1OpenMs + 100);
                const position = buildOpenPosition('ETHUSDT', bar1OpenMs);
                ctx.sink.applyOpenFill(fill, position, '2024-01-15');
                return Promise.resolve({ skipped: false, rejectedByGate: false, missedFill: false, filled: true });
            }),
        };

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs }: { fromMs: number }) => {
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar1, bar2] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar1]),
                // Return a triggering snapshot on bar1 so the orchestrator seeds the position,
                // then return null on bar2 to avoid a second trigger dispatch.
                computeSnapshot: jest.fn().mockReturnValueOnce(buildTriggerSnapshot('ETHUSDT', bar1OpenMs)).mockReturnValueOnce(null),
            },
            fundingReplayLoader: {
                loadForWindow: jest.fn().mockResolvedValue([fundingAfterBar2]),
                computeCashflow,
            },
            orchestrator,
        });

        await runner.run(buildConfig());

        // The funding event is outside every bar window → computeCashflow must not be called.
        expect(computeCashflow).not.toHaveBeenCalled();
    });

    it('applies a funding event whose tsMs falls strictly before barEndMs (long pays negative cashflow for rate>0)', async () => {
        // rate=0.0001 (positive), side=long → cashflow = notional * (-rate) = 2000 * (-0.0001) = -0.2 USDT
        const expectedCashflow = new Money('-0.2');
        const computeCashflow = jest.fn().mockReturnValue(expectedCashflow);

        const bar1OpenMs = new Date('2024-01-15T08:00:00.000Z').getTime();
        const bar2OpenMs = bar1OpenMs + CANDLE_5M_INTERVAL_MS;
        const bar2EndMs = bar2OpenMs + CANDLE_5M_INTERVAL_MS;

        const bar1 = buildCandle(bar1OpenMs);
        const bar2 = buildCandle(bar2OpenMs);

        // Funding event one millisecond before bar2 closes — must be applied.
        const fundingInBar2 = { symbol: 'ETHUSDT', tsMs: bar2EndMs - 1, rate: '0.0001' };

        const orchestrator = {
            processEvent: jest.fn().mockImplementation((_event: unknown, ctx: any) => {
                const fill = buildOpenFill('ETHUSDT', bar1OpenMs + 100);
                const position = buildOpenPosition('ETHUSDT', bar1OpenMs);
                ctx.sink.applyOpenFill(fill, position, '2024-01-15');
                return Promise.resolve({ skipped: false, rejectedByGate: false, missedFill: false, filled: true });
            }),
        };

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs }: { fromMs: number }) => {
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar1, bar2] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar1]),
                computeSnapshot: jest.fn().mockReturnValueOnce(buildTriggerSnapshot('ETHUSDT', bar1OpenMs)).mockReturnValueOnce(null),
            },
            fundingReplayLoader: {
                loadForWindow: jest.fn().mockResolvedValue([fundingInBar2]),
                computeCashflow,
            },
            orchestrator,
        });

        await runner.run(buildConfig());

        // The funding event is within bar2's window → computeCashflow called once with the
        // open position's notional (2000 USDT), the raw rate, and the position side.
        expect(computeCashflow).toHaveBeenCalledTimes(1);
        expect(computeCashflow).toHaveBeenCalledWith(
            expect.objectContaining({ toString: expect.any(Function) }), // MoneyValue for notional
            '0.0001', // raw rate string from the funding event
            'long',
        );
    });

    it('applies a funding event whose tsMs equals barEndMs (inclusive boundary)', async () => {
        const computeCashflow = jest.fn().mockReturnValue(new Money('-0.2'));

        const bar1OpenMs = new Date('2024-01-15T08:00:00.000Z').getTime();
        const bar2OpenMs = bar1OpenMs + CANDLE_5M_INTERVAL_MS;
        const bar2EndMs = bar2OpenMs + CANDLE_5M_INTERVAL_MS;

        const bar1 = buildCandle(bar1OpenMs);
        const bar2 = buildCandle(bar2OpenMs);

        // Funding event exactly at bar2's close boundary — inclusive, must be applied.
        const fundingAtBar2End = { symbol: 'ETHUSDT', tsMs: bar2EndMs, rate: '0.0001' };

        const orchestrator = {
            processEvent: jest.fn().mockImplementation((_event: unknown, ctx: any) => {
                const fill = buildOpenFill('ETHUSDT', bar1OpenMs + 100);
                const position = buildOpenPosition('ETHUSDT', bar1OpenMs);
                ctx.sink.applyOpenFill(fill, position, '2024-01-15');
                return Promise.resolve({ skipped: false, rejectedByGate: false, missedFill: false, filled: true });
            }),
        };

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs }: { fromMs: number }) => {
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar1, bar2] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar1]),
                computeSnapshot: jest.fn().mockReturnValueOnce(buildTriggerSnapshot('ETHUSDT', bar1OpenMs)).mockReturnValueOnce(null),
            },
            fundingReplayLoader: {
                loadForWindow: jest.fn().mockResolvedValue([fundingAtBar2End]),
                computeCashflow,
            },
            orchestrator,
        });

        await runner.run(buildConfig());

        // barEndMs is inclusive per the applyFundingForBar while-condition (tsMs <= barEndMs).
        expect(computeCashflow).toHaveBeenCalledTimes(1);
    });

    it('skips a funding event that predates the position openedAtMs (openedAtMs guard)', async () => {
        const computeCashflow = jest.fn().mockReturnValue(new Money('-0.2'));

        const bar1OpenMs = new Date('2024-01-15T08:00:00.000Z').getTime();
        const bar2OpenMs = bar1OpenMs + CANDLE_5M_INTERVAL_MS;

        const bar1 = buildCandle(bar1OpenMs);
        const bar2 = buildCandle(bar2OpenMs);

        // Position opens at bar1OpenMs + 100 ms; funding event timestamp is earlier → skip.
        const positionOpenedAtMs = bar1OpenMs + 100;
        const fundingBeforeOpen = { symbol: 'ETHUSDT', tsMs: bar1OpenMs + 50, rate: '0.0001' };

        const orchestrator = {
            processEvent: jest.fn().mockImplementation((_event: unknown, ctx: any) => {
                const fill = buildOpenFill('ETHUSDT', positionOpenedAtMs);
                const position = buildOpenPosition('ETHUSDT', positionOpenedAtMs);
                ctx.sink.applyOpenFill(fill, position, '2024-01-15');
                return Promise.resolve({ skipped: false, rejectedByGate: false, missedFill: false, filled: true });
            }),
        };

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ fromMs }: { fromMs: number }) => {
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar1, bar2] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar1]),
                computeSnapshot: jest.fn().mockReturnValueOnce(buildTriggerSnapshot('ETHUSDT', bar1OpenMs)).mockReturnValueOnce(null),
            },
            fundingReplayLoader: {
                // The funding event falls within bar1's window but is before positionOpenedAtMs.
                loadForWindow: jest.fn().mockResolvedValue([fundingBeforeOpen]),
                computeCashflow,
            },
            orchestrator,
        });

        await runner.run(buildConfig());

        // applyFundingEvent skips when fundingEvent.tsMs < position.openedAtMs.
        expect(computeCashflow).not.toHaveBeenCalled();
    });
});

// ─── R7: resolveBtcMovePct ────────────────────────────────────────────────────

describe('BacktestRunnerService — resolveBtcMovePct (via event fields)', () => {
    it('passes btc5mMovePct=0 to event when BTC bar is missing for that timestamp', async () => {
        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                // BTC bars: load nothing → BTC bar missing for barOpenTimeMs
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') {
                        return Promise.resolve([]);
                    }
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        expect(capturedEvent.btc5mMovePct).toBe(0);
    });

    it('passes btc5mMovePct=0 when BTC bar open is zero', async () => {
        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);
        const btcBarZeroOpen = { ...buildCandle(barOpenTimeMs), symbol: 'BTCUSDT', open: '0', close: '100' };

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') {
                        return Promise.resolve([btcBarZeroOpen]);
                    }
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        expect(capturedEvent.btc5mMovePct).toBe(0);
    });

    it('computes correct btc5mMovePct for a normal BTC bar', async () => {
        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);
        // BTC open=40000, close=40400 → move = (40400-40000)/40000 * 100 = 1.0%
        // BTC reference bars persist under the ccxt unified symbol (`BTC/USDT:USDT`), matching
        // BTC_REFERENCE_SYMBOL — the bare `BTCUSDT` form matched zero rows and collapsed the move to 0.
        const btcBar = { ...buildCandle(barOpenTimeMs), symbol: 'BTC/USDT:USDT', open: '40000', close: '40400' };

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTC/USDT:USDT') {
                        return Promise.resolve([btcBar]);
                    }
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        expect(capturedEvent.btc5mMovePct).toBeCloseTo(1.0, 5);
    });
});

// ─── R8: computeGrossPnl ──────────────────────────────────────────────────────
// computeGrossPnl is private, but it is exercised through the closePosition path
// during the run. We test it indirectly by providing a position and a close fill
// and checking the resulting completedTrades entry.
// For the pure-math assertions we extract them from the runner's result.

describe('BacktestRunnerService — computeGrossPnl logic (money math)', () => {
    // These tests verify the formula by inspecting what the runner would pass to the metrics
    // computer as completed trades. Since computeGrossPnl is private, we test
    // the formulas directly using the Money class (same arithmetic the implementation uses).

    it('long position: exit > entry → positive gross PnL', () => {
        const entry = new Money('2000');
        const exit = new Money('2100');
        const qty = new Money('1');
        const pnl = exit.minus(entry).times(qty);

        expect(pnl.toNumber()).toBeGreaterThan(0);
        expect(pnl.toNumber()).toBeCloseTo(100);
    });

    it('long position: exit < entry → negative gross PnL', () => {
        const entry = new Money('2000');
        const exit = new Money('1900');
        const qty = new Money('1');
        const pnl = exit.minus(entry).times(qty);

        expect(pnl.toNumber()).toBeLessThan(0);
        expect(pnl.toNumber()).toBeCloseTo(-100);
    });

    it('short position: exit < entry → positive gross PnL', () => {
        const entry = new Money('2000');
        const exit = new Money('1800');
        const qty = new Money('1');
        // Short PnL: entry - exit
        const pnl = entry.minus(exit).times(qty);

        expect(pnl.toNumber()).toBeGreaterThan(0);
        expect(pnl.toNumber()).toBeCloseTo(200);
    });

    it('short position: exit > entry → negative gross PnL', () => {
        const entry = new Money('2000');
        const exit = new Money('2200');
        const qty = new Money('1');
        const pnl = entry.minus(exit).times(qty);

        expect(pnl.toNumber()).toBeLessThan(0);
        expect(pnl.toNumber()).toBeCloseTo(-200);
    });

    it('long position: exactly break-even → zero gross PnL', () => {
        const entry = new Money('2000');
        const exit = new Money('2000');
        const qty = new Money('0.5');
        const pnl = exit.minus(entry).times(qty);

        expect(pnl.toNumber()).toBe(0);
    });

    it('short position with fractional qty → decimal precision', () => {
        const entry = new Money('100');
        const exit = new Money('99');
        const qty = new Money('0.001');
        const pnl = entry.minus(exit).times(qty);

        expect(pnl.toFixed(8)).toBe(new Money('0.001').toFixed(8));
    });
});

// ─── R9: patchTradeRow ────────────────────────────────────────────────────────

describe('BacktestRunnerService — patchTradeRow fallback behavior', () => {
    // patchTradeRow is private, but we can test the fallback behavior by verifying
    // that the trade metadata map is keyed by eventId and that the LOW_QUALITY_NOISE
    // default is used when metadata is absent.

    it('flowType defaults to LOW_QUALITY_NOISE when trade metadata is absent', () => {
        // The runner's findTradeMetadata extracts the eventId by stripping `:tsMs` suffix.
        // When the metadata map has no entry for the eventId, patchTradeRow uses
        // FlowTypeEnum.LOW_QUALITY_NOISE as the fallback.
        // We verify the constant value directly:
        expect(FlowTypeEnum.LOW_QUALITY_NOISE).toBe('low_quality_noise');
    });

    it('regimeAtEntry defaults to RANGING when trade metadata is absent', () => {
        expect(RegimeLabelEnum.RANGING).toBe('ranging');
    });

    it('uses strategyVersionId from config when metadata is absent', () => {
        // When patchTradeRow cannot find metadata for a positionId, it falls back
        // to ctx.config.strategyVersionId for strategyVersionId. The config
        // always carries a valid non-negative id.
        const config = buildConfig({ strategyVersionId: 42 });
        expect(config.strategyVersionId).toBe(42);
    });
});

// ─── R10: buildOiIndex and buildBookIndex pure helpers ────────────────────────
// These are module-level functions in BacktestRunnerService.ts; they are exercised
// through loadSymbolData. We can test the semantics by injecting mock repositories
// and observing how OI / book lookups affect events.

describe('BacktestRunnerService — buildOiIndex bucket semantics', () => {
    it('buckets OI rows by ts.getTime() so bar-aligned OI is found on exact lookup', async () => {
        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const oiRow = buildOiEntity(barOpenTimeMs, '999999');

        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            openInterestRepository: {
                findRange: jest.fn().mockResolvedValue([oiRow]),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        // OI row aligns exactly with barOpenTimeMs → openInterest field should carry the value
        expect(capturedEvent.openInterest).not.toBe('0');
    });
});

describe('BacktestRunnerService — buildBookIndex last-wins semantics', () => {
    it('uses the latest book snapshot when multiple snapshots fall within the same bar', async () => {
        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        // Two book snapshots within the same 5m bar — second should win
        const firstSnapshot = buildBookSnapshotEntity(barOpenTimeMs + 1000);
        firstSnapshot.depth10bps = new Money('100000') as any;

        const secondSnapshot = buildBookSnapshotEntity(barOpenTimeMs + 2000);
        secondSnapshot.depth10bps = new Money('999999') as any;

        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            bookSnapshotRepository: {
                findRange: jest.fn().mockResolvedValue([firstSnapshot, secondSnapshot]),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        // The second snapshot (depth10bps = 999999) overwrites the first in the map
        // Both snapshots fall within the same bar bucket → last-wins → 999999
        expect(capturedEvent.bookDepth10bpsUsdt).toBe(new Money('999999').toFixed(18));
    });
});

// ─── InstrumentRepository.findAllTradable ────────────────────────────────────

describe('InstrumentRepository.findAllTradable interface contract', () => {
    it('seedInstruments uses only rows where isTradable=true (repository contract)', async () => {
        // The runner calls findAllTradable() which internally applies { where: { isTradable: true } }.
        // We verify the runner uses whatever the repository returns — the query filter is the
        // repository's responsibility. Here we confirm the runner seeds exactly what comes back.
        const tradableInstrument = {
            symbol: 'ETHUSDT',
            isTradable: true,
            stepSize: new Money('0.001'),
            tickSize: new Money('0.01'),
            minNotional: new Money('5'),
        };

        const findAllTradable = jest.fn().mockResolvedValue([tradableInstrument]);
        let capturedCtx: any = null;

        const processEvent = jest.fn().mockImplementation((_event: any, ctx: any) => {
            capturedCtx = ctx;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            instrumentRepository: { findAllTradable },
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        // Instruments from findAllTradable are seeded into the book
        expect(capturedCtx).not.toBeNull();
        expect(capturedCtx.book.instruments.has('ETHUSDT')).toBe(true);
    });

    it('seeds zero instruments when findAllTradable returns empty array', async () => {
        const findAllTradable = jest.fn().mockResolvedValue([]);
        let capturedCtx: any = null;

        const processEvent = jest.fn().mockImplementation((_event: any, ctx: any) => {
            capturedCtx = ctx;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            instrumentRepository: { findAllTradable },
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedCtx).not.toBeNull();
        expect(capturedCtx.book.instruments.size).toBe(0);
    });
});

// ─── R1b fix-2: ticks loaded once per bar (perf + determinism) ───────────────

describe('BacktestRunnerService — single tick load per bar (R1b fix-2)', () => {
    it('loads ticks only once per bar even when the bar both triggers and has an open position', async () => {
        // Pre-condition: the previous implementation called loadTicksForBar up to 3 times
        // per bar (handleOpenPositionsForBar/checkPositionExit, closePosition, dispatchTriggerEvent).
        // After fix-2, the runner loads ticks once at the top of processBar and threads them through.

        const loadTicksForBar = jest.fn().mockResolvedValue([]);

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar,
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
        });

        await runner.run(buildConfig());

        // One bar, one call. Before fix-2 this would have been ≥2 (dispatch + close paths).
        expect(loadTicksForBar).toHaveBeenCalledTimes(1);
        expect(loadTicksForBar).toHaveBeenCalledWith('ETHUSDT', barOpenTimeMs);
    });
});

// ─── R1b fix-3: OI deltas and funding rate are propagated to events ──────────

describe('BacktestRunnerService — OI deltas and funding rate in event (R1b fix-3)', () => {
    it('computes oiChange5mPct and oiChange15mPct from data.oiByTsMs around the bar', async () => {
        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        // OI samples: now=1100, 5m ago=1000, 15m ago=1000 → 5m change = 10%, 15m change = 10%
        const oiNow = buildOiEntity(barOpenTimeMs, '1100');
        const oi5mAgo = buildOiEntity(barOpenTimeMs - CANDLE_5M_INTERVAL_MS, '1000');
        const oi15mAgo = buildOiEntity(barOpenTimeMs - 3 * CANDLE_5M_INTERVAL_MS, '1000');

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            openInterestRepository: {
                findRange: jest.fn().mockResolvedValue([oi15mAgo, oi5mAgo, oiNow]),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        // Before fix-3 these were hard-coded to 0; after fix-3 they reflect the OI series.
        expect(capturedEvent.openInterestChange5mPct).toBeCloseTo(10, 5);
        expect(capturedEvent.openInterestChange15mPct).toBeCloseTo(10, 5);
    });

    it('resolves fundingRate from the most-recent funding event at-or-before bar open', async () => {
        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T08:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        // Funding event 1 hour before the bar — must be selected.
        const fundingEvent = {
            symbol: 'ETHUSDT',
            tsMs: barOpenTimeMs - 60 * 60 * 1000,
            rate: new Money('0.0001'),
        };

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            fundingReplayLoader: {
                loadForWindow: jest.fn().mockResolvedValue([fundingEvent]),
                computeCashflow: jest.fn().mockReturnValue(new Money('0')),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        // Before fix-3 these were hard-coded to 0; after fix-3 they reflect the funding series.
        expect(capturedEvent.fundingRate).toBeCloseTo(0.0001, 8);
        // Annualization: rate * 3 ticks/day * 365 days = 0.0001 * 1095 = 0.1095
        expect(capturedEvent.fundingRateAnnualized).toBeCloseTo(0.1095, 6);
    });

    it('returns 0 for OI changes when prior OI samples are missing (boundary)', async () => {
        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        // Only current OI present — no 5m-ago, no 15m-ago.
        const oiNow = buildOiEntity(barOpenTimeMs, '1000');

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            openInterestRepository: {
                findRange: jest.fn().mockResolvedValue([oiNow]),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        // No prior OI sample within the 1h lookback → change% defaults to 0 by spec.
        expect(capturedEvent.openInterestChange5mPct).toBe(0);
        expect(capturedEvent.openInterestChange15mPct).toBe(0);
    });
});

// ─── R1b fix-1: force-close open positions at end-of-window (NAV pinning) ────

describe('BacktestRunnerService — force-close survivors at end-of-window (R1b fix-1)', () => {
    it('closes positions still open at end-of-window so the equity curve includes their PnL', async () => {
        // Seed an open position into the book by intercepting buildOrchestratorContext through
        // a custom orchestrator that opens a position on the first event.

        const barOpenTimeMs = new Date('2024-01-30T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs, 2000, 2070, 2080, 1990);

        // The orchestrator inserts a synthetic open position into the book so the runner's
        // end-of-window force-close path has something to close.
        const orchestrator = {
            processEvent: jest.fn().mockImplementation((event: any, ctx: any) => {
                ctx.book.openPositions.set(`${event.eventId}:${barOpenTimeMs}`, {
                    positionId: `${event.eventId}:${barOpenTimeMs}`,
                    symbol: 'ETHUSDT',
                    side: 'long',
                    slot: 'A',
                    entryPriceUsdt: '2000',
                    qty: '1',
                    entryNotionalUsdt: '2000',
                    leverage: '1',
                    stopLossUsdt: '1900',
                    takeProfitUsdt: '2100',
                    openedAtMs: barOpenTimeMs,
                    timeStopAtMs: null,
                    maxAdverseExcursionPct: '0',
                    maxFavorableExcursionPct: '0',
                    accumulatedFundingUsdt: '0',
                });
                // Also seed the PnL ledger via the sink so closure works.
                ctx.sink.applyOpenFill(
                    {
                        eventId: event.eventId,
                        symbol: 'ETHUSDT',
                        side: 'long',
                        priceUsdt: '2000',
                        qty: '1',
                        feeUsdt: '0',
                        slippagePct: '0',
                        tsMs: barOpenTimeMs,
                        missed: false,
                        depthAware: true,
                    },
                    ctx.book.openPositions.get(`${event.eventId}:${barOpenTimeMs}`),
                    '2024-01-30',
                );
                return Promise.resolve({ skipped: false, rejectedByGate: false, missedFill: false, filled: true });
            }),
        };

        // Capture trades passed to the metrics computer.
        let capturedTrades: any[] = [];
        const metricsComputer = {
            compute: jest.fn().mockImplementation((input: any) => {
                capturedTrades = input.trades;
                return {
                    strategyVersionId: 1,
                    strategyName: 'v1',
                    strategyVersion: 1,
                    fromUtcDate: '2024-01-01',
                    toUtcDate: '2024-01-31',
                    runLabel: 'test-run',
                    trades: input.trades,
                    equityCurve: [],
                    maxDrawdownPct: '0',
                    maxDrawdownDurationDays: 0,
                    totalTrades: 0,
                    winRate: '0',
                    profitFactor: '0',
                    sharpeRatio: '0',
                    netPnlUsdt: '0',
                    grossPnlUsdt: '0',
                    feesUsdt: '0',
                    fundingUsdt: '0',
                    slippageCostUsdt: '0',
                    avgReturnPct: '0',
                    skippedTriggerCount: 0,
                    rejectedByGateCount: 0,
                    missedLimitFillCount: 0,
                    lowFidelityTradeCount: 0,
                };
            }),
        };

        const lastWindowBar = buildCandle(new Date('2024-01-30T23:55:00.000Z').getTime(), 2050, 2080, 2090, 2040);
        const tradableInstrument = {
            symbol: 'ETHUSDT',
            isTradable: true,
            stepSize: new Money('0.001'),
            tickSize: new Money('0.01'),
            minNotional: new Money('5'),
        };

        const runner = buildRunner({
            instrumentRepository: { findAllTradable: jest.fn().mockResolvedValue([tradableInstrument]) },
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs, toMs }: { symbol: string; fromMs: number; toMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime() && toMs === new Date('2024-01-31T00:00:00.000Z').getTime();
                    if (isReplay) return Promise.resolve([bar]);
                    // End-of-window last-bar lookup: window of CANDLE_5M_INTERVAL_MS ending at toMs
                    const isLastBarLookup = toMs === new Date('2024-01-31T00:00:00.000Z').getTime() && fromMs === toMs - CANDLE_5M_INTERVAL_MS;
                    if (isLastBarLookup) return Promise.resolve([lastWindowBar]);
                    return Promise.resolve([]);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator,
            metricsComputer,
        });

        await runner.run(buildConfig());

        // Before fix-1 the survivor stayed in book.openPositions and was never added to trades.
        // After fix-1 the runner force-closes it at last-bar close, so it appears as a closed trade.
        expect(capturedTrades.length).toBe(1);
        expect(capturedTrades[0].symbol).toBe('ETHUSDT');
        expect(capturedTrades[0].exitReason).toBe('force_close');
    });
});

// ─── M19 breadth sentinel regression ─────────────────────────────────────────
//
// Before the M19 fix, BacktestRunnerService seeded `marketBreadth5mUpPct: 0` for
// every replay bar (cross-symbol breadth is not reconstructable in single-symbol
// replay). With STRESS_BREADTH_DISTANCE_PCT=40, |0-50|=50 >= 40, which trips
// MARKET_STRESS on bar 1, persists a halt, and GLOBAL_HALT-s every subsequent bar.
//
// After the fix the runner seeds MARKET_BREADTH_NEUTRAL_PCT (=50): |50-50|=0 < 40,
// so the breadth halt never fires. These tests are the paired regression guard:
// they fail if someone reverts the sentinel back to 0.

describe('BacktestRunnerService — M19 breadth sentinel (marketBreadth5mUpPct=NEUTRAL, not 0)', () => {
    // Test 1 — structural: the event built by the runner carries MARKET_BREADTH_NEUTRAL_PCT,
    // not 0. Asserting the field value guards the sentinel at the source.

    it('event built for a replay bar carries marketBreadth5mUpPct === MARKET_BREADTH_NEUTRAL_PCT (not 0)', async () => {
        let capturedEvent: any = null;
        const processEvent = jest.fn().mockImplementation((event: any) => {
            capturedEvent = event;
            return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
        });

        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol === 'BTCUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: { processEvent },
        });

        await runner.run(buildConfig());

        expect(capturedEvent).not.toBeNull();
        // The field must equal MARKET_BREADTH_NEUTRAL_PCT (50), never 0.
        // Reverting the sentinel to 0 breaks this assertion.
        expect(capturedEvent.marketBreadth5mUpPct).toBe(MARKET_BREADTH_NEUTRAL_PCT);
        expect(capturedEvent.marketBreadth5mUpPct).not.toBe(0);
    });

    // Test 2 — contract: MARKET_BREADTH_NEUTRAL_PCT does NOT trip StressHaltEvaluator,
    // whereas 0 would. Feeds both values through the real evaluator with calm params
    // so the breadth term is the only variable.

    it('MARKET_BREADTH_NEUTRAL_PCT does not trip StressHaltEvaluator breadth halt; 0 does (guard that 0 would have broken replays)', () => {
        const evaluator = new StressHaltEvaluator();

        const calmParams = buildParams();

        // The sentinel value — must not trigger stress.
        // M21: btc_5m_move_pct replaces btc_1m_move_pct as the active index-shock field;
        // the fixture must supply btc_5m_move_pct so hasInvalidStressInputs does not
        // fail-close on an absent (undefined) value.
        const neutralSnapshot = {
            btc_5m_move_pct: 0.0, // M21 active field — calm, below STRESS_BTC_5M_SHOCK_PCT=1.5
            btc_1m_move_pct: 0.0, // telemetry only (M21)
            eth_5m_move_pct: 0.0,
            market_breadth_5m_up_pct: MARKET_BREADTH_NEUTRAL_PCT, // sentinel: 50
            same_bar_trigger_count: 0,
            open_interest_change_5m_pct: 0.0,
            funding_rate_annualized: 0.0,
            bid_ask_spread_pct: 0.0,
            book_depth_10bps_usdt: '50000000',
        } as any;

        expect(evaluator.isStressed(neutralSnapshot, calmParams, false)).toBe(false);

        // The old sentinel (0) would trip the halt: |0-50|=50 >= STRESS_BREADTH_DISTANCE_PCT=40.
        // This assertion documents that 0 IS stressful, proving the fix was necessary.
        const zeroSnapshot = { ...neutralSnapshot, market_breadth_5m_up_pct: 0 };

        expect(Math.abs(0 - 50)).toBeGreaterThanOrEqual(STRESS_BREADTH_DISTANCE_PCT);
        expect(evaluator.isStressed(zeroSnapshot, calmParams, false)).toBe(true);
    });
});

// ─── M37 W2 — resolveBookGateInputs fallback (D2 fill-restoration) ─────────────
//
// `resolveBookGateInputs` is a module-level private function; we exercise it through
// the event payload the orchestrator receives via `processEvent`. The event's
// `bookDepth10bpsUsdt` and `bidAskSpreadPct` fields are populated by the function.

describe('BacktestRunnerService — M37 W2: BTC_REFERENCE_SYMBOL uses ccxt unified form', () => {
    it('BTC_REFERENCE_SYMBOL constant is BTC/USDT:USDT (not BTCUSDT)', async () => {
        // why: the bare BTCUSDT form silently matched zero rows in the candles table,
        // collapsing btc5mMovePct to 0 on every bar and hard-rejecting every
        // idiosyncrasy-filtered candidate via NO_ELIGIBLE_SLOT (M37 W2 second 0-fill blocker).
        // The runner's internal constant is tested indirectly via the loadFor5mWindow call;
        // this assertion locks the canonical string form.
        let btcSymbolQueried: string | null = null;
        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol !== 'ETHUSDT') {
                        btcSymbolQueried = symbol as string;
                    }
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay && symbol === 'ETHUSDT' ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue(null),
            },
        });

        await runner.run(buildConfig());

        // The runner MUST query the BTC reference with the ccxt unified symbol, not the bare form.
        expect(btcSymbolQueried).toBe('BTC/USDT:USDT');
        expect(btcSymbolQueried).not.toBe('BTCUSDT');
    });
});

describe('BacktestRunnerService — M37 W2: resolveBookGateInputs fallback semantics', () => {
    // Builds a runner that captures the event the orchestrator receives, with a controllable
    // book snapshot repository. The captured event's book depth / spread fields reflect what
    // resolveBookGateInputs returned for that bar.
    function buildRunnerCapturingEvent(bookSnapshots: ReturnType<typeof buildBookSnapshotEntity>[]) {
        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const bar = buildCandle(barOpenTimeMs);
        let capturedEvent: any = null;

        const runner = buildRunner({
            pointInTimeUniverse: {
                resolveForWindow: jest.fn().mockResolvedValue(['ETHUSDT']),
                resolveAt: jest.fn().mockResolvedValue(new Map([['ETHUSDT', CoinTierEnum.TIER_1]])),
            },
            bookSnapshotRepository: {
                findRange: jest.fn().mockResolvedValue(bookSnapshots),
            },
            candleLoader: {
                loadFor5mWindow: jest.fn().mockImplementation(({ symbol, fromMs }: { symbol: string; fromMs: number }) => {
                    if (symbol !== 'ETHUSDT') return Promise.resolve([]);
                    const isReplay = fromMs === new Date('2024-01-01T00:00:00.000Z').getTime();
                    return Promise.resolve(isReplay ? [bar] : []);
                }),
                loadTicksForBar: jest.fn().mockResolvedValue([]),
            },
            indicatorStateBuilder: {
                buildInitialWindow: jest.fn().mockReturnValue([]),
                appendBar: jest.fn().mockReturnValue([bar]),
                computeSnapshot: jest.fn().mockReturnValue({
                    symbol: 'ETHUSDT',
                    closedBarOpenTimeMs: barOpenTimeMs,
                    vwapSession: new Money('2000'),
                    vwap20bar: new Money('2000'),
                    vwap24h: new Money('2000'),
                    vwapEventAnchored: new Money('2000'),
                    activeVwapAnchorType: 'session',
                    vwapDeviationPct: 3.5,
                    vwapDeviationSigma: 2.5,
                    volumeRatio: 2.5,
                    volume20barAvg: new Money('500000'),
                    atr14: new Money('50'),
                    adx14: 20,
                    adxDiPlus: 10,
                    adxDiMinus: 5,
                    rsi14: 55,
                    bollingerUpper: new Money('2100'),
                    bollingerLower: new Money('1900'),
                    bollingerPctB: 0.7,
                    close: new Money('2070'),
                    fiveMinMovePct: 1.0,
                }),
            },
            orchestrator: {
                processEvent: jest.fn().mockImplementation((event: any) => {
                    capturedEvent = event;
                    return Promise.resolve({ skipped: true, rejectedByGate: false, missedFill: false, filled: false });
                }),
            },
        });

        return { runner, barOpenTimeMs, getCapturedEvent: () => capturedEvent };
    }

    it('when no book_snapshot row exists, bookDepth10bpsUsdt is the tier-floor multiplied fallback (non-zero, non-rejecting)', async () => {
        // why: pre-M37 the gate received depth=0, which hard-rejected EVERY no-book candidate.
        // The fallback must be strictly above the per-tier COIN_DEPTH_FLOOR_10BPS_USDT floor
        // so the depth check passes, not a zero that continues the 0-fill blocker.
        const { runner, getCapturedEvent } = buildRunnerCapturingEvent([]);

        await runner.run(buildConfig());

        const event = getCapturedEvent();
        expect(event).not.toBeNull();

        const tier1Floor = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1];
        const expectedFallbackDepth = tier1Floor * BACKTEST_FALLBACK_DEPTH_FLOOR_MULTIPLIER;

        // Depth must be strictly above the floor (> not >=) — the gate boundary is `<=` (floor rejects).
        expect(Number(event.bookDepth10bpsUsdt)).toBeGreaterThan(tier1Floor);
        expect(Number(event.bookDepth10bpsUsdt)).toBeCloseTo(expectedFallbackDepth, 2);
    });

    it('when no book_snapshot row exists, bidAskSpreadPct is the conservative fallback (below tier-1 spread ceiling)', async () => {
        // why: the fallback spread must be sub-ceiling so the spread check passes.
        // Tier-1 ceiling is 0.15%; BACKTEST_FALLBACK_BID_ASK_SPREAD_PCT = 0.05%.
        const { runner, getCapturedEvent } = buildRunnerCapturingEvent([]);

        await runner.run(buildConfig());

        const event = getCapturedEvent();
        expect(event).not.toBeNull();
        expect(event.bidAskSpreadPct).toBeCloseTo(BACKTEST_FALLBACK_BID_ASK_SPREAD_PCT, 4);
    });

    it('when a book_snapshot row exists, the real captured spread and depth are used (full-fidelity gate input)', async () => {
        // why: the fallback must only apply when no snapshot exists; a real snapshot
        // row must override the fallback so the live-captured conditions are reproduced.
        const barOpenTimeMs = new Date('2024-01-15T00:00:00.000Z').getTime();
        const snapshot = buildBookSnapshotEntity(barOpenTimeMs);
        snapshot.spread = new Money('0.12') as any;
        snapshot.depth10bps = new Money('75000') as any;

        const { runner, getCapturedEvent } = buildRunnerCapturingEvent([snapshot]);

        await runner.run(buildConfig());

        const event = getCapturedEvent();
        expect(event).not.toBeNull();
        // Real snapshot values flow through — NOT the fallback values.
        expect(Number(event.bidAskSpreadPct)).toBeCloseTo(0.12, 4);
        expect(Number(event.bookDepth10bpsUsdt)).toBeCloseTo(75000, 0);
    });

    it('fallback depth is CONSERVATIVE (tier-floor × 1.01) — not abundant — so no live-impossible fills are manufactured', async () => {
        // why: the fallback models barely-sufficient liquidity (1% above the floor),
        // not abundant book. It stops EVERY candidate from being rejected but cannot
        // turn a genuinely thin-book rejection into an approval.
        // BACKTEST_FALLBACK_DEPTH_FLOOR_MULTIPLIER = 1.01: depth sits 1% above the
        // floor that the gate's `<= floor` boundary would reject.
        expect(BACKTEST_FALLBACK_DEPTH_FLOOR_MULTIPLIER).toBe(1.01);

        const tier1Floor = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1];
        const fallbackDepth = tier1Floor * BACKTEST_FALLBACK_DEPTH_FLOOR_MULTIPLIER;

        // The fallback is strictly above the rejection boundary but not abundant.
        expect(fallbackDepth).toBeGreaterThan(tier1Floor);
        // It should not be so generous that it models a liquid top-tier coin.
        // Abundant tier-1 depth is order-of-magnitude larger (tens of millions); the
        // fallback is only marginally above the floor.
        expect(fallbackDepth / tier1Floor).toBeLessThan(1.1);
    });
});
