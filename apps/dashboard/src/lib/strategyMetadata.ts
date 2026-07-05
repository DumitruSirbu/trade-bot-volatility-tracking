// Static display metadata for strategy_versions.name (short slug). The DB only
// stores the short name — the full display name and description are cosmetic
// dashboard-only concerns, so they live here rather than in @bot/shared.
interface IStrategyDisplayMetadata {
    fullName: string;
    description: string;
}

const STRATEGY_DISPLAY_METADATA: Record<string, IStrategyDisplayMetadata> = {
    xmom: {
        fullName: 'Cross-Sectional Momentum',
        description: 'Ranks the top universe by relative momentum each rebalance and opens directional slots in the top-ranked names.',
    },
    'volatility-vwap': {
        fullName: 'Volatility VWAP',
        description:
            'VWAP-deviation detector strategy (mean-reversion/trend-fade), retired 2026-07-01 in favor of cross-sectional momentum — no longer active.',
    },
};

// Falls back to the raw short name for both fields when the name is unknown
// (future-proofing for strategies added after this lookup was written).
export const getStrategyDisplayMetadata = (strategyVersionName: string): IStrategyDisplayMetadata => {
    const metadata = STRATEGY_DISPLAY_METADATA[strategyVersionName];

    return metadata ?? { fullName: strategyVersionName, description: strategyVersionName };
};
