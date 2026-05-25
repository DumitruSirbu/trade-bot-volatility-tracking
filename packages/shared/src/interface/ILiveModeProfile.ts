// M11a W0.3: Soak restricted-profile contract. Validates at boot via Zod.
// All numeric fields are counts or percentages. risk_per_trade_pct is a decimal percent
// (e.g., 0.25 = 0.25% of account equity). Field renames will cause compile errors, not
// silent drift.
export interface ILiveModeProfile {
	readonly live_mode: 'restricted';
	readonly max_open_positions: number;
	readonly max_coin_tier: number;
	readonly risk_per_trade_pct: number;
	readonly allow_mean_reversion: boolean;
	readonly allow_momentum: boolean;
	readonly require_exhaustion_confirmation: boolean;
	readonly require_oi_available: boolean;
	readonly skip_fresh_universe_entrants: boolean;
	readonly skip_market_stress: boolean;
	readonly max_trades_per_day: number;
	readonly halt_after_consecutive_losses: number;
	readonly margin_mode: 'isolated' | 'cross';
}
