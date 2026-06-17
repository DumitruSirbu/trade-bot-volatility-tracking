// M13 W2.B — runWeeklyLoop integration tests with stubbed deps.
//
// Asserts the exact call-order through a shared call-log array, plus the
// halt-state short-circuit and the LLM repair-once policy.

import { ZodError } from 'zod';

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
    forceCloseFraction: null,
    missRate: null,
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

const FIXTURE_DRAFT: IProposedDraft = {
    params: { signalThreshold: 1.8 },
    rationale: 'Tighten signal threshold.',
    expectedDirection: 'better',
    confidence: 0.6,
};

interface ITestHarness {
    deps: IRunWeeklyLoopDeps;
    calls: string[];
}

function makeHarness(
    overrides: {
        halt?: HaltStateViewParsed;
        llmResults?: ReadonlyArray<IProposedDraft | Error>;
        draftVersionId?: number;
    } = {},
): ITestHarness {
    const calls: string[] = [];
    const halt: HaltStateViewParsed = overrides.halt ?? { isHalted: false, haltReason: null, asOf: '2026-05-27T00:00:00.000Z' };
    const llmResults = overrides.llmResults ?? [FIXTURE_DRAFT];
    let llmIdx = 0;

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
            const r = llmResults[llmIdx];
            llmIdx = llmIdx + 1;
            if (r === undefined) {
                throw new Error('stub exhausted');
            }
            if (r instanceof Error) {
                throw r;
            }
            return { value: r, usageUsd: 0.01 };
        },
        get totalUsageUsd() {
            return 0.01;
        },
    };

    const persistence: IPersistencePort = {
        async draftStrategyVersion() {
            calls.push('persistence.draftStrategyVersion');
            return overrides.draftVersionId ?? 999;
        },
        async recordHistory() {
            calls.push('persistence.recordHistory');
            return 1;
        },
    };

    const reportWriter: IReportWriterPort = {
        async write(weekIso, draftVersionId) {
            calls.push('reportWriter.write');
            return { mdPath: `/tmp/${weekIso}-${draftVersionId}.md`, jsonPath: `/tmp/${weekIso}-${draftVersionId}.json` };
        },
    };

    const logger: ILogger = { info: () => undefined, error: () => undefined };

    const deps: IRunWeeklyLoopDeps = {
        mcp,
        llm,
        persistence,
        reportWriter,
        logger,
        weekIso: '2026-W21',
        parentVersionId: 7,
        nowIso: '2026-05-27T00:00:00.000Z',
        modelId: 'anthropic/claude-opus-4-7',
    };

    return { deps, calls };
}

describe('runWeeklyLoop — happy path', () => {
    it('returns COMPLETED and visits every step in the exact documented order', async () => {
        const { deps, calls } = makeHarness();
        const result = await runWeeklyLoop(deps);

        expect(result.terminalState).toBe('COMPLETED');
        expect(result.draftVersionId).toBe(999);
        expect(result.reportPaths).not.toBeNull();
        expect(result.failureReason).toBeNull();

        expect(calls).toEqual([
            'getHaltState',
            'getPerformance',
            'getDecisions:BTCUSDT',
            'getDecisions:ETHUSDT',
            'getDecisions:SOLUSDT',
            'llm.generateStructured',
            'persistence.draftStrategyVersion',
            'runBacktest:active',
            'runBacktest:draft',
            'reportWriter.write',
            'persistence.recordHistory',
        ]);
    });

    it('emits a non-empty markdown report path scoped to weekIso + draftVersionId', async () => {
        const { deps } = makeHarness();
        const result = await runWeeklyLoop(deps);
        expect(result.reportPaths?.mdPath).toContain('2026-W21');
        expect(result.reportPaths?.mdPath).toContain('999');
    });
});

describe('runWeeklyLoop — halt branch', () => {
    it('returns SKIPPED_HALTED and makes no LLM or persistence call when isHalted=true', async () => {
        const { deps, calls } = makeHarness({
            halt: { isHalted: true, haltReason: 'manual', asOf: '2026-05-27T00:00:00.000Z' },
        });

        const result = await runWeeklyLoop(deps);

        expect(result.terminalState).toBe('SKIPPED_HALTED');
        expect(result.draftVersionId).toBeNull();
        expect(result.reportPaths).toBeNull();
        expect(result.failureReason).toBeNull();
        expect(calls).toEqual(['getHaltState', 'persistence.recordHistory']);
        expect(calls).not.toContain('llm.generateStructured');
        expect(calls).not.toContain('persistence.draftStrategyVersion');
    });
});

describe('runWeeklyLoop — dry-run (M13 W6 fix wave 2 #2)', () => {
    it('skips runBacktest, persistence.draftStrategyVersion, and persistence.recordHistory', async () => {
        const { deps, calls } = makeHarness();
        const result = await runWeeklyLoop({ ...deps, dryRun: true });

        expect(result.terminalState).toBe('COMPLETED');
        expect(result.draftVersionId).toBeNull();
        expect(result.reportPaths).not.toBeNull();

        expect(calls).not.toContain('runBacktest:active');
        expect(calls).not.toContain('runBacktest:draft');
        expect(calls).not.toContain('persistence.draftStrategyVersion');
        expect(calls).not.toContain('persistence.recordHistory');
    });

    it('writes a report with a DRY-RUN banner so operators cannot mistake it for a real eval', async () => {
        const { deps } = makeHarness();
        let captured = '';
        const reportWriter: IReportWriterPort = {
            async write(weekIso, draftVersionId, markdown) {
                captured = markdown;
                return { mdPath: `/tmp/${weekIso}-${draftVersionId}.md`, jsonPath: `/tmp/${weekIso}-${draftVersionId}.json` };
            },
        };
        await runWeeklyLoop({ ...deps, reportWriter, dryRun: true });
        expect(captured).toMatch(/DRY-RUN/);
    });

    it('does not call recordHistory even on the halted branch when dryRun=true', async () => {
        const { deps, calls } = makeHarness({
            halt: { isHalted: true, haltReason: 'manual', asOf: '2026-05-27T00:00:00.000Z' },
        });
        const result = await runWeeklyLoop({ ...deps, dryRun: true });
        expect(result.terminalState).toBe('SKIPPED_HALTED');
        expect(calls).toEqual(['getHaltState']);
        expect(calls).not.toContain('persistence.recordHistory');
    });
});

describe('runWeeklyLoop — LLM repair', () => {
    function zodFailure(): ZodError {
        return new ZodError([{ code: 'custom', path: [], message: 'schema mismatch' }]);
    }

    it('retries once on Zod failure and then COMPLETES', async () => {
        const { deps, calls } = makeHarness({
            llmResults: [zodFailure(), FIXTURE_DRAFT],
        });

        const result = await runWeeklyLoop(deps);

        expect(result.terminalState).toBe('COMPLETED');
        const llmCalls = calls.filter((c) => c === 'llm.generateStructured');
        expect(llmCalls).toHaveLength(2);
    });

    it('returns FAILED with LLM_SCHEMA_REPAIR_FAILED when both attempts throw schema-shape errors', async () => {
        const { deps, calls } = makeHarness({
            llmResults: [zodFailure(), zodFailure()],
        });

        const result = await runWeeklyLoop(deps);

        expect(result.terminalState).toBe('FAILED');
        expect(result.failureReason).toBe('LLM_SCHEMA_REPAIR_FAILED');
        expect(result.draftVersionId).toBeNull();
        expect(result.reportPaths).toBeNull();
        expect(calls.filter((c) => c === 'llm.generateStructured')).toHaveLength(2);
        expect(calls).not.toContain('persistence.draftStrategyVersion');
        expect(calls).not.toContain('runBacktest:active');
    });

    // M13 W6 fix wave 3 (#5): non-schema gateway errors (network, rate-limit,
    // transport) must NOT trigger the one-shot schema-repair retry.
    it('returns FAILED with LLM_GATEWAY_ERROR on the FIRST non-schema error (no repair retry)', async () => {
        const networkErr = Object.assign(new Error('socket hang up'), { name: 'GatewayRateLimitError' });
        const { deps, calls } = makeHarness({
            llmResults: [networkErr as unknown as Error],
        });

        const result = await runWeeklyLoop(deps);

        expect(result.terminalState).toBe('FAILED');
        expect(result.failureReason).toBe('LLM_GATEWAY_ERROR');
        // Crucially: only ONE LLM call (no repair retry on gateway failure).
        expect(calls.filter((c) => c === 'llm.generateStructured')).toHaveLength(1);
    });

    it('returns FAILED with LLM_GATEWAY_ERROR when the repair attempt itself throws a non-schema error', async () => {
        const networkErr = Object.assign(new Error('rate limit'), { name: 'GatewayRateLimitError' });
        const { deps, calls } = makeHarness({
            llmResults: [zodFailure(), networkErr as unknown as Error],
        });

        const result = await runWeeklyLoop(deps);

        expect(result.terminalState).toBe('FAILED');
        expect(result.failureReason).toBe('LLM_GATEWAY_ERROR');
        expect(calls.filter((c) => c === 'llm.generateStructured')).toHaveLength(2);
    });
});
