# ADR 0051 — xmom `force_close` slot recovery: bounded, volatility-gated same-coin retry

- **Status:** Proposed (paper-only; default-off; trusted only after the M52 soak gate — §7)
- **Date:** 2026-07-03
- **Milestone:** M52 (D1–D4)
- **Composes with:** ADR 0045 (fill-acceptance guard / `evaluateFillDrift` / synthetic-FLATTEN unwind
  — **unchanged**; this ADR consumes its `GEOMETRY_ANCHOR_DRIFT` output), ADR 0048 (rebalance
  orchestrator — the retry lives at the same orchestrator impurity boundary), ADR 0050 (rank-cascade
  + `top_n` basket — the retry recovers a slot the cascade counted but the fill lost), ADR 0004 (risk
  gate / slots / exposure caps — **unchanged**; every retry re-enters through the same gate).
- **Amends:** the core retry (§1–§7) is additive behavior gated behind a default-off, paper-only flag.
  The **M52a amendment** additionally narrows two `RiskGateService` stateful-limit checks so a mechanical
  `force_close` no longer counts as a trading loss: (a) retry-entry intents are exempt from
  cooldown-after-loss (paper-only reach), and (b) the consecutive-loss halt streak excludes
  `force_close` legs (**global**, LIVE and paper — see ADR 0004 §5).

> **ADR numbering note.** The next free number after `0050` is **0051**; this ADR uses it.

---

## 1. Context

### 1.1 What happens today

xmom (`strategy_versions` id=20, ADR 0048/0050) is long-only cross-sectional momentum: a fixed 01:07
UTC daily cron (ADR 0050 §4) re-ranks the universe by trailing 24h return and cascades through the
ranking, opening the top `top_n = 3` winners not already held
(`MomentumOrchestratorService.rebalance`).

Two facts about that cascade collide:

1. **Slot accounting is synchronous, at gate-approval.** The cascade loop calls `processOpen` →
   `RiskGateService.evaluate`; on approval it increments `filled++` and records the symbol in
   `retained`, then moves on. "Opened" means **gate-approved / slot-reserved**, not confirmed fill
   (ADR 0050 §2.2). `rebalance()` returns once the walk hits `filled === top_n`.

2. **Fill acceptance is asynchronous, out-of-band.** The actual fill and the ADR 0045
   fill-acceptance guard (`ExecutionService.rejectAndUnwindIfUnacceptable` →
   `exitGeometryHelper.evaluateFillDrift`) run **after** `rebalance()` has already returned, on the
   `ORDER_INTENT_APPROVED_EVENT` → fill event chain. That guard recomputes SL/TP geometry against the
   **actual fill price**; if the fill drifted far enough from the decision-time reference (SL
   collapsed, SL below floor, or fill-anchored R:R below `xmom_min_rr` — ADR 0045 §D2.9), it
   immediately unwinds the position via a synthetic FLATTEN with `exitReason = force_close`, logging a
   `GEOMETRY_ANCHOR_DRIFT` line that already reports `driftPct` and `atrUnits`
   (`ExecutionService.logGeometryAnchorDrift`).

**The gap:** a slot the cascade counted as `filled` but the fill-acceptance guard then
`force_close`'d is **not backfilled within the same rebalance cycle**. The orchestrator's `filled`
counter is a local variable that no longer exists by the time the async `force_close` fires. The slot
just sits empty until the next 01:07 cron — up to a full day. On a volatile day this can leave xmom
holding fewer than `top_n` (or zero) positions purely from execution-timing artifacts, not from a
genuine absence of good candidates.

### 1.2 The observation that motivated this (not a bug — the guard worked)

In the **2026-07-03 01:07 UTC** scheduled rebalance, **FARTCOIN/USDT** (`atrUnits = 1.76`,
`driftPct = 1.07%`) and **WLD/USDT** (`atrUnits = 1.32`, `driftPct = 0.79%`) both opened and were
`force_close`'d within ~0.1 s — the market moved sharply between the decision-time reference (latest
closed 5m bar) and the actual fill.

**This is the guard working exactly as designed, and in this instance it was far cheaper than the loss
it prevents:** these two unwinds cost ~$0.20 apiece to reverse under the calm conditions of this
sample, versus a ~$14.91 realized `stop_loss` on the same strategy when a degenerate-geometry fill was
*allowed* to run. **That ~$0.20 is a single low-volatility observation, not the cost of a `force_close`
in general** — the close leg carries mandatory adverse tier-floor slippage (M52a-2), so on a volatile
day or a higher tier the unwind cost can be an order of magnitude larger. What holds generally is the
*direction* of the trade-off (unwinding a degenerate-geometry fill is cheaper than letting it run to a
stop), not the specific dollar figure. Nothing here proposes weakening the guard. The guard stays
byte-for-byte (ADR 0045 unchanged). This ADR only decides **what to do with the now-empty slot**: leave
it empty for a day, or attempt a bounded, carefully-gated recovery.

### 1.3 Why a naive "just retry" is wrong (quant review, authoritative)

The quant review of this exact case is the primary input to the decision below. Its load-bearing
findings:

- A `GEOMETRY_ANCHOR_DRIFT` of 1.3–1.8 ATR units means price gapped **in our (long) favor** between
  decision and fill — this is precisely the "fast-mover entry slippage" already flagged as an
  unmodeled cost in EXP-011/012 (D10 winners averaged +22.6% trailing return; entering them slips
  worse than the modeled tier2 floor). At the sub-minute timescale of an immediate retry,
  **liquidity-vacuum snapback dominates the 24h momentum-continuation thesis** — an immediate same-coin
  retry systematically buys the worst tick with no offsetting edge at that timescale (adverse
  selection).
- Because sizing is ATR-risk-normalized, dollar risk stays roughly constant across a retry, but the
  **rising ATR** on a fast mover shrinks the position and seats it closer to the reversion zone — a
  retry quietly buys a **degraded** position, not a corrected one.
- Therefore: **no blind attempt-count cap.** Gate any retry behind a **volatility-conditioned circuit
  breaker keyed on the already-logged `atrUnits` drift** — retry only when drift is small (the
  "stale-reference" range), skip entirely above a threshold (illustrative cut ~1.0 ATR unit) because
  that is a genuine dislocation, not a stale-reference artifact. Under this rule neither FARTCOIN
  (1.76) nor WLD (1.32) would have retried — consistent with the locked risk philosophy that **"skip
  is an acceptable/expected outcome," not a failure to be worked around.**
- If a retry does fire it must **not be instant** — cooldown to the next closed 5m bar rather than
  refiring into the same liquidity-vacuum tick.
- Risk-limit interactions: the `force_close` leg's slot/exposure reservation must be **fully released**
  before a retry reserves again (else `SAME_DIRECTION_EXPOSURE_CAP` / per-coin exposure transiently
  double-book, since `filled++` counts at gate-approval, not confirmed fill); a retry must **re-run
  `sizer.size()` fresh** (never reuse attempt-1 notional/geometry).
- Quant's lean, recorded: **prefer skip over both same-coin retry and next-ranked-coin backfill when
  drift is large; retry-same-coin only makes sense in the narrow band of small, plausibly-stale
  drift.**

### 1.4 Invariants this ADR must not break

Pure/deterministic core (the retry is gate-dependent and impure → orchestrator-only, never the core),
no order path bypassing the risk gate (every retry re-enters through `RiskGateService.evaluate`), no
LLM in the loop, money is `decimal`, and **no live capital** — xmom is paper-only (ADR 0047 §2.6); the
retry ships default-off and paper-gated, and inherits xmom's existing HIGH go-live blockers.

---

## 2. Decision 1 — recover the slot, but only via a bounded, volatility-gated **same-coin** retry

**Decision:** when a scheduled-rebalance momentum OPEN fill is `force_close`'d by the ADR 0045
fill-acceptance guard, the orchestrator MAY re-attempt **the same symbol** to refill the slot within
the same rebalance cycle — but **only** when a volatility circuit breaker keyed on the logged
`atrUnits` drift says the drift was small enough to be a plausibly-stale reference rather than a
genuine dislocation. Above the breaker threshold the slot is **left empty** (skip is the expected
outcome). The retry is:

- **same-coin only** (no next-ranked-coin backfill — Decision 4 / §7),
- **drift-gated** (breaker on `atrUnits`, not a blind attempt count — §3.1),
- **attempt-capped** as a safety backstop only (§3.2),
- **cooled down to the next closed 5m bar and re-anchored** (never instant — §3.3),
- **reservation-safe** (fires only after the `force_close` reservation is fully released — §3.4),
- **freshly sized** (re-runs the full open-intent build + `sizer.size()` — §3.5),
- **paper-only, default-off** (§4), and
- **trusted only after the M52 soak gate passes** (§6).

### 2.1 The retry lives in the orchestrator, driven by an out-of-band event — never in the core, never in the cascade loop

The cascade loop cannot host the retry: the `force_close` is asynchronous and fires **after**
`rebalance()` has returned (§1.1). The retry is therefore an **out-of-band, event-driven** step, and it
belongs in `MomentumOrchestratorService` — the sanctioned impurity boundary that already owns
clock/state/gate-touching logic (ADR 0048 §4, ADR 0050 §2.1). It must **not** touch
`crossSectionalMomentumCore`: the core stays a pure function of `(universe, params, nowMs)`; the retry
reads live gate state, live open-position counts, and a wall-clock bar-close — all impure, all already
allowed in the orchestrator.

**Correlation mechanism (cycle identity).** Each `rebalance()` invocation stamps a
**`rebalanceCycleId`** (a per-cycle nonce derived from `nowMs` + the trigger source) onto every
momentum OPEN intent it emits. That id flows through the existing engine-internal
`IOrderIntentApprovedEvent` → the fill-acceptance context, unchanged in spirit from how ADR 0045/0048
already carry signal-time values forward on the approved event. The orchestrator keeps a small
per-cycle retry ledger keyed by `rebalanceCycleId`.

**Signal from the execution layer (additive, engine-internal).** When `unwindRejectedFill` force-closes
an **OPEN momentum** position, the execution layer emits a new engine-internal event —
`MOMENTUM_FILL_FORCE_CLOSED_EVENT` — carrying `{ rebalanceCycleId, symbol, strategyVersionId, rank,
atrUnitsDrift, driftPct, reason }`. `atrUnitsDrift`/`driftPct` are exactly the values
`logGeometryAnchorDrift` already computes (§1.1) — no new math in the execution layer, just surfacing
the number it already logs. The execution layer makes **no retry decision**; it only reports the
`force_close` with the drift it measured. All of `{ rebalanceCycleId, rank }` originate on the intent
the orchestrator stamped, so the event is self-describing.

The orchestrator listens for that event and runs the retry-eligibility decision (§3). This keeps the
gate-dependent, impure logic in the orchestrator and the pure core untouched.

### 2.2 "Recover the slot" is bounded by the live top_n count, re-checked at retry time

Because `filled++` counts at gate-approval and a `force_close` happens after `rebalance()` returns, the
`filled` counter is stale and gone. The retry therefore **never** trusts the old counter. At retry
decision time the orchestrator re-reads the **live** count of open momentum positions
(`positions.findOpen()` filtered to `activeVersionId`, the same source the cascade uses) and only
retries if that live count is **below `top_n`**. If another slot filled in the interim (or an operator
manually rebalanced), the retry is abandoned — the basket is already full. This makes the retry
idempotent against concurrent fills and impossible to overfill the basket.

---

## 3. Decision 2 — the concrete retry mechanism

### 3.1 The volatility circuit breaker (the primary gate)

A retry is **eligible** only when the `force_close`'s measured `atrUnitsDrift` is **below** a
threshold constant `MOMENTUM_RETRY_MAX_ATR_DRIFT` (proposed provisional default **1.0** ATR unit,
matching the quant's illustrative cut). At or above the threshold the drift is treated as a genuine
dislocation, the slot is left empty, and a counted `MOMENTUM_RETRY_SKIPPED_DRIFT` metric is emitted.

- **Why `atrUnits`, not `driftPct`.** ATR-unit drift is regime-independent (ADR 0045 §D2.12 chose it
  as the canary for exactly this reason): 1% drift means very different things on a placid tier1 name
  vs a fast mover. The breaker must key on the volatility-normalized measure.
- **The threshold is provisional and MUST be calibrated data-driven.** 1.0 is an illustrative starting
  point, not a validated value. The M52 soak (D3) records the **empirical distribution of `atrUnits`
  drift at every `force_close`** so the threshold is set from the data — where the "stale-reference"
  cluster ends and the "genuine dislocation" tail begins — rather than guessed. Until the soak
  calibrates it, the retry ships **default-off** (§4).
- **Under this breaker, the observed case does not retry.** FARTCOIN (1.76) and WLD (1.32) both exceed
  1.0 → both leave the slot empty. This is the intended behavior: those were genuine fast-mover
  dislocations, and skip is correct.

### 3.2 Attempt cap — a safety backstop, not the gate

The breaker (§3.1) is the *gate*; the attempt cap is only a backstop against pathological oscillation
(fill → `force_close` → retry → `force_close` → retry …). **At most one retry per symbol per
rebalance cycle** (`MOMENTUM_RETRY_MAX_ATTEMPTS_PER_SYMBOL = 1`), tracked in the per-cycle retry
ledger (§2.1) keyed by `(rebalanceCycleId, symbol)`. A second `force_close` of the same symbol in the
same cycle is not retried again — the slot is left empty, `MOMENTUM_RETRY_EXHAUSTED` counted. Per the
quant, the cap is **not** the primary decision surface (a blind attempt-count cap would keep buying the
worst tick); it exists solely to bound the loop.

### 3.3 Cooldown + re-anchor to the next closed 5m bar (never instant)

A retry does **not** refire into the same liquidity-vacuum tick. When a retry is eligible, the
orchestrator **arms** it and fires on the **next closed 5m bar for that symbol** (the existing
bar-close ingest seam that already feeds `symbolStates`), then rebuilds the open intent from that fresh
bar. This gives two things the quant requires: a real cooldown (the snapback has a bar to resolve) and
a **fresh reference anchor** — the retry's decision-time reference is the new closed bar, not the stale
one that produced the drift. If no fresh bar arrives within a bounded window (e.g. the retry is
abandoned if a new `rebalanceCycleId` supersedes it — the next daily cron — or after a small
`MOMENTUM_RETRY_MAX_WAIT_MS` guard), the retry is dropped and the slot left empty. In practice the next
5m bar is ≤5 min away, far inside the 24h cycle, so this rarely trips.

Determinism note: the arm-to-next-bar wait uses the orchestrator's injected `ClockPort` / the bar-close
event, both already inside the orchestrator impurity boundary — no wall-clock or timer leaks into the
pure core. The retry path is inert in backtest (§5).

### 3.4 Reservation release ordering (correctness-critical)

The `force_close` leg's slot and same-direction/per-coin **exposure reservations must be fully released
before the retry reserves again**, or the retry could transiently double-book against
`SAME_DIRECTION_EXPOSURE_CAP` or `MAX_EXPOSURE_PER_COIN_USDT` (recall `filled++` and the reservation
are taken at gate-approval, not confirmed fill). The force_close reservation is still **PENDING**
(never confirmed — `confirmReservationSafely` only runs on a successful open, `ExecutionService.ts`),
so `POSITION_CLOSED_EVENT` → `SlotReleaseListener` → `ReservationLedger.releaseConfirmedReservationsFor`
is a **no-op** for this leg (it only releases CONFIRMED reservations). The actual release is
`ExecutionService.unwindRejectedFill` calling `releaseReservationSafely(event.reservationId)`
**synchronously**, inside the same unwind that emits `force_close` (`ExecutionService.ts:1245`). The
retry is **sequenced after** that release: the retry fires on the next-bar seam (§3.3), which is
strictly later than the synchronous unwind, and at fire time the orchestrator re-checks the live open
count (§2.2) and re-enters the **unchanged** gate — which re-evaluates all caps against the
now-released ledger. No new reservation bookkeeping is introduced; the retry simply cannot run before
the release has already happened.

### 3.5 Fresh sizing and geometry — never reuse attempt 1

The retry re-runs the **full** `buildMomentumOpenIntent` path against the fresh 5m bar: new entry
price, freshly recomputed ATR, and a fresh `sizer.size()`. It **never** reuses attempt-1 notional,
ATR distance, or SL/TP geometry. This is mandatory because ATR has typically risen on a fast mover
(§1.3): reusing the old size would mis-risk the position. The rebuilt intent carries the same
`rebalanceCycleId` (for ledger attribution) but is otherwise a first-class new open through the
unchanged gate — including the unchanged ADR 0045 fill-acceptance guard, which will `force_close` the
retry too if *its* fill also degenerates (bounded by the §3.2 attempt cap).

---

## 4. Decision 3 — paper-only, default-off, operator-opt-in

The retry ships behind a **default-off** flag `XMOM_FORCE_CLOSE_RETRY` (boolean), reachable **only**
when `EXCHANGE_ENV = paper`. With the flag unset the behavior is exactly today's: a `force_close`'d
slot is left empty until the next cron. Turning the retry on is an explicit operator action in a paper
environment, mirroring the M51 `PAPER_RELAX_PER_COIN_LIQUIDITY` precedent (ADR 0042 §9): default-off,
paper-gated by construction, reviewer-verified unreachable from any LIVE path.

This is deliberate: the retry is an **unvalidated** behavior until the M52 soak measures adverse
selection (§6). It must not be a silent default, and it must never reach live capital before both (a)
the soak gate passes and (b) xmom clears its existing HIGH go-live blockers (ADR 0050 §3.3 correlation
gap). The retry inherits, and does not relax, those blockers.

---

## 5. Invariants this ADR defends

- **Pure, deterministic core.** `crossSectionalMomentumCore` is untouched. The retry (gate-dependent,
  clock-dependent, impure) lives wholly in the orchestrator (§2.1).
- **No order path bypasses the risk gate.** Every retry is a fresh `IOrderIntent` through the
  **unchanged** `RiskGateService.evaluate`, and through the **unchanged** ADR 0045 fill-acceptance
  guard (§3.5). No new order path, no new gate rule, no weakening of the fill-acceptance guard.
- **The fill-acceptance guard is unchanged.** ADR 0045's `evaluateFillDrift` / synthetic-FLATTEN
  unwind is byte-for-byte the same; this ADR only *consumes* its `GEOMETRY_ANCHOR_DRIFT` output and
  adds a report event (§2.1).
- **Money is `decimal`.** Sizing/exposure/geometry stay `decimal.js` in the unchanged sizer and gate;
  the breaker compares `atrUnits` (already a decimal-derived value).
- **No LLM in the loop.** A drift threshold, an attempt cap, a bar-close tick, and gate re-entry — no
  model call.
- **No live capital.** Paper-only, default-off (§4); inherits xmom's HIGH go-live blockers.
- **Backtest parity preserved trivially.** The retry is triggered by a live/paper `force_close`, which
  cannot occur in backtest (backtest fills are deterministic, no slippage → `evaluateFillDrift` is
  live-only, ADR 0045 §D2.8). The retry path is therefore inert in backtest, exactly like the guard it
  hangs off — no parity divergence.

---

## 6. Paper-soak validation gate (the go/no-go bar — MUST pass before the retry is trusted)

The retry ships **default-off**; M52 turns it on **in paper only** and measures the following before
any recommendation to leave it on. This is the decisive work — the retry is a hypothesis about
recovering execution-artifact slots without buying adverse selection, and it must be **measured, not
assumed**.

**Metrics to collect (D3):**

1. **Retry fill-acceptance rate** — of retries that fire, how many survive the fill-acceptance guard vs
   `force_close` again. A near-zero survival rate means retries just re-hit the vacuum → disable.
2. **Forward returns of retry entries vs first-attempt entries at matched horizons** — the **decisive
   adverse-selection test**. If retry entries underperform first-attempt entries at matched horizons,
   the retry is buying the worst tick (quant §1.3) and must be tightened or disabled.
3. **Empirical distribution of `atrUnits` drift at every `force_close`** — to calibrate
   `MOMENTUM_RETRY_MAX_ATR_DRIFT` **data-driven** (where the stale-reference cluster ends), replacing
   the provisional 1.0.
4. **Realized slippage: retry vs attempt 1** — confirms/denies the "retry buys a worse tick"
   hypothesis directly.
5. **Counterfactual PnL: retried slots vs leaving them empty** — the bottom-line test of whether the
   whole mechanism adds value over the current do-nothing behavior.
6. **`force_close` realized-PnL distribution (magnitude *and* sign, split by `coin_tier` and trigger
   type)** — tests the M52a-2 premise directly. The first M52a draft assumed `force_close` is
   fee-only; the code applies mandatory adverse tier-floor slippage on the close leg
   (tier1 0.15% / tier2 0.5% / tier3 1.0%), so the realized loss is expected to be slippage-dominated.
   This measures whether it is, which sizes the money bleed the daily-loss limit (M52a-3) must absorb.

**Go / no-go bar (D4 closure):** the retry is recommended to stay **on** only if **all** hold:

- **(a) No adverse selection:** retry entries do **not** show materially/§-significantly worse forward
  returns than first-attempt entries at matched horizons (metric 2). *This is the hard gate — if it
  fails, the retry is disabled regardless of everything else, per the quant lean (§7 / §1.3).*
- **(b) Retries actually survive:** retry fill-acceptance rate is materially above zero (metric 1) —
  the mechanism recovers real slots, not phantom churn.
- **(c) Positive counterfactual:** counterfactual PnL of retried slots ≥ leaving them empty (metric 5),
  net of realized slippage (metric 4).
- **(d) Threshold calibrated:** `MOMENTUM_RETRY_MAX_ATR_DRIFT` is set from the measured drift
  distribution (metric 3), not the provisional guess.

If (a) fails → **disable the retry** (skip wins; quant §7). If (a) holds but (b)/(c) are marginal →
**tighten** the drift threshold (retry only the smallest-drift band) and re-measure. Only when all four
hold is turning the flag on in a future live path even *considered* (and even then it remains blocked
by xmom's existing HIGH go-live blockers, §4).

### 6.1 Metric definitions — the D3 measurement contract (amended post-D3 review)

The D3 query (`getRetryAttribution`) is the *only* lens D4 reads these gates through, so the metric
definitions are load-bearing and specified here precisely. This subsection was added after the D3
review surfaced two measurement biases in the first implementation of metric 2, both of which pushed
the **hard** gate (a) toward a false "looks fine." No real soak data exists yet, so correcting the
definitions now — before any number is read — is the whole point.

**Metric 2 is a per-notional return, not a raw-dollar comparison.** Sizing is ATR-risk-normalized
(§3.5): a risen post-drift ATR shrinks the retry's notional for the same dollar risk. Comparing raw
`realized_pnl` therefore compresses the retry arm toward zero purely from size, so a genuinely
worse-per-unit-exposure retry entry can show a *smaller* dollar loss than a first attempt and look
benign. Metric 2 MUST compare a size-invariant **return on entry notional**,
`realized_pnl / entry_notional` (both existing, non-null columns), per matched `(coin_tier, ATR%-band)`
cell. This is exactly the "forward return at matched horizons" the gate language already intends. A
per-`effective_risk_usdt` R-multiple was rejected: no such column exists (it would force another
migration), and within an ATR%-matched cell it differs from return-on-notional only by a near-constant
SL-distance factor, so it yields the same sign and ranking of adverse selection.

**Metric 2 excludes `force_close` legs from both arms; metrics 1 and 5 include them.** A `force_close`
leg's `realized_pnl` is an unwind artifact (fees + mandatory close-leg tier-floor slippage, magnitude
per M52a-2), not a forward return — including it in metric 2's
attempt-1 arm dilutes the baseline with off-thesis rows for exactly the coins that got retried (every
retry is preceded by an attempt-1 `force_close`), biasing the delta toward "less adverse." Metric 2's
row source therefore fences `exit_reason <> 'force_close'` on **both** arms. This bias compounds with
(does not cancel) the sizing bias above — both make retries look better than reality — so both fixes
are required. In contrast, metric 5 (counterfactual) and metric 1 (survival) MUST retain `force_close`
retry legs: a force-closed retry's unwind cost is a real cost of the mechanism vs an empty slot, and it
is the numerator of the survival rate. The two row sources are therefore distinct and must not share a
single fenced query.

**Metric 2 reports sample size and dispersion.** Gate (a)'s "materially/§-significantly worse" language
is unevaluable without it. Each matched cell reports, per arm, the count (already present) and the
population stddev of the per-notional return, plus the standard error of the delta
(`sqrt(s²_retry/n_retry + s²_attempt1/n_attempt1)`) so a thin-cell single-trade artifact is
distinguishable from genuine adverse selection at a glance. This is instrumentation, not a stats
engine — no t-test, no p-value machinery.

**Metric 3 drift histogram is tightened to 0.25-wide bands** through the calibration-relevant range so
D4 can place `MOMENTUM_RETRY_MAX_ATR_DRIFT` off a fine grid rather than the old 0.5 one. The histogram
remains an eyeballing aid for the cluster boundary; the final threshold is still set from the **raw**
`force_close_atr_units_drift` column, which is the source of truth.

**Metric 4 (realized slippage) stays deferred, not in this query.** It is blocked on a slippage-aware
fill simulator, not on query design — under the flat-fill sim (the caveat already on the report),
`slippage_model_pct` is the model's own input, so surfacing it would report a circular constant, not a
measurement. Metric 1 (survival rate) IS added to this query now: it is a cheap count split on
`exit_reason` over the same retry row set and gate (b) reads it alongside gate (a).

---

## 7. Alternatives considered

- **Immediate, uncapped same-coin retry (refire on the same tick, no drift gate).** Rejected. At the
  sub-minute timescale liquidity-vacuum snapback dominates the 24h momentum thesis, so an instant
  retry systematically buys the worst tick with no offsetting edge — textbook adverse selection (quant
  §1.3). A blind attempt-count cap does not fix this: capping *how many* times you buy the worst tick
  still buys the worst tick. The drift-gated breaker + cooldown-to-next-bar (§3.1/§3.3) is the
  correction; the attempt cap is only a loop backstop (§3.2).

- **Next-ranked-coin backfill (open rank #4 when a top-3 slot force-closes).** Rejected. The quant's
  explicit lean (§1.3) is to **prefer skip over next-ranked-coin backfill** when drift is large. Rank
  #4 was not selected by the strategy this cycle; substituting it is a different, unbacktested
  selection rule (it changes which basket EXP-011/012's edge was measured on), and it does nothing to
  address the actual cause (execution-timing drift on the *selected* name). If the selected name's
  drift was small enough to be a stale-reference artifact, retrying **it** is the faithful recovery;
  if the drift was large, the correct action is to hold the empty slot, not to reach for a name the
  ranking did not choose. Backfill is out of scope and explicitly a non-goal in M52.

- **More frequent rebalance cron (e.g. 2–4×/day) so an emptied slot refills sooner.** Rejected — same
  reasoning as ADR 0050 §4 / M51 "cadence decided, do not relitigate." The xmom edge (EXP-011/012) is
  a 24h-lookback / 24h-cadence operating point; sub-24h cadence re-ranks a barely-changed metric,
  collapses the daily exit into noise-trading, and churns fees on still-ranked winners. It also does
  not target the problem — the empty slot is an intra-cycle execution artifact, not a cadence
  question. Any sub-24h cadence is a separate hypothesis requiring its own `EXP-0xx`. The sanctioned
  way to force extra observation cycles remains the M50c manual-trigger surface (ADR 0048 §M50c).

- **Weaken / disable the ADR 0045 fill-acceptance guard so the fill is never force-closed in the first
  place.** Rejected, emphatically. The guard is the insurance the whole exercise depends on: unwinding a
  degenerate-geometry fill (~$0.20 in the calm §1.2 sample, but slippage-scaled and larger on a volatile
  day — M52a-2) is directionally cheaper than the ~$14.91 realized `stop_loss` such a fill runs to when
  allowed. The guard stays byte-for-byte. This ADR operates strictly *downstream* of it.

- **Put the retry decision in the execution layer (decide-and-refire where the force_close happens).**
  Rejected. The retry is gate-dependent, needs the live open-position count, the per-cycle attempt
  ledger, the fresh universe/sizing build, and cycle identity — all orchestrator concerns (ADR 0048
  §4). The execution layer only *reports* the `force_close` + its measured drift (§2.1); it makes no
  retry decision. Keeping the decision in the orchestrator preserves the single impurity boundary and
  keeps the execution layer a mechanism, not a policy owner.

- **Put the retry in the pure core (core re-emits the symbol on rejection).** Rejected — identical to
  ADR 0050 §7's rejection of a gate-aware core. The core must not know a fill drifted; injecting
  fill/gate state destroys `(universe, params, nowMs)` purity and paper/shadow/backtest parity.

- **Ship the retry on by default.** Rejected. The retry is an unvalidated adverse-selection hypothesis
  until the M52 soak measures it (§6). Default-off, paper-only, operator-opt-in (§4) mirrors the M51
  precedent and keeps the current do-nothing behavior as the safe default until the go/no-go bar
  passes.

- **Reuse attempt-1 notional/geometry for the retry (skip re-sizing).** Rejected. ATR has typically
  risen on the fast mover that drifted; reusing the old size mis-risks the position and seats it closer
  to the reversion zone (quant §1.3). The retry re-runs the full sizer fresh (§3.5).

---

## M52a Amendment — two stacked stateful-limit vetoes structurally block the armed retry (2026-07-03, revised)

> **Revision note.** The first draft of this amendment fixed only the cooldown veto (M52a-4) on the
> premise that a paper `force_close` is "fee-only, zero-slippage" and therefore carries "no
> information." Two adversarial reviews (bot-review-logic, bot-review-quant) showed both claims wrong
> against the code. This revision (a) corrects the `force_close`-PnL premise (M52a-2), (b) reframes the
> cooldown exemption's justification onto a backstop that actually holds (M52a-4), and (c) promotes the
> exit-reason-aware **consecutive-loss-halt** fix from a deferred LOW tech-debt item to **in-scope**,
> because the exact same fee/slippage-negative `force_close` legs trip a second, *worse* veto one check
> below cooldown (M52a-5).

### M52a-1. The defect — the exemption alone does not unblock the retry, it moves the veto down one check

A manual rebalance (`npm run rebalance:trigger`) force-closed RIF, MAGMA, XPL. RIF measured
`drift=0.24` → `MOMENTUM_RETRY_ELIGIBLE` → `MOMENTUM_RETRY_ARMED`, and ~4 min later fired on the next
5m bar as `MOMENTUM_RETRY_FIRED approved=false` — vetoed by `RiskGateService`:
`REJECTED open RIF/USDT:USDT reason=cooldown_active`. (MAGMA `drift=1.23` → `SKIPPED_DRIFT` and XPL →
`BASKET_FULL` are correct exclusions, not the defect.)

`checkStatefulLimits` (`RiskGateService.ts:830`) runs its sub-checks in order:
`isCooldownActive` → `checkLossWindows` → overtrading → funding. There are **two** vetoes on that path
that a `force_close`-driven negative close arms, not one:

1. **Cooldown-after-loss (per-symbol, transient).** `isCooldownActive` (`RiskGateService.ts:934`) arms
   a `COOLDOWN_AFTER_LOSS_MS` (env `COOLDOWN_AFTER_LOSS_MS = 900000`, 15 min) block whenever the
   **most recent close** on the symbol had `realizedPnl.isNegative()`. The retry fires on the next
   closed 5m bar (§3.3) — ≤10 min, always **inside** the 15-min window — so the retry's own
   `force_close` always arms a cooldown that outlives the retry's fire window.

2. **Consecutive-loss halt (global, day-wide, DB-persisted).** One check below cooldown,
   `checkLossWindows` → `isConsecutiveLossHalt` (`RiskGateService.ts:1015`) derives a loss streak from
   `findClosedOnUtcDay` (`PositionRepository.ts:115`), whose query filters `state = CLOSED` **only,
   with no `exit_reason` exclusion**. Every fee/slippage-negative `force_close` leg therefore counts
   toward the streak exactly like a real trading loss, `longestTrailingLossStreak` scans them, and with
   `CONSECUTIVE_LOSS_HALT_COUNT = 2` (`riskConsts.ts:46`) the observed incident (RIF, MAGMA, XPL — 3
   `force_close`s in one cycle) builds a streak ≥ 2. When the streak trips, `persistHalt`
   (`RiskGateService.ts:991`) writes `is_halted = true` on today's `risk_state` row — a **global**
   halt affecting every symbol and every strategy for the rest of the UTC day.

The consequence for the shipped cooldown exemption (M52a-4): once the retry is no longer vetoed by
`cooldown_active`, it **falls straight through to `checkLossWindows`**, which now rejects it with
`CONSECUTIVE_LOSS_HALT` instead. Net effect of the exemption **in isolation**: it does not unblock the
retry, it **upgrades the veto** from a per-symbol 15-min block to a global, persisted, whole-day halt.
Both fixes are therefore required together.

> **Masking caveat (unstated in the first draft).** The consecutive-loss halt is currently *masked* in
> paper soak only because soak runs with `paperRelaxConsecutiveLossHalt` ON — `checkLossWindows`
> returns early (`RiskGateService.ts:970`) **before** the streak check when that flag is set. The
> moment soak turns that relax OFF to validate real halt behavior, three `force_close`s in a day halt
> the whole bot. The fix below corrects the derivation **regardless of the relax flag**, so the halt is
> correct whether the flag is on or off.

### M52a-2. Corrected premise — a paper `force_close` is slippage-dominated, not fee-only

The first draft asserted a paper `force_close` "flattens at the current mark with zero slippage" and is
therefore "always negative-by-fees-only." **This is false.** Verified against the code:

- `ExecutionService` passes `markPrice = fillSummary.avgFillPrice` for the synthetic FLATTEN, but
  `PaperFillSimulator.translateToFillIntent` → `deriveReferencePrice`
  (`PaperFillSimulator.ts:262–309`) **ignores that price** for a reduce/close leg and re-derives the
  exit from the **live bid/ask** (a closing long hits the bid).
- `applyAdverseSlippage` / `computeTierFillPrice` (`tierSlippageCalculator.ts:82–106`) then applies
  **mandatory adverse tier-floor slippage on the close leg** (tier1 0.15% / tier2 0.5% / tier3 1.0%).

So a `force_close`'s realized PnL is **slippage-dominated** — it can be an order of magnitude larger
than the fees (scaling with tier and notional), and it can include a **real adverse price move** over
the fill-latency window. The n=3 RIF/MAGMA/XPL sample (one manual trigger, calm conditions, observed
`-0.159 / -0.203 / -0.200`) does **not** establish "fee-only" as an invariant; it is a small,
low-volatility sample. **"`force_close` realized PnL is small and fee-only" is demoted to a hypothesis**
pending soak measurement of the actual `force_close` PnL distribution (magnitude *and* sign, split by
`coin_tier` and trigger type) — added to the §6 soak metrics as metric 6.

**Why the deadlock diagnosis survives the correction.** The two vetoes key on the **sign** of realized
PnL (`realizedPnl.isNegative()`), not its magnitude. A slippage-dominated `force_close` is, if
anything, *more* reliably negative than a fee-only one. So the structural block in M52a-1 holds
independent of the premise — only the *original justification* for exempting the retry (below) depended
on the false "no information" claim and must change.

### M52a-3. Root cause — a mechanical unwind is neither a discretionary trading loss nor a selection failure

Both vetoes conflate a **mechanical unwind** with the failure mode each is actually built to catch.

- **What cooldown-after-loss protects (ADR 0004 §5).** Stop *re-opening the same symbol* immediately
  after a **real, thesis-invalidating trading loss** (a stop-loss hit, an adverse time-stop) — the
  per-symbol revenge / adverse-selection failure mode, on a 15-min horizon.
- **What the consecutive-loss halt protects (ADR 0004 §5).** Detect that the strategy's **selection /
  thesis has been repeatedly wrong today** and halt *all* new entries for the day. It is a
  **signal-quality** circuit breaker, deliberately *not* a money-magnitude one — money magnitude is the
  daily- and weekly-loss limits' job (`checkLossWindows`, evaluated first, not exempted).

A `force_close` is categorically different from what either guard targets. It is a mechanical unwind of
an entry that **never established a thesis** — the fill degenerated at the ADR 0045 fill-acceptance
seam and was rejected *before* the position could run, or it is a rebalance slot-recovery flatten.
Three `force_close`s in one manual-rebalance cycle is **not** "the strategy's selection was wrong three
times"; it is "three fast-mover entries slipped past the geometry guard in one cycle." It reflects
**execution quality**, not **selection quality**.

The corrected premise (M52a-2, `force_close` can be slippage-*expensive*) does **not** change this
conclusion — it clarifies the division of labour:

- The **money** a `force_close` costs (fees + slippage, possibly large) is real and **is** counted —
  by the **daily-loss limit**, which sums `realized_pnl_day` over *every* close including `force_close`
  legs and *including retries*, and is **not** exempted. That is the honest instrument for "am I
  bleeding too much today, from any cause."
- The **signal** a `force_close` carries about selection quality is **nil** — so it must not feed the
  consecutive-loss streak, and re-opening after one is not "chasing a loss."

### M52a-4. Decision A — exempt retry-entry intents from the cooldown-after-loss gate (shipped; justification revised)

`isCooldownActive` returns `false` immediately when `intent.isRetryEntry === true`, before it reads the
last close (already implemented, `RiskGateService.ts:939`). The retry class is exempt from
cooldown-after-loss; **all other opens keep the check byte-for-byte**.

**The original justification is withdrawn.** The first draft argued the retry's own volatility drift
gate "subsumes" cooldown — that `isRetryEntry === true` is "unreachable for a symbol that actually
moved against us." That is **false**, for two independently sufficient reasons the quant review
established against the code:

- **The drift gate is unsigned.** `computeGeometryAnchorDrift` uses `.abs()`
  (`ExecutionService.ts:1234–1235`), so `drift < 1.0` admits **small adverse** moves just as readily as
  small favorable ones. A symbol that moved slightly *against* us (e.g. drift 0.4 adverse) still arms a
  retry. "Unreachable for a symbol that moved against us" is therefore wrong — it is only unreachable
  for *large* moves, in either direction.
- **The gate is measured at arm time, not re-verified at fire time.** The drift is computed on
  attempt-1's fill. The retry then waits a full 5m bar and **rebuilds from a fresh reference**
  (§3.5) — so the arm-time drift bound says nothing about the retry entry's *own* adverse exposure. The
  gate does **not** bound "chasing a real adverse move."

**The corrected justification.** Cooldown-after-loss is a per-symbol revenge guard calibrated to a
15-min horizon. The retry's cadence (fires on the next 5m bar, ≤10 min, structurally *inside* 15 min)
makes cooldown **incapable of doing anything but deadlocking the retry** — it is the wrong instrument
for this cadence, not a live risk decision being overridden. Exempting it removes a structural
deadlock; it does **not** remove protection, because the residual adverse-selection risk is carried by
instruments that can actually see it:

- **The daily-loss limit (`checkLossWindows`, not exempted)** sees the full realized-PnL magnitude of
  every `force_close` and every retry, slippage included — the honest money backstop (M52a-3).
- **The §3.2 attempt cap** bounds oscillation to one retry per `(rebalanceCycleId, symbol)`.
- **The §6 soak adverse-selection hard gate (metric 2)** is the actual validation that retry entries do
  not systematically buy the worst tick; until it passes, the whole retry ships default-off (§4).

So the "chasing losses" failure mode is bounded — by the daily-loss limit and the attempt cap and the
soak gate — *not* by a per-symbol 15-min cooldown the retry cadence structurally defeats.

**Concrete fix spec (for `bot-engine-nestjs`) — already implemented; recorded for the audit trail.**
One file, one method, no new constant, no interface change, no migration.

- **File / method:** `apps/engine/src/risk/service/RiskGateService.ts`, `isCooldownActive` (lines
  934–950). Guard clause at the top, before the `findLastCloseForSymbol` read:
  `if (intent.isRetryEntry === true) { return false; }`.
- **Discriminator already exists.** `IOrderIntent.isRetryEntry` (`IOrderIntent.ts:79`) is set `true`
  **only** by the retry orchestrator's `fireArmedRetry` (`MomentumOrchestratorService.ts:329`);
  attempt-1 opens leave it `undefined`. Comparison is strict `=== true` so every non-retry intent takes
  the unchanged path — no accidental widening.
- **Comment must cite the revised justification** (this M52a-4): the retry cadence structurally defeats
  the 15-min cooldown; residual risk is held by the daily-loss limit + attempt cap + soak gate — **not**
  by the drift gate (unsigned, arm-time-only).

**Tests `bot-qa-engineer` must add (paired to the fix):**
1. A retry-flagged intent (`isRetryEntry: true`) whose last close is a negative `force_close` within
   the cooldown window is **not** rejected `cooldown_active` (the regression the live soak exposed).
2. A non-retry intent (`isRetryEntry` undefined) with the same recent negative close **is** still
   rejected `cooldown_active` — the invariant is preserved for the discretionary path.
3. A retry-flagged intent still fails every *other* gate check that should reject it (e.g. book too
   thin, exposure cap, **and the consecutive-loss halt of M52a-5 when real losses precede it**) — the
   exemption scopes exactly one sub-check; it is not a gate bypass.

### M52a-5. Decision B — the consecutive-loss streak excludes `force_close` legs (promoted from LOW to in-scope)

**Why the `isRetryEntry` intent-exemption does NOT fit this veto.** `isConsecutiveLossHalt` derives the
streak from **aggregate closed positions on the day** (`findClosedOnUtcDay`), not from the evaluated
intent, and on trip it **persists a global `is_halted` day row** (`persistHalt`). An `isRetryEntry`
guard on this check would be nearly useless: (a) the streak-building `force_close` legs remain in the
DB and would halt the very next **non-retry** open — tomorrow's 01:07 cron, or an entirely different
symbol; (b) once the global halt is persisted, it blocks everything for the day regardless of any
single intent's flag. The M52a-2 scoping claim in the first draft ("this defect only bites the retry
path; outside it the next re-entry is ~24h away") is **false for this veto specifically** — the
consecutive-loss halt is global and independent of any one symbol's retry timing. The fix must live at
the **streak derivation**, not on the intent.

**Decision.** Make the streak derivation **exit-reason-aware**: `force_close` legs are **filtered out
before the scan** — they neither increment nor reset the streak (they are invisible to it). This
faithfully encodes the invariant of M52a-3: the halt counts **thesis-bearing closes only**
(`stop_loss`, `take_profit`, `time_stop`, `signal`, `liquidated`, …), because only those speak to
selection quality. The money cost of the excluded `force_close` legs is still fully counted by the
daily-loss limit (M52a-3), so nothing is un-protected.

> **Filter, do not reset.** A `force_close` must be *removed* from the sequence, **not** treated as a
> streak-resetting "win." A `force_close` sitting between two real `stop_loss` legs must stay invisible
> so the two genuine thesis losses still trip the halt at streak 2 — treating it as a win would let a
> mechanical unwind silently *cancel* a legitimate losing streak and weaken the protection.

**Concrete fix spec (for `bot-engine-nestjs`) — same rigor as M52a-4. Engine-internal only; NO
`bot-shared-maintainer` change.**

The first draft deferred this as needing a shared-contract change through `bot-shared-maintainer`. That
was wrong: the view the gate reads is the **engine-internal** `IClosedPositionView` in
`apps/engine/src/risk/interface/IOpenPositionsPort.ts` — *not* the shared
`packages/shared/src/interface/IClosedPositionView.ts` (which already carries `exitReason`). The
backtest trade view (`IBacktestTradeResult`) already carries `exitReason` including `'force_close'`.
So the change is confined to `apps/engine`.

1. **`apps/engine/src/risk/interface/IOpenPositionsPort.ts`** — add `readonly exitReason:
   ExitReasonEnum | null;` to the engine-internal `IClosedPositionView` (import `ExitReasonEnum` from
   `@bot/shared`). Keep it **nullable** so a legacy/unknown row is expressible.
2. **`apps/engine/src/risk/service/OpenPositionsPortAdapter.ts`** — `toClosedView` maps
   `exitReason: position.exitReason ?? null` (`PositionEntity.exitReason` is already
   `ExitReasonEnum | null`, `PositionEntity.ts:74`).
3. **`apps/engine/src/backtest/adapter/BacktestPositionAdapter.ts`** — `toClosedView` maps
   `exitReason: trade.exitReason as ExitReasonEnum` (`IBacktestTradeResult.exitReason` is a string
   union whose members match `ExitReasonEnum`). Inert in practice — `force_close` cannot occur in
   backtest (§5) — but the field must be populated for type-completeness and parity.
4. **`apps/engine/src/risk/service/RiskGateService.ts`** — in `isConsecutiveLossHalt`
   (`RiskGateService.ts:1015`), filter the fetched closes to exclude `force_close` **before** ordering
   and scanning:
   `const thesisClosed = closed.filter((position) => position.exitReason !== ExitReasonEnum.FORCE_CLOSE);`
   then order + `longestTrailingLossStreak(thesisClosed)`. `longestTrailingLossStreak` is unchanged.
   A `null` `exitReason` is **kept** (a legacy/unknown close still counts) — fail toward *preserving*
   the halt, never toward suppressing it. Attach a comment citing ADR 0004 §5 / ADR 0051 §M52a-5:
   `force_close` is a mechanical unwind, not a selection loss; its money cost is caught by the
   daily-loss limit.
5. **`apps/engine/tests/risk/support/fixtures.ts`** — `buildClosedPositionView` gains an `exitReason`
   default (e.g. `ExitReasonEnum.STOP_LOSS`, so existing streak fixtures that build negative closes
   still count) plus override support.

**Tests `bot-qa-engineer` must add (paired to the fix):**
1. A day with **two negative `force_close` closes and nothing else** does **not** halt —
   `isConsecutiveLossHalt` returns `false`, no `persistHalt` write (the RIF/MAGMA/XPL regression).
2. A day of `stop_loss` (neg) → `force_close` (neg) → `stop_loss` (neg) **does** halt at streak 2 — the
   `force_close` is invisible, so the two real thesis losses still trip it (guards against the
   "treat force_close as a reset" mis-fix).
3. A day of **two real `stop_loss` losses** still halts (unchanged baseline) — the invariant is
   preserved for thesis losses.
4. A negative close with **`exitReason = null`** still counts toward the streak — the fail-safe default.
5. The fix holds with `paperRelaxConsecutiveLossHalt` **OFF** — the derivation is correct independent of
   the relax flag (M52a-1 masking caveat).

### M52a-6. Alternatives considered

- **Apply the `isRetryEntry` intent-exemption to the consecutive-loss halt too (mirror Decision A).**
  Rejected — it does not fit the veto's shape (M52a-5). The halt fires on aggregate closed-position
  history and persists a **global** day row; an intent flag cannot un-persist a global halt, and the
  streak-building `force_close` legs would still halt the next non-retry open. The derivation-level
  exit-reason exclusion is the only fix that addresses the actual mechanism.
- **Treat a `force_close` as a streak-resetting "win" instead of filtering it out.** Rejected. A
  `force_close` between two real `stop_loss` legs would then silently cancel a legitimate losing
  streak, weakening the halt. A mechanical unwind must be *invisible* to the streak, not a positive
  signal (M52a-5).
- **Fix only the cooldown veto (the first draft) and defer the consecutive-loss halt as LOW
  tech-debt.** Rejected — this is the promotion. With the cooldown exemption shipped, the retry falls
  through to the consecutive-loss halt, which is *worse* (global, persisted). The two defects are the
  same root cause (`force_close` counted as a loss) on two stacked checks; fixing one without the other
  ships a change whose only effect is to make the veto more severe (M52a-1).
- **Distinguish "real loss" from "mechanical flatten" inside `isCooldownActive` globally** (make
  cooldown itself exit-reason-aware, dropping the intent exemption). Rejected as the cooldown fix. The
  only *reachable* case where a `force_close` last-close matters within the 15-min window is the retry
  path (a non-retry re-entry after a `force_close` is the next daily cron, ~24h out, far past
  cooldown). The `isRetryEntry` exemption already covers that one reachable case with a smaller blast
  radius than rewriting the cooldown semantic for every strategy. (The `exitReason` data now on the
  engine view *would* make this cheap, but it buys no additional reachable protection — kept as LOW
  tech-debt in M52a-8.)
- **Shorten the cooldown for retry-armed re-entries via a new constant.** Rejected. To unblock a retry
  firing within ~5 min of its own `force_close`, the retry-specific cooldown would have to be
  effectively zero — the exemption with extra machinery, a misleading name, and a constant that must be
  kept below `MOMENTUM_RETRY_MAX_WAIT_MS` forever or the deadlock silently returns.
- **Gate the cooldown exemption behind `xmomForceCloseRetry` as well as `isRetryEntry`.** Rejected as
  redundant coupling. `isRetryEntry === true` is *only* reachable when the paper-gated, default-off
  retry orchestrator ran (which already requires the flag), so re-reading strategy config inside the
  risk gate adds no safety.

### M52a-7. Trading-safety invariants — explicitly defended

- **No order path bypasses the risk gate (CLAUDE.md hard rule).** The retry intent still runs the
  **entire** `RiskGateService.evaluate` pipeline. Decision A scopes exactly **one** sub-check
  (`isCooldownActive`) to exclude the retry class; Decision B changes **what counts as a loss** in
  **one** derivation (`isConsecutiveLossHalt`), narrowing it to thesis-bearing closes for **every**
  strategy — it does not weaken any threshold. Every other check (stress, spread, book depth, OI,
  daily/weekly loss limits, overtrading caps, exposure caps, R:R, SL-inside-liquidation, sizing) is
  unchanged and still applies to retries. Neither change is a bypass, a new order path, or a new gate
  rule; both mirror the established `paperRelaxConsecutiveLossHalt` precedent of scoping a single check.
- **Decision B is a global narrowing, and that is correct — not a paper-only relax.** Excluding
  `force_close` legs from the consecutive-loss streak applies in LIVE too. This is intended: a
  `force_close` is a mechanical unwind in *any* environment, its money cost is caught by the (unchanged,
  not-exempted) daily-loss limit, and counting it as a selection loss is a false positive everywhere.
  The change makes the halt *more precise*, not more permissive, and cannot mask real thesis losses
  (those keep counting).
- **Inert-in-LIVE for Decision A.** `isRetryEntry` is set only by the retry orchestrator, reachable
  only when `EXCHANGE_ENV = paper` **and** `XMOM_FORCE_CLOSE_RETRY` is on (default-off, §4). In every
  LIVE path `isRetryEntry` is `undefined`, so `isCooldownActive` behaves exactly as today. **Reviewer
  rule:** any code path that sets `intent.isRetryEntry = true` outside the paper-gated retry
  orchestrator is a must-fix — it would leak the cooldown exemption toward live capital.
- **Backtest parity preserved.** The retry path is inert in backtest (§5), so `isRetryEntry` is never
  `true` and Decision A never fires there. For Decision B, `force_close` cannot occur in backtest (§5),
  so the exit-reason filter never removes a backtest close — the derivation is identical live and in
  backtest. No parity divergence from either change.
- **Money stays `decimal`.** No arithmetic changes; the streak filter compares an enum, the removed
  cooldown comparison was already `decimal.js`.

### M52a-8. Consciously out of scope

- **The reconciliation cooldown mirror.** `ReconciliationService.isCooldownStillActive`
  (`ReconciliationService.ts:1687`, ADR 0010 §7) duplicates the last-close-PnL-sign derivation for the
  crash-recovery decision "may I re-open this symbol on restart?" It is **not** changed here: armed
  retries live in an in-memory map lost on restart, so a retry never resumes across a process boundary
  and this mirror cannot deadlock it. Its conservative behavior (decline to re-open a just-force_closed
  symbol on cold start) is correct for recovery. Recorded as LOW tech-debt: if global cooldown is ever
  made exit-reason-aware, this mirror should move in lockstep.
- **Making cooldown-after-loss itself exit-reason-aware (dropping the intent exemption).** With the
  `exitReason` field now on the engine-internal `IClosedPositionView` (Decision B), this is cheap — but
  it buys no additional *reachable* protection (M52a-6), so it stays LOW tech-debt. Decision A's intent
  exemption remains the sanctioned cooldown fix.
