# M27 — Decision data-capture completeness (live trade geometry, halt leg, real position count, live book snapshots)

> **Sequencing note:** M27 is the fourth milestone of the data-fix arc (M24→M25→M26→M27) from the
> architect analysis [main-architector-paper-soak-fill-and-gate-analysis.md](../wip/main-architector-paper-soak-fill-and-gate-analysis.md)
> (analysis item **P5**). M24–M26 make trades *happen* (paper fills, gate approvals, shadow
> counterfactuals); M27 makes every decision and fill *analyzable* so the resulting dataset can
> actually be used to fine-tune strategies. M27 runs in **parallel** with M26 and after M24/M25 begin
> producing fills. **Unlike M24–M26, M27 carries schema migrations** — so the CLAUDE.md DB-safety
> invariants (#8/#9: dump-before-migration, no destructive ops) are front and centre, and shared
> contract changes route through `bot-shared-maintainer`.

## Context

The capture audit (analysis §4) found capture is **strong for funnel diagnosis** (a 40-field
`market_snapshot` JSONB on every decision row, `event_id` joining live ↔ shadow ↔ backtest) but
**weak for outcome-based learning**. Concretely:

- **Live `decisions` lacks trade geometry:** no `gate_allowed` boolean, no trade side, no
  `stop_loss`/`take_profit`/`qty`/`notional`/`leverage`. Only `shadow_decisions` carries these. You
  **cannot reconstruct the intended trade from a live decision row** — so even after M24/M25 produce
  fills, the *decision → trade* linkage is incomplete.
- **Halt leg is not on the decision row:** `global_halt`/`market_stress` store only the coarse enum;
  the actual leg (`market_stress:breadth` vs BTC shock vs multi) lives on `risk_state`, joinable only
  by **UTC date**, not `event_id`. Halt reasons are not self-describing per decision.
- **`active_positions_count` is hard-coded to 0** (`ACTIVE_POSITIONS_COUNT_DRY_RUN` in the snapshot
  mapper) — misleading for any slot/exposure/concurrency analysis (and M25 raises concurrency, making
  this gap worse).
- **`book_snapshots` has no live writer** (schema only), and **no market-data table carries
  `event_id`** — trigger-time L2 microstructure cannot be exactly rejoined, only fuzzily by `symbol`
  + time.
- **Decision-row Zod validation is warn-only**, so JSONB schema drift can degrade silently.

These are the gaps that, left unfixed, will make the freshly-produced outcome data hard to learn from.

## Review amendments (locked 2026-06-08 — 3 independent analysts)

Independent reviews (`docs/independent-analysis/{composer,gbt,gemini}/M27-*`) **approve the direction**
(observability-only, additive/nullable migrations, shared-first, DB-safety front-and-centre) but flagged
**code-verified** corrections. All are folded into the scope below. Earlier-milestone decisions are also
carried in (see A0).

- **A0 (carry-in from M26) — add the durable `ISimulatedFill.missedReason` field here.** M26 deferred the
  durable missing-data tag to M27 (decision 2026-06-08). M27's shared wave adds optional
  `missedReason?: 'missing_tick_data' | 'price_not_touched' | null` to `ISimulatedFill` +
  `simulatedFillSchema` (additive/nullable), and the shadow orchestrator populates it so the
  analysis-layer detection M26 shipped becomes durable. (M25's honest 3-slot ceiling is also reflected in
  the `active_positions_count` expectations — counts top out at 3, A4.)
- **A1 (must-fix) — keep trade geometry OFF `marketSnapshotSchema`.** That schema is the strict 40-field
  market-context contract (verified `.strict()`); `marketSnapshot.driftGuard.spec.ts` separates context
  from order fields. Geometry (`gate_allowed`, side, SL/TP, qty/notional/leverage) goes on **top-level
  `DecisionEntity` columns** mirroring `ShadowDecisionEntity`. **Only `active_positions_count` stays in
  the snapshot** (it is already a snapshot field). The shared wave does **not** add geometry keys to
  `marketSnapshotSchema`.
- **A2 (must-fix) — halt leg is gate-owned metadata on `IRiskDecision`, not a date join or
  re-derivation.** `IRiskDecision` (engine-internal, verified) carries no halt detail; the gate already
  builds the durable string in `buildPersistedHaltReason`. Add `haltReasonDetail: string | null` to
  `IRiskDecision`: for fresh `market_stress` rejects return the same `classifyHaltLeg`-suffixed string the
  gate persists to `risk_state`; for already-halted-day rejects return `state.today.haltReason`; NULL
  otherwise. `StrategyService` persists that string verbatim — it must **not** recompute the leg (drift
  risk, esp. under M25 `PAPER_RELAX_MARKET_STRESS`). **Drop the date-join helper** as an acceptance
  option (legacy analysis only).
- **A3 (must-fix) — Zod hard-fail in test/dev ONLY; warn in paper/testnet/live (decision 2026-06-08).**
  `gateAndPersist` `await`s the decision write **before** `emitApproval` (verified
  `StrategyService.ts:301-304`), so a hard-fail in paper would block a gate-approved open from filling —
  re-introducing the zero-trade symptom M24–M26 fixed. M27 keys the throw on **test/local-dev only**
  (`NODE_ENV`), staying warn-only in paper, testnet, and live. No emit/persist reorder. Inject
  `AppConfigService` into `DecisionRepository` to decide.
- **A4 (must-fix) — `active_positions_count` sourced post-evaluate from the gate's own state.** Replace
  `ACTIVE_POSITIONS_COUNT_DRY_RUN` (=0) with the **portfolio-wide open-position count at decision time**,
  sourced from the same `IOpenPositionsPort.findOpen()` the gate consults in `buildGateContext` — stamped
  **after** `riskGate.evaluate()` (extend `stampGateVerdict`/a sibling stamp) so the gate never sees the
  fixed value. Thread the count from the gate's loaded state where possible to avoid a divergent second
  read. Counts top out at the M25 3-slot ceiling.
- **A5 (must-fix) — `book_snapshots`: additive `event_id` + best-effort writer in M27; retention
  DEFERRED.** The table is **non-partitioned** (verified `CreateSchema` migration); "mirror partitioning"
  is **not** an additive migration. M27 ships only: a nullable `event_id` column + a **nullable UNIQUE
  index on `event_id`** (idempotency, one book row per trigger), an optional `mid_at_trigger` numeric
  column on the same migration (ADR 0005 deferred since M5), and a **best-effort** writer (mirror
  `MarketDataPersistenceListener`'s swallow pattern — observability must not destabilize the trade loop).
  Retention (partition vs bounded-DELETE job) is a **separate follow-up ADR/milestone** with its own
  DB-safety plan. Update `SchemaValidationService` book_snapshots required columns after the migration.
- **A6 (must-fix) — capture is spread/depth aggregates, not raw L2.** `IVolatilityDetectedEvent` carries
  `bidAskSpreadPct`/`bookDepth10bpsUsdt`/`bookDepth50bpsUsdt` (no raw bid/ask/levels), and the entity
  stores only spread/depth (verified). Reword "trigger-time L2 microstructure" → **"trigger-time
  spread/depth aggregates"**; raw L2 is out of scope (a larger event/entity change).
- **A7 (must-fix) — behaviour-unchanged needs a gate fingerprint test, not just the funnel mix.** Funnel
  comparison is confounded by M25 concurrency/stress changes. Add a load-bearing test: a fixed
  `(intent, snapshot, risk_state fixture)` set → **identical `IRiskDecision`** before/after M27. Assert
  the gate still receives `active_positions_count` as pre-stamp (the fix is post-evaluate only).
- **A8 (should-fix) — per-row null-geometry rules.** Define population per row class: strategy skip
  (no intent → geometry NULL, `gate_allowed` NULL), pre-gate open skip (side may exist, qty NULL), gate
  reject (side/SL/TP/qty from intent/proposed exit, `gate_allowed=false`), gate approval (use
  `decision.clampedExit` + `approvedSizing`, **not** raw `intent.proposedExit`). Explicit QA for the
  correlated-loser (`BTC_CORRELATED_NOT_BEST_CANDIDATE`) row.
- **A9 (should-fix) — read-API/`IDecisionView` is out of scope; acceptance target is SQL/MCP.** New
  columns are for raw-SQL/MCP soak analysis; `IDecisionView` + `mapDecision` stay unchanged (ADR 0022
  stability). Add a single MEDIUM tech-debt line for an analysis-SDK projection if soak agents later need
  the geometry over the API. `position_id` linkage is a separate optional follow-on (set after execution).

## Scope

Six capture upgrades (A0 folds in the M26-deferred field). They are independent — sequence by blast
radius (schema-touching first).

1. **Live `decisions` trade geometry (parity with shadow) — top-level columns (A1):** add `gate_allowed`
   (boolean), `trade_side`, `stop_loss`, `take_profit`, `qty`, `notional`, `leverage` (nullable text
   decimals / boolean) to **`DecisionEntity`** + a migration, mirroring `ShadowDecisionEntity`. Populate
   in the decision writer from `IRiskDecision`/intent per the A8 row-class rules (approved opens use
   `decision.clampedExit` + `approvedSizing`). **Do not** add geometry to `marketSnapshotSchema`.
2. **Persist the halt leg on the decision row via gate metadata (A2):** add
   `haltReasonDetail: string | null` to `IRiskDecision`; the gate returns the same string it persists to
   `risk_state` (fresh `market_stress` → `classifyHaltLeg` suffix; already-halted-day →
   `state.today.haltReason`). `StrategyService` writes it to a `halt_reason_detail` decision column
   **verbatim** — no re-derivation. Date-join helper dropped.
3. **Fix `active_positions_count` (A4):** replace `ACTIVE_POSITIONS_COUNT_DRY_RUN` with the real
   portfolio-wide open count at decision time, from the same `IOpenPositionsPort` the gate consults,
   stamped **post-evaluate** so the gate never sees the fix. Stays in the `market_snapshot` JSONB field.
4. **Live `book_snapshots` writer keyed by `event_id` — additive only, retention deferred (A5/A6):** add
   a nullable `event_id` column + nullable UNIQUE index, an optional `mid_at_trigger` column, and a
   **best-effort** writer that persists the trigger-time **spread/depth aggregates**
   (`bidAskSpreadPct`/`bookDepth10bpsUsdt`/`bookDepth50bpsUsdt`) tagged with `event_id` so context is
   exactly rejoinable. **Retention is a separate follow-up** (the table is non-partitioned; a partition
   or bounded-DELETE design is its own ADR with DB-safety). Update `SchemaValidationService`.
5. **Promote decision-row Zod validation to hard-fail in test/local-dev ONLY (A3):** warn-only in paper,
   testnet, and live (a hard-fail in paper would block gate-approved opens — `gateAndPersist` persists
   before emitting). Inject `AppConfigService`/`NODE_ENV` into `DecisionRepository`.
6. **Durable shadow missing-data tag (A0, carry-in from M26):** add optional
   `missedReason?: 'missing_tick_data' | 'price_not_touched' | null` to `ISimulatedFill` +
   `simulatedFillSchema` (additive/nullable) and populate it in the shadow orchestrator, making M26's
   analysis-layer detection durable.

**Out of scope:**
- The fills themselves — M24 (P0), M26 (P4) produce the rows M27 annotates.
- Strategy/gate/slot changes — M25.
- Real measured slippage replacing `estimated_slippage_pct` (tier constant) — that needs real fills
  to accrue first; track as a follow-on telemetry item, not a schema change here (aligns with M22's
  14-day slippage-telemetry requirement).
- Any change to live trading risk behaviour — M27 is **observability only**; it must not alter a
  single gate decision (it records what the gate already decided).
- **`book_snapshots` retention/partitioning** — additive `event_id` + writer only in M27; the retention
  design (partition vs bounded-DELETE) is a separate follow-up ADR/milestone (A5).
- **Raw L2 order-book capture** — M27 stores trigger-time spread/depth aggregates only; raw bid/ask/levels
  would need a larger event/entity change (A6).
- **Read-API / `IDecisionView` / dashboard surfacing** of the new columns — acceptance is SQL/MCP; a
  read-contract widening is an optional follow-on (A9). `position_id` linkage likewise.
- **Hard Zod in paper/testnet/live** — explicitly rejected (A3) to avoid blocking gate-approved opens.

## Schema & contract semantics (lock before migration)

- **Additive, nullable columns only.** Every new `decisions` column is added nullable / with a safe
  default — **no `NOT NULL` backfill on existing rows**, no column drop, no type change to an existing
  column. Old rows keep NULL trade geometry (pre-M27 decisions legitimately have none).
- **Shared contract via `bot-shared-maintainer`.** Only genuinely-shared types route through the shared
  maintainer **before** the engine wave: the `ISimulatedFill.missedReason` field + `simulatedFillSchema`
  (A0). **Trade geometry does NOT touch `marketSnapshotSchema`** (A1) — it lives on `DecisionEntity`
  columns (engine). `IRiskDecision.haltReasonDetail` (A2) is engine-internal (not `packages/shared/`).
  Engine does not edit shared types directly.
- **Observability must not change behaviour.** `active_positions_count` is sourced **post-evaluate** (A4)
  and the halt detail is **read from the gate's own output** (A2) — no new gate input, no slot-assignment
  change. A **gate-fingerprint test** (fixed fixtures → identical `IRiskDecision`) is the load-bearing
  proof (A7), not the noisy funnel mix.
- **`book_snapshots` writer is additive + best-effort; retention deferred (A5).** The table is
  non-partitioned, so no partition conversion here. The writer swallows errors (mirrors
  `MarketDataPersistenceListener`) and must never sit on the order path. A nullable UNIQUE `event_id`
  index gives idempotency. Bounded retention is a separate follow-up with its own DB-safety plan.

## Change set

| Workspace            | Files (representative)                                                                                          | Item |
|----------------------|----------------------------------------------------------------------------------------------------------------|------|
| `packages/shared/`   | `ISimulatedFill` + `simulatedFillSchema` — add nullable `missedReason` (A0). **No `marketSnapshotSchema` geometry keys (A1).** | 6 |
| `apps/engine/`       | `src/strategy/entity/DecisionEntity.ts` + migration: additive nullable `gate_allowed`, `trade_side`, `stop_loss`, `take_profit`, `qty`, `notional`, `leverage`, `halt_reason_detail` | 1,2 |
| `apps/engine/`       | `IRiskDecision` + `RiskGateService` — return `haltReasonDetail` (engine-internal, A2) | 2 |
| `apps/engine/`       | decision writer (`persistDecision`/`recordGateDecision` signature + A8 row-class population) + `stampGateVerdict`/sibling for real `active_positions_count` post-evaluate; drop `ACTIVE_POSITIONS_COUNT_DRY_RUN` | 1,2,3 |
| `apps/engine/`       | `book_snapshots` migration (nullable `event_id` + UNIQUE index, optional `mid_at_trigger`) + best-effort writer (spread/depth aggregates) + `SchemaValidationService` update | 4 |
| `apps/engine/`       | `DecisionRepository` Zod guard hard in **test/dev only** (inject `AppConfigService`/`NODE_ENV`), warn elsewhere | 5 |
| `apps/engine/`       | shadow orchestrator — populate `missedReason` (A0) | 6 |
| `apps/engine/` (tests) | decision-capture + gate-fingerprint + migration up/down specs (see QA wave) | QA |

Migrations present → **DB-safety wave applies** (dump-before-each-migrate; `decisions` and
`book_snapshots` are **separate** migration files). A dashboard surface is **optional/deferred** (A9);
acceptance is SQL/MCP. No new reject reason.

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

> **Shared-first, then engine, then QA — and split the engine work into ≤5-file dispatches.** This is
> the largest milestone of the arc (5 independent capture upgrades + migrations); do **not** dispatch
> all five at once.

1. **Serial — `bot-architect`**: lock the decision-row column set + names, the **on-row halt detail via
   `IRiskDecision.haltReasonDetail`** (A2, date-join dropped), the `book_snapshots` **additive `event_id`
   + UNIQUE index + optional `mid_at_trigger`, retention DEFERRED** (A5), the **spread/depth-aggregate**
   capture scope (A6), and the **post-evaluate `active_positions_count`** sourcing (A4). Record an ADR
   note that live `decisions` reach shadow parity and the change is **observability-only** (gate
   fingerprint unchanged, A7). Stub the retention-design follow-up as a separate item.
2. **Serial — `bot-shared-maintainer`**: add **only** the nullable `ISimulatedFill.missedReason` +
   `simulatedFillSchema` (A0). **No `marketSnapshotSchema` geometry keys** (A1). Single contract wave
   before the engine touches it.
3. **Serial — `bot-engine-nestjs`** (split into ≤5-file dispatches):
   - **Dispatch A (decisions schema):** `DecisionEntity` columns + migration (additive nullable);
     **pg_dump first**.
   - **Dispatch B (population):** `IRiskDecision.haltReasonDetail` from `RiskGateService`; decision
     writer signature + A8 row-class population; real `active_positions_count` post-evaluate (remove
     `ACTIVE_POSITIONS_COUNT_DRY_RUN`).
   - **Dispatch C (book snapshots):** migration (nullable `event_id` + UNIQUE index, optional
     `mid_at_trigger`) — **pg_dump first**; best-effort writer (spread/depth aggregates);
     `SchemaValidationService` update. No retention job.
   - **Dispatch D (Zod guard):** hard in **test/dev only**, warn in paper/testnet/live (A3).
   - **Dispatch E (shadow tag):** populate `missedReason` in the shadow orchestrator (A0).
4. **Serial — `bot-qa-engineer`**: paired tests per fix item —
   - **Trade geometry (A8):** approved open → `gate_allowed=true`, side, SL/TP (from `clampedExit`),
     qty/notional/leverage; gate reject → `gate_allowed=false` + reason; strategy skip → geometry NULL;
     correlated-loser row explicit.
   - **Halt leg (A2):** fresh `market_stress` reject → `halt_reason_detail` = gate's persisted suffix
     (breadth/btc_shock/multi…); already-halted-day → `state.today.haltReason`; matches `risk_state`;
     not re-derived.
   - **Real position count (A4):** non-zero when positions held, 0 when flat, tops at 3 (M25 ceiling);
     gate still sees pre-stamp count.
   - **Book rejoin (A5/A6):** written row joins decision by `event_id`; UNIQUE prevents dup; writer is
     best-effort (a write failure does not throw into the caller); spread/depth fields populated.
   - **Zod policy (A3):** malformed snapshot **throws in test/dev**, **warns in paper/testnet/live**;
     an approved paper open still emits `ORDER_INTENT_APPROVED_EVENT` under malformed capture.
   - **`missedReason` durable (A0):** shadow missing-tick fill carries `missedReason='missing_tick_data'`;
     price-not-touched carries `'price_not_touched'`.
   - **Behaviour unchanged (load-bearing, A7):** gate-fingerprint — fixed fixtures → identical
     `IRiskDecision` before/after M27.
   - **Migration reversibility:** `up`/`down` clean on the M16 test DB; old rows tolerate NULL geometry.
5. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   **`bot-review-quant`**. Security owns migration safety (additive/nullable, reversible, no destructive
   backfill; no PII in new columns) and the Zod policy (no order-path block). Logic owns the
   observability-only proof (gate fingerprint A7; halt detail read-not-recomputed A2; count post-evaluate
   A4; book writer best-effort A5). Quant owns analyzability: captured fields reconstruct intended trade
   + outcome + regime; halt-leg closes the date-join fuzziness; `missedReason` prevents survivorship bias.
   Cycle fix → re-review until zero blockers, zero highs, majority mediums.
6. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, CLAUDE.md status line,
   `docs/plans/00-overview.md` data-capture note, ADR link, and **`docs/tech-debt.md`**: close the
   data-capture-gap items M27 resolves (live trade geometry, halt leg, `active_positions_count`, live
   `book_snapshots` writer, hard Zod in test/dev, durable shadow `missedReason`) and add MEDIUM follow-ons
   for (a) *measured-slippage replacing the tier-constant* `estimated_slippage_pct` (M22 telemetry),
   (b) **`book_snapshots` retention design** (A5), and (c) optional **analysis-SDK/`IDecisionView`
   projection** of the new columns (A9). Record the dump paths and migrations applied.

Orchestrator verifies the actual diff after every wave and **explicitly confirms** (a) all migrations are
additive/nullable and reversible, (b) `ACTIVE_POSITIONS_COUNT_DRY_RUN` is gone and the count is sourced
post-evaluate, (c) the gate fingerprint is unchanged (observability-only), (d) `marketSnapshotSchema`
gained **no** geometry keys (A1), and (e) Zod hard-fail is test/dev-only (A3).

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M27 carries migrations — this is the milestone where #8/#9 matter most.**

- **Take a full `pg_dump` immediately before *each* migration** (schema dispatch A, and book-snapshot
  dispatch C if it migrates):
  `docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`.
  Show the user the dump path and get explicit confirmation **before** running the migration.
- **Prune `backup_` files to the 2 most recent** after each dump:
  `ls -t backups/backup_*.sql.gz | tail -n +3 | xargs rm -f`.
- **Additive/nullable only.** No `DROP`, no `TRUNCATE`, no `DELETE`, no `NOT NULL` backfill, no type
  change on existing columns, no `down -v`. The `down` migration drops only the **newly added**
  columns/indexes.
- **No destructive compose ops.** No `docker compose down -v`, no `docker volume rm`, no
  `docker system prune` against the soak DB.
- **Migration revert is forbidden on the live/paper soak** without explicit user confirmation in the
  same turn (CLAUDE.md hard rule #8). Validate `up`/`down` on the **test DB** (M16 ephemeral Postgres,
  port 6900) first.

## Post-deploy steps

1. Take `pg_dump` **before** the migration; show the user the path; get confirmation; prune to 2-deep.
2. Apply the migration; **engine restart**.
3. **10-min live smoke** per `feedback-milestone-app-smoke` — fix-and-report boot/migration errors
   before the scribe. Confirm the engine boots and stays running and the new columns exist.
4. **Capture confirmation (24–48h):** confirm live `decisions` rows now carry `gate_allowed`, side,
   SL/TP, qty/notional; `halt_reason_detail` resolves to the specific leg and matches `risk_state`;
   `active_positions_count` is non-zero when positions are held (≤3); `book_snapshots` rows are written
   and rejoinable by `event_id`; shadow fills carry `missedReason`. **Requires M24 fills + M25 approvals
   already deployed** (A-M6) — do not treat empty geometry on new opens as failure until those are live.
   Read-only DB querying.
5. **Behaviour-unchanged confirmation:** the **gate-fingerprint tests** (A7) are the primary proof. The
   funnel-mix comparison is secondary and **confounded if M25 deployed in the same window** — note that.
   Read-only.

## Verification

- **Unit:** decision-capture suites green; `src/strategy` + `src/risk` suites green; migration `up`/
  `down` green on the M16 test DB.
- **Geometry (top-level columns) + halt detail (gate-owned) + real count (post-evaluate) + book snapshot
  (event_id rejoin) + durable `missedReason`** all populated/rejoinable as specified.
- **`marketSnapshotSchema` unchanged** by geometry (A1); only `active_positions_count` value changes.
- **Zod hard in test/dev only, warn in paper/testnet/live** (A3); approved paper open still emits under
  malformed capture.
- **Behaviour unchanged (load-bearing):** gate-fingerprint identical before/after M27 (A7).
- **Book writer best-effort** — a persistence failure never throws into the trade loop (A5).
- **Migration safety:** additive/nullable, reversible, old rows tolerate NULL geometry; separate
  `decisions` and `book_snapshots` migrations; dump taken and pruned per #8/#9.
- **Boot:** engine boots and stays **running** post-migration; `SchemaValidationService` green.

## References

- Architect analysis (P5): [main-architector-paper-soak-fill-and-gate-analysis.md](../wip/main-architector-paper-soak-fill-and-gate-analysis.md) §4, §5 P5, §6 (DB safety)
- Independent reviews (2026-06-08, source of amendments A0–A9):
  [composer](../independent-analysis/composer/M27-decision-data-capture-completeness-review.md),
  [gbt](../independent-analysis/gbt/M27-decision-data-capture-completeness.md),
  [gemini](../independent-analysis/gemini/M27-decision-data-capture-completeness.md)
- Carry-in: M26 deferred the durable `ISimulatedFill.missedReason` field to M27 (A0)
- Risk management + halt legs: [docs/architecture/adr/0004-risk-management.md](../architecture/adr/0004-risk-management.md)
- Slippage-telemetry follow-on (measured vs tier-constant): [docs/plans/M22-depth-floor-recalibration.md](M22-depth-floor-recalibration.md) §Verification
- Produces the rows M27 annotates: M24 (paper fills), M26 (shadow fills); concurrency from M25
- Test-DB isolation for migration validation: [docs/plans/M16-test-db-isolation.md](M16-test-db-isolation.md)

### Key source files

| Concern | Path |
|---|---|
| Decision entity (schema change) | `apps/engine/src/strategy/entity/DecisionEntity.ts` |
| Shadow decision entity (parity target) | `apps/engine/src/strategy/entity/ShadowDecisionEntity.ts` |
| Decision writer + gate stamp (population) | `apps/engine/src/strategy/service/StrategyService.ts` (`gateAndPersist`/`stampGateVerdict`) |
| Snapshot mapper (`active_positions_count` fix) | `apps/engine/src/strategy/mapper/marketSnapshotMapper.ts` (`ACTIVE_POSITIONS_COUNT_DRY_RUN`) |
| Zod guard (test/dev-only hard-fail) | `apps/engine/src/strategy/repository/DecisionRepository.ts` |
| Market snapshot schema (NOT geometry, A1) | `packages/shared/src/schema/marketSnapshotSchema.ts` |
| Gate output (add `haltReasonDetail`, A2) | `apps/engine/src/risk/interface/IRiskDecision.ts`, `apps/engine/src/risk/service/RiskGateService.ts` (`buildPersistedHaltReason`) |
| Shadow fill contract (add `missedReason`, A0) | `packages/shared/src/interface/ISimulatedFill.ts`, `packages/shared/src/schema/simulatedFillSchema.ts` |
| Book snapshot entity + writer (A5/A6) | `apps/engine/src/market-data/entity/BookSnapshotEntity.ts`, `apps/engine/src/market-data/service/MarketDataPersistenceListener.ts` |
| Stress legs (halt-leg source) | `apps/engine/src/risk/service/StressHaltEvaluator.ts` (`classifyHaltLeg`) |
| Risk state (already-halted-day halt reason) | `apps/engine/src/risk/` (risk_state entity) |
