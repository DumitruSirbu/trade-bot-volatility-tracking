import { z } from 'zod';
import { ISimulatedFill } from '../interface/ISimulatedFill.js';

// M11a W0.5: Zod schema for ISimulatedFill (JSONB shape in shadow_decisions.simulated_fill).
// Validates the output of the M7 BacktestRunnerService fill simulator before storage.
// Money fields are strings (decimal-as-string) per the shared view type convention.
export const simulatedFillSchema = z.object({
    entryPrice: z.string().trim().min(1, 'entryPrice cannot be empty'),
    exitPrice: z.string().trim().min(1).nullable(),
    slippageEntryPct: z.string().trim().min(1, 'slippageEntryPct cannot be empty'),
    slippageExitPct: z.string().trim().min(1).nullable(),
    slippageComponents: z.object({
        tierBase: z.string().trim().min(1, 'tierBase cannot be empty'),
        latency: z.string().trim().min(1, 'latency cannot be empty'),
        crossingSpread: z.string().trim().min(1, 'crossingSpread cannot be empty'),
    }),
    missed: z.boolean(),
    forceClose: z.boolean(),
    lowFidelity: z.boolean(),
    closedAt: z.string().trim().min(1).datetime().nullable(),
    closeReason: z.enum(['sl', 'tp', 'force_close', 'intra_bar_stop']).nullable(),
    feeUsdtEntry: z.string().trim().min(1).nullable().optional(),
    feeUsdtExit: z.string().trim().min(1).nullable().optional(),
    missedReason: z.enum(['missing_tick_data', 'price_not_touched']).nullable().optional(),
}) satisfies z.ZodType<ISimulatedFill>;
