# ADR 0050 — xmom rank-cascade selection, `top_n` basket, fixed-UTC rebalance anchor

- **Status:** Accepted
- **Date:** 2026-07-01
- **Milestone:** M50b (D1)
- **Amends:** ADR 0047 §2.1 / §2.5 (selection contract + params) and ADR 0048 §2.2 / §2.4 / §5
  (scheduler + close ordering + core algorithm). Those ADRs stay Accepted for their original M50
  decisions; this ADR supersedes only the sub-sections named below.
- **Composes with:** ADR 0004 (risk gate / slots / exposure caps — **unchanged**), ADR 0016
  (lineage), ADR 0029 (shadow), ADR 0042 (paper gate), ADR 0046 (closes survive halts).

> **ADR numbering note.** The next free number after `0049` is **0050**; this ADR uses it.

---

## 1. Context

A dashboard smoke test of the xmom path (`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` → `strategy_versions`
id=20) surfaced three gaps in the as-built M50 momentum path — none a bug, all design limits worth
closing before the next paper soak (investigation: `docs/wip/2026-07-01-xmom-cascade-topn-rebalance-timing.md`):

1. **No fallback on rejection.** With `top_n = 1`, one illiquid top-ranked mover
   (`coin_book_too_thin`) stalls the whole cycle — zero trades for a full rebalance interval even
   though rank #2, #3, … are tradeable. The core slices `top_n` off the ranked list; if a selected
   leg is gate-rejected, nothing replaces it that cycle (`MomentumOrchestratorService.rebalance`,
   the `opens` loop).
2. **Single all-or-nothing bet.** `top_n = 1` holds one position; the contract was always described
   as a "ranked, sized-by-rank selection" (ADR 0047 §2.1) but M50 shipped the single-slot proxy.
3. **Boot-relative cadence.** `RebalanceSchedulerService` registers a plain `setInterval` at engine
   boot (no wall-clock alignment), so the 24h re-rank instant drifts with whenever the process last
   restarted — non-reproducible across restarts, and unaligned with funding settlement / the daily
   universe-volume window / the `pg_dump` backup window.

All three are M50b increments on the **paper-only** momentum path (ADR 0047 §2.6 boot gate is
unchanged; no live capital reaches xmom). The invariants this project defends — pure/deterministic
core, no order path bypassing the risk gate, no LLM in the loop, money is `decimal` — are preserved
and re-argued per decision below.

---

## 2. Decision 1 — rank-cascade fallback, driven by the impure orchestrator (uncapped depth)

### 2.1 The walk lives in the orchestrator; the core returns the FULL ranked list

**The cascade MUST NOT live in `crossSectionalMomentumCore`.** Whether a candidate can be *opened*
depends on the risk gate, which is stateful and impure — it reads open positions, the reservation
ledger, per-coin book depth, cooldowns, and loss windows from live state. Threading gate outcomes
into the core would inject I/O and non-determinism into the one function ADR 0047 §2.1 requires to
be a pure function of `(universe, params, nowMs)`. The purity invariant is non-negotiable: the same
`selectUniverse` must rank identically in paper, shadow, and a future backtest replay. A
gate-dependent walk cannot satisfy that.

**Therefore (amends ADR 0047 §2.1 and ADR 0048 §5 step 4):**

- `crossSectionalMomentumCore` **no longer slices to `top_n`.** It returns the **full ranked
  eligible universe**, best-first, with dense `rank` 1..M (M = eligible count). The eligibility
  filter (step 1), no-eligible guard (`no_eligible_symbols`), min-universe guard
  (`universe_too_small`), and the return-then-symbol sort (steps 2–3) are **unchanged**. Only the
  final `.slice(0, top_n)` is removed — the core ranks, it does not select a count.
- `top_n` is **no longer a core input for slicing.** It becomes a pure **orchestrator consumption
  target** (how many positions to actually hold). The core keeps reading `params` for
  `min_universe_size`; it ignores `top_n`. The param stays in `momentumParamsSchema` unchanged.
- **Contract rename (shared package):** `IPortfolioSelection.selected` → `IPortfolioSelection.ranked`
  to make the new "full ranked list, not a top-N cut" semantics honest at the type level.
  `ISelectedSymbol.rank` now spans 1..M. `PortfolioSelectionReasonEnum` is unchanged (`ranked` still
  means "a rankable universe was produced"). This is a `bot-shared-maintainer` change; the only
  consumer is the orchestrator and the core's own return.

The impure **walk** then lives wholly in `MomentumOrchestratorService`, which is already the
determinism boundary for everything clock-, state-, and gate-touching (ADR 0048 §4). This keeps the
one pure function pure and puts the gate-dependent logic exactly where impurity is already allowed.

### 2.2 The cascade walk + churn-safe close ordering

The orchestrator's `rebalance(nowMs)` is restructured into a **two-tier close** around the walk so a
still-selected held position is never closed-then-reopened (the churn bug the WIP doc calls out) and
the ADR 0048 §2.4 "free a de-ranked slot before opening" rationale is preserved for the case that
actually needs it.

Let `ranked` = the core's full ranked list; `openMomentum` = currently-open positions filtered to the
active momentum `strategy_version_id`; `rankedSymbols` = the set of symbols present in `ranked`.

1. **Definite de-rank closes — before any open (preserves ADR 0048 §2.4).**
   Close every `openMomentum` position whose symbol is **absent from `ranked` entirely** (it lost
   eligibility — no trailing return, or the whole universe went `universe_too_small`/
   `no_eligible_symbols`, in which case `ranked` is empty and *all* momentum positions close). These
   can never be re-selected this cycle, so closing them first frees their slots for the walk. Sorted
   by symbol ascending (deterministic).

2. **Cascade walk — hold-or-open in rank order, uncapped depth, stop at `top_n` fills.**
   Walk `ranked` best-first. Maintain `filled = 0`. For each entry, stop once `filled === top_n`:
   - **Already open** (symbol ∈ `openMomentum`, survived step 1) → **HOLD**: no gate call, no
     intent (holding is free; avoids re-entry churn per ADR 0048 §6). `filled++`. Record the symbol
     in `retained`.
   - **Not open** → attempt an open through the **unchanged gate** (`processOpen` →
     `RiskGateService.evaluate` → on approval the existing `ORDER_INTENT_APPROVED_EVENT` seam).
     - **Gate-approved** → `filled++`; record in `retained`. "Actually opened" is defined as
       **gate-approved** (a slot reserved in the ledger), *not* the async fill — the reservation is
       the durable commitment that a position will open, and it is what makes the slot count correct
       within the cycle. A later partial/failed fill is handled by the existing reconciliation path,
       unchanged.
     - **Gate-rejected** (`coin_book_too_thin`, `max_positions_reached`, cooldown, exposure cap, …)
       → **cascade**: do not count it, continue to the next ranked entry. The rejection is still
       persisted as a `decisions` row (unchanged), so the log shows the full walk.
   The walk is **uncapped in depth** — it may traverse the entire ranked eligible list — and is
   naturally bounded by the eligible-universe size (which is itself ≥ `min_universe_size` to have
   produced a `ranked` result at all, and ≤ the ~100-symbol universe cap).

3. **Residual de-rank closes — after the walk.**
   Close every remaining `openMomentum` position (present in `ranked`, so it survived step 1) whose
   symbol is **not in `retained`** — it ranked below the `top_n` fill line and was genuinely
   displaced. Because a held symbol reached in the walk is recorded in `retained` **before** any
   lower-ranked open is attempted, a position the cascade fell back onto is retained, never closed.
   This is the fix to the WIP doc's specific concern: **closes key off the post-walk `retained` set,
   never the naive top-`top_n` ranked slice.**

Ordering summary: **definite-derank closes → cascade (holds + opens) → residual-derank closes.**
Determinism preserved: `ranked` is deterministic; closes are symbol-sorted; opens are attempted in
rank order; the only non-determinism (gate state) was already outside the core.

### 2.3 Uncapped walk depth — call-volume / log-volume is negligible (shown, not asserted)

At the fixed 24h cadence (Decision 3) the walk runs **once per UTC day**. Worst case — a pathological
day where *every* ranked candidate is gate-rejected — the walk attempts an open on the entire
eligible universe: ordered by the volume-floor universe cap, that is **≤ ~100 candidates**. Per
attempted open the orchestrator does: one in-memory `RiskGateService.evaluate` (reads the cached
reservation ledger + a handful of state reads), one `candles.findRange` read for ATR sizing, and one
`decisions` row insert. So the absolute worst day is **~100 gate evaluations, ~100 candle-range
reads, and ~100 decision rows** — once.

Context for scale: the VWAP path runs `evaluate` **per trigger, per symbol, every bar, continuously**
across the same ~100-symbol universe — orders of magnitude more gate traffic and decision rows every
single day. The typical (non-pathological) momentum walk stops at `top_n` fills plus a few rejects —
on the order of **3–8 evaluations/day**. There is no meaningful risk-gate call-volume, DB-read, or
`decisions`-table growth concern at this scale; an explicit depth cap would add configuration surface
and a new failure mode (silently under-filling below `top_n`) to guard against a load that does not
exist. **Uncapped, bounded only by `min_universe_size`/universe size, is correct.** `min_universe_size`
(default 20) is untouched — it remains a data-quality floor, not the cascade depth (WIP doc scope).

---

## 3. Decision 2 — `top_n` 1 → 3 (single-value, not a range)

`top_n` default moves from `1` to **`3`** in `momentumParamsSchema`. This is a schema default change
only (no code path change beyond Decision 1's cascade, which already consumes `top_n` as a fill
target). The N-long basket was always the intended shape (ADR 0047 §2.1); M50b ships it.

### 3.1 The slot model already admits 3 concurrent idiosyncratic momentum positions

Momentum opens are hardcoded `correlationMode = IDIOSYNCRATIC`, `idiosyncrasyScore = 1`
(`buildMomentumOpenIntent`). The `SlotManager` (ADR 0004 §4) gives an idiosyncratic trade slot A,
then B (`MAX_IDIOSYNCRATIC_SLOTS = 2`), then C when A and B are already idiosyncratic-occupied and no
BTC-correlated position holds C — i.e. **up to 3 idiosyncratic positions**. So `top_n = 3` fits the
existing 3-slot model with **no cap change**, exactly when the shared A/B/C pool is otherwise empty.
Under the shared pool (ADR 0047 §2.4), any slot VWAP holds is a slot momentum cannot get: a 3rd (or
2nd) momentum open then gate-rejects with `max_positions_reached` — an **expected, logged** outcome,
and now precisely the case the Decision 1 cascade handles gracefully instead of stalling.

### 3.2 The binding portfolio cap is same-direction exposure — verify config, no code change

All momentum legs are **LONG**. The per-coin exposure cap (`MAX_EXPOSURE_PER_COIN_USDT`) is per-symbol
and does not bind across 3 distinct symbols. The cap that *does* bind is the **same-direction
exposure cap** (`checkExposureCaps` → `SAME_DIRECTION_EXPOSURE_CAP`): it sums the notional of **all**
open longs — momentum **and** VWAP — and rejects when the running sum + the new leg exceeds
`MAX_SAME_DIRECTION_EXPOSURE_USDT` (config default **$600**).

Consequence to verify before the soak (an **operator config check**, not a code change): with
`ACCOUNT_CAPITAL_USDT` and risk-per-trade sizing producing a per-position momentum notional of ~$N,
three momentum longs consume ~3·$N of the same-direction budget, shared with any VWAP longs. If
`MAX_SAME_DIRECTION_EXPOSURE_USDT` is smaller than the intended 3-leg basket notional, the 3rd (or
2nd) leg gate-rejects on `SAME_DIRECTION_EXPOSURE_CAP` — **safe** (survival-first: it caps aggregate
long exposure exactly as designed) but it silently under-fills the basket. The plan's QA/operator step
is to confirm `MAX_SAME_DIRECTION_EXPOSURE_USDT` in the paper profile is sized for the intended 3-leg
basket (plus VWAP headroom) **or** to accept under-fill as the documented, logged behavior. **No gate
code changes** — the caps already account for N simultaneous positions correctly; only the config
value needs to match intent.

### 3.3 Correlation risk — accepted-as-is for paper, explicit live/M50b blocker (mirrors ADR 0048 §3.1)

Real risk, stated plainly: the top 3 cross-sectional momentum names are frequently **correlated**
(a market-wide altcoin pump, high BTC beta). Yet every momentum leg self-labels
`correlationMode = IDIOSYNCRATIC` / `idiosyncrasyScore = 1`, so the slot model's correlation
protection — slot C reserved for at most **one** BTC-correlated position (`max_btc_correlated_positions`)
— **does not engage** for momentum. With `top_n = 1` this was harmless (one position). With
`top_n = 3` it means three possibly-correlated longs can occupy A/B/C as if independent: **this is not
true diversification.**

**Decision: accept as-is for M50b paper, document as a known limitation, and make it a hard blocker
for any non-paper promotion** — the same disposition and rationale as the synthesized-snapshot
stress-halt bypass (ADR 0048 §3.1):

- **Bounded, not open-ended.** Momentum is paper-only (ADR 0047 §2.6) — no capital at risk. The
  same-direction exposure cap (§3.2) is a crude aggregate backstop that limits total long notional
  regardless of correlation labeling.
- **Out of scope for this change by design.** A real momentum correlation classifier needs a
  correlation/beta source (rolling BTC-beta or a returns correlation matrix) and a decision on how a
  correlated momentum leg competes for slot C — substantial new work with its own review surface,
  disproportionate to a `top_n` + cascade increment. Hardcoding a heuristic now would be worse than
  the honest gap.
- **Live blocker (tracked as M50b/tech-debt).** Before xmom is promoted beyond `EXCHANGE_ENV = paper`,
  momentum legs must carry a **real** `correlationMode` (or an equivalent basket-correlation cap) so
  three correlated movers cannot masquerade as three idiosyncratic positions. This caveat must not
  survive into a live path. Recorded in `docs/tech-debt.md` as a HIGH (go-live blocker) item.

---

## 4. Decision 3 — keep 24h cadence, anchor it to a fixed UTC time via `@Cron`

**Frequency is unchanged (24h).** The only backtested, cost-surviving edge (EXP-011/012) is
specifically a 24h-cadence strategy: rank by 24h return, re-rank every 24h. `lookback_ms` and the
cadence are coupled by design; sub-24h cadence without shortening `lookback_ms` re-ranks a
barely-changed metric and churns fees — an unbacktested variant requiring its own `EXP-0xx`
(`docs/analysis/README.md`), out of scope here.

### 4.1 `@Cron` at a fixed UTC time — chosen over interval-plus-anchor

**Decision: replace the boot-relative `setInterval` with a fixed daily UTC cron** (amends ADR 0048
§2.2). `RebalanceSchedulerService` moves from `SchedulerRegistry.addInterval(setInterval(...))` to a
dynamically-registered cron job — `SchedulerRegistry.addCronJob(MOMENTUM_REBALANCE_CRON_NAME, job)`
where `job` is a `CronJob` (from the pinned `cron` 4.4.0 that backs `@nestjs/schedule` 6.1.3)
constructed with the fixed expression and an explicit **`timeZone: 'UTC'`**. Dynamic registration
(not the static `@Cron` decorator) is kept so the existing paper-gate condition still governs
whether the job is registered at all: register **only** when `EXCHANGE_ENV = paper` **and**
`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` is set (ADR 0047 §2.6) — otherwise stay dormant, exactly as
today. The job's callback is unchanged in spirit: read `nowMs` from the injected `ClockPort`
(determinism seam, ADR 0048 §2.2) and emit `UNIVERSE_REBALANCE_DUE_EVENT`. `onModuleDestroy`
deletes the cron job instead of the interval.

**Why `@Cron`/cron-job over interval-plus-wall-clock-anchor:**
- **Zero drift, restart-stable.** A cron fires at the same wall-clock instant regardless of when the
  process last booted — the reproducibility the WIP doc asks for. An interval-plus-anchor must
  compute a delay-to-next-boundary, `setTimeout`, then `setInterval(24h)`, and re-anchor on every
  restart; more moving parts and a drift surface (timer jitter accumulates over long uptimes).
- **Removes the sub-24h foot-gun.** Cadence is no longer read from `rebalance_interval_ms`, so a
  param typo (or a leftover smoke-test override like the 5-min value on id=20) can no longer silently
  shorten the cadence into an unbacktested variant. The cadence is pinned in code to the only
  validated value.
- **Declarative + matches ADR 0048 §2.2's own stated intent** (`@Interval`/`@Cron` via the
  scheduler) and the existing dynamic-registration pattern already in the service.

### 4.2 Locked time: **01:07 UTC** — `7 1 * * *`, `timeZone: 'UTC'`

Locked at **01:07 UTC** (operator decision; a 7-minute offset from the round hour, same rationale as
the originally-proposed 01:00 window):
- **Past the 00:00 UTC funding settlement** — ranks on settled data, not funding-print noise.
- **Uses a full, just-closed UTC day** of returns/volume — aligns with the 24h universe volume floor;
  01:07 is close enough to the day boundary that the trailing-24h window is freshest.
- **Just under two hours of clearance before the ~03:00 UTC `pg_dump` window** — the rebalance (and
  its fill path) is done well before the nightly backup, so a backup never races an in-flight
  rebalance.

### 4.3 `rebalance_interval_ms` is decoupled from cadence — pinned, validated, downstream-only

Cadence no longer reads `rebalance_interval_ms`. The param is **retained** because it still feeds the
**time-stop safety net**: `buildMomentumOpenIntent` sets `timeStopAtMs = nowMs + rebalance_interval_ms * 2`
and `buildGateStrategyParams` sets `time_stop_minutes = ceil(rebalance_interval_ms / 60000)` — both
sized so the time-stop enforcer can **never** fire before the next daily rebalance (else a
still-ranked winner is force-closed then reopened, double fees; the 2× margin is the guard). To keep
that math consistent with the now-fixed 24h cadence:

- `rebalance_interval_ms` default stays **`86_400_000`** (24h) and MUST equal the cron period.
- Introduce `MOMENTUM_REBALANCE_PERIOD_MS = 86_400_000` as the single source of truth for the daily
  period. On registration, `RebalanceSchedulerService` **validates** `params.rebalance_interval_ms`
  against it: on mismatch, log a loud **WARN** (`rebalance_interval_ms=<x> != fixed 24h cadence — the
  cron period is fixed; this param now only sizes the time-stop net`). This neutralizes the leftover
  5-min smoke-test override (memory note: id=20 must be reset to `{}`) — even if the param is stale,
  cadence stays 24h and the mismatch is surfaced. (Registration still proceeds; the param is advisory
  for the time-stop only.)
- **Smoke tests / fast local iteration** no longer shorten the cadence. Use the **event seam**: emit
  `UNIVERSE_REBALANCE_DUE_EVENT` manually (a dev/test trigger, already anticipated by ADR 0048 §10 —
  "a manual rebalance endpoint or backtest replay driver drives the same orchestrator"). This keeps
  production cadence pinned while preserving a controllable trigger for tests.

---

## 5. Invariants this ADR defends

- **Pure, deterministic core.** `crossSectionalMomentumCore` stays a pure function of
  `(universe, params, nowMs)` — the cascade (gate-dependent, impure) is added only in the
  orchestrator; the core change is a *narrowing* (stop slicing), not new impurity (§2.1).
- **No order path bypasses the risk gate.** Every cascade open is an `IOrderIntent` routed through
  the unchanged `RiskGateService.evaluate`; "actually opened" means gate-approved. No new order path,
  no new gate rule (§2.2, §3).
- **Money is `decimal`.** Sizing/exposure/PnL stay `decimal.js` in the unchanged risk/execution path;
  the core still ranks on the `trailingReturnPct` scalar (§2).
- **No LLM in the loop.** Ranking math + gate routing + a cron tick; no model call.
- **No live capital.** ADR 0047 §2.6 paper-only boot gate is unchanged; the cron registers only under
  `EXCHANGE_ENV = paper` (§4.1).
- **Closes survive halts.** De-rank exits (both tiers) route as risk-reducing intents (ADR 0046),
  unchanged.
- **Reproducible cadence.** Fixed 01:07 UTC cron — same instant across restarts (§4).

---

## 6. Consequences

- One illiquid top-ranked mover no longer stalls a cycle: the cascade walks past it to the next
  tradeable name, up to `top_n` actual opens. Zero-trade cycles now mean the *whole* eligible
  universe was un-openable, not that rank #1 was thin.
- `IPortfolioSelection.selected` → `ranked` (full list) is a shared-contract change: the core, the
  orchestrator, and their tests update in lockstep (`bot-shared-maintainer` first).
- `top_n = 3` holds a 3-name basket; under the shared slot pool and the same-direction exposure cap
  it may hold fewer, logged as expected. The correlation gap (§3.3) is an accepted paper-only
  limitation and a HIGH go-live blocker recorded in tech-debt.
- Cadence is pinned to 01:07 UTC in code; `rebalance_interval_ms` is now downstream-only (time-stop
  net) and validated against the fixed period. Smoke tests trigger via the event seam, not a
  shortened interval.
- Determinism end-to-end is preserved, so an M50b xmom version remains backtestable through the same
  `selectUniverse` for the down-regime promotion gate (ADR 0047 §4 / §5).

---

## 7. Alternatives considered

- **Walk inside the pure core (core calls the gate / takes a "can-open" predicate).** Rejected.
  Injecting gate outcomes — even as a predicate — makes ranking depend on live, stateful,
  non-deterministic gate state, breaking the ADR 0047 §2.1 purity invariant and destroying
  paper/shadow/backtest parity. The core must not know why a candidate was rejected. The walk belongs
  in the orchestrator, which is already the sanctioned impurity boundary (ADR 0048 §4).
- **Keep the core slicing to `top_n` and re-invoke it on a shrinking universe after each rejection.**
  Rejected. It re-runs the sort O(top_n) times, leaks the "which symbols were rejected" state back
  into repeated core calls, and is strictly more complex than returning the full ranked list once and
  walking it. The core sorting once and the orchestrator consuming top-down is simpler and keeps the
  core stateless.
- **Compute closes from the naive top-`top_n` ranked slice (as today), then cascade opens.**
  Rejected — it is the churn bug: a held position just outside the naive slice is closed, then the
  cascade falls back onto it and reopens it, paying double fees. Closes must key off the post-walk
  `retained` set (§2.2).
- **Cap the cascade depth (e.g. `top_n + k`).** Rejected. Adds a config knob and a new
  silently-under-fill failure mode to defend against a load that does not exist (§2.3); at 24h cadence
  the worst case is ~100 in-memory evaluations once/day, dwarfed by the VWAP path's continuous
  per-bar traffic. `min_universe_size`/universe size is the natural, sufficient bound.
- **Give momentum its own disjoint slot pool now so `top_n = 3` never loses to VWAP.** Rejected as
  scope — this is the deferred ADR 0047 §2.4 / M50b disjoint-namespace work. `top_n = 3` fits the
  existing 3-slot model with no cap change; slot contention with VWAP stays a logged, expected outcome
  the cascade now tolerates.
- **Build a real momentum correlation classifier before raising `top_n`.** Rejected for M50b —
  correct long-term, disproportionate now (needs a beta/correlation source and a slot-C competition
  model). Documented as an accepted paper-only limitation and a HIGH live blocker instead (§3.3),
  matching the ADR 0048 §3.1 disposition.
- **Interval-plus-wall-clock-anchor (compute delay to 01:07, `setTimeout` then `setInterval(24h)`).**
  Rejected in favor of `@Cron`. More moving parts, re-anchors on every restart, accumulates timer
  jitter over long uptimes, and still lets `rebalance_interval_ms` drive cadence (keeping the
  sub-24h foot-gun). A fixed cron is drift-free, declarative, and pins cadence to the only validated
  value (§4.1).
- **Raise the frequency (rebalance 2–3×/day) instead of only anchoring it.** Rejected — unbacktested
  variant; re-ranks a barely-changed 24h metric and churns fees. Any sub-24h cadence is a new
  hypothesis requiring its own `EXP-0xx` before touching paper (§4).
</content>
</invoke>
