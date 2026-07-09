# M54 — xmom entry geometry: arm against the EXPECTED fill price (correctness / fee-bleed, NOT edge)

> **What M54 is.** A surgical correctness fix to *where* xmom arms its stop-loss and take-profit at
> signal time. Today the geometry is anchored to the **signal 5m close** (`entryPrice = latestBar.close`,
> `MomentumOrchestratorService.ts:597`), but the ADR 0045 fill-acceptance guard measures realized R:R
> against the **actual fill**. On thin books a long systematically fills *above* signal (adverse), so the
> guard sees a realized R:R biased below the arm ratio and `force_close`s the fill at 0-duration. M54
> arms the SL/TP against an **expected fill price** — `signal + modeled adverse slippage` computed from
> the already-captured `bid_ask_spread_pct` (half-spread) and `book_depth_10bps_usdt` — so the geometry
> is honest relative to where the order will actually fill, and predictably-degenerate thin-book
> candidates are **skipped before any order is sent** rather than opened-and-instantly-rejected.
>
> **This is NOT an edge fix.** EXP-021 (fragile peak, 1/10 folds) and EXP-022 (all 22 exit-geometry
> variants net-negative; the binding constraint is the *signal*, not exit mechanics) already proved xmom
> has no cost-surviving edge and that widening geometry does not create one. M54's success is measured as
> **force_close-rate reduction** and **fee/slot-churn reduction** — never PnL improvement, and it must
> not be sold internally as a profitability fix. It stops fee bleed and makes the R:R-at-open math
> honest so future measurement is trustworthy.
>
> **Source analysis:** `docs/analysis/20260708-xmom-geometry-and-live-forensics-exp022.md` (EXP-022 §3
> "Force_close root cause proven", §7 "Still-valid SEPARATE action") and
> `docs/analysis/20260704-m52-force-close-retry-soak-analysis.md` (EXP-018 §2, seed #3 "pre-fill RR gate
> with a slippage budget"). Read both before implementing.

---

## 1. Problem statement (confirmed by two independent live analyses)

xmom (`strategy_versions.id=20`, ADR 0048/0050) opens every long with geometry armed off the **signal
price** `P0 = latestBar.close` (`MomentumOrchestratorService.ts:597`):

```
stopDistance   = atr24h × xmom_atr_stop_multiplier         (:616)   [call this D]
stopLossPrice  = P0 − D                                    (:617)
takeProfitPrice = P0 + xmom_tp_arm_rr × D                  (:623)   [arm ratio a, default 1.5]
```

The ADR 0045 fill-acceptance guard (`exitGeometryHelper.ts:120-155`, `evaluateFillGeometry`) then
measures realized R:R against the **actual fill** `F` and rejects (`degenerate_geometry_at_fill` →
0-duration `force_close`) when `tpDist/slDist < min_rr` (`xmom_min_rr`, default 1.5).

For a long that fills at `F = P0 + s·D` (slippage `s` as a fraction of `D`; `s>0` = adverse):

- `slDist = F − SL = D(1 + s)` — grows
- `tpDist = TP − F = D(a − s)` — shrinks (TP frozen at signal, `tpRebaseEligible=false`, `:672`)
- realized `R:R = (a − s)/(1 + s)`

Because the arm anchors to `P0` while the guard anchors to `F`, **and thin-book slippage is
systematically adverse (`s > 0`)**, realized R:R is systematically *below* the arm ratio `a`. Armed at
`a = min_rr = 1.5`, any adverse slippage tips it under the floor. Live proof (EXP-022 §3, scheduled
longs): force_close set averaged R:R-at-fill **1.03** (all ≤ 1.5), traded set **1.96** — a razor-sharp
split at the guard floor. Scheduled force_close rate **67% (14/21)**.

**The defect is an OPEN-time anchor mismatch, not a guard bug.** The guard is protective and correct
(EXP-022 §4: the force-closed positions would have lost *more* if held — −66 at armed TP/SL, −441
no-stop). M54 does **not** touch the guard. It fixes the anchor the geometry is computed against, and
adds a pre-send skip so the doomed thin-book orders are never sent.

### 1.1 Confirmed code locations (the mismatch, with line references)

| Seam | File:line | Anchors to | M54 change |
|------|-----------|-----------|-----------|
| Arm — SL | `MomentumOrchestratorService.ts:617` | signal `P0` | anchor to `F_exp` |
| Arm — TP | `MomentumOrchestratorService.ts:623` | signal `P0` | anchor to `F_exp` |
| Sizer input | `MomentumOrchestratorService.ts:625-639` (`entryPrice`, `stopLossPrice`) | signal `P0` | feed `F_exp` so risk distance stays `D` (`PositionSizer.ts:52` computes `|entryPrice−stopLossPrice|`) |
| Fill guard | `exitGeometryHelper.ts:148-152` (`isRrInsufficient`) | actual fill `F` | **unchanged** (byte-for-byte) |
| Liquidity source | `state.getSpreadPct()`, `state.getBookDepth10bpsUsdt()` (already read in `buildMomentumSnapshot`, `:902/:918`) | — | **used for gate eligibility today, NOT for arming** — M54 consumes them at the arm site too |

The `state` (`SymbolMarketState`) carrying spread/depth is **already in scope** at the arm site
(`buildMomentumOpenIntent`, `:590`). No new data source, no new I/O — the fields are read from the same
deterministic market state the gate snapshot already uses. Accessor return types are
`getSpreadPct(): number | null` (`SymbolMarketState.ts:374`) and
`getBookDepth10bpsUsdt(): MoneyValue | null` (`:378`) — **`null` means "no reading captured yet", which
is distinct from a live near-zero value** (load-bearing for the fail-closed handling in §3).

> **Correction to the earlier "captured but unused" framing:** depth is already consumed for
> *eligibility* by the risk gate (`isBookTooThin`, §1.2). It is only unused for *arming geometry*. §1.2
> reconciles the new strategy-layer skip with the existing gate guard so the two are not conflated.

### 1.2 Reconciliation with the existing gate depth guard (`isBookTooThin`, ADR 0004 §6a / M22)

The risk gate **already** rejects opens that over-consume book depth:
`RiskGateService.isBookTooThin` (`RiskGateService.ts:892-926`, ADR 0004 §6a, introduced M19/M22)
rejects (`coin_book_too_thin`, a per-coin SKIP) when `book_depth_10bps_usdt` is at or below the
tier-sized floor `COIN_DEPTH_FLOOR_10BPS_USDT` (`riskConsts.ts:96`). M54's part-(b) skip must be
**explicitly reconciled** with it, not silently duplicative:

- **Ordering — two layers, distinct roles.** M54's skip runs **strategy-layer, pre-gate** (inside
  `buildMomentumOpenIntent`, returns `null` before any intent is emitted). `isBookTooThin` still runs
  **in-gate, unchanged**, as the last-line eligibility floor. M54 does **not** touch, weaken, or replace
  it.
- **Why a second layer rather than just tightening the tier floor.** The two guards are *different
  shapes*: `isBookTooThin` is a **static per-tier depth floor independent of order size**; M54's skip is
  an **order-size-aware slippage budget** (`orderNotional / book_depth_10bps_usdt`) — the same coin
  passes the static floor at small size but fails the budget at large size, and vice-versa. Crucially,
  **M51's paper-relax deliberately LOOSENS `isBookTooThin`'s floor for exactly the thin soak coins this
  milestone targets** (`Math.min(PAPER_RELAX_COIN_DEPTH_FLOOR_10BPS_USDT, liveFloor)`,
  `RiskGateService.ts:905`, ADR 0042 §9 — RIF/MAGMA/XPL/TLM). So in the paper soak the in-gate floor is
  *intentionally permissive* and admits precisely the names whose fills then 0-duration-`force_close`.
  The gate cannot prevent that churn without un-doing the M51 relax (which exists so the soak can gather
  data at all). M54's pre-gate slippage budget is the layer that stops the open→force_close→retry churn
  *without* re-tightening the eligibility floor the soak depends on.
- **Consistency of convention.** M54's skip adopts `isBookTooThin`'s **fail-closed** discipline
  (§3 part b) so the two never disagree in direction on bad data.

---

## 2. Why this is honest and edge-neutral (the mechanism)

Anchor SL/TP to `F_exp = P0 + s_exp·D` (expected adverse slippage `s_exp`). At the actual fill
`F = P0 + s·D`, define residual `r = s − s_exp` (actual minus expected):

- `slDist = F − SL = D(1 + r)`
- `tpDist = TP − F = D(a − r)`
- realized `R:R = (a − r)/(1 + r)`

Realized R:R now depends on the **residual** `r`, not total slippage `s`, so the *R:R-at-expected-fill*
is centered at `a` instead of being systematically dragged below it. Residual noise still trips the
floor occasionally — that is what the pre-send skip (§3, decision **b**) and the unchanged guard handle.

**Two honest caveats (do not overstate this as "edge-neutral"):**

1. **Half-spread is a lower-bound estimator, not an unbiased one.** EXP-022's realized adverse slippage
   on scheduled longs implies roughly `~0.23·D` typical adverse move, whereas half-spread alone models
   only `~0.05·D` on these books. So `E[r] > 0` is *expected*, not zero — the anchor removes the part of
   the bias the half-spread captures and leaves a positive residual that **D3 must calibrate** (§7). A
   depth-scaled impact term (deferred, §11) would tighten it. **Most of the force_close-rate improvement
   is expected to come from the SKIP (b), not the anchor (a)** — the anchor's job is honest measurement,
   the skip's job is stopping the churn.
2. **The anchor shifts *absolute* SL/TP prices, not only the ratio.** Both legs move up by the
   half-spread for **every filled trade**, so a filled loser stops slightly earlier/smaller and a filled
   winner runs slightly further. Only the R:R *ratio at expected-fill* is neutral; the **absolute
   filled-book PnL is not guaranteed neutral**. This is small (half-spread ≈ 0.05·D) but real, and D3
   must *measure* it (filled-book SL-hit-rate + PnL delta as characterization), not assume it away
   (§7 D3, §10).

---

## 3. Decision: BOTH (a) expected-fill anchor AND (b) pre-send skip — skip is the protective lever

The lead posed three options: (a) widen armed SL/TP by the expected-slippage buffer, (b) skip pre-send
when expected R:R is below the guard, or (c) both. **Recommendation: (c) both** — they are
complementary and each is required; and the **skip is the primary fee-bleed and safety lever**, the
anchor is the correctness/honest-measurement lever.

### (a) Expected-fill anchor — half-spread offset (notional-independent, no circular dependency)

`F_exp = P0 × (1 + halfSpreadPct/100)` for a long, where `halfSpreadPct = bid_ask_spread_pct / 2`
(you cross the spread to fill a taker IOC — the half-spread is the guaranteed-adverse minimum). This is
**notional-independent**, so it avoids the sizer circular dependency (impact needs notional; notional
needs `entryPrice`). Then:

- `stopLossPrice = F_exp − D`, `takeProfitPrice = F_exp + a·D`
- Sizer receives `entryPrice = F_exp`, `stopLossPrice = F_exp − D` → `stopDistance = D` unchanged →
  notional ≈ unchanged (`PositionSizer.ts:52-54`; `F_exp ≈ P0`).
- **`referencePrice`, `midAtTrigger`, and the recorded signal anchor stay `P0`** (do NOT move them).
  The M48 `slFloor` anchors to `referencePrice` (`exitGeometryHelper.ts:182`) and the M52 retry breaker
  keys on `atrUnitsDrift = |fill − referencePrice|/atr` (ADR 0051 §3.1) — keeping `referencePrice = P0`
  leaves the `atrUnitsDrift` breaker **unchanged** (no `MOMENTUM_RETRY_MAX_ATR_DRIFT` recalibration) and
  leaves the `slFloor` **threshold-anchor** unchanged. (The fill-anchored `slDist` the threshold is
  compared against still shifts by the half-spread, so the guard *outcome* can flip — safely; see test
  #4. The anchor does not move; the compared distance does.)

**Why half-spread, not the backtest's flat %-of-notional slippage:** EXP-008 proved the backtest
`slippageCostUsdt` is a fixed ~0.30%-of-notional model that encodes *size*, not *price velocity* — do
NOT reuse it. The half-spread is the real, captured microstructure cost and is the defensible first
model. A depth-scaled linear impact term added to the anchor is a **possible refinement** if soak shows
half-spread under-models the observed bias (the residual `r` distribution from D3 is the calibration
input) — but ships **out of scope**; keep the anchor simple.

### (b) Pre-send skip — order-size-aware thin-book budget, FAIL-CLOSED

Skip the candidate (return `null` from `buildMomentumOpenIntent`, a logged skip identical to the
existing null-skips at `:594/:601/:607/:613/:643`) when the order would consume too much of the visible
book:

```
depthFraction = orderNotional / book_depth_10bps_usdt
skip if depthFraction > xmom_max_depth_fraction        (new param — see §6 for coupling + seeding)
```

This is EXP-018 seed #3 ("pre-fill RR gate with a slippage budget so predictably-degenerate thin-coin
candidates are filtered *before* the order"). It is the lever that actually stops fee bleed: instead of
open→0-duration-force_close→retry-churn, the doomed thin-book name is never sent. It is also
**protective** — EXP-022 §4 proved these thin names lose *more* if actually held, so skipping them (vs
rescuing them into real positions) is the safe direction.

**Fail-CLOSED on bad/empty book data (revised — matches `isBookTooThin`, `RiskGateService.ts:909-921`).**
The earlier draft's "fail-open on zero/missing depth" was **backwards** and is corrected here: a
genuinely empty book is the *worst* adverse-slippage case (EXP-018's thin-coin root cause), so admitting
it is exactly wrong. The skip resolves, distinguishing `null` (no reading) from a live near-zero value —
`getBookDepth10bpsUsdt()` returns `MoneyValue | null` (`SymbolMarketState.ts:378`):

| `book_depth_10bps_usdt` reading | M54 skip decision | Rationale |
|---|---|---|
| `null` / undefined (no reading captured) | **skip (fail-closed)** | The in-gate `isBookTooThin` already fails-closed on `null` (`:909`), so this coin never fills today regardless — M54 failing-closed here is **behavior-preserving**, just earlier and cheaper. It does **not** starve the soak beyond the existing gate. |
| finite, `≤ 0` or below a near-zero epsilon | **skip (fail-closed)** | Empty/near-empty book = worst-case slippage. `isBookTooThin` rejects `≤ 0` (`:921`); M54 matches. |
| finite, `> 0` | apply the `depthFraction` budget | The normal order-size-aware path. |

This makes the skip's bad-data direction **identical to the shipped gate convention** ("bad data costs a
single skip, never a fill") and closes the empty-book admission hole. Because `isBookTooThin` already
fails-closed on `null`/`≤0`, the skip never *removes* opens the soak would otherwise get — it only moves
the rejection earlier and adds the order-size-aware budget on top of the finite-depth names.

### (b→a) The anchor MUST NOT run without a live skip budget (coupling — see §6)

Part (a) alone is unsafe (it converts near-floor fee-only rejects into full-size positions that EXP-022
§4 proved lose more). Therefore **enabling the anchor requires a finite, conservatively-seeded
`xmom_max_depth_fraction`** — the schema enforces this (`.superRefine`, §6), so the D3 calibration
bootstrap can never run the anchor with the skip disabled.

### Why BOTH, and why the skip is primary (the load-bearing nuance)

Anchor-only (a) is **not safe alone**: for a name with modest residual it converts a 0-duration
fee-only reject into a *real, full-size position* — and EXP-022 §4 proved the force-closed cohort would
have lost −66 to −441 if held. Rescuing rejects into positions **increases losses**. The skip (b) is
what keeps M54 net-safe: the thin-book tail that dominates the force_close set is *skipped*, not opened;
the names that survive the depth budget have small expected slippage, so their anchor barely moves and
the guard still governs the residual. Net effect on the traded book is **≈neutral-to-fewer trades**,
with the fee-churn win coming from skips replacing open-then-reject — not from admitting more trades.

**Do NOT** implement (a) without (b). **Do NOT** frame (a) as "rescuing force_closes into trades" — that
is the EXP-022 §4 failure mode.

### Trading-safety invariants (all preserved)

- **No new nondeterminism:** `F_exp`, `depthFraction`, and the skip are deterministic functions of the
  market snapshot (`bid_ask_spread_pct`, `book_depth_10bps_usdt`, `atr24h`, sized notional) already read
  at the arm site. (`buildMomentumOpenIntent` is not literally pure — it already `await`s
  `candles.findRange` / `instrumentPort.findConstraints` — so the invariant is "same snapshot ⇒ same
  `F_exp` and same skip decision," no new clock/RNG/nondeterministic input.) xmom is currently unwired
  from the backtest harness (M53b §2), but the model MUST stay a deterministic function of the snapshot
  so live==backtest holds if/when it is wired.
- **No order path bypasses the risk gate:** the skip emits *no intent at all* (strictly safer); the
  armed geometry still flows through the unchanged risk gate and the unchanged ADR 0045 guard.
- **Money is `decimal`:** all offsets via `Money`.
- **No live capital:** xmom is PAPER-only and keeps its HIGH go-live blockers; M54 ships default-off.

### Cold-boot / missing-data behavior (M51 caveat) — anchor no-ops, skip fails-closed

Two independent fields, two independent rules:

- **Spread (anchor input).** `getSpreadPct()` returns `null` or `≤ 0` (no reading / cold boot) ⇒
  `halfSpread = 0 ⇒ F_exp = P0` — the anchor degrades to a **byte-identical no-op**. This is safe (not a
  fill-admission decision): a missing spread simply means no anchor correction, and the geometry still
  faces the unchanged gate + ADR 0045 guard downstream.
- **Depth (skip input).** `getBookDepth10bpsUsdt()` returns `null` or `≤ 0` ⇒ **skip fails-CLOSED**
  (per the §3(b) table). This does **not** "skip the whole universe on cold boot" beyond what happens
  today, because the in-gate `isBookTooThin` *already* fails-closed on the same `null`/`≤0` readings — so
  those coins were never going to fill anyway. M54 makes the rejection earlier and cheaper, it does not
  newly starve the soak.

Net: M54 is never *worse* than today on missing data (anchor no-ops; skip matches the existing
fail-closed gate), and it never admits an empty book.

---

## 4. Interaction with M53 `xmom_tp_arm_rr` — complementary, NOT redundant; NOT replaced

The lead asked whether M53 D1's headroom param (ADR 0047 §6, shipped, default 1.5 no-op) becomes
redundant, complementary, or replaced. **Answer: complementary; stays at its 1.5 no-op default; M54 does
not touch it.**

- **M53 `xmom_tp_arm_rr` changes the arm *ratio* `a`** — it widens the TP-to-entry *distance* for
  *every* trade. That buys slack against residual noise but at the EXP-002 cost (wider TP ⇒ lower win
  rate; EXP-022 confirmed all 22 widened-geometry cells net-negative). It attacks the *symptom* by
  over-widening.
- **M54 changes the *anchor point*** (`P0 → F_exp`) — it removes the *systematic bias* at the source
  without widening the TP relative to the expected entry. It attacks the *cause* and is edge-neutral.

They are **orthogonal levers** (ratio vs anchor). After M54, arming at `a = min_rr = 1.5` against
`F_exp` centers realized R:R at 1.5 (not biased below it), so the residual-noise force_closes that
remain are best handled by the **skip** (b) — which is protective — rather than by raising
`xmom_tp_arm_rr` — which reintroduces the EXP-002 trap. **Recommendation: keep `xmom_tp_arm_rr` at 1.5;
M54 makes it largely unnecessary as a force_close lever but does not remove it** (it is shipped,
harmless at default, and remains available as a deliberately-chosen residual-noise buffer if a future
soak justifies it). M54 and the M53 param never write the same seam: M53 sets the ratio at `:623`; M54
sets the anchor `F_exp` that both `:617` and `:623` are computed from.

---

## 5. Data model impact

**None required for D1/D2.** `bid_ask_spread_pct` and `book_depth_10bps_usdt` are already captured on
the market snapshot / `SymbolMarketState` and persisted on `decisions.market_snapshot` and
`positions` entry-snapshot columns. New momentum params live in the existing `strategy_versions.params`
JSONB (no migration — non-strict schema, §2.5 ADR 0047).

**Observability (D2, log-only, no schema):** log expected slippage `s_exp`, actual-fill residual `r`,
and `depthFraction` per open so D3 can calibrate the skip budget from the measured distribution (mirrors
the M48 `GEOMETRY_ANCHOR_DRIFT` log-only pattern, ADR 0045 §D2.12 — never gates).

---

## 6. New momentum params (D1 — shared contract)

Add to `momentumParamsSchema.ts` (`packages/shared`):

| Param | Type / bound | Default | Meaning |
|-------|--------------|---------|---------|
| `xmom_expected_fill_enabled` | boolean | **false** | **Anchor** toggle only. `false` ⇒ arm off `P0` exactly as today (byte-identical). |
| `xmom_max_depth_fraction` | number > 0 (finite) | **`null` ⇒ skip disabled** | **Skip** budget: skip when `orderNotional / book_depth_10bps_usdt` exceeds it. `null` = skip off (no-op). A finite value activates the order-size-aware skip. Calibrated from D3 before tightening. |

**Coupling constraint (High — enforced in the schema, not just documented).** Add a Zod
`.superRefine` (or `.refine`) on `momentumParamsSchema` that **rejects the parse** when
`xmom_expected_fill_enabled === true` AND `xmom_max_depth_fraction` is `null`/undefined/non-finite. This
makes it **structurally impossible to enable the anchor without a live skip budget**, closing the
EXP-022 §4 bootstrap trap (the earlier draft left them independently toggleable, so D3 calibration could
have run the anchor with the skip disabled — rescuing near-floor force_closes into full-size losers). A
version row that turns the anchor on must therefore also carry a finite, conservatively-seeded
`xmom_max_depth_fraction`.

**Conservative seed for `xmom_max_depth_fraction` (so the skip is calibrated, not guessed).** Seed the
first finite value from the existing depth floors: the gate already treats `book_depth_10bps_usdt` at or
below `COIN_DEPTH_FLOOR_10BPS_USDT[tier]` (`riskConsts.ts:96`) as too thin, and the M22 header pins
tier-consumption at ~10% of the 10bps band as the ~2 bps-slippage reference. Seed the budget at that
same order-of-magnitude consumption fraction (conservative = smaller admitted fraction), then tighten
from D3's measured `depthFraction` distribution. This is enabled **before** the anchor per the coupling
constraint, so calibration data is gathered skip-first.

**Master-toggle vs skip interaction (explicit — the two are separable in the SAFE direction only):**

| `xmom_expected_fill_enabled` | `xmom_max_depth_fraction` | Behavior | Allowed? |
|---|---|---|---|
| `false` | `null` | Full no-op — arm off `P0`, no skip (today's behavior, byte-identical). | ✅ default |
| `false` | finite | **Skip-only** — arm still off `P0`, but the protective thin-book skip runs. Safe (skip is protective, no anchor). | ✅ (skip is calibratable independently, gather data skip-first) |
| `true` | finite | Full M54 — anchor + skip. | ✅ |
| `true` | `null` | Anchor without skip — the EXP-022 §4 trap. | ❌ **rejected by `.superRefine`** |

Both params ship at their no-op defaults, so D1+D2 are a byte-identical no-op on the active version
(`id=20`, `params={}`), consistent with the M51/M52/M53 default-off-paper-soak discipline. Keeping the
model coefficient (half-spread) hard-coded rather than parameterized holds surface minimal; promote it to
a param only if D3 shows the fixed half-spread mis-models the bias (§11).

> **`.env.example`:** these are JSONB strategy params, not env flags, so **no `.env.example` change**
> (per the repo rule, only new env vars/flags require it). Document them in the ADR 0047 params table
> instead (§8).

---

## 7. Phased delivery + dispatch plan

Per `dev-qa-cycle.md` §1 (≤5 items, minimum surface, paired tests, contract touches route through
`bot-shared-maintainer` first, adversarial QA, orchestrator verifies every diff).

| # | Deliverable | Blocking? | Agent (wave) | Primary files (indicative) | Paired tests |
|---|-------------|-----------|--------------|----------------------------|--------------|
| **D1** | Add `xmom_expected_fill_enabled` (default false) + `xmom_max_depth_fraction` (default disabled) to `momentumParamsSchema`; `IMomentumParams` picks them up via `z.infer`. **No-op at defaults.** | **Yes** | `bot-shared-maintainer` (serial, first) | `packages/shared/src/schema/momentumParamsSchema.ts` | `params={}` parses to `enabled=false` + disabled skip (byte-identical to today); explicit values parse and bound-check |
| **D2** | Wire the arm in a fixed compute order (see below); keep `referencePrice`/`midAtTrigger` = `P0`; skip **fails-closed** on `null`/`≤0` depth (§3b table). Applies to the **M52 retry rebuild too** (same builder — see note). Log `s_exp`/`r`/`depthFraction`. | **Yes** | `bot-engine-nestjs` | `MomentumOrchestratorService.ts:597-673` (`buildMomentumOpenIntent`); retry rebuild path (ADR 0051 §3.5) | See §9 (pin the offset, `referencePrice`/drift unchanged, sizer notional unchanged, **fail-closed** on null/zero depth, skip fires only above budget, **thin-book retry is skipped not churned**, slFloor-outcome-may-change assertion) |
| **D3** | Extend the offline replay (`packages/analysis/research/xmom_tp_ratio_replay.mjs`) to re-anchor geometry to `F_exp` and recompute, off the **real recorded fill** (arm-invariant — immune to flat-fill, per M53b Route 2): **(decision-grade)** force_close-rate + skip count + fee-churn; **(characterization, NOT decision-grade)** filled-book SL-hit-rate and PnL delta vs the `F_exp=P0` baseline — reported separately and explicitly labelled non-comparable to the EXP-021/022 full-universe baseline (the skip changes the admitted population, §10). Capture the `s_exp`/`r` residual distribution to calibrate `xmom_max_depth_fraction`. Register **EXP-023**. | Yes (for the soak read) | `bot-engine-nestjs` (analysis) + `bot-review-quant` | `packages/analysis/research/…`, `docs/analysis/README.md` | replay reproduces recorded force_close/barrier at `F_exp=P0` (anchor off) as the baseline calibration; per-config counts separable; characterization metrics are labelled separately from the decision-grade force_close-rate |

**D2 compute order (explicit — M5).** (1) read `state.getSpreadPct()`; if `null`/`≤0` ⇒ `halfSpread=0`.
(2) `F_exp = P0 × (1 + halfSpread/100)` (notional-independent — computed **before** sizing, no circular
dependency). (3) `stopLossPrice = F_exp − D`, `takeProfitPrice = F_exp + a·D`. (4) size with
`entryPrice = F_exp`, `stopLossPrice = F_exp − D` ⇒ `stopDistance = D` (`PositionSizer.ts:52`),
producing `orderNotional`. (5) read `state.getBookDepth10bpsUsdt()`; **skip decision runs AFTER sizing**
(it needs `orderNotional`): `null`/`≤0` ⇒ fail-closed skip; else skip iff
`orderNotional/depth > xmom_max_depth_fraction`. (6) if not skipped, emit the intent → unchanged gate.

**D2 M52 retry coupling (M3).** The M52 retry rebuild constructs a *fresh* open intent via the same
`buildMomentumOpenIntent` (ADR 0051 §3.5 "fresh sizing and geometry — never reuse attempt 1"), so it
inherits the anchor + skip automatically. This is desirable: a thin-book retry that would just
re-`force_close` is now **skipped, not re-opened-and-churned** (EXP-018 §3 observed 3/4 retries
re-rejecting the same thin coin). A dedicated test asserts this (§9 #9).
| **D4** | Adversarial QA on D2 (the only behavioral code) + ADR amendment. | Yes | `bot-qa-engineer` | tests | §9 adversarial suite is the bar |
| **D5** | Reviewers + scribe close-out. | Yes | `bot-review-quant` (mandatory) + `bot-review-security` + `bot-review-logic` + `bot-review-clean-code`; then `bot-scribe` | ADR 0047 §7 amend, ADR 0045/0051 reference notes, milestone-log, work-log, README status→DONE | zero blockers/highs, majority mediums |

**Wave order:** (1) `bot-shared-maintainer` (D1 schema, serial). (2) `bot-engine-nestjs` (D2 arm wiring +
D3 replay). (3) `bot-qa-engineer` (D4 adversarial). (4) reviewers in parallel — **`bot-review-quant` is
mandatory** (geometry/quant change; must enforce "correctness not edge" and that the skip, not admission,
is the lever). (5) `bot-scribe`. No `bot-devops` needed (no env var, no config). No
`bot-shared-maintainer` re-interpretation of the fill-acceptance contract — the guard is untouched.

---

## 8. ADR impact

- **ADR 0047 (portfolio-strategy contract / `momentumParamsSchema`) — AMEND (new §7, sibling to the M53
  §6).** Document the two new params, their no-op defaults, the expected-fill anchor decision (arm off
  `F_exp`, keep `referencePrice = P0`), the half-spread model + why not the backtest flat-slippage
  (EXP-008), the depth-fraction skip, and the "correctness/fee-bleed, NOT edge" scope (EXP-021/022).
  This is the params' home ADR.
- **ADR 0045 (fill-acceptance guard) — REFERENCE, not amended.** The guard is consumed byte-for-byte.
  Add a note: the arm now anchors to the expected fill, so the guard's realized R:R is *centered at the
  floor* instead of *biased below it* — the guard's meaning is unchanged; only the pre-fill anchor it
  measures against is corrected.
- **ADR 0051 (M52 force_close retry) — REFERENCE, not amended.** Note that expected-fill anchoring +
  the skip *reduce the force_close arrival rate* the retry mechanism responds to and that the retry
  rebuild inherits the anchor+skip via the shared builder (§7 D2), but the retry contract is unchanged
  and `atrUnitsDrift` (keyed on `|fill − referencePrice|/atr`, `referencePrice = P0` unchanged) needs
  **no** `MOMENTUM_RETRY_MAX_ATR_DRIFT` recalibration.
- **ADR 0004 §6a (per-coin book-depth eligibility / `isBookTooThin`) — REFERENCE, not amended.** Record
  the two-layer reconciliation (§1.2): M54's pre-gate, order-size-aware slippage-budget skip sits *above*
  the unchanged in-gate static tier-floor guard, and adopts its fail-closed convention. The gate guard
  (and the M51/ADR 0042 §9 paper-relax that loosens it) is untouched.
- **New ADR: NOT warranted.** This is an amendment to the existing momentum-params + arm-geometry
  contract (ADR 0047/0045), not a new mechanism. Update `docs/architecture/adr/README.md` Strategy
  section anchors.

---

## 9. Testing requirements (adversarial is the bar)

**No-op / regression backbone:**

1. **D1/D2 no-op at defaults.** `params={}` (or `xmom_expected_fill_enabled=false`) ⇒ SL/TP armed off
   `P0` byte-identical to today; skip disabled. (The safety of shipping to the active version.)

**Adversarial (the bar for done):**

2. **Anchor pins the offset, not a bare price.** With `enabled=true`, `bid_ask_spread_pct = 0.20%` ⇒
   `halfSpread = 0.10%` ⇒ `F_exp = P0 × 1.001`; assert `stopLossPrice = F_exp − D`,
   `takeProfitPrice = F_exp + a·D`, and that at a fill `F = F_exp` (residual `r=0`) realized R:R = `a`
   (clears the floor), whereas the same fill under the old `P0` anchor gives `(a−s)/(1+s) < a`.
3. **`referencePrice`, `midAtTrigger`, and `atrUnitsDrift` anchor are UNCHANGED** by the anchor move
   (assert they still equal `P0`) — the M52 retry breaker keys on `|fill − referencePrice|/atr` and must
   not shift.
4. **slFloor threshold anchor unchanged, but the slFloor *outcome* may change (and that is safe).**
   Assert `resolveSlFloorDistance` still anchors to `referencePrice = P0` (the *threshold* does not
   move). But because `stopLossPrice = F_exp − D`, the realized `slDist` at fill shifts by the
   half-spread, so `isSlBelowFloor` (`exitGeometryHelper.ts:181`) *can* flip vs the `P0`-anchored
   baseline — assert this is possible and intended (the guard outcome changing is safe; only the
   threshold anchor is invariant). Do **not** claim "no shift" in the outcome.
5. **Sizer notional unchanged.** With the anchor on, `stopDistance` fed to the sizer stays `D` and
   notional matches the `P0`-anchored baseline within tick rounding (`PositionSizer.ts:52-54`).
6. **Skip FAILS-CLOSED on bad data (revised).** `book_depth_10bps_usdt = null` ⇒ candidate **skipped**;
   `book_depth_10bps_usdt ≤ 0` ⇒ **skipped**; `bid_ask_spread_pct = null/0` ⇒ `F_exp = P0` (anchor
   no-op, candidate not skipped on spread alone). Assert the empty book is never admitted.
7. **Skip fires only above budget.** finite `orderNotional/depth` just above `xmom_max_depth_fraction`
   ⇒ `null` skip (no intent emitted, logged); just below ⇒ intent built. Assert **no** intent from a
   skipped candidate reaches the risk gate / executor.
8. **Schema coupling enforced.** `momentumParamsSchema.parse({ xmom_expected_fill_enabled: true })` with
   `xmom_max_depth_fraction` absent/`null`/non-finite **throws** (`.superRefine`); with a finite budget
   it parses. `enabled=false` + finite budget parses (skip-only is allowed).
9. **M52 retry inherits the skip (M3).** A retry rebuild on a thin coin whose depth fails the budget is
   **skipped** (no intent, logged), not re-opened-and-force_closed — assert the retry path produces no
   0-duration force_close for a budget-failing coin.
10. **No-new-nondeterminism of `:597-673`.** Same snapshot ⇒ same `F_exp`, same skip decision (the
    method still `await`s candle/instrument reads — assert no new clock/RNG/nondeterministic input, not
    literal purity).
11. **Guard untouched.** `exitGeometryHelper` `isRrInsufficient` / `evaluateFillGeometry` reads
    `geometryParams.min_rr` (= `xmom_min_rr`), never the new params.

**Live-app PAPER smoke (mandatory before close, `dev-qa-cycle.md` §6.4).** Boot PAPER, drive
`pnpm rebalance:trigger`: (a) no `ERROR`/DI-cycle/boot failure; (b) with `enabled=false` xmom opens arm
exactly as pre-M54 (no-op verified end-to-end); (c) with `enabled=true` on a paper version, confirm the
`s_exp`/`r`/`depthFraction` logs emit and at least one thin-book candidate is skipped pre-send (no
0-duration force_close for it).

---

## 10. Rollback / soak gating / success criteria

- **Ships default-off (byte-identical no-op).** Reversible by leaving the params at defaults or removing
  the fields (inert). No migration, no DB touch, no `pg_dump` gate (CLAUDE.md rule-9 N/A — no schema/DB
  operation).
- **Soak-gated enablement.** Enable `xmom_expected_fill_enabled` (and later tighten
  `xmom_max_depth_fraction` from D3's measured residual/depth distribution) on the paper soak only. The
  active version stays no-op until the soak read confirms the intended effect.
- **Success criteria:**
  - **Decision-grade (correctness/fee-bleed):** **force_close rate** on scheduled opens falls materially
    from the ~67% baseline toward the residual-noise floor; **fee/slot churn** falls (fewer 0-duration
    open→force_close→retry cycles — skips replace them); **skip count / depth-fraction distribution** is
    sane (does not starve the soak beyond the existing gate; calibrated, not universe-emptying).
  - **Characterization (NOT decision-grade, must still be measured — High-2):** the anchor moves
    absolute SL/TP by the half-spread on **every filled trade**, so filled-book **SL-hit-rate** and
    **PnL delta** are *not guaranteed neutral*. D3/EXP-023 must report these as a **characterization**
    of what the anchor did — do **not** pre-declare a PnL move as "noise." A PnL swing is a *finding to
    explain*, not a success or a dismissable artifact.
  - **Non-comparability guard (M2):** the depth-skip changes the admitted-signal population, so any
    filtered-universe filled-book PnL is **NOT comparable** to the EXP-021/022 full-universe baseline —
    D3 must state this explicitly so nobody reads a filtered-universe PnL delta as "edge recovered."
  - **Not a profitability fix.** EXP-021/022 proved there is no edge to recover. **Do not sell M54 as a
    profitability fix**; the decision-grade metric remains force_close-rate / fee-churn, and any PnL
    movement is characterization, not attribution.
- **Unchanged:** the ADR 0045 guard, `xmom_min_rr`, the risk gate, slot model, `top_n`, ranking,
  rebalance cadence, the M52 retry mechanism / `MOMENTUM_RETRY_MAX_ATR_DRIFT`, and the M53
  `xmom_tp_arm_rr` param (stays 1.5). M54 is additive and pre-fill only.

---

## 11. What NOT to change (scope boundaries)

- **The ADR 0045 fill-acceptance guard** (`evaluateFillGeometry`/`isRrInsufficient`/synthetic-FLATTEN
  unwind) — byte-for-byte unchanged.
- **`xmom_min_rr`** — stays the guard floor; not raised, not repurposed.
- **`referencePrice` / `midAtTrigger` / recorded signal anchor** — stay `P0` (protect M48 slFloor + M52
  drift breaker).
- **`xmom_tp_arm_rr`** — stays 1.5 (M53). M54 does not raise or remove it.
- **No fill-time TP rebase** (`tpRebaseEligible` stays false — ADR 0045 M47 amendment REJECTED it).
- **No depth-scaled impact term on the anchor** in this milestone (half-spread only; refinement deferred
  pending D3 residual calibration).
- **No live capital, no promotion, no edge claim.**

---

## 12. Open questions

1. **Skip budget default & calibration.** `xmom_max_depth_fraction` ships disabled; the tightened value
   must come from D3's measured `depthFraction` distribution over the soak `positions` set, not a guess.
   Pre-register the enablement/tightening threshold before reading, per the repo's multiple-comparisons
   discipline.
2. **Anchor model sufficiency.** If D3's residual `r` distribution stays biased (`E[r] > 0`) under the
   half-spread-only anchor, add a depth-scaled linear impact term to `F_exp` — a follow-up, not M54.
3. **Measurement instrument.** D3 uses the offline replay (M53b Route 2 — immune to flat-fill because it
   prices off the real recorded fill). The portfolio-shadow fan-out (Route 1) is NOT built for xmom (ADR
   0047 §6.4) and is not needed here — force_close-rate and skip-count are recorded/replayable directly;
   no post-fill counterfactual on rescued fills is required (M54 skips them, it does not rescue them).

---

## Supersedes / links

- **Extends** ADR 0047 (momentum params) and consumes ADR 0045 (fill-acceptance guard) + ADR 0051 (M52
  retry) unchanged.
- **Builds on** M50/M50b (xmom cascade), M51 (paper-gate unblock), M52/M52a (force_close slot recovery),
  M53 (`xmom_tp_arm_rr` decouple — complementary, §4).
- **Source analysis:** EXP-022 (`docs/analysis/20260708-xmom-geometry-and-live-forensics-exp022.md`,
  §3/§7) and EXP-018 (`docs/analysis/20260704-m52-force-close-retry-soak-analysis.md`, §2, seed #3).
- **Does not affect** the xmom live-promotion gate — xmom stays PAPER-only with its HIGH go-live blockers
  (EXP-021 fragile peak; no edge).
</content>
</invoke>
