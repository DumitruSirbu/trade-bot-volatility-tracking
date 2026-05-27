// M12 W4 — `get_decisions` MCP tool.
//
// Adapter onto `@bot/analysis.getDecisions`. Symbol-scoped decisions slice
// with optional market-snapshot inclusion. Hard 10k row cap inside the
// analysis layer; the 30-day hard window is enforced by the DTO schema.
//
// Boundary invariant (ADR 0033 §2.2): no `@bot/engine` imports.

import { AnalysisValidationError, createMcpDataSource, getDecisions, type IGetDecisionsResult } from '@bot/analysis';

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

import { GetDecisionsParamsSchema, type GetDecisionsParams } from '../dtos/index.js';
import { McpToolError } from '../errors/McpToolError.js';
import type { IReadOnlyToolRegistration } from './ToolRegistry.js';

const INPUT_JSON_SCHEMA = {
    type: 'object',
    properties: {
        symbol: { type: 'string', description: 'Uppercase alphanumeric symbol (e.g. BTCUSDT).' },
        from: { type: 'string', description: 'ISO 8601 lower bound (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 upper bound (exclusive). Range cap: 30 days.' },
        includeSnapshot: {
            type: 'boolean',
            description: "When true, returns each decision's market_snapshot JSON. Default false.",
        },
    },
    required: ['symbol', 'from', 'to'],
    additionalProperties: false,
} as const;

export function buildGetDecisionsTool(ds: AnalysisDataSource): IReadOnlyToolRegistration<typeof GetDecisionsParamsSchema> {
    return {
        name: 'get_decisions',
        description: 'List strategy decisions (signal/skip/reject) for a symbol over a window. Optionally include market_snapshot.',
        paramsSchema: GetDecisionsParamsSchema,
        inputJsonSchema: INPUT_JSON_SCHEMA,
        handler: async (params: GetDecisionsParams): Promise<IGetDecisionsResult> => {
            try {
                return await getDecisions(ds, {
                    symbol: params.symbol,
                    from: new Date(params.from),
                    to: new Date(params.to),
                    includeSnapshot: params.includeSnapshot,
                });
            } catch (cause) {
                if (cause instanceof AnalysisValidationError) {
                    throw McpToolError.validation(cause.message, cause);
                }
                throw McpToolError.internal('get_decisions failed', cause);
            }
        },
    };
}
