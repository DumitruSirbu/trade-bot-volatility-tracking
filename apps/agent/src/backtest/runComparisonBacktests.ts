// M13 W4 — paired backtest runner.
//
// Wraps the two `runBacktest` calls (active baseline + draft challenger) with
// a shared `(from, to)` window. The MCP server is the source of truth for the
// actual replay range; if the two responses disagree on the range it is a
// contract violation (anti-coverage) — `BacktestWindowMismatchError` is thrown
// rather than letting the report compare apples to oranges.

// eslint-disable-next-line no-restricted-imports -- agent-internal `src/mcp/` directory; ADR 0035 §2.3 layer B targets WORKSPACE reaches (apps/mcp / packages/analysis), not the agent's own subdirectories.
import type { BacktestReportParsed } from '../mcp/schemas.js';

export interface IRunComparisonBacktestsArgs {
    readonly mcp: IComparisonMcpPort;
    readonly parentVersionId: number;
    readonly draftVersionId: number;
    readonly from: string;
    readonly to: string;
    readonly draftParamsOverride?: Record<string, unknown>;
}

export interface IComparisonMcpPort {
    runBacktest(args: {
        readonly versionId: number;
        readonly from: string;
        readonly to: string;
        readonly paramsOverride?: Record<string, unknown>;
    }): Promise<BacktestReportParsed>;
}

export interface IComparisonBacktests {
    readonly active: BacktestReportParsed;
    readonly draft: BacktestReportParsed;
}

export async function runComparisonBacktests(args: IRunComparisonBacktestsArgs): Promise<IComparisonBacktests> {
    const active = await args.mcp.runBacktest({
        versionId: args.parentVersionId,
        from: args.from,
        to: args.to,
    });
    const draft = await args.mcp.runBacktest({
        versionId: args.draftVersionId,
        from: args.from,
        to: args.to,
        paramsOverride: args.draftParamsOverride,
    });
    assertSharedWindow(active, draft);
    return { active, draft };
}

function assertSharedWindow(active: BacktestReportParsed, draft: BacktestReportParsed): void {
    if (active.fromUtcDate !== draft.fromUtcDate || active.toUtcDate !== draft.toUtcDate) {
        throw new BacktestWindowMismatchError({ from: active.fromUtcDate, to: active.toUtcDate }, { from: draft.fromUtcDate, to: draft.toUtcDate });
    }
}

export class BacktestWindowMismatchError extends Error {
    public readonly activeWindow: { readonly from: string; readonly to: string };
    public readonly draftWindow: { readonly from: string; readonly to: string };

    constructor(activeWindow: { readonly from: string; readonly to: string }, draftWindow: { readonly from: string; readonly to: string }) {
        super(`Backtest window mismatch: active=[${activeWindow.from}..${activeWindow.to}] ` + `draft=[${draftWindow.from}..${draftWindow.to}]`);
        this.name = 'BacktestWindowMismatchError';
        this.activeWindow = activeWindow;
        this.draftWindow = draftWindow;
    }
}
