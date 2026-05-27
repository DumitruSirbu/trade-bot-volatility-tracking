// M12 W4 — `get_performance` MCP tool.
//
// Thin adapter: Zod-validated params → `@bot/analysis.getPerformance` → typed
// shared `IPerformanceByVersionView`. Validation (range caps, NaN, reversed)
// is owned by `dtos/index.ts`; the analysis layer additionally rejects
// malformed inputs with `AnalysisValidationError`. Any other thrown shape is
// classified as INTERNAL with the cause confined to server-side logs.
//
// Boundary invariant (ADR 0033 §2.2): imports `@bot/analysis` + sibling MCP
// modules only. No `@bot/engine`.

import { AnalysisValidationError, createMcpDataSource, getPerformance } from '@bot/analysis';
import type { IPerformanceByVersionView } from '@bot/shared';

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

import { GetPerformanceParamsSchema, type GetPerformanceParams } from '../dtos/index.js';
import { McpToolError } from '../errors/McpToolError.js';
import type { IReadOnlyToolRegistration } from './ToolRegistry.js';

const INPUT_JSON_SCHEMA = {
    type: 'object',
    properties: {
        versionId: { type: 'integer', minimum: 1 },
        from: { type: 'string', description: 'ISO 8601 lower bound (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 upper bound (exclusive).' },
        acknowledgedLargeRange: {
            type: 'boolean',
            description: 'Required to widen range beyond 90 days. Hard cap 365 days.',
        },
    },
    required: ['versionId', 'from', 'to'],
    additionalProperties: false,
} as const;

export function buildGetPerformanceTool(ds: AnalysisDataSource): IReadOnlyToolRegistration<typeof GetPerformanceParamsSchema> {
    return {
        name: 'get_performance',
        description: 'Aggregate closed-position metrics for a single strategy version over an ISO date window.',
        paramsSchema: GetPerformanceParamsSchema,
        inputJsonSchema: INPUT_JSON_SCHEMA,
        handler: async (params: GetPerformanceParams): Promise<IPerformanceByVersionView> => {
            try {
                return await getPerformance(ds, {
                    versionId: params.versionId,
                    from: new Date(params.from),
                    to: new Date(params.to),
                });
            } catch (cause) {
                if (cause instanceof AnalysisValidationError) {
                    throw McpToolError.validation(cause.message, cause);
                }
                throw McpToolError.internal('get_performance failed', cause);
            }
        },
    };
}
