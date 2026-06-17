// M13 W6a — Vector 1: Egress violation (ADR 0037 §2.3).
//
// Simulates an operator error where `IPerformanceByVersionView` is seeded with
// a blocklisted field (`params.apiKey`). Every LLM egress chokepoint in the
// loop (`buildPrompt` via `redactForLlm`) MUST throw `EgressViolationError`
// before any prompt is constructed, and `runWeeklyLoop` MUST surface this as
// `terminalState='FAILED'` with a `failureReason` containing 'EgressViolation'
// or 'EGRESS_VIOLATION'. No call to `aiGateway.generateStructured` may occur.

import { EgressViolationError, redactForLlm } from '../../src/llm/redactForLlm.js';
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
import { ProposedDraftSchema } from '../../src/llm/ProposedDraftSchema.js';

// ---------------------------------------------------------------------------
// Fixture: a valid PerformanceByVersionView contaminated with a blocklisted
// field nested inside `params`. The operator accidentally stored an API key
// in the strategy's runtime params that later leaked into the perf view.
// ---------------------------------------------------------------------------

const CONTAMINATED_PERFORMANCE = {
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
    // Operator error: blocklisted field nested in the performance payload
    apiKey: 'sk-binance-abc123-OPERATOR-ERROR',
} as unknown as PerformanceByVersionViewParsed;

const SAFE_DECISIONS: GetDecisionsResultParsed = {
    items: [],
    snapshots: null,
};

const SAFE_BACKTEST: BacktestReportParsed = {
    runLabel: 'active',
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
    skippedTriggerCount: 0,
    rejectedByGateCount: 0,
    missedLimitFillCount: 0,
    lowFidelityTradeCount: 0,
    equityCurve: [],
    perRegime: [],
    perFlowType: [],
    perSymbol: [],
    trades: [],
};

// ---------------------------------------------------------------------------
// Unit — redactForLlm throws on the contaminated fixture directly
// ---------------------------------------------------------------------------

describe('redactForLlm — blocklisted field throws EgressViolationError', () => {
    it('throws when input contains apiKey at top level', () => {
        expect(() => redactForLlm({ apiKey: 'secret', sharpe: '0.42' })).toThrow(EgressViolationError);
    });

    it('throws when input contains apiKey nested inside an object', () => {
        expect(() => redactForLlm({ summary: { sharpe: '0.42', apiKey: 'deep-secret' } })).toThrow(EgressViolationError);
    });

    it('includes the offending path in the error message', () => {
        let caught: EgressViolationError | null = null;
        try {
            redactForLlm({ apiKey: 'secret' });
        } catch (err) {
            caught = err as EgressViolationError;
        }
        expect(caught).not.toBeNull();
        expect(caught!.paths.length).toBeGreaterThan(0);
        expect(caught!.paths.some((p) => p.includes('apiKey'))).toBe(true);
    });

    it('reports ALL violations in a single pass, not just the first', () => {
        let caught: EgressViolationError | null = null;
        try {
            redactForLlm({ apiKey: 'a', balance: '100', password: 'b' });
        } catch (err) {
            caught = err as EgressViolationError;
        }
        expect(caught).not.toBeNull();
        // At least two blocklisted fields (apiKey + password) — balance may
        // trigger token-boundary as well
        expect(caught!.paths.length).toBeGreaterThanOrEqual(2);
    });
});

// ---------------------------------------------------------------------------
// Integration — runWeeklyLoop surfaces FAILED + no LLM call
// ---------------------------------------------------------------------------

function makeEgressHarness(): { deps: IRunWeeklyLoopDeps; calls: string[] } {
    const calls: string[] = [];

    const mcp: IMcpClientPort = {
        async getHaltState(): Promise<HaltStateViewParsed> {
            calls.push('getHaltState');
            return { isHalted: false, haltReason: null, asOf: '2026-05-27T00:00:00.000Z' };
        },
        async getPerformance(): Promise<PerformanceByVersionViewParsed> {
            calls.push('getPerformance');
            return CONTAMINATED_PERFORMANCE;
        },
        async getDecisions(): Promise<GetDecisionsResultParsed> {
            calls.push('getDecisions');
            return SAFE_DECISIONS;
        },
        async runBacktest(): Promise<BacktestReportParsed> {
            calls.push('runBacktest');
            return SAFE_BACKTEST;
        },
    };

    const llm: ILlmGateway = {
        async generateStructured(): Promise<{ value: never; usageUsd: number }> {
            calls.push('llm.generateStructured');
            throw new Error('generateStructured must not be called when egress is violated');
        },
        get totalUsageUsd() {
            return 0;
        },
    };

    const persistence: IPersistencePort = {
        async draftStrategyVersion() {
            calls.push('persistence.draftStrategyVersion');
            return 999;
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

    return {
        calls,
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

describe('runWeeklyLoop — egress violation (ADR 0037, W6a vector 1)', () => {
    it('returns terminalState=FAILED when performance contains a blocklisted field', async () => {
        const { deps } = makeEgressHarness();
        const result = await runWeeklyLoop(deps);
        expect(result.terminalState).toBe('FAILED');
    });

    it('includes EgressViolation or EGRESS_VIOLATION in failureReason', async () => {
        const { deps } = makeEgressHarness();
        const result = await runWeeklyLoop(deps);
        expect(result.failureReason).not.toBeNull();
        const reason = result.failureReason!;
        const mentionsEgress = reason.includes('EgressViolation') || reason.includes('EGRESS_VIOLATION') || reason.includes('egress');
        // The failure reason should be traceable to the egress error name or code.
        // EgressViolationError.name === 'EgressViolationError' → extracted as 'EgressViolationError'.
        expect(mentionsEgress || reason.includes('EgressViolationError')).toBe(true);
    });

    it('does NOT call llm.generateStructured before throwing', async () => {
        const { deps, calls } = makeEgressHarness();
        await runWeeklyLoop(deps);
        expect(calls).not.toContain('llm.generateStructured');
    });

    it('does NOT call persistence.draftStrategyVersion', async () => {
        const { deps, calls } = makeEgressHarness();
        await runWeeklyLoop(deps);
        expect(calls).not.toContain('persistence.draftStrategyVersion');
    });

    it('does NOT call runBacktest', async () => {
        const { deps, calls } = makeEgressHarness();
        await runWeeklyLoop(deps);
        expect(calls).not.toContain('runBacktest');
    });

    it('still calls persistence.recordHistory with FAILED state (best-effort)', async () => {
        const { deps, calls } = makeEgressHarness();
        await runWeeklyLoop(deps);
        // Best-effort history write should still happen even on FAILED path.
        expect(calls).toContain('persistence.recordHistory');
    });
});

// ---------------------------------------------------------------------------
// Additional blocked field coverage
// ---------------------------------------------------------------------------

describe('redactForLlm — each explicit blocklist field throws individually', () => {
    const BLOCKLISTED_FIELDS = [
        'apiKey',
        'apiSecret',
        'bearerToken',
        'password',
        'balance',
        'equity',
        'exchangeOrderId',
        'clientOrderId',
        'ipAllowlist',
        'accountId',
        'userId',
    ] as const;

    for (const field of BLOCKLISTED_FIELDS) {
        it(`throws EgressViolationError for field: ${field}`, () => {
            expect(() => redactForLlm({ [field]: 'sensitive-data', sharpe: '0.5' })).toThrow(EgressViolationError);
        });
    }
});

// Suppress TS "unused import" for the schema that the ProposedDraftSchema test
// needs but is imported at the module level — reference it to avoid tree-shake.
void ProposedDraftSchema;
