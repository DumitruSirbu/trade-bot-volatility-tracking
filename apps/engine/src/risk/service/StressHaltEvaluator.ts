import { IMarketSnapshot, IStrategyParams } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import {
    HALT_LEG_BREADTH,
    HALT_LEG_BTC_SHOCK,
    HALT_LEG_ETH_SHOCK,
    HALT_LEG_FUNDING,
    HALT_LEG_INVALID,
    HALT_LEG_MULTI,
    HALT_LEG_OI,
    HALT_LEG_SAME_BAR,
    HALT_LEG_SPREAD,
    MARKET_BREADTH_NEUTRAL_PCT,
    MARKET_STRESS_RESUME_BREADTH_DISTANCE,
    STRESS_BREADTH_DISTANCE_PCT,
    STRESS_BTC_5M_SHOCK_PCT,
    STRESS_ETH_5M_SHOCK_PCT,
    STRESS_FUNDING_ANNUALIZED_PCT,
    STRESS_OI_CHANGE_5M_PCT,
    STRESS_SPREAD_PCT,
} from '../const';

// M25 (ADR 0042 §2) — the global stress legs that the paper exploration profile SKIPS when
// PAPER_RELAX_MARKET_STRESS is effective. Breadth and same_bar are intentionally absent: breadth
// keeps M23 engage + auto-resume, same_bar is relaxed only via its strategy param. The
// invalid-inputs guard is not a leg here — it is evaluated before, and independent of, the relax
// helper (never relaxed in any env, under any flag).
const PAPER_RELAXABLE_LEGS: ReadonlySet<string> = new Set([HALT_LEG_BTC_SHOCK, HALT_LEG_ETH_SHOCK, HALT_LEG_OI, HALT_LEG_FUNDING, HALT_LEG_SPREAD]);

// Global market-stress detector (ADR 0004 §6). Reads ONLY fields already on the market
// snapshot (M1 fast-stress inputs) so it is deterministic and replayable with no extra I/O.
// When stress indicates trend-initiation it OVERRIDES the ADX/regime "ranging" verdict — the
// fast-stress inputs lead the lagging ADX. The check sits before any regime/slot logic so it
// short-circuits ahead of ADX-derived eligibility.
@Injectable()
export class StressHaltEvaluator {
    // M25 (ADR 0042 §2) — `isPaperRelaxActive` is the effective two-condition switch resolved by
    // AppConfigService (EXCHANGE_ENV=paper AND PAPER_RELAX_MARKET_STRESS=true), passed through by
    // RiskGateService. Both this verdict and classifyHaltLeg derive their answer from the SAME
    // activeStressLegs set so the verdict and the persisted halt_reason suffix can never diverge
    // (the M23 resume contract depends on that consistency). When false, the path is byte-identical
    // to pre-M25.
    isStressed(snapshot: IMarketSnapshot, params: IStrategyParams, isPaperRelaxActive: boolean): boolean {
        if (this.hasInvalidStressInputs(snapshot)) {
            return true;
        }

        return this.activeStressLegs(snapshot, params, isPaperRelaxActive).length > 0;
    }

    // Classify the canonical halt_reason leg suffix for a snapshot already known to be stressed
    // (ADR 0004 §6d). Enumerates every engage path so no engage is silently misclassified, and
    // applies most-conservative-leg-wins: `breadth` only when breadth is the SOLE engaging global
    // leg; `multi` when two or more legs engage together. Only `breadth` is resume-eligible —
    // every other suffix stays full-day locked. Under the paper profile (ADR 0042 §2) relaxed legs
    // are excluded from the active set, so a breadth+BTC snapshot classifies as `breadth`, not
    // `multi`, keeping it resume-eligible.
    classifyHaltLeg(snapshot: IMarketSnapshot, params: IStrategyParams, isPaperRelaxActive: boolean): string {
        if (this.hasInvalidStressInputs(snapshot)) {
            return HALT_LEG_INVALID;
        }

        const legs = this.activeStressLegs(snapshot, params, isPaperRelaxActive);

        if (legs.length >= 2) {
            return HALT_LEG_MULTI;
        }

        if (legs.length === 0) {
            return HALT_LEG_INVALID;
        }

        return legs[0];
    }

    // The global resume predicate (ADR 0004 §6d): evaluates only the breadth leg for the resume
    // decision, but fail-closes on NaN in any of the three global move fields (btc_5m_move_pct,
    // eth_5m_move_pct, market_breadth_5m_up_pct). The breadth check runs at the RESUME threshold
    // (strict `>`, distinct from the engage `>=` at STRESS_BREADTH_DISTANCE_PCT). A non-finite
    // breadth/BTC/ETH 5m field is treated AS stressed so the clean-tick counter resets. Funding and
    // per-coin spread play no role here (they live at the per-entry eligibility gate), so a single
    // coin cannot perpetually
    // block resume after the global breadth cause has cleared. Breadth is never relaxed (ADR 0042
    // §2), so this predicate takes no paper flag.
    isGlobalStressed(snapshot: IMarketSnapshot): boolean {
        const guarded = [snapshot.btc_5m_move_pct, snapshot.eth_5m_move_pct, snapshot.market_breadth_5m_up_pct];

        if (guarded.some((value) => !Number.isFinite(value))) {
            return true;
        }

        const distanceFromBalance = Math.abs(snapshot.market_breadth_5m_up_pct - MARKET_BREADTH_NEUTRAL_PCT);

        return distanceFromBalance > MARKET_STRESS_RESUME_BREADTH_DISTANCE;
    }

    // Every engage leg active on this snapshot, in the §6d enumeration order. Excludes the
    // invalid-inputs guard (handled before this runs). The single source of truth for "is this leg
    // active under the current config" (ADR 0042 §2, A2): a leg engages only when it crosses its
    // threshold AND it is active under the paper profile. Both isStressed and classifyHaltLeg
    // consume this list, so a relaxed leg disappears from both surfaces atomically.
    private activeStressLegs(snapshot: IMarketSnapshot, params: IStrategyParams, isPaperRelaxActive: boolean): string[] {
        const legs: string[] = [];

        if (this.isLegActive(HALT_LEG_BTC_SHOCK, isPaperRelaxActive) && Math.abs(snapshot.btc_5m_move_pct) >= STRESS_BTC_5M_SHOCK_PCT) {
            legs.push(HALT_LEG_BTC_SHOCK);
        }

        if (this.isLegActive(HALT_LEG_ETH_SHOCK, isPaperRelaxActive) && Math.abs(snapshot.eth_5m_move_pct) >= STRESS_ETH_5M_SHOCK_PCT) {
            legs.push(HALT_LEG_ETH_SHOCK);
        }

        const isBreadthEngaging =
            this.isLegActive(HALT_LEG_BREADTH, isPaperRelaxActive) &&
            Math.abs(snapshot.market_breadth_5m_up_pct - MARKET_BREADTH_NEUTRAL_PCT) >= STRESS_BREADTH_DISTANCE_PCT;

        if (isBreadthEngaging) {
            legs.push(HALT_LEG_BREADTH);
        }

        if (this.isLegActive(HALT_LEG_SAME_BAR, isPaperRelaxActive) && snapshot.same_bar_trigger_count >= params.stress_same_bar_trigger_count) {
            legs.push(HALT_LEG_SAME_BAR);
        }

        if (this.isLegActive(HALT_LEG_OI, isPaperRelaxActive) && Math.abs(snapshot.open_interest_change_5m_pct) >= STRESS_OI_CHANGE_5M_PCT) {
            legs.push(HALT_LEG_OI);
        }

        if (this.isLegActive(HALT_LEG_FUNDING, isPaperRelaxActive) && Math.abs(snapshot.funding_rate_annualized) >= STRESS_FUNDING_ANNUALIZED_PCT) {
            legs.push(HALT_LEG_FUNDING);
        }

        if (this.isLegActive(HALT_LEG_SPREAD, isPaperRelaxActive) && snapshot.bid_ask_spread_pct >= STRESS_SPREAD_PCT) {
            legs.push(HALT_LEG_SPREAD);
        }

        return legs;
    }

    // The single shared source of truth for "is this global stress leg active under the current
    // config" (ADR 0042 §2, A2). When the paper profile is off, every leg is active — the path is
    // byte-identical to pre-M25. When on, only the relaxable legs (BTC/ETH shock, OI, funding,
    // spread) go inactive; breadth and same_bar are never in the relaxable set, and the
    // invalid-inputs guard is evaluated before this is ever called.
    private isLegActive(leg: string, isPaperRelaxActive: boolean): boolean {
        if (!isPaperRelaxActive) {
            return true;
        }

        return !PAPER_RELAXABLE_LEGS.has(leg);
    }

    // Fail-closed (ADR 0004 §6 safety): a NaN/Infinity in any consumed numeric stress input
    // is treated AS stress, never as "no stress" (a NaN comparison would otherwise be false).
    // The guard now covers btc_5m_move_pct (the active index-shock field, ADR 0004 §6c);
    // btc_1m_move_pct is intentionally absent — it exits the stress contract and stays on the
    // snapshot for telemetry only. NEVER relaxed by the paper profile (ADR 0042 §2): a malformed
    // snapshot fail-closes in every env, under any flag.
    private hasInvalidStressInputs(snapshot: IMarketSnapshot): boolean {
        const scalars = [
            snapshot.btc_5m_move_pct,
            snapshot.eth_5m_move_pct,
            snapshot.market_breadth_5m_up_pct,
            snapshot.same_bar_trigger_count,
            snapshot.open_interest_change_5m_pct,
            snapshot.funding_rate_annualized,
            snapshot.bid_ask_spread_pct,
        ];

        return scalars.some((value) => !Number.isFinite(value));
    }
}
