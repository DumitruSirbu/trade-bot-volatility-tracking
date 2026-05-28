// M13 W1.C — `get_halt_state` MCP tool.
//
// Adapter onto `@bot/analysis.selectHaltState`. Returns the current global
// halt flag + reason + timestamp so an LLM client can decide whether to
// propose any state-changing follow-up. Read-only, no params.
//
// Boundary invariant (ADR 0033 §2.2): no `@bot/engine` imports.

import { createMcpDataSource, selectHaltState } from '@bot/analysis';
import type { IHaltStateView } from '@bot/shared';
import { z } from 'zod';

import { McpToolError } from '../errors/McpToolError.js';
import type { IReadOnlyToolRegistration } from './ToolRegistry.js';

type AnalysisDataSource = ReturnType<typeof createMcpDataSource>;

export const GetHaltStateParamsSchema = z.object({}).strict();

export type GetHaltStateParams = z.infer<typeof GetHaltStateParamsSchema>;

const INPUT_JSON_SCHEMA = {
    type: 'object',
    properties: {},
    additionalProperties: false,
} as const;

export function buildGetHaltStateTool(ds: AnalysisDataSource): IReadOnlyToolRegistration<typeof GetHaltStateParamsSchema> {
    return {
        name: 'get_halt_state',
        description: 'Return the current global halt flag, reason, and the timestamp of the most recent risk_state row.',
        paramsSchema: GetHaltStateParamsSchema,
        inputJsonSchema: INPUT_JSON_SCHEMA,
        handler: async (_params: GetHaltStateParams): Promise<IHaltStateView> => {
            try {
                return await selectHaltState(ds);
            } catch (cause) {
                throw McpToolError.internal('get_halt_state failed', cause);
            }
        },
    };
}
