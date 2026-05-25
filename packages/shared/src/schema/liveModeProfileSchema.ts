import { z } from 'zod';
import { ILiveModeProfile } from '../interface/ILiveModeProfile.js';

// M11a W0.3: Zod schema for ILiveModeProfile. Strict validation with defensible ranges.
// risk_per_trade_pct is a percentage (0–1); counts are positive integers.
export const liveModeProfileSchema = z.object({
	live_mode: z.literal('restricted'),
	max_open_positions: z.number().int().positive(),
	max_coin_tier: z.number().int().positive(),
	risk_per_trade_pct: z.number().min(0).max(1),
	allow_mean_reversion: z.boolean(),
	allow_momentum: z.boolean(),
	require_exhaustion_confirmation: z.boolean(),
	require_oi_available: z.boolean(),
	skip_fresh_universe_entrants: z.boolean(),
	skip_market_stress: z.boolean(),
	max_trades_per_day: z.number().int().positive(),
	halt_after_consecutive_losses: z.number().int().positive(),
	margin_mode: z.enum(['isolated', 'cross']),
}) satisfies z.ZodType<ILiveModeProfile>;
