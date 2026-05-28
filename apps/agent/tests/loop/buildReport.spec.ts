// M13 W2.B — buildReport golden-file + injection-safety tests.

import type { IProposedDraft } from '../../src/llm/ProposedDraftSchema.js';
import { buildReport, type IBuildReportInput } from '../../src/loop/buildReport.js';
import type { BacktestReportParsed, PerformanceByVersionViewParsed } from '../../src/mcp/schemas.js';

const ACTIVE_PERF: PerformanceByVersionViewParsed = {
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

function makeReport(label: string, netPnl: string, perRegimeKey: string, regimeTrades: number): BacktestReportParsed {
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
        netPnlUsdt: netPnl,
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
        perRegime: [{ key: perRegimeKey, tradeCount: regimeTrades, winRatePct: '60.00', netPnlUsdt: netPnl, profitFactor: '1.50' }],
        perFlowType: [],
        perSymbol: [],
        trades: [],
    };
}

const FIXTURE_DRAFT: IProposedDraft = {
    params: { signalThreshold: 1.8 },
    rationale: 'Tighten signal threshold to reduce noise.',
    expectedDirection: 'better',
    confidence: 0.6,
};

function makeInput(overrides: Partial<IBuildReportInput> = {}): IBuildReportInput {
    return {
        activePerformance: ACTIVE_PERF,
        activeReport: makeReport('active', '92.00', 'regime:trend', 5),
        draftReport: makeReport('draft', '105.00', 'regime:trend', 6),
        proposed: FIXTURE_DRAFT,
        provenance: {
            modelId: 'anthropic/claude-opus-4-7',
            weekIso: '2026-W21',
            parentVersionId: 7,
            draftVersionId: 999,
            promptHash: 'deadbeef',
            gatewayCostUsd: 0.0123,
        },
        ...overrides,
    };
}

describe('buildReport — golden markdown', () => {
    it('renders headline + summary + provenance in the documented order', () => {
        const { markdown } = buildReport(makeInput());

        expect(markdown).toContain('# Agent weekly report — 2026-W21');
        expect(markdown).toContain('Parent version: `7` -> Draft version: `999`');
        expect(markdown).toContain('Expected direction: `better` (confidence 0.6)');
        expect(markdown).toContain('## Active vs Draft');
        expect(markdown).toContain('| netPnlUsdt | 92.00 | 105.00 |');
        expect(markdown).toContain('## In-sample summary (walk-forward OOS pending engine extension)');
        expect(markdown).toContain('## Bootstrap CI on expectancy-per-unit-risk');
        expect(markdown).toContain('## Per-regime breakdown');
        expect(markdown).toContain('| regime:trend | 5 | 6 | 92.00 | 105.00 |');
        expect(markdown).toContain('## Promotion gate (ADR 0019)');
        expect(markdown).toContain('## LLM rationale');
        expect(markdown).toContain('- passesPromotionGate: `');
        expect(markdown).toContain('## Provenance');
        expect(markdown).toContain('- modelId: `anthropic/claude-opus-4-7`');
        expect(markdown).toContain('- promptHash: `deadbeef`');
        expect(markdown).toContain('- gatewayCostUsd: `0.0123`');
    });

    it('emits the section headers in the documented order', () => {
        const { markdown } = buildReport(makeInput());
        const order = [
            '# Agent weekly report',
            '## Active vs Draft',
            '## In-sample summary (walk-forward OOS pending engine extension)',
            '## Bootstrap CI on expectancy-per-unit-risk',
            '## Per-regime breakdown',
            '## Promotion gate (ADR 0019)',
            '## LLM rationale',
            '## Provenance',
        ];
        let cursor = -1;
        for (const heading of order) {
            const idx = markdown.indexOf(heading);
            expect(idx).toBeGreaterThan(cursor);
            cursor = idx;
        }
    });
});

describe('buildReport — JSON contract', () => {
    it('produces a JSON object mirroring the markdown facts', () => {
        const { json } = buildReport(makeInput());

        expect(json.headline.weekIso).toBe('2026-W21');
        expect(json.headline.draftVersionId).toBe(999);
        expect(json.headline.expectedDirection).toBe('better');
        expect(json.activeVsDraft).toContainEqual({ metric: 'netPnlUsdt', active: '92.00', draft: '105.00' });
        expect(json.perRegime).toEqual([
            { regime: 'regime:trend', activeTrades: 5, draftTrades: 6, activeNetPnl: '92.00', draftNetPnl: '105.00' },
        ]);
        expect(json.llmRationale).toBe('Tighten signal threshold to reduce noise.');
        expect(json.provenance.gatewayCostUsd).toBe(0.0123);
    });
});

describe('buildReport — promotion gate (ADR 0019)', () => {
    it('renders all 13 criteria rows in ADR 0019 order in the markdown table (criterion 10 splits into 10a + 10b)', () => {
        const { markdown } = buildReport(makeInput());
        const gateIdx = markdown.indexOf('## Promotion gate (ADR 0019)');
        expect(gateIdx).toBeGreaterThan(-1);
        const rationaleIdx = markdown.indexOf('## LLM rationale');
        const gateSection = markdown.slice(gateIdx, rationaleIdx);

        // Each criterion row starts with `\n| <n> | <name>`. Criterion 10
        // appears twice (per-symbol measurable + per-week NOT_AVAILABLE).
        const indices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 12];
        const rowIndices: number[] = [];
        let cursor = 0;
        for (const i of indices) {
            const re = new RegExp(`\\n\\| ${i} \\| `, 'g');
            re.lastIndex = cursor;
            const match = re.exec(gateSection);
            expect(match).not.toBeNull();
            rowIndices.push(match!.index);
            cursor = match!.index + 1;
        }
        for (let k = 1; k < rowIndices.length; k = k + 1) {
            expect(rowIndices[k]).toBeGreaterThan(rowIndices[k - 1]);
        }
    });

    it('exposes promotionGate + passesPromotionGate on the JSON shape (13 rows with split criterion 10)', () => {
        const { json } = buildReport(makeInput());
        expect(json.promotionGate.criteria).toHaveLength(13);
        expect(json.promotionGate.criteria[0].index).toBe(1);
        expect(json.promotionGate.criteria[12].index).toBe(12);
        // Criterion 10 has two adjacent rows (per-symbol + per-week).
        expect(json.promotionGate.criteria[9].index).toBe(10);
        expect(json.promotionGate.criteria[10].index).toBe(10);
        expect(typeof json.promotionGate.passes).toBe('boolean');
        expect(json.provenance.passesPromotionGate).toBe(json.promotionGate.passes);
    });
});

describe('buildReport — markdown-injection safety', () => {
    it('renders an attacker-controlled rationale inside a fenced block, never as raw headers', () => {
        const malicious: IProposedDraft = {
            params: {},
            rationale: '# pwned\n```bash\nrm -rf /\n```\n## injected section',
            expectedDirection: 'similar',
            confidence: 0.5,
        };
        const { markdown } = buildReport(makeInput({ proposed: malicious }));

        // The rationale text appears verbatim inside the fenced block.
        expect(markdown).toContain('# pwned');
        expect(markdown).toContain('rm -rf /');

        // Structural sections still in the documented order (no injected
        // heading hijacks the outline).
        const provenanceIdx = markdown.indexOf('## Provenance');
        const rationaleIdx = markdown.indexOf('## LLM rationale');
        expect(rationaleIdx).toBeGreaterThan(0);
        expect(provenanceIdx).toBeGreaterThan(rationaleIdx);

        // The rationale fence opens with `+markdown and closes with the same
        // run-length of backticks (CommonMark fenced-block rule). The renderer
        // picks a fence longer than any backtick run in the rationale so an
        // attacker cannot close it early.
        const fenceMatch = markdown.slice(rationaleIdx).match(/(`{3,})markdown\n/);
        expect(fenceMatch).not.toBeNull();
        const openFence = fenceMatch![1];
        const fenceOpen = rationaleIdx + fenceMatch!.index!;
        const fenceClose = markdown.indexOf(`\n${openFence}\n`, fenceOpen + openFence.length);
        expect(fenceClose).toBeGreaterThan(fenceOpen);
        const fencedBody = markdown.slice(fenceOpen, fenceClose);
        expect(fencedBody).toContain('# pwned');
        expect(fencedBody).toContain('## injected section');
        // The internal ``` from the attacker rationale must NOT close the outer fence.
        expect(openFence.length).toBeGreaterThan(3);
    });
});
