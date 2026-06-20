# M37 — Strategy-comparison infrastructure (fix the measurement instruments: expose existing shadow data to the comparison layer, repair the hollow shadow fill simulator, backtest fill restoration, trade-record integrity)

> **Sequencing note:** M37 is an **instrumentation-and-integrity** milestone, not a strategy-tuning one.
> The bot currently cannot *display* a same-event comparison of its strategy versions (v0 baseline /
> v1 reversion / v2 momentum / v3 hybrid) — **not** because shadow evaluation is missing, but because the
> **analysis read layer never reads the table the shadow data already lands in** AND because the
> **shadow fill simulator that table feeds is producing hollow, PnL-less fills**. Concurrent same-event
> shadow evaluation is already running in production (`ShadowStrategyOrchestratorService.runShadows`
> writes one row per version per event into `shadow_decisions`, sharing a single `event_id`) — but a
> direct content inspection of the `simulated_fill` JSONB (2026-06-15) shows **~99% of those fills are
> `missed:true` with `entryPrice:"0"`, no `exitPrice`, no `closeReason`, and `lowFidelity:true`** (v2:
> 841 of 844 missed; v3: 177 of 179 missed). **The same-event DECISION coverage exists; the
> counterfactual OUTCOME (realized PnL) does not** — so exposing the table to the comparison layer alone
> yields nothing to compare. The three real measurement defects are: (1) the comparison queries
> (`compareVersions`, `getPerformance`) read only `decisions`/`positions` and never touch
> `shadow_decisions`, plus a 6-day v1 shadow-logging blackout and an active-vs-shadow double-count hazard
> — AND the shadow fill simulator writes hollow `missed` fills with no realized counterfactual PnL; and
> (2) the backtest produces **zero fills** for every version (the offline measurement device is dead). On
> top of that, trade-record integrity defects (mislabeled exits, an exit-enforcement breach) are
> contaminating the only live sample we have. M37 repairs all three so that a future strategy switch can be
> made on evidence. It is a **prerequisite** to ever changing the active strategy — M37 does **not** switch
> it. Every change preserves the trading-safety invariants in `CLAUDE.md`: **no order path bypasses the
> risk gate**, **strategies stay pure/deterministic** (ADR 0029, 0032 live/backtest parity), **money is
> `decimal`**, and — load-bearing for this milestone — **no shadow version can place an order** (preserved
> as a *regression guard on the existing orchestrator separation*, not as a constraint on a new evaluation
> loop). The shadow fill simulator repaired in W1 is a **VIRTUAL ledger — counterfactual only, never a
> live order** (ADR 0029 §2.1 sovereign per-version ledgers).

## Context

Strategy selection is supposed to rest on two measurement channels. As of the live soak DB
(queried directly on 2026-06-15) and the backtest reports inspected the same day, **the comparison
*read* layer, the shadow fill simulator, and the backtest are broken** — but, crucially, **concurrent
shadow evaluation itself is already running**. The same-event DECISION data the comparison needs **exists**
(2,441 shared `event_id`s; a full v0 skip baseline). What does **NOT** exist is the counterfactual
OUTCOME: a direct content check of `shadow_decisions.simulated_fill` shows ~99% of fills are hollow
(`missed:true`, `entryPrice:"0"`, no `exitPrice`/`closeReason`, all `lowFidelity:true`), so there is no
realized counterfactual PnL to compare even after the read layer is wired up.

> **Motivating example (OUT OF SCOPE for M37 — explains WHY the instruments must be repaired first).**
> This is the kind of question the repaired instruments must be able to answer; **M37 does not act on it,
> changes no strategy logic, and switches nothing.** From the live v2 momentum sample (24 trades): **76%
> of total loss (−20.17 of −26.55 USDT) came from just 5 `catalyst_risk` SHORT trades that went 0-for-5**
> (MFE ~0.75 bps — price barely moved in favor before reversing). Momentum is *following* liquidation-driven
> dumps to the short side and getting bounced on the reversion. Winners had HIGHER deviation (2.08σ vs
> 1.42σ) and HIGHER signal score (68 vs 52) — so this is a **flow/direction-selection** issue, not entry
> latency. The hypothesis (FADE `catalyst_risk` rather than follow it — exactly what v3 hybrid / v1
> reversion are designed to do) **cannot be tested today** precisely because all three instruments are
> dead: backtest 0-fills, shadow counterfactuals ~99% hollow, and the analysis layer never reads the shadow
> table. That is **WHY M37 (instruments) must precede any direction change** — and the direction change
> itself is a **SEPARATE FUTURE MILESTONE**, gated on M37's data plus the ADR 0019 promotion gate. The
> sample is **n=5 — below the noise floor — so it is explicitly NOT actionable now.**

### Strategy version registry (for reference, verified against the soak DB)

Two tables hold decision data: the **active** version writes to `decisions`; every **shadow**-status
version writes to a separate table, `shadow_decisions`. The two share `event_id` (the same id allocated
once per live event is threaded into every shadow row). Verified counts:

| `strategy_versions.id` | Version | Status | `decisions` (active stream) | `shadow_decisions` (shadow stream) |
|---|---|---|---|---|
| 1 | v0 baseline (`trade_enabled:false`) | `shadow` | — | **2442 skip, 0 open, 0 sim-fills, May 30 → Jun 15 (FULL skip baseline EXISTS)** |
| 2 | v1 reversion | `shadow` | active May 30 → Jun 8 | **83 rows (26 open / 57 skip), Jun 14 → 15 ONLY — 6-day blackout** |
| 3 | v2 momentum | **active** | active since Jun 8 (the only version that has traded live) | 2359 rows (1235 open / 1124 skip), 844 sim-fill rows but **841 `missed:true` (HOLLOW)**, May 30 → Jun 14 (also shadowed) |
| 4 | v3 hybrid router | `shadow` | — | 2442 rows (428 open / 2014 skip), 179 sim-fill rows but **177 `missed:true` (HOLLOW)**, May 30 → Jun 15 (FULL) |
| 5 | manual_adopted | draft | — | — |

`shadow_decisions` shares **2,441 `event_id`s** with `decisions` — same-event evaluation is already
happening, so the same-event **DECISION** coverage exists. The table already carries the counterfactual
`simulated_fill` and `virtual_slot_state_snapshot` columns (ADR 0029) — but a direct content inspection
of those `simulated_fill` JSONB blobs (2026-06-15) shows the **OUTCOME** data does **NOT** exist yet:

| version | sim-fill rows | `missed:true` | has entry/exit price | has closeReason | `lowFidelity` |
|---|---|---|---|---|---|
| v2 momentum (id=3) | 844 | **841** | 0 | 0 | 844 (all) |
| v3 hybrid (id=4) | 179 | **177** | 0 | 0 | 179 (all) |

A representative `simulated_fill` is
`{"missed":true,"entryPrice":"0","exitPrice":null,"closeReason":null,"lowFidelity":true,"slippageEntryPct":"0",...}`.
So ~99% of "sim-fills" are **hollow**: no entry/exit price, no close reason, no realized PnL. The shadow
fill simulator records *decisions* but computes essentially **zero counterfactual PnL** — exposing these
rows to the comparison layer yields nothing to compare. **The counterfactual FILL/PnL data does not exist
yet and must be produced (W1, D1.6); the same-event DECISION coverage and v0 skip baseline do exist.**
`shadow_decisions` has `UNIQUE(shadow_version, event_id)`; `decisions` has no per-event uniqueness. **The
schema already supports one-row-per-version-per-event — no migration is needed for cardinality.**

### Problem 1 (PRIMARY) — the comparison read layer never reads `shadow_decisions`; the shadow fill simulator produces hollow PnL-less fills; plus a v1 blackout and an active-vs-shadow double-count hazard

The original premise that "shadow evaluation is not running" was **refuted by direct DB inspection**.
Shadow evaluation IS running and IS concurrent: `ShadowStrategyOrchestratorService.runShadows`
(`apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts`) iterates every active+shadow
version per event and writes one `shadow_decisions` row per version per event, all sharing the single
`event.eventId` allocated once at the live trigger. The disjoint v1→v2 window previously seen in
`decisions` is **only the active-version flip on Jun 8** (v1 active May 30→Jun 8, v2 active since) — it is
the *active stream*, not a concurrency failure. The real defects are:

- **D-real-1 — Read-layer gap (the actual W1).** `compareVersions.ts` and `getPerformance.ts` read
  **only** `decisions`/`positions`; neither ever reads `shadow_decisions`. That is why same-event
  comparison returns nothing despite the data existing. The fix lives in `packages/analysis/` (a
  UNION / reconciling view over `decisions` + `shadow_decisions` on `event_id`, or a dedicated comparison
  view) — **not** in engine evaluation topology, which already produces the rows.
- **D-real-2 — v1 6-day shadow blackout (verified).** v1 (`id=2`) has **zero rows in either table**
  Jun 8 → Jun 14, then shadow-logging starts Jun 14. It went inactive Jun 8 but did not begin
  shadow-logging until Jun 14 — most likely its `status` was not set to `shadow` (or it was archived /
  re-added) for 6 days. This is the genuine version-specific data gap: a version flipped off `active` must
  immediately continue as `shadow` with **no logging gap**.
- **D-real-3 — Active-vs-shadow double-count hazard.** v2 (active since Jun 8) ALSO has
  `shadow_decisions` rows through Jun 14. Any reconciliation across the two tables must **not** double-count
  v2 (once as active in `decisions`/`positions`, once in `shadow_decisions`). A precedence rule is
  required: for the **active** version use `decisions`/`positions`; for **shadow-status** versions use
  `shadow_decisions`.
- **D-real-4 — Hollow shadow fills: the simulator computes no counterfactual PnL (NEW, verified
  2026-06-15).** A direct content check of `shadow_decisions.simulated_fill` shows **~99% are
  `missed:true`** with `entryPrice:"0"`, no `exitPrice`, no `closeReason`, all `lowFidelity:true` (v2:
  841/844; v3: 177/179). The shadow fill simulator (`VirtualPositionLedgerService` + the
  `ShadowStrategyOrchestratorService.simulateShadowFill` pipeline, ADR 0029 §2.3 + M26 amendment) records
  the *decision* but produces **no realized counterfactual outcome** — so the read-layer union (D-real-1)
  would expose rows with nothing to compare. This is a content defect, not a cardinality or read-layer one:
  a shadow `open` decision that the simulator accepts must carry a populated `entryPrice`, an exit (via the
  **same version's own exit policy on FORWARD bars only**), a `closeReason`, and a realized counterfactual
  PnL — subject to the look-ahead-safe estimator already specified in W4/D4.2 (entry at decision-close,
  forward-only exit, no future-extremum fill). The engine must **root-cause WHY ~99% miss** before
  changing fill logic — candidate causes: a limit-fill model that almost never fills, the M26 next-bar
  alignment declining when no next bar exists, or the `lowFidelity` path short-circuiting before computing
  an exit (ADR 0029 M26 notes close-side still resolves at the `reconstructReferencePrice` low-fidelity
  proxy). **This is a VIRTUAL ledger — counterfactual only, never a live order.**

The fix has two parts. The **read-mostly + decision-only** part: expose existing `shadow_decisions` data
to the comparison layer (analysis change), close the v1 status-transition logging gap (engine change), and
define the active-vs-shadow dedup/precedence rule. The **engine content-fix** part (D-real-4): repair the
shadow fill simulator so accepted `open` counterfactuals carry entry/exit/closeReason/realized PnL instead
of hollow `missed`. **Shadow evaluation must STAY in
`ShadowStrategyOrchestratorService`** — its own orchestrator, its own virtual ledger, never touching
`RiskGateService`. The "no shadow version can place an order" invariant is preserved as a **regression
guard on this existing separation**, not as a constraint on any new loop. **Do NOT fold shadow versions
into `StrategyService`'s gated per-event loop** — that is the only live-order path, and merging shadows
into it would risk the HARD invariant.

### Problem 2 — backtest produces ZERO fills for every version (measurement device dead)

The three backtest reports in `reports/backtest/` —
`v2-20260609-20260613.json`, `v3-20260530-20260614.json`, `v4-20260609-20260613.json` — all have
`tradeCount: 0`. In every run **every candidate that survives the signal stage is then rejected by the
gate** (`tradeCount: 0`) → the backtest risk gate rejects **100%** of everything the signal stage passes.
Live, the same gate passes roughly **~7% of open-intents** (post-signal-stage candidates). **A gate that
approves ~7% live and 0% in backtest is not the same gate** — which breaks the live/backtest parity
contract (`docs/architecture/live-vs-backtest-contract.md`, ADR 0015). Note the two rates must be
compared on the **same denominator** — approvals over **open-intents** (post-gate-eligible candidates),
**not** approvals over total events, because the live ~7% and the backtest 0% were originally measured on
different denominators (see D2.5).

- **Documented cause:** the backtest cannot reconstruct `book_snapshots` / liquidation-distance / depth,
  so liquidation- and depth-dependent gate checks (e.g. `sl_outside_liquidation`) hard-reject every
  candidate.
- M37 must make the backtest produce **realistic fills** again: either feed captured `book_snapshots`
  into the replay, **or** define a documented **relaxed/fallback** liquidation+depth check the backtest
  uses when live book data is unavailable — with the fallback **clearly flagged** so backtest fills are
  never confused with live fidelity. The live-vs-backtest contract must be made explicit about **which
  gate checks are reconstructable and which are approximated**.

### Problem 3 — trade-record integrity defects contaminating the live sample (≥6 of 24 trades)

These corrupt win/loss attribution and expectancy and must be diagnosed and fixed (or explicitly
scoped):

- **3 positions** with `exit_reason=take_profit` but **negative** `realized_pnl`, 0-min hold, MFE 0.00
  (EDGE −1.32, ZEC −0.48, ALLO −0.26). A profit-taking exit that loses money instantly is a **mislabeled
  exit**. These were **v2 momentum** trades. Note the M35 degenerate-geometry guard is
  **mean-reversion-only** and only produces a **SKIP** — it cannot write a `take_profit`, and momentum has
  **no** degenerate-geometry guard. The `take_profit` label is written by `LocalProtectiveMonitor` on a TP
  breach. The most likely cause is that the **momentum TP is computed off a bar-close reference rather than
  the actual next-bar entry fill**, so the entry fills at/past TP and the monitor fires TP immediately
  (0-min hold, MFE 0.00). M37 must re-aim at this momentum exit-geometry vs actual entry-fill price and
  `LocalProtectiveMonitor.evaluateBreach` arming-tick behavior, and at the momentum-vs-v1 missing-guard
  asymmetry.
- **1 position** `exit_reason=time_stop` at **127-min** hold while `time_stop_minutes=15` (MRVL) — an
  **exit-enforcement breach**; M33 ("live exit enforcement") was supposed to cover this path. The most
  likely missed cause: `PositionTimeStopEnforcer` is **event-driven off `price.update`** — if no tick
  arrives for the symbol (thin tier-2 / stalled feed), the deadline never fires.
- **2 `manual` exits** (OPN 75 min, AMD) — establish whether manual intervention actually occurred and
  whether these should be **excluded** from strategy expectancy.

### Supporting live evidence (motivation only — not a verdict on momentum)

Live momentum (24 closed trades, Jun 11–15): net **−26.55 USDT**, win rate **37.5%**, profit factor
**0.48**, expectancy **−1.11/trade**. The entire loss is in time-stops (−28.63 over 10 trades); **8 of
10 time-stops have MFE=0.00** (price never ticked in favor after entry) — an **entry-timing / regime-fit**
problem, **not** a TP/stop calibration problem. The clean sample is ~18 trades in a **single** regime
window — **below** the 20+/regime noise floor — so this does **not** by itself condemn momentum. **The
purpose of M37 is to build the instruments to decide, not to retune momentum.**

## Goal

Repair the three measurement defects so strategy selection can be made on evidence:

1. **Expose existing shadow data to the comparison layer AND repair the hollow shadow fill simulator** —
   the comparison queries read `shadow_decisions` (which already holds one concurrent same-event row per
   shadow version) reconciled against the active stream in `decisions`/`positions`, deduped so the active
   version is never double-counted; the v1 status-transition logging blackout is closed so a deactivated
   version continues as `shadow` with no gap; **and the shadow fill simulator is fixed so an accepted
   `open` counterfactual carries a populated `entryPrice`, a forward-only exit, a `closeReason`, and a
   realized counterfactual PnL — not the current ~99% hollow `missed` fills**. The read-layer +
   status-transition work is **read-mostly + decision-only**; the fill-simulator fix is a narrow engine
   content change to a **VIRTUAL ledger (counterfactual only, never a live order)**. The order path is
   unchanged and unreachable from any shadow version (regression-guarded).
2. **Backtest fill restoration + an explicit live-vs-backtest gate contract** — the backtest produces
   non-zero realistic fills; the contract documents which gate checks are reconstructable vs approximated;
   low-fidelity (fallback-gated) fills are flagged.
3. **Trade-record integrity** — the three defect classes above are diagnosed and fixed (or explicitly
   scoped out with a written reason).

When M37 is complete, the comparison-reporting surfaces (`compareVersions`, `getFunnelSummary`,
`getPerformance`) expose **same-event, skip-adjusted expectancy** and a **v0 skip baseline** once data
flows. M37 changes **no strategy logic** and **does not switch the active strategy**.

## Workstreams & design decisions

### W1 — Expose existing shadow data to the comparison layer + repair the hollow shadow fill simulator + close the v1 blackout + dedup active-vs-shadow (PRIMARY)

**Problem:** concurrent same-event shadow evaluation is **already running** and already writes one row per
version per event to `shadow_decisions` with a shared `event_id`. But two distinct defects make the data
unusable. First, the comparison **read layer** (`compareVersions.ts`, `getPerformance.ts`) reads only
`decisions`/`positions` and never reads `shadow_decisions`, so same-event comparison returns nothing.
Second — and newly verified by direct content inspection (2026-06-15) — even if the read layer were wired
up, there is **nothing to compare on the shadow side**: ~99% of `simulated_fill` blobs are `missed:true`
with `entryPrice:"0"`, no exit, no `closeReason`, all `lowFidelity:true` (v2 841/844; v3 177/179). The
shadow fill simulator records decisions but computes **no realized counterfactual PnL**. Two narrower
defects compound these: a 6-day v1 shadow-logging blackout, and a double-count hazard for the active
version (which appears in both tables).

**Decision (W1):** this is a `packages/analysis/` read-layer change, **plus a narrow engine content fix to
the shadow fill simulator (D1.6)**, plus a narrow engine fix for the status-transition logging gap. **None
of these is an evaluation-topology change** — evaluation topology already exists and is correct. Shadow
evaluation stays in `ShadowStrategyOrchestratorService` (separate orchestrator, sovereign virtual ledger
per ADR 0029, fire-and-forget, never touches `RiskGateService`). The fill simulator is a **VIRTUAL ledger
— counterfactual only, never a live order.**

- **D1.1 — Analysis reads both tables, reconciled on `event_id`.** The comparison layer must read the
  shadow stream from `shadow_decisions` and reconcile it with the active stream
  (`decisions`/`positions`) on the shared `event_id` — via a UNION, a reconciling view, or a dedicated
  comparison view in `packages/analysis/`. This is the actual fix that makes `compareVersions` return
  non-empty same-event output. The shared `event_id` (allocated once per live event, threaded into every
  shadow row) is the join key ADR 0017 depends on; the engine already guarantees it.
- **D1.2 — Active-vs-shadow dedup / precedence rule (HARD).** The active version appears in **both** tables
  (e.g. v2 is in `decisions`/`positions` as active *and* in `shadow_decisions` through Jun 14). The
  reconciliation must apply a precedence rule so no version is double-counted: **for the active version use
  `decisions`/`positions`; for shadow-status versions use `shadow_decisions`.** State this rule explicitly
  in the analysis query and test it.
- **D1.3 — Close the v1 status-transition logging blackout (engine).** v1 (`id=2`) logged nothing in
  either table Jun 8 → Jun 14 after going inactive Jun 8, then resumed in `shadow_decisions` Jun 14.
  Diagnose **why a version flipped off `active` stops logging entirely** for a window, and ensure a version
  flipped off `active` **immediately continues as `shadow`** (picked up by `runShadows`) with **no gap**.
  This is a targeted engine fix to the active→shadow transition, not a topology change.
- **D1.4 — No-shadow-order invariant is a REGRESSION GUARD on existing separation (HARD).** Shadow
  evaluation already runs in a separate orchestrator (`ShadowStrategyOrchestratorService`) with its own
  virtual ledger and never calls `RiskGateService`. M37 must **preserve** that separation, not create a
  new merged loop. The engine must prove (test) that the shadow path cannot allocate a live slot, call the
  exchange order API, or write a live `positions`/order row. **Do NOT fold shadow versions into
  `StrategyService`'s gated per-event loop** — that path is the only live-order path and merging shadows
  into it would risk the HARD invariant. This defends `CLAUDE.md` "no shadow version can trade" as a guard
  on the existing topology.
- **D1.5 — Determinism preserved (ADR 0029/0032) — NOT a shared snapshot.** Per ADR 0029 §1 cardinal rule
  and the actual code, each version **re-classifies `flowType`/`signalScore` under its OWN params and
  builds its OWN snapshot** from the **same raw event + same signal-bar tick evidence** (loaded once per
  event in `runShadows` and threaded immutably into each `runOneShadow`, ADR 0029 M26 amendment).
  Determinism comes from the **shared immutable event/tick set**, NOT from a shared market snapshot.
  **Mandating a single shared snapshot across versions is forbidden** — it reintroduces the exact
  censoring/bias ADR 0029 §2.1 (cardinal rule) and §4 alt-2 reject. No version evaluation reads wall-clock
  or RNG; evaluation order across versions does not affect any version's decision (strategies are pure,
  ledgers are sovereign).
- **D1.6 — Repair the hollow shadow fill simulator so accepted `open` counterfactuals carry realized PnL
  (engine, NEW).** Verified content defect (2026-06-15): ~99% of `shadow_decisions.simulated_fill` are
  `missed:true` with `entryPrice:"0"`, no `exitPrice`, no `closeReason`, all `lowFidelity:true`. The
  simulator records decisions but produces **no counterfactual outcome**. M37 must make a shadow `open`
  decision that the simulator **accepts** produce a **filled counterfactual**: a populated `entryPrice`
  (entry at the **decision-close** reference per the M26 next-bar-open alignment), an exit driven by **that
  same version's own exit policy on FORWARD bars only** (no future-extremum / look-ahead fill), a
  `closeReason`, and a realized counterfactual PnL — the exact look-ahead-safe estimator W4/D4.2 specifies.
  The engine must **first root-cause WHY ~99% miss** before changing fill logic; candidate causes (from ADR
  0029 §2.3 + the M26 amendment): a limit-fill / `MissedFillModel` that almost never fills, the M26
  next-bar alignment declining when no next bar exists, or the `lowFidelity` close-side proxy
  (`reconstructReferencePrice`) short-circuiting before computing an exit. The fix lives in the shadow
  fill-simulator pipeline (`VirtualPositionLedgerService` /
  `ShadowStrategyOrchestratorService.simulateShadowFill`), is a **VIRTUAL ledger (counterfactual only,
  never a live order)**, and must stay deterministic and forward-only (no wall-clock/RNG, no look-ahead),
  preserving ADR 0029 §2.1 (sovereign per-version ledger) and §2.3 (the fill-simulator-before-comparison
  hard rule). W4's v0 skip baseline and any cross-version expectancy comparison **depend on this fix**, not
  just on the read-layer union.

**W1 acceptance criteria:**

- `compareVersions(a, b, from, to)` returns **non-empty** same-event output for two concurrently-evaluated
  versions over a window where both have shadow/active rows, by reading `shadow_decisions` reconciled with
  `decisions`/`positions` on `event_id`. (`pairedEventCount > 0`; see W4 for the traded-pair caveat.)
- The reconciliation applies the active-vs-shadow precedence rule and a test proves the active version is
  **not** double-counted (once from `decisions`, once from `shadow_decisions`).
- The v1 status-transition blackout is root-caused and fixed: a version flipped off `active` continues
  shadow-logging with **no gap** (a test/observation proves continuity across the transition).
- **The shadow fill simulator is root-caused and repaired (D1.6):** the ~99%-miss cause is identified, and
  a shadow `open` decision the simulator **accepts** now writes a **non-hollow** `simulated_fill` —
  populated `entryPrice` (decision-close ref, M26 next-bar alignment), a forward-only exit via the version's
  own exit policy, a `closeReason`, and a realized counterfactual PnL — never `missed:true` with
  `entryPrice:"0"`. A paired test reproduces a hollow fill and proves the repaired path computes
  entry/exit/closeReason/PnL; the fill stays a VIRTUAL counterfactual (no live order, no slot, no
  `positions` row) and is deterministic + forward-only (no look-ahead).
- **No shadow version touches the order path** — a regression test proves the shadow path
  (`ShadowStrategyOrchestratorService`) cannot allocate a slot, call the exchange order API, or write a
  live `positions` row, and that shadow evaluation remains separate from `StrategyService`'s gated loop.
- Each shadow version builds its **own** snapshot from the shared immutable event/tick set (no shared
  snapshot mandate); evaluation is deterministic and order-independent (re-running yields identical
  per-version decisions).
- **No migration** — the existing `shadow_decisions` `UNIQUE(shadow_version, event_id)` already supports
  one-row-per-version-per-event; cardinality is not the gap.

### W2 — Backtest fill restoration + live-vs-backtest gate contract

**Problem:** the backtest gate rejects 100% of candidates because it cannot reconstruct book/liquidation/
depth state; live passes ~7%.

**Decision (W2):** make the backtest produce non-zero, **realistic** fills, and make the live-vs-backtest
contract explicit about gate-check reconstructability. The engine chooses between two documented routes
(or a hybrid), and **flags** any fill produced under the fallback:

- **D2.1 — Preferred: feed captured `book_snapshots` into the replay.** If the soak DB has retained
  `book_snapshots` for the backtest windows, the replay should consume them so the liquidation-distance
  and depth checks run on **real** captured book state — full fidelity, no fallback flag needed. The
  engine must first verify `book_snapshots` coverage over the report windows; partial coverage means a
  per-event mix of full-fidelity and fallback (D2.2).
- **D2.2 — Fallback: a documented relaxed liquidation+depth check when book data is unavailable.** Where
  `book_snapshots` cannot be reconstructed, the backtest uses a **clearly documented** fallback for the
  liquidation-distance / depth checks (e.g. `sl_outside_liquidation`) instead of hard-rejecting. Any fill
  produced via the fallback path is **flagged low-fidelity** in the backtest output, so a fallback fill is
  **never** confused with a full-fidelity (book-backed) fill. The fallback must be conservative enough
  that it does not manufacture fills the live gate would never allow.
- **D2.3 — Explicit gate-check reconstructability table in the contract.** Amend
  `docs/architecture/live-vs-backtest-contract.md` with a table enumerating **every** risk-gate check and
  classifying it as **reconstructable** (runs identically live and in backtest), **approximated** (uses a
  documented fallback in backtest, flagged), or **not modeled** (skipped, with a stated reason). This is
  the single place that explains why a backtest fill is or is not live-faithful.
- **D2.4 — Determinism + parity preserved (ADR 0015/0029/0032).** The backtest still runs the **same**
  strategy + execution-policy code as live (the live-vs-backtest contract umbrella rule). The fallback is
  a **gate-input approximation**, not a different gate or a strategy change. The backtest must remain a
  pure function of its inputs (replayable, no wall-clock/RNG).
- **D2.5 — Sanity bound on fill rate (same denominator) + composition check.** The bound must be defined
  on the **SAME denominator** on both sides. The live ~7% is **approvals / open-intents**; the original
  backtest 0% was **fills / total-events** — different denominators. Define the bound as
  **approvals / open-intents** (post-gate-eligible candidates, **excluding pre-gate skips**) on both sides.
  After W2, the backtest v2 approval rate over a live-overlapping window should be **directionally
  comparable** to the live ~7% on that denominator (not 0%, not ~100%). **A scalar rate is insufficient** —
  also compare the **accept/reject composition** (per-`flow_type` or per-symbol pass rate, or the
  rejected-reason distribution) so a biased fallback that happens to land near ~7% in aggregate is still
  caught. The real protection is **ADR 0019 criterion 12** (edge must survive with `lowFidelity` trades
  excluded); the report schema **already** carries `lowFidelityTradeCount` (ADR 0017 §2.4) — **extend it,
  do not re-add it**.

**W2 acceptance criteria:**

- All three report windows (or fresh runs over them) produce `tradeCount > 0` for versions that traded
  live in the overlapping window.
- Each backtest fill is tagged **full-fidelity** (book-backed) or **fallback/low-fidelity**; the report
  surfaces the count of each so fallback fills are never silently pooled with book-backed fills.
- `docs/architecture/live-vs-backtest-contract.md` contains the per-check reconstructability table
  (reconstructable / approximated / not modeled), each row citing its owning ADR.
- Backtest v2 **approval / open-intent** rate over a live-overlapping window is directionally comparable to
  live ~7% **on the same denominator** (not 0%, not ~100%); the accept/reject **composition**
  (per-`flow_type` or per-symbol, or rejected-reason distribution) is compared too, and deviations are
  explained by the fallback / `lowFidelity` flag.
- The backtest remains deterministic and runs the same strategy/execution code as live (no parity
  regression vs the contract).

### W3 — Trade-record integrity fixes

**Problem:** ≥6 of 24 live trades carry mislabeled or breached exit records, corrupting expectancy.

**Decision (W3):** diagnose each defect class, then fix or explicitly scope out with a written reason.
Each class is a separate fix item with its own paired test.

- **D3.1 — Mislabeled `take_profit` exits (EDGE/ZEC/ALLO: negative PnL, 0-min hold, MFE 0.00 — v2
  MOMENTUM trades).** Re-aimed root cause: the M35 degenerate-geometry guard is **mean-reversion-only** and
  only emits a **SKIP** — it cannot write a `take_profit`, so this is **not** an M35 escape/mislabel.
  Momentum has **no** degenerate-geometry guard. The `take_profit` label is written by
  `LocalProtectiveMonitor` on a TP breach. Likely cause: **momentum TP is computed off a bar-close
  reference vs the actual next-bar entry fill**, so the entry fills at/past TP and `LocalProtectiveMonitor`
  fires TP immediately (0-min, MFE 0.00). Re-aim the diagnosis at momentum **exit-geometry vs actual
  entry-fill price** and `LocalProtectiveMonitor.evaluateBreach` **arming-tick behavior**, plus the
  **momentum-vs-v1 missing-guard asymmetry** (why mean-reversion has a guard and momentum does not).
  Principle held: a `take_profit` label requires a **realized gain net of cost**. Cross-reference M35
  (`exit_reason` labeling) and ADR 0013 (position instrumentation) / ADR 0012 (realized PnL).
- **D3.2 — `time_stop` enforcement breach (MRVL: 127-min hold vs `time_stop_minutes=15`).** Diagnose why
  the M33 live exit-enforcement path let a position run **8.5×** past its time stop. Most likely missed
  cause: **`PositionTimeStopEnforcer` is event-driven off `price.update`** — if no tick arrives for the
  symbol (thin tier-2 / stalled feed), the deadline never fires. Candidate root causes to evaluate:
  the time-stop check was not scheduled, was skipped on a tick, failed to fire the close, **or no
  `price.update` arrived between the deadline and the close**. Consider a **replay-safe periodic sweep**
  that closes deadline-breached positions independent of tick arrival — it **must remain deterministic for
  backtest** (no wall-clock branch that diverges live vs replay). The fix must ensure a position is closed
  at/near `time_stop_minutes`; a breach this large is an exit-enforcement bug, not a calibration choice.
  Cross-reference M33 and ADR 0008/0011 (SL/TP attach + local fallback).
- **D3.3 — `manual` exits (OPN 75 min, AMD).** Establish whether manual intervention actually occurred.
  Decide (and document) whether `manual`-exit trades are **excluded** from strategy expectancy — they are
  not strategy-attributable outcomes and should not be pooled into win/loss/PF for a version. The fix may
  be analysis-side (exclude `manual` from expectancy) rather than a code defect; state which.
- **D3.4 — Scope discipline.** W3 is **diagnosis + correctness**, not retuning. If a defect turns out to
  be a calibration choice rather than a bug, it is **explicitly scoped out** with a written reason — M37
  does **not** retune TP/stop/time-stop thresholds (see Out of scope). Any fix that corrects historical
  rows must follow the DB-safety rules (backup-first; no destructive ops).

**W3 acceptance criteria:**

- The mislabeled-`take_profit` class is root-caused (escaped guard vs guard-mislabel) and the fix prevents
  a negative-PnL/0-min/MFE-0.00 close from being labeled `take_profit`; a paired test reproduces the
  defect and proves the fix.
- The time-stop breach is root-caused and the fix closes a position at/near `time_stop_minutes`; a paired
  test proves a position cannot run materially past its time stop.
- `manual`-exit trades are either confirmed legitimate-and-excluded from strategy expectancy or explained;
  the expectancy/comparison surfaces no longer attribute `manual` exits to a strategy version.
- Any correction to historical rows is applied under DB-safety (backup-first, scoped, confirmed) — no
  destructive ops.

### W4 — Comparison reporting

**Problem:** the reporting surfaces are correct in principle but were starved of same-event data for **two**
reasons: they never read `shadow_decisions` (W1 read layer), **and even the rows that exist carry hollow,
PnL-less `simulated_fill` blobs (W1/D1.6)**. Both must be fixed before any cross-version expectancy or v0
skip baseline is computable — **W4 depends on D1.6, not just the read-layer union.** A subtlety:
`compareVersions` suppresses the **mean** until a **traded-pair** floor is met — and v0/skip baselines have
**zero traded pairs by construction**, so the v0 baseline cannot come from the paired-traded PnL path at
all.

**Decision (W4):** once W1's read layer reconciles both tables, **confirm** `compareVersions`,
`getFunnelSummary`, and `getPerformance` surface **same-event expectancy** and a **v0 skip baseline via a
separate path**, and **note any query/schema gaps** discovered.

- **D4.1 — Same-event paired-diff expectancy + the traded-pair floor caveat.** `compareVersions` pairs on
  `event_id` and computes paired-diff expectancy (ADR 0017/0018), but reading `shadow_decisions` only makes
  `pairedEventCount` non-zero. `compareVersions` **suppresses `meanPnlDeltaUsd` to `null` until
  `pairedTradedEventCount ≥ 30`** (`MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN`), and counts a pair as **traded**
  only when **both** versions **opened AND closed in-window**. Confirm the reconciled query populates
  `pairedTradedEventCount` from the correct streams (active from `positions`, shadow from
  `shadow_decisions.simulated_fill`) and surfaces the mean once the floor is met.
- **D4.2 — v0 skip baseline comes from the skip/counterfactual stream, NOT compareVersions' traded path.**
  v0 (`trade_enabled:false`) **never trades**, so a v0-vs-active `compareVersions` has **~0 paired-TRADED
  events by construction** and `meanPnlDeltaUsd` stays `null` forever on that path. The v0 skip baseline
  must instead be computed from the **decision/skip stream + the counterfactual `simulated_fill` ledger**
  in `shadow_decisions` (`getFunnelSummary` / `getPerformance` skip-expectancy path). Define the **skip
  counterfactual-PnL estimator explicitly**: entry at the **decision-close** reference, exit by the **same
  version's own exit policy on FORWARD bars only** — **no future-extremum / look-ahead fill** (cite
  ADR 0029 forward-only ledger + M26 next-bar-open alignment to prevent look-ahead). This is the **same**
  forward-only estimator the W1/D1.6 fill-simulator repair must implement — D4.2 (the v0 skip baseline) is
  **uncomputable until D1.6 lands**, because today the `simulated_fill` ledger it reads is ~99% hollow
  (`missed:true`, no entry/exit/PnL). It is uncomputable for **two** reasons, not one: the read layer
  ignores `shadow_decisions`, AND the counterfactual fills it would read carry no PnL.
- **D4.3 — null `position_id` LATERAL workaround is largely moot here.** Because shadow rows live in
  `shadow_decisions` (which has **no `position_id` column**) they are **structurally excluded** from any
  `decisions`-`positions` join — so the original null-`position_id` LATERAL concern does not arise for
  shadow rows. Document the LATERAL workaround as it applies to the **active** `decisions` stream only, and
  confirm the reconciliation keeps shadow rows out of live-position attribution by construction (separate
  table, no `position_id`), not by an explicit filter.
- **D4.4 — Forced-continuation bias marker carry-over (M36 `halt_relax_active`).** Cross-version
  comparisons must continue to honor the M36 `halt_relax_active` constraint: forced-continuation rows are
  a left-tail conditional sample and must be excluded from or cohorted separately in any cross-version
  win-rate / PF / expectancy comparison. W4 must not regress that fence.

**W4 acceptance criteria:**

- `compareVersions` returns non-zero `pairedEventCount` for two concurrently-evaluated versions once the
  read layer reconciles `decisions` + `shadow_decisions` (W1); `meanPnlDeltaUsd` surfaces only once
  `pairedTradedEventCount ≥ 30` (the documented floor), and the W4 close-out states this explicitly rather
  than claiming a mean that the floor suppresses.
- The v0 skip baseline is computable from v0's **skip/counterfactual** stream (`shadow_decisions` +
  `simulated_fill`) via `getFunnelSummary` / `getPerformance` — **not** from `compareVersions`' paired-
  traded path (v0 has ~0 traded pairs by construction); the skip counterfactual-PnL estimator is
  forward-only (no look-ahead), per ADR 0029. **This explicitly depends on W1/D1.6** — the
  `simulated_fill` stream must carry realized counterfactual PnL (not the current ~99% hollow `missed`
  fills), or there is no outcome to baseline.
- Any query/schema gap (active-vs-shadow precedence/dedup; null `position_id` LATERAL on the active stream;
  shadow-row exclusion-by-construction; `halt_relax_active` cohorting) is documented in this milestone's
  close-out, with a fix or a ticket reference.

## Out of scope (explicit non-goals)

- **Do NOT retune momentum thresholds.** No change to TP / stop / regime / idiosyncrasy thresholds. There
  is no edge to tune on this sample (losses are zero-MFE time-stops — an entry-timing/regime-fit problem,
  not a calibration problem), and the clean sample is below the 20+/regime noise floor.
- **Do NOT promote or switch the active strategy.** v2 momentum stays `active`. Switching is gated on the
  comparison data M37 produces and is a separate future milestone. **The switch-gate is the locked
  promotion gate, not an invented number:** ADR 0019 + ADR 0018 §2.5 require **≥200 trades total, ≥100 in
  the target regime, ≥30 days shadow, and the paired bootstrap `winner === candidate` with CI excluding
  zero and not `inconclusive`** (ADR 0018 §2.4 returns `inconclusive` below 200). M37 must **not** restate
  this as a weaker invented threshold. If a *minimum-to-attempt-a-comparison* trigger is wanted, label it
  explicitly as that — e.g. **≥30 paired non-zero events to compute a mean** (the
  `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` floor) — and never conflate it with the promotion/switch gate.
- **No new strategy logic.** M37 is **instrumentation + integrity only**. No new strategy version, no
  routing change, no signal change.
- **No change to live risk posture.** The risk gate is not loosened (W2's fallback is a **backtest-only**
  gate-input approximation, never applied live). No order path is added or bypassed.
- **Shadow equity-decrement fix** (the M36-noted constant `PAPER_STARTING_EQUITY_USDT` sizing base) — out
  of scope; continue to fence affected shadow data via the M36 `halt_relax_active` marker.
- **Dashboard / UI** — no new surface unless an operator explicitly needs to *see* concurrent-version
  decision counts; defer unless asked.

## Trading-safety invariants reaffirmed (M37-specific)

- **No order path bypasses the risk gate** — W1 is a **read-layer + narrow-engine** change; it adds **no**
  evaluation loop. The single live order path through `RiskGateService` is unchanged and remains reachable
  by the **one** `active` version only, via `StrategyService`.
- **No shadow version can place an order** (HARD) — preserved as a **regression guard on the existing
  `ShadowStrategyOrchestratorService` separation** (D1.4), NOT a constraint on a new loop. Shadow
  evaluation stays in its own orchestrator with a sovereign virtual ledger; M37 must not merge it into the
  gated live loop.
- **The repaired shadow fill simulator is a VIRTUAL ledger — counterfactual only, never a live order**
  (D1.6, ADR 0029 §2.1). Making it compute realized counterfactual PnL adds **no** order path: it computes
  a hypothetical entry/exit/PnL in-memory and stamps `shadow_decisions.simulated_fill`; it never allocates
  a slot, calls the exchange order API, or writes a live `positions`/order row. The no-shadow-order
  invariant is unaffected.
- **Strategies stay pure/deterministic** — each version builds its **own** snapshot from the **shared
  immutable event/tick set** (NOT a shared snapshot — ADR 0029 §2.1 cardinal rule); no wall-clock/RNG;
  order-independent (D1.5). W2's backtest stays a pure replay (D2.4).
- **Money is `decimal`** — all PnL/expectancy/sizing in W3/W4 stay `decimal`, never float.
- **Live ↔ backtest parity** — W2 keeps the same strategy + execution code live and in backtest; the
  fallback is a documented, flagged gate-input approximation, not a divergent gate.

## Change set (representative — engine confirms exact files)

| Workspace | Files (representative) | Workstream |
|---|---|---|
| `packages/analysis/` | **PRIMARY:** `compareVersions.ts` / `getPerformance.ts` (+ a reconciling view) read `shadow_decisions` reconciled with `decisions`/`positions` on `event_id`, with the active-vs-shadow precedence/dedup rule | W1 (D1.1/D1.2) |
| `apps/engine/` | **NEW:** repair the hollow shadow fill simulator — accepted `open` counterfactuals carry entry/exit/closeReason/realized PnL (forward-only, no look-ahead) instead of ~99% hollow `missed` fills; VIRTUAL ledger only, never a live order: `ShadowStrategyOrchestratorService.simulateShadowFill`, `VirtualPositionLedgerService` | W1 (D1.6) |
| `apps/engine/` | narrow fix: close the active→shadow status-transition logging blackout (a deactivated version continues as `shadow` via `runShadows` with no gap) — NOT a topology change | W1 (D1.3) |
| `apps/engine/` | regression guard only: a test proving `ShadowStrategyOrchestratorService` cannot reach the order path / allocate a slot / write a live `positions` row, and stays separate from `StrategyService`'s gated loop | W1 (D1.4) |
| `apps/engine/` | backtest replay gate path — consume captured `book_snapshots` where available; documented fallback liquidation+depth check + low-fidelity flag where not | W2 |
| `docs/` | `docs/architecture/live-vs-backtest-contract.md` — per-check reconstructability table (reconstructable / approximated / not modeled), ADR-cited | W2 (D2.3) |
| `apps/engine/` | momentum exit-geometry vs entry-fill + `LocalProtectiveMonitor.evaluateBreach` arming (`take_profit` only on real net gain); `PositionTimeStopEnforcer` tick-driven deadline gap (replay-safe sweep) | W3 |
| `packages/analysis/` | v0 skip baseline from skip + `simulated_fill` counterfactual stream (forward-only estimator), NOT compareVersions' traded path; document active-stream LATERAL workaround | W4 |
| `docs/` | ADR amendments (0017 same-event comparison now actually *read* from `shadow_decisions`; 0029 read-layer reconciliation + status-transition continuity, no topology change; 0015 backtest fill restoration); milestone-log / work-log / STATUS at close | architect + scribe |

**No cardinality migration** — `shadow_decisions.UNIQUE(shadow_version, event_id)` already supports
one-row-per-version-per-event. W1 is read-layer + a narrow engine status-transition fix. W2 and W3 are not
expected to require migrations; W3 historical-row corrections, if any, run under DB-safety.
`packages/shared/` is touched only if a comparison DTO needs a fidelity flag field (W2) — route through
`bot-shared-maintainer` first per `CLAUDE.md` hard-rule 5.

## Dispatch waves (per `CLAUDE.md` / dev-qa-cycle — ≤5 items/files per dispatch)

> **Architect first — this changes the analysis comparison contract and the live/backtest gate contract,
> NOT evaluation topology.** Evaluation topology already exists and is correct (`runShadows` already writes
> concurrent same-event rows). The architect pass is for: the **analysis read/reconciliation contract**
> (how `decisions` + `shadow_decisions` are joined and deduped), the **ADR 0017/0029 amendments**, and the
> live/backtest gate contract. Per dev-qa-cycle, a change to a comparison/measurement contract gets an
> architect pass before code.

1. **Serial — `bot-architect`:**
   - Amend **ADR 0017** (same-event comparison) — record that the same-event pairs ADR 0017 specifies are
     produced by the **already-existing** `shadow_decisions` stream (shared `event_id`), and that the
     comparison layer must **read** that table (the prior gap was the read layer, not the producer); pin
     the active-vs-shadow precedence/dedup rule.
   - Amend **ADR 0029** (shadow pipeline) — record the analysis-layer reconciliation contract, the
     active→shadow status-transition continuity requirement, **and the shadow fill-simulator content fix
     (D1.6): an accepted `open` counterfactual must produce a non-hollow `simulated_fill` (entry at
     decision-close per the M26 next-bar alignment, forward-only exit via the version's own exit policy,
     `closeReason`, realized counterfactual PnL — no look-ahead), superseding the current ~99% hollow
     `missed` behavior (the M26 close-side `reconstructReferencePrice` proxy is the suspected
     short-circuit)**; reaffirm (do NOT change) that shadow evaluation stays in
     `ShadowStrategyOrchestratorService`, that the fill simulator is a **VIRTUAL ledger — counterfactual
     only, never a live order**, that "no shadow version reaches the order path" is a **regression guard on
     the existing separation** (D1.4), and the §2.1 cardinal rule that each version builds its **own**
     snapshot (no shared snapshot).
   - Amend **ADR 0015** (backtest) + `live-vs-backtest-contract.md` — the per-check reconstructability
     table, the captured-`book_snapshots` route, the documented fallback, and the low-fidelity flag.
   - Confirm the determinism/parity contract (ADR 0032) is preserved — determinism from the shared
     immutable event/tick set, NOT a shared snapshot.
1a. **Serial — shared-maintainer pre-check (W2/W4).** If a comparison/backtest DTO needs a fidelity flag
    or a fidelity-count field in `packages/shared/`, dispatch **`bot-shared-maintainer`** first
    (`CLAUDE.md` hard-rule 5). If all touched DTOs are engine/analysis-internal, skip and note it in the
    orchestrator verification.
2. **Parallel after the ADR (and after 1a if it ran)** (independent ≤5-file dispatches; disjoint files):
   - **`bot-analysis` / `packages/analysis` Dispatch A (W1 read-layer — PRIMARY):** `compareVersions` /
     `getPerformance` (+ reconciling view) read `shadow_decisions` reconciled with `decisions`/`positions`
     on `event_id`, with the active-vs-shadow precedence/dedup rule. No engine topology change.
   - **`bot-engine-nestjs` Dispatch A2 (W1 engine — narrow):** close the active→shadow status-transition
     logging blackout so a deactivated version continues as `shadow` via `runShadows` with no gap; add the
     no-shadow-order regression guard (D1.4). NO new evaluation loop.
   - **`bot-engine-nestjs` Dispatch A3 (W1 engine — shadow fill simulator, D1.6 — NEW, separate from A2):**
     root-cause the ~99% hollow `missed` fills, then repair `ShadowStrategyOrchestratorService.simulateShadowFill`
     / `VirtualPositionLedgerService` so an accepted `open` counterfactual carries entry/exit/closeReason/
     realized PnL (forward-only, no look-ahead). VIRTUAL ledger only — never a live order, no slot, no
     `positions` row. ≤5 files; disjoint from A2. This dispatch is a **prerequisite for W4** (v0 skip
     baseline + cross-version expectancy).
   - **`bot-engine-nestjs` Dispatch B (W2 backtest fill restoration):** book-snapshot replay where
     available + documented fallback liquidation/depth check + low-fidelity flag.
   - **`bot-engine-nestjs` Dispatch C (W3 trade-record integrity):** momentum exit-geometry/entry-fill +
     `LocalProtectiveMonitor` arming; `PositionTimeStopEnforcer` tick-driven deadline gap (replay-safe
     sweep). (≤2 fix items per sub-dispatch per dev-qa-cycle.)
3. **Serial — `bot-qa-engineer`:** paired tests per fix item — W1 (non-empty reconciled comparison from
   `shadow_decisions`; active-vs-shadow **no double-count**; v1 status-transition continuity; **shadow fill
   simulator produces non-hollow counterfactuals — accepted `open` carries entry/exit/closeReason/PnL, not
   `missed:true`/`entryPrice:"0"`, forward-only, VIRTUAL-only**; shadow-path no-order **regression guard**;
   per-version own-snapshot determinism); W2 (non-zero fills, fidelity flag,
   contract table, same-denominator fill-rate + composition bound); W3 (one paired test per defect class).
   Adversarial: prove the shadow path **cannot** place an order and stays separate from the gated loop;
   prove the backtest fallback does not manufacture live-impossible fills; prove the active version is not
   double-counted across the two tables.
4. **Parallel — reviewers:** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   `bot-review-quant`. Security/logic own the **no-shadow-order regression guard** (the existing
   orchestrator separation is preserved, no shadow path reaches the order path, and shadows were NOT merged
   into the gated loop) and that no order path is bypassed.
   Quant owns whether the restored backtest fills are realistic (not manufactured) and whether the
   comparison surfaces now yield analyzable same-event/skip-baseline data. Cycle fix → re-review until zero
   blockers, zero highs, majority mediums.
5. **Serial — `bot-scribe`:** `docs/milestone-log.md`, `docs/work-log.md`, `docs/STATUS.md`, the ADR
   amendment links (0017, 0029, 0015), and the `live-vs-backtest-contract.md` reconstructability table.
   **`docs/STATUS.md` is the scribe's job at close — not touched by this plan.**

Orchestrator verifies the actual diff after every wave and **explicitly confirms**: (a) the comparison
layer reads `shadow_decisions` reconciled with `decisions`/`positions` on `event_id` and returns non-empty
same-event output, with the active version **not** double-counted; (a2) **the shadow fill simulator is
repaired — accepted `open` counterfactuals carry `entryPrice`/`exitPrice`/`closeReason`/realized PnL (NOT
`missed:true` with `entryPrice:"0"`), forward-only with no look-ahead, and the fill stays a VIRTUAL
counterfactual (no live order, no slot, no `positions` row)**; (b) the v1 status-transition blackout is
closed and **no shadow version can reach the order path** (regression-test-proven, separation preserved);
(c) the backtest produces non-zero fills with each fill tagged full-fidelity vs fallback; (d) the
live-vs-backtest contract table classifies every gate check; (e) the three trade-record defect classes are
root-caused and fixed or explicitly scoped; (f) no strategy logic changed, **no evaluation-topology change
was made**, and the active strategy was **not** switched.

## Success criteria / acceptance tests (rollup)

- **W1:** the comparison layer reads `shadow_decisions` reconciled with `decisions`/`positions` on
  `event_id`; `compareVersions` returns non-empty same-event output with the active version not
  double-counted; **the shadow fill simulator is repaired so an accepted `open` counterfactual carries
  `entryPrice`/`exitPrice`/`closeReason`/realized PnL (forward-only, no look-ahead) instead of the current
  ~99% hollow `missed` fills — a VIRTUAL counterfactual only, never a live order**; the v1
  status-transition blackout is closed (deactivated version continues as `shadow` with no gap); a shadow
  version **cannot** place an order / allocate a slot / write a live `positions` row (regression test,
  separation preserved); each version builds its own snapshot from the shared immutable event/tick set;
  evaluation is deterministic and order-independent. **No evaluation-topology change; no cardinality
  migration.**
- **W2:** all three report windows produce `tradeCount > 0`; each fill is tagged full-fidelity vs
  fallback; the contract table classifies every gate check (reconstructable / approximated / not modeled);
  v2 backtest fill rate over a live-overlapping window is directionally comparable to live ~7% (not 0%,
  not ~100%); backtest stays deterministic and runs the same strategy/execution code as live.
- **W3:** mislabeled-`take_profit` root-caused and fixed (paired test); time-stop breach root-caused and
  fixed so a position cannot run materially past `time_stop_minutes` (paired test); `manual` exits
  excluded from / explained for strategy expectancy.
- **W4:** `compareVersions` returns non-zero `pairedEventCount` (mean only above the
  `pairedTradedEventCount ≥ 30` floor); the v0 skip baseline is computable from the skip/`simulated_fill`
  counterfactual stream (forward-only estimator, no look-ahead), **not** from the paired-traded path;
  query/schema gaps (active-vs-shadow precedence, active-stream LATERAL, shadow-exclusion-by-construction,
  `halt_relax_active` cohorting) documented.
- **Boot:** engine boots and stays running; 10-min live smoke per `feedback-milestone-app-smoke`
  (fix-and-report any boot error before the scribe) — confirm the existing shadow evaluation continues to
  run and write `shadow_decisions`, the status-transition fix logs without gaps, and no shadow version
  emits an order.
- **Data confirmation (post-deploy, 24–48h):** confirm `shadow_decisions` continues to accrue same-event
  rows across versions (v1 with no further blackout), **that newly written `simulated_fill` blobs for
  accepted `open` decisions are non-hollow (populated `entryPrice`/`exitPrice`/`closeReason`/PnL, not the
  prior ~99% `missed:true`/`entryPrice:"0"`)**, and that the reconciled `compareVersions` returns
  non-empty output; read-only DB querying; honor the M36 `halt_relax_active` analysis constraint. Note
  pre-D1.6 historical rows stay hollow and are not retroactively rescored (ADR 0029 M26 forward-only
  ledger) — a full-window rescore is a separate replay job, out of scope for M37.

## Risk / rollback

- **W1 is read-mostly + a narrow engine fix; reversible.** The PRIMARY change is in `packages/analysis/`
  (read-only) and does not touch any order path or evaluation topology. The engine change is the narrow
  active→shadow status-transition fix. Rollback is reverting the analysis reconciliation and the
  status-transition fix. The no-shadow-order **regression guard** (D1.4) is defense-in-depth on the
  existing orchestrator separation — no shadow version can ever place an order.
- **W2 is backtest-only.** The fallback gate-input approximation lives entirely in the backtest replay and
  is **never** applied live — live risk posture is byte-identical. The low-fidelity flag prevents
  fallback fills from contaminating fidelity-sensitive analysis. Rollback is reverting the backtest gate
  change; live is unaffected either way.
- **W3 corrects labeling/enforcement.** The exit-label fix tightens correctness (a profit label only on a
  real net gain); the time-stop fix tightens enforcement (closes at/near the stop). Both are
  conservative-leaning. Any historical-row correction is backup-first and scoped.
- **Determinism preserved.** Each version's own-snapshot evaluation (from the shared immutable event/tick
  set, NOT a shared snapshot — ADR 0029 §2.1) and the pure backtest replay keep ADR 0029/0032 parity
  intact; re-running yields identical decisions.
- **No live-capital exposure added.** M37 adds no new live order path and no new evaluation loop; the only
  live order path remains the single `active` version through the unchanged risk gate.

## DB safety (HARD — `CLAUDE.md` invariants #8/#9)

- **No cardinality migration (W1).** The existing `shadow_decisions.UNIQUE(shadow_version, event_id)`
  **already** supports one-row-per-version-per-event with a shared `event_id` (verified). W1 is read-layer +
  a narrow engine status-transition fix — no schema change is anticipated. If an unforeseen blocking
  constraint is discovered, any migration is additive/constraint-relaxing and applied under DB-safety:
  **`pg_dump` first**, show the path, prune to the **2 most recent** `backup_` files, confirm, then apply.
  No `-v`, no `down`/`revert` in the live soak, no `TRUNCATE`/`DELETE`.
- **W3 historical-row corrections (if any).** Correcting mislabeled exit rows is a scoped `UPDATE` keyed to
  the specific defective positions (EDGE/ZEC/ALLO/MRVL/OPN/AMD). It is **not** a bulk op. Per `CLAUDE.md`
  #9, any `UPDATE` touching more than one row is **backup-first** (`pg_dump`, show path, confirm). Prefer
  fixing the **code** path so future rows are correct, and correcting history only with explicit user
  confirmation.
- **Backup command:**
  `docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`,
  then `ls -t backups/backup_*.sql.gz | tail -n +3 | xargs rm -f`. Show the user the dump path and confirm
  before any schema or data write.

## Post-deploy steps

1. Take `pg_dump` before the engine restart (the W1 PRIMARY change is analysis-side and read-only; the
   engine change is the narrow status-transition fix); prune to 2-deep retention; show the path and confirm.
2. Deploy the W1 engine status-transition fix + the analysis reconciliation; **engine restart**. Confirm
   the tick loop is healthy, `shadow_decisions` continues to accrue, and no shadow version emits an order.
3. **10-min live smoke** per `feedback-milestone-app-smoke` — confirm the existing shadow evaluation keeps
   running, the active→shadow transition logs without gaps, and the loop does not stall.
4. **Reconciled-comparison + blackout confirmation (24–48h):** confirm `shadow_decisions` continues to
   accrue same-event rows across versions (v1 with no further blackout) and that the reconciled
   `compareVersions` returns non-empty output. Read-only DB querying; honor the M36 `halt_relax_active`
   analysis constraint when comparing.
5. **Backtest re-run:** re-run the three report windows; confirm `tradeCount > 0`, the fidelity flag is
   populated, and the v2 fill rate is directionally comparable to live ~7%.

## References

- Same-event comparison + paired bootstrap: [ADR 0017](../../architecture/adr/0017-walk-forward-and-same-event-comparison.md),
  [ADR 0018](../../architecture/adr/0018-statistical-significance-paired-block-bootstrap.md)
- Strategy version lineage + promotion gate: [ADR 0016](../../architecture/adr/0016-strategy-version-lineage-and-promotion.md),
  [ADR 0019](../../architecture/adr/0019-promotion-gate.md)
- Shadow counterfactual + fill-simulator pipeline: [ADR 0029](../../architecture/adr/0029-shadow-counterfactual-and-fill-simulator-pipeline.md)
- Backtest module + live/backtest parity: [ADR 0015](../../architecture/adr/0015-backtest-module.md),
  [live-vs-backtest-contract.md](../../architecture/live-vs-backtest-contract.md)
- Risk management (gate checks, liquidation/depth): [ADR 0004](../../architecture/adr/0004-risk-management.md)
- Trade-record integrity precedents: M35 (`exit_reason` labeling / wrong-side & sub-cost TP guards),
  M33 (live exit enforcement); position instrumentation [ADR 0013](../../architecture/adr/0013-position-instrumentation.md),
  funding/PnL [ADR 0012](../../architecture/adr/0012-funding-and-pnl.md)
- Decision data-capture completeness: [ADR 0043](../../architecture/adr/0043-m27-decision-data-capture-completeness.md)
- Forced-continuation bias marker (carry-over constraint): [M36](M36-paper-soak-consecutive-loss-halt-relaxation.md)

### Key source files

| Concern | Path |
|---|---|
| Same-event comparison query (reads only `decisions`/`positions` today — W1 read-layer gap) | `packages/analysis/src/query/compareVersions.ts` |
| Funnel / performance queries (reads only `positions` today) | `packages/analysis/src/query/getFunnelSummary.ts`, `packages/analysis/src/query/getPerformance.ts` |
| **Concurrent shadow evaluation — ALREADY RUNNING** (`runShadows` writes one `shadow_decisions` row per version per event, shared `event.eventId`, fire-and-forget, never touches `RiskGateService`); **`simulateShadowFill` is the hollow-fill locus to repair (D1.6) — ~99% emit `missed:true`/`entryPrice:"0"`** | `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` |
| Live gated order path (the ONLY live-order path — do NOT merge shadows into it) | `apps/engine/src/strategy/service/StrategyService.ts` |
| Sovereign per-version virtual ledger (counterfactual fills — **D1.6 repair target; VIRTUAL only, never a live order**) | `apps/engine/src/strategy/service/VirtualPositionLedgerService.ts` |
| Backtest reports (all `tradeCount: 0`) | `reports/backtest/v2-20260609-20260613.json`, `v3-20260530-20260614.json`, `v4-20260609-20260613.json` |
| Live/backtest gate contract | `docs/architecture/live-vs-backtest-contract.md` |
</content>
</invoke>
