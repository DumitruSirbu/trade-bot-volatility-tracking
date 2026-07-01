import { Decimal } from 'decimal.js';

import { COIN_DEPTH_FLOOR_10BPS_USDT } from '../const/riskConsts.js';
import { CoinTierEnum } from '../enum/CoinTierEnum.js';
import { RejectReasonEnum } from '../enum/RejectReasonEnum.js';

export interface IGateDetailView {
    readonly label: string;
    readonly hint: string;
}

const DECIMAL_REGEX = /^-?\d+(\.\d+)?$/;

function formatCompactUsd(value: Decimal): string {
    const rounded = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

    return `$${rounded.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function parseDepthUsdt(raw: unknown): Decimal | null {
    if (raw === null || raw === undefined || raw === '') {
        return null;
    }

    const asString = typeof raw === 'string' ? raw.trim() : String(raw);

    if (!DECIMAL_REGEX.test(asString)) {
        return null;
    }

    const depth = new Decimal(asString);

    if (!depth.isFinite() || depth.lessThanOrEqualTo(0)) {
        return null;
    }

    return depth;
}

function resolveCoinTier(raw: unknown): CoinTierEnum | null {
    if (raw === CoinTierEnum.TIER_1 || raw === CoinTierEnum.TIER_2 || raw === CoinTierEnum.TIER_3) {
        return raw;
    }

    return null;
}

// Projects per-gate observability onto IDecisionView for dashboard operators.
// Currently only coin_book_too_thin — extend with spread/funding detail as needed.
export function extractGateDetail(reason: string | null | undefined, snapshot: unknown): IGateDetailView | null {
    if (reason !== RejectReasonEnum.COIN_BOOK_TOO_THIN) {
        return null;
    }

    if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') {
        return null;
    }

    const record = snapshot as Record<string, unknown>;
    const tier = resolveCoinTier(record['coin_tier']);
    const depth = parseDepthUsdt(record['book_depth_10bps_usdt']);

    if (tier === null || depth === null) {
        return null;
    }

    const floor = COIN_DEPTH_FLOOR_10BPS_USDT[tier];
    const floorMoney = new Decimal(floor);
    const pct = depth.div(floorMoney).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const shortBy = floorMoney.minus(depth);

    return {
        label: `${formatCompactUsd(depth)} / ${formatCompactUsd(floorMoney)} · ${pct.toFixed(0)}%`,
        hint: `10bps one-sided depth $${depth.toFixed(2)} — ${tier} floor $${floorMoney.toFixed(0)} — short $${shortBy.toFixed(2)}`,
    };
}
