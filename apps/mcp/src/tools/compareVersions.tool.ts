// M12 W4 — `compare_versions` MCP tool.
//
// Adapter onto `@bot/analysis.compareVersions`. Returns the
// `IVersionComparisonResult` shape (two `IPerformanceByVersionView` blocks +
// paired-diff summary). The wrapper shape is currently local to
// `@bot/analysis`; promotion to `@bot/shared` is flagged for the M12 reviewer
// wave.
//
// Boundary invariant (ADR 0033 §2.2): no `@bot/engine` imports.

import { AnalysisValidationError, compareVersions, createMcpDataSource, type IVersionComparisonResult } from '@bot/analysis';

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

import { CompareVersionsParamsSchema, type CompareVersionsParams } from '../dtos/index.js';
import { McpToolError } from '../errors/McpToolError.js';
import type { IReadOnlyToolRegistration } from './ToolRegistry.js';

const INPUT_JSON_SCHEMA = {
    type: 'object',
    properties: {
        aVersionId: { type: 'integer', minimum: 1 },
        bVersionId: { type: 'integer', minimum: 1 },
        from: { type: 'string', description: 'ISO 8601 lower bound (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 upper bound (exclusive).' },
        acknowledgedLargeRange: { type: 'boolean' },
    },
    required: ['aVersionId', 'bVersionId', 'from', 'to'],
    additionalProperties: false,
} as const;

export function buildCompareVersionsTool(ds: AnalysisDataSource): IReadOnlyToolRegistration<typeof CompareVersionsParamsSchema> {
    return {
        name: 'compare_versions',
        description:
            'Compare two strategy versions head-to-head over a window: per-version metrics + paired same-event PnL diff. ' +
            '`meanPnlDeltaUsd` is null when paired-traded events < 30 (see `belowSampleFloor`).',
        paramsSchema: CompareVersionsParamsSchema,
        inputJsonSchema: INPUT_JSON_SCHEMA,
        handler: async (params: CompareVersionsParams): Promise<IVersionComparisonResult> => {
            try {
                return await compareVersions(ds, {
                    aVersionId: params.aVersionId,
                    bVersionId: params.bVersionId,
                    from: new Date(params.from),
                    to: new Date(params.to),
                });
            } catch (cause) {
                if (cause instanceof AnalysisValidationError) {
                    throw McpToolError.validation(cause.message, cause);
                }
                throw McpToolError.internal('compare_versions failed', cause);
            }
        },
    };
}
