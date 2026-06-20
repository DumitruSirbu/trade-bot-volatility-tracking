# M41 — Decisions feed outcome clarity + zero-fill audit fix

> **Status: DONE (2026-06-19).** Outcome: [`docs/milestone-log/archive/M41.md`](../../milestone-log/archive/M41.md)

> **Sequencing note:** M41 is a **paper-soak UX + audit-integrity** milestone surfaced by the
> 2026-06-19 operator report: Decisions showed green **OPEN** while Positions stayed empty.
> Investigation confirmed distinct causes — misleading decision labels (risk rejects still show
> `action=open`) and a zero-fill audit insert failure (`cashflow` NOT NULL).
> **Paper stale-tick fill recovery is M42** (shipped 2026-06-19); this plan covered the remaining items.

## Findings → scope decision (at a glance)

| # | Finding | Severity | M41 scope |
|---|---------|----------|-----------|
| 1 | Decisions **Action** column shows green OPEN for risk-rejected rows (`no_eligible_slot`, `tp_below_cost`, …) | **MEDIUM (UX)** | **D1 — SHIPPED.** |
| 2 | Paper fills fail when WS tick cache is stale at execution time | **HIGH (paper soak)** | **Out → M42** ([plan](M42-paper-stale-tick-rest-refresh.md), [outcome](../../milestone-log/archive/M42.md), DONE). |
| 3 | Zero-fill audit row insert fails: `null value in column "cashflow"` on `transactions` | **MEDIUM (audit)** | **D2 — SHIPPED.** `cashflow: new Money(0)` in `recordZeroFillAuditRow`. |

### Production evidence (2026-06-19 14:05 UTC)

```text
symbol          action  reason           gate_allowed  position_id
ALGO/USDT:USDT  open    no_eligible_slot  false        null
UNI/USDT:USDT   open    momentum_follow   true         null   ← stale tick (M42)
OP/USDT:USDT    open    momentum_follow   true         null   ← stale tick (M42)
```

---

## D1 (MEDIUM) — Decisions feed shows outcome, not intent alone — SHIPPED

### Problem

`decisions.action` stores the **intent action** at persistence time (`open` even when
`gate_allowed=false`). The dashboard mapped that to a green **OPEN** badge with tooltip text
"New position opened" — false for every risk reject and every approved-but-unfilled row.

### Decision

Extended the read API contract (shared) with an explicit **outcome** dimension:

| Outcome | Rule |
|---------|------|
| `skipped` | `action === skip` |
| `rejected` | `action === open` and `gate_allowed === false` |
| `approved` | `action === open` and `gate_allowed === true` and `position_id` is null |
| `filled` | `position_id` is not null |

### Files shipped

1. `packages/shared` — `DecisionOutcomeEnum`, `mapDecisionOutcome()`, `IDecisionView.outcome`
2. `apps/engine/src/read-api/mappers/readApiMappers.ts` — `mapDecision()` wires outcome
3. `packages/analysis/src/query/getDecisions.ts` — `gate_allowed` in SQL + outcome
4. `apps/dashboard/src/views/DecisionsFeed.tsx` — Outcome column, filter, tooltips

---

## D2 (MEDIUM) — Zero-fill audit `cashflow` NOT NULL violation — SHIPPED

`ExecutionService.recordZeroFillAuditRow` now sets `cashflow: new Money(0)` on zero-qty audit rows.

---

## Out of scope (unchanged)

- Changing persistence of `decisions.action` for rejects (would break funnel SQL).
- Stale-tick recovery (M42).
- M40 halt-exempt / shadow fill work (separate milestone).

## Implementation log (for reviewers)

| File | Change |
|------|--------|
| `packages/shared/src/enum/DecisionOutcomeEnum.ts` | New enum |
| `packages/shared/src/util/mapDecisionOutcome.ts` | Pure mapper (shared by engine + analysis) |
| `packages/shared/src/interface/IDecisionView.ts` | `outcome` field |
| `apps/engine/src/read-api/mappers/readApiMappers.ts` | `DECISION_VIEW_KEYS` + `mapDecision` |
| `apps/engine/src/execution/service/ExecutionService.ts` | D2 only: `cashflow` on zero-fill audit |
| `apps/dashboard/src/views/DecisionsFeed.tsx` | Outcome column UI |
| Tests | shared, read-api, ExecutionServiceDelta, DecisionsFeed, getDecisions |
