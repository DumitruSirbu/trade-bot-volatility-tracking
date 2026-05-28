// M13 W2.B — weekly agent loop orchestration (execution plan §W2.1, §W2.5).
//
// Single exported `runWeeklyLoop` that wires MCP reads, the LLM call, paired
// backtests, and the report writer in a strict, observable order. Every step
// is its own ≤20-line helper so the call-order can be asserted from tests via
// stubbed deps. Errors are swallowed at the top level and mapped to a
// terminal-state result; the caller is responsible for persisting that.
//
// What this file does NOT do:
//   - Does NOT touch Postgres directly (W3 wires `persistence.draftStrategyVersion`).
//   - Does NOT enforce the promotion gate (W4).
//   - Does NOT write to disk (the report writer dep does, behind an interface).

import { TerminalStateEnum } from '@bot/shared';
import { ZodError } from 'zod';

import { runComparisonBacktests } from '../backtest/runComparisonBacktests.js';
import { evaluatePromotionGate } from '../backtest/promotionGate.js';
import { DEFAULT_AGENT_MODEL_ID } from '../llm/aiGateway.js';
import { buildPrompt } from '../llm/buildPrompt.js';
import { ProposedDraftSchema, type IProposedDraft } from '../llm/ProposedDraftSchema.js';
// eslint-disable-next-line no-restricted-imports -- agent-internal `src/mcp/` directory; ADR 0035 §2.3 layer B targets WORKSPACE reaches (apps/mcp / packages/analysis), not the agent's own subdirectories.
import type { BacktestReportParsed, GetDecisionsResultParsed, HaltStateViewParsed, PerformanceByVersionViewParsed } from '../mcp/schemas.js';

import { buildReport, type IBuiltReport } from './buildReport.js';

export const TOP_SYMBOL_COUNT = 3;
export const LOOKBACK_DAYS = 90;

export { TerminalStateEnum };

export interface IRunWeeklyLoopResult {
    readonly terminalState: TerminalStateEnum;
    readonly draftVersionId: number | null;
    readonly reportPaths: IReportPaths | null;
    readonly failureReason: string | null;
    readonly bootstrapCiLo: string | null;
    readonly bootstrapCiHi: string | null;
    readonly passesPromotionGate: boolean | null;
}

export interface IReportPaths {
    readonly mdPath: string;
    readonly jsonPath: string;
}

export interface ILlmGateway {
    generateStructured(opts: {
        readonly system: string;
        readonly user: string;
        readonly schema: typeof ProposedDraftSchema;
    }): Promise<{ readonly value: IProposedDraft; readonly usageUsd: number }>;
    readonly totalUsageUsd: number;
}

export interface IMcpClientPort {
    getHaltState(): Promise<HaltStateViewParsed>;
    getPerformance(args: { readonly versionId: number; readonly from: string; readonly to: string }): Promise<PerformanceByVersionViewParsed>;
    getDecisions(args: { readonly symbol: string; readonly from: string; readonly to: string }): Promise<GetDecisionsResultParsed>;
    runBacktest(args: {
        readonly versionId: number;
        readonly from: string;
        readonly to: string;
        readonly paramsOverride?: Record<string, unknown>;
    }): Promise<BacktestReportParsed>;
}

export interface IPersistencePort {
    // Returns the new strategy_versions_id, OR null when the SDF's
    // (parent_version_id, week_iso) uniqueness fires — re-run for the same
    // week is a silent no-op per ADR 0036 §2.3.
    draftStrategyVersion(args: {
        readonly parentVersionId: number;
        readonly weekIso: string;
        readonly params: Record<string, unknown>;
        readonly rationale: string;
    }): Promise<number | null>;
    // Best-effort history INSERT. Returns the new agent_run_id, OR null on
    // ON CONFLICT (week_iso) DO NOTHING. The loop logs but does NOT throw
    // if this fails — the SDF write (if it happened) is the source of
    // truth for downstream consumers.
    recordHistory(row: IAgentHistoryRow): Promise<number | null>;
}

export interface IAgentHistoryRow {
    readonly weekIso: string;
    readonly parentVersionId: number;
    readonly draftVersionId: number | null;
    readonly modelId: string;
    readonly reportMdPath: string | null;
    readonly reportJsonPath: string | null;
    readonly terminalState: TerminalStateEnum;
    readonly failureReason: string | null;
    readonly startedAt: Date;
    readonly finishedAt: Date | null;
    readonly bootstrapCiLo: string | null;
    readonly bootstrapCiHi: string | null;
    readonly passesPromotionGate: boolean | null;
}

export interface IReportWriterPort {
    write(weekIso: string, draftVersionId: number, markdown: string, json: unknown): Promise<IReportPaths>;
}

export interface ILogger {
    info(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface IRunWeeklyLoopDeps {
    readonly mcp: IMcpClientPort;
    readonly llm: ILlmGateway;
    readonly persistence: IPersistencePort;
    readonly reportWriter: IReportWriterPort;
    readonly logger: ILogger;
    readonly weekIso: string;
    readonly parentVersionId: number;
    readonly nowIso?: string;
    readonly modelId?: string;
    // M13 W6 fix wave 2 (#2): when true, runWeeklyLoop never calls
    // `mcp.runBacktest`, never calls `persistence.draftStrategyVersion`, and
    // never invokes `persistence.recordHistory`. The report markdown carries
    // a top-of-file DRY-RUN banner so an operator who runs `--dry-run` cannot
    // mistake the rendered output for a real evaluation. main.ts holds the
    // CLI/env wiring; runWeeklyLoop merely respects the flag.
    readonly dryRun?: boolean;
}

const DRY_RUN_BANNER = '> **DRY-RUN — backtests skipped, nothing written to Postgres.**\n\n';

export async function runWeeklyLoop(deps: IRunWeeklyLoopDeps): Promise<IRunWeeklyLoopResult> {
    const startedAt = new Date();
    try {
        const halt = await deps.mcp.getHaltState();

        if (halt.isHalted) {
            deps.logger.info('agent.skip.halted', { haltReason: halt.haltReason });
            const result = makeResult(TerminalStateEnum.SKIPPED_HALTED, null, null, null);
            await persistHistoryBestEffort(deps, result, startedAt);

            return result;
        }

        return await runCompleteCycle(deps, startedAt);
    } catch (err) {
        const reason = extractFailureReason(err);
        deps.logger.error('agent.loop.failed', { failureReason: reason });
        const result = makeResult(TerminalStateEnum.FAILED, null, null, reason);
        await persistHistoryBestEffort(deps, result, startedAt);

        return result;
    }
}

async function runCompleteCycle(deps: IRunWeeklyLoopDeps, startedAt: Date): Promise<IRunWeeklyLoopResult> {
    const window = resolveWindow(deps.nowIso);
    const performance = await deps.mcp.getPerformance({ versionId: deps.parentVersionId, from: window.from, to: window.to });
    const decisions = await fetchTopDecisions(deps, window, performance);
    const prompt = buildAgentPrompt(performance, decisions, deps.parentVersionId);
    const proposed = await callLlmWithRepair(deps, prompt);

    if (deps.dryRun === true) {
        return await renderDryRunReport(deps, performance, prompt.promptHash, proposed, startedAt);
    }

    return await runBacktestsAndReport(deps, window, performance, prompt.promptHash, proposed, startedAt);
}

// M13 W6 fix wave 2 (#2): dry-run renders the markdown report (with a clear
// banner) and skips every database mutation + every MCP backtest call.
async function renderDryRunReport(
    deps: IRunWeeklyLoopDeps,
    performance: PerformanceByVersionViewParsed,
    promptHash: string,
    proposed: IProposedDraft,
    startedAt: Date,
): Promise<IRunWeeklyLoopResult> {
    void startedAt;
    deps.logger.info('agent.dry_run.skip_backtests', { weekIso: deps.weekIso });
    const placeholderReport = makeDryRunPlaceholderReport(performance, deps.parentVersionId);
    const built = buildAgentReport(deps, performance, placeholderReport, placeholderReport, proposed, promptHash, 0);
    const markdown = DRY_RUN_BANNER + built.markdown;
    const paths = await deps.reportWriter.write(deps.weekIso, 0, markdown, built.json);
    deps.logger.info('agent.dry_run.completed', { weekIso: deps.weekIso, mdPath: paths.mdPath });
    // Dry-run NEVER calls persistence (neither draft nor history) — operator
    // intent is "show me what would happen", not "commit a no-op row".
    return {
        terminalState: TerminalStateEnum.COMPLETED,
        draftVersionId: null,
        reportPaths: paths,
        failureReason: null,
        bootstrapCiLo: null,
        bootstrapCiHi: null,
        passesPromotionGate: null,
    };
}

function makeDryRunPlaceholderReport(performance: PerformanceByVersionViewParsed, parentVersionId: number): BacktestReportParsed {
    // Zero-trade placeholder so downstream report rendering produces the
    // canonical "no data" rows rather than crashing on missing fields. The
    // promotion-gate evaluation invoked inside buildAgentReport will surface
    // NOT_AVAILABLE for every criterion — which is the correct read of a
    // dry-run (no backtest, no verdict).
    return {
        runLabel: 'dry-run',
        strategyVersionId: parentVersionId,
        strategyName: performance.label,
        strategyVersion: 0,
        fromUtcDate: '',
        toUtcDate: '',
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        winRatePct: '0',
        grossPnlUsdt: '0',
        feesUsdt: '0',
        fundingUsdt: '0',
        slippageCostUsdt: '0',
        netPnlUsdt: '0',
        returnPct: '0',
        profitFactor: '0',
        avgHoldMs: 0,
        maxDrawdownPct: '0',
        maxDrawdownDurationDays: 0,
        sharpeAnnualized: '0',
        sortinoAnnualized: '0',
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

async function runBacktestsAndReport(
    deps: IRunWeeklyLoopDeps,
    window: ITimeWindow,
    performance: PerformanceByVersionViewParsed,
    promptHash: string,
    proposed: IProposedDraft,
    startedAt: Date,
): Promise<IRunWeeklyLoopResult> {
    const draftVersionId = await deps.persistence.draftStrategyVersion({
        parentVersionId: deps.parentVersionId,
        weekIso: deps.weekIso,
        params: proposed.params,
        rationale: proposed.rationale,
    });

    if (draftVersionId === null) {
        deps.logger.info('agent.skip.idempotent', { weekIso: deps.weekIso, parentVersionId: deps.parentVersionId });
        const result = makeResult(TerminalStateEnum.IDEMPOTENT_SKIP, null, null, null);
        await persistHistoryBestEffort(deps, result, startedAt);

        return result;
    }
    const { active: activeReport, draft: draftReport } = await runComparisonBacktests({
        mcp: deps.mcp,
        parentVersionId: deps.parentVersionId,
        draftVersionId,
        from: window.from,
        to: window.to,
        draftParamsOverride: proposed.params,
    });
    const gate = evaluatePromotionGate(draftReport, activeReport);
    const built = buildAgentReport(deps, performance, activeReport, draftReport, proposed, promptHash, draftVersionId);
    const paths = await deps.reportWriter.write(deps.weekIso, draftVersionId, built.markdown, built.json);
    deps.logger.info('agent.loop.completed', { draftVersionId, mdPath: paths.mdPath, passesPromotionGate: gate.passes });
    const result: IRunWeeklyLoopResult = {
        terminalState: TerminalStateEnum.COMPLETED,
        draftVersionId,
        reportPaths: paths,
        failureReason: null,
        bootstrapCiLo: extractBootstrapBound(draftReport, 'lo'),
        bootstrapCiHi: extractBootstrapBound(draftReport, 'hi'),
        passesPromotionGate: gate.passes,
    };
    await persistHistoryBestEffort(deps, result, startedAt);

    return result;
}

function extractBootstrapBound(report: BacktestReportParsed, bound: 'lo' | 'hi'): string | null {
    // `IBacktestReport` does not yet carry the bootstrap CI directly; once the
    // engine wires it through, the agent-local Zod schema (`BacktestReportSchema`)
    // already declares `bootstrap.ci` as an optional typed field, so this helper
    // reads it without a cast. Today the field is absent and history reflects
    // that; the operator-facing gate column is the substantive output.
    const value = report.bootstrap?.ci?.[bound];

    return typeof value === 'string' && value.length > 0 ? value : null;
}

async function persistHistoryBestEffort(deps: IRunWeeklyLoopDeps, result: IRunWeeklyLoopResult, startedAt: Date): Promise<void> {
    if (deps.dryRun === true) {
        // M13 W6 fix wave 2 (#2): dry-run NEVER writes history.
        deps.logger.info('agent.dry_run.skip_history', { weekIso: deps.weekIso, terminalState: result.terminalState });

        return;
    }

    const row: IAgentHistoryRow = {
        weekIso: deps.weekIso,
        parentVersionId: deps.parentVersionId,
        draftVersionId: result.draftVersionId,
        modelId: deps.modelId ?? DEFAULT_AGENT_MODEL_ID,
        reportMdPath: result.reportPaths?.mdPath ?? null,
        reportJsonPath: result.reportPaths?.jsonPath ?? null,
        terminalState: result.terminalState,
        failureReason: result.failureReason,
        startedAt,
        finishedAt: new Date(),
        bootstrapCiLo: result.bootstrapCiLo ?? null,
        bootstrapCiHi: result.bootstrapCiHi ?? null,
        passesPromotionGate: result.passesPromotionGate ?? null,
    };
    try {
        const id = await deps.persistence.recordHistory(row);

        if (id === null) {
            deps.logger.info('agent.history.idempotent_skip', { weekIso: deps.weekIso });
        }
    } catch (err) {
        deps.logger.error('agent.history.write_failed', {
            weekIso: deps.weekIso,
            error: extractFailureReason(err),
        });
    }
}

async function fetchTopDecisions(
    deps: IRunWeeklyLoopDeps,
    window: ITimeWindow,
    performance: PerformanceByVersionViewParsed,
): Promise<readonly GetDecisionsResultParsed[]> {
    const symbols = pickTopSymbols(performance);
    const out: GetDecisionsResultParsed[] = [];

    for (const symbol of symbols) {
        const result = await deps.mcp.getDecisions({ symbol, from: window.from, to: window.to });
        out.push(result);
    }

    return out;
}

function buildAgentPrompt(
    performance: PerformanceByVersionViewParsed,
    decisions: readonly GetDecisionsResultParsed[],
    parentVersionId: number,
): { readonly system: string; readonly user: string; readonly promptHash: string } {
    const aggregates = decisions.flatMap((d) => d.items.map((i) => ({ flowType: i.flowType, signalScore: i.signalScore, action: i.action })));
    // M13 W6 fix wave 4 (#5a): redactForLlm is the ADR 0037 chokepoint inside
    // buildPrompt — every dynamic input is redacted there. Earlier code called
    // redactForLlm here for side-effect only and discarded the returns, which
    // duplicates work and (worse) misleads readers into thinking the agent did
    // an extra pass. Removed.
    return buildPrompt({
        activeVersion: { versionId: parentVersionId, name: performance.label, version: performance.windowDays },
        recentPerformance: [performance as unknown as Record<string, unknown>],
        topDecisionAggregates: aggregates,
    });
}

async function callLlmWithRepair(deps: IRunWeeklyLoopDeps, prompt: { readonly system: string; readonly user: string }): Promise<IProposedDraft> {
    try {
        const r = await deps.llm.generateStructured({ system: prompt.system, user: prompt.user, schema: ProposedDraftSchema });

        return r.value;
    } catch (firstErr) {
        // Only schema-shape failures trigger the one-shot repair. Network /
        // rate-limit / gateway failures should NOT be retried here (the gateway
        // already has its own primary→fallback retry) — they propagate as
        // `LLM_GATEWAY_ERROR`.
        if (!isSchemaShapeFailure(firstErr)) {
            throw new LlmGatewayError(nameOf(firstErr));
        }

        deps.logger.info('agent.llm.repair_retry', { firstErrorName: nameOf(firstErr) });

        try {
            const r = await deps.llm.generateStructured({ system: prompt.system, user: prompt.user, schema: ProposedDraftSchema });

            return r.value;
        } catch (secondErr) {
            if (!isSchemaShapeFailure(secondErr)) {
                throw new LlmGatewayError(nameOf(secondErr));
            }

            throw new LlmSchemaRepairFailedError(nameOf(secondErr));
        }
    }
}

// A schema-shape failure is a ZodError thrown by `ProposedDraftSchema.parse` OR
// one of the Vercel AI SDK's structured-output validation errors. Anything else
// (transport, rate-limit, auth) is a gateway failure that propagates upward.
function isSchemaShapeFailure(err: unknown): boolean {
    if (err instanceof ZodError) {
        return true;
    }

    if (err === null || typeof err !== 'object') {
        return false;
    }

    const name = (err as { name?: unknown }).name;

    if (typeof name !== 'string') {
        return false;
    }

    return name === 'AI_NoObjectGeneratedError' || name === 'AI_TypeValidationError' || name === 'TypeValidationError';
}

function buildAgentReport(
    deps: IRunWeeklyLoopDeps,
    activePerf: PerformanceByVersionViewParsed,
    activeReport: BacktestReportParsed,
    draftReport: BacktestReportParsed,
    proposed: IProposedDraft,
    promptHash: string,
    draftVersionId: number,
): IBuiltReport {
    return buildReport({
        activePerformance: activePerf,
        activeReport,
        draftReport,
        proposed,
        provenance: {
            modelId: deps.modelId ?? DEFAULT_AGENT_MODEL_ID,
            weekIso: deps.weekIso,
            parentVersionId: deps.parentVersionId,
            draftVersionId,
            promptHash,
            gatewayCostUsd: deps.llm.totalUsageUsd,
        },
    });
}

interface ITimeWindow {
    readonly from: string;
    readonly to: string;
}

function resolveWindow(nowIso?: string): ITimeWindow {
    const to = nowIso ?? new Date().toISOString();
    const toMs = Date.parse(to);
    const fromMs = toMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    return { from: new Date(fromMs).toISOString(), to };
}

function pickTopSymbols(performance: PerformanceByVersionViewParsed): readonly string[] {
    void performance;
    // The performance view is a single-row aggregate per version; the
    // per-symbol trade-count ranking is not exposed by `getPerformance`. As a
    // safe default the agent enumerates the canonical top-tier-1 symbols and
    // relies on the analysis layer to deduplicate empty results. Operators can
    // override via env in W5; for W2 we keep the dep-free deterministic list.
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].slice(0, TOP_SYMBOL_COUNT);
}

function makeResult(
    terminalState: TerminalStateEnum,
    draftVersionId: number | null,
    reportPaths: IReportPaths | null,
    failureReason: string | null,
): IRunWeeklyLoopResult {
    // Explicit null on every CI/gate field so the result shape is uniform
    // across COMPLETED / SKIPPED_HALTED / IDEMPOTENT_SKIP / FAILED branches —
    // downstream consumers never see `undefined`.
    return {
        terminalState,
        draftVersionId,
        reportPaths,
        failureReason,
        bootstrapCiLo: null,
        bootstrapCiHi: null,
        passesPromotionGate: null,
    };
}

function extractFailureReason(err: unknown): string {
    if (err instanceof LlmSchemaRepairFailedError) {
        return 'LLM_SCHEMA_REPAIR_FAILED';
    }

    if (err instanceof LlmGatewayError) {
        return 'LLM_GATEWAY_ERROR';
    }

    if (err === null || err === undefined || typeof err !== 'object') {
        return typeof err === 'string' ? err : 'UNKNOWN';
    }

    const tagged = err as { code?: string; name?: string };

    if (typeof tagged.code === 'string' && tagged.code.length > 0) {
        return tagged.code;
    }

    if (typeof tagged.name === 'string' && tagged.name.length > 0) {
        return tagged.name;
    }

    return 'UNKNOWN';
}

function nameOf(err: unknown): string {
    if (err !== null && typeof err === 'object') {
        const n = (err as { name?: unknown }).name;

        if (typeof n === 'string') {
            return n;
        }
    }

    return 'Error';
}

export class LlmSchemaRepairFailedError extends Error {
    public readonly secondAttemptName: string;

    constructor(secondAttemptName: string) {
        super(`LLM schema repair failed: second attempt threw ${secondAttemptName}`);
        this.name = 'LlmSchemaRepairFailedError';
        this.secondAttemptName = secondAttemptName;
    }
}

// Non-schema gateway failure (network, rate-limit, auth, transport). Does NOT
// trigger a one-shot repair retry — surfaces directly as `LLM_GATEWAY_ERROR`.
export class LlmGatewayError extends Error {
    public readonly underlyingName: string;

    constructor(underlyingName: string) {
        super(`LLM gateway error: ${underlyingName}`);
        this.name = 'LlmGatewayError';
        this.underlyingName = underlyingName;
    }
}
