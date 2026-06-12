# ADR 0016 — Strategy version lineage & promotion model (M8)

**Status:** Accepted (M8 design wave)
**Date:** 2026-05-24
**Milestone:** M8 — Strategy versioning & comparison
**Depends on:** ADR 0003 (strategy engine), ADR 0015 (backtest module).
**Related:** `docs/plans/archive/M8-versioning-comparison.md`, `docs/plans/00-overview.md` (Locked decisions § Signal direction).

## 1. Context

`strategy_versions` already exists from M2/M3 with the columns M8 needs:
`id`, `name`, `version`, `direction`, `params jsonb`, `status (draft|active|archived)`,
`parent_version_id (fk→self, ON DELETE SET NULL)`, `created_at`. The live engine
resolves the *active* row via `StrategyRegistry` keyed on `name:version`, and
backtest replays accept the same row through `IBacktestConfig`.

What is missing for M8 is the **lineage and promotion mechanism**: how a candidate
becomes `active`, how rollback works, how more than one row can be evaluated
side-by-side without disturbing live, and how lineage is auditable.

Key constraints:
- **Reversible.** Archive ≠ delete. A regression must be one row update away.
- **Exactly one `active` per `name` at a time.** Live reads a single row.
- **No live disruption during comparison.** Candidate rows must coexist as
  `draft` while M8 evaluates them.
- **Auditable.** Every promotion writes who/when/why and which comparison report
  produced the decision.

## 2. Decision

### 2.1 Schema delta (additive only; the column set is already correct)

A single forward migration `<timestamp>-AddStrategyPromotionAudit.ts` adds:

```text
ALTER TABLE strategy_versions
  ADD COLUMN promoted_at  timestamptz NULL,
  ADD COLUMN archived_at  timestamptz NULL,
  ADD COLUMN promotion_report_id integer NULL,         -- fk → comparison_reports.id, ON DELETE SET NULL
  ADD COLUMN promotion_note text NULL;

-- Enforce the "exactly one ACTIVE per name" invariant at the DB level.
CREATE UNIQUE INDEX uq_strategy_versions_active_per_name
  ON strategy_versions (name)
  WHERE status = 'active';
```

The existing `StrategyStatusEnum ∈ {draft, active, archived}` is unchanged.
`parent_version_id` already exists. `params jsonb` already carries the per-version
config the registry validates against `strategyParamsSchema`.

### 2.2 Promotion state machine

```text
            (create / clone-from-parent)
                       │
                       ▼
                    [DRAFT]
                       │
                       │  promote(report_id, note)
                       │  -- gate-check passes (ADR 0019)
                       ▼
                    [ACTIVE]
                       │
                       │  archive(reason)
                       │  -- or another DRAFT promoted in its place
                       ▼
                   [ARCHIVED]
                       │
                       │  reactivate()   -- explicit, operator-driven
                       └──▶ [ACTIVE]     -- archive_at cleared, promoted_at refreshed
```

Transitions:

| From | To | Allowed when |
|---|---|---|
| (create) | `draft` | always |
| `draft` | `active` | promotion gate (ADR 0019) green; in same TX archive the current `active` row for that `name` |
| `active` | `archived` | another row of the same `name` is being promoted, or operator-initiated rollback |
| `archived` | `active` | operator-initiated rollback; existing `active` row (if any) auto-archived in same TX |
| any | (delete) | **forbidden in code.** History stays. `SET NULL` on `parent_version_id` handles a hypothetical manual purge but the application never deletes |

`PromotionService.promote(versionId, reportId, note)` runs as a **single
serializable transaction**:
1. `SELECT ... FOR UPDATE` the target row and the current `active` row (if any) for that `name`.
2. Validate target is in `draft`; validate `reportId` row references a comparison whose `decision === 'promote'` for this version.
3. Update current `active` (if any) → `status='archived', archived_at=now()`.
4. Update target → `status='active', promoted_at=now(), promotion_report_id=?, promotion_note=?`.
5. Commit. The partial unique index ensures the DB rejects any state where two rows are simultaneously `active` for the same `name`.

### 2.3 Lineage

`parent_version_id` is **mandatory for any new row except the initial seeds** (v0
baseline rows have `NULL` parent). Cloning a strategy for tuning copies the
parent's `params jsonb` and stamps `parent_version_id = parent.id`. A
`StrategyLineageView` (read-side, no schema) walks the chain so the M8 comparison
report can render "v1.4 ← v1.3 ← v1.2 ← v1.0".

### 2.4 Live read path

`StrategyService` continues to resolve the active strategy at boot via
`StrategyVersionRepository.findActive(name)`. M8 adds no new read path on the hot
loop — promotion is a one-row state change picked up at the next strategy reload
(boot, hot-reload signal, or restart). **Mid-session promotion is intentionally
not supported**: switching strategies on a running engine would mean two indicator
states, two reservation ledgers, and ambiguous in-flight events; an operator
promotes, then bounces the engine.

## 3. Consequences

**Positive**
- Reversible promotion: `reactivate(archived_id)` flips a row back to live in one TX.
- DB-enforced "one active per name" — no application-layer race window.
- Lineage is queryable for retrospectives and report rendering.
- Audit trail (`promoted_at`, `archived_at`, `promotion_report_id`, `promotion_note`) lives on the row, not in a separate log.

**Negative**
- Promotion requires an engine restart for the live read path; documented in the M8 runbook.
- A future "multi-active per name" experiment (A/B at the engine level) is out of scope and would require revisiting the partial unique index.

## 4. Alternatives considered

1. **Single boolean `active` column.** Rejected — the enum already exists; a
   parallel boolean duplicates state and introduces drift risk.
2. **Promotion via a separate `strategy_active` pointer table.** Rejected — adds
   a join on the live boot path for no win; the partial unique index achieves
   the same invariant with one column.
3. **Soft-delete via `deleted_at` instead of `archived`.** Rejected — `archived`
   is semantically different from "deleted." An archived row is still a valid
   target for `reactivate`.
4. **Mid-session hot-swap of the active strategy.** Rejected for M8 — see §2.4.
   The complexity (drain in-flight events, re-seed indicator state on the new
   strategy's params, reservation handover) does not pay back for a comparison
   tool that runs offline.
5. **Hard-delete archived rows after N days.** Rejected — history is cheap;
   regression analysis a year later still wants the row.

## 5. Open questions (resolved before W1)

- **Who can promote?** For M8 the CLI is the only caller; M11 (go-live hardening)
  will add an operator audit identity. The `promotion_note` column accepts a free-text
  reason now so the schema is forward-compatible.
- **Are seed v0/v1/v2/v3 rows in M3 retroactively given `parent_version_id`?**
  No — they are roots. New rows after M8 W1 must set a parent.
