## 2026-06-18 — M40 D2.0 — shadow fill mechanism investigation

**Goal (investigation-only, no fix code):** confirm the exact mechanism behind `shadow_decisions.simulated_fill`
collapsing to ~0/day since ~June 10. The M40 plan §D2 listed three candidates: (a) signal-bar ticks absent
at event time [leading], (b) tick-aggregate partition/retention, (c) deferred-walk durability.

**Confirmed mechanism: NONE of (a)/(b)/(c). A fourth, previously-unidentified mechanism — the shadow
stop-side validation guard (`isStopSideValid`, `ShadowStrategyOrchestratorService.ts:392/961`) rejects the
open because the strategy's stop is computed against a DIFFERENT entry reference than the one the shadow
validates against.**

### The collapse (DB, soak `shadow_decisions`)

Daily gate-allowed OPEN rows vs rows with a populated `simulated_fill`:

| day | gate_open | with_fill |
|-----|-----------|-----------|
| 06-05 | 140 | 134 |
| 06-06 | 104 | 97 |
| 06-07 | 164 | 150 |
| 06-08 | 106 | 96 |
| 06-09 | 56 | 53 |
| 06-10 | 0 | 0 |
| 06-11 | 3 | 3 |
| 06-12–13 | 0 | 0 |
| 06-14 | 11 | **0** |
| 06-15 | 73 | **0** |
| 06-16 | 25 | **1** |
| 06-17 | 61 | **0** |
| 06-18 | 18 | **0** |

From 06-14 onward gate-open volume recovered (11/73/25/61/18) but populated fills stayed ~0. All 187 unfilled
gate-open rows since 06-10 are **v1 only** (the active `volatility-vwap:1`, mean_reversion); v0/v2/v3 have zero
gate-allowed opens under the restricted shadow profile, so the regression is entirely in the active version's
shadow series.

### Mechanism (b) — RULED OUT

All daily `tick_aggregates` partitions for `p20260610` … `p20260619` exist and are queryable (`pg_class`).
No dropped/missing partition.

### Mechanism (a) — RULED OUT (this was the plan's leading hypothesis; it is wrong)

Decisive DB join: for all 187 gate-open-no-fill rows since 06-10, the signal-bar `tick_aggregates` over the
half-open window `[barOpen, barOpen+5m)` (parsing `barOpen` as the trailing numeric segment of `event_id`):
**187 / 187 have signal-bar ticks PRESENT, 0 absent.** So `loadTicksForBar` returns rows and
`evidence.nextBarOpenPrice` is non-null — the "no next-bar evidence" decline path is never taken.

Decisive log evidence (engine log level = `debug`, confirmed; 25,422 debug lines emitted in window, so debug
logging is live, not suppressed). Over the 168h Docker retention window:
- `no tick_aggregates for signal bar` (`loadSignalBarEvidence`, `:267`): **0 occurrences**
- `no next-bar open (no signal-bar ticks)` (`:370`): **0 occurrences**
- `invalid stop-loss side — skipping open` (`:393`): **79 occurrences**
- `deferred walk completed` / `deferred walk failed`: **0 / 0**

### Mechanism (c) — DOES NOT CONTRIBUTE MATERIALLY

There are no force_close-only / present-but-W1-only rows in the regression window — the unfilled rows are
**truly absent** (`simulated_fill IS NULL`), not present-but-not-upgraded. `with_fill` ≈ 0 means there is no
synchronous W1 fill to later upgrade, so deferred-walk durability cannot be the gap. (`deferred walk completed`
= 0 in the window is consistent: nothing reached the deferred queue because nothing produced a W1 force_close
fill in the first place.)

### Confirmed mechanism — shadow stop-side guard rejects on an entry-reference mismatch

`runOneShadow` validates the strategy's stop against the **tick-derived** shadow entry
(`evidence.nextBarOpenPrice` = signal-bar last-tick close, `:275/:382`) via
`isStopSideValid(tradeSide, entryPriceStr, stopLossStr)` (`:392`). When the check fails it logs the WARN and
takes the branch that leaves `openData = null` (it never enters the `else` that builds the fill), so
`persistShadowDecision` writes `simulatedFill: openData?.simulatedFill ?? null` = **null** (`:770`).

The stop itself is computed by the active mean-reversion strategy against a DIFFERENT reference:
`meanReversionCore.buildMeanReversionExit` → `computeStructuralStop(tradeSide, reconstructReferencePrice(event), …)`
(`meanReversionCore.ts:134-140`). `reconstructReferencePrice` = `vwapSession × (1 + vwapDeviationPct/100)`
(`entryHelpers.ts:42`) — the **live event-derived** reference, NOT the tick-derived signal-bar close. The
structural stop sits tight to that live reference; when the tick-derived `nextBarOpenPrice` diverges enough to
land on the wrong side of the stop, `isStopSideValid` rejects.

Every sampled WARN line confirms a wrong-side stop, e.g. `side:long entry:0.6805 stopLoss:0.68835` (stop ~1.15%
ABOVE entry — invalid for a LONG; a long's stop must be below entry). The 79 logged rejections split 45 long /
34 short, matching the unfilled-row direction split (113 long / 74 short across the longer DB window). This is
the asymmetry HIGH-1 in §D2 already flagged: the shadow path is the only synchronous tick consumer, so it is the
only path where the tick-derived entry can disagree with the strategy's `reconstructReferencePrice`-anchored stop.

### Why ~June 10 (regression onset)

M38's exit-geometry repair tightened the mean-reversion structural stop so it sits very close to
`reconstructReferencePrice`. With the stop hugging the live reference, even a small divergence between the live
reference and the tick-derived `nextBarOpenPrice` now flips the stop to the wrong side of the shadow entry —
turning what used to be valid opens into `isStopSideValid` rejections. The June 10–13 gate-open drought
(0–3/day) is a separate, lower-volume window; the clean signal is 06-14 onward where gate-open volume returned
but fills did not.

### Recommended fix shape (per §D2; final scope is the impl brief's call)

The defect is an **entry-reference inconsistency inside the shadow path**, not a tick flush-timing/ordering gap
and not partition/durability. The fix must keep the shadow entry **tick-derived** (HIGH-1 / B4: do NOT substitute
`reconstructReferencePrice` — that would restate the live decision as the counterfactual fill and risk
look-ahead). Two consistent remedies:

1. **(preferred) Validate the stop-side against the same reference the stop was geometrically drawn from, then
   keep the tick-derived `nextBarOpenPrice` as the fill entry.** The stop-side invariant is a property of the
   strategy's `(reference, stop)` pair (`reconstructReferencePrice` vs `proposedExit.stopLossPrice`), which the
   strategy already guarantees by construction (`meanReversionCore` draws the stop on the correct side of its own
   reference and additionally guards `isDegenerateReversionGeometry`). Validating that pre-built stop against a
   *different* (tick-derived) entry is the bug. The shadow should accept the strategy's stop and fill at the
   tick-derived next-bar open, letting the intrabar walk decide sl/tp/time_stop/force_close honestly. (A
   genuinely malformed strategy stop is still caught at the strategy / `reconstructReferencePrice` level; the
   shadow guard is double-validating against the wrong anchor.)
2. **(alternative, more conservative)** keep the guard but re-anchor the stop *distance* onto the tick-derived
   entry the same way the live executor's TP-rebase does (M38 D1 `rebaseMomentumTakeProfit` pattern) — carry the
   stop distance and re-apply it on the correct side of `nextBarOpenPrice`. This preserves the guard's
   malformed-strategy protection while removing the reference mismatch. Mean-reversion stops are structural (not
   ATR-distance: `atrDistance:null`, `tpRebaseEligible:false`), so a distance-rebase here needs its own
   derivation and is the heavier change.

Mechanism is purely a shadow-path validation/anchoring bug; no live trade path is touched, determinism holds
(entry stays tick-derived, no `Date.now()`), and the shadow run stays fire-and-forget. **No ADR 0029 timing
amendment is needed** (this is not a flush-timing contract change) — architect to confirm, but the evidence
points to a pure shadow-guard anchoring fix in `ShadowStrategyOrchestratorService`.

**B5 caveat for re-qualification:** the prod-verification gate must still confirm a non-degenerate `close_reason`
distribution after the fix (not ~100% force_close) AND that the deferred-walk upgrade lands — mechanism (c) was
not exercised in this window only because there were no W1 fills to upgrade; once fills are produced again, (c)'s
durability must be re-checked against B3/B5.
