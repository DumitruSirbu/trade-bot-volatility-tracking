// M13 W2.B — pure report builder (execution plan §W2.5).
//
// Renders a markdown + JSON report from the two backtest payloads (active +
// draft), the LLM's proposed draft, and provenance metadata. Deterministic,
// I/O-free, side-effect-free. The LLM rationale is rendered inside a fenced
// markdown block — it is never eval'd, never templated, never piped back into
// a future prompt (Risks R2 in ADR 0037).

import { evaluatePromotionGate, type IPromotionGateEvaluation } from '../backtest/promotionGate.js';
import type { IProposedDraft } from '../llm/ProposedDraftSchema.js';
// eslint-disable-next-line no-restricted-imports -- agent-internal `src/mcp/` directory; ADR 0035 §2.3 layer B targets WORKSPACE reaches (apps/mcp / packages/analysis), not the agent's own subdirectories.
import type { BacktestReportParsed, PerformanceByVersionViewParsed } from '../mcp/schemas.js';

export interface IBuildReportInput {
    readonly activePerformance: PerformanceByVersionViewParsed;
    readonly activeReport: BacktestReportParsed;
    readonly draftReport: BacktestReportParsed;
    readonly proposed: IProposedDraft;
    readonly provenance: IProvenance;
}

export interface IProvenance {
    readonly modelId: string;
    readonly weekIso: string;
    readonly parentVersionId: number;
    readonly draftVersionId: number;
    readonly promptHash: string;
    readonly gatewayCostUsd: number;
}

export interface IBuiltReport {
    readonly markdown: string;
    readonly json: IReportJson;
}

export interface IReportJson {
    readonly headline: IHeadline;
    readonly activeVsDraft: ISummaryRow[];
    readonly walkForwardOos: ISummaryRow[];
    readonly bootstrapCi: IBootstrapCiRow;
    readonly perRegime: IPerRegimeRow[];
    readonly promotionGate: IPromotionGateEvaluation;
    readonly llmRationale: string;
    readonly provenance: IProvenanceJson;
}

export interface IProvenanceJson extends IProvenance {
    readonly passesPromotionGate: boolean;
}

export interface IHeadline {
    readonly weekIso: string;
    readonly parentVersionId: number;
    readonly draftVersionId: number;
    readonly expectedDirection: IProposedDraft['expectedDirection'];
    readonly confidence: number;
}

export interface ISummaryRow {
    readonly metric: string;
    readonly active: string;
    readonly draft: string;
}

export interface IBootstrapCiRow {
    readonly metric: string;
    readonly note: string;
}

export interface IPerRegimeRow {
    readonly regime: string;
    readonly activeTrades: number;
    readonly draftTrades: number;
    readonly activeNetPnl: string;
    readonly draftNetPnl: string;
}

export function buildReport(input: IBuildReportInput): IBuiltReport {
    const headline = renderHeadline(input);
    const summary = renderSummary(input.activeReport, input.draftReport);
    const oos = renderInSampleSummary(input.activeReport, input.draftReport);
    const ci = renderBootstrapCi();
    const regimes = renderPerRegime(input.activeReport, input.draftReport);
    const gate = evaluatePromotionGate(input.draftReport, input.activeReport);
    const markdown = composeMarkdown(input, headline, summary, oos, ci, regimes, gate);
    const json: IReportJson = {
        headline,
        activeVsDraft: summary,
        walkForwardOos: oos,
        bootstrapCi: ci,
        perRegime: regimes,
        promotionGate: gate,
        llmRationale: input.proposed.rationale,
        provenance: { ...input.provenance, passesPromotionGate: gate.passes },
    };
    return { markdown, json };
}

function renderHeadline(input: IBuildReportInput): IHeadline {
    return {
        weekIso: input.provenance.weekIso,
        parentVersionId: input.provenance.parentVersionId,
        draftVersionId: input.provenance.draftVersionId,
        expectedDirection: input.proposed.expectedDirection,
        confidence: input.proposed.confidence,
    };
}

function renderSummary(active: BacktestReportParsed, draft: BacktestReportParsed): ISummaryRow[] {
    return [
        { metric: 'tradeCount', active: String(active.tradeCount), draft: String(draft.tradeCount) },
        { metric: 'winRatePct', active: active.winRatePct, draft: draft.winRatePct },
        { metric: 'netPnlUsdt', active: active.netPnlUsdt, draft: draft.netPnlUsdt },
        { metric: 'sharpeAnnualized', active: active.sharpeAnnualized, draft: draft.sharpeAnnualized },
        { metric: 'sortinoAnnualized', active: active.sortinoAnnualized, draft: draft.sortinoAnnualized },
        { metric: 'maxDrawdownPct', active: active.maxDrawdownPct, draft: draft.maxDrawdownPct },
        { metric: 'profitFactor', active: active.profitFactor, draft: draft.profitFactor },
    ];
}

function renderInSampleSummary(active: BacktestReportParsed, draft: BacktestReportParsed): ISummaryRow[] {
    // The MCP backtest payload doesn't carry walk-forward splits at this stage;
    // we emit a single in-sample row so the table is non-empty and the schema
    // is stable for downstream renderers. W4 wires the real OOS slices.
    return [
        { metric: 'inSampleNetPnlUsdt', active: active.netPnlUsdt, draft: draft.netPnlUsdt },
        { metric: 'inSampleReturnPct', active: active.returnPct, draft: draft.returnPct },
    ];
}

function renderBootstrapCi(): IBootstrapCiRow {
    return {
        metric: 'expectancyPerUnitRisk',
        note: 'bootstrap CI not yet sourced from backtest payload (W4)',
    };
}

function renderPerRegime(active: BacktestReportParsed, draft: BacktestReportParsed): IPerRegimeRow[] {
    const byKey = new Map<string, IPerRegimeRow>();
    for (const row of active.perRegime) {
        byKey.set(row.key, { regime: row.key, activeTrades: row.tradeCount, draftTrades: 0, activeNetPnl: row.netPnlUsdt, draftNetPnl: '0' });
    }
    for (const row of draft.perRegime) {
        const existing = byKey.get(row.key);
        if (existing === undefined) {
            byKey.set(row.key, { regime: row.key, activeTrades: 0, draftTrades: row.tradeCount, activeNetPnl: '0', draftNetPnl: row.netPnlUsdt });
            continue;
        }
        byKey.set(row.key, { ...existing, draftTrades: row.tradeCount, draftNetPnl: row.netPnlUsdt });
    }
    return Array.from(byKey.values()).sort((a, b) => a.regime.localeCompare(b.regime));
}

function pickFenceForRationale(rationale: string): string {
    // CommonMark allows a fenced block to use any run of >=3 backticks; the
    // closing fence must match the opener's length. To make the rationale
    // tamper-proof against embedded triple-backticks we pick a fence one
    // character longer than the longest backtick run in the rationale.
    const matches = rationale.match(/`+/g);
    let longest = 0;
    if (matches !== null) {
        for (const m of matches) {
            if (m.length > longest) {
                longest = m.length;
            }
        }
    }
    const fenceLen = Math.max(3, longest + 1);
    return '`'.repeat(fenceLen);
}

function composeMarkdown(
    input: IBuildReportInput,
    headline: IHeadline,
    summary: ISummaryRow[],
    oos: ISummaryRow[],
    ci: IBootstrapCiRow,
    regimes: IPerRegimeRow[],
    gate: IPromotionGateEvaluation,
): string {
    const sections: readonly string[] = [
        renderHeadlineSection(headline),
        renderSummarySection(summary),
        renderOosSection(oos),
        renderBootstrapCiSection(ci),
        renderRegimeSection(regimes),
        renderGateSection(gate),
        renderRationaleSection(input.proposed.rationale),
        renderProvenanceSection(input.provenance, gate),
    ];

    return sections.join('\n\n');
}

function renderHeadlineSection(headline: IHeadline): string {
    const lines: string[] = [];
    lines.push(`# Agent weekly report — ${headline.weekIso}`);
    lines.push('');
    lines.push(`Parent version: \`${headline.parentVersionId}\` -> Draft version: \`${headline.draftVersionId}\``);
    lines.push(`Expected direction: \`${headline.expectedDirection}\` (confidence ${headline.confidence})`);

    return lines.join('\n');
}

function renderSummarySection(summary: readonly ISummaryRow[]): string {
    const lines: string[] = [];
    lines.push('## Active vs Draft');
    lines.push('');
    lines.push('| metric | active | draft |');
    lines.push('| --- | --- | --- |');

    for (const row of summary) {
        lines.push(`| ${row.metric} | ${row.active} | ${row.draft} |`);
    }

    return lines.join('\n');
}

function renderOosSection(oos: readonly ISummaryRow[]): string {
    const lines: string[] = [];
    lines.push('## In-sample summary (walk-forward OOS pending engine extension)');
    lines.push('');
    lines.push('| metric | active | draft |');
    lines.push('| --- | --- | --- |');

    for (const row of oos) {
        lines.push(`| ${row.metric} | ${row.active} | ${row.draft} |`);
    }

    return lines.join('\n');
}

function renderBootstrapCiSection(ci: IBootstrapCiRow): string {
    const lines: string[] = [];
    lines.push('## Bootstrap CI on expectancy-per-unit-risk');
    lines.push('');
    lines.push(`- metric: ${ci.metric}`);
    lines.push(`- note: ${ci.note}`);

    return lines.join('\n');
}

function renderRegimeSection(regimes: readonly IPerRegimeRow[]): string {
    const lines: string[] = [];
    lines.push('## Per-regime breakdown');
    lines.push('');
    lines.push('| regime | active trades | draft trades | active netPnl | draft netPnl |');
    lines.push('| --- | --- | --- | --- | --- |');

    for (const row of regimes) {
        lines.push(`| ${row.regime} | ${row.activeTrades} | ${row.draftTrades} | ${row.activeNetPnl} | ${row.draftNetPnl} |`);
    }

    return lines.join('\n');
}

function renderGateSection(gate: IPromotionGateEvaluation): string {
    const lines: string[] = [];
    lines.push('## Promotion gate (ADR 0019)');
    lines.push('');
    lines.push(`Overall: ${gate.passes ? 'PASS' : 'FAIL'}`);
    lines.push('');
    lines.push('| # | criterion | threshold | measured | result |');
    lines.push('| --- | --- | --- | --- | --- |');

    for (const row of gate.criteria) {
        lines.push(`| ${row.index} | ${row.name} | ${row.threshold} | ${row.measured} | ${row.passed ? 'PASS' : 'FAIL'} |`);
    }

    return lines.join('\n');
}

function renderRationaleSection(rationale: string): string {
    const fence = pickFenceForRationale(rationale);
    const lines: string[] = [];
    lines.push('## LLM rationale');
    lines.push('');
    lines.push(`${fence}markdown`);
    lines.push(rationale);
    lines.push(fence);

    return lines.join('\n');
}

function renderProvenanceSection(provenance: IProvenance, gate: IPromotionGateEvaluation): string {
    const lines: string[] = [];
    lines.push('## Provenance');
    lines.push('');
    lines.push(`- modelId: \`${provenance.modelId}\``);
    lines.push(`- weekIso: \`${provenance.weekIso}\``);
    lines.push(`- parentVersionId: \`${provenance.parentVersionId}\``);
    lines.push(`- draftVersionId: \`${provenance.draftVersionId}\``);
    lines.push(`- promptHash: \`${provenance.promptHash}\``);
    lines.push(`- gatewayCostUsd: \`${provenance.gatewayCostUsd}\``);
    lines.push(`- passesPromotionGate: \`${gate.passes}\``);

    return lines.join('\n');
}
