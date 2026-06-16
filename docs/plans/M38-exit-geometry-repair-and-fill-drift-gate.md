# M38 — Exit-geometry repair + fill-acceptance guard (rebase momentum TP to actual fill price, reject + unwind wrong-side/over-slippage fills, then promote V3 hybrid on M37 data)

> **Sequencing note:** M38 is a **trade-geometry-correctness** milestone. M37 fixed the *measurement
> instruments* (shadow fill simulator, comparison read layer, backtest fills, exit-label integrity).
> M38 fixes the *trades themselves*: the exit geometry (TP/SL) armed on a momentum position is
> computed from the **signal-time reference price and frozen** — it is never rebased to the **actual
> fill price**. When the paper fill lands away from the signal price (which it does on >50% of the
> live sample), the armed TP and/or SL land on the **wrong side of entry**, producing instant fake
> exits and structurally unreachable targets. M37's `tpEligible` guard fixes only the **label**; M38
> fixes the **geometry**. Every change preserves the trading-safety invariants in `CLAUDE.md`: **no
> order path bypasses the risk gate**, **strategies stay pure/deterministic** (the rebase happens in
> the execution layer at fill-acceptance, not in the strategy), **money is `decimal`**, and the
> structural risk budget (SL = VWAP, one R) is preserved, not loosened. M38 does **not** invent a new
> strategy — D3 promotes the already-built V3 hybrid, and only after M37's repaired shadow data backs
> the switch.

## Context

The persona quant (`VWAP-Edge`) ran an independent analysis of the live paper-soak over the
**trailing 48 hours** (closed positions `2026-06-14 20:25 → 2026-06-16 04:50 UTC`, queried directly
against the soak DB on `2026-06-16 04:57 UTC`). This milestone is the result. It **confirms** the
three problems first flagged in `docs/wip/m38-momentum-exit-geometry-and-strategy-routing.md`
(2026-06-15, 24h window) on a fresh, larger window — and **extends** the diagnosis with one finding
that contradicts a claim in the WIP brief.

### Sample (independently re-derived, 48h)

| Metric | Value |
|--------|-------|
| Closed positions | **45** |
| Strategy versions in the closed set | **V2 momentum only** (`strategy_version_id = 3`) — no realized v0/v1/v3 trades to compare against |
| Net realized PnL | **−$88.78** |
| Win rate (PnL > 0) | 3 / 45 ≈ **6.7%** (and the 3 "wins" are +$0.01, +$0.40, +$1.78 — at or near fee-noise) |

Breakdown by exit reason:

| exit_reason | n | net_pnl | avg_hold_s | zero_mfe (price never ticked in favour) |
|-------------|---|---------|-----------|------|
| `take_profit` | 23 | +$8.14 | 51.9 | 19 / 23 |
| `stop_loss` | 9 | −$45.33 | 241.1 | 7 / 9 |
| `time_stop` | 13 | −$51.60 | 903.8 | 9 / 13 |

The `take_profit` bucket being net-positive is an artefact: 19 of its 23 rows have `mfe_pct = 0`
(price never moved in our favour) and exited in ~1 second — these are **fake/instant exits**, not
realised edge. The real economic damage is the `time_stop` (−$51.60) and the genuine `stop_loss`
(−$43.52, see below) buckets.

### Loss attribution (added after quant review — corrects the WIP brief's emphasis)

The quant reviewer's central correction, **verified independently against the DB**: the
signal-to-fill *drift* axis and the *economic loss* axis are **not the same thing** in this sample.
Splitting the 45 positions at the proposed 2.0% drift gate:

| bucket | n | net_pnl |
|--------|---|---------|
| drift > 2.0% (would be rejected by D2) | 12 | **−$4.29** (fee noise — the instant exits) |
| drift ≤ 2.0% (kept) | 33 | **−$84.49** (95% of the loss survives the gate) |

By flow type:

| flow_type | n | net_pnl |
|-----------|---|---------|
| `catalyst_risk` | 36 | **−$66.92** |
| `trend_initiation` | 8 | **−$21.46** |
| `market_beta` | 1 | −$0.41 |

Sharper still — split by **whether D1 even touches the position** (quant-verified):

| set | n | net_pnl | fixed by |
|-----|---|---------|----------|
| wrong-side geometry (instant exits) | 23 | **−$8.30** | D1 + D2 (correctness) |
| correctly-armed (ran to stop / time-stop) | 22 | **−$80.48** | **only D3** (flow selection) |

So **D1 + D2's economic ceiling on this window is ≈ −$12.6 of fee-noise (~14% of the loss)**; the
remaining ≈ **−$80 is untouchable by geometry repair** and addressable only by D3. D1's true value is
making that −$80 **measurable on clean trades** so D3 can be judged on uncontaminated data.

**Conclusion that reorders the milestone:** the real economic bleed is **direction/flow selection**
(V2 following `catalyst_risk` and `trend_initiation` into reversal), which is the **D3** problem — not
drift. Therefore:

- **D1 (TP rebase)** is a *correctness-by-construction* fix: it removes a provably wrong armed level.
  It is the safe, immediate fix but it does **not** by itself recover the −$84 — it makes the
  surviving trades *measurable*.
- **D2 (drift + wrong-side gate)** is a **structural-safety / slippage guard**, worth only ~−$4.29 +
  −$1.81 of removed fee-noise here. It is **not** the primary economic fix — that framing (carried
  from the WIP brief) was wrong and is corrected below.
- **D3 (V3 promotion, gated)** is the only deliverable that addresses the economic loss, and only on
  M37-backed evidence.

> **Sample-size discipline (persona rule 1).** All 45 closed positions are a **single version (V2)**.
> There is **no realized counterfactual** for v0/v1/v3 in the closed-position data — the shadow fills
> are the hollow ones M37 just repaired, so they carry no PnL yet. Per-`flow_type` cells are n < 25.
> Every verdict below is about **mechanism** (geometry that is provably wrong by construction),
> **not** about strategy expectancy. No parameter (`MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER`,
> `time_stop_minutes`, any threshold) is tuned in M38 — the instrument was contaminated; you do not
> calibrate on a contaminated instrument.

---

### Post-M37-rebuild confirmation — the geometry bug is still firing (engine rebuilt 2026-06-16 04:47 UTC)

M37 (including the `tpEligible` exit-label guard) was deployed at the engine rebuild **2026-06-16
04:47 UTC**. The 10 positions opened **after** the rebuild (window to 08:50 UTC) confirm M37 fixed the
*symptom*, not the *cause*:

| post-rebuild (n=10) | result |
|---------------------|--------|
| sub-2s instant fake take-profits | **0** (was 14/31 pre-rebuild — `tpEligible` is suppressing the instant case) |
| **positions that still armed a wrong-side TP** | **2 / 10** (`take_profit_price` below a LONG entry) |
| **`take_profit` exits closing at a LOSS** | **2** — id 68 ETH (entry 1809.65, TP **1804.22**, −$0.95) and id 70 BASED (entry 0.08384, TP **0.08364**, −$0.65), both `mfe = 0` |
| time-stops (still late/wrong-direction) | 6 / 10, mostly `catalyst_risk`, ~0 mfe |
| net PnL | +$8.04 — **n=10 is noise, not evidence M37 "works"** |

**Interpretation:** the TP is still computed from signal-time price and frozen, so a TP armed
marginally on the wrong side of the fill is still reached shortly after open and closes as a *losing*
`take_profit`. `tpEligible` is only a label backstop at the entry instant — it does **not** move the
level — and it visibly missed ids 68/70 (entry was past TP at fill yet still labeled `take_profit`, a
secondary `tpEligible` gap worth its own look). **Only D1 (rebase TP to the actual fill price) removes
this by construction.** The direction/flow loss (still `catalyst_risk`-dominated, time-stops with ~0
mfe) is likewise untouched → D3 still required. M37 made the failure *less visible*, not *less real*.

### Problem 1 (PRIMARY mechanism) — exit geometry is frozen at signal time and never rebased to the fill price

The momentum exit is built **pre-fill**, in the pure strategy layer:

`apps/engine/src/strategy/strategies/momentumCore.ts:41-48`
```ts
const referencePrice = reconstructReferencePrice(event);              // VWAP × (1 + dev/100) = signal-time candle close
const atrTarget      = new Money(event.atr14).times(MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER);
const takeProfitPrice = tradeSide === LONG ? referencePrice.plus(atrTarget) : referencePrice.minus(atrTarget);
// ...
stopLossPrice: new Money(event.vwapSession),                          // SL anchored to VWAP (structural)
```

`ExecutionService` then arms the protective monitor **directly from the frozen values** and never
substitutes the realised fill price (which it already has in scope as
`fillSummary.avgFillPrice`, used at `ExecutionService.ts:1102` for the stop-distance calc):

`apps/engine/src/execution/service/ExecutionService.ts:1136-1137` (and :927-928, :951-952, :1200-1201)
```ts
stopLossPrice:   event.clampedExit.stopLossPrice,    // signal-time
takeProfitPrice: event.clampedExit.takeProfitPrice,  // signal-time
```

**Data proof.** In **every one of the 45** positions, `stop_loss_price = vwap_at_entry` exactly —
the SL is the frozen VWAP. And **23 of 45 (51%)** have an exit level on the **wrong side of the
actual entry price**:

| Geometry defect at fill | count |
|---|---|
| LONG with `take_profit_price ≤ entry_price` (TP unreachable / instant fire) | 15 |
| SHORT with `take_profit_price ≥ entry_price` (TP unreachable / instant fire) | 4 |
| LONG with `stop_loss_price ≥ entry_price` (instant stop) | 1 |
| SHORT with `stop_loss_price ≤ entry_price` (instant stop) | 3 |
| **Total positions with ≥1 wrong-side level** | **23** |

All 23 exited in ≤2 seconds. Representative rows:

| id | symbol | side | entry | tp | sl(=vwap) | exit_reason | pnl |
|----|--------|------|-------|----|-----------| ------------|-----|
| 41 | XLM  | long  | 0.22620 | **0.21829** | 0.20357 | take_profit | −0.68 |
| 45 | AAVE | long  | 77.41595 | **75.11994** | 72.88521 | take_profit | −0.08 |
| 54 | ENA  | short | 0.08496 | **0.08502** | 0.08702 | take_profit | +0.01 |
| 29 | TAO  | long  | 275.45256 | 284.63413 | **275.68925** | stop_loss | −0.52 |

(For 41/45 the TP sits *below* a LONG entry → the "price ≥ TP" condition is already true at fill →
instant fake `take_profit`. For 29 the SL sits *above* a LONG entry → instant `stop_loss`.)

This is the WIP brief's "Problem 1", **independently reconfirmed** on the 48h window. M37's
`tpEligible` guard suppresses the *mislabel*; it does not move the level. The position is still armed
with an unreachable target and is locked into running to SL or the time-stop — both losses.

---

### Problem 1b (NEW — corrects the WIP brief) — the wrong-side failure is two-sided; SL is *not* "fine as-is"

The WIP brief asserts: *"The SL (`vwapSession`) remains anchored to VWAP … this is intentional and
correct … Only TP moves."* **The 48h data contradicts the second half of that claim.**

4 positions instant-stopped (≤5 s, net −$1.81) because the **SL itself was on the wrong side of
entry**. The mechanism: the SL is the frozen VWAP, so when the fill drifts to the **wrong side of
VWAP**, the SL is violated the instant the position opens. Cross-check:

| condition | count |
|---|---|
| LONG filled *below* VWAP (→ SL=VWAP sits above entry) | 1 |
| SHORT filled *above* VWAP (→ SL=VWAP sits below entry) | 3 |
| **= instant wrong-side stops** | **4** |

The right conclusion: **anchoring SL to VWAP is correct as a risk-budget choice, but only valid when
the fill is on the correct side of VWAP.** Rebasing the SL to the fill (as the WIP brief implies only
TP needs) would *destroy* the one-R structural budget and is the wrong fix. The correct fix is to
**reject the open** when the fill lands on the wrong side of the structural SL — which is exactly what
the Problem 2 drift gate does. This is why **D2 (drift/side gate) is reframed as the primary
deliverable, not secondary** — it subsumes both wrong-side TP and wrong-side SL at the source.

---

### Problem 2 (entries land after the move is exhausted — but NOT explained by drift)

Positions that fill late, into an already-spent move, bleed to the stop or the time-stop with **no
favourable excursion**.

- `time_stop`: 13 positions, **−$51.60**; **9 of 13 have `mfe_pct = 0.000`** and the rest ≤ 0.003.
  Worst: VVV long −$11.84, XPL long −$7.43, VVV long −$7.06, FET long −$6.66.
- `stop_loss`, split by hold time:

| kind | n | net_pnl | avg_mfe |
|------|---|---------|---------|
| genuine stop (held > 5 s) | 5 | **−$43.52** | 0.002 |
| instant wrong-side stop (≤ 5 s) | 4 | −$1.81 | 0.000 |

> **MFE confound (added after quant review).** The headline "35/45 have `mfe_pct = 0`" is
> **half-tautological**: 19 of those are the instant `take_profit` exits that closed in ~1.3 s — they
> have zero MFE because *no time elapsed*, not because the entry was late. The valid late-entry
> signature is only on the **held** subset: **13 of 23 positions held > 5 s have `mfe_pct = 0`** (price
> never ticked in our favour after entry). That is the real, non-tautological figure.

**Crucial correction (quant-verified):** this late-entry damage is **not** the high-drift set. The
worst economic losers have *low* drift — the largest single loss was a `catalyst_risk` short stopping
out at **0.28% drift**, −$23.73; the worst time-stop (VVV −$11.84) was 1.49% drift. So "late /
exhausted entry" here is a **direction-selection** failure (V2 follows a move that then reverts), not
a signal-to-fill *latency* failure. The D2 drift gate does **not** fix it — D3 (flow routing) does.
This is the key place where the WIP brief's "Problem 2 = staleness, fixed by a drift gate" framing was
wrong.

---

### Problem 3 (direction selection) — V2 follows `catalyst_risk` into the reversion

Consistent with the WIP brief and the M37 motivating example: the closed set is dominated by
`catalyst_risk` flow, and V2 momentum *follows* these liquidation-driven moves rather than fading
them. **This is the weakest-evidence finding and stays gated**: per-flow cells are n < 25, and there
is no realized v3 counterfactual in the closed data (only routing logic). The "V3 would have saved
~70%" figure in the WIP brief is derived from **decision routing, not realized shadow PnL**, and must
not be quoted as a measured result until M37's repaired shadow ledger produces same-`event_id`
counterfactual PnL. D3 below is therefore **gated on M37 data + the ADR 0019 promotion gate**, not on
this window.

---

## Goal

Make the exit geometry armed on every position **correct by construction relative to the actual
fill** (D1), and **reject + unwind** fills that land on the wrong side of their own stop or beyond a
gross slippage bound (D2) — so the next soak window measures *strategy* behaviour instead of
*geometry-bug* behaviour. Then, and only then, promote V3 on M37-backed evidence (D3) — the only lever
that addresses the actual economic loss (flow selection), which D1/D2 deliberately do **not** touch.

**Non-goal restated:** M38 changes **no** strategy parameter and invents **no** new strategy. It
repairs execution-layer geometry, adds one fill-acceptance gate, and (gated) flips an
already-shipped version from shadow to active.

---

## Workstreams & design decisions

### D1 — Rebase momentum TP to the actual fill price at arm time (execution layer) — PRIMARY correctness fix

**Where:** `apps/engine/src/execution/service/ExecutionService.ts` (post-fill, before
`LocalProtectiveMonitor.arm`, lines ~922-930 / ~1136-1137). The strategy layer stays pure —
`momentumCore.ts` keeps emitting the signal-time geometry; the **rebase is an execution-layer
transform applied once the fill is known.**

**Behaviour:** after the open fill is confirmed, recompute the TP from the realised fill price:
```
takeProfitPrice = avgFillPrice ± atrDistance      (+ for LONG, − for SHORT)
```
where `atrDistance` is the **same distance the strategy already computed**
(`atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER`). The multiplier is unchanged — only the **anchor**
moves from signal price to fill price. The value persisted to `take_profit_price` and passed to
`arm()` is the rebased one. **SL is NOT rebased** (structural VWAP budget; D2 handles wrong-side SL).

**Input-source correction (logic review — was a blocker):** the execution open path does **not** have
the raw `IVolatilityDetectedEvent`, so it **cannot call `reconstructReferencePrice(event)`**. It has
`IOrderIntentApprovedEvent`, which carries `clampedExit` and an **optional** `entrySnapshot:
IMarketSnapshot` (`vwap_session`, `vwap_deviation_pct`, `atr_14`). The rebase must therefore consume
`fillSummary.avgFillPrice` (already in scope, used at `ExecutionService.ts:1102`) plus the
**ATR distance carried on `clampedExit`** — not the strategy helper.

**Pin a single distance representation (quant review).** `bot-architect` adds **one** field
`atrDistance: MoneyValue` to `clampedExit`, **computed once in the strategy layer** (`momentumCore.ts`)
and **consumed verbatim** by both the live arm seam and `BacktestOrchestrator`. Do **not** allow either
path to re-derive `atr_14 × MULTIPLIER` — re-derivation (live carries a `Money`, backtest re-multiplies
a snapshot string) can diverge at the last decimal and fail the parity test (#5). The carried distance
must be the **post-clamp** distance (the value is `clampedExit` — if the risk gate clamps SL/TP, a
pre-clamp `atrDistance` would reintroduce SL/TP-anchor drift; logic review).

**Decimal op-order (quant review).** Where a reference price is reconstructed (D2 below), build it as
`new Money(vwap_session).times(ONE.plus(new Money(vwap_deviation_pct).dividedBy(100)))` — the **exact
op order** of `entryHelpers.ts:44-46` — not a re-grouped/pre-multiplied variant, so it is bit-identical
to the strategy-layer original.

**Fallback when `atrDistance` / `entrySnapshot` is absent:** do **not** rebase; arm the original
geometry and rely on D1's verification query + the `tpEligible` backstop to flag it (don't reject).

**Scope decision — RESOLVED to momentum-only (was flagged "open"; logic review closed it).** The
rebase must **not** touch the mean-reversion path: reversion TP is **VWAP-anchored** (not
reference+ATR), so applying the momentum `fill ± ATR` formula would *corrupt* it. The discriminator
the WIP/earlier draft assumed (`stopType` "anchor type") **does not exist** — both momentum
(`momentumCore.ts:49`) and reversion (`meanReversionCore.ts:145`) set `stopType: STRUCTURAL`. So D1
requires an **explicit** rebase-eligibility field on `IProposedExit`/`clampedExit` (e.g.
`tpAnchor: 'reference' | 'vwap'` or `tpRebaseEligible: boolean`), routed through
`bot-shared-maintainer` + `bot-architect`. Without it the execution layer cannot distinguish the two
strategies.

**Relationship to D2 (not substitutes — complementary).** D1 fixes the **body**: every momentum fill,
including sub-threshold-drift ones, gets a correctly-anchored TP. D2 only rejects the **tail** (gross
drift / wrong-side). A 1.5% drift fill passes D2 but still needs D1 to anchor its TP correctly.

**Relationship to M37 `tpEligible`.** After D1, the "fill at/past TP" condition `tpEligible` guards
should essentially never fire for momentum. `tpEligible` is **retained as defense-in-depth**, not
removed. QA must confirm D1 + `tpEligible` don't conflict at the rounding boundary (rebased TP that
rounds to exactly entry, or `atr14 = 0`).

**Verification:** after the fix, **zero** closed positions may have `take_profit_price ≤ entry_price`
for a LONG or `take_profit_price ≥ entry_price` for a SHORT (the exact query that returns 19 today).

### D2 — Fill-acceptance drift + wrong-side-of-own-SL guard (structural-safety guard, NOT the economic fix)

**Reframed after quant review.** D2 is **not** the primary economic fix — on this window the drift
gate removes only −$4.29 of fee-noise instant exits and the wrong-side-SL reject only −$1.81; 95% of
the loss flows straight through it (that loss is flow-selection, i.e. D3). D2's real job is
**structural safety**: refuse to arm a position whose fill is on the **wrong side of its own stop**
(the operative reject), plus an optional far-tail magnitude rail against pathological fills. The
calibration in Appendix B shows drift is **collinear with the wrong-side-geometry bug** (no
genuinely-held trade above ~2.2 ATR), so this window cannot calibrate a magnitude cap at all — D2 is a
guardrail, **never** a profit lever, and the cap ships off/un-calibrated.

**Where:** the execution open path, evaluated **only on a confirmed full fill**, positioned so it does
not reopen the ADR 0008 §2 synchronous-arm window (`ExecutionService.ts:908-930`). `bot-architect`
rules on the exact seam before code.

**Seam correction (logic review — was a blocker).** D2 is **not** a strategy `action=skip /
SkipReasonEnum` decision — those are written pre-trade at the strategy seam
(`StrategyService.persistDecision`). By fill-acceptance the risk gate has already approved, an order
was submitted, **and a fill exists on the exchange**. D2 must be an **execution-layer reject** (a new
counted `ORDER_INTENT_*` reject reason/metric, analogous to the `handleNoFill` / expired paths), and
the plan must specify how it reconciles with the **OPEN `decisions` row already persisted** for that
`event_id`. Do not add `SIGNAL_STALE` to `SkipReasonEnum`.

**Phantom-position correction (logic review — was a blocker).** "Reject the open, do not persist a
position" is unsafe as written: the order has **already filled**, so dropping it leaves the engine
**flat in the DB but in-position on the exchange**. D2 must specify the **post-fill unwind**, and the
round-2 logic review confirmed this is **real new code, not a reuse** — the execution layer has **no
self-issued close**. Every existing close (SL/TP breach, time-stop, reconciler flatten) is synthesized
the same way: build a CLOSE/FLATTEN `IOrderIntent` → `riskGate.evaluate` (auto-approved de-risk) →
emit `ORDER_INTENT_APPROVED_EVENT` → reduce-family path (`applyReduceFillToPosition`,
`ExecutionService.ts:275`). That pattern is already duplicated twice
(`LocalProtectiveMonitor.executeBreachClose:340-400`,
`ReconciliationService.flattenAdoptedForeignPosition:962-1028`), each with its own close-slot
coordination + gate-reject/slot-leak handling.

**Decision (was "or hand to reconciler" — now pinned):** D2's unwind **emits a synthetic
`OrderIntentActionEnum.FLATTEN` intent through the existing `buildCloseIntent → gate → emit` pattern,
factored into a shared helper** (it now appears 3×, so the extraction is mandatory, not optional). The
just-opened **`positions` row** (INSERTed PENDING_OPEN at `ExecutionService.ts:905/1116` *before* the
arm) is force-closed through the existing reduce-family finalize — which already handles a PENDING_OPEN
row via the promote-before-close guard (`:379`) and stamps `exit_reason` exactly once via
`finalizeRealizedPnl` (`:447`) — yielding **one clean CLOSED row** with
`ExitReasonEnum.FORCE_CLOSE`. The helper must acquire the shared `closeCoordinator` slot and handle the
gate-reject/throw slot-leak path exactly as the other two copies do.

**Row-clarification (logic review).** It is the **`positions` row** that is unwound, **not** the
`decisions` row. The pre-trade `decisions` row (`StrategyService.persistDecision`, `action='open'`) is
never mutated by execution and is **correct to leave as-is** — the bot *did* decide to open. So D2
produces: `decisions` row unchanged + one CLOSED `positions` row (`FORCE_CLOSE`) + a counted
execution-layer drift-reject metric. This preserves M37 trade-record integrity (no contradictory or
duplicate row).

**Placement (logic review).** D2 must evaluate **before** the synchronous arm at
`ExecutionService.ts:922` so the monitor never arms a doomed position (the row already exists from
`:905`); on reject it skips the arm and routes straight to the FLATTEN unwind. This keeps the ADR 0008
§2 synchronous-arm window closed for *surviving* positions.

Partial fills / `RECONCILE_REQUIRED` follow the **existing** reconcile path (`ExecutionService.ts:565,
703, 853`) and are explicitly out of D2's single-fill drift evaluation.

**Behaviour (on confirmed full fill):** reject + unwind when **either**:
1. *(operative — hard structural check, always on)* the fill is on the **wrong side of the position's
   own structural SL** — LONG with `avgFillPrice ≤ clampedExit.stopLossPrice`, SHORT with
   `avgFillPrice ≥ clampedExit.stopLossPrice`. **Keyed on `clampedExit.stopLossPrice`, not literally
   `vwapSession`** (logic review) — this generalises correctly to mean-reversion (SL is a structural
   wick stop, not VWAP) instead of wrongly rejecting valid reversion fills on the VWAP side. Not a
   tunable. **or**
2. *(far-tail guard — off by default / un-calibrated, see §Param)*
   `driftPct = |avgFillPrice − referencePrice| / referencePrice > MAX_SIGNAL_DRIFT_PCT`, with
   `referencePrice` built from `entrySnapshot` as `vwap_session × (1 + vwap_deviation_pct/100)` (exact
   decimal op-order per D1). Disabled unless an explicit fat-finger cap (~8%) is configured.

**Param:** `MAX_SIGNAL_DRIFT_PCT` — new risk param at the highest config level. **This window CANNOT
calibrate a magnitude cap** (Appendix B); the operative reject is the structural wrong-side-of-own-SL
check, and any magnitude cap is an **un-calibrated fat-finger guard**, not a data-derived rail. Two
facts and one non-result decided this:

1. **Spread is negligible** — `spread_at_entry_pct` p95 = **0.052%**, max **0.073%**. True microstructure
   slippage is ~1–5 bps, so a "slippage-tolerance" cap (a few × spread ≈ 0.1–0.3%) would reject the
   *median* fill (drift p50 = 1.49%) — absurd. Drift here is **volatility movement, not slippage**.
2. **Drift is collinear with the wrong-side-geometry bug** — the held vs instant split is near-disjoint
   in drift, so the two axes are confounded:

   | subset | n | drift range (ATR) | net_pnl |
   |--------|---|-------------------|---------|
   | genuinely held (> 5 s) | 23 | **0.07 – 2.16** | −$80.47 |
   | instant wrong-side exits (≤ 5 s) | 22 | **2.07 – 6.51** | −$8.31 |

   **There is not a single genuinely-held trade above ~2.2 ATR drift in this window.** An earlier draft
   cited a "drift is *inversely* related to loss" bucket table as proof a cap is harmless — that was a
   **contamination artifact**: the high-drift buckets are 100% the instant wrong-side exits (≈zero PnL
   by construction), not held trades. Corrected: **the sample carries zero information about what a
   genuinely-held high-drift fill does.** You cannot calibrate a magnitude cap on it.

**Decision:** the operative D2 reject is the **structural wrong-side-of-own-SL check** (sub-condition 1
below — hard, unambiguous, fired on 4/45 and is *not* a tunable). For the magnitude cap, **ship
sub-condition 2 disabled by default (cap = off / null) until a clean post-D1 window exists**, OR — if a
far-tail safety rail is wanted by the conservative-survival philosophy — ship it as an **explicitly
arbitrary fat-finger guard** set well beyond the observed max (6.23%), e.g. **8.0%**, **expressed in a
single unit (% of reference price)** and **labelled un-calibrated**. Do **not** present any value as a
percentile/ATR-derived rail (the prior "5.0% ≈ p99 ≈ 6 ATR" claim was false on all three legs: 5.0% is
~p98 of drift-%, not p99; and "% ↔ ATR" only coincide at the median ATR/price, so they are not
interchangeable). Recalibrate only after a clean window; never tighten toward the distribution body.

**Distinction from the existing slippage cap (logic review — characterization corrected).** A
`slippageCapPct` already exists, but it is a **pre-submit limit-price bound**, **not** a post-fill
acceptance gate: `OrderPolicyRouter.computeLimitPrice` sets the IOC limit at `midAtTrigger × (1 ±
slippageCapPct)`, so the order simply *cannot fill beyond it* (it no-fills / partial-fills); at
`ExecutionService.ts:1138` the value is only persisted as `slippageModelPct`. D2 is therefore a
**genuinely new, distinct mechanism** — a *signal-relative, post-fill* check (fill vs. signal
reference), measured against a different baseline (the limit cap is relative to mid-at-trigger, not the
signal price). D2 **composes with** the existing cap; it does not replace or duplicate it.

**Verification:** `SIGNAL_STALE`-equivalent rejects absorb the high-drift opens; **zero** positions
arm with an SL on the wrong side of entry; no phantom position results from a reject (DB and exchange
agree post-unwind).

### D3 — Promote V3 hybrid from shadow to active (GATED — no new code)

**Hard prerequisite:** M37 complete and a **non-hollow** shadow ledger producing same-`event_id`
realized counterfactual PnL for V2 vs V3, **plus** D1+D2 deployed and one clean soak window so the
comparison is between *correct-geometry* trades, not bug-contaminated ones. Promoting V3 on top of the
broken geometry would just move the same geometry bug to a lower-frequency version.

**Promotion path:** ADR 0019 promotion gate (re-read its criteria before this deliverable is scoped).
V3 (`strategy_versions.id = 4`) `shadow → active`; V2 (`id = 3`) `active → shadow`. V3 already routes
`forced_exhaustion → fade`, `trend_initiation → follow`, and `catalyst_risk / market_beta /
low_quality_noise → SKIP`. **No new strategy code** — this is a status flip via migration + the
promotion gate.

**V3 is not a guaranteed win here (quant review).** V3 *skips* `catalyst_risk` (−$66.92 this window —
the bulk of the avoidable loss) but it *follows* `trend_initiation`, which was **−$21.46 over 8 trades**
in this same window. So V3 would have avoided the catalyst_risk leg but **not** the trend_initiation
leg, and at n=8 the trend_initiation result is below the noise floor. This is *exactly why* D3 is gated
on M37 realized shadow PnL + a clean D1/D2 window — the V3 `trend_initiation` leg is unproven, and
promoting on routing logic alone would be calibrating on an n=8, geometry-contaminated cell.

**Open question carried into the brief:** are the `trend_initiation` losses a momentum problem or a
signal-quality-at-entry problem? With D1 live (correct TP anchor) this becomes answerable, because the
entry geometry is no longer the confound. Until then it stays an open question, not a scoped change.

---

## Out of scope (explicit non-goals)

- **Any V4** that *fades* `catalyst_risk` instead of skipping it — requires M37 shadow data + a
  separate milestone. V3 promotion (skip) is the conservative first step.
- **Tuning `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER` (2.0) or `time_stop_minutes` (15)** — the sample is
  geometry-contaminated and per-flow n is below the noise floor. Re-evaluate after a clean window.
- **Rebasing the SL to the fill price** — explicitly rejected; it would destroy the one-R structural
  budget. Wrong-side SL is handled by D2 rejection + post-fill unwind, not by moving the stop.
- **Signal-score / deviation-threshold filters on `catalyst_risk`** — micro-optimisation on a
  contaminated instrument; defer until post-clean-window data exists.
- **Touching the mean-reversion exit path** — D1 is **momentum-only** (reversion TP is VWAP-anchored;
  the momentum formula would corrupt it). The reversion path is untouched.
- **Switching the detector to a finer candle timeframe (1m / 15s / 1s) — considered and rejected.**
  Intuition: finer bars detect the spike sooner → enter earlier → less "chasing." Rejected because
  (1) it does not address the diagnosed loss — the −$80 is *low-drift* fills (landed near signal) that
  went the wrong **direction** (fade-vs-follow = D3); earlier detection changes entry price/timing, not
  side; (2) the binding constraint is **OI cadence (~148s median / ~302s p90, measured)** — the flow
  classifier (`catalyst_risk`/`trend_initiation`/`forced_exhaustion`) that fixes direction reads OI /
  `oi_change_5m` / funding, so a sub-minute detector would classify flow on OI up to ~2.5 min **stale**
  (detect fast, decide direction blind); (3) SNR collapses (a 5m VWAP-deviation spike is a real event;
  a 5s one is microstructure noise) and triggers multiply ~60× into a single position slot;
  (4) it resets all 5m-tuned calibration (ATR, `signal_score`, 0.5 idiosyncrasy) and the M37 shared-
  `event_id` v0/v1/v2/v3 comparison just repaired. Data note: the finest cadence that exists is
  **5-second `tick_aggregates`** (not 1s, and they carry only volume/price — no flow context); 1m
  candles exist. **Future bounded experiment (NOT M38):** a 1m detector as a new *shadow* version after
  D1+D3, judged on the repaired M37 lane, to test the momentum-follow leg only. 15s/1s are non-viable
  (no 1s data; 5s ticks lack flow context; OI too stale).
- **ADD / reduce path geometry** — D1 rebases only on the OPEN intent (arm is OPEN-only,
  `ExecutionService.ts:922`); ADD deliberately does not re-anchor SL/TP (ADR 0007 §3, weighted-avg
  entry). D2's drift check likewise evaluates the OPEN fill only. ADD/reduce are out of scope by
  design — stated explicitly so the asymmetry is not read as an omission.

---

## Trading-safety invariants reaffirmed (M38-specific)

- **No order path bypasses the risk gate.** D2 is an additional *reject* path at fill acceptance; it
  never opens or sizes anything.
- **Strategies stay pure/deterministic.** D1 rebase and D2 gate live in the **execution layer** and
  consume only the realised fill + already-captured `entrySnapshot`/`clampedExit`; `momentumCore.ts`
  is untouched in behaviour, preserving the live-vs-backtest contract (ADR 0015 +
  `live-vs-backtest-contract.md`).
- **Parity is via a NEW pure helper, not an existing shared layer (logic review — was a stated
  fact-error).** There is **no** shared fill/arm abstraction: live arms geometry in
  `ExecutionService.openOrAddPositionAndAttachProtection` from `fillSummary.avgFillPrice`; the backtest
  sets geometry in `BacktestOrchestrator.buildPosition:367-388` from `fill.priceUsdt` with
  `stopLossUsdt`/`takeProfitUsdt` taken **frozen** from `decision.clampedExit:380-381` — i.e. the
  backtest carries the **identical geometry bug** and its own separate seam. M38 must therefore
  **extract pure helpers `rebaseMomentumTakeProfit(...)` + `evaluateFillDrift(...)`** and call them at
  **both** seams (live arm seam + `BacktestOrchestrator.buildPosition`). Parity acceptance (#5) tests
  these helpers produce identical output on identical inputs.
- **Money is `decimal`** (`Money`/decimal.js) throughout the rebase and drift math — no float.
- **Risk budget preserved**, not loosened: SL distance is still VWAP (one R); D2 only ever *reduces*
  the opened set.

---

## Change set (representative — engine confirms exact files)

| Area | File(s) | Change |
|------|---------|--------|
| Rebase-eligibility contract | **engine-local** `IProposedExit` (`apps/engine/src/strategy/interface/`) + `clampedExit` on engine-local `IOrderIntentApprovedEvent` | explicit `tpAnchor`/`tpRebaseEligible` + carried `atrDistance: MoneyValue` (momentum vs reversion is NOT discernible via `stopType`) — **NOT** `packages/shared` |
| Pure helpers (parity) | new util consumed by live + backtest | `rebaseMomentumTakeProfit(...)`, `evaluateFillDrift(...)` — no existing shared fill layer to reuse |
| TP rebase | `apps/engine/src/execution/service/ExecutionService.ts` (before arm `:922`) | recompute TP from `avgFillPrice` ± carried `atrDistance`; persist rebased value; momentum-only |
| TP rebase (backtest) | `apps/engine/src/backtest/service/BacktestOrchestrator.ts:367-388` | call same helper at `buildPosition` (today takes frozen `decision.clampedExit` — same bug) |
| Drift/side gate + unwind | execution open path (pre-arm, post-confirmed-full-fill) | execution-layer reject (new `ORDER_INTENT_*` reason/metric — **not** `SkipReasonEnum`) on drift > param OR fill on wrong side of `clampedExit.stopLossPrice`; unwind = synthetic `FLATTEN` → gate → reduce-family finalize → CLOSED row `FORCE_CLOSE`; never silent drop |
| Close-intent helper | factor from `LocalProtectiveMonitor.executeBreachClose` + `ReconciliationService.flattenAdoptedForeignPosition` | shared `buildCloseIntent → gate → emit` (now 3× — extract) |
| Shared enum/param | `packages/shared` | new drift-reject reason enum + `MAX_SIGNAL_DRIFT_PCT`; `FLATTEN`/`FORCE_CLOSE` already exist (reuse) |
| V3 promotion (gated) | migration + ADR 0019 gate | `strategy_versions` status flip; no logic |

**Contract routing (corrected after logic review):** `tpAnchor`/`atrDistance` live on the
**engine-local** `IProposedExit`/`IOrderIntentApprovedEvent` — `bot-architect` owns these, **not**
`bot-shared-maintainer`. Only the **new drift-reject reason enum** and `MAX_SIGNAL_DRIFT_PCT` (if a
shared contract) route through `bot-shared-maintainer`. Do **not** add `SIGNAL_STALE` to
`SkipReasonEnum`. `OrderIntentActionEnum.FLATTEN` and `ExitReasonEnum.FORCE_CLOSE` already exist —
reuse, do not add.

---

## Dispatch waves (per `CLAUDE.md` / dev-qa-cycle — ≤5 items/files per dispatch)

1. **Serial — `bot-architect`:** confirm (a) D1 momentum-only vs all-exit-path scope, (b) D2 gate
   placement and whether `SIGNAL_STALE` is a shared-contract reason, (c) backtest-parity contract for
   the rebase. ADR note if the fill-time rebase changes the live/backtest exit contract.
2. **Serial — `bot-shared-maintainer`** (only if `SIGNAL_STALE` / `MAX_SIGNAL_DRIFT_PCT` are shared):
   add enum/param to `packages/shared`.
3. **Parallel — `bot-engine-nestjs`:** D1 rebase + D2 gate + backtest parity (≤5 files/dispatch).
4. **Serial — `bot-qa-engineer`:** paired tests per fix item — wrong-side TP rebase (long & short),
   wrong-side-of-own-SL reject + post-fill unwind (no phantom), drift-over-threshold reject,
   drift-under-threshold pass (D1 still anchors its TP), reversion fill NOT rebased/rejected,
   backtest/live parity on a rebased exit. Boundary cases: fill exactly at SL, fill exactly at the
   drift threshold, `atr14 = 0` / rebased TP rounding to exactly entry (D1 + `tpEligible` backstop),
   partial fill routes to existing reconcile (not D2).
5. **Parallel — `bot-review-quant` + `bot-review-logic` + `bot-review-clean-code` + `bot-review-security`.**
6. **Serial — `bot-scribe`:** milestone-log outcome, work-log, STATUS.

(D3 promotion is a **separate, gated** sub-cycle after M37 data + one clean window — not bundled with
D1/D2 code.)

## Success criteria / acceptance tests (rollup)

1. **No wrong-side TP:** the geometry-audit query (run against **opened-in-window** rows, not
   `closed_at` — a fast wrong-side open may not have closed yet) returns 0 (was 19/45).
2. **No wrong-side SL opens:** 0 positions arm with SL on the wrong side of entry (was 4/45).
3. **No phantom positions:** every D2 reject leaves DB and exchange in agreement (post-unwind); a
   reconcile/close fires for the just-filled order.
4. **Drift rejects counted:** the execution-layer drift-reject metric > 0 in a window with drift
   events; the rejected set matches the high-drift opens. *(Not framed as a PnL win — D2 is a guard.)*
5. **Backtest parity:** the pure `rebaseMomentumTakeProfit`/`evaluateFillDrift` helpers produce
   identical output on identical inputs at the live arm seam and `BacktestOrchestrator.buildPosition`
   (ADR 0015 + live-vs-backtest contract). **Note:** backtest today arms *frozen* geometry with **no**
   `tpEligible`/instant-fire guard, so D1 in backtest is a deliberate **behaviour change** — historical
   backtest metrics will move; that is expected, not a regression. Re-baseline after D1 lands.
6. **D3 (gated):** V3 active / V2 shadow only after M37 realized shadow PnL + one clean D1/D2 window.

## Risk / rollback

- **Over-rejection:** too tight a `MAX_SIGNAL_DRIFT_PCT` skips good fast-fill trades (drift p50 is
  already 1.49%, so a 2% cap would bite ~the top quartile of normal fills — do **not** ship 2%).
  Mitigation: the operative reject is the structural wrong-side-of-own-SL check; the magnitude cap
  ships **off by default (or as a wide ~8% fat-finger guard)** with the drift value logged on every
  evaluation (recorded even when it passes), and is recalibrated only from a clean post-D1 window.
- **Backtest divergence:** if the rebase is applied live but not in backtest, parity breaks.
  Mitigation: D1/D2 land in both paths in the same milestone; parity test is an acceptance gate.
- **Rollback:** D1/D2 are additive (a transform + a reject path) and revert cleanly; D3 is a status
  flip reversible by the inverse migration.
- **Kill-switch:** `handleApproved` short-circuits on `haltFlag.isHalted()` before any submit
  (`ExecutionService.ts:150`), so D2's reject path cannot fire under halt — D2 adds no new halt
  interaction; its reject is a normal idempotent terminal (reservation release / `clientOrderId`).

## DB safety (HARD — `CLAUDE.md` invariants #8/#9)

- All analysis here was **read-only** (`SELECT` only). No schema or data was modified.
- D3's migration and any param/enum migration require a `pg_dump` into `backups/` **first**, then
  user confirmation, then prune to the 2 most recent — per invariants #8/#9. No `-v`, no volume ops.

## References

- WIP source brief: `docs/wip/m38-momentum-exit-geometry-and-strategy-routing.md`
- Predecessor: `docs/plans/M37-strategy-comparison-infrastructure.md` (instruments)
- ADR 0019 (promotion gate); ADR 0015 + `docs/.../live-vs-backtest-contract.md` (parity); ADR 0007
  (ADD/reduce re-anchor rules); ADR 0008 (synchronous-arm window)

### Key source files
- `apps/engine/src/strategy/strategies/momentumCore.ts:41-48` — signal-time TP/SL construction
- `apps/engine/src/execution/service/ExecutionService.ts:1102,1136-1137` — fill price available; frozen geometry armed
- `apps/engine/src/execution/service/LocalProtectiveMonitor.ts` — arm target

---

## Appendix — independent 48h verification queries (read-only, soak DB)

> **Two data caveats for anyone re-running these (raised in review):**
> 1. These analysis queries reconstruct drift from `vwap_at_entry × (1 + vwap_deviation_at_entry/100)`.
>    `vwap_deviation_at_entry` is stored `numeric(18,8)` — **truncated** vs. the live float
>    (~15-17 sig digits) the gate actually used. The reconstruction differs microscopically from the
>    in-memory value; it does **not** affect the live/backtest decision path (both use the float).
> 2. There is **no stored "signal reference price" column** — drift is *reconstructed*, not *measured*.
>    The live D2 gate computes it in-memory from `entrySnapshot`; the DB can only approximate it.
> 3. Acceptance queries #1/#2 should filter on `opened_at` (opened-in-window), not `closed_at`, so a
>    fast wrong-side open that has not closed yet is still counted.

```sql
-- A. Exit-reason breakdown
SELECT exit_reason, count(*) n, round(sum(realized_pnl),2) net_pnl,
       round(avg(EXTRACT(EPOCH FROM (closed_at-opened_at))),1) avg_hold_s,
       count(*) FILTER (WHERE mfe_pct = 0) zero_mfe
FROM positions WHERE closed_at >= now() - interval '48 hours'
GROUP BY exit_reason ORDER BY net_pnl;

-- B. Wrong-side geometry vs actual entry (returns 23; TP-wrong=19, SL-wrong=4)
SELECT side, count(*) n,
  count(*) FILTER (WHERE side='long'  AND take_profit_price <= entry_price) tp_unreachable_long,
  count(*) FILTER (WHERE side='short' AND take_profit_price >= entry_price) tp_unreachable_short,
  count(*) FILTER (WHERE side='long'  AND stop_loss_price   >= entry_price) sl_wrongside_long,
  count(*) FILTER (WHERE side='short' AND stop_loss_price   <= entry_price) sl_wrongside_short
FROM positions WHERE closed_at >= now() - interval '48 hours' GROUP BY side;

-- C. SL is the frozen VWAP in 100% of rows (45/45)
SELECT count(*) FILTER (WHERE stop_loss_price = vwap_at_entry) sl_equals_vwap, count(*) total
FROM positions WHERE closed_at >= now() - interval '48 hours';

-- D. Fill on wrong side of VWAP → instant wrong-side SL (1 long + 3 short)
SELECT count(*) FILTER (WHERE side='long'  AND entry_price < vwap_at_entry) long_below_vwap,
       count(*) FILTER (WHERE side='short' AND entry_price > vwap_at_entry) short_above_vwap
FROM positions WHERE closed_at >= now() - interval '48 hours';
```

## Appendix B — `MAX_SIGNAL_DRIFT_PCT` calibration (book/fill distributions, read-only)

Pulled to calibrate the threshold (see D2 §Param). **Conclusion: this window cannot calibrate a
magnitude cap.** Drift is volatility movement (not spread), and it is **collinear with the
wrong-side-geometry bug** — the high-drift region is entirely instant wrong-side exits, with no
genuinely-held trade above ~2.2 ATR. So drift carries no information about held-trade outcomes here;
the operative reject is the structural wrong-side-of-own-SL check, and any magnitude cap is an
un-calibrated fat-finger guard pending a clean post-D1 window.

```sql
-- B1. Microstructure (spread) vs volatility (ATR) vs signal-to-fill drift, as % of price
WITH p AS (
  SELECT spread_at_entry_pct AS spread_pct,
    (atr_at_entry/NULLIF(entry_price,0))*100 AS atr_pct,
    abs(entry_price-(vwap_at_entry*(1+vwap_deviation_at_entry/100)))
      / NULLIF(vwap_at_entry*(1+vwap_deviation_at_entry/100),0)*100 AS drift_pct
  FROM positions WHERE closed_at >= now() - interval '48 hours')
SELECT percentile_cont(0.5)  WITHIN GROUP (ORDER BY spread_pct) spread_p50,  -- 0.011%
       percentile_cont(0.95) WITHIN GROUP (ORDER BY spread_pct) spread_p95,  -- 0.052%
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY atr_pct)    atr_p50,     -- 0.55%
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY drift_pct)  drift_p50,   -- 1.49%
       percentile_cont(0.95) WITHIN GROUP (ORDER BY drift_pct)  drift_p95;   -- 4.25%

-- B2. Held vs instant split is near-DISJOINT in drift (the collinearity that kills calibration):
--   held >5s:    n=23, drift 0.07–2.16 ATR, net −$80.47
--   instant <=5s: n=22, drift 2.07–6.51 ATR, net −$8.31
--   => no genuinely-held trade exists above ~2.2 ATR; high-drift buckets are 100% instant exits.
-- B3. drift-% percentiles: p98=5.13%, p99=5.68%, max=6.23%  (so "5%≈p99" was false; 5% is ~p98)
```

**Outcome:** the structural wrong-side-of-own-SL check is the operative reject. The magnitude cap
**cannot be calibrated from this window** — ship it **off by default, or as a wide ~8% fat-finger guard
explicitly labelled un-calibrated** (in % units only). Recalibrate only after a clean post-D1 window;
never tighten toward the distribution body.
