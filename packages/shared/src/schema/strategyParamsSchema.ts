import { z } from 'zod';

// Zod schema for strategy_versions.params JSONB.
// Mirrors the M2 canonical params keys exactly in their persisted snake_case form.
// Per-version optional keys are marked .optional().
//
// RISK-ONLY FIELDS NOTE (ADR conflict #2):
// The following keys are validated here for completeness but are consumed by M4 (risk gate),
// NOT by M3 strategies: max_open_positions, max_btc_correlated_positions, consecutive_loss_halt,
// max_trades_per_symbol_per_day, max_trades_per_bar_universe, stress_btc_1m_shock_pct,
// stress_eth_1m_shock_pct, stress_breadth_pct, stress_same_bar_trigger_count.
// Reviewers enforce that strategies never read these.
const baseSchema = z
    .object({
        // Base params (shared by all versions)
        vwap_window_bars: z.number().min(1),
        vwap_sigma_trigger: z.number().positive(),
        volume_ratio_min: z.number().positive(),
        atr_period: z.number().min(1),
        atr_stop_multiplier: z.number().positive(),
        time_stop_minutes: z.number().min(1),
        idiosyncrasy_min_score: z.number().min(0).max(1),
        btc_correlated_move_threshold_pct: z.number().positive(),
        max_open_positions: z.number().min(1),
        max_btc_correlated_positions: z.number().min(0),
        tier1_min_abs_move_pct: z.number().positive(),
        tier2_min_abs_move_pct: z.number().positive(),
        tier3_min_abs_move_pct: z.number().positive(),
        tier1_max_abs_move_pct: z.number().positive(),
        tier2_max_abs_move_pct: z.number().positive(),
        tier3_max_abs_move_pct: z.number().positive(),
        funding_rate_suppress_threshold: z.number().min(0),
        candle_interval: z.literal('5m'),
        slippage_tier1_pct: z.number().positive(),
        slippage_tier2_pct: z.number().positive(),
        slippage_tier3_pct: z.number().positive(),
        require_oi_available: z.boolean(),
        oi_rising_skip: z.boolean(),
        consecutive_loss_halt: z.number().min(1),
        max_trades_per_symbol_per_day: z.number().min(1),
        max_trades_per_bar_universe: z.number().min(1),
        // DEPRECATED as of M21 (2026-06-04):
        // The BTC shock path now reads btc_5m_move_pct against engine const STRESS_BTC_5M_SHOCK_PCT = 1.5 in riskConsts.ts.
        // stress_btc_1m_shock_pct is no longer consumed by the live stress-halt path.
        // Retained and still validated for historical replay compatibility.
        stress_btc_1m_shock_pct: z.number().positive(),
        // DEPRECATED as of M21 (2026-06-04):
        // The ETH shock path now reads eth_5m_move_pct against engine const STRESS_ETH_5M_SHOCK_PCT = 2.5 in riskConsts.ts.
        // stress_eth_1m_shock_pct is no longer consumed by the live stress-halt path.
        // Retained and still validated for historical replay compatibility.
        stress_eth_1m_shock_pct: z.number().positive(),
        stress_breadth_pct: z.number().min(0).max(100),
        stress_same_bar_trigger_count: z.number().min(1),
        structural_stop_wick_buffer_pct: z.number().positive(),
        structural_stop_hard_cap_pct: z.number().positive(),

        // M47 R:R geometry coupling params (core target and noise floors)
        // Unit convention: min_rr, atr_floor_multiplier, max_tp_dist_factor are plain multipliers.
        // entry_pct_floor is a percent-number (e.g., 0.3 = 0.3%), matching structural_stop_hard_cap_pct.
        // Do NOT mix fraction and percent-number forms; divide entry_pct_floor by 100 before applying to a price.
        min_rr: z.number().positive(),
        entry_pct_floor: z.number().positive(),
        atr_floor_multiplier: z.number().positive(),
        max_tp_dist_factor: z.number().positive(),

        // Per-version optional keys
        trade_enabled: z.boolean().optional(),
        direction: z.string().optional(), // Redundant with strategy_versions.direction column; column is authoritative
        require_exhaustion_confirmation: z.boolean().optional(),
    })
    .strict();

// Apply refinements: tier bands must be valid (max > min)
export const strategyParamsSchema = baseSchema
    .refine((params) => params.tier1_max_abs_move_pct > params.tier1_min_abs_move_pct, {
        message: 'tier1_max_abs_move_pct must be greater than tier1_min_abs_move_pct',
        path: ['tier1_max_abs_move_pct'],
    })
    .refine((params) => params.tier2_max_abs_move_pct > params.tier2_min_abs_move_pct, {
        message: 'tier2_max_abs_move_pct must be greater than tier2_min_abs_move_pct',
        path: ['tier2_max_abs_move_pct'],
    })
    .refine((params) => params.tier3_max_abs_move_pct > params.tier3_min_abs_move_pct, {
        message: 'tier3_max_abs_move_pct must be greater than tier3_min_abs_move_pct',
        path: ['tier3_max_abs_move_pct'],
    });

export type IStrategyParams = z.infer<typeof strategyParamsSchema>;
