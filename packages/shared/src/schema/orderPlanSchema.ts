import { z } from 'zod';

import { OrderPolicyEnum } from '../enum/OrderPolicyEnum.js';

export const orderPlanSchema = z.object({
    policy: z.nativeEnum(OrderPolicyEnum),
    limitPrice: z.string().describe('Decimal string, never float'),
    timeoutMs: z.number().int().positive(),
    slippageCapPct: z.string().describe('Decimal string, never float'),
    reduceOnly: z.boolean(),
});

export type IOrderPlan = z.infer<typeof orderPlanSchema>;
