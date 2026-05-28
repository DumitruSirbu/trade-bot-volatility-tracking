// M13 W2.A — buildPrompt + ProposedDraftSchema tests (execution plan §W2.2/3).

import {
    AGENT_SYSTEM_PROMPT,
    buildPrompt,
    MAX_PROMPT_CHARS,
    ONE_SHOT_EXAMPLE_MARKER,
    PromptTooLargeError,
    SYSTEM_CONSTRAINT_STATEMENT,
    type IBuildPromptInput,
} from '../../src/llm/buildPrompt.js';
import { EgressViolationError } from '../../src/llm/redactForLlm.js';
import { PROPOSED_DRAFT_RATIONALE_MAX_CHARS, ProposedDraftSchema } from '../../src/llm/ProposedDraftSchema.js';

function makeValidInput(overrides: Partial<IBuildPromptInput> = {}): IBuildPromptInput {
    return {
        activeVersion: { versionId: 7, name: 'volatility-vwap', version: 3 },
        recentPerformance: [{ strategyVersionId: '7', tradeCount: 42, sharpe: '0.42', windowDays: 90 }],
        topDecisionAggregates: [{ flowType: 'mean_revert', signalScore: '1.8', tradeCount: 14 }],
        ...overrides,
    };
}

describe('buildPrompt — system constraints', () => {
    it('embeds the immutable constraint statement', () => {
        const { system } = buildPrompt(makeValidInput());
        expect(system).toContain(SYSTEM_CONSTRAINT_STATEMENT);
    });

    it('embeds the 1-shot example marker', () => {
        const { system } = buildPrompt(makeValidInput());
        expect(system).toContain(ONE_SHOT_EXAMPLE_MARKER);
    });

    it('returns the canonical AGENT_SYSTEM_PROMPT constant', () => {
        const { system } = buildPrompt(makeValidInput());
        expect(system).toBe(AGENT_SYSTEM_PROMPT);
    });
});

describe('buildPrompt — egress chokepoint', () => {
    it('throws EgressViolationError when a blocklist field is injected anywhere', () => {
        const input = makeValidInput({
            topDecisionAggregates: [{ flowType: 'mean_revert', apiKey: 'leaked-secret' }],
        });
        expect(() => buildPrompt(input)).toThrow(EgressViolationError);
    });

    it('throws EgressViolationError when an operator-identity field reaches the prompt', () => {
        const input = makeValidInput({
            recentPerformance: [{ strategyVersionId: '7', accountId: 'op-1234' }],
        });
        expect(() => buildPrompt(input)).toThrow(EgressViolationError);
    });
});

describe('buildPrompt — size limit', () => {
    it('throws PromptTooLargeError when total chars exceed MAX_PROMPT_CHARS', () => {
        // One large unknown numeric field (legal-for-redactor) blows past 16k.
        const huge = 'x'.repeat(MAX_PROMPT_CHARS);
        const input = makeValidInput({
            recentPerformance: [{ strategyVersionId: huge, tradeCount: 1, windowDays: 90 }],
        });
        expect(() => buildPrompt(input)).toThrow(PromptTooLargeError);
    });
});

describe('buildPrompt — provenance', () => {
    it('produces a deterministic promptHash for the same input', () => {
        const a = buildPrompt(makeValidInput());
        const b = buildPrompt(makeValidInput());
        expect(a.promptHash).toEqual(b.promptHash);
        expect(a.promptHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes promptHash when the input changes', () => {
        const a = buildPrompt(makeValidInput());
        const b = buildPrompt(
            makeValidInput({
                activeVersion: { versionId: 8, name: 'volatility-vwap', version: 4 },
            }),
        );
        expect(a.promptHash).not.toEqual(b.promptHash);
    });
});

describe('ProposedDraftSchema', () => {
    it('parses a valid object', () => {
        const ok = ProposedDraftSchema.parse({
            params: { signalThreshold: 1.8, atrMultiplier: 1.5 },
            rationale: 'Tighten threshold.',
            expectedDirection: 'better',
            confidence: 0.55,
        });
        expect(ok.confidence).toBe(0.55);
        expect(ok.expectedDirection).toBe('better');
    });

    it('rejects confidence > 1', () => {
        expect(() =>
            ProposedDraftSchema.parse({
                params: {},
                rationale: 'ok',
                expectedDirection: 'similar',
                confidence: 1.5,
            }),
        ).toThrow();
    });

    it('rejects confidence < 0', () => {
        expect(() =>
            ProposedDraftSchema.parse({
                params: {},
                rationale: 'ok',
                expectedDirection: 'similar',
                confidence: -0.1,
            }),
        ).toThrow();
    });

    it('rejects rationale longer than the max', () => {
        const long = 'a'.repeat(PROPOSED_DRAFT_RATIONALE_MAX_CHARS + 1);
        expect(() =>
            ProposedDraftSchema.parse({
                params: {},
                rationale: long,
                expectedDirection: 'worse',
                confidence: 0.1,
            }),
        ).toThrow();
    });

    it('rejects a missing required field', () => {
        expect(() =>
            ProposedDraftSchema.parse({
                params: {},
                rationale: 'ok',
                confidence: 0.5,
            }),
        ).toThrow();
    });

    it('rejects an unknown expectedDirection enum value', () => {
        expect(() =>
            ProposedDraftSchema.parse({
                params: {},
                rationale: 'ok',
                expectedDirection: 'much-better',
                confidence: 0.5,
            }),
        ).toThrow();
    });
});
