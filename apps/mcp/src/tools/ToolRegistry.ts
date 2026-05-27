// M12 W3 — read-only tool registry for the MCP server.
//
// API constraint (ADR 0033 §2 — structural read-only guarantee): this
// registry exposes ONE registration method, `registerReadOnlyTool`. There
// is no `registerMutation`, no `registerWriteTool`, no generic
// `registerTool({ kind: 'write' })`. Adding write support is itself a code
// change that lands on the reviewer wave.
//
// Tools are registered by the boot path (main.ts) and invoked by the SDK
// CallToolRequest handler. The registry validates params with the tool's
// Zod schema before invoking the handler, and converts both validation
// failures and unknown-tool requests into typed `McpToolError`s.
//
// Boundary invariant (ADR 0033 §2.2): imports zod + sibling MCP files only.
// No @bot/engine, no @bot/analysis (W4 handlers will import @bot/analysis
// themselves; the registry stays infrastructure).

import type { ZodTypeAny, z } from 'zod';

import { McpToolError } from '../errors/McpToolError.js';

/**
 * The MCP SDK tool description shape used in `tools/list` responses. We
 * declare the subset we need locally rather than re-exporting the SDK type,
 * so the registry stays decoupled from a specific SDK version.
 */
export interface IMcpToolDescriptor {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the tool's input parameters (derived offline by the caller). */
    readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface IReadOnlyToolRegistration<TSchema extends ZodTypeAny> {
    readonly name: string;
    readonly description: string;
    readonly paramsSchema: TSchema;
    /** JSON Schema for `tools/list`. Required so the registry never derives JSON Schema at runtime. */
    readonly inputJsonSchema: Readonly<Record<string, unknown>>;
    readonly handler: (params: z.infer<TSchema>) => Promise<unknown>;
}

interface IRegisteredTool {
    readonly descriptor: IMcpToolDescriptor;
    readonly paramsSchema: ZodTypeAny;
    readonly handler: (params: unknown) => Promise<unknown>;
}

export class ToolRegistry {
    private readonly tools = new Map<string, IRegisteredTool>();

    /**
     * Register a READ-ONLY tool. There is intentionally no mutation-shaped
     * counterpart on this class — see file header.
     */
    registerReadOnlyTool<TSchema extends ZodTypeAny>(reg: IReadOnlyToolRegistration<TSchema>): void {
        if (this.tools.has(reg.name)) {
            // Boot-time programming error (duplicate registration is caught
            // during composition, not at runtime by the LLM caller). Use the
            // typed domain error so the global filter logs it with structured
            // kind, never a raw `Error`.
            throw McpToolError.internal(`ToolRegistry: tool '${reg.name}' is already registered`);
        }
        this.tools.set(reg.name, {
            descriptor: {
                name: reg.name,
                description: reg.description,
                inputSchema: reg.inputJsonSchema,
            },
            paramsSchema: reg.paramsSchema,
            handler: async (params: unknown): Promise<unknown> => reg.handler(params as z.infer<TSchema>),
        });
    }

    listTools(): readonly IMcpToolDescriptor[] {
        return [...this.tools.values()].map((t) => t.descriptor);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Validate + dispatch a `tools/call` request. Returns the handler result
     * on success. Throws `McpToolError.NOT_FOUND` for unknown tools and
     * `McpToolError.VALIDATION` for params that fail the Zod schema.
     */
    async callTool(name: string, rawParams: unknown): Promise<unknown> {
        const tool = this.tools.get(name);
        if (!tool) {
            throw McpToolError.notFound(`Unknown tool: '${name}'`);
        }

        const parsed = tool.paramsSchema.safeParse(rawParams);
        if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
            throw McpToolError.validation(`Invalid params for tool '${name}': ${issues}`, parsed.error);
        }

        return tool.handler(parsed.data);
    }
}
