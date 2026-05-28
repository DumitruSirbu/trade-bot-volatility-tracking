// M13 W1.C — unit tests for the `get_halt_state` MCP tool.
//
// Stubs `@bot/analysis.selectHaltState` so the suite never touches a real
// DB. Verifies registry dispatch, return-shape passthrough, the strict empty
// input schema (rejects extra fields), and the INTERNAL classification of
// thrown analysis errors.

import { McpToolErrorKindEnum } from '../../src/errors/McpToolError';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

jest.mock('@bot/analysis', () => ({
    __esModule: true,
    selectHaltState: jest.fn(),
}));

import * as analysis from '@bot/analysis';
import { buildGetHaltStateTool } from '../../src/tools/getHaltState.tool';

const fakeDs = {} as never;

afterEach(() => {
    jest.clearAllMocks();
});

describe('get_halt_state tool', () => {
    it('passes through the IHaltStateView returned by analysis.selectHaltState', async () => {
        const expected = {
            isHalted: true,
            haltReason: 'daily_loss_breach',
            asOf: '2026-05-26T00:00:00.000Z',
        };
        (analysis.selectHaltState as jest.Mock).mockResolvedValueOnce(expected);

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetHaltStateTool(fakeDs));

        const result = await registry.callTool('get_halt_state', {});

        expect(result).toBe(expected);
        expect(analysis.selectHaltState).toHaveBeenCalledTimes(1);
        expect((analysis.selectHaltState as jest.Mock).mock.calls[0][0]).toBe(fakeDs);
    });

    it('rejects unknown input fields via the strict Zod schema (VALIDATION)', async () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetHaltStateTool(fakeDs));

        await expect(registry.callTool('get_halt_state', { unexpected: 'field' })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.VALIDATION,
        });

        expect(analysis.selectHaltState).not.toHaveBeenCalled();
    });

    it('classifies any thrown error from analysis as INTERNAL', async () => {
        (analysis.selectHaltState as jest.Mock).mockRejectedValueOnce(new Error('pg exploded'));

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetHaltStateTool(fakeDs));

        await expect(registry.callTool('get_halt_state', {})).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.INTERNAL,
        });
    });

    it('advertises a no-params descriptor in the tools listing', async () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetHaltStateTool(fakeDs));

        const descriptors = registry.listTools();
        const descriptor = descriptors.find((d) => d.name === 'get_halt_state');

        expect(descriptor).toBeDefined();
        expect(descriptor?.inputSchema).toMatchObject({
            type: 'object',
            properties: {},
            additionalProperties: false,
        });
    });
});
