// M12 W4 — `list_positions` MCP tool.
//
// Adapter onto `@bot/analysis.listPositions`. Cursor pagination + filters
// (symbol, versionId, status, time window). Returns `IPaginated<...>` over the
// union of open/closed position views.
//
// Boundary invariant (ADR 0033 §2.2): no `@bot/engine` imports.

import { AnalysisValidationError, createMcpDataSource, listPositions } from '@bot/analysis';
import type { IClosedPositionView, IOpenPositionView, IPaginated } from '@bot/shared';

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

import { ListPositionsParamsSchema, type ListPositionsParams } from '../dtos/index.js';
import { McpToolError } from '../errors/McpToolError.js';
import type { IReadOnlyToolRegistration } from './ToolRegistry.js';

const INPUT_JSON_SCHEMA = {
    type: 'object',
    properties: {
        symbol: { type: 'string', description: 'Optional symbol filter (e.g. BTCUSDT). Uppercase alphanumeric.' },
        versionId: { type: 'integer', minimum: 1 },
        status: { type: 'string', enum: ['open', 'closed'] },
        from: { type: 'string', description: 'ISO 8601 lower bound (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 upper bound (exclusive).' },
        cursor: { type: 'string', description: 'Opaque pagination cursor returned by a previous call.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['from', 'to'],
    additionalProperties: false,
} as const;

export function buildListPositionsTool(ds: AnalysisDataSource): IReadOnlyToolRegistration<typeof ListPositionsParamsSchema> {
    return {
        name: 'list_positions',
        description: 'List open and/or closed positions filtered by symbol, version, and status across a time window. Cursor-paginated.',
        paramsSchema: ListPositionsParamsSchema,
        inputJsonSchema: INPUT_JSON_SCHEMA,
        handler: async (params: ListPositionsParams): Promise<IPaginated<IOpenPositionView | IClosedPositionView>> => {
            try {
                return await listPositions(ds, {
                    symbol: params.symbol,
                    versionId: params.versionId,
                    status: params.status,
                    from: new Date(params.from),
                    to: new Date(params.to),
                    cursor: params.cursor,
                    limit: params.limit,
                });
            } catch (cause) {
                if (cause instanceof AnalysisValidationError) {
                    throw McpToolError.validation(cause.message, cause);
                }
                throw McpToolError.internal('list_positions failed', cause);
            }
        },
    };
}
