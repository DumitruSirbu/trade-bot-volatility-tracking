// M13 W6a — Vector 3: LLM hallucination of activation field (ADR 0036 §2.3).
//
// Stubs the LLM to return a response that includes an extra `_action` field
// with the value `'promote_to_active'`. The ProposedDraftSchema must either:
//   (a) Reject the extra field via `.strict()` — the agent catches the Zod
//       error and either re-prompts or fails cleanly; or
//   (b) Strip the field via default Zod behavior (strip-mode) — the agent
//       never sees `_action` and the SDF still hard-codes status='draft'.
//
// In either case:
//   - No code path reads `_action`.
//   - persistence.draftStrategyVersion is called WITHOUT a `status` argument
//     (the interface has no `status` parameter — the SDF enforces 'draft').
//   - The loop either COMPLETES (strip mode) or FAILS on repair exhaustion
//     (strict mode). Both are acceptable; the key invariant is that 'active'
//     is never passed down the write path.
//
// FINDING CHECK (filed if schema is not .strict()): see assertion at end.

import { ProposedDraftSchema } from '../../src/llm/ProposedDraftSchema.js';
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

// ---------------------------------------------------------------------------
// Schema-level assertions
// ---------------------------------------------------------------------------

describe('ProposedDraftSchema — extra field handling', () => {
    const VALID_CORE = {
        params: { signalThreshold: 1.9 },
        rationale: 'Tighten threshold.',
        expectedDirection: 'better' as const,
        confidence: 0.65,
    };

    it('parses a well-formed ProposedDraft successfully', () => {
        const result = ProposedDraftSchema.safeParse(VALID_CORE);
        expect(result.success).toBe(true);
    });

    it('rejects when `_action` extra field is present (schema is .strict() per ADR 0037 §2.5)', () => {
        const withExtra = { ...VALID_CORE, _action: 'promote_to_active' };
        const result = ProposedDraftSchema.safeParse(withExtra);
        expect(result.success).toBe(false);
        if (!result.success) {
            const issueMessages = result.error.issues.map((i) => i.message).join(', ');
            expect(issueMessages).toMatch(/unrecognized|unexpected/i);
        }
    });

    it('rejects arbitrary unknown fields (not just `_action`)', () => {
        const withExtra = { ...VALID_CORE, fooBar: 42 };
        const result = ProposedDraftSchema.safeParse(withExtra);
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    items: [],
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
        tradeCount: 8,
        winCount: 5,
        lossCount: 3,
        winRatePct: '62.50',
        grossPnlUsdt: '80.00',
        feesUsdt: '4.00',
        fundingUsdt: '1.00',
        slippageCostUsdt: '2.00',
        netPnlUsdt: '73.00',
        returnPct: '7.30',
        profitFactor: '1.40',
        avgHoldMs: 3_600_000,
        maxDrawdownPct: '3.50',
        maxDrawdownDurationDays: 1,
        sharpeAnnualized: '0.38',
        sortinoAnnualized: '0.50',
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
}

// The LLM response includes an extra `_action` field — simulating hallucination.
const LLM_HALLUCINATED_RESPONSE = {
    params: { signalThreshold: 1.9 },
    rationale: 'Tighten threshold.',
    expectedDirection: 'better' as const,
    confidence: 0.65,
    _action: 'promote_to_active',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface IHallucinationHarness {
    deps: IRunWeeklyLoopDeps;
    calls: string[];
    capturedDraftArgs: Array<Parameters<IPersistencePort['draftStrategyVersion']>[0]>;
}

function makeHallucinationHarness(llmBehavior: 'succeed-with-extra' | 'fail-then-succeed'): IHallucinationHarness {
    const calls: string[] = [];
    const capturedDraftArgs: Array<Parameters<IPersistencePort['draftStrategyVersion']>[0]> = [];

    const mcp: IMcpClientPort = {
        async getHaltState(): Promise<HaltStateViewParsed> {
            calls.push('getHaltState');
            return { isHalted: false, haltReason: null, asOf: '2026-05-27T00:00:00.000Z' };
        },
        async getPerformance(): Promise<PerformanceByVersionViewParsed> {
            calls.push('getPerformance');
            return FIXTURE_PERFORMANCE;
        },
        async getDecisions(args): Promise<GetDecisionsResultParsed> {
            calls.push(`getDecisions:${args.symbol}`);
            return FIXTURE_DECISIONS;
        },
        async runBacktest(args): Promise<BacktestReportParsed> {
            const tag = args.paramsOverride === undefined ? 'active' : 'draft';
            calls.push(`runBacktest:${tag}`);
            return makeReport(tag);
        },
    };

    let attemptCount = 0;

    const llm: ILlmGateway = {
        async generateStructured() {
            calls.push('llm.generateStructured');
            attemptCount += 1;

            if (llmBehavior === 'fail-then-succeed' && attemptCount === 1) {
                // Real aiGateway surfaces schema mismatches as ZodError (or an
                // AI-SDK structured-output validation error). Use the actual
                // schema's strict-mode failure so the agent's narrow catch
                // recognises this as a repair-eligible failure.
                ProposedDraftSchema.parse(LLM_HALLUCINATED_RESPONSE);
            }

            // Pass the hallucinated response through Zod to simulate what aiGateway does.
            // In production, generateStructured uses `streamObject` which validates via schema.
            // Here we simulate both parsing modes (strict vs strip).
            // `parse` throws a real ZodError on strict-mode rejection — matching
            // production behaviour and the agent's `isSchemaShapeFailure` predicate.
            const data = ProposedDraftSchema.parse(LLM_HALLUCINATED_RESPONSE);
            return { value: data, usageUsd: 0.01 };
        },
        get totalUsageUsd() {
            return 0.01;
        },
    };

    const persistence: IPersistencePort = {
        async draftStrategyVersion(args) {
            calls.push('persistence.draftStrategyVersion');
            capturedDraftArgs.push(args);
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
            return {
                mdPath: `/tmp/${weekIso}-${draftVersionId}.md`,
                jsonPath: `/tmp/${weekIso}-${draftVersionId}.json`,
            };
        },
    };

    const logger: ILogger = { info: () => undefined, error: () => undefined };

    return {
        calls,
        capturedDraftArgs,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWeeklyLoop — LLM hallucination of _action field (W6a vector 3)', () => {
    it('loop completes or fails cleanly — never reaches an activation path', async () => {
        const { deps } = makeHallucinationHarness('succeed-with-extra');
        const result = await runWeeklyLoop(deps);
        // Either COMPLETED (strip mode) or FAILED (strict mode or schema-parse cascade).
        expect(['COMPLETED', 'FAILED']).toContain(result.terminalState);
    });

    it('_action field is never passed to persistence.draftStrategyVersion', async () => {
        const { deps, capturedDraftArgs } = makeHallucinationHarness('succeed-with-extra');
        await runWeeklyLoop(deps);
        for (const args of capturedDraftArgs) {
            const serialized = JSON.stringify(args);
            expect(serialized).not.toContain('_action');
            expect(serialized).not.toContain('promote_to_active');
        }
    });

    it('draftStrategyVersion args never contain a status property', async () => {
        const { deps, capturedDraftArgs } = makeHallucinationHarness('succeed-with-extra');
        await runWeeklyLoop(deps);
        for (const args of capturedDraftArgs) {
            expect('status' in args).toBe(false);
        }
    });

    it('_action is not read by any code path — no "active" string reaches persistence', async () => {
        const { deps, capturedDraftArgs } = makeHallucinationHarness('succeed-with-extra');
        await runWeeklyLoop(deps);
        const allSerialized = JSON.stringify(capturedDraftArgs);
        // The word 'active' must never appear as a value in persistence args
        // (it may appear as the status of the parent version in the `params`
        // field only if the LLM explicitly echoed it — even then it's opaque jsonb).
        expect(allSerialized).not.toMatch(/"status"\s*:\s*"active"/);
    });

    it('schema is strict — loop fails with LLM_SCHEMA_REPAIR_FAILED after the one-shot repair attempt', async () => {
        const { deps, calls } = makeHallucinationHarness('succeed-with-extra');
        const result = await runWeeklyLoop(deps);
        expect(result.terminalState).toBe('FAILED');
        expect(result.failureReason).toBe('LLM_SCHEMA_REPAIR_FAILED');
        // initial call + one repair retry == 2 invocations of generateStructured.
        expect(calls.filter((c) => c === 'llm.generateStructured').length).toBe(2);
        expect(calls).not.toContain('persistence.draftStrategyVersion');
    });
});
