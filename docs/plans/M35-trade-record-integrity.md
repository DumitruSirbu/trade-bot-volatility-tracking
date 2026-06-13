---
adr: [0013, 0011, 0004, 0003, 0043, 0008, 0012]
modules: [position, execution, strategy, risk, analysis]
---

# M35 — Trade-record integrity (entry-snapshot persistence + exit-geometry guards)

## Context

A user-driven quant review (2026-06-13, VWAP-Edge persona) of the live paper-soak asked a
single question: *"why are more trades negative than positive?"* The honest top-line answer is
that **the question is not yet answerable** — there are only **11 closed trades**, below the
≥20–30-trade minimum for any directional read, and the win/loss count (5 / 6) flips on a single
trade. The investigation that question triggered surfaced **two confirmed defects in the trade
record (Findings 1 and 3), one latent-risk item (Finding 2), and one deferred strategy
observation (Finding 4)**. Until the two confirmed defects are fixed, key calibration inputs —
flow-classification, version comparison, exit-geometry sanity — are made on absent or
sign-corrupted data.

> **Review correction (2026-06-14).** The quant + logic reviewers independently overturned the
> original Finding 2 ("MAE/MFE understated 45–82×"). That claim was a **fraction-vs-percent
> misread**: `positions.mae_pct` is stored as a *fractional decimal* (ADR 0013;
> `instrumentationMath.ts:17-20`), so `-0.0262` is **−2.62%**, not "−0.0262%". Recomputed
> correctly, MAE/MFE **reconcile on all 11 rows**. Finding 2 is demoted to a MEDIUM latent-risk
> item; Finding 3's root cause is repointed from the (innocent) liquidation clamp to VWAP-anchor
> geometry. See each finding for detail.

This milestone is **not** a strategy-tuning milestone. It is a **data-integrity / instrumentation
hardening** milestone. The deliverable is a trade record you can trust, so that the *next* soak
window produces a dataset on which expectancy questions can actually be answered. No threshold,
stop, TP, or time-stop parameter is changed here (see Non-goals).

Verified against live code and the soak DB on 2026-06-13, reconciled against reviewer feedback
2026-06-14. Every finding below is reproduced from the actual `positions` table and quoted
against the real write-sites.

### The evidence (soak DB, 11 closed positions, all `strategy_version_id = 3`)

**Column units (read before interpreting):** `pnl` is realized USD. `raw_move%` is **not a DB
column** — it is the derived entry→exit price move (`(exit−entry)/entry × 100`), shown as a
percent, used only to sanity-check direction. `mae_pct` / `mfe_pct` are the **raw DB values,
stored as fractional decimals** (ADR 0013) — e.g. `-0.0262` = **−2.62%**. Do **not** read them as
percent. `sl_price` / `tp_price` are the persisted clamped exits (null pre-M33; see Context note).

```
id  symbol        side  exit_reason  pnl     raw_move%  mae(frac) mfe(frac) sl_price  tp_price
 1  VVV   long  take_profit  +3.864  +0.8085  -0.0324  +0.1234  (null)   (null)
 2  XMR   long  take_profit  +2.921  +0.6206  -0.0183  +0.2126  (null)   (null)
 3  ORCL  short stop_loss   -6.272  +1.2085  -0.0262  +0.0373  (null)   (null)
 5  OPN   long  manual      -0.061  +0.0678  -0.0080  +0.0094  (null)   (null)
 6  AMD   long  manual      +0.627  +0.2052  -0.0038  +0.0032  (null)   (null)
 7  MRVL  short time_stop   -6.492  +1.2554  -0.0152   0.0000  (null)   (null)
 8  WLD   long  take_profit  +6.129  +1.3082  -0.0066  +0.0116  0.459290 0.472331
 9  XPL   long  time_stop   -5.483  -1.0178  -0.0226   0.0000  0.083100 0.087120
10  XLM   short time_stop   +2.236  -0.5278  -0.0016  +0.0049  0.187362 0.184465
11  EDGE  short take_profit  -1.318  +0.1925  -0.0034   0.0000  0.445247 0.416661
12 1000SHIB long time_stop   -3.661  -0.6491  -0.0105  +0.0001  0.005001 0.005102
```

Aggregate by exit reason:

```
exit_reason   n   total_pnl   avg_pnl
take_profit   4    +11.60     +2.90
manual        2     +0.57     +0.28
stop_loss     1     -6.27     -6.27
time_stop     4    -13.40     -3.35
```

These per-reason aggregates are **descriptive only** — 11 trades dominated by 4 time-stops carry
no statistical weight (Finding 4). The entire net loss (−7.51) comes from **time-stop exits**; TP
exits are net positive. That is a holding-rule observation, not a signal observation — and it is
**not tunable**
until the instrumentation below is fixed.

---

## Findings

Severity uses the `docs/tech-debt.md` vocabulary: HIGH = go-live blocker, MEDIUM = feature gap,
LOW = cosmetic.

### Finding 1 — Entry snapshot is never persisted *(HIGH — confirmed, definitive)*

**Symptom.** `vwap_at_entry`, `atr_at_entry`, `vwap_deviation_at_entry`, `idiosyncrasy_at_entry`,
`signal_score_at_entry`, `open_interest_at_entry`, `oi_change_5m_at_entry`,
`funding_annualized_at_entry`, `book_depth_10bps_at_entry`, `spread_at_entry_pct`,
`vwap_anchor_type`, and `symbol_universe_age_hours` are **NULL on all 11 rows**.

**Root cause (confirmed).** `ExecutionService.createPositionFromFill`
(`apps/engine/src/execution/service/ExecutionService.ts:1114`) is the sole live open-path writer
(`PositionRepository.createOpen`). It persists only: `symbol`, `strategyVersionId`, `side`,
`state`, `leverage`, `entryPrice`, `qty`, `entryNotional`, `openedAt`, `coinTier`,
`positionSlot`, `correlationMode`, `timeStopAt`, `stopLossPrice`, `takeProfitPrice`,
`slippageModelPct`, `stopGapPct`, `flowTypeAtEntry`. **None of the twelve snapshot columns above
are set.** The columns exist on `PositionEntity` and in the M2 schema; nothing writes them.

**Downstream effect (confirmed).** Because `vwap_at_entry` is null, the instrumentor's reversion
metric short-circuits — `computeTimeToReversionPct`/`updateTimeToReversionSecs`
(`apps/engine/src/position/util/instrumentationMath.ts:91`) returns the prior value unchanged when
`vwapAtEntry === null`, so `time_to_reversion_secs` is **also NULL on every row**. One missing
write cascades into a second dead metric.

**Why it matters.** The persona's entire analytical framework — correlate outcome to
`signal_score`, segment by `flow_type` × `vwap_deviation`, compare v0/v1/v2/v3 on the same
`event_id` — is impossible without these columns. The bot is soaking blind on its own entry
context. This is the single highest-value fix in the milestone.

**Note (reviewer).** `flow_type_at_entry` is **already** populated (`createOpen` sets
`flowTypeAtEntry`, `ExecutionService.ts:1138`) — it is not among the twelve missing columns. The
developer must not redundantly re-add it.

**Proposed solution.**
- The values exist upstream at signal time. M27 (ADR 0043, "decision data-capture completeness")
  already stamps `decisions.market_snapshot` (JSONB) **at evaluation time** — that enrichment
  object is the source of truth.
- **Architect decision is effectively pre-decided by a trading invariant.** Two routes exist:
  (a) widen the approved-intent contract (`IOrderIntentApprovedEvent` / `IOrderIntent`) to carry an
  `entrySnapshot` sub-object; (b) re-read the latest `decisions.market_snapshot` for the `event_id`
  at `createPositionFromFill` time. **Route (b) is disqualified for determinism:** it reads at
  fill time, not evaluation time, so a backtest replay of the same `event_id` would not reproduce
  the persisted snapshot — violating the strategy-determinism / backtest-parity invariant
  (CLAUDE.md). **Take route (a)** (contract-widening), which routes through `bot-shared-maintainer`
  first. The architect still confirms the contract shape, but the route is constrained.
- **Snapshot is "as-of decision evaluation", not "as-of fill".** Document this on the columns:
  for latency-sensitive fields (`funding_annualized_at_entry`, `oi_change_5m_at_entry`) a
  multi-second fill delay means the value is the evaluation-instant reading, not the fill-instant
  one. Downstream analysis must treat them accordingly.
- Map every column in `createPositionFromFill`'s `createOpen({...})` literal.
- **Scope the write to the signal→approve→fill path only.** Positions created via reconciliation
  (`RECONCILED_*`) or `MANUAL_ADOPTED_UNMANAGED → OPEN` never flow through
  `createPositionFromFill` and will **legitimately** carry null snapshots — the acceptance
  criterion must exclude them or QA fails on a non-bug.
- **ADD path must NOT re-stamp.** An ADD changes blended entry price/notional, but the entry
  snapshot is an *open-instant* record and stays frozen at the original open. State this invariant
  so the developer does not re-write it on ADD.
- **Instrumentor seed dependency (no extra wiring, but sequence-sensitive).** `PositionInstrumentor`
  seeds `vwapAtEntry` from the persisted row at `onPositionOpened` (`PositionInstrumentor.ts:131`),
  which reads the row *after* the `createOpen` INSERT. Writing `vwapAtEntry` in that same INSERT is
  therefore sufficient to revive `time_to_reversion_secs` — no separate instrumentor change needed.
- Add a paired regression test asserting a position opened via the fill path has all snapshot
  columns non-null when the upstream snapshot was present, and that `time_to_reversion_secs`
  populates on a reverting trade.
- **Backfill is NOT possible** for the existing 11 rows (the snapshot was never captured) — accept
  the gap and start clean from the fix forward. Note this explicitly in the milestone close.

### Finding 2 — MAE/MFE seed-timing gap *(MEDIUM — latent risk; the original "understatement" was a measurement error)*

> **Corrected by review (2026-06-14).** The original framing — "MAE/MFE understated 45–82×, the
> accumulator freezes because the symbol leaves the universe" — is **withdrawn**. It was a
> fraction-vs-percent misread compounded by a structurally-prevented mechanism. Both points below.

**The original claim was wrong (measurement error, not a bug).** `mae_pct`/`mfe_pct` are stored as
**fractional decimals** (`instrumentationMath.ts:17-20`). Read correctly, MAE **reconciles on
every row**: the inequality `|mae| ≥ realized price excursion` holds throughout —

| id | side | realized adverse (price) | `mae` (fraction → %) | reconciles? |
|----|------|--------------------------|----------------------|-------------|
| ORCL | short | −1.21% | −0.0262 = **−2.62%** | ✓ (more adverse, as expected) |
| MRVL | short | −1.26% | −0.0152 = **−1.52%** | ✓ |
| XPL | long | −1.02% | −0.0226 = **−2.26%** | ✓ |
| EDGE | short | −0.19% | −0.0034 = **−0.34%** | ✓ |

The "non-constant ratio ⇒ not a units typo" argument in the original was backwards: dividing a
correct, varying adverse move by a correct, varying MAE *and misreading the latter's scale* is
exactly what produces a non-constant phantom ratio. The `mfe = 0` rows (MRVL, XPL, EDGE) are also
**correct** — those positions went straight adverse and never traded above entry, so MFE is
genuinely zero (`updateMfePct` only raises on favorable ticks). **There is no understatement.**

**The "universe-drop freezes the tape" mechanism is structurally prevented.** A
`SubscriptionRetainer` pins every open-position symbol: `UniverseService.emitLeavers`
(`apps/engine/src/market-data/service/UniverseService.ts:190-214`) skips eviction when
`subscriptionRetainer.isRetained(symbol)`, and `PositionLifecycleRetentionListener`
(`apps/engine/src/position/service/PositionLifecycleRetentionListener.ts:45-50`) retains the symbol
from **PENDING_OPEN** until **CLOSED**. The feed is a single market-wide `!ticker@arr` socket
(`MarketDataService.ts:24,111`), not a per-symbol subscription. So a held symbol cannot fall out of
`getEntry` and stop emitting `price.update`.

**What remains real (the latent risk, MEDIUM).** The accumulator is seeded only on
`POSITION_OPENED_EVENT`, which fires *after* the PENDING_OPEN→OPEN transition and protective attach
(`ExecutionService.ts:966-982`), via an **async** `seedFromRow` DB read
(`PositionInstrumentor.ts:225-226, 280-290`). Any `price.update` arriving between the event emit
and the async seed completing is a map-miss (`onPriceUpdate`, `PositionInstrumentor.ts:184`). The
service doc-comment claims PENDING_OPEN ticks are sampled (`PositionInstrumentor.ts:72-74`), but no
accumulator exists during PENDING_OPEN, so **early excursion can be bounds-lost**. This would never
produce a sustained understatement (the data confirms it has not), but it can clip the first ticks
of MAE/MFE.

**Why fix it despite the clean data (priority rationale).** This is a *volatility-tracking*
strategy — entries fire on a spike, and the most violent excursion typically lands in the **first
few seconds after entry**, which is precisely the window this gap drops. The dropped sample is
therefore the single most informative MAE reading the strategy produces, and the defect is
structurally mis-aligned with where this strategy's risk concentrates. The 11-row sample stayed
clean only because those losers bled slowly over minutes (time-stops), not off the entry spike —
luck of the sample, not a guarantee. Closing the gap is cheap and protects MAE/MFE exactly where it
matters most; hence MEDIUM and **in-milestone**, not deferred to tech-debt — though still not a
soak-blocking defect.

A secondary cadence note: `!ticker@arr` pushes ~1/sec and includes a symbol only when its 24h
ticker changed in the window, so a quiet symbol is sparsely sampled — also benign for MAE/MFE
(extremes still register) but relevant if sub-second fidelity is ever required.

**Proposed solution (MEDIUM, in-milestone; not soak-blocking).**
- Close the seed-timing gap: seed the accumulator **synchronously at PENDING_OPEN** (or buffer
  pre-seed ticks per symbol and replay them into the accumulator once `seedFromRow` resolves), so
  the doc-comment promise (`:72-74`) becomes true and no early tick is dropped.
- **Keep the reconcile invariant as a permanent regression test** — it is the real acceptance gate
  regardless of the seed fix. Word it precisely: for a **single-fill, no-ADD** position, comparing
  against the **price-only** excursion (exit vs original entry, **not** `realized_pnl`, which
  includes fees + funding), `|mae| ≥ |adverse price excursion|` within a slippage+inter-tick-gap
  tolerance band. It is a one-directional sanity floor, **not** an equality, and must be scoped
  away from ADD/reduce (which move the entry reference) and from funding-bearing holds.
- The test must drive ticks through the **actual `onPriceUpdate` event path** (not call the pure
  updater directly), so it also exercises the seed-timing window above.

### Finding 3 — Wrong-side TP geometry produces a mislabeled `take_profit` loss *(HIGH — confirmed)*

**Symptom.** EDGE/USDT (id 11): `short`, entry `0.414977`, **`stop_loss_price = 0.445247`
(+7.30% above entry — correct side for a short), but `take_profit_price = 0.416661`
(+0.41% *above* entry — WRONG side for a short)**. A short's TP must be *below* entry. Exit filled
at `0.415775`; the breach classifier (LONG/SHORT-aware) fired TP because for a short
"TP breached if mark ≤ TP" and `0.415775 ≤ 0.416661`. Result: a close tagged `take_profit` that
actually **lost −1.318** with `mfe_pct = 0` (price never went favorable).

**Contrast (rules out a universal short-inversion).** XLM/USDT (id 10), also a short, has correct
geometry: SL `0.187362` (above), TP `0.184465` (below entry `0.185401`). So the bug is **not** "all
shorts inverted" — it is a degenerate VWAP geometry on a specific class of event.

**Root cause (confirmed by review — repointed).** The breach classifier in
`LocalProtectiveMonitor.evaluateBreach` (`apps/engine/src/execution/service/LocalProtectiveMonitor.ts:129`)
is correct and innocent. The original draft blamed the `sl_outside_liquidation` clamp — that is
**wrong**: `clampExitToLiquidation` / `tightenStop` (`RiskGateService.ts:1105,1124-1128`) mutate
**only the stop**; `takeProfitPrice` passes through the gate completely **unvalidated and
unclamped** (grep confirms no TP-side check anywhere in `RiskGateService`). The wrong-side TP is
born **in the strategy**, at `computeMeanReversionTakeProfit`
(`apps/engine/src/strategy/strategies/meanReversionCore.ts:148-156`):
`TP = vwap + (referencePrice − vwap) × OFFSET`. For a mean-reversion short, entry sits above VWAP
and the TP should land between them (below entry). But when `vwapSession ≥ referencePrice` at
signal time — a degenerate VWAP on a thin / young / low-priced coin like EDGE — the TP lands **at
or above entry**, i.e. wrong-side. ATR, spread, and the liquidation clamp are **not** involved.

So there are **two** defects, at two layers:
1. **Strategy (origin):** `meanReversionCore.ts:148-156` can emit a wrong-side / cost-negative TP
   under a degenerate VWAP relationship.
2. **Risk gate (missing guardrail):** there is no TP-side analogue of `isWrongSideStop`
   (`RiskGateService.ts:1113-1122`), so the bad TP is never caught — unlike a wrong-side stop,
   which *is* rejected.

**Why it matters (trader lens).** A TP on the wrong side of entry is not a small mislabel — it is a
**guaranteed-adverse profit target**: the position can only "take profit" by first moving against
you, so the so-called winner is a structural loser. Worse, an unclamped TP placed only ~0.4% from
entry (EDGE) sits *inside the round-trip cost*: even a correct-side TP that close is net-negative
after taker fees + funding + slippage. The per-reason aggregate is poisoned (`take_profit` shows
+11.60, but one of those four is a −1.318 loss), and on a live book this arms trades that cannot
win.

**Proposed solution.**
- **Strategy fix (origin):** in `computeMeanReversionTakeProfit`, guard the degenerate VWAP
  relationship so a short TP can never be emitted at or above the reference/entry price (mirror for
  long). If VWAP geometry is degenerate, the correct behaviour is to **skip the trade**, not arm a
  wrong-side target — consistent with skip-as-first-class-output.
- **Risk-gate guardrail (defence in depth):** add a wrong-side-TP **hard reject** mirroring
  `isWrongSideStop` — a new `RejectReasonEnum` value. Policy is **reject, not silent repair**, to
  match the existing stop convention and preserve live/backtest parity (a repaired TP would diverge
  from what a replay computes). Required invariant: short ⇒ `TP < entry < SL`; long ⇒
  `SL < entry < TP`.
- **Cost-aware distance (trader requirement):** beyond the sign check, reject a TP whose
  profit distance is **smaller than the modelled round-trip cost** (taker fees both legs +
  slippage model + expected funding over the hold) — otherwise the sign fix still arms
  cost-negative TPs like EDGE's 0.41%. This is a geometry/cost guard, **not** a strategy-parameter
  change (no TP *distance target* is altered; we only reject targets that cannot clear costs).
- **Paired adversarial tests:** (a) a short whose `vwapSession ≥ referencePrice` must skip or be
  rejected — never arm a wrong-side TP; (b) a correct-side TP closer than round-trip cost must be
  rejected.

### Finding 4 — time-stop / TP holding asymmetry *(DATA observation — NOT a bug, NOT actionable yet)*

**Observation.** Losers run to `time_stop` having gone fully adverse (`mfe = 0` on 2 of 4); winners
are cut at TP. `time_stop` exits are the entire net loss; TP exits are net positive. That is a
classic negative-skew holding rule ("let the loser ride to the clock, take the winner early").

**Why it is listed but not fixed here.** (a) n = 11 carries no statistical weight — the apparent
skew is 4 trades, and one trade flips the win/loss count. (b) It **cannot be segmented until
Finding 1 is fixed**: without the entry snapshot you cannot tell which `flow_type` / `signal_score`
/ `vwap_deviation` band the time-stop losers came from, so any time-stop change would be blind.
Note (post-review): MAE/MFE are *not* broken (Finding 2 corrected), so the excursions on these
losers are trustworthy — but the segmentation that would justify a holding-rule change still
depends on Finding 1. Calibrating the time-stop now is premature. **Explicitly deferred** to a
post-fix soak window with ≥ 20–30 closed trades and a v0 same-`event_id` skip baseline.

**Trader read (for the eventual tuning, not now).** The pattern — winners cut at a tight TP,
losers held to the clock having gone straight adverse — is the classic negative-skew signature of
a TP that is too close relative to the stop/time-stop. The Finding 3 cost-aware TP guard partially
addresses the "TP too tight" leg by rejecting sub-cost targets. Whether the time-stop itself is too
long (letting adverse-from-entry trades bleed the full move) is the open question for the post-fix
soak, answered with the now-trustworthy MAE/MFE distribution plus the restored entry-snapshot
segmentation — not before.

### Context note — NULL SL/TP on the first six rows *(already resolved by M33 — no action)*

Positions 1, 2, 3, 5, 6, 7 have NULL `stop_loss_price`/`take_profit_price`. These pre-date M33
Task 5, which began persisting the clamped SL/TP at INSERT time (`ExecutionService.ts:1134-1135`,
comment block `:1128-1133`). New rows (8–12) carry the prices. No fix required; noted so the NULLs
are not mistaken for a regression.

---

## Scope (this milestone)

**Two confirmed HIGH defects ship; one MEDIUM hardening is optional-in-window; one observation is
deferred.**

1. **Finding 1 — persist the entry snapshot** at `createPositionFromFill`, via the contract-widening
   route (determinism-mandated), scoped to the signal→approve→fill path. *(HIGH — primary)*
2. **Finding 3 — guarantee exit geometry**: strategy fix at the origin
   (`computeMeanReversionTakeProfit`) + risk-gate wrong-side-TP reject (mirror of `isWrongSideStop`)
   + cost-aware minimum-TP-distance reject. Invariant: short ⇒ `TP < entry < SL`. *(HIGH)*
3. **Finding 2 — close the MAE/MFE seed-timing gap** (synchronous PENDING_OPEN seed or pre-seed
   tick buffer) + land the reconcile invariant as a permanent regression test. *(MEDIUM — the
   original "understatement" was a measurement error; this no longer blocks the soak and may be
   split to a follow-up if it inflates the wave.)*

Findings 1 and 3 are the deliverable. Each lands as its own ≤5-file dispatch wave per
`docs/best-practices/dev-qa-cycle.md`, with paired tests, then the parallel reviewer wave
(security + logic + clean-code + quant), then the scribe.

- **Finding 1** needs a `bot-shared-maintainer` pass first (widen `IOrderIntentApprovedEvent` /
  `IOrderIntent` with `entrySnapshot`). The **architect** confirms the contract *shape*, but the
  *route* is already constrained to contract-widening by the backtest-determinism invariant — the
  decisions-table-join route is disqualified (reads at fill time, breaks replay).
- **Finding 3** spans `strategy` + `risk` modules and adds a `RejectReasonEnum` value (shared
  enum) — route the enum addition through `bot-shared-maintainer` and flag the architect since it
  touches the strategy→risk contract.
- **Optional co-located shared-contract addition (LOW):** if the architect is already widening the
  price/intent contracts, consider adding the `(markPrice, lastPrice)` split to
  `IPriceUpdateEvent` so `mark_vs_last_max_divergence_pct` (also structurally null —
  `PositionInstrumentor.ts:89-95`) can populate, avoiding a second `bot-shared-maintainer` round.
  Not required for this milestone.

## Non-goals (explicit)

- **No strategy parameter changes.** No stop distance, *TP distance target*, time-stop duration,
  idiosyncrasy threshold (stays 0.5), or flow-classification logic is tuned. The Finding 3 strategy
  edit is a **correctness guard, not a calibration**: it makes a degenerate-VWAP short *skip* and
  rejects geometrically-impossible / sub-cost targets — it does not change the TP offset for valid
  geometry. This milestone makes the record trustworthy; it does not tune what the record shows.
- **No time-stop / holding-rule tuning** (Finding 4) — deferred to a post-fix soak.
- **No backfill** of the 11 existing rows' entry snapshot (data was never captured; impossible).
- **No Claude model migration**, no cloud/topology work — out of scope as in M20.

## Sample-size discipline (carry into the close)

The motivating question ("more trades negative than positive") is **statistically unanswerable at
n = 11** and must not be answered until the instrumentation is fixed AND the soak has produced
≥ 20–30 closed trades, with a v0 same-`event_id` skip-baseline comparison. The milestone close must
restate this so the fixed instrumentation is not immediately over-interpreted on a thin sample.

## Acceptance criteria

- [ ] **Finding 1:** every position opened via the **signal→approve→fill path** persists all
      entry-snapshot columns non-null when the upstream snapshot is present; reconciliation- and
      manual-adopted-created positions are explicitly exempt. `time_to_reversion_secs` populates on
      reverting trades. ADD does **not** re-stamp the snapshot.
- [ ] **Finding 1 (determinism):** a backtest replay of the same `event_id` reproduces identical
      snapshot columns (proves the evaluation-time, contract-carried route — not a fill-time
      re-read).
- [ ] **Finding 3:** no position can be armed with a wrong-side TP or SL (short ⇒ `TP < entry < SL`;
      mirror for long), nor with a TP whose distance is below modelled round-trip cost; both are
      hard-rejected at the risk gate with a dedicated `RejectReasonEnum`. The strategy skips rather
      than emits a wrong-side TP on degenerate VWAP. Covered by paired adversarial tests
      (degenerate-VWAP short; sub-cost TP).
- [ ] **Finding 2 (if shipped in-window):** the MAE/MFE accumulator seeds synchronously at
      PENDING_OPEN (no dropped early ticks); the reconcile invariant — single-fill/no-ADD,
      price-only excursion, one-directional `|mae| ≥ |adverse|` within tolerance — lands as a
      permanent regression test driven through the `onPriceUpdate` event path.
- [ ] Reviewer wave clears: zero blockers, zero highs, majority of mediums resolved.
- [ ] Live-app smoke (per `feedback-milestone-app-smoke`) runs clean; scribe updates
      `docs/STATUS.md`, `docs/milestone-log.md`, `docs/tech-debt.md`, `docs/work-log.md`.

## Key code sites (verified)

- `apps/engine/src/execution/service/ExecutionService.ts:1094-1140` — `createPositionFromFill`
  (Finding 1 write-site; M33 SL/TP-at-insert at `:1134-1135`).
- `apps/engine/src/strategy/strategies/meanReversionCore.ts:148-156` — `computeMeanReversionTakeProfit`
  (Finding 3 origin: degenerate-VWAP wrong-side TP).
- `apps/engine/src/risk/service/RiskGateService.ts:1105,1113-1128` — `clampExitToLiquidation` /
  `isWrongSideStop` / `tightenStop` (Finding 3: stop-only clamp, missing TP-side reject).
- `apps/engine/src/execution/service/LocalProtectiveMonitor.ts:129-141` — `evaluateBreach`
  (correct/innocent classifier).
- `apps/engine/src/position/util/instrumentationMath.ts:17-35,79-101` — fractional-decimal units;
  reversion early-return on null `vwapAtEntry` (Finding 1 cascade; Finding 2 units correction).
- `apps/engine/src/position/service/PositionInstrumentor.ts:72-74,131,184,225-290` — seed timing
  (Finding 2 latent risk).
- `apps/engine/src/market-data/service/UniverseService.ts:190-214` +
  `apps/engine/src/position/service/PositionLifecycleRetentionListener.ts:45-50` — subscription
  retainer that prevents the withdrawn "universe-drop freeze" mechanism.

## References

- ADR 0013 — position instrumentation (MAE/MFE/reversion accumulator; fractional-decimal units).
- ADR 0011 — protective orders + breach classification.
- ADR 0004 — risk gate (wrong-side-stop reject; the missing TP-side mirror).
- ADR 0003 — strategy engine (mean-reversion TP geometry).
- ADR 0043 / M27 — decision data-capture completeness (`decisions.market_snapshot` is the snapshot
  source of truth, stamped at evaluation time).
- ADR 0008 / 0012 / M33 — live exit enforcement (time-stop + paper protective simulation), the
  branch on which the exit path currently lives.
- Source of findings: live soak DB + code, 2026-06-13 quant review; reconciled against quant +
  logic reviewer feedback 2026-06-14.
