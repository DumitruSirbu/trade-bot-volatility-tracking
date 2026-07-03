# M52 — xmom `force_close` slot recovery (bounded, volatility-gated same-coin retry)

> **What M52 is.** A PAPER-mode **improvement** (not a bug fix) that closes the remaining gap left by
> the ADR 0045 fill-acceptance guard on the xmom path. Today, when a scheduled-rebalance momentum OPEN
> fill drifts far enough from its decision-time reference that the guard `force_close`'s it, the slot
> is **left empty until the next 24h cron** — the async `force_close` fires after the cascade's
> `rebalance()` has already returned, so nothing backfills the slot within the cycle. On a volatile day
> xmom can hold fewer than `top_n` (or zero) positions purely from execution-timing artifacts.
>
> M52 adds a **bounded, volatility-gated, same-coin retry** (ADR 0051): when a momentum OPEN is
> `force_close`'d, the orchestrator MAY re-attempt the **same** symbol to recover the slot — but only
> when a circuit breaker keyed on the already-logged `atrUnits` drift says the drift was small enough to
> be a plausibly-**stale reference** rather than a genuine dislocation; above the threshold the slot is
> **left empty** (skip is the expected outcome). The retry is cooldown-deferred to the next closed 5m
> bar (re-anchored, never instant), freshly sized, reservation-safe, **paper-only, and default-off**.
>
> **This is not a bug fix.** The guard is working correctly and is far cheaper than the losses it
> prevents (observed 2026-07-03: ~$0.20 `force_close` unwind vs ~$14.91 realized `stop_loss` when a
> degenerate fill is allowed to run). M52 does **not** touch the guard. It only decides what to do with
> the emptied slot, and it treats the retry as an **unvalidated adverse-selection hypothesis** that must
> be **measured in paper before it is trusted** (the soak gate below is the point of the milestone, not
> an afterthought).
>
> Every `CLAUDE.md` trading-safety invariant holds: **no order path bypasses the risk gate** (every
> retry re-enters through the unchanged gate and the unchanged ADR 0045 fill-acceptance guard),
> strategies stay pure/deterministic (the retry is orchestrator-only; the pure core is untouched),
> money stays `decimal`, no LLM in the loop, **no live capital** (paper-only, default-off, inherits
> xmom's existing HIGH go-live blockers).
>
> This milestone **implements ADR 0051**. That ADR is the source of every design decision below.

---

## Problem statement

xmom (`strategy_versions` id=20, ADR 0048/0050) runs a fixed 01:07 UTC daily cron that ranks the
universe and cascades through it opening the top `top_n = 3` winners not already held. Two facts about
that cascade collide (ADR 0051 §1.1):

1. **Slot accounting is synchronous, at gate-approval.** `rebalance()` increments `filled++` on gate
   approval and returns once `filled === top_n`. "Opened" = gate-approved / slot-reserved, not
   confirmed fill.
2. **Fill acceptance is asynchronous.** The actual fill and the ADR 0045 guard
   (`ExecutionService.rejectAndUnwindIfUnacceptable` → `evaluateFillDrift`) run **after**
   `rebalance()` has returned. If the fill degenerated (SL collapsed / below floor / R:R below
   `xmom_min_rr`), the guard unwinds via synthetic FLATTEN with `exitReason = force_close`, logging a
   `GEOMETRY_ANCHOR_DRIFT` line with `driftPct` and `atrUnits`.

**The gap:** a `force_close`'d slot is not backfilled within the same cycle. The `filled` counter is a
local variable that no longer exists when the async `force_close` fires. The slot sits empty for up to
a full day.

**Observed (2026-07-03 01:07 UTC scheduled rebalance):** FARTCOIN/USDT (`atrUnits = 1.76`,
`driftPct = 1.07%`) and WLD/USDT (`atrUnits = 1.32`, `driftPct = 0.79%`) both opened and were
`force_close`'d within ~0.1 s — the market moved sharply between the decision-time reference (latest
closed 5m bar) and the actual fill. Both slots then sat empty. The guard did exactly the right thing;
the open gap is the un-recovered slot.

---

## Goals / non-goals

### Goals

1. **Recover execution-artifact slots without buying adverse selection** — add a same-coin retry that
   fires only when the `force_close` drift was small enough to be a stale-reference artifact, and leaves
   the slot empty otherwise.
2. **Make the retry a measured decision, not an assumed win** — instrument the paper soak so the
   adverse-selection question (do retry entries underperform first-attempt entries?) is answered with
   data, and calibrate the drift threshold from the empirical drift distribution.
3. **Keep it safe by construction** — paper-only, default-off, reservation-safe, freshly sized, and
   inert in backtest; the ADR 0045 guard and the risk gate are untouched.

### Non-goals (explicitly out of scope — rejected, do not re-propose)

- **No next-ranked-coin backfill.** Opening rank #4 when a top-3 slot force-closes is a different,
  unbacktested selection rule and does nothing to address the actual cause (execution-timing drift on
  the *selected* name). The quant lean is to **prefer skip over backfill** when drift is large (ADR
  0051 §7). Same-coin retry only.
- **No faster / more frequent rebalance cron.** The xmom edge is a 24h-lookback / 24h-cadence operating
  point (EXP-011/012); sub-24h cadence re-ranks a barely-changed metric, collapses the daily exit into
  noise-trading, and churns fees (ADR 0050 §4 / M51 "cadence decided, do not relitigate"). It also does
  not target the problem. Any sub-24h cadence is a separate `EXP-0xx`. Extra observation cycles use the
  M50c manual trigger.
- **No change to the ADR 0045 fill-acceptance guard.** `evaluateFillDrift` / synthetic-FLATTEN unwind is
  byte-for-byte unchanged. M52 operates strictly downstream of it and only *consumes* its
  `GEOMETRY_ANCHOR_DRIFT` output.
- **No change to the risk gate, slot model, exposure caps, `top_n`, ranking, or the pure core.**
- **No live-capital path, no promotion-gate change.** Paper-only, default-off; inherits xmom's HIGH
  go-live blockers (ADR 0050 §3.3). M52 changes nothing about promotion eligibility.
- **No blind attempt-count cap as the primary gate.** The drift breaker is the gate; the attempt cap is
  only a loop backstop (ADR 0051 §3.1/§3.2).

---

## Design (implements ADR 0051)

### D1 — retry-eligibility circuit breaker + per-cycle attempt tracking

The decision surface. When a scheduled-rebalance momentum OPEN is `force_close`'d, decide whether to
retry the same symbol.

- **Cycle correlation.** `rebalance()` stamps a `rebalanceCycleId` (per-cycle nonce from `nowMs` + the
  trigger source) onto every momentum OPEN intent; it flows through the engine-internal
  `IOrderIntentApprovedEvent` → the fill-acceptance context (same pattern ADR 0045/0048 already use to
  carry signal-time values forward). No `packages/shared` change (engine-internal event).
- **Force-close report event.** `unwindRejectedFill` (execution layer) emits a new engine-internal
  `MOMENTUM_FILL_FORCE_CLOSED_EVENT` carrying `{ rebalanceCycleId, symbol, strategyVersionId, rank,
  atrUnitsDrift, driftPct, reason }`. `atrUnitsDrift`/`driftPct` are exactly the values
  `logGeometryAnchorDrift` already computes — **no new math in the execution layer**. The execution
  layer makes **no retry decision**; it only reports.
- **The breaker (primary gate).** The orchestrator retries only when `atrUnitsDrift <
  MOMENTUM_RETRY_MAX_ATR_DRIFT` (provisional default **1.0**; calibrated data-driven in D3). At/above
  → leave the slot empty, emit `MOMENTUM_RETRY_SKIPPED_DRIFT` metric. Under this rule the observed
  FARTCOIN (1.76) / WLD (1.32) do **not** retry — intended.
- **Attempt cap (backstop only).** `MOMENTUM_RETRY_MAX_ATTEMPTS_PER_SYMBOL = 1` per
  `(rebalanceCycleId, symbol)`, held in a small per-cycle retry ledger in the orchestrator. A second
  `force_close` of the same symbol in the same cycle is not retried (`MOMENTUM_RETRY_EXHAUSTED`).
- **Live top_n re-check.** At retry decision time, re-read the live open-momentum count
  (`positions.findOpen()` filtered to `activeVersionId`) and retry only if it is **below `top_n`** —
  never trust the stale `filled`. Abandon if the basket already refilled.

### D2 — cooldown / re-anchor retry execution path

If eligible, execute the retry — deferred and freshly built.

- **Cooldown to the next closed 5m bar.** Arm the retry; fire on the next closed 5m bar for the symbol
  (the existing bar-close ingest seam feeding `symbolStates`). Never instant — gives the snapback a bar
  to resolve and a **fresh reference anchor**. Abandon if a new `rebalanceCycleId` supersedes it (next
  cron) or after a bounded `MOMENTUM_RETRY_MAX_WAIT_MS` guard.
- **Reservation-safe ordering.** The retry fires strictly **after** the synchronous unwind has released
  the `force_close` leg's slot + exposure reservations. The reservation is still PENDING (never
  confirmed) at force_close time, so the release is `ExecutionService.unwindRejectedFill` calling
  `releaseReservationSafely` synchronously inside the unwind — **not** the `POSITION_CLOSED_EVENT` →
  `SlotReleaseListener` path, which only releases CONFIRMED reservations and is a no-op here. Either
  way it cannot double-book against `SAME_DIRECTION_EXPOSURE_CAP` / `MAX_EXPOSURE_PER_COIN_USDT`. No new
  reservation bookkeeping; the next-bar deferral guarantees the ordering.
- **Fresh sizing/geometry.** Re-run the full `buildMomentumOpenIntent` against the fresh bar: new
  entry price, recomputed ATR, fresh `sizer.size()`. **Never** reuse attempt-1 notional/geometry (ATR
  has typically risen on the mover). The rebuilt intent carries the same `rebalanceCycleId` for ledger
  attribution and re-enters the **unchanged** gate + **unchanged** ADR 0045 guard (which will
  `force_close` the retry too if its fill also degenerates — bounded by the D1 attempt cap).
- **Paper-only, default-off flag.** `XMOM_FORCE_CLOSE_RETRY` (boolean, default off), reachable **only**
  under `EXCHANGE_ENV = paper`. Flag unset → today's do-nothing behavior. Security reviewer greps for
  any path that lets the retry reach a LIVE gate (mirrors the M51 `PAPER_RELAX_PER_COIN_LIQUIDITY`
  anti-coverage requirement).

### D3 — paper-soak observability / metrics for the validation gate

The measurement layer — the point of the milestone. Instrument the soak to answer the
adverse-selection question and calibrate the threshold (ADR 0051 §6):

1. **Retry fill-acceptance rate** — retries that survive the fill-acceptance guard vs `force_close`
   again.
2. **Forward returns: retry entries vs first-attempt entries at matched horizons** — the **decisive
   adverse-selection test**.
3. **Empirical distribution of `atrUnits` drift at every `force_close`** — to calibrate
   `MOMENTUM_RETRY_MAX_ATR_DRIFT` from data (where the stale-reference cluster ends), replacing the
   provisional 1.0.
4. **Realized slippage: retry vs attempt 1.**
5. **Counterfactual PnL: retried slots vs leaving them empty.**

Deliverable is the instrumentation (counters/labels + an analysis query set, tagging retry entries so
attempt-1 vs retry is separable — reuse the `positions.trigger_source` / attribution precedent if it
fits, else a retry marker), plus registering the hypothesis in `docs/analysis/README.md` (this is a new
experiment — an `EXP-0xx` for "does force_close retry buy adverse selection?"). **No PnL claim is drawn
until data accumulates.**

**Fill-simulator fidelity caveat (carry over from M51).** If the paper fill simulator fills flat at
best-quote with zero slippage, the retry-vs-attempt-1 *slippage* metric (D3.4) and the counterfactual
PnL (D3.5) are **pipeline-validation only, not edge** — a flat-fill sim cannot show the worse-tick cost
the retry is theorized to incur. This must be annotated wherever early M52-era retry PnL is surfaced.
The **forward-return** test (D3.2) is less sensitive to this because it compares entry *timing/price
level* forward, but it must still be read with the caveat. (Verification requirement, not a simulator
change in M52.)

### D4 — soak-gate closure (go / no-go)

After the soak accumulates enough retries to measure, evaluate the ADR 0051 §6 go/no-go bar:

- **(a) No adverse selection** (hard gate): retry entries do not show materially/significantly worse
  forward returns than first-attempt entries at matched horizons (D3.2). **Fail → disable the retry**
  regardless of everything else (skip wins).
- **(b) Retries actually survive:** fill-acceptance rate materially > 0 (D3.1).
- **(c) Positive counterfactual:** retried-slot PnL ≥ leaving-empty, net of slippage (D3.5/D3.4).
- **(d) Threshold calibrated:** `MOMENTUM_RETRY_MAX_ATR_DRIFT` set from the measured drift distribution
  (D3.3), not the provisional guess.

If (a) fails → disable. If (a) holds but (b)/(c) marginal → tighten the threshold (retry only the
smallest-drift band) and re-measure. Only when all four hold is the retry recommended to stay on **in
paper** (live remains blocked by xmom's HIGH go-live blockers). D4 output: the analysis writeup, the
disposition (keep-on / tighten / disable), and the calibrated threshold value.

---

## Deliverables / tasks (≤ 5 items, minimum surface)

> Per `docs/best-practices/dev-qa-cycle.md` §1: touch the minimum surface, each code item ships a paired
> test (fails before / passes after), and any contract re-interpretation STOPs and surfaces to the
> architect (ADR 0051 pre-blesses the contract). Blocking code deliverables are **D1 + D2**; D3 is
> observability (blocking for the soak to be meaningful); D4 is analysis and closes after soak data.

| # | Deliverable | Blocking? | Primary files (indicative) | Tests |
|---|-------------|-----------|----------------------------|-------|
| **D1** | Retry-eligibility circuit breaker + per-cycle attempt tracking: stamp `rebalanceCycleId` on momentum open intents; emit engine-internal `MOMENTUM_FILL_FORCE_CLOSED_EVENT` from `unwindRejectedFill` carrying the already-logged `atrUnitsDrift`; orchestrator breaker (`atrUnitsDrift < MOMENTUM_RETRY_MAX_ATR_DRIFT`) + attempt ledger (`MOMENTUM_RETRY_MAX_ATTEMPTS_PER_SYMBOL = 1`) + live-`top_n` re-check | **Yes** | `strategy/const/strategyConsts.ts` (new consts), `strategy/service/MomentumOrchestratorService.ts` (cycle id, ledger, listener, breaker), `execution/service/ExecutionService.ts` (emit report event in `unwindRejectedFill`), engine-internal event interface | Paired unit tests: drift 0.8 → eligible, drift 1.0/1.76 → skipped (`MOMENTUM_RETRY_SKIPPED_DRIFT`); 2nd force_close same symbol/cycle → `MOMENTUM_RETRY_EXHAUSTED`; live count already at `top_n` → abandoned; observed FARTCOIN(1.76)/WLD(1.32) → not retried |
| **D2** | Cooldown/re-anchor retry execution path: arm on next closed 5m bar, rebuild intent fresh (new price/ATR/`sizer.size()`), fire after reservation release, behind default-off paper-only `XMOM_FORCE_CLOSE_RETRY` | **Yes** | `strategy/service/MomentumOrchestratorService.ts` (armed retry, next-bar fire, fresh build), `config/service/AppConfigService.ts` (flag read) | Paired: eligible retry re-sizes fresh (not attempt-1 notional); fires on next 5m bar not instantly; abandoned if superseded by new cycle or `MAX_WAIT_MS`; **flag off → no retry (current behavior)**; **flag on + LIVE env → retry NOT reachable (anti-coverage)**; retry re-enters the unchanged gate + unchanged ADR 0045 guard |
| **D3** | Paper-soak observability + metrics + hypothesis registration for the validation gate (retry fill-acceptance rate, retry-vs-attempt-1 forward returns, force_close `atrUnits` drift distribution, slippage, counterfactual PnL); annotate the flat-fill sim caveat | **Yes (for a meaningful soak)** | metric labels at the force_close/retry seams, analysis query set (`docs/analysis/`), `docs/analysis/README.md` (new `EXP-0xx`), retry-entry attribution marker | Test: a retry entry is tagged/separable from a first-attempt entry; metrics increment on the right transitions |
| **D4** | Soak-gate closure — evaluate the ADR 0051 §6 go/no-go bar; disposition (keep-on / tighten / disable) + calibrated `MOMENTUM_RETRY_MAX_ATR_DRIFT`; analysis writeup | Closes after soak | analysis writeup + tech-debt/analysis updates; possible const value change | n/a (analysis); if the threshold const changes, a boundary test at the new value |
| **D5** | (Docs) Record the "backfill and faster-cron rejected" decisions so future readers don't re-propose them | Docs | this plan (done) + ADR 0051 §7 | n/a |

**Wave/dispatch note.** D1 and D2 are separable and should be **two sequential engine dispatches** with
a mini-review between (D1 first — the decision surface + the report event; then D2 — the deferred
execution path), each within the ≤5-file cap. Both touch the engine-internal event and the orchestrator
determinism boundary — ADR 0051 pre-blesses the contract, so no `bot-shared-maintainer` wave is needed
(the event is engine-internal). D3 is observability + an analysis-doc change; if a retry-attribution
marker crosses into `packages/shared`, route that piece through `bot-shared-maintainer` first. D4 is a
scribe/analysis close after soak data accumulates.

---

## Testing strategy

Per `dev-qa-cycle.md` §2/§4 — each blocking code deliverable ships a paired test (fails before / passes
after); adversarial coverage is the bar; adversarial failures route to the architect.

**Happy path (regression backbone):**

1. **D1 — small-drift force_close is eligible.** A momentum OPEN force-closed at `atrUnits = 0.8`, with
   the live basket below `top_n`, is marked retry-eligible.
2. **D2 — eligible retry fires fresh on the next bar.** The armed retry fires on the next closed 5m bar,
   rebuilds the intent with a fresh `sizer.size()` (new ATR), and re-enters the gate.

**Adversarial (the bar for done):**

3. **D1 — breaker skips large drift.** `atrUnits = 1.76` (FARTCOIN) and `1.32` (WLD) → **not** retried;
   `MOMENTUM_RETRY_SKIPPED_DRIFT` counted; slot left empty. (The observed case.)
4. **D1 — attempt cap.** A retry that itself force-closes is **not** retried again in the same cycle
   (`MOMENTUM_RETRY_EXHAUSTED`).
5. **D1 — basket already full.** If the live open-momentum count reached `top_n` before the retry fires
   (concurrent fill / manual rebalance), the retry is abandoned — never overfills.
6. **D1 — no stale-counter trust.** The retry keys off the live `positions.findOpen()` count, not the
   local `filled` (which no longer exists post-`rebalance()`).
7. **D2 — reservation released before retry.** The retry fires only after
   `ExecutionService.unwindRejectedFill`'s synchronous `releaseReservationSafely` call has run (not the
   `POSITION_CLOSED_EVENT` → `SlotReleaseListener` path, which is a no-op for a never-confirmed
   reservation); assert no transient double-book against `SAME_DIRECTION_EXPOSURE_CAP` / per-coin
   exposure.
8. **D2 — fresh sizing, never attempt-1 reuse.** Retry notional/geometry derives from the fresh bar, not
   the frozen attempt-1 values.
9. **D2 — never instant.** The retry does not fire on the force_close tick; it waits for the next closed
   5m bar; superseded/`MAX_WAIT_MS` → abandoned.
10. **D2 — default off.** Flag unset → identical to current behavior (slot left empty, no retry).
11. **D2 — anti-coverage: retry never reaches LIVE.** Flag on **but** `EXCHANGE_ENV` LIVE → the retry
    path is unreachable; asserted **not** taken. Security-critical test.
12. **D2 — unchanged guard still applies to the retry.** The retry fill re-runs `evaluateFillDrift`; a
    degenerate retry fill is force-closed exactly like any open (bounded by the attempt cap).
13. **D3 — retry entry is separable.** A retry entry is tagged/distinguishable from a first-attempt
    entry so the forward-return comparison is possible.

**Live-app PAPER smoke (mandatory before close, `dev-qa-cycle.md` §6.4).** Boot the app in PAPER with
`XMOM_FORCE_CLOSE_RETRY = true`, drive `pnpm rebalance:trigger`, and confirm the retry path is exercised
without `ERROR` / DI-cycle / boot-pipeline failure — ideally observe at least one small-drift
force_close → eligible retry (or, if none occurs naturally, a targeted test harness that injects a
small-drift force_close event and asserts the armed-retry path). Large-drift force_closes must be
observed to **skip** (leave the slot empty), matching the observed FARTCOIN/WLD behavior.

---

## Rollout / reversibility

- **D1 + D2** are **default-off and paper-only**: shipping the code changes nothing until an operator
  sets `XMOM_FORCE_CLOSE_RETRY = true` in a PAPER environment. Reversible by unsetting the flag (no
  redeploy). It can never affect LIVE (reviewer-verified, test #11), and cannot affect backtest (the
  retry is triggered by a live/paper force_close, which cannot occur on deterministic backtest fills —
  ADR 0045 §D2.8 / ADR 0051 §5).
- **No DB migration** expected (config + orchestrator state + engine-internal event only). If
  implementation finds a migration unavoidable (e.g. a persisted retry-attribution column), the engineer
  STOPs and surfaces it (CLAUDE.md rule-9 dump + confirm flow).
- **The ADR 0045 guard and the risk gate are byte-for-byte unchanged** — M52 is strictly additive
  downstream of them.
- **Operator runbook after deploy:** confirm `strategy_versions` id=20 params are `{}` (24h defaults),
  set `XMOM_FORCE_CLOSE_RETRY = true` in the paper soak env, then either wait for the 01:07 cron or drive
  `pnpm rebalance:trigger`. Let the soak accumulate force_close + retry events; do **not** draw any PnL
  conclusion until D4's go/no-go bar has the data.

---

## ADR impact

- **ADR 0051 (this milestone's ADR) — new, Proposed.** Documents the bounded volatility-gated same-coin
  retry, the rejected alternatives (immediate uncapped retry, next-ranked-coin backfill, faster cron,
  weakening the guard), the concrete mechanism (cycle id, report event, breaker, attempt cap, cooldown
  re-anchor, reservation ordering, fresh sizing), and the paper-soak validation gate with the explicit
  go/no-go bar. Status stays **Proposed** until D4 passes the gate (then it moves to Accepted, or is
  superseded/withdrawn if the retry is disabled).
- **ADR 0045 — unchanged** (consumed, not amended). ADR 0048 / 0050 / 0004 — unchanged (composed with).
- Update `docs/architecture/adr/README.md` (Strategy section) to reference ADR 0051.

---

## What NOT to change (scope boundaries)

- **The ADR 0045 fill-acceptance guard** (`evaluateFillDrift` / synthetic-FLATTEN unwind) — byte-for-byte
  unchanged.
- **The risk gate, slot model, exposure caps, `top_n`, ranking, pure core** — untouched.
- **The rebalance cadence** (`7 1 * * *` UTC cron) — unchanged; no next-ranked-coin backfill; no faster
  cron (both explicitly rejected — ADR 0051 §7).
- **No live-capital path, no promotion-gate change, no new order type, no new rate-limit bucket.**

---

## Open questions

1. **Retry-entry attribution mechanism (D3).** Reuse the `positions.trigger_source` attribution pattern
   (ADR 0048 §M50c) for retry entries, or a dedicated retry marker? Decide during D3 design; if it
   crosses `packages/shared`, route through `bot-shared-maintainer`.
2. **Fill-simulator slippage on retry fills (D3 caveat).** Does the paper fill simulator charge
   book-impact slippage on the retry fill, or fill flat at best-quote? If flat, the retry-vs-attempt-1
   slippage + counterfactual-PnL metrics are pipeline-validation only and must be annotated. A slippage
   model, if needed, is a separate follow-up.
3. **How much soak data before D4 can decide?** The go/no-go bar needs enough force_close + retry events
   to compare forward returns with any confidence. The success criterion is a **defensible
   adverse-selection read**, not a fixed calendar window; D4 stays open until the sample supports a call.
4. **Cooldown horizon (D2).** Next closed 5m bar is the ADR default; confirm it is the right cooldown vs
   a slightly longer re-anchor during implementation if the 5m snapback is too short to resolve the
   vacuum — measurable in D3.

---

## Supersedes / links

- **Implements** ADR 0051 (xmom force_close slot recovery).
- **Builds on** M50 / M50b (ADR 0048, 0050), M50c (manual trigger, ADR 0048 §M50c), M51 (paper-gate
  unblock — the soak this measurement rides on), and M38/M47/M48 (ADR 0045 fill-acceptance guard, whose
  `GEOMETRY_ANCHOR_DRIFT` output this consumes).
- **Does not affect** the M44 shadow-fidelity gate or the M50 live-promotion gate — both remain open and
  unchanged.
