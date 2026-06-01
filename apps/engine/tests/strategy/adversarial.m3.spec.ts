/**
 * M3 Adversarial Backfill — 5 surfaces per docs/plans/M5.5-adversarial-backfill.md §M3.
 *
 * Each describe block corresponds to one architect-listed surface. Every test cites the
 * ADR clause or invariant it falsifies above the test body.
 *
 * Failure-routing: if any test fails, stop and report "ARCHITECT ROUTING NEEDED".
 */

import {
    DeviationSideEnum,
    FlowTypeEnum,
    PositionSideEnum,
    RiskOutcomeEnum,
    SignalActionEnum,
    SignalTypeEnum,
    SkipReasonEnum,
    StrategyDirectionEnum,
    classifyFlowType,
    computeSignalScore,
} from '@bot/shared';

import { V0BaselineStrategy } from '../../src/strategy/strategies/V0BaselineStrategy';
import { V1MeanReversionStrategy } from '../../src/strategy/strategies/V1MeanReversionStrategy';
import { V2MomentumStrategy } from '../../src/strategy/strategies/V2MomentumStrategy';
import { V3HybridRouterStrategy } from '../../src/strategy/strategies/V3HybridRouterStrategy';
import { IStrategyInput } from '../../src/strategy/interface';
import { StrategyService } from '../../src/strategy/service/StrategyService';
import { buildEvent, buildParams, buildSnapshot } from './support/fixtures';
import { Money } from '../../src/common/utils/money';
import { buildSizing, buildProposedExit } from '../risk/support/fixtures';
import {
    COOLDOWN_AFTER_LOSS_MS,
    DAILY_LOSS_LIMIT_USDT,
    MAX_EXPOSURE_PER_COIN_USDT,
    MAX_SAME_DIRECTION_EXPOSURE_USDT,
    WEEKLY_LOSS_LIMIT_USDT,
} from '../../src/risk/const';

// ─── shared helpers ───────────────────────────────────────────────────────────

function buildInput(overrides: Partial<IStrategyInput> = {}): IStrategyInput {
    return {
        event: buildEvent(),
        snapshot: buildSnapshot({ signal_score: 65 }),
        openPosition: null,
        params: buildParams(),
        nowMs: 1_716_307_500_000,
        ...overrides,
    };
}

function buildVersionRow(
    overrides: Partial<{ id: number; name: string; version: number; direction: StrategyDirectionEnum; params: Record<string, unknown> }> = {},
) {
    return {
        id: 1,
        name: 'volatility-vwap',
        version: 0,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        params: buildParams() as unknown as Record<string, unknown>,
        ...overrides,
    };
}

function _makeOpenSignal() {
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

    const strategyVersions = { findById: jest.fn() };
    const positions = { findOpenBySymbol: jest.fn().mockResolvedValue([]) };
    const decisions = { record: jest.fn().mockResolvedValue({}) };
    const events = { emit: jest.fn() };

    const strategyImpl = {
        name: 'volatility-vwap',
        version: 0,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        evaluate: jest.fn().mockReturnValue({
            action: SignalActionEnum.SKIP,
            signalType: SignalTypeEnum.VWAP_DEVIATION_LONG_BIAS,
            skipReason: SkipReasonEnum.BASELINE_NO_TRADE,
            tradeSide: null,
            signalScore: 55,
            flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            reason: SkipReasonEnum.BASELINE_NO_TRADE,
            proposedExit: null,
        }),
    };

    const registry = {
        resolve: jest.fn().mockReturnValue({
            strategy: strategyImpl,
            params: buildParams(),
        }),
    };

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

    const sizer = { size: jest.fn().mockReturnValue({ kind: 'sized', sizing: buildSizing() }) };

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

    const universe = { findOpenMembership: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT' }) };

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
        // M11a W2: ShadowStrategyOrchestratorService stub — no-op so the
        // adversarial active-path assertions remain insulated from the shadow path.
        shadowOrchestrator: { runShadows: jest.fn().mockResolvedValue(undefined) },
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
        mocks.shadowOrchestrator as any,
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SURFACE 1 — Strategy determinism under repeated evaluation of the same input
// ADR 0003 §pure-and-deterministic: "no Date.now() / Math.random() / I/O inside a strategy."
// ═══════════════════════════════════════════════════════════════════════════════

describe('M3 adversarial — surface 1: strategy determinism across v0–v3', () => {
    // Frozen input re-used across all repetitions — any hidden state or clock read would
    // produce divergence on the 2nd+ call.
    const FROZEN_INPUT = Object.freeze(buildInput());

    // ADR 0003 §pure-and-deterministic
    it('v0: N identical calls on the same frozen input produce bit-identical ISignal output', () => {
        const strategy = new V0BaselineStrategy();
        const results = Array.from({ length: 10 }, () => strategy.evaluate(FROZEN_INPUT));

        for (let idx = 1; idx < results.length; idx++) {
            expect(results[idx].action).toBe(results[0].action);
            expect(results[idx].skipReason).toBe(results[0].skipReason);
            expect(results[idx].signalScore).toBe(results[0].signalScore);
            expect(results[idx].flowType).toBe(results[0].flowType);
            expect(results[idx].tradeSide).toBe(results[0].tradeSide);
        }
    });

    // ADR 0003 §pure-and-deterministic
    it('v1: N identical calls on the same frozen exhaustion-confirmed input produce bit-identical output', () => {
        const strategy = new V1MeanReversionStrategy();
        const input = Object.freeze(
            buildInput({
                event: buildEvent({
                    side: DeviationSideEnum.ABOVE,
                    bollingerPctB: 0.7,
                    volumeRatio: 0.8,
                    openInterestChange5mPct: -1.0,
                    flowType: FlowTypeEnum.FORCED_EXHAUSTION,
                }),
            }),
        );
        const results = Array.from({ length: 10 }, () => strategy.evaluate(input));

        for (let idx = 1; idx < results.length; idx++) {
            expect(results[idx].action).toBe(results[0].action);
            expect(results[idx].tradeSide).toBe(results[0].tradeSide);
            expect(results[idx].signalScore).toBe(results[0].signalScore);
            // proposedExit timestamps must be bar-derived, identical across calls
            expect(results[idx].proposedExit?.timeStopAtMs).toBe(results[0].proposedExit?.timeStopAtMs);
        }
    });

    // ADR 0003 §pure-and-deterministic
    it('v2: N identical calls on the same frozen trending input produce bit-identical output', () => {
        const strategy = new V2MomentumStrategy();
        const input = Object.freeze(
            buildInput({
                event: buildEvent({ flowType: FlowTypeEnum.TREND_INITIATION, regimeLabel: 'trending_up' as any }),
            }),
        );
        const results = Array.from({ length: 10 }, () => strategy.evaluate(input));

        for (let idx = 1; idx < results.length; idx++) {
            expect(results[idx].action).toBe(results[0].action);
            expect(results[idx].tradeSide).toBe(results[0].tradeSide);
            expect(results[idx].proposedExit?.timeStopAtMs).toBe(results[0].proposedExit?.timeStopAtMs);
        }
    });

    // ADR 0003 §pure-and-deterministic
    it('v3: N identical calls on the same frozen input produce bit-identical output', () => {
        const strategy = new V3HybridRouterStrategy();
        const input = Object.freeze(
            buildInput({
                event: buildEvent({ flowType: FlowTypeEnum.FORCED_EXHAUSTION }),
            }),
        );
        const results = Array.from({ length: 10 }, () => strategy.evaluate(input));

        for (let idx = 1; idx < results.length; idx++) {
            expect(results[idx].action).toBe(results[0].action);
            expect(results[idx].tradeSide).toBe(results[0].tradeSide);
        }
    });

    // ADR 0003 §pure-and-deterministic — purity guard: evaluate must NOT mutate its input
    it('v1: evaluate does not mutate the IStrategyInput object it receives', () => {
        const strategy = new V1MeanReversionStrategy();
        const input = buildInput({
            event: buildEvent({ side: DeviationSideEnum.ABOVE, bollingerPctB: 0.7, openInterestChange5mPct: -1.0 }),
        });
        const originalNowMs = input.nowMs;
        const originalSignalScore = input.snapshot.signal_score;
        const originalFlowType = input.event.flowType;

        strategy.evaluate(input);

        expect(input.nowMs).toBe(originalNowMs);
        expect(input.snapshot.signal_score).toBe(originalSignalScore);
        expect(input.event.flowType).toBe(originalFlowType);
    });

    // ADR 0003 §pure-and-deterministic — purity guard: evaluate must NOT mutate its input
    it('v3: evaluate does not mutate the IStrategyInput object it receives', () => {
        const strategy = new V3HybridRouterStrategy();
        const input = buildInput({ event: buildEvent({ flowType: FlowTypeEnum.MARKET_BETA }) });
        const originalFlowType = input.event.flowType;

        strategy.evaluate(input);

        expect(input.event.flowType).toBe(originalFlowType);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — nowMs always from bar, never wall-clock
// ADR 0003 §pure-and-deterministic: backtest-vs-live parity invariant.
// ═══════════════════════════════════════════════════════════════════════════════

describe('M3 adversarial — surface 2: nowMs derivation from bar, not wall-clock', () => {
    const CANDLE_INTERVAL_MS = 5 * 60 * 1_000;

    // ADR 0003 §pure-and-deterministic — orchestrator must compute nowMs = bar + interval,
    // never Date.now(). An ancient candle timestamp reveals any wall-clock contamination.
    it('orchestrator stamps nowMs = entryCandleOpenTime + CANDLE_INTERVAL_MS for a far-past bar', async () => {
        const mocks = buildMocks();
        mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
        const service = buildService(mocks);
        await service.onModuleInit();

        // A candle from 2020 — if Date.now() leaks, nowMs would be ~years different.
        const ancientBarOpenTime = 1_580_000_000_000; // 2020-01-26 epoch
        await service.onVolatilityDetected(buildEvent({ entryCandleOpenTime: ancientBarOpenTime }));

        const evaluateArg = mocks.strategyImpl.evaluate.mock.calls[0][0] as IStrategyInput;

        expect(evaluateArg.nowMs).toBe(ancientBarOpenTime + CANDLE_INTERVAL_MS);
        // Guard: nowMs must NOT equal an approximation of wall-clock
        const wallClockNow = Date.now();
        const wallClockTolerance = 5_000; // 5 s
        expect(Math.abs(evaluateArg.nowMs - wallClockNow)).toBeGreaterThan(wallClockTolerance);
    });

    // ADR 0003 §pure-and-deterministic — time_stop_at must be anchored to the bar, not now.
    // v1 computes timeStopAtMs = nowMs + time_stop_minutes * MS_PER_MINUTE where nowMs comes
    // from the input. Injecting an ancient bar exposes any wall-clock read in stop computation.
    it('v1: time_stop_at is anchored to the bar (nowMs), not wall-clock — ancient candle smoke test', () => {
        const strategy = new V1MeanReversionStrategy();
        const ancientNowMs = 1_580_000_300_000; // 5 min after ancient bar open
        const TIME_STOP_MINUTES = 60;

        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.7,
                volumeRatio: 0.8,
                openInterestChange5mPct: -1.0,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            }),
            params: buildParams({ time_stop_minutes: TIME_STOP_MINUTES }),
            nowMs: ancientNowMs,
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit?.timeStopAtMs).toBe(ancientNowMs + TIME_STOP_MINUTES * 60_000);
        // If wall-clock leaked: timeStopAtMs ≈ Date.now() + offset — assert it isn't
        const wallClockDelta = Math.abs((signal.proposedExit?.timeStopAtMs ?? 0) - Date.now());
        expect(wallClockDelta).toBeGreaterThan(100_000); // >100 s away from wall-clock
    });

    // ADR 0003 §pure-and-deterministic — v2 time stop must also be bar-derived
    it('v2: time_stop_at is anchored to nowMs (bar), not wall-clock — ancient candle smoke test', () => {
        const strategy = new V2MomentumStrategy();
        const ancientNowMs = 1_580_000_300_000;
        const TIME_STOP_MINUTES = 45;

        const input = buildInput({
            event: buildEvent({ flowType: FlowTypeEnum.TREND_INITIATION, regimeLabel: 'trending_up' as any }),
            params: buildParams({ time_stop_minutes: TIME_STOP_MINUTES }),
            nowMs: ancientNowMs,
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.proposedExit?.timeStopAtMs).toBe(ancientNowMs + TIME_STOP_MINUTES * 60_000);
    });

    // ADR 0003 §pure-and-deterministic — replay invariant: same bar at two different wall-clock
    // moments must produce identical signals (proves no hidden Date.now() dependency).
    it('v1: replaying the same frozen bar at two wall-clock instants produces identical signals', () => {
        const strategy = new V1MeanReversionStrategy();
        const frozenInput = buildInput({
            event: buildEvent({ side: DeviationSideEnum.ABOVE, bollingerPctB: 0.7, openInterestChange5mPct: -1.0 }),
        });

        const first = strategy.evaluate(frozenInput);
        // Spin the CPU briefly so wall-clock advances, then re-evaluate.
        const busyWaitEnd = Date.now() + 5; // 5 ms busy-wait
        while (Date.now() < busyWaitEnd) {
            /* spin */
        }
        const second = strategy.evaluate(frozenInput);

        expect(first.action).toBe(second.action);
        expect(first.proposedExit?.timeStopAtMs).toBe(second.proposedExit?.timeStopAtMs);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SURFACE 3 — flow_type + signal_score stamped exactly once; stale pre-populated values
// ADR 0003 §single-stamp-orchestrator: "every version of a given trigger event reads
// the same flow_type / signal_score."
// ═══════════════════════════════════════════════════════════════════════════════

describe('M3 adversarial — surface 3: single-stamp orchestrator; stale pre-populated values', () => {
    // ADR 0003 §single-stamp-orchestrator — flow_type must be overwritten by orchestrator
    // even when the incoming event carries a stale (pre-populated) value.
    it('orchestrator overwrites a stale pre-populated flowType on the incoming event before passing to strategy', async () => {
        const mocks = buildMocks();
        mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
        const service = buildService(mocks);
        await service.onModuleInit();

        // The incoming event carries a stale/wrong flowType that the orchestrator must replace
        // with its own fresh classification.
        const event = buildEvent({
            openInterestChange5mPct: -2.0, // raw data → FORCED_EXHAUSTION
            flowType: FlowTypeEnum.CATALYST_RISK, // stale pre-populated value — must be overwritten
        });

        await service.onVolatilityDetected(event);

        const evaluateArg = mocks.strategyImpl.evaluate.mock.calls[0][0] as IStrategyInput;

        // The orchestrator classifies fresh from the event data, so the strategy sees the
        // fresh classification (FORCED_EXHAUSTION), never the stale CATALYST_RISK.
        expect(evaluateArg.event.flowType).toBe(FlowTypeEnum.FORCED_EXHAUSTION);
    });

    // ADR 0003 §single-stamp-orchestrator — signal_score on the snapshot must equal what
    // computeSignalScore would produce for that event; not a stale zero or pre-populated garbage.
    it('orchestrator stamps a non-zero signal_score on the snapshot regardless of snapshot default', async () => {
        const mocks = buildMocks();
        mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
        const service = buildService(mocks);
        await service.onModuleInit();

        const event = buildEvent({ vwapDeviationPct: 2.5, volumeRatio: 3.0 });
        await service.onVolatilityDetected(event);

        const evaluateArg = mocks.strategyImpl.evaluate.mock.calls[0][0] as IStrategyInput;

        expect(evaluateArg.snapshot.signal_score).toBeGreaterThan(0);
        expect(evaluateArg.snapshot.signal_score).toBeLessThanOrEqual(100);
    });

    // ADR 0003 §single-stamp-orchestrator — classifyFlowType is pure: same inputs → same output.
    // Calling it twice on the same event and params must return the same flow type.
    it('classifyFlowType is deterministic: same event + params → identical flow type across N calls', () => {
        const event = buildEvent({ openInterestChange5mPct: -2.0, idiosyncrasyScore: 0.2 });
        const params = buildParams();

        const results = Array.from({ length: 20 }, () => classifyFlowType(event, params));

        const first = results[0];
        for (const result of results) {
            expect(result).toBe(first);
        }
    });

    // ADR 0003 §single-stamp-orchestrator — computeSignalScore is pure: same inputs → same score.
    it('computeSignalScore is deterministic: same event + params + flowType → identical score across N calls', () => {
        const event = buildEvent({ vwapDeviationPct: 2.0, volumeRatio: 2.5, idiosyncrasyScore: 0.4 });
        const params = buildParams();
        const flowType = FlowTypeEnum.FORCED_EXHAUSTION;

        const results = Array.from({ length: 20 }, () => computeSignalScore(event, params, flowType));

        const first = results[0];
        for (const result of results) {
            expect(result).toBe(first);
        }
    });

    // ADR 0003 §single-stamp-orchestrator — the decision record written to persistence must
    // carry the event_id stamped by MarketData, unchanged.
    it('orchestrator preserves the incoming event_id on the persisted decision (no re-derivation)', async () => {
        const mocks = buildMocks();
        mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow({ id: 3 }));
        const service = buildService(mocks);
        await service.onModuleInit();

        const event = buildEvent({
            symbol: 'ADAUSDT',
            entryCandleOpenTime: 1_716_400_000_000,
            eventId: 'ADAUSDT:1716400000000',
        });
        await service.onVolatilityDetected(event);

        const recorded = mocks.decisions.record.mock.calls[0][0];
        expect(recorded.eventId).toBe('ADAUSDT:1716400000000');
    });

    // ADR 0003 §single-stamp-orchestrator — replay: two calls with the same event must produce
    // decisions with the same flow_type stamp on the snapshot.
    it('replaying the same event twice produces decisions with the same flow_type on the snapshot', async () => {
        const mocks = buildMocks();
        mocks.strategyVersions.findById.mockResolvedValue(buildVersionRow());
        const service = buildService(mocks);
        await service.onModuleInit();

        const event = buildEvent({ openInterestChange5mPct: -2.0 });

        await service.onVolatilityDetected(event);
        await service.onVolatilityDetected(event);

        const [firstArg, secondArg] = mocks.strategyImpl.evaluate.mock.calls.map((c: any[]) => c[0] as IStrategyInput);
        expect(firstArg.event.flowType).toBe(secondArg.event.flowType);
        expect(firstArg.snapshot.signal_score).toBe(secondArg.snapshot.signal_score);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SURFACE 4 — v1 exhaustion confirmation tightness at %B = 0.8 / 0.2 exact boundaries
// ADR 0003 §skip-is-first-class + §exhaustion-confirmation:
// "v1 must not enter on the first close outside the band."
// ═══════════════════════════════════════════════════════════════════════════════

describe('M3 adversarial — surface 4: v1 exhaustion confirmation boundary tightness', () => {
    const strategy = new V1MeanReversionStrategy();

    // ADR 0003 §exhaustion-confirmation — ABOVE spike: %B exactly at 0.8 is NOT confirmed
    // (still pinned at the band edge — BAND_REENTRY_UPPER_PCT_B is exclusive).
    it('ABOVE spike: bollingerPctB = 0.8 exactly (at the boundary) does NOT confirm exhaustion via band re-entry', () => {
        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.8, // exactly at boundary — should fail band re-entry
                volumeRatio: 2.5, // elevated — NOT decelerating
                openInterestChange5mPct: 0.5, // OI rising — NOT confirmed
                idiosyncrasyScore: 0.2,
            }),
        });

        const signal = strategy.evaluate(input);

        // %B = 0.8 means "still at the band edge" — the tightened check requires <0.8.
        // If OI is also rising and volume elevated, exhaustion is NOT confirmed → skip.
        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
    });

    // ADR 0003 §exhaustion-confirmation — ABOVE spike: %B = 0.79 is just inside the threshold
    // (< 0.8) — band re-entry IS confirmed.
    it('ABOVE spike: bollingerPctB = 0.79 (just inside boundary) confirms band re-entry and permits OPEN', () => {
        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.79,
                volumeRatio: 2.5, // elevated — NOT volume-decelerating alone
                openInterestChange5mPct: 0.5, // OI rising — not OI-confirmed alone
                regimeLabel: 'ranging' as any,
                idiosyncrasyScore: 0.2,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            }),
        });

        const signal = strategy.evaluate(input);

        // %B < 0.8 → band re-entry confirmed → OPEN (the one confirmation needed)
        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.tradeSide).toBe(PositionSideEnum.SHORT);
    });

    // ADR 0003 §exhaustion-confirmation — BELOW spike: %B exactly at 0.2 does NOT confirm
    // (BAND_REENTRY_LOWER_PCT_B requires >0.2 for a dump exhaustion).
    it('BELOW spike: bollingerPctB = 0.2 exactly does NOT confirm exhaustion via band re-entry', () => {
        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.BELOW,
                bollingerPctB: 0.2, // exactly at lower boundary — should fail
                volumeRatio: 2.5, // elevated
                openInterestChange5mPct: 0.5, // OI rising
                idiosyncrasyScore: 0.2,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            }),
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
    });

    // ADR 0003 §exhaustion-confirmation — BELOW spike: %B = 0.21 is just inside (>0.2) —
    // band re-entry IS confirmed on the dump side.
    it('BELOW spike: bollingerPctB = 0.21 (just inside lower boundary) confirms band re-entry', () => {
        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.BELOW,
                bollingerPctB: 0.21,
                volumeRatio: 2.5,
                openInterestChange5mPct: 0.5,
                regimeLabel: 'ranging' as any,
                idiosyncrasyScore: 0.2,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            }),
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.OPEN);
        expect(signal.tradeSide).toBe(PositionSideEnum.LONG);
    });

    // ADR 0003 §exhaustion-confirmation — still-extended spike: %B >> 1 with no other
    // confirmation must produce NO_EXHAUSTION_CONFIRMATION (the "first close outside" case).
    it('still-extended ABOVE spike (%B=1.3, high volume, OI rising) skips with no_exhaustion_confirmation', () => {
        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 1.3,
                volumeRatio: 3.5,
                openInterestChange5mPct: 1.5,
                idiosyncrasyScore: 0.2,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            }),
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
    });

    // ADR 0003 §exhaustion-confirmation — OI threshold: exactly 0.0% OI change is the
    // boundary of "not rising" (OI_NOT_RISING_THRESHOLD_PCT = 0.0 → <= 0.0 passes).
    it('openInterestChange5mPct = 0.0 exactly satisfies the OI-not-rising exhaustion confirmation', () => {
        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 1.3, // still extended — band re-entry fails
                volumeRatio: 3.5, // elevated — volume deceleration fails
                openInterestChange5mPct: 0.0, // exactly at OI not-rising boundary
                idiosyncrasyScore: 0.2,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            }),
        });

        const signal = strategy.evaluate(input);

        // OI at exactly 0.0 → <= OI_NOT_RISING_THRESHOLD_PCT (0.0) → confirms exhaustion
        expect(signal.action).toBe(SignalActionEnum.OPEN);
    });

    // ADR 0003 §exhaustion-confirmation — OI just above threshold (0.0001) should NOT confirm.
    it('openInterestChange5mPct = 0.0001 (fractionally above zero) does NOT confirm OI-not-rising', () => {
        const input = buildInput({
            event: buildEvent({
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 1.3, // still extended
                volumeRatio: 3.5, // elevated
                openInterestChange5mPct: 0.0001, // just above zero → OI still rising
                idiosyncrasyScore: 0.2,
                flowType: FlowTypeEnum.FORCED_EXHAUSTION,
            }),
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.NO_EXHAUSTION_CONFIRMATION);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SURFACE 5 — v3 router fallthrough on unknown / missing flow_type
// ADR 0003 §v3-routing-is-deterministic:
// "an unknown classifier output never produces a direction signal."
// ═══════════════════════════════════════════════════════════════════════════════

describe('M3 adversarial — surface 5: v3 router fallthrough on unknown / missing flow_type', () => {
    const strategy = new V3HybridRouterStrategy();

    // ADR 0003 §v3-routing-is-deterministic — undefined flow_type must route to skip, never raise.
    it('undefined flowType routes to a SKIP signal, never throws', () => {
        const input = buildInput({
            event: buildEvent({ flowType: undefined as unknown as FlowTypeEnum }),
        });

        let signal: ReturnType<typeof strategy.evaluate> | null = null;
        expect(() => {
            signal = strategy.evaluate(input);
        }).not.toThrow();
        expect(signal!.action).toBe(SignalActionEnum.SKIP);
    });

    // ADR 0003 §v3-routing-is-deterministic — null flow_type must route to skip, never raise.
    it('null flowType routes to a SKIP signal, never throws', () => {
        const input = buildInput({
            event: buildEvent({ flowType: null as unknown as FlowTypeEnum }),
        });

        let signal: ReturnType<typeof strategy.evaluate> | null = null;
        expect(() => {
            signal = strategy.evaluate(input);
        }).not.toThrow();
        expect(signal!.action).toBe(SignalActionEnum.SKIP);
    });

    // ADR 0003 §v3-routing-is-deterministic — a future/unknown string enum value must route
    // to skip (forward-compatibility: schema drift never yields a direction signal).
    it('a future unknown flow_type string routes to SKIP, never invents a direction', () => {
        const input = buildInput({
            event: buildEvent({ flowType: 'unknown_future_flow_type_v9' as unknown as FlowTypeEnum }),
        });

        let signal: ReturnType<typeof strategy.evaluate> | null = null;
        expect(() => {
            signal = strategy.evaluate(input);
        }).not.toThrow();
        expect(signal!.action).toBe(SignalActionEnum.SKIP);
        expect(signal!.tradeSide).toBeNull();
    });

    // ADR 0003 §v3-routing-is-deterministic — low_quality_noise is a known skip-routed type.
    // This is a regression guard for the case the M3 plan specifically cited.
    it('low_quality_noise flowType routes to SKIP with FLOW_ROUTED_SKIP reason', () => {
        const input = buildInput({
            event: buildEvent({ flowType: FlowTypeEnum.LOW_QUALITY_NOISE }),
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
        expect(signal.tradeSide).toBeNull();
        expect(signal.proposedExit).toBeNull();
    });

    // ADR 0003 §v3-routing-is-deterministic — market_beta is a known skip-routed type.
    it('market_beta flowType routes to SKIP with FLOW_ROUTED_SKIP reason', () => {
        const input = buildInput({
            event: buildEvent({ flowType: FlowTypeEnum.MARKET_BETA }),
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.skipReason).toBe(SkipReasonEnum.FLOW_ROUTED_SKIP);
    });

    // ADR 0003 §v3-routing-is-deterministic — anti-coverage: any skip-route must never set
    // tradeSide to a non-null value (no accidental direction from fallthrough).
    it('every skip-routed flowType produces tradeSide = null (no direction invented)', () => {
        const skipFlows = [FlowTypeEnum.MARKET_BETA, FlowTypeEnum.CATALYST_RISK, FlowTypeEnum.LOW_QUALITY_NOISE];

        for (const flowType of skipFlows) {
            const input = buildInput({ event: buildEvent({ flowType }) });
            const signal = strategy.evaluate(input);

            expect(signal.tradeSide).toBeNull();
            expect(signal.proposedExit).toBeNull();
        }
    });

    // ADR 0003 §v3-routing-is-deterministic — unknown flow_type must not produce a direction
    // even if the underlying market data would qualify for a trade.
    it('unknown flow_type produces no direction signal even with trade-qualifying market data', () => {
        const input = buildInput({
            event: buildEvent({
                flowType: 'schema_drift_unknown_v12' as unknown as FlowTypeEnum,
                side: DeviationSideEnum.ABOVE,
                bollingerPctB: 0.7, // exhaustion confirmed
                volumeRatio: 0.8,
                openInterestChange5mPct: -2.0,
                regimeLabel: 'ranging' as any,
                idiosyncrasyScore: 0.1,
            }),
        });

        const signal = strategy.evaluate(input);

        expect(signal.action).toBe(SignalActionEnum.SKIP);
        expect(signal.tradeSide).toBeNull();
    });
});
