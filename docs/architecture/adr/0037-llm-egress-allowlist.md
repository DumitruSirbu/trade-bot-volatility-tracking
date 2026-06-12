# ADR 0037 — LLM egress allowlist + `redactForLlm` chokepoint

**Status:** Accepted (M13 W0 — orchestrator-blessed config-row + HTTP transport + compose cron)
**Date:** 2026-05-27
**Milestone:** M13 — Agentic weekly loop
**Depends on:** ADR 0034 (MCP DB isolation — sensitive-table blocklist), ADR 0020 (auth-failure shape, token contents), ADR 0035 (agent structural boundary), ADR 0028 (key-permission assertion port — sensitive material).
**Consumed by:** M13 W1.5 (`redactForLlm` chokepoint), M13 W2.2 (`buildPrompt`), M13 W6 (egress adversarial QA).
**Related:** `docs/plans/archive/M13-execution-plan.md` §"Inputs locked" #6, §W1 item 5, §W6a vector 1, §Risks R2.

## 1. Context

M13's agent serializes engine data into LLM prompts. The data flows:

```
MCP tools  ->  agent in-process DTO  ->  redactForLlm()  ->  prompt string  ->  Vercel AI Gateway  ->  LLM provider
```

Every byte that crosses the LLM boundary is permanently exfiltrated from
the operator's trust boundary: even if no provider logs prompts (and most
do, by default), the bytes have left the host. Therefore:

- Any **secret** field reaching the prompt is a credential leak.
- Any **operator-identity** field (account id, user id, IP) reaching the
  prompt is a privacy leak and a re-identification handle.
- Any **exchange-side** identifier (`exchange_order_id`, `client_order_id`)
  reaching the prompt is a position-disclosure handle that lets a third
  party correlate orders to the operator on public exchange data.

ADR 0034's DB role already blocks the agent from `SELECT`ing
`auth_tokens`, `paper_account_state`, `account_snapshots`, etc., at the
database layer. ADR 0037 is the **second layer**: even within the
allowed table set, individual *fields* may be sensitive (e.g.,
`positions.exchange_order_id`, `account_snapshots.balance` if it ever
appears in a permitted-table join). The egress chokepoint enforces the
field-level allowlist.

The orchestrator has locked the policy:

> LLM egress allowlist: explicit DTO whitelist of what may be serialized
> into prompts (aggregated metrics, returns, regime summaries); never API
> keys, account balances, equity, user identifiers, exchange order IDs.
> Redaction layer at the agent→LLM boundary, tested.

## 2. Decision

### 2.1 Single chokepoint — `redactForLlm`

Location: `apps/agent/src/llm/redactForLlm.ts`. **Every code path that
builds a prompt string MUST call `redactForLlm(input)` first.**

```
function redactForLlm<T>(input: T): T
```

Behavior:

- Walks the input tree (objects, arrays, nested objects).
- For each leaf field, asserts that:
  - The field's name (path-qualified) is on the allowlist (see §2.2), OR
  - The leaf value is a numeric / decimal-string metric / enum tag /
    boolean (structural data with no PII channel).
- On the first non-conforming leaf, throws `EgressViolationError` with
  a payload listing every offending path discovered in a single pass
  (collected, not short-circuited — operator sees the full violation
  set, not just the first).
- Does NOT silently drop fields. Does NOT replace with `[REDACTED]`.
  Failure is a hard exception that halts the agent run with
  `terminal_state='FAILED'` and `failure_reason='EGRESS_VIOLATION'`.

The function is pure and deterministic (no `Date.now()`, no I/O); it can
be called from anywhere in the agent without ordering concerns.

### 2.2 Allowlist (whitelist)

Field paths and DTO shapes the LLM may receive:

**Performance / metric DTOs:**

- `IPerformanceByVersionView`: every field — `versionId`, `name`,
  `version`, `trades`, `winRate`, `expectancy`, `expectancyPerUnitRisk`,
  `sharpe`, `sortino`, `maxDrawdown`, `pnlSum`, `windowDays`,
  `regimeTag`.
- `IComparisonReport`: every field — paired metric deltas, bootstrap CI
  bounds, walk-forward OOS splits, per-regime breakdowns.
- `IBacktestReport` summary fields ONLY: `fromIso`, `toIso`,
  `tradesCount`, `pnlSum`, `expectancy`, `expectancyPerUnitRisk`,
  `sharpe`, `sortino`, `maxDrawdown`, `winRate`, `regimeBreakdown`,
  `bootstrap.ci.lo`, `bootstrap.ci.hi`, `walkForward.splits[*]`,
  `lowFidelity` (boolean tag).
- Decision aggregates: counts by `flow_type`, by `signal_score` bucket,
  by `regimeTag`, by hour-of-day bucket. **NOT** raw decision rows.

**Identifiers (anonymized only):**

- `instruments.symbol` — exchange-public, broadcast on every order
  book. Allowed.
- `strategy_versions.name`, `version`, `parent_version_id`,
  `versionId` (integer surrogate key) — internal-only identifiers
  with no operator linkage. Allowed.

**Structural / enum tags:**

- `FlowTypeEnum`, `RegimeTagEnum`, `SignalScoreBucketEnum`,
  `TerminalStateEnum`, `HaltReasonEnum`.
- ISO timestamps (`fromIso`, `toIso`, `weekIso`).
- Numeric / decimal-string metrics with no identifier semantics.

**Statistical metadata:**

- Paired-bootstrap statistics (count, CI bounds, p-values).
- Sample sizes, trade counts, regime trade counts.

The allowlist is enumerated as a single exported const
`EGRESS_ALLOWLIST` in `redactForLlm.ts` (kept in lockstep with this
ADR's §2.2 by the paired test described in §2.4).

### 2.3 Blocklist (explicit denylist of fields named here)

Even when a permitted table is joined, these field paths MUST NOT reach
the LLM under any circumstance:

**Auth / secrets:**

- Anything from `auth_tokens.*`, `revoked_jti.*`.
- `bearerToken`, `apiKey`, `apiSecret`, `secret`, `signingSecret`,
  `bootstrapSecret`, `passphrase`, `password`, `hmac`, `hmacKey`,
  `subkey`, `seed`, `salt`, `nonce` (any field whose name contains these
  substrings).
- `AUTH_SIGNING_SECRET`, `AUTH_BOOTSTRAP_SECRET`, `MCP_DB_PASSWORD`,
  `AGENT_DB_PASSWORD`, `AGENT_MCP_BEARER`, `AI_GATEWAY_API_KEY`,
  `TELEGRAM_BOT_TOKEN`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`.

**Account-state numerics:**

- `account_snapshots.balance`, `account_snapshots.equity`,
  `account_snapshots.totalWalletBalance`,
  `account_snapshots.availableBalance`,
  `account_snapshots.unrealizedPnl`, `account_snapshots.marginBalance`,
  any column whose name contains `balance`, `equity`, `wallet`,
  `availableMargin`.

**Operator identity:**

- `accountId`, `userId`, `operatorId`, `actorSub`, `actorJti`,
  `sourceIp`, any field whose name contains `ip` (e.g., `clientIp`,
  `ipAllowlist`, `ipAddress`).

**Exchange-side identifiers:**

- `position.exchange_order_id`, `position.exchangePositionId`,
  `client_order_id`, `clientOrderId`, `exchangeOrderId`,
  `exchangeTradeId`, `binanceOrderId`.
- Raw exchange responses (`rawResponse`, `exchangeResponse`,
  `ccxtResponse` — any field whose name contains these substrings).

**Halt / audit forensics:**

- `control_audit.*` content (operator action records).
- `previousState`, `newState` from `control_audit`.
- `crn_tape.*`, `boot_mode_history.*`, `key_permission_*.*` — even by
  table read, ADR 0034 blocks; this ADR makes the field-name patterns
  explicit defense-in-depth in case of a join-projection.

The blocklist is a const `EGRESS_BLOCKLIST` exported from
`redactForLlm.ts`. **Every name appears in a fixture in the paired test
and triggers the throw** (see §2.4).

### 2.4 Paired-test contract

`apps/agent/tests/redactForLlm.spec.ts` is required-green at every fix
wave. Asserts:

1. **Every blocklist field name triggers the throw.** A single fixture
   object contains one field per entry in `EGRESS_BLOCKLIST`. Each
   call to `redactForLlm(fixture)` MUST throw `EgressViolationError`
   listing exactly that path.
2. **Every allowlist field name passes.** A separate fixture contains
   one field per entry in `EGRESS_ALLOWLIST` with valid sample
   values; `redactForLlm` returns the object unchanged.
3. **Nested objects walk correctly.** Fixture with a blocklist field
   three levels deep triggers the throw with the full path string.
4. **Arrays of objects are walked element-by-element.** Fixture with
   100 entries, one containing a blocklist field, throws once with
   the indexed path.
5. **All offending paths are reported in one throw.** Fixture with
   five blocklist fields → `EgressViolationError.paths.length === 5`.
6. **Numeric/decimal-string leaves of unknown field-name are
   accepted.** Fixture with `{ customMetric: '1.23456' }` passes.
7. **String leaves of unknown field-name are rejected.** Fixture
   with `{ customString: 'hello' }` throws (catches "free-text leaks
   via a field name no one anticipated").
8. **The fixture in (1) is generated from `EGRESS_BLOCKLIST` at test
   time** — any new blocklist entry added in §2.3 is automatically
   under test without the test author remembering to extend.

### 2.5 Where `redactForLlm` is called

Required call sites (M13 W2):

- `buildPrompt(systemTemplate, userTemplate, dynamicData)` — every
  dynamic-data injection passes through `redactForLlm` first.
- Any "1-shot example" assembly that includes real data — also through
  `redactForLlm`.
- Anywhere the agent code path serializes a tool response into the
  LLM's tool-result message — through `redactForLlm`.

Forbidden call sites:

- The function MUST NOT be called on LLM **output** (the LLM's
  proposed `params` jsonb). The output is parsed against
  `ProposedDraftSchema` (Zod), and the `params` jsonb is treated as
  opaque structured data for the SDF — not re-serialized to a
  prompt.
- The function MUST NOT be called on `rationale` text written to the
  report (rationale is rendered as fenced markdown to operators, not
  back-piped to a future prompt in M13 — anti-feedback-loop discipline).

### 2.6 What this ADR does NOT do

- Does NOT attempt to redact tool-response content at the MCP server
  side. MCP enforces the table-level grant set (ADR 0034); field-level
  scrubbing is the agent's job at the LLM boundary.
- Does NOT cover model-provider-side prompt logging. Operator selects
  the model provider via Vercel AI Gateway; provider-side data-retention
  policies are an operational concern documented in the runbook
  (M13 W5.5).
- Does NOT redact LLM-emitted text on the way back into reports. The
  LLM's `rationale` is bounded (≤2000 chars), rendered as untrusted
  markdown, never `eval`'d (R2 in execution plan §Risks).

## 3. Consequences

**Positive.**

- One auditable code path gates every byte that crosses the LLM
  boundary. `git grep "redactForLlm\|EgressViolationError" apps/agent`
  enumerates every prompt-building call site in a few seconds.
- Adding a new sensitive field to a permitted table is safe by
  default: unless its field name matches an allowlist entry, the
  walker rejects it.
- Symmetric to ADR 0034's table-level grant set — table layer +
  field layer = two independent failure points before secrets leave
  the host.
- W6a vector 1 (egress-violation adversarial test) becomes a one-line
  fixture (`{ apiKey: 'leaked' }` in tool-response shape) with a
  deterministic assertion.

**Negative.**

- The allowlist is hand-maintained. A new DTO field added in
  `@bot/shared` is invisible to the allowlist until someone updates
  it. Mitigated by the test in §2.4 item 7: any unknown string field
  triggers a throw, which CI catches before the agent runs.
- "Reject unknown string fields" is conservative — it can false-positive
  when a new safe field is added. Operator updates the allowlist in the
  same PR as the DTO; the failure mode is "agent run fails loudly,"
  not "secret silently leaked." Acceptable.

**Neutral.**

- Maintenance cost is concentrated in one file (`redactForLlm.ts`) plus
  this ADR. M14 (code-gen) inherits the chokepoint unchanged.

## 4. Alternatives considered

- **A. Trust the MCP server's table-grant set; no field-level filter
  in the agent.** Rejected: a future tool that joins
  `positions` ⨝ `instruments` and returns `exchange_order_id`
  silently leaks. Defense-in-depth requires the field layer.
- **B. Schema-driven (Zod) "only allow this shape" instead of a
  field-name walker.** Considered. Stricter but couples every prompt
  build site to a Zod schema; the walker pattern admits richer
  composition (a tool returns 200 fields and we want a subset for
  prompting, not a rigid schema). Hybrid possible: schema for typed
  tool responses, walker for ad-hoc prompt assembly. M13 ships the
  walker as the single mechanism; M14 may add per-prompt schemas as
  an additional layer.
- **C. Allow-all by default, blocklist-only.** Rejected: any new
  sensitive field added in `@bot/shared` would silently leak until
  someone updated the blocklist. Allowlist-default is the correct
  failure mode (loud rejection of unknowns).
- **D. Redact-and-replace (substitute `[REDACTED]` instead of throw).**
  Rejected: a "soft" redaction encourages "well, the prompt still
  works without that field" patches that drift the prompt away from
  the assertion that *only* allowlist fields are ever sent. Hard
  throw forces the operator to think about each new field before it
  ships.
- **E. Provider-side anonymization (rely on Vercel AI Gateway features).**
  Rejected: gateway features (if they exist) are downstream of the
  bytes leaving the host. The threat model includes the gateway
  itself; redaction must happen client-side.
- **F. Hash sensitive fields (one-way) instead of dropping.**
  Considered for `symbol` if M13 ever needs to anonymize tier-1 vs
  tier-3 instrument identity. Not needed in M13: `symbol` is
  exchange-public. Revisit if M14 introduces sensitive operator-derived
  tags.
- **G. Allowlist by Zod schema name (whole-DTO grants) rather than
  field-path.** Coarser than needed; rejected because it loses the
  ability to allow a subset of `IBacktestReport` (summary fields only).

## 5. References

- `docs/plans/archive/M13-execution-plan.md` §"Inputs locked" #6, §W1.5,
  §W2.2, §W6a vector 1, §Risks R2.
- ADR 0034 §2.5 (table-level grant blocklist this ADR complements at
  the field level).
- ADR 0020 §2.6 (auth-failure shape — `IAuthFailure` is the precedent
  for "envelope shape with named reason" used by `EgressViolationError`).
- ADR 0035 (agent structural boundary — egress chokepoint is the data
  complement to the import-graph boundary).
