import { z } from 'zod';

// Zod schema for strategy_versions.params JSONB when direction = 'momentum'.
// Deliberately NOT .strict() to allow forward-compatibility during the experimental phase (M50/M50b).
// The param set is expected to grow (basket sizing, vol-scaling, skip-recent-bar lookback).
// Will be tightened to .strict() once the param set settles (M50b follow-up).
// All params have defaults, so parsing an empty object yields a valid record.
const momentumParamsBaseSchema = z.object({
    top_n: z.number().int().min(1).default(3),
    lookback_ms: z.number().int().min(1).default(86_400_000),
    rebalance_interval_ms: z.number().int().min(1).default(86_400_000),
    min_universe_size: z.number().int().min(1).default(20),
    // ATR-multiple stop distance for momentum opens. Determines proposedExit.stopLossPrice.
    xmom_atr_stop_multiplier: z.number().positive().default(2.0),
    // Minimum reward:risk ratio; the risk gate rejects intents below this floor.
    xmom_min_rr: z.number().positive().default(1.5),
    // Take-profit arm ratio; decoupled from xmom_min_rr (guard floor) per M53.
    xmom_tp_arm_rr: z.number().positive().default(1.5),
    // Anchor SL/TP to expected fill instead of signal price; false = byte-identical no-op to pre-M54.
    xmom_expected_fill_enabled: z.boolean().default(false),
    // Order-size-aware thin-book skip budget; null = skip disabled; finite value = skip when orderNotional/book_depth_10bps_usdt exceeds it.
    xmom_max_depth_fraction: z.number().positive().finite().nullable().default(null),
});

export const momentumParamsSchema = momentumParamsBaseSchema.superRefine((data, ctx) => {
    if (data.xmom_expected_fill_enabled && (data.xmom_max_depth_fraction === null || data.xmom_max_depth_fraction === undefined)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['xmom_max_depth_fraction'],
            message: 'xmom_max_depth_fraction must be a finite positive number when xmom_expected_fill_enabled is true',
        });
    }
});

export type IMomentumParams = z.infer<typeof momentumParamsSchema>;
