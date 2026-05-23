import { IMarketSnapshot, IStrategyParams } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { Money } from '../../common/utils/money';
import {
    MARKET_BREADTH_NEUTRAL_PCT,
    STRESS_BOOK_DEPTH_FLOOR_USDT,
    STRESS_ETH_5M_SHOCK_PCT,
    STRESS_FUNDING_ANNUALIZED_PCT,
    STRESS_OI_CHANGE_5M_PCT,
    STRESS_SPREAD_PCT,
} from '../const';

const STRESS_BOOK_DEPTH_FLOOR = new Money(STRESS_BOOK_DEPTH_FLOOR_USDT);

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

        if (this.isIndexShock(snapshot, params)) {
            return true;
        }

        if (this.isBreadthCollapse(snapshot, params)) {
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
    private hasInvalidStressInputs(snapshot: IMarketSnapshot): boolean {
        const scalars = [
            snapshot.btc_1m_move_pct,
            snapshot.eth_5m_move_pct,
            snapshot.market_breadth_5m_up_pct,
            snapshot.same_bar_trigger_count,
            snapshot.open_interest_change_5m_pct,
            snapshot.funding_rate_annualized,
            snapshot.bid_ask_spread_pct,
        ];

        return scalars.some((value) => !Number.isFinite(value));
    }

    private isIndexShock(snapshot: IMarketSnapshot, params: IStrategyParams): boolean {
        const btcShock = Math.abs(snapshot.btc_1m_move_pct) >= params.stress_btc_1m_shock_pct;
        const ethShock = Math.abs(snapshot.eth_5m_move_pct) >= STRESS_ETH_5M_SHOCK_PCT;

        return btcShock || ethShock;
    }

    // Breadth collapse OR surge: a move of stress_breadth_pct away from the neutral midpoint.
    private isBreadthCollapse(snapshot: IMarketSnapshot, params: IStrategyParams): boolean {
        const distanceFromBalance = Math.abs(snapshot.market_breadth_5m_up_pct - MARKET_BREADTH_NEUTRAL_PCT);

        return distanceFromBalance >= params.stress_breadth_pct;
    }

    private isLiquidityShock(snapshot: IMarketSnapshot): boolean {
        const spreadWidening = snapshot.bid_ask_spread_pct >= STRESS_SPREAD_PCT;
        const depthCollapse = new Money(snapshot.book_depth_10bps_usdt).lessThanOrEqualTo(STRESS_BOOK_DEPTH_FLOOR);

        return spreadWidening || depthCollapse;
    }
}
