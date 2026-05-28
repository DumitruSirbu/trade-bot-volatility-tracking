// M13 W2.A — Zod schema for the LLM's structured output (ADR 0037 §2.5).
//
// The LLM is constrained to producing a single ProposedDraft per agent run.
// The shape lives here (NOT in @bot/shared) — it is an agent-internal contract
// between the agent and the LLM, not a cross-app DTO. The agent persists
// `params` opaquely via the SDF; the SDF validates `params` is a jsonb object.
//
// Constraints encoded:
//   - `params`     : jsonb-shaped record (the SDF will reject non-object).
//   - `rationale`  : <=2000 chars; rendered as fenced markdown in reports, never
//                    eval'd or back-piped to a future prompt (Risks R2).
//   - `expectedDirection` : trichotomy — directs the operator's expectation,
//                    not a promotion decision (ADR 0019 enforces gating).
//   - `confidence` : [0, 1] — LLM self-reported, not a rejection threshold.

import { z } from 'zod';

export const PROPOSED_DRAFT_RATIONALE_MAX_CHARS = 2000;

// `.strict()` causes Zod to reject extra fields (e.g., a hallucinated
// `_action: 'promote_to_active'`) instead of silently stripping them.
// Required by ADR 0037 §2.5 — surfacing the extra field triggers the
// agent's one-shot schema-repair cycle; on second failure the loop
// terminates with `LLM_SCHEMA_REPAIR_FAILED` rather than silently
// dropping data the operator's prompt did not authorise.
export const ProposedDraftSchema = z
    .object({
        params: z.record(z.string(), z.unknown()),
        rationale: z.string().max(PROPOSED_DRAFT_RATIONALE_MAX_CHARS),
        expectedDirection: z.enum(['better', 'similar', 'worse']),
        confidence: z.number().min(0).max(1),
    })
    .strict();

export type IProposedDraft = z.infer<typeof ProposedDraftSchema>;
