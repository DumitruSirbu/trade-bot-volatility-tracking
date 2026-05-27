// M12 W3 — ToolRegistry unit tests: param validation + unknown-tool routing.

import { z } from 'zod';

import { McpToolError, McpToolErrorKindEnum } from '../../src/errors/McpToolError';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

const echoSchema = z.object({
    n: z.number().int().positive(),
});

describe('ToolRegistry', () => {
    it('lists registered tools with name + description + inputSchema', () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool({
            name: 'echo',
            description: 'returns n',
            paramsSchema: echoSchema,
            inputJsonSchema: { type: 'object', properties: { n: { type: 'integer' } } },
            handler: async (params) => ({ n: params.n }),
        });

        const tools = registry.listTools();
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('echo');
        expect(tools[0].description).toBe('returns n');
        expect(tools[0].inputSchema).toEqual({ type: 'object', properties: { n: { type: 'integer' } } });
    });

    it('throws NOT_FOUND when callTool is invoked with an unknown tool name', async () => {
        const registry = new ToolRegistry();

        await expect(registry.callTool('nope', {})).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.NOT_FOUND,
        });
    });

    it('throws VALIDATION when params fail the Zod schema', async () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool({
            name: 'echo',
            description: 'returns n',
            paramsSchema: echoSchema,
            inputJsonSchema: {},
            handler: async (params) => ({ n: params.n }),
        });

        const attempt = registry.callTool('echo', { n: -1 });
        await expect(attempt).rejects.toBeInstanceOf(McpToolError);
        await expect(attempt).rejects.toMatchObject({ kind: McpToolErrorKindEnum.VALIDATION });
    });

    it('invokes the handler with parsed params on success', async () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool({
            name: 'echo',
            description: 'returns n',
            paramsSchema: echoSchema,
            inputJsonSchema: {},
            handler: async (params) => ({ doubled: params.n * 2 }),
        });

        const result = await registry.callTool('echo', { n: 7 });
        expect(result).toEqual({ doubled: 14 });
    });

    it('rejects double-registration of the same tool name', () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool({
            name: 'echo',
            description: 'x',
            paramsSchema: echoSchema,
            inputJsonSchema: {},
            handler: async () => null,
        });

        expect(() =>
            registry.registerReadOnlyTool({
                name: 'echo',
                description: 'y',
                paramsSchema: echoSchema,
                inputJsonSchema: {},
                handler: async () => null,
            }),
        ).toThrow(/already registered/);

        // why: fix wave 4b — boot-time programming error is now a typed
        // `McpToolError(INTERNAL)`, not a raw `Error`, so the global handler
        // logs structured kind. The convention forbids raw `throw new Error`.
        try {
            registry.registerReadOnlyTool({
                name: 'echo',
                description: 'z',
                paramsSchema: echoSchema,
                inputJsonSchema: {},
                handler: async () => null,
            });
            fail('expected duplicate registration to throw');
        } catch (caught) {
            expect(caught).toBeInstanceOf(McpToolError);
            expect((caught as McpToolError).kind).toBe(McpToolErrorKindEnum.INTERNAL);
        }
    });

    it('has NO public surface for registering write/mutation-shaped tools', () => {
        const registry = new ToolRegistry() as unknown as Record<string, unknown>;

        // Surface assertion: structural read-only guarantee (ADR 0033 §2).
        expect(registry.registerMutation).toBeUndefined();
        expect(registry.registerWriteTool).toBeUndefined();
        expect(registry.registerTool).toBeUndefined();
    });
});
