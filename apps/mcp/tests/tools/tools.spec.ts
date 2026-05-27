// M12 W4 — unit tests for the 4 query tools (get_performance, compare_versions,
// list_positions, get_decisions). Each test stubs the corresponding
// @bot/analysis function so the suite never touches a real DB.

import { McpToolErrorKindEnum } from '../../src/errors/McpToolError';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

jest.mock('@bot/analysis', () => {
    class AnalysisValidationError extends Error {
        readonly field: string;
        constructor(field: string, detail: string) {
            super(`analysis input invalid (${field}): ${detail}`);
            this.name = 'AnalysisValidationError';
            this.field = field;
        }
    }
    return {
        __esModule: true,
        AnalysisValidationError,
        getPerformance: jest.fn(),
        compareVersions: jest.fn(),
        listPositions: jest.fn(),
        getDecisions: jest.fn(),
    };
});

import * as analysis from '@bot/analysis';
import { buildCompareVersionsTool } from '../../src/tools/compareVersions.tool';
import { buildGetDecisionsTool } from '../../src/tools/getDecisions.tool';
import { buildGetPerformanceTool } from '../../src/tools/getPerformance.tool';
import { buildListPositionsTool } from '../../src/tools/listPositions.tool';

// Tools take an opaque DataSource; tests never use its methods (analysis is
// mocked), so an empty object cast is sufficient and avoids depending on
// `typeorm` from within the MCP package.
const fakeDs = {} as never;

// Use a fixed "now" inside the schemas' future-cap window. The schema rejects
// `to` > Date.now(); these fixtures sit well in the past.
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-15T00:00:00.000Z';

afterEach(() => {
    jest.clearAllMocks();
});

describe('get_performance tool', () => {
    it('passes validated params to analysis.getPerformance and returns its result', async () => {
        const expected = { strategyVersionId: '7', label: 'x', status: 'active', windowDays: 14, tradeCount: 3 };
        (analysis.getPerformance as jest.Mock).mockResolvedValueOnce(expected);

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetPerformanceTool(fakeDs));

        const result = await registry.callTool('get_performance', {
            versionId: 7,
            from: FROM,
            to: TO,
        });

        expect(result).toBe(expected);
        expect(analysis.getPerformance).toHaveBeenCalledTimes(1);
        const callArgs = (analysis.getPerformance as jest.Mock).mock.calls[0];
        expect(callArgs[0]).toBe(fakeDs);
        expect(callArgs[1].versionId).toBe(7);
        expect(callArgs[1].from).toBeInstanceOf(Date);
        expect(callArgs[1].to).toBeInstanceOf(Date);
    });

    it('classifies AnalysisValidationError from analysis as VALIDATION', async () => {
        (analysis.getPerformance as jest.Mock).mockImplementationOnce(() => {
            throw new (analysis as unknown as { AnalysisValidationError: new (f: string, m: string) => Error }).AnalysisValidationError('versionId', 'bad');
        });

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetPerformanceTool(fakeDs));

        await expect(registry.callTool('get_performance', { versionId: 1, from: FROM, to: TO })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.VALIDATION,
        });
    });

    it('classifies any other thrown error from analysis as INTERNAL', async () => {
        (analysis.getPerformance as jest.Mock).mockRejectedValueOnce(new Error('postgres exploded'));

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetPerformanceTool(fakeDs));

        await expect(registry.callTool('get_performance', { versionId: 1, from: FROM, to: TO })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.INTERNAL,
        });
    });

    it('rejects malformed params via the Zod schema (VALIDATION) end-to-end', async () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetPerformanceTool(fakeDs));

        await expect(registry.callTool('get_performance', { versionId: -1, from: FROM, to: TO })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.VALIDATION,
        });

        expect(analysis.getPerformance).not.toHaveBeenCalled();
    });
});

describe('compare_versions tool', () => {
    it('happy path — invokes analysis.compareVersions with parsed Dates', async () => {
        const expected = {
            aPerformance: {},
            bPerformance: {},
            pairedDiff: { pairedEventCount: 0, pairedTradedEventCount: 0, netPnlDeltaUsd: '0', meanPnlDeltaUsd: null },
        };
        (analysis.compareVersions as jest.Mock).mockResolvedValueOnce(expected);

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildCompareVersionsTool(fakeDs));

        const result = await registry.callTool('compare_versions', {
            aVersionId: 1,
            bVersionId: 2,
            from: FROM,
            to: TO,
        });

        expect(result).toBe(expected);
        expect(analysis.compareVersions).toHaveBeenCalledTimes(1);
    });

    it('classifies analysis throw as INTERNAL', async () => {
        (analysis.compareVersions as jest.Mock).mockRejectedValueOnce(new Error('boom'));

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildCompareVersionsTool(fakeDs));

        await expect(registry.callTool('compare_versions', { aVersionId: 1, bVersionId: 2, from: FROM, to: TO })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.INTERNAL,
        });
    });
});

describe('list_positions tool', () => {
    it('happy path — passes filter fields through', async () => {
        const expected = { items: [], nextCursor: null, pageSize: 0 };
        (analysis.listPositions as jest.Mock).mockResolvedValueOnce(expected);

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildListPositionsTool(fakeDs));

        const result = await registry.callTool('list_positions', {
            symbol: 'BTCUSDT',
            status: 'closed',
            limit: 50,
            from: FROM,
            to: TO,
        });

        expect(result).toBe(expected);
        const args = (analysis.listPositions as jest.Mock).mock.calls[0][1];
        expect(args.symbol).toBe('BTCUSDT');
        expect(args.status).toBe('closed');
        expect(args.limit).toBe(50);
    });

    it('classifies analysis throw as INTERNAL', async () => {
        (analysis.listPositions as jest.Mock).mockRejectedValueOnce(new Error('db'));

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildListPositionsTool(fakeDs));

        await expect(registry.callTool('list_positions', { from: FROM, to: TO })).rejects.toMatchObject({ kind: McpToolErrorKindEnum.INTERNAL });
    });
});

describe('get_decisions tool', () => {
    it('happy path — defaults includeSnapshot to false', async () => {
        const expected = { items: [], snapshots: null };
        (analysis.getDecisions as jest.Mock).mockResolvedValueOnce(expected);

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetDecisionsTool(fakeDs));

        const result = await registry.callTool('get_decisions', {
            symbol: 'ETHUSDT',
            from: FROM,
            to: TO,
        });

        expect(result).toBe(expected);
        const args = (analysis.getDecisions as jest.Mock).mock.calls[0][1];
        expect(args.symbol).toBe('ETHUSDT');
        expect(args.includeSnapshot).toBe(false);
    });

    it('classifies analysis throw as INTERNAL', async () => {
        (analysis.getDecisions as jest.Mock).mockRejectedValueOnce(new Error('x'));

        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetDecisionsTool(fakeDs));

        await expect(registry.callTool('get_decisions', { symbol: 'BTCUSDT', from: FROM, to: TO })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.INTERNAL,
        });
    });

    it('rejects lowercase symbol via Zod schema (VALIDATION) end-to-end', async () => {
        const registry = new ToolRegistry();
        registry.registerReadOnlyTool(buildGetDecisionsTool(fakeDs));

        await expect(registry.callTool('get_decisions', { symbol: 'btcusdt', from: FROM, to: TO })).rejects.toMatchObject({
            kind: McpToolErrorKindEnum.VALIDATION,
        });

        expect(analysis.getDecisions).not.toHaveBeenCalled();
    });
});
