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

// Global market-stress detector (ADR 0004 §6). Reads ONLY fields already on the market
// snapshot (M1 fast-stress inputs) so it is deterministic and replayable with no extra I/O.
// When stress indicates trend-initiation it OVERRIDES the ADX/regime "ranging" verdict — the
// fast-stress inputs lead the lagging ADX. The check sits before any regime/slot logic so it
// short-circuits ahead of ADX-derived eligibility.
@Injectable()
export class StressHaltEvaluator {
    isStressed(snapshot: IMarketSnapshot, params: IStrategyParams): boolean {
        if (this.hasInvalidStressInputs(snapshot)) {
            return true;
        }

        if (this.isIndexShock(snapshot)) {
            return true;
        }

        if (this.isBreadthCollapse(snapshot)) {
            return true;
        }

        if (snapshot.same_bar_trigger_count >= params.stress_same_bar_trigger_count) {
            return true;
        }

        if (Math.abs(snapshot.open_interest_change_5m_pct) >= STRESS_OI_CHANGE_5M_PCT) {
            return true;
        }

        if (Math.abs(snapshot.funding_rate_annualized) >= STRESS_FUNDING_ANNUALIZED_PCT) {
            return true;
        }

        return this.isLiquidityShock(snapshot);
    }

    // Classify the canonical halt_reason leg suffix for a snapshot already known to be stressed
    // (ADR 0004 §6d). Enumerates every engage path so no engage is silently misclassified, and
    // applies most-conservative-leg-wins: `breadth` only when breadth is the SOLE engaging global
    // leg; `multi` when two or more legs engage together. Only `breadth` is resume-eligible —
    // every other suffix stays full-day locked.
    classifyHaltLeg(snapshot: IMarketSnapshot, params: IStrategyParams): string {
        if (this.hasInvalidStressInputs(snapshot)) {
            return HALT_LEG_INVALID;
        }

        const legs = this.activeStressLegs(snapshot, params);

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
    // per-coin spread play no
    // role here (they live at the per-entry eligibility gate), so a single coin cannot perpetually
    // block resume after the global breadth cause has cleared.
    isGlobalStressed(snapshot: IMarketSnapshot): boolean {
        const guarded = [snapshot.btc_5m_move_pct, snapshot.eth_5m_move_pct, snapshot.market_breadth_5m_up_pct];

        if (guarded.some((value) => !Number.isFinite(value))) {
            return true;
        }

        const distanceFromBalance = Math.abs(snapshot.market_breadth_5m_up_pct - MARKET_BREADTH_NEUTRAL_PCT);

        return distanceFromBalance > MARKET_STRESS_RESUME_BREADTH_DISTANCE;
    }

    // Every engage leg active on this snapshot, in the §6d enumeration order. Excludes the
    // invalid-inputs guard (handled by classifyHaltLeg before this runs).
    private activeStressLegs(snapshot: IMarketSnapshot, params: IStrategyParams): string[] {
        const legs: string[] = [];

        if (Math.abs(snapshot.btc_5m_move_pct) >= STRESS_BTC_5M_SHOCK_PCT) {
            legs.push(HALT_LEG_BTC_SHOCK);
        }

        if (Math.abs(snapshot.eth_5m_move_pct) >= STRESS_ETH_5M_SHOCK_PCT) {
            legs.push(HALT_LEG_ETH_SHOCK);
        }

        if (Math.abs(snapshot.market_breadth_5m_up_pct - MARKET_BREADTH_NEUTRAL_PCT) >= STRESS_BREADTH_DISTANCE_PCT) {
            legs.push(HALT_LEG_BREADTH);
        }

        if (snapshot.same_bar_trigger_count >= params.stress_same_bar_trigger_count) {
            legs.push(HALT_LEG_SAME_BAR);
        }

        if (Math.abs(snapshot.open_interest_change_5m_pct) >= STRESS_OI_CHANGE_5M_PCT) {
            legs.push(HALT_LEG_OI);
        }

        if (Math.abs(snapshot.funding_rate_annualized) >= STRESS_FUNDING_ANNUALIZED_PCT) {
            legs.push(HALT_LEG_FUNDING);
        }

        if (snapshot.bid_ask_spread_pct >= STRESS_SPREAD_PCT) {
            legs.push(HALT_LEG_SPREAD);
        }

        return legs;
    }

    // Fail-closed (ADR 0004 §6 safety): a NaN/Infinity in any consumed numeric stress input
    // is treated AS stress, never as "no stress" (a NaN comparison would otherwise be false).
    // The guard now covers btc_5m_move_pct (the active index-shock field, ADR 0004 §6c);
    // btc_1m_move_pct is intentionally absent — it exits the stress contract and stays on the
    // snapshot for telemetry only.
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

    private isIndexShock(snapshot: IMarketSnapshot): boolean {
        const btcShock = Math.abs(snapshot.btc_5m_move_pct) >= STRESS_BTC_5M_SHOCK_PCT;
        const ethShock = Math.abs(snapshot.eth_5m_move_pct) >= STRESS_ETH_5M_SHOCK_PCT;

        return btcShock || ethShock;
    }

    // Breadth collapse OR surge: a move of STRESS_BREADTH_DISTANCE_PCT away from the neutral
    // midpoint (ADR 0004 §6b). Reads the risk-only halt-distance const, NOT the
    // `stress_breadth_pct` strategy param — those two knobs are intentionally decoupled (the
    // param keeps driving classifyFlowType MARKET_BETA routing unchanged).
    private isBreadthCollapse(snapshot: IMarketSnapshot): boolean {
        const distanceFromBalance = Math.abs(snapshot.market_breadth_5m_up_pct - MARKET_BREADTH_NEUTRAL_PCT);

        return distanceFromBalance >= STRESS_BREADTH_DISTANCE_PCT;
    }

    // Spread widening is the remaining global liquidity-shock proxy (ADR 0004 §6 M19): a
    // market-wide spread blowout is genuinely systemic and still halts. Book depth moved to a
    // per-coin eligibility guard (RiskGateService.isBookTooThin, §6a) and no longer halts.
    private isLiquidityShock(snapshot: IMarketSnapshot): boolean {
        return snapshot.bid_ask_spread_pct >= STRESS_SPREAD_PCT;
    }
}
