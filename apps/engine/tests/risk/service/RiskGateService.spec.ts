/**
 * RiskGateService — central risk gate, ordered check pipeline.
 *
 * The decision core is pure: ports (IRiskStatePort, IOpenPositionsPort,
 * IInstrumentPort) and nowMs are injected. No DB, no exchange.
 *
 * Coverage maps to ADR 0004 and M4 Definition of Done:
 *   - Global halt (kill-switch, model divergence)
 *   - Market stress overrides ADX
 *   - Universe floor, OI availability, spread filters
 *   - Tier-3 unvalidated gate
 *   - Cooldown after closed loss
 *   - Daily + weekly loss limits, consecutive-loss halt
 *   - Overtrading caps (per-symbol/day, per-bar-universe)
 *   - Funding-as-skip flow rules
 *   - Slot/candidate selection (delegated to SlotManager, gate wires it)
 *   - SL-inside-liquidation: pass, tighten, reject
 *   - Time-stop mandatory
 *   - Exposure caps (per-coin + same-direction)
 *   - Exposure reservation: reserve on approve; no reservation on reject
 *   - Reduce/close/flatten ALWAYS approved (pass-through)
 *   - Boundary conditions throughout
 */

import { CoinTierEnum, CorrelationModeEnum, OrderIntentActionEnum, PositionSideEnum, RejectReasonEnum, RiskOutcomeEnum } from '@bot/shared';

import { Money } from '../../../src/common/utils/money';
import {
    COIN_DEPTH_FLOOR_10BPS_USDT,
    DAILY_LOSS_LIMIT_USDT,
    HALT_LEG_BTC_SHOCK,
    MAX_EXPOSURE_PER_COIN_USDT,
    MAX_SAME_DIRECTION_EXPOSURE_USDT,
    WEEKLY_LOSS_LIMIT_USDT,
} from '../../../src/risk/const';
import { ReservationStateEnum } from '../../../src/risk/enum';
import { IRiskGateContext } from '../../../src/risk/interface';
import { ReservationLedger } from '../../../src/risk/service/ReservationLedger';
import { RiskGateService } from '../../../src/risk/service/RiskGateService';
import { SlotManager } from '../../../src/risk/service/SlotManager';
import { StressHaltEvaluator } from '../../../src/risk/service/StressHaltEvaluator';
import {
    buildGateContext,
    buildOpenPositionView,
    buildOpenPositionsPort,
    buildOrderIntent,
    buildProposedExit,
    buildReservation,
    buildRiskStateDay,
    buildRiskStatePort,
    buildSizing,
} from '../support/fixtures';
import { buildSnapshot } from '../../strategy/support/fixtures';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGate(): { gate: RiskGateService; ledger: ReservationLedger } {
    const ledger = new ReservationLedger();
    const slotManager = new SlotManager();
    const stress = new StressHaltEvaluator();
    const positions = { findById: jest.fn().mockResolvedValue(null) };
    const riskState = { findByDate: jest.fn().mockResolvedValue(null), upsertDay: jest.fn() };
    const events = { emit: jest.fn() };
    const appConfig = { marketStressAutoResumeEnabled: false };
    const gate = new RiskGateService(ledger, slotManager, stress, positions as never, riskState as never, events as never, appConfig as never);
    // M6 W8: gate starts in recovery mode; tests that exercise evaluate() must
    // mark recovery complete to bypass the RECOVERY_IN_PROGRESS guard. The
    // gate's recovery contract is exercised separately in tests/position/W8.spec.ts.
    gate.markRecoveryComplete();
    return { gate, ledger };
}

// Builds a context that will PASS all checks by default
function buildPassingContext(overrides: Partial<IRiskGateContext> = {}): IRiskGateContext {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return buildGateContext({
        nowMs: NOW_MS,
        ...overrides,
    });
}

// Builds a valid OPEN intent that passes the gate by default
function buildPassingIntent(overrides = {}) {
    const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
    return buildOrderIntent({
        intentAction: OrderIntentActionEnum.OPEN,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        idiosyncrasyScore: 0.9,
        coinTier: CoinTierEnum.TIER_1,
        proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
        sizing: buildSizing({ leverage: new Money('1') }),
        entryPrice: new Money('30000'),
        tradeSide: PositionSideEnum.SHORT,
        ...overrides,
    });
}

// ─── global halt ──────────────────────────────────────────────────────────────

describe('RiskGateService', () => {
    describe('global halt — kill-switch', () => {
        it('rejects with global_halt when risk_state.isHalted is true', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                riskState: buildRiskStatePort({ day: buildRiskStateDay({ isHalted: true, haltReason: 'kill_switch' }) }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        });

        it('rejects with model_divergence_halt when modelDivergenceDetected is true', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ modelDivergenceDetected: true });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
            expect(result.rejectReason).toBe(RejectReasonEnum.MODEL_DIVERGENCE_HALT);
        });

        it('model_divergence check comes BEFORE is_halted check (order determinism)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                modelDivergenceDetected: true,
                riskState: buildRiskStatePort({ day: buildRiskStateDay({ isHalted: true }) }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MODEL_DIVERGENCE_HALT);
        });

        it('approves when risk_state row is null (first day — no halt possible)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                riskState: buildRiskStatePort({ day: null }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('rejects with global_halt when nowMs is non-finite (fail-closed invariant)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ nowMs: NaN });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
            expect(result.rejectReason).toBe(RejectReasonEnum.GLOBAL_HALT);
        });
    });

    // ─── market stress overrides ADX ───────────────────────────────────────────

    describe('market-stress halt overrides ADX', () => {
        it('rejects with market_stress when BTC 5m move exceeds threshold (M21: reads btc_5m_move_pct)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ btc_5m_move_pct: 2.0 }), // well above STRESS_BTC_5M_SHOCK_PCT=1.5
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
            expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
        });

        it('shocked btc_1m_move_pct with calm btc_5m_move_pct does NOT return MARKET_STRESS (M21 horizon contract)', async () => {
            // btc_1m_move_pct is now telemetry only (M21); only btc_5m_move_pct drives the index-shock halt.
            // A shocked 1m field with a calm 5m field must pass through the stress check without halting.
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ btc_1m_move_pct: 5.0, btc_5m_move_pct: 0.5 }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).not.toBe(RejectReasonEnum.MARKET_STRESS);
        });

        it('calm btc_1m_move_pct with shocked btc_5m_move_pct returns MARKET_STRESS (M21 horizon contract)', async () => {
            // btc_5m_move_pct=2.0 > STRESS_BTC_5M_SHOCK_PCT=1.5 → halt; 1m field is irrelevant.
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ btc_1m_move_pct: 0.5, btc_5m_move_pct: 2.0 }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
        });

        it('rejects mean-reversion entry during stress even when ADX signals ranging', async () => {
            // ADX below threshold = "ranging" normally, but stress overrides
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({
                    adx_14: 15, // low ADX → ranging
                    btc_5m_move_pct: 5.0, // but massive BTC 5m move → stress (M21: active field)
                }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
        });

        it('stress check is before slot/exposure checks (short-circuits pipeline)', async () => {
            const { gate } = makeGate();
            // Use a correlated intent (slot C) to potentially conflict, but stress fires first
            const context = buildPassingContext({
                snapshot: buildSnapshot({ btc_5m_move_pct: 3.0 }), // above STRESS_BTC_5M_SHOCK_PCT=1.5
            });

            const result = await gate.evaluate(buildPassingIntent({ correlationMode: CorrelationModeEnum.CORRELATED }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
        });

        it('persists a durable halt (upserts risk_state) when market stress fires', async () => {
            const { gate } = makeGate();
            const riskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });
            const context = buildPassingContext({
                snapshot: buildSnapshot({ btc_5m_move_pct: 3.0 }), // above STRESS_BTC_5M_SHOCK_PCT=1.5
                riskState,
            });

            await gate.evaluate(buildPassingIntent(), context);

            // M23 (ADR 0004 §6d): the persisted halt_reason carries the engaged-leg suffix.
            // A sole BTC-shock engage persists `market_stress:btc_shock`. M45 D3a: the halt now
            // routes through the column-scoped upsertHaltForDay(date, isHalted, haltReason).
            expect(riskState.upsertHaltForDay).toHaveBeenCalledWith(expect.any(String), true, `${RejectReasonEnum.MARKET_STRESS}:${HALT_LEG_BTC_SHOCK}`);
        });

        it('does NOT re-upsert halt when risk_state is already halted (idempotent)', async () => {
            const { gate } = makeGate();
            const riskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: true, haltReason: 'market_stress' }) });
            const context = buildPassingContext({ riskState });

            await gate.evaluate(buildPassingIntent(), context);

            // Already halted → GLOBAL_HALT fires before stress → no halt write (M45 D3a path)
            expect(riskState.upsertHaltForDay).not.toHaveBeenCalled();
            expect(riskState.upsertDay).not.toHaveBeenCalled();
        });
    });

    // ─── universe floor + OI availability + spread ──────────────────────────────

    describe('universe floor filter', () => {
        it('rejects with below_universe_floor when symbol dropped below universe floor', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ belowUniverseFloor: true });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.BELOW_UNIVERSE_FLOOR);
        });

        it('approves when symbol is in the universe (belowUniverseFloor=false)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ belowUniverseFloor: false });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    describe('OI availability filter', () => {
        it('rejects with oi_unavailable when require_oi_available=true and open_interest is null', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ open_interest: null as any }),
                params: { ...buildPassingContext().params, require_oi_available: true },
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.OI_UNAVAILABLE);
        });

        it('does NOT reject when require_oi_available=false even with null OI', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ open_interest: null as any }),
                params: { ...buildPassingContext().params, require_oi_available: false },
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('does NOT reject when OI is present and require_oi_available=true', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                params: { ...buildPassingContext().params, require_oi_available: true },
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    describe('spread filter — tier-based ceiling', () => {
        it('rejects with spread_too_wide when tier-1 spread exceeds 0.15%', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: 0.16 }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.SPREAD_TOO_WIDE);
        });

        it('approves at exactly tier-1 ceiling (boundary: spread == 0.15% — NOT exceeded)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: 0.15 }),
            });

            // 0.15 is NOT > 0.15 so should pass
            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('rejects when tier-2 spread exceeds 0.30%', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: 0.31 }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_2 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.SPREAD_TOO_WIDE);
        });

        it('approves tier-2 spread at exactly 0.30% (boundary)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: 0.3 }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_2 }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('rejects when tier-3 spread exceeds 0.50%', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: 0.51 }),
                // Need a validated version-id to pass tier-3 check — not needed since spread fires first
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_3 }), context);

            // Spread check fires before tier3 check in the pipeline
            expect(result.rejectReason).toBe(RejectReasonEnum.SPREAD_TOO_WIDE);
        });

        it('rejects with market_stress when bid_ask_spread_pct is NaN (stress halt fires before spread filter)', async () => {
            // StressHaltEvaluator.hasInvalidStressInputs includes bid_ask_spread_pct in its NaN
            // guard, so a NaN spread triggers MARKET_STRESS in the stress halt stage — which runs
            // BEFORE the tier-filter spread check. isSpreadTooWide also has its own !Number.isFinite
            // guard as defence-in-depth against future pipeline reordering, but in the current
            // pipeline the stress halt fires first.
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: NaN }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
        });

        it('rejects with market_stress when bid_ask_spread_pct is Infinity (stress halt fires before spread filter)', async () => {
            // Same pipeline-order rationale as the NaN case above: hasInvalidStressInputs fires
            // MARKET_STRESS before isSpreadTooWide gets to evaluate the Infinity value.
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: Infinity }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MARKET_STRESS);
        });
    });

    // ─── tier-3 unvalidated ────────────────────────────────────────────────────

    describe('tier-3 unvalidated gate', () => {
        it('rejects tier-3 entry with tier3_not_validated when no version is in the allow-list', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ strategyVersionId: 999 }); // not in TIER3_VALIDATED_VERSION_IDS (empty)

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_3 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.TIER3_NOT_VALIDATED);
        });

        it('approves tier-1 and tier-2 regardless of the version allow-list', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ strategyVersionId: 999 });

            const t1 = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);
            const t2 = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_2, eventId: 'e2' }), context);

            expect(t1.outcome).toBe(RiskOutcomeEnum.APPROVED);
            expect(t2.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    // ─── cooldown ─────────────────────────────────────────────────────────────

    describe('cooldown after closed loss', () => {
        it('rejects with cooldown_active when last close was a loss within the cooldown window', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // Last close 5 minutes ago (well within 15-min cooldown)
            const lastClose = {
                symbol: 'BTCUSDT',
                realizedPnl: new Money('-10'),
                closedAtMs: NOW_MS - 5 * 60_000,
            };
            const context = buildPassingContext({
                nowMs: NOW_MS,
                openPositions: buildOpenPositionsPort({ lastClose }),
            });

            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COOLDOWN_ACTIVE);
        });

        it('does NOT activate cooldown when last close was a profit (not a loss)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const lastClose = {
                symbol: 'BTCUSDT',
                realizedPnl: new Money('50'), // profit
                closedAtMs: NOW_MS - 1 * 60_000,
            };
            const context = buildPassingContext({
                nowMs: NOW_MS,
                openPositions: buildOpenPositionsPort({ lastClose }),
            });

            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('approves after the cooldown window expires (boundary: just past 15 min)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const COOLDOWN_MS = 15 * 60_000;
            const lastClose = {
                symbol: 'BTCUSDT',
                realizedPnl: new Money('-20'),
                closedAtMs: NOW_MS - COOLDOWN_MS - 1, // one ms past the cooldown
            };
            const context = buildPassingContext({
                nowMs: NOW_MS,
                openPositions: buildOpenPositionsPort({ lastClose }),
            });

            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('does NOT activate cooldown when there is no prior close', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                openPositions: buildOpenPositionsPort({ lastClose: null }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    // ─── loss windows ─────────────────────────────────────────────────────────

    describe('daily loss limit', () => {
        it('rejects with daily_loss_limit when realized PnL reaches the daily limit', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                riskState: buildRiskStatePort({
                    day: buildRiskStateDay({ realizedPnlDay: new Money(-DAILY_LOSS_LIMIT_USDT) }),
                }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.DAILY_LOSS_LIMIT);
        });

        it('rejects when realized PnL EXCEEDS the daily limit (one-over)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                riskState: buildRiskStatePort({
                    day: buildRiskStateDay({ realizedPnlDay: new Money(-(DAILY_LOSS_LIMIT_USDT + 1)) }),
                }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.DAILY_LOSS_LIMIT);
        });

        it('approves when PnL is one dollar above the daily limit (boundary)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                riskState: buildRiskStatePort({
                    day: buildRiskStateDay({ realizedPnlDay: new Money(-(DAILY_LOSS_LIMIT_USDT - 1)) }),
                }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    describe('weekly loss limit', () => {
        it('rejects with weekly_loss_limit when rolling 7-day PnL reaches the weekly limit', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                riskState: buildRiskStatePort({
                    weeklyPnl: String(-WEEKLY_LOSS_LIMIT_USDT), // exactly at limit
                }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.WEEKLY_LOSS_LIMIT);
        });

        it('approves when weekly PnL is one dollar above the weekly limit (boundary)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                riskState: buildRiskStatePort({
                    weeklyPnl: String(-(WEEKLY_LOSS_LIMIT_USDT - 1)),
                }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    describe('consecutive-loss halt', () => {
        it('rejects with consecutive_loss_halt after 2 consecutive losses in the UTC day', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const closedToday = [
                { symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 120_000 },
                { symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 60_000 },
            ];
            const context = buildPassingContext({
                nowMs: NOW_MS,
                openPositions: buildOpenPositionsPort({ closed: closedToday }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
        });

        it('approves after a WIN that resets the consecutive-loss streak', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // Two losses, then a win — streak resets
            const closedToday = [
                { symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 180_000 },
                { symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 120_000 },
                { symbol: 'BNBUSDT', realizedPnl: new Money('+20'), closedAtMs: NOW_MS - 60_000 },
            ];
            const context = buildPassingContext({
                nowMs: NOW_MS,
                openPositions: buildOpenPositionsPort({ closed: closedToday }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('approves with only 1 consecutive loss (below the halt threshold of 2)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const closedToday = [{ symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 60_000 }];
            const context = buildPassingContext({
                nowMs: NOW_MS,
                openPositions: buildOpenPositionsPort({ closed: closedToday }),
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('persists a durable halt (upserts risk_state) when consecutive-loss halt fires', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const closedToday = [
                { symbol: 'ETHUSDT', realizedPnl: new Money('-5'), closedAtMs: NOW_MS - 120_000 },
                { symbol: 'SOLUSDT', realizedPnl: new Money('-3'), closedAtMs: NOW_MS - 60_000 },
            ];
            const riskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });
            const context = buildPassingContext({
                nowMs: NOW_MS,
                riskState,
                openPositions: buildOpenPositionsPort({ closed: closedToday }),
            });

            await gate.evaluate(buildPassingIntent(), context);

            // M45 D3a: the consecutive-loss halt routes through the column-scoped writer.
            expect(riskState.upsertHaltForDay).toHaveBeenCalledWith(expect.any(String), true, RejectReasonEnum.CONSECUTIVE_LOSS_HALT);
        });
    });

    // ─── overtrading caps ─────────────────────────────────────────────────────

    describe('overtrading caps', () => {
        it('rejects with max_trades_per_symbol_per_day when per-symbol count reaches the limit', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                params: { ...buildPassingContext().params, max_trades_per_symbol_per_day: 3 },
                openPositions: buildOpenPositionsPort({ countForSymbol: 3 }), // exactly at limit
            });

            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MAX_TRADES_PER_SYMBOL_PER_DAY);
        });

        it('approves when per-symbol count is one below the limit (boundary)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                params: { ...buildPassingContext().params, max_trades_per_symbol_per_day: 3 },
                openPositions: buildOpenPositionsPort({ countForSymbol: 2 }),
            });

            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('rejects with max_trades_per_bar_universe when ledger already holds cap reservations in the current bar index', async () => {
            // Bar-index match: Math.floor(createdAtMs / CANDLE_INTERVAL_MS) === Math.floor(nowMs / CANDLE_INTERVAL_MS).
            // Seeding at createdAtMs = nowMs guarantees same bar index. Different symbols avoid exposure-cap interference.
            const { gate, ledger } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const symbols = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
            const slots = ['A', 'B', 'C'] as any[];
            for (let i = 0; i < 3; i++) {
                ledger.reserve(
                    buildReservation({
                        reservationId: `existing-r${i}`,
                        symbol: symbols[i],
                        slot: slots[i],
                        createdAtMs: NOW_MS, // same bar index as context.nowMs
                        state: ReservationStateEnum.PENDING,
                    } as any),
                );
            }
            const context = buildPassingContext({
                nowMs: NOW_MS,
                params: { ...buildPassingContext().params, max_trades_per_bar_universe: 3 },
            });

            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MAX_TRADES_PER_BAR_UNIVERSE);
        });

        it('approves when universe cap is one below limit (2 same-bar-index reservations, cap 3)', async () => {
            const { gate, ledger } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            for (let i = 0; i < 2; i++) {
                ledger.reserve(
                    buildReservation({
                        reservationId: `existing-r${i}`,
                        symbol: i === 0 ? 'ETHUSDT' : 'SOLUSDT',
                        slot: i === 0 ? 'A' : 'B',
                        createdAtMs: NOW_MS, // same bar index as context.nowMs
                        state: ReservationStateEnum.PENDING,
                    } as any),
                );
            }
            const context = buildPassingContext({
                nowMs: NOW_MS,
                params: { ...buildPassingContext().params, max_trades_per_bar_universe: 3 },
            });

            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('does NOT count previous-bar reservations against the current-bar cap', async () => {
            // Reservations created in the PREVIOUS bar index (createdAtMs one bar earlier) must NOT
            // count — the cap is per-bar-index, not a rolling window.
            // All 3 reservations use the SAME slot (A) so Set deduplication in occupiedSlots
            // produces {A} — only slot A taken — leaving slot B free for the BTCUSDT intent.
            // Using distinct slots across previous-bar reservations would fill all idiosyncratic
            // slots, causing a MAX_POSITIONS_REACHED rejection before the bar-index check matters.
            const { gate, ledger } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const CANDLE_INTERVAL_MS = 5 * 60_000;
            const symbols = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
            for (let i = 0; i < 3; i++) {
                ledger.reserve(
                    buildReservation({
                        reservationId: `prev-r${i}`,
                        symbol: symbols[i],
                        slot: 'A' as any, // all same slot → Set deduplicates to {A}; slots B and C remain free
                        createdAtMs: NOW_MS - CANDLE_INTERVAL_MS, // previous bar index
                        state: ReservationStateEnum.PENDING,
                    } as any),
                );
            }
            const context = buildPassingContext({
                nowMs: NOW_MS,
                params: { ...buildPassingContext().params, max_trades_per_bar_universe: 3 },
            });

            // Current bar is empty — should approve despite 3 previous-bar reservations
            const result = await gate.evaluate(buildPassingIntent({ symbol: 'BTCUSDT' }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('fills the per-bar cap through real gate.evaluate calls (gate-driven cap, no pre-seeded ledger)', async () => {
            // Drives the cap purely through evaluate: N approvals consume the cap, (N+1)th rejects.
            // cap=2 so we need only 2 symbols that can get different slots.
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const baseContext = buildPassingContext({
                nowMs: NOW_MS,
                params: { ...buildPassingContext().params, max_trades_per_bar_universe: 2 },
            });

            // First approve: ETHUSDT → slot A
            const first = await gate.evaluate(buildPassingIntent({ eventId: `ETHUSDT:${NOW_MS}`, symbol: 'ETHUSDT' }), baseContext);
            expect(first.outcome).toBe(RiskOutcomeEnum.APPROVED);

            // Second approve: SOLUSDT → slot B
            const second = await gate.evaluate(buildPassingIntent({ eventId: `SOLUSDT:${NOW_MS}`, symbol: 'SOLUSDT' }), baseContext);
            expect(second.outcome).toBe(RiskOutcomeEnum.APPROVED);

            // Third: cap (2) reached → MAX_TRADES_PER_BAR_UNIVERSE
            const third = await gate.evaluate(buildPassingIntent({ eventId: `BNBUSDT:${NOW_MS}`, symbol: 'BNBUSDT' }), baseContext);
            expect(third.rejectReason).toBe(RejectReasonEnum.MAX_TRADES_PER_BAR_UNIVERSE);
        });
    });

    // ─── funding-as-skip flow rules ───────────────────────────────────────────

    describe('funding-as-skip flow rules', () => {
        it('rejects with funding_suppressed on a FADE entry when OI is rising and funding is not extreme (oi_rising_skip)', async () => {
            // A FADE entry: price above VWAP (vwap_deviation_pct > 0) and we go SHORT
            // — fading the spike, not following momentum.
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({
                    open_interest_change_5m_pct: 1.5, // OI rising
                    funding_rate: 0.0001, // below suppress threshold (not extreme)
                    vwap_deviation_pct: 1.0, // price above VWAP → SHORT is a fade entry
                }),
                params: { ...buildPassingContext().params, oi_rising_skip: true, funding_rate_suppress_threshold: 0.001 },
            });
            // SHORT intent (default) with price ABOVE VWAP → qualifies as fade
            const intent = buildPassingIntent({ tradeSide: PositionSideEnum.SHORT });

            const result = await gate.evaluate(intent, context);

            expect(result.rejectReason).toBe(RejectReasonEnum.FUNDING_SUPPRESSED);
        });

        it('does NOT apply oi_rising_skip to a MOMENTUM (non-fade) entry', async () => {
            // A momentum entry: price below VWAP (vwap_deviation_pct < 0) and we go SHORT
            // — following the drop, not fading. isFadeEntry returns false.
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({
                    open_interest_change_5m_pct: 1.5, // OI rising
                    funding_rate: 0.0001, // not extreme
                    vwap_deviation_pct: -1.0, // price BELOW VWAP; SHORT here is momentum, not fade
                }),
                params: { ...buildPassingContext().params, oi_rising_skip: true, funding_rate_suppress_threshold: 0.001 },
            });
            const intent = buildPassingIntent({ tradeSide: PositionSideEnum.SHORT });

            const result = await gate.evaluate(intent, context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('rejects with funding_suppressed on deeply negative funding + buy-flow dominance (short squeeze skip)', async () => {
            // Rising price is detected via agg_trade_buy_volume_ratio > 0.5 (buy-flow dominance),
            // NOT via vwap_deviation_pct (which is a level, not a direction).
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({
                    funding_rate: -0.002, // deeply negative, exceeds suppress threshold
                    agg_trade_buy_volume_ratio: 0.6, // buy-flow dominance → rising price signal
                    vwap_deviation_pct: -1.0, // level does not matter for short-squeeze logic
                }),
                params: { ...buildPassingContext().params, funding_rate_suppress_threshold: 0.001 },
            });
            // SHORT intent + deeply negative funding + buy-flow dominance → squeeze skip
            const intent = buildPassingIntent({ tradeSide: PositionSideEnum.SHORT });

            const result = await gate.evaluate(intent, context);

            expect(result.rejectReason).toBe(RejectReasonEnum.FUNDING_SUPPRESSED);
        });

        it('does NOT skip a SHORT when buy-volume ratio is at 0.5 (boundary — must be strictly > 0.5)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({
                    funding_rate: -0.002,
                    agg_trade_buy_volume_ratio: 0.5, // exactly 0.5 — NOT > 0.5
                    vwap_deviation_pct: -1.0,
                }),
                params: { ...buildPassingContext().params, funding_rate_suppress_threshold: 0.001 },
            });

            const result = await gate.evaluate(buildPassingIntent({ tradeSide: PositionSideEnum.SHORT }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('does NOT skip when OI is FALLING on the spike (valid reversion case)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({
                    open_interest_change_5m_pct: -1.5, // OI FALLING → valid reversion
                    funding_rate: -0.0001,
                    vwap_deviation_pct: 1.0, // fade entry (SHORT + above VWAP)
                    agg_trade_buy_volume_ratio: 0.3,
                }),
                params: { ...buildPassingContext().params, oi_rising_skip: true },
            });

            const result = await gate.evaluate(buildPassingIntent({ tradeSide: PositionSideEnum.SHORT }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    // ─── SL-inside-liquidation ────────────────────────────────────────────────

    describe('SL-inside-liquidation validation', () => {
        it('approves when stop loss is close enough to entry (inside liquidation distance)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // entryPrice=30000, leverage=1, maintenanceMarginRate=0.005 (default)
            // liquidationFraction = 1 - 0.005 = 0.995; liquidationDistance = 29850
            // safeDistance = 29850 * 0.8 = 23880
            // stopDistance = |30000 - 20000| = 10000 → well inside 23880
            const intent = buildPassingIntent({
                entryPrice: new Money('30000'),
                sizing: buildSizing({ leverage: new Money('1') }),
                proposedExit: buildProposedExit({
                    stopLossPrice: new Money('20000'), // 10000 away
                    takeProfitPrice: new Money('31000'), // above entry (correct side for LONG)
                    timeStopAtMs: NOW_MS + 30 * 60_000,
                }),
                tradeSide: PositionSideEnum.LONG,
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('rejects with sl_outside_liquidation when leverage is 0 (invalid)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const intent = buildPassingIntent({
                sizing: buildSizing({ leverage: new Money('0') }),
                proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.rejectReason).toBe(RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        });

        it('rejects with sl_outside_liquidation when leverage exceeds MAX_LEVERAGE', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const intent = buildPassingIntent({
                sizing: buildSizing({ leverage: new Money('4') }), // exceeds MAX_LEVERAGE=3
                proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.rejectReason).toBe(RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        });

        it('tightens the stop when it exceeds the safe distance and returns clamped exit', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // entryPrice=100, leverage=2, maintenanceMarginRate=0.005
            // liquidationFraction = 1/2 - 0.005 = 0.495
            // liquidationDistance = 100 * 0.495 = 49.5
            // safeDistance = 49.5 * 0.8 = 39.6
            // stop at 50 → stopDistance=50 > 39.6 → tighten
            // tightened = entry - safeDistance = 100 - 39.6 = 60.4 (LONG)
            const intent = buildPassingIntent({
                entryPrice: new Money('100'),
                maintenanceMarginRate: new Money('0.005'),
                sizing: buildSizing({ leverage: new Money('2') }),
                tradeSide: PositionSideEnum.LONG,
                proposedExit: buildProposedExit({
                    stopLossPrice: new Money('50'), // 50 away > 39.6 safe distance → tighten
                    timeStopAtMs: NOW_MS + 30 * 60_000,
                }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
            expect(result.clampedExit).not.toBeNull();
            if (result.clampedExit) {
                // tightened stop = 100 - 39.6 = 60.4
                expect(result.clampedExit.stopLossPrice.equals(new Money('60.4'))).toBe(true);
            }
        });

        it('SL triggers before liquidation: stop distance <= safe distance passes unchanged', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // entryPrice=100, leverage=2, maintenanceMarginRate=0.005
            // liquidationFraction = 0.495, safeDistance = 39.6
            // stop at 65 → stopDistance=35 ≤ 39.6 → passes unchanged
            const intent = buildPassingIntent({
                entryPrice: new Money('100'),
                maintenanceMarginRate: new Money('0.005'),
                sizing: buildSizing({ leverage: new Money('2') }),
                tradeSide: PositionSideEnum.LONG,
                proposedExit: buildProposedExit({
                    stopLossPrice: new Money('65'), // 35 away < 39.6 safe distance
                    timeStopAtMs: NOW_MS + 30 * 60_000,
                }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
            // Stop is unchanged — already within the safe distance
            if (result.clampedExit) {
                expect(result.clampedExit.stopLossPrice.equals(new Money('65'))).toBe(true);
            }
        });

        it('rejects with sl_outside_liquidation when maintenanceMarginRate >= 1/leverage (fraction <= 0)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // leverage=2, maintenanceMarginRate=0.5 → fraction = 1/2 - 0.5 = 0 → reject before distance check.
            // Stop must be on the correct side (LONG: below entry=100) so wrong-side check does not
            // fire first and obscure the fraction check being tested.
            const intent = buildPassingIntent({
                entryPrice: new Money('100'),
                maintenanceMarginRate: new Money('0.5'),
                sizing: buildSizing({ leverage: new Money('2') }),
                tradeSide: PositionSideEnum.LONG,
                proposedExit: buildProposedExit({
                    stopLossPrice: new Money('90'), // below entry → correct side for LONG
                    timeStopAtMs: NOW_MS + 30 * 60_000,
                }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.rejectReason).toBe(RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        });

        it('rejects with sl_outside_liquidation when a LONG has stop >= entry (wrong-side stop)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // LONG stop must be BELOW entry. A stop AT or ABOVE entry is never protective.
            const intent = buildPassingIntent({
                entryPrice: new Money('30000'),
                tradeSide: PositionSideEnum.LONG,
                proposedExit: buildProposedExit({
                    stopLossPrice: new Money('30000'), // stop == entry → wrong side
                    timeStopAtMs: NOW_MS + 30 * 60_000,
                }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.rejectReason).toBe(RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        });

        it('rejects with sl_outside_liquidation when a SHORT has stop <= entry (wrong-side stop)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            // SHORT stop must be ABOVE entry. A stop AT or BELOW entry is never protective.
            const intent = buildPassingIntent({
                entryPrice: new Money('30000'),
                tradeSide: PositionSideEnum.SHORT,
                proposedExit: buildProposedExit({
                    stopLossPrice: new Money('30000'), // stop == entry → wrong side for SHORT
                    timeStopAtMs: NOW_MS + 30 * 60_000,
                }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.rejectReason).toBe(RejectReasonEnum.SL_OUTSIDE_LIQUIDATION);
        });
    });

    // ─── time-stop mandatory ───────────────────────────────────────────────────

    describe('time-stop mandatory for mean-reversion', () => {
        it('rejects with time_stop_missing_or_invalid when timeStopAtMs is null', async () => {
            const { gate } = makeGate();
            const intent = buildPassingIntent({
                proposedExit: buildProposedExit({ timeStopAtMs: null as any }),
            });

            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.rejectReason).toBe(RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID);
        });

        it('rejects when time stop is already in the past (timeStopAtMs <= nowMs)', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const intent = buildPassingIntent({
                proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS - 1 }),
            });

            const result = await gate.evaluate(intent, buildPassingContext({ nowMs: NOW_MS }));

            expect(result.rejectReason).toBe(RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID);
        });

        it('rejects when time stop exceeds params.time_stop_minutes from now', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const TOO_FAR = NOW_MS + 120 * 60_000; // 120 min, but limit is 60 min
            const intent = buildPassingIntent({
                proposedExit: buildProposedExit({ timeStopAtMs: TOO_FAR }),
            });
            const context = buildPassingContext({
                nowMs: NOW_MS,
                params: { ...buildPassingContext().params, time_stop_minutes: 60 },
            });

            const result = await gate.evaluate(intent, context);

            expect(result.rejectReason).toBe(RejectReasonEnum.TIME_STOP_MISSING_OR_INVALID);
        });

        it('approves when time stop is within the allowed window', async () => {
            const { gate } = makeGate();
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            const intent = buildPassingIntent({
                proposedExit: buildProposedExit({ timeStopAtMs: NOW_MS + 30 * 60_000 }), // 30 min < 60 min
            });

            const result = await gate.evaluate(intent, buildPassingContext({ nowMs: NOW_MS }));

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    // ─── exposure caps ────────────────────────────────────────────────────────

    describe('exposure caps', () => {
        it('rejects with exposure_cap_per_coin when per-coin notional would exceed cap', async () => {
            const { gate } = makeGate();
            // Existing open position uses most of the per-coin cap
            const context = buildPassingContext({
                openPositions: buildOpenPositionsPort({
                    open: [
                        buildOpenPositionView({
                            symbol: 'BTCUSDT',
                            notional: new Money(MAX_EXPOSURE_PER_COIN_USDT - 10), // 10 left
                        }),
                    ],
                }),
            });
            const intent = buildPassingIntent({
                symbol: 'BTCUSDT',
                sizing: buildSizing({ notional: new Money('20') }), // 20 > 10 remaining
            });

            const result = await gate.evaluate(intent, context);

            expect(result.rejectReason).toBe(RejectReasonEnum.EXPOSURE_CAP_PER_COIN);
        });

        it('approves when per-coin notional is exactly at the cap (boundary: == cap)', async () => {
            const { gate } = makeGate();
            // No existing exposure + new sizing exactly at cap
            const context = buildPassingContext();
            const intent = buildPassingIntent({
                symbol: 'BTCUSDT',
                sizing: buildSizing({ notional: new Money(MAX_EXPOSURE_PER_COIN_USDT) }),
            });

            const result = await gate.evaluate(intent, context);

            // Exactly AT cap (not over) should approve
            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('rejects with same_direction_exposure_cap when same-side portfolio cap is exceeded', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                openPositions: buildOpenPositionsPort({
                    open: [
                        buildOpenPositionView({ symbol: 'ETHUSDT', side: PositionSideEnum.SHORT, notional: new Money(MAX_SAME_DIRECTION_EXPOSURE_USDT - 10) }),
                    ],
                }),
            });
            const intent = buildPassingIntent({
                symbol: 'BTCUSDT',
                tradeSide: PositionSideEnum.SHORT,
                sizing: buildSizing({ notional: new Money('20') }),
            });

            const result = await gate.evaluate(intent, context);

            expect(result.rejectReason).toBe(RejectReasonEnum.SAME_DIRECTION_EXPOSURE_CAP);
        });

        it('counts PENDING reservations toward per-coin exposure cap', async () => {
            const { gate, ledger } = makeGate();
            // Reserve most of the cap for BTCUSDT
            ledger.reserve(
                buildReservation({
                    symbol: 'BTCUSDT',
                    notional: new Money(MAX_EXPOSURE_PER_COIN_USDT - 10),
                    state: ReservationStateEnum.PENDING,
                }),
            );

            const context = buildPassingContext();
            const intent = buildPassingIntent({
                symbol: 'BTCUSDT',
                sizing: buildSizing({ notional: new Money('20') }), // 20 > 10 remaining
            });

            const result = await gate.evaluate(intent, context);

            expect(result.rejectReason).toBe(RejectReasonEnum.EXPOSURE_CAP_PER_COIN);
        });
    });

    // ─── exposure reservation — no leak ───────────────────────────────────────

    describe('exposure reservation lifecycle', () => {
        it('creates a reservation on approval', async () => {
            const { gate, ledger } = makeGate();
            const result = await gate.evaluate(buildPassingIntent(), buildPassingContext());

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
            expect(result.reservationId).not.toBeNull();
            expect(ledger.listActive()).toHaveLength(1);
        });

        it('does NOT create a reservation on rejection', async () => {
            const { gate, ledger } = makeGate();
            const context = buildPassingContext({ belowUniverseFloor: true });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
            expect(result.reservationId).toBeNull();
            expect(ledger.listActive()).toHaveLength(0);
        });

        it('reservation id is deterministic: eventId:slot', async () => {
            const { gate } = makeGate();
            const intent = buildPassingIntent({ eventId: 'TEST_EVENT:123' });
            const result = await gate.evaluate(intent, buildPassingContext());

            expect(result.reservationId).toBe('TEST_EVENT:123:A');
        });

        it('releasing a reservation removes it from active caps', async () => {
            const { gate, ledger } = makeGate();
            const result = await gate.evaluate(buildPassingIntent(), buildPassingContext());
            expect(result.reservationId).not.toBeNull();

            gate.releaseReservation(result.reservationId!);

            expect(ledger.listActive()).toHaveLength(0);
        });

        it('released reservation no longer counts against the exposure cap (no leak)', async () => {
            const { gate } = makeGate();
            // Approve and immediately release
            const first = await gate.evaluate(
                buildPassingIntent({ eventId: 'e1', symbol: 'BTCUSDT', sizing: buildSizing({ notional: new Money(MAX_EXPOSURE_PER_COIN_USDT) }) }),
                buildPassingContext(),
            );
            expect(first.outcome).toBe(RiskOutcomeEnum.APPROVED);
            gate.releaseReservation(first.reservationId!);

            // A second intent for the same symbol should now also approve (cap freed)
            const second = await gate.evaluate(
                buildPassingIntent({ eventId: 'e2', symbol: 'BTCUSDT', sizing: buildSizing({ notional: new Money(MAX_EXPOSURE_PER_COIN_USDT) }) }),
                buildPassingContext(),
            );

            expect(second.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    // ─── reduce/close/flatten — always approved ───────────────────────────────

    describe('reduce / close / flatten always approved (pass-through)', () => {
        const deRiskingActions = [OrderIntentActionEnum.REDUCE, OrderIntentActionEnum.CLOSE, OrderIntentActionEnum.FLATTEN] as const;

        for (const action of deRiskingActions) {
            it(`${action} is approved even when global halt is active`, async () => {
                const { gate } = makeGate();
                const context = buildPassingContext({
                    riskState: buildRiskStatePort({ day: buildRiskStateDay({ isHalted: true }) }),
                });
                const intent = buildPassingIntent({ intentAction: action });

                const result = await gate.evaluate(intent, context);

                expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
                expect(result.rejectReason).toBeNull();
            });

            it(`${action} is approved even during market stress`, async () => {
                const { gate } = makeGate();
                const context = buildPassingContext({
                    snapshot: buildSnapshot({ btc_5m_move_pct: 5.0 }), // M21: active stress field
                });
                const intent = buildPassingIntent({ intentAction: action });

                const result = await gate.evaluate(intent, context);

                expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
            });

            it(`${action} does NOT create a reservation`, async () => {
                const { gate, ledger } = makeGate();
                const intent = buildPassingIntent({ intentAction: action });

                await gate.evaluate(intent, buildPassingContext());

                // De-risking has no reservation
                expect(ledger.listActive()).toHaveLength(0);
            });

            it(`${action} returns the sizing unchanged (pass-through path)`, async () => {
                const { gate } = makeGate();
                const sizing = buildSizing({ notional: new Money('999') });
                const intent = buildPassingIntent({ intentAction: action, sizing });

                const result = await gate.evaluate(intent, buildPassingContext());

                expect(result.approvedSizing).not.toBeNull();
                if (result.approvedSizing) {
                    expect(result.approvedSizing.notional.equals(new Money('999'))).toBe(true);
                }
            });
        }
    });

    // ─── approved decision structure ──────────────────────────────────────────

    describe('approved decision structure', () => {
        it('returns APPROVED outcome with a non-null approvedSlot', async () => {
            const { gate } = makeGate();
            const result = await gate.evaluate(buildPassingIntent(), buildPassingContext());

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
            expect(result.approvedSlot).not.toBeNull();
        });

        it('returns null rejectReason on approval', async () => {
            const { gate } = makeGate();
            const result = await gate.evaluate(buildPassingIntent(), buildPassingContext());

            expect(result.rejectReason).toBeNull();
        });

        it('returns approvedSizing matching the intent sizing on approval', async () => {
            const { gate } = makeGate();
            const sizing = buildSizing({ qty: new Money('0.05') });
            const result = await gate.evaluate(buildPassingIntent({ sizing }), buildPassingContext());

            expect(result.approvedSizing?.qty.equals(new Money('0.05'))).toBe(true);
        });
    });

    // ─── rejected decision structure ──────────────────────────────────────────

    describe('rejected decision structure', () => {
        it('returns REJECTED outcome with a non-null rejectReason', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ belowUniverseFloor: true });
            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.REJECTED);
            expect(result.rejectReason).not.toBeNull();
        });

        it('returns null approvedSlot on rejection', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ belowUniverseFloor: true });
            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.approvedSlot).toBeNull();
        });

        it('returns null approvedSizing on rejection', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({ belowUniverseFloor: true });
            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.approvedSizing).toBeNull();
        });
    });

    // ─── pipeline ordering ────────────────────────────────────────────────────

    describe('check pipeline ordering (first failing check short-circuits)', () => {
        it('model_divergence fires before universe_floor', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                modelDivergenceDetected: true,
                belowUniverseFloor: true,
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.MODEL_DIVERGENCE_HALT);
        });

        it('universe_floor fires before OI_unavailable', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                belowUniverseFloor: true,
                snapshot: buildSnapshot({ open_interest: null as any }),
                params: { ...buildPassingContext().params, require_oi_available: true },
            });

            const result = await gate.evaluate(buildPassingIntent(), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.BELOW_UNIVERSE_FLOOR);
        });

        it('spread fires before tier3_not_validated', async () => {
            const { gate } = makeGate();
            // Use a spread that exceeds tier-3 ceiling (0.50%) but is BELOW the stress spread
            // threshold (STRESS_SPREAD_PCT = 0.6%) so that stress does NOT fire first.
            const context = buildPassingContext({
                snapshot: buildSnapshot({ bid_ask_spread_pct: 0.55 }), // > tier-3 ceiling but < stress threshold
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_3 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.SPREAD_TOO_WIDE);
        });
    });

    // ─── gate expireStaleReservations (M6 seam) ──────────────────────────────

    describe('expireStaleReservations (M6 seam)', () => {
        it('delegated correctly: calling gate.expireStaleReservations removes PENDING past TTL', async () => {
            const { gate, ledger } = makeGate();
            await gate.evaluate(buildPassingIntent(), buildPassingContext());

            // Advance clock past TTL
            const TTL_MS = 60_000;
            const NOW_MS = 1_716_307_200_000 + 5 * 60_000;
            gate.expireStaleReservations(NOW_MS + TTL_MS + 1_000);

            expect(ledger.listActive()).toHaveLength(0);
        });
    });

    // ─── coin book depth — per-tier floor (M19) ───────────────────────────────

    describe('coin book depth — per-tier floor', () => {
        // Happy-path: deep books pass the depth gate for each tier.

        it('approves tier-1 intent when book_depth_10bps_usdt is well above the tier-1 floor', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: '50000000.00' }), // far above 20_000
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        // Thin-book rejection per tier.

        it('rejects with coin_book_too_thin when tier-1 depth is below the tier-1 floor (20_000)', async () => {
            const { gate } = makeGate();
            const thinDepth = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_1] - 1; // 19_999
            const context = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: String(thinDepth) }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        });

        it('rejects with coin_book_too_thin when tier-2 depth is below the tier-2 floor (10_000)', async () => {
            const { gate } = makeGate();
            const thinDepth = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2] - 1; // 9_999
            const context = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: String(thinDepth) }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_2 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        });

        it('rejects with coin_book_too_thin when tier-3 depth is below the tier-3 floor (5_000)', async () => {
            const { gate } = makeGate();
            const thinDepth = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_3] - 1; // 4_999
            const context = buildPassingContext({
                // Tier-3 needs a validated version; but depth fires before tier3 check.
                snapshot: buildSnapshot({ book_depth_10bps_usdt: String(thinDepth) }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_3 }), context);

            // Depth check fires before tier3_not_validated in the pipeline.
            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        });

        // Boundary: tier-2 depth exactly AT the floor rejects (boundary is <=).

        const tier2Floor = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2];

        it('rejects tier-2 depth exactly at the floor (boundary: <= floor rejects)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: String(tier2Floor) }), // exactly at tier-2 floor
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_2 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
        });

        it('approves tier-2 depth just above the floor (boundary: > floor passes)', async () => {
            const { gate } = makeGate();
            const context = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: String(tier2Floor + 0.01) }),
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_2 }), context);

            // Depth gate passes; intent reaches the next legitimate gate and should approve.
            expect(result.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });

    // ─── coin book depth — adversarial fail-closed (M19) ─────────────────────

    describe('coin book depth — adversarial fail-closed', () => {
        // Every adversarial case must:
        //   1. Resolve to COIN_BOOK_TOO_THIN (not throw, not pass).
        //   2. NOT write a halt to upsertDay — thin-depth is a per-coin skip, never a halt.

        function buildAdversarialContext(depth: unknown) {
            const riskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });
            const context = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: depth as any }),
                riskState,
            });
            return { context, riskState };
        }

        it('rejects with coin_book_too_thin and does NOT halt when depth is null', async () => {
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext(null);

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        it('rejects with coin_book_too_thin and does NOT halt when depth is undefined', async () => {
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext(undefined);

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        it('rejects with coin_book_too_thin and does NOT halt when depth is empty string', async () => {
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        it('rejects with coin_book_too_thin and does NOT halt when depth is a non-numeric string', async () => {
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('NaN_garbage');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        it('rejects with coin_book_too_thin and does NOT halt when depth is negative', async () => {
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('-1000');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        it('rejects with coin_book_too_thin and does NOT halt when depth is zero', async () => {
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('0');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        it('rejects with coin_book_too_thin and does NOT halt for an unknown coinTier', async () => {
            const { gate } = makeGate();
            // Depth is deep; tier is unmapped — fail-closed on unknown tier.
            const riskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });
            const context = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: '50000000.00' }),
                riskState,
            });

            const result = await gate.evaluate(buildPassingIntent({ coinTier: 'TIER_UNKNOWN' as any }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        // The next four tests cover inputs that slipped past the old Number() guard but
        // are correctly caught by the parseMoney try/catch introduced in the M19 review fix.

        it('rejects with coin_book_too_thin and does NOT halt for whitespace-padded depth ("  100  ")', async () => {
            // "  100  " passes Number() → 100, but decimal.js parseMoney throws on leading/trailing
            // whitespace (MoneyParseException). The try/catch in isBookTooThin returns true (thin).
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('  100  ');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
            await expect(gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context)).resolves.not.toThrow();
        });

        it('rejects with coin_book_too_thin and does NOT halt for hex-notation depth ("0x10")', async () => {
            // decimal.js parses "0x10" to 16 (no throw), which is far below the tier-1 floor
            // (20_000) → too thin. This pins that an exotic-but-parseable string resolves to a
            // safe per-coin skip, never a fill — and never a halt.
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('0x10');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
            await expect(gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context)).resolves.not.toThrow();
        });

        it('rejects with coin_book_too_thin for scientific-notation depth below tier floor ("1e3" = 1000 < tier-1 floor 20_000)', async () => {
            // "1e3" is valid decimal.js input (parses to 1000). 1000 < COIN_DEPTH_FLOOR[TIER_1]=20_000 → thin.
            // This confirms the guard works for scientific notation that happens to be below the floor.
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('1e3');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
        });

        it('rejects with coin_book_too_thin and does NOT halt for only-whitespace depth ("  ")', async () => {
            // "  " (only whitespace) passes Number() → NaN but parseMoney throws.
            // The try/catch returns true (thin). No throw escapes the gate.
            const { gate } = makeGate();
            const { context, riskState } = buildAdversarialContext('  ');

            const result = await gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context);

            expect(result.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(riskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));
            await expect(gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context)).resolves.not.toThrow();
        });

        it('does NOT throw an exception for any adversarial depth input', async () => {
            const { gate } = makeGate();
            const adversarialInputs = [null, undefined, '', '  ', 'garbage', '0x10', '  100  ', '-999', '0', NaN, Infinity];

            for (const depth of adversarialInputs) {
                const context = buildPassingContext({
                    snapshot: buildSnapshot({ book_depth_10bps_usdt: depth as any }),
                });
                await expect(gate.evaluate(buildPassingIntent({ coinTier: CoinTierEnum.TIER_1 }), context)).resolves.not.toThrow();
            }
        });
    });

    // ─── day-contagion regression (M19 core proof) ───────────────────────────

    describe('day-contagion regression — thin alt does NOT halt the day for deep coins', () => {
        // This is the core M19 regression guard: before M19, a single thin-depth alt
        // would flip risk_state.is_halted=true, causing every subsequent signal that
        // day to be rejected as GLOBAL_HALT — even deep-book tier-1 coins. M19 moves
        // depth to a per-coin eligibility skip so it can never set is_halted.
        //
        // Proof: evaluate a thin tier-2 signal → COIN_BOOK_TOO_THIN (not a halt).
        // Then, with the SAME UTC-day risk state (still not halted), evaluate a deep
        // tier-1 signal → APPROVED (or any reason other than GLOBAL_HALT).

        it('thin tier-2 coin is skipped with coin_book_too_thin; deep tier-1 coin on the same UTC day is NOT global_halt', async () => {
            const { gate } = makeGate();

            // Shared risk-state fixture: today's row exists, not halted.
            const sharedRiskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });

            // Step 1 — thin tier-2 signal.
            const tier2Floor = COIN_DEPTH_FLOOR_10BPS_USDT[CoinTierEnum.TIER_2];
            const thinContext = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: String(tier2Floor - 1) }), // below tier-2 floor
                riskState: sharedRiskState,
            });
            const thinResult = await gate.evaluate(
                buildPassingIntent({ coinTier: CoinTierEnum.TIER_2, eventId: 'ALTUSDT:thin', symbol: 'ALTUSDT' }),
                thinContext,
            );

            // Thin coin is skipped per-coin — not a halt.
            expect(thinResult.outcome).toBe(RiskOutcomeEnum.REJECTED);
            expect(thinResult.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            // upsertDay MUST NOT have been called with is_halted:true — depth is not a halt signal.
            expect(sharedRiskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));

            // Step 2 — deep tier-1 signal on the SAME UTC day (same risk state, still not halted).
            const deepContext = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: '50000000.00' }), // well above tier-1 floor
                riskState: sharedRiskState,
            });
            const deepResult = await gate.evaluate(
                buildPassingIntent({ coinTier: CoinTierEnum.TIER_1, eventId: 'SOLUSDT:deep', symbol: 'SOLUSDT' }),
                deepContext,
            );

            // Deep tier-1 coin must NOT be rejected as GLOBAL_HALT.
            expect(deepResult.rejectReason).not.toBe(RejectReasonEnum.GLOBAL_HALT);
            // In a clean state it should approve entirely.
            expect(deepResult.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });

        it('thin tier-3 coin does NOT set is_halted so a subsequent deep tier-1 signal is NOT global_halt', async () => {
            const { gate } = makeGate();

            const sharedRiskState = buildRiskStatePort({ day: buildRiskStateDay({ isHalted: false }) });

            // Thin tier-3.
            const thinContext = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: '100' }), // below tier-3 floor
                riskState: sharedRiskState,
            });
            const thinResult = await gate.evaluate(
                buildPassingIntent({ coinTier: CoinTierEnum.TIER_3, eventId: 'MEME:thin', symbol: 'MEMEUSDT' }),
                thinContext,
            );

            expect(thinResult.rejectReason).toBe(RejectReasonEnum.COIN_BOOK_TOO_THIN);
            expect(sharedRiskState.upsertDay).not.toHaveBeenCalledWith(expect.objectContaining({ isHalted: true }));

            // Deep tier-1 follows — same day, same not-halted state.
            const deepContext = buildPassingContext({
                snapshot: buildSnapshot({ book_depth_10bps_usdt: '50000000.00' }),
                riskState: sharedRiskState,
            });
            const deepResult = await gate.evaluate(
                buildPassingIntent({ coinTier: CoinTierEnum.TIER_1, eventId: 'BNBUSDT:deep', symbol: 'BNBUSDT' }),
                deepContext,
            );

            expect(deepResult.rejectReason).not.toBe(RejectReasonEnum.GLOBAL_HALT);
            expect(deepResult.outcome).toBe(RiskOutcomeEnum.APPROVED);
        });
    });
});
