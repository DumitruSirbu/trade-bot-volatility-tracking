// M13 W3 — runWeeklyLoop persistence-edge cases.
//
// Covers the SDF-returns-null branch (caller maps to IDEMPOTENT_SKIP and
// short-circuits) and the loss-tolerant history-INSERT path (failure logs
// but does not propagate).

import type { IProposedDraft } from '../../src/llm/ProposedDraftSchema.js';
import {
    runWeeklyLoop,
    type IRunWeeklyLoopDeps,
    type IMcpClientPort,
    type ILlmGateway,
    type IPersistencePort,
    type IReportWriterPort,
    type ILogger,
} from '../../src/loop/runWeeklyLoop.js';
import type { BacktestReportParsed, GetDecisionsResultParsed, HaltStateViewParsed, PerformanceByVersionViewParsed } from '../../src/mcp/schemas.js';

const FIXTURE_PERFORMANCE: PerformanceByVersionViewParsed = {
    strategyVersionId: '7',
    label: 'volatility-vwap',
    status: 'ACTIVE',
    windowDays: 90,
    tradeCount: 42,
    winRate: '0.55',
    netPnlUsd: '123.45',
    maxDrawdownUsd: '-50.00',
    sharpe: '0.42',
    sortino: '0.55',
    expectancyPerUnitRisk: '0.10',
};

const FIXTURE_DECISIONS: GetDecisionsResultParsed = {
    items: [
        {
            id: 'd1',
            occurredAt: '2026-05-20T00:00:00.000Z',
            symbol: 'BTCUSDT',
            action: 'OPEN',
            flowType: 'mean_revert',
            signalScore: '1.8',
            reason: null,
            strategyVersionId: '7',
            eventId: 'e1',
        },
    ],
    snapshots: null,
};

const FIXTURE_DRAFT: IProposedDraft = {
    params: { signalThreshold: 1.8 },
    rationale: 'Tighten signal threshold.',
    expectedDirection: 'better',
    confidence: 0.6,
};

function makeReport(label: string): BacktestReportParsed {
    return {
        runLabel: label,
        strategyVersionId: 7,
        strategyName: 'volatility-vwap',
        strategyVersion: 3,
        fromUtcDate: '2026-02-26',
        toUtcDate: '2026-05-27',
        tradeCount: 10,
        winCount: 6,
        lossCount: 4,
        winRatePct: '60.00',
        grossPnlUsdt: '100.00',
        feesUsdt: '5.00',
        fundingUsdt: '1.00',
        slippageCostUsdt: '2.00',
        netPnlUsdt: '92.00',
        returnPct: '9.20',
        profitFactor: '1.50',
        avgHoldMs: 3_600_000,
        maxDrawdownPct: '4.00',
        maxDrawdownDurationDays: 2,
        sharpeAnnualized: '0.42',
        sortinoAnnualized: '0.55',
        skippedTriggerCount: 1,
        rejectedByGateCount: 1,
        missedLimitFillCount: 0,
        lowFidelityTradeCount: 0,
        equityCurve: [],
        perRegime: [],
        perFlowType: [],
        perSymbol: [],
        trades: [],
    };
}

interface IHarnessOptions {
    readonly halt?: HaltStateViewParsed;
    readonly draftReturns?: number | null;
    readonly historyThrows?: Error;
    readonly historyReturns?: number | null;
}

interface IHarness {
    deps: IRunWeeklyLoopDeps;
    calls: string[];
    historyRows: Array<{ terminalState: string; draftVersionId: number | null }>;
    errorLogs: Array<{ msg: string; ctx?: Record<string, unknown> }>;
}

function makeHarness(opts: IHarnessOptions = {}): IHarness {
    const calls: string[] = [];
    const historyRows: IHarness['historyRows'] = [];
    const errorLogs: IHarness['errorLogs'] = [];

    const halt = opts.halt ?? { isHalted: false, haltReason: null, asOf: '2026-05-27T00:00:00.000Z' };

    const mcp: IMcpClientPort = {
        async getHaltState() {
            calls.push('getHaltState');
            return halt;
        },
        async getPerformance() {
            calls.push('getPerformance');
            return FIXTURE_PERFORMANCE;
        },
        async getDecisions(args) {
            calls.push(`getDecisions:${args.symbol}`);
            return FIXTURE_DECISIONS;
        },
        async runBacktest(args) {
            const tag = args.paramsOverride === undefined ? 'active' : 'draft';
            calls.push(`runBacktest:${tag}`);
            return makeReport(tag);
        },
    };

    const llm: ILlmGateway = {
        async generateStructured() {
            calls.push('llm.generateStructured');
            return { value: FIXTURE_DRAFT, usageUsd: 0.01 };
        },
        get totalUsageUsd() {
            return 0.01;
        },
    };

    const persistence: IPersistencePort = {
        async draftStrategyVersion() {
            calls.push('persistence.draftStrategyVersion');
            return opts.draftReturns === undefined ? 999 : opts.draftReturns;
        },
        async recordHistory(row) {
            calls.push('persistence.recordHistory');
            historyRows.push({ terminalState: row.terminalState, draftVersionId: row.draftVersionId });
            if (opts.historyThrows !== undefined) {
                throw opts.historyThrows;
            }
            return opts.historyReturns === undefined ? 1 : opts.historyReturns;
        },
    };

    const reportWriter: IReportWriterPort = {
        async write(weekIso, draftVersionId) {
            calls.push('reportWriter.write');
            return { mdPath: `/tmp/${weekIso}-${draftVersionId}.md`, jsonPath: `/tmp/${weekIso}-${draftVersionId}.json` };
        },
    };

    const logger: ILogger = {
        info: () => undefined,
        error: (msg, ctx) => {
            errorLogs.push({ msg, ctx });
        },
    };

    return {
        calls,
        historyRows,
        errorLogs,
        deps: {
            mcp,
            llm,
            persistence,
            reportWriter,
            logger,
            weekIso: '2026-W21',
            parentVersionId: 7,
            nowIso: '2026-05-27T00:00:00.000Z',
            modelId: 'anthropic/claude-opus-4-7',
        },
    };
}

describe('runWeeklyLoop persistence — IDEMPOTENT_SKIP branch', () => {
    it('when SDF returns null, records IDEMPOTENT_SKIP history and skips backtests + report', async () => {
        const h = makeHarness({ draftReturns: null });

        const result = await runWeeklyLoop(h.deps);

        expect(result.terminalState).toBe('IDEMPOTENT_SKIP');
        expect(result.draftVersionId).toBeNull();
        expect(result.reportPaths).toBeNull();
        expect(result.failureReason).toBeNull();

        // No backtest, no report write, only the SDF call + history row.
        expect(h.calls).not.toContain('runBacktest:active');
        expect(h.calls).not.toContain('runBacktest:draft');
        expect(h.calls).not.toContain('reportWriter.write');
        expect(h.calls).toContain('persistence.draftStrategyVersion');
        expect(h.calls).toContain('persistence.recordHistory');

        // Exactly one history row, tagged IDEMPOTENT_SKIP, no draftId.
        expect(h.historyRows).toHaveLength(1);
        expect(h.historyRows[0].terminalState).toBe('IDEMPOTENT_SKIP');
        expect(h.historyRows[0].draftVersionId).toBeNull();
    });
});

describe('runWeeklyLoop persistence — history INSERT is loss-tolerant', () => {
    it('logs but does not throw when recordHistory raises (re-fire conflict surfaced as throw)', async () => {
        const h = makeHarness({ historyThrows: new Error('duplicate key value violates unique constraint') });

        const result = await runWeeklyLoop(h.deps);

        // The SDF write already succeeded, so the loop reports COMPLETED.
        expect(result.terminalState).toBe('COMPLETED');
        expect(result.draftVersionId).toBe(999);

        // The history failure was logged.
        const failures = h.errorLogs.filter((l) => l.msg === 'agent.history.write_failed');
        expect(failures).toHaveLength(1);
    });

    it('treats recordHistory returning null (ON CONFLICT) as a no-op without throwing', async () => {
        const h = makeHarness({ historyReturns: null });
        const result = await runWeeklyLoop(h.deps);
        expect(result.terminalState).toBe('COMPLETED');
        // No error log because returning-null is the documented idempotent path.
        const failures = h.errorLogs.filter((l) => l.msg === 'agent.history.write_failed');
        expect(failures).toHaveLength(0);
    });
});
