# M39 — Shadow-ledger close path + realized-PnL fidelity (free the single virtual slot so opens accrue, then make the counterfactual exit non-degenerate; unblock the D3 gate)

> **Sequencing note:** M39 is a **shadow-measurement-completeness** milestone, not a live-trade or
> backtest change. M37 built the shadow *fill simulator* (entry + a forward-only resolved exit per
> event). M38 repaired the *live* trade geometry. M39 closes the gap between the two halves of the
> shadow path: the simulator resolves an exit at open time, but that verdict is never fed back into
> the virtual ledger, so the ledger believes every opened position is still open. Under the
> restricted-profile `max_open_positions: 1`, the first open occupies the only slot **forever** and
> every subsequent open is rejected `max_open_positions_reached` — so the **opens count per version
> is starved to ≈1**, which is the real reason no usable counterfactual series exists. M39 (W1) frees
> the slot so opens accrue, then (W2) makes the resolved exit economically meaningful. Every
> trading-safety invariant in `CLAUDE.md` holds: the shadow path **never** touches the exchange,
> strategies stay pure/deterministic, money is `decimal`, no wall-clock in the deterministic path,
> and the slot ceiling stays at the live restricted profile (M39 does **not** raise it).

## Is this the fix for "shadow decisions" or "backtest"?

**Shadow decisions.** The backtest engine (`HistoricalFillAdapter` + `BacktestOrchestrator`) is **not**
broken — it already simulates next-bar fills correctly. M39 touches the backtest only as the
**reference model** for the W2 exit walk; it does not modify the backtest engine.

## Premise correction (post-quant/logic review)

The first draft of this plan claimed the D3 gap was "no `realized_pnl` is ever produced" and proposed
adding a `realizedPnl` field to `ISimulatedFill`. **Both reviewers showed this is wrong:** the analysis
layer already computes shadow realized PnL directly from the fill JSONB —
`(exitPrice − entryPrice) × qty × side − feeUsdtEntry − feeUsdtExit`, counting a row as traded on
`missed = false AND exitPrice IS NOT NULL AND entryPrice != '0'` (`getPerformance.ts:92-138`,
`compareVersions.ts:112-136`). It never reads the ledger and needs no persisted field. So:

- **The real defect is the opens *count*, not a missing PnL field.** The slot-lock starves opens to
  ≈1/version (verified: 247/251 gate rejects on 06-16 were `max_open_positions_reached`).
- **A persisted `realizedPnl` field is dropped from scope.** It would be net-new state that *disagrees*
  with the analysis layer (the ledger's `closeBySymbol` deducts only the exit-leg fee; the analysis
  layer deducts both legs). The **canonical D3 PnL source is the analysis-layer recomputation** (both
  fee legs), full stop. The ledger's internal `realizedPnl` stays exactly what it is today — a
  gate-internal signal for the consecutive-loss streak only, never the reported/compared number.

## Context

Verified against the soak DB on `2026-06-16` and by reading the code.

### Data symptom (verified)

`shadow_decisions`: **8,310 rows, 1,024 with a `simulated_fill`, only 1 with an `exitPrice`.** Of the
1,024: 1,018 are miss sentinels (`entryPrice "0"`, pre-M37), 5 are pre-M37 entry-only hollow fills, 1
is the single post-M37 complete fill (`force_close`, `exitPrice == entryPrice == 0.06245`).

### Why only 1 of 79 opens since the M37/M38 restart produced a fill (verified)

On `2026-06-16`: **251 gate-allowed vs 247 `max_open_positions_reached`.** A fill is only written for a
gate-allowed open (`shouldSimulateFill = isOpen && gateOutcome.allowed`, `:328`). Once a version's
single slot is occupied it never frees, so all later opens reject → no fill.

### Root cause (verified by tracing every production caller)

1. `VirtualPositionLedgerService` has no SL/TP/time-stop close path; only `reverse_signal` and
   `force_close` exist.
2. Only `reverse_signal` is wired (`ShadowStrategyOrchestratorService.ts:298`). `forceCloseAllPositions`
   has **zero callers** ("Wiring … is a TODO").
3. M37's `simulateShadowFill` → `resolveShadowExit` (`:439-546`) resolves an exit, but it is written
   only into the `simulated_fill` JSONB and **never fed into `ledger.tryClose()`**. Fill says "closed";
   ledger says "open". The slot never frees. Scope gap, not a regression.

## Goal

1. Free the single virtual slot on every event so the **opens count per version** accrues (the actual
   D3 data gap).
2. Make the resolved counterfactual exit **non-degenerate** so the analysis-layer realized series is
   economically meaningful and admissible to the D3 gate.

## Design

### W1 — Free the slot: close the virtual position in-pass with the fill's resolved exit (primary)

When `runOneShadow` accepts an open and `simulateShadowFill` returns a **non-missed** fill with a
resolved `closeReason`, close the virtual position in the same pass.

- **Reuse `closeBySymbol`** (`event.symbol`, `fill.exitPrice`, mapped reason) rather than adding a new
  `closeByVirtualOrderId` — it already resolves the position, runs the tested PnL math, and calls
  `tryClose`. Avoids a third PnL code path. *(LOW from logic review.)*
- **BLOCKER — distinct close eventId.** `tryOpen` marks `event.eventId` processed; `tryClose` rejects a
  duplicate `eventId`. The close **MUST** use a derived id `${event.eventId}:exit` (mirroring the
  existing `:reverse` suffix at `:304`) or it returns `duplicate_event_id` and the slot silently never
  frees. This is a named acceptance criterion, not an open question. QA must assert `tryClose` succeeds
  in the same pass as `tryOpen`.
- **HIGH — deterministic close timestamp.** Derive the close `nowMs` from `IShadowExitOutcome.closedAt`;
  when `closedAt` is null (`resolveShadowExit` returns null when `stop.hitTsMs` is null, `:530`) fall
  back to the **last-tick timestamp** (already available at `:544`), never wall-clock — preserves the
  determinism invariant.
- **HIGH — cold-restart rebuild.** `rebuildLedger` (`:655-714`) replays only `open` rows. Define the
  rebuild rule explicitly with a **precise predicate** (logic NEW-1): an `open` row with a
  **non-missed fill AND a non-null `exitPrice`** is replayed as a **net-zero no-op** (open-then-close ⇒
  slot ends empty) — only the `eventId` is seeded into `processedEventIds`. Hollow/missed rows
  (`missed=true` or null `exitPrice`, including all pre-M37 rows) continue to NOT replay as opens, exactly
  as today (`:665`) — the predicate must not loosen to "any resolved exit" or it would wrongly replay a
  hollow row. Without this, restart re-creates the stuck slot. QA must cover restart with a
  resolved-exit row AND a missed row.
- **HIGH — consecutive-loss halt interaction.** A same-bar `force_close ≈ entry` minus the exit fee is
  reliably *slightly negative*; `countConsecutiveLossesInRiskDay` (`:133-150`) counts any
  `realizedPnl < 0` as a loss, so with `halt_after_consecutive_losses: 2` two opens/day would trip the
  halt and **re-lock the version** — defeating the milestone. Resolution (decide + state, not discover
  in soak): the streak exclusion **MUST key on `closeReason === 'force_close'` specifically** (quant
  NEW), NOT on "small/negative PnL" — after W2 a genuine `sl` / `time_stop` exit can also land slightly
  negative and **must still arm the streak**. The predicate in `countConsecutiveLossesInRiskDay` becomes
  `realizedPnl.isNegative() && entry.closeReason !== 'force_close'` (`closeReason` is already on each
  `closedTrades` entry, `:236`). (Running the soak with `paperRelaxConsecutiveLossHalt` on is a weaker
  fallback; the `force_close`-keyed exclusion is cleaner and must be the default.) QA must assert both:
  N≥3 consecutive `force_close` exits do **not** halt, AND a `sl`/`time_stop` loss **does** arm the streak.

W1 alone makes the slot free every event and the opens count honest. **It does NOT make the realized
PnL meaningful** — in live eval the post-entry window is the entry tick, so the exit is `force_close ≈
entry` ⇒ realized ≈ −fees. W1 fixes the count; W2 fixes the value.

### W2 — Non-degenerate exit walk across the next-bar tape (the genuine D3 precondition)

Replace the same-bar `force_close` with a true SL / TP / **time-stop** walk across the **next bar's**
`tick_aggregates` (available on the soak tape minutes later, never in live eval). This borrows the
`HistoricalFillAdapter.simulateIntrabarStop` model the backtest already uses — **without modifying the
backtest engine**. Options for the impl brief: a short deferred pass once the next bar's ticks land, or
a dedicated backtest-replay over the shadow opens for the D3 window.

**W2 is a hard precondition for any D3 realized-PnL input** (reclassified from "optional"). Until it
lands, the only realized series is the ≈ −fees force_close series, which has near-zero variance and a
guaranteed-slightly-negative mean — the ADR 0018 bootstrap would read it as a *false*
inconclusive/reject (ADR 0019 criterion 5), not as "no data." Therefore:

- **Wire ADR 0019 criterion 12 as a D3 abstain guard, keyed on the `force_close` fraction** — NOT on
  `lowFidelity` (logic NEW-2). `buildFilledShadowFill` hard-codes `lowFidelity: true` on every shadow
  fill (`ShadowStrategyOrchestratorService.ts:486`), so a `lowFidelity`-keyed guard would abstain
  *forever*, even on good W2 `sl`/`tp` data. The operative signal is the **`force_close` fraction**,
  which W2 genuinely reduces. (If a true `lowFidelity` distinction is wanted later, W2 must explicitly set
  `lowFidelity: false` for next-bar-walked exits — out of scope here.) The D3 gate abstains when the
  `force_close` fraction of the realized series exceeds a stated threshold over the window. **The
  threshold constant lives in `promotionGateConsts.ts`** (per ADR 0019 §2.4), as operator policy in one
  file — never a magic number inside `compareVersions.ts` (quant NEW). This mechanically prevents D3 from
  consuming degenerate W1-only data.

### Statistical validity of the D3 realized series (quant review)

- **Canonical PnL = analysis-layer both-leg-fee recomputation.** Pin this in the ADR 0029 amendment.
- **Funding asymmetry (document + assign).** Live `realized_pnl` includes `+ fundingPaid`
  (`PositionService.ts:373`); the shadow series does not. Intra/next-bar holds rarely cross an 8h
  settlement, so the error is small but non-zero and short-biased. The D3 paired diff either (a) **accepts
  a documented, bounded bias** — documentation only, no code touch; or (b) **excludes funding from the
  live side** — which requires `compareVersions` to subtract `fundingPaid` from the live `realized_pnl`,
  a change to the analysis read layer (add to file item 4 if chosen). Pick one in the ADR 0029 amendment;
  default to (a) given the bounded magnitude (logic NEW-3).
- **Selection bias (report it).** Only filled events produce PnL; miss/no-fill rate differs by version
  (v2 opened 54, v4 opened 25 on 06-16), and the `compareVersions` INNER JOIN further selects
  both-traded events. The D3 report MUST surface per-version miss/no-fill rate alongside PnL, state the
  comparison is **both-traded-only**, and quantify the paired-traded, force_close-excluded N against the
  ADR 0019 criterion-6 floor (≥200 trades / ≥100 in-regime / ≥30 days; the mean is suppressed below
  `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN = 30`).
- **Constant-equity scope.** `deriveShadowQty` uses a fixed `PAPER_STARTING_EQUITY_USDT` (no
  compounding). This is unbiased for a **paired absolute-PnL diff** (the D3 use), but invalid for a
  compounded equity curve / Sharpe / max-DD. Scope the shadow realized series to the paired diff only;
  feeding it into ADR 0019 criteria 3/4 (max-DD, worst-day %) requires an equity model and is out of
  scope.
- **Window discipline + held-out.** The D3 window `from` MUST be ≥ the M39 (W2) deploy timestamp; no
  pre/post-M39 mixing (the legacy miss/hollow rows are already filtered by the analysis SQL, but the one
  legacy complete row would contaminate a straddling window). Report the window start. Partition the
  series per the ADR 0017 walk-forward (or ≥2 sub-periods); v(n+1) must beat v(n) in each, not just
  pooled (ADR 0019 §2.2).

### Non-goals (explicit)

- **Do not raise `SHADOW_GATE_MAX_OPEN_POSITIONS`** (`strategyConsts.ts:80`) — mirrors the live
  restricted profile; raising it biases the counterfactual and only moves the lock from 1 → N.
- **Do not add a persisted `realizedPnl` field** to `ISimulatedFill` (premise corrected above).
- **Do not backfill the legacy hollow rows**, and **do not mix** pre/post-M39 rows in a D3 window.
- **Do not touch the live trade path or the backtest engine.** Shadow-only.
- No strategy changes (strategies never see slot state — ADR 0029 §2.1 cardinal rule).

## Contract / files (indicative — confirm in impl brief; ≤5 per dispatch)

1. `packages/shared` — **only** the close-reason union: `time_stop` is brand-new. The two unions differ
   (quant NEW — the prior draft mis-stated this): `ISimulatedFill.closeReason` carries
   `sl | tp | force_close | intra_bar_stop | null` (**no `reverse_signal`**), while
   `IVirtualCloseInput.closeReason` / `IVirtualLedgerSnapshot` carry `reverse_signal`. Add `time_stop`
   where it is actually emitted and reconcile it against the dormant `intra_bar_stop` (pick one; don't
   leave both). Route through **bot-shared-maintainer**. No `realizedPnl` field. (JSONB column has no CHECK →
   no migration.)
2. `apps/engine/src/strategy/service/VirtualPositionLedgerService.ts` — extend
   `ShadowCloseBySymbolReason`; exclude fee-only/`force_close` exits from the streak counter.
3. `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` — in-pass `closeBySymbol`
   after `tryOpen` with `${eventId}:exit`; deterministic timestamp + null fallback; rebuild no-op for
   resolved-exit rows; (W2) next-bar exit walk.
4. `packages/analysis` (`getPerformance`, `compareVersions`) — surface per-version miss/no-fill rate and
   the `lowFidelity`/force_close fraction for the criterion-12 guard; verify the Postgres `NUMERIC`
   recomputation matches the engine `decimal.js` value to fixed precision (money-is-decimal across the
   SQL boundary).
5. `reverse_signal` path — after W1 it becomes effectively dead in steady state (the prior event already
   closed the position); keep only for the restart-window edge case, or flag for removal. Decide + note.

## ADRs

- **Amend ADR 0029** — close-path wiring, derived `:exit` eventId, rebuild no-op rule, streak-exclusion
  of force_close, the W1-count-vs-W2-value split, canonical PnL source, funding/selection/constant-equity
  caveats.
- **ADR 0019** — record that the D3 realized precondition is **W2** (not W1); wire criterion 12
  (`lowFidelity` abstain); both-traded-only paired N; window/held-out discipline.

## Acceptance / gating

- After W1: `max_open_positions_reached` is no longer the dominant reject; the slot returns to 0 between
  opens; opens-per-version accrues; `tryClose` succeeds in-pass (no `duplicate_event_id`); restart with a
  resolved-exit row does not re-lock; ≥3 consecutive force_close exits do not trip the halt.
- After W2: shadow exits resolve to `sl`/`tp`/`time_stop` (not only `force_close`); the analysis-layer
  realized series is non-degenerate; the criterion-12 guard passes (force_close fraction below threshold).
- **D3 stays gated** on a clean **post-W2** window meeting the ADR 0019 floor on both-traded,
  force_close-excluded paired events, reported across ≥2 sub-periods. The earlier routing-based V3
  projection remains directional only — not the gate input.

## Dispatch waves

1. **Serial:** `bot-shared-maintainer` (close-reason union only).
2. **Serial:** `bot-architect` (ADR 0029 amendment + ADR 0019 criterion-12 wiring — cross-cutting).
3. **Parallel:** `bot-engine-nestjs` (ledger close path + streak exclusion) then (W2 walk); `bot-engine-nestjs`
   analysis read layer — sequenced per the ≤5-file rule.
4. **Serial:** `bot-qa-engineer` — paired tests: in-pass close succeeds; slot frees per event;
   rebuild no-op on resolved-exit; force_close streak exclusion; exit-reason mapping; analysis-vs-engine
   PnL precision; per-version miss-rate surfaced.
5. **Parallel:** `bot-review-quant` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-security`.
6. **Serial:** `bot-scribe` (work-log + STATUS + milestone-log).
