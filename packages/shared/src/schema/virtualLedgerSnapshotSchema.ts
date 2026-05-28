import { z } from 'zod';
import { IVirtualLedgerSnapshot } from '../interface/IVirtualLedgerSnapshot.js';

// M11a W0.6: Zod schema for IVirtualLedgerSnapshot (JSONB shape in shadow_decisions.virtual_slot_state_snapshot).
// Validates the ledger state at the moment the gate was evaluated.
// Money fields are strings (decimal-as-string) per the shared view type convention.

const virtualOpenPositionSchema = z.object({
    symbol: z.string().trim().min(1),
    side: z.string().trim().min(1), // PositionSideEnum value
    openedAtMs: z.number().int().nonnegative(),
    openedAtEventId: z.string().trim().min(1),
    entryPrice: z.string().trim().min(1, 'entryPrice cannot be empty'),
    qty: z.string().trim().min(1, 'qty cannot be empty'),
    stopLoss: z.string().trim().min(1, 'stopLoss cannot be empty'),
    takeProfit: z.string().trim().min(1, 'takeProfit cannot be empty'),
    virtualOrderId: z.string().trim().min(1),
});

export const virtualLedgerSnapshotSchema = z.object({
    riskDayUtcDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be UTC date (YYYY-MM-DD)'),
    openPositions: z.array(virtualOpenPositionSchema),
    haltedUntilRiskDayUtcDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be UTC date (YYYY-MM-DD)')
        .nullable(),
    lastEventIdProcessed: z.string().trim().min(1),
}) satisfies z.ZodType<IVirtualLedgerSnapshot>;
