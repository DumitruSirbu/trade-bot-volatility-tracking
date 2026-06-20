# 2026-06-19 — Decisions OPEN badge vs empty Positions tab

**Date:** 2026-06-19  
**Author:** main session (operator dashboard report)  
**Status:** **Resolved** — M42 (stale-tick fills) + M41 (outcome UX + audit cashflow) shipped 2026-06-19.

---

## Report

Operator saw green **OPEN** actions in the Decisions tab while the Positions tab showed no open
positions (Closed sub-tab, Open Exposure 0.00).

## Findings

| # | Cause | Severity | Resolution |
|---|-------|----------|------------|
| 1 | `decisions.action=open` is **intent**, not outcome; risk rejects (`no_eligible_slot`, `tp_below_cost`) still show green OPEN | MEDIUM (UX) | **M41 D1 DONE** — `DecisionOutcomeEnum` + dashboard Outcome column |
| 2 | Gate-approved opens missed fill when WS tick cache was ~26 min stale (`StreamingFillAdapter` > 5s threshold) | HIGH (paper) | **M42 DONE** — REST `fetchTickers` refresh at fill time |
| 3 | `recordZeroFillAuditRow` omits `cashflow` → NOT NULL violation on no-fill audit insert | MEDIUM (audit) | **M41 D2 DONE** — `cashflow: new Money(0)` |

### DB evidence (2026-06-19 14:05 UTC)

```text
ALGO  open  no_eligible_slot   gate_allowed=false  → no position (expected)
AVAX  open  no_eligible_slot   gate_allowed=false  → no position (expected)
OP    open  momentum_follow    gate_allowed=true   position_id=null (bug → M42)
UNI   open  momentum_follow    gate_allowed=true   position_id=null (bug → M42)
```

## Code shipped (M42)

- `PaperFillSimulator.ensureFreshTickCache()`
- `MarketDataService.onPaperTickRefreshRequest`
- `PAPER_TICK_REFRESH_REQUEST` event + `IPaperTickRefreshRequest`

See [M42 milestone outcome](../../milestone-log/archive/M42.md).

## Code shipped (M41)

- `packages/shared` — `DecisionOutcomeEnum`, `mapDecisionOutcome()`, `IDecisionView.outcome`
- `readApiMappers.mapDecision` + analysis `getDecisions` (`gate_allowed` in SQL)
- `DecisionsFeed` — Outcome column + filter; Action badge no longer all-green for OPEN
- `ExecutionService.recordZeroFillAuditRow` — `cashflow: new Money(0)`

See [M41 milestone outcome](../../milestone-log/archive/M41.md).
