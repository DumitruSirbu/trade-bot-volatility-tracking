# ADR 0043 — Decision data-capture completeness (M27)

Status: Accepted
Date: 2026-06-08
Milestone: M27 — Decision data-capture completeness (live trade geometry, halt leg, real position count, live book snapshots)
Amends: ADR 0002 §4/§5 (decisions + book_snapshots schema, market_snapshot field list);
ADR 0029 (adds `ISimulatedFill.missedReason`, carry-in from M26).
Preserves: ADR 0004 (risk gate behaviour unchanged), ADR 0022 (read-API surface frozen),
ADR 0025 (startup schema-validation gate), ADR 0032 (paper mode), ADR 0042 (M25 3-slot ceiling).

## Context

M27 is the fourth milestone of the data-fix arc (M24 → M25 → M26 → M27, analysis item P5 in
`docs/wip/done/main-architector-paper-soak-fill-and-gate-analysis.md`). M24–M26 make trades *happen*
(paper fills, gate approvals, shadow counterfactuals); **M27 makes every decision and fill
*analyzable*** so the resulting dataset can fine-tune strategies. Unlike M24–M26 (code-only),
M27 carries additive schema migrations.

The capture audit (analysis §4) found capture is strong for funnel diagnosis (a 40-field
`market_snapshot` JSONB on every decision row, `event_id` joining live ↔ shadow ↔ backtest) but
weak for outcome-based learning:

- Live `decisions` lacks trade geometry — no `gate_allowed`, no side, no `stop_loss`/`take_profit`/
  `qty`/`notional`/`leverage`. Only `shadow_decisions` carries these; you cannot reconstruct the
  intended trade from a live decision row.
- Halt leg is not on the decision row — `global_halt`/`market_stress` store only the coarse enum;
  the actual leg (`market_stress:breadth` vs BTC shock vs multi) lives on `risk_state`, joinable
  only by UTC date, not `event_id`.
- `active_positions_count` is hard-coded to 0 (`ACTIVE_POSITIONS_COUNT_DRY_RUN` in the snapshot
  mapper) — misleading for any slot/exposure/concurrency analysis (M25 raises concurrency, worsening
  the gap).
- `book_snapshots` has no live writer (schema only); no market-data table carries `event_id`, so
  trigger-time microstructure cannot be exactly rejoined.
- Decision-row Zod validation is warn-only, so JSONB schema drift can degrade silently.

This ADR locks the architecture for closing those gaps. The defining invariant of M27:
**it is observability-only — it must not alter a single gate decision** (it records what the gate
already decided). The locked decisions below are amendments A0–A9 from three independent reviews
(`docs/archive/independent-analysis/{composer,gbt,gemini}/M27-*`, 2026-06-08), code-verified and folded in.

## Decision

### 1. Live `decisions` trade geometry — top-level columns, NOT in `marketSnapshotSchema` (A1)

Add the following **nullable, additive** columns to `DecisionEntity` only, mirroring
`ShadowDecisionEntity`:

| Column | Type | Meaning |
|---|---|---|
| `gate_allowed` | boolean (nullable) | gate verdict; NULL when no intent reached the gate |
| `trade_side` | varchar (nullable) | `PositionSideEnum` value of the intended trade |
| `stop_loss` | numeric `(38,18)` decimal (nullable) | intended/clamped stop price |
| `take_profit` | numeric `(38,18)` decimal (nullable) | intended/clamped take-profit price |
| `qty` | numeric `(38,18)` decimal (nullable) | approved/sized base quantity |
| `notional` | numeric `(38,8)` decimal (nullable) | approved notional (USDT) |
| `leverage` | numeric `(10,4)` decimal (nullable) | applied leverage |

Money/price columns use `decimalColumnTransformer` (ADR 0002 §2) — `MoneyValue`, never `number`.

**Trade geometry does NOT touch `marketSnapshotSchema`.** That schema is the strict 40-field
market-*context* contract (verified `.strict()`; guarded by `marketSnapshot.driftGuard.spec.ts`).
Order fields are not market context. Keeping geometry on top-level `DecisionEntity` columns
preserves the schema-drift guard and the clean separation of context from order intent.
**Only `active_positions_count` stays in the snapshot** (decision 3) — it is already a snapshot field.

Rationale: separates context from order fields; maintains the schema drift guard; reaches shadow
parity so live decisions can be reconstructed into the intended trade for outcome learning.

### 2. Halt leg via gate-owned `IRiskDecision.haltReasonDetail` — read, never re-derived (A2)

`IRiskDecision` (engine-internal) gains `haltReasonDetail: string | null`. The gate already builds
the durable, leg-suffixed string in `buildPersistedHaltReason` / `classifyHaltLeg`. The gate returns:

- **Fresh `market_stress` reject** → the same `classifyHaltLeg`-suffixed string the gate persists to
  `risk_state` (e.g. `market_stress:breadth`, `market_stress:btc_shock`, `market_stress:multi`).
- **Already-halted-day reject** → `state.today.haltReason`.
- **Otherwise** → `null`.

`StrategyService` persists this string **verbatim** to a new nullable `halt_reason_detail` decision
column. It must **not** recompute the leg.

The **date-join helper is explicitly rejected** as an acceptance option (legacy analysis only). A
date join carries drift risk — especially under M25 `PAPER_RELAX_MARKET_STRESS` (ADR 0042), where
the per-leg relax table can make a date-keyed `risk_state` row diverge from what the gate decided for
a specific `event_id`. Reading the leg from the gate's own output keeps the decision row
self-describing and authoritative.

`IRiskDecision.haltReasonDetail` is **engine-internal** — it is not added to `packages/shared/`.

### 3. Real `active_positions_count`, stamped post-evaluate (A4)

Remove `ACTIVE_POSITIONS_COUNT_DRY_RUN` (= 0). Source the **portfolio-wide open-position count at
decision time** from the same `IOpenPositionsPort.findOpen()` the gate consults in
`buildGateContext`. Thread the count from the gate's already-loaded state where possible (avoid a
divergent second read).

The count is stamped **after** `riskGate.evaluate()` (extend `stampGateVerdict` or a sibling stamp)
so **the gate never sees the fixed value** — this is what keeps M27 observability-only (decision 7).
Counts top out at the M25 3-slot ceiling (max 3; ADR 0042 §slot model).

This value stays in the `market_snapshot` JSONB field — it is already a snapshot field and the only
geometry-adjacent field that remains in the snapshot (contrast decision 1). The `marketSnapshotSchema`
field list is unchanged; only the runtime value changes (0 → real count).

### 4. `book_snapshots` additive writer keyed by `event_id` — retention DEFERRED (A5/A6)

The `book_snapshots` table is **non-partitioned** (verified `CreateSchema` migration), so "mirror
the `tick_aggregates` partitioning" is *not* an additive migration. M27 ships only additive changes:

- A nullable `event_id` column.
- A **nullable UNIQUE index on `event_id`** (idempotency — one book row per trigger; replay/retry
  cannot double-write).
- An optional `mid_at_trigger` numeric column (ADR 0002/0005 deferred since M5; same migration).
- A **best-effort writer** that persists the **trigger-time spread/depth aggregates**
  (`bidAskSpreadPct` → `bid_ask_spread_pct`, `bookDepth10bpsUsdt` → `book_depth_10bps_usdt`,
  `bookDepth50bpsUsdt` → `book_depth_50bps_usdt`) keyed by `event_id`, so context is exactly
  rejoinable to the decision row.

**Capture is spread/depth aggregates, not raw L2 (A6).** `IVolatilityDetectedEvent` carries
`bidAskSpreadPct`/`bookDepth10bpsUsdt`/`bookDepth50bpsUsdt` (no raw bid/ask/levels); the entity
stores only spread/depth (verified). Raw L2 order-book capture (bid/ask/levels) is **out of scope** —
it would require a larger event/entity change.

**Best-effort = swallow errors.** The writer mirrors `MarketDataPersistenceListener`'s swallow
pattern (ADR 0002 §4): a write failure logs and returns; it must **never** sit on the order path and
must **never** throw into the trade loop. Observability must not destabilize trading.

`SchemaValidationService` (ADR 0025) is updated to include the new `book_snapshots` required columns
after the migration.

**Retention is a separate follow-up.** A partition-conversion or bounded-DELETE retention design for
`book_snapshots` is its own ADR/milestone with its own DB-safety plan (see §Follow-ups). M27 adds the
column + writer only.

### 5. Decision-row Zod validation — hard-fail in test/dev ONLY, warn elsewhere (A3)

`DecisionRepository`'s `market_snapshot` Zod guard **throws** only in `NODE_ENV=test` or local-dev;
it stays **warn-only** in paper, testnet, and live.

`gateAndPersist` `await`s the decision write **before** `emitApproval` (verified
`StrategyService.ts:301-304`). A hard-fail in paper/live would therefore block a gate-approved open
from ever emitting `ORDER_INTENT_APPROVED_EVENT` — re-introducing the zero-trade symptom that
M24–M26 spent the whole arc fixing. So the throw is keyed on test/dev only. No emit/persist reorder.

`AppConfigService` is injected into `DecisionRepository` to decide the policy. Drift is caught loudly
in CI/tests (where it is safe to throw) and surfaced as a warning in production (where it must not
block fills).

### 6. Durable shadow `missedReason` (A0, carry-in from M26)

M26 deferred the durable missing-data tag to M27 (ADR 0029 M26 Amendment). M27's shared wave adds
optional `missedReason?: 'missing_tick_data' | 'price_not_touched' | null` to `ISimulatedFill` +
`simulatedFillSchema` (additive/nullable), and the shadow orchestrator populates it so M26's
analysis-layer-only detection becomes durable on the row.

This is the **only** `packages/shared/` change in M27 (routed through `bot-shared-maintainer` before
the engine wave). Crucially, **no geometry keys are added to `marketSnapshotSchema`** (decision 1).

### 7. Observability-only invariant — gate fingerprint is the load-bearing proof (A7)

M27 must not alter a single gate decision:

- The gate **never receives** the new `active_positions_count` value — it is stamped post-evaluate
  (decision 3). The gate still sees the pre-stamp value as input.
- The halt detail is **read from the gate's output**, not fed in (decision 2).
- The book writer is **never on the order path** and is best-effort (decision 4).

The behaviour-unchanged proof is a **gate-fingerprint test**, not the funnel mix (which is confounded
by M25 concurrency/stress changes). A fixed `(intent, snapshot, risk_state fixture)` set must produce
an **identical `IRiskDecision`** before and after M27, and the test asserts the gate still receives
`active_positions_count` as a pre-stamp value. This is the load-bearing acceptance test.

### 8. Per-row null-geometry population rules (A8)

Geometry is populated per decision-row class:

| Row class | `gate_allowed` | Geometry population |
|---|---|---|
| **Strategy skip** (no intent) | NULL | All geometry NULL |
| **Pre-gate open skip** (side may exist) | NULL | `trade_side` may be set; `qty` NULL (never sized) |
| **Gate reject** | `false` | `trade_side`/`stop_loss`/`take_profit`/`qty` from intent / proposed exit |
| **Gate approval** | `true` | Use `decision.clampedExit` + `approvedSizing` — **NOT** raw `intent.proposedExit` |

Approved opens use the **post-clamp** exit and the **approved** sizing so the persisted geometry
matches what is actually sent to execution, not the pre-gate proposal. The correlated-loser row
(`BTC_CORRELATED_NOT_BEST_CANDIDATE`) gets explicit QA coverage as a gate-reject case.

### 9. Read-API / `IDecisionView` out of scope (A9)

The new columns are for raw-SQL/MCP soak analysis. `IDecisionView` + `mapDecision` (ADR 0022) stay
**unchanged** — the read contract is frozen. Surfacing the geometry over the read API is an optional
follow-on tracked as MEDIUM tech-debt (an analysis-SDK / `IDecisionView` projection). `position_id`
linkage on the decision row is likewise a separate optional follow-on (set after execution).

## Schema & contract semantics (locked before migration)

- **Additive, nullable only.** Every new `decisions` and `book_snapshots` column is nullable / has a
  safe default. No `NOT NULL` backfill on existing rows, no column drop, no type change to an existing
  column. Pre-M27 rows legitimately keep NULL geometry. The `down` migration drops only the newly
  added columns/indexes.
- **Separate migrations.** `decisions` geometry and `book_snapshots` are **separate** migration
  files (separate blast radius; separate pg_dump-before-migrate per CLAUDE.md #8/#9).
- **Shared contract only where genuinely shared.** Only `ISimulatedFill.missedReason` +
  `simulatedFillSchema` (A0) route through `bot-shared-maintainer`. Geometry lives on `DecisionEntity`
  (engine); `IRiskDecision.haltReasonDetail` is engine-internal. The engine never edits shared types
  directly.
- **DB safety front-and-centre.** Migrations are validated `up`/`down` on the M16 ephemeral test DB
  (port 6900) first. A full `pg_dump` is taken immediately before each soak migration, the path shown
  to the user for confirmation, and `backup_` files pruned to the 2 most recent (CLAUDE.md #8/#9).
  No `down -v`, no `DROP`/`TRUNCATE`/`DELETE`, no destructive compose ops.

## Consequences

**Positive**

- Live `decisions` reach shadow parity — the intended trade is reconstructable per row, enabling
  outcome-based strategy fine-tuning (the entire point of the data-fix arc).
- The halt leg is self-describing per `event_id`, closing the date-join fuzziness and drift risk
  under M25 paper relaxation.
- `active_positions_count` reflects real concurrency for slot/exposure analysis.
- Trigger-time spread/depth aggregates are exactly rejoinable to decisions via `event_id`.
- Schema drift is caught loudly in CI/test without risking blocked fills in production.
- Durable `missedReason` prevents survivorship bias when analyzing shadow misses.

**Negative / accepted trade-offs**

- More nullable columns on `decisions`; old rows carry NULL geometry (expected, not a defect).
- `book_snapshots` grows without retention until the follow-up ships — bounded only by soak duration
  for now (accepted; flagged as a follow-up with its own DB-safety plan).
- The Zod policy is environment-dependent (test/dev throw, prod warn) — a deliberate asymmetry to
  protect the order path, documented here so it is not mistaken for an oversight.
- Raw L2 microstructure is still not captured (aggregates only) — a larger event/entity change
  deferred out of M27.

## Follow-ups (separate ADRs / tech-debt, explicitly deferred)

- **`book_snapshots` retention design (stub).** A partition-conversion vs bounded-DELETE retention
  job for `book_snapshots`, with its own DB-safety plan. Out of scope for M27 (additive `event_id` +
  writer only). MUST be addressed before the table grows unbounded in a long soak.
- **Measured slippage replacing the `estimated_slippage_pct` tier constant** — needs real fills to
  accrue (aligns with M22's 14-day slippage-telemetry requirement). Telemetry item, not a schema
  change here.
- **Analysis-SDK / `IDecisionView` projection** of the new geometry columns over the read API, and
  optional `position_id` linkage (A9). MEDIUM tech-debt.

## Alternatives considered

1. **Put trade geometry inside `marketSnapshotSchema`.** Rejected (A1) — that schema is the strict
   40-field market-context contract with an explicit drift guard. Order fields are not context;
   adding them would break the `.strict()` guard and conflate two concerns. Geometry goes on
   top-level `DecisionEntity` columns instead.

2. **Derive the halt leg by joining `decisions` to `risk_state` on UTC date.** Rejected (A2) — the
   date join is fuzzy (not `event_id`-keyed) and carries drift risk under M25 `PAPER_RELAX_MARKET_STRESS`,
   where a date-keyed `risk_state` row can diverge from the gate's per-event decision. The gate
   already builds the durable string; reading it verbatim is authoritative and drift-free.

3. **Re-derive the halt leg in `StrategyService` from snapshot fields.** Rejected — duplicates
   `classifyHaltLeg` logic outside the gate, the exact drift the gate-owned approach prevents.

4. **Hard-fail Zod everywhere (including paper/live).** Rejected (A3) — `gateAndPersist` persists
   before emitting, so a paper/live throw would block a gate-approved open from filling, undoing
   the M24–M26 fixes. Hard-fail is keyed to test/dev only; prod stays warn-only.

5. **Mirror `tick_aggregates` partitioning on `book_snapshots` in M27.** Rejected (A5) — the table
   is non-partitioned; partition conversion is not an additive migration and pulls in a retention
   design out of M27's scope. M27 adds a nullable `event_id` + UNIQUE index + best-effort writer;
   retention is a separate ADR.

6. **Capture raw L2 (bid/ask/levels) at trigger time.** Rejected (A6) — the event and entity carry
   only spread/depth aggregates; raw L2 needs a larger event/entity change. Out of scope.

7. **Let the gate read the real `active_positions_count`.** Rejected (A4/A7) — that would change a
   gate input and could alter a decision, violating the observability-only invariant. The count is
   stamped post-evaluate; the gate never sees it.

8. **Prove behaviour-unchanged via the funnel mix.** Rejected as the primary proof (A7) — the funnel
   is confounded by M25 concurrency/stress changes deployed in the same window. The gate-fingerprint
   test (fixed fixtures → identical `IRiskDecision`) is the load-bearing proof; funnel mix is
   secondary.

9. **Widen `IDecisionView` / the read API for the new columns in M27.** Rejected (A9) — acceptance is
   SQL/MCP; the read contract (ADR 0022) stays frozen. A projection is an optional follow-on.

## See also

- `docs/plans/archive/M27-decision-data-capture-completeness.md` (scope, amendments A0–A9, dispatch waves, DB safety)
- ADR 0002 (persistence & data model — `decisions`, `book_snapshots`, `marketSnapshotSchema`; amended here)
- ADR 0004 (risk management — halt legs, stress logic; behaviour unchanged by M27)
- ADR 0029 (shadow counterfactual + fill simulator — `ISimulatedFill`; `missedReason` added here)
- ADR 0022 (read-API surface — frozen by M27)
- ADR 0025 (startup schema-validation gate — `book_snapshots` required columns updated)
- ADR 0042 (M25 paper exploration profile — 3-slot ceiling, paper stress relax driving A2/A4 rationale)
- Architect analysis (P5): `docs/wip/done/main-architector-paper-soak-fill-and-gate-analysis.md` §4, §5 P5, §6
