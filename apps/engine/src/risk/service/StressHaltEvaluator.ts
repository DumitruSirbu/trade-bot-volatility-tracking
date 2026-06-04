import { IMarketSnapshot, IStrategyParams } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import {
    MARKET_BREADTH_NEUTRAL_PCT,
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
