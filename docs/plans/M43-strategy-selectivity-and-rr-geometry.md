# M43 — Strategy selectivity (flow-routing) + long-book reward:risk geometry

> **Sequencing note:** M43 is a **strategy-edge** milestone surfaced by the 2026-06-21 24h paper-soak
> trade analysis (`docs/wip/2026-06-21-vwap-edge-24h-soak-analysis.md`; quant + logic reviewers passed,
> two HIGH corrections applied). It is **not** a safety hotfix and **not** a go-live milestone (M15 keeps
> that slot). Every `CLAUDE.md` trading-safety invariant holds: no order path bypasses the risk gate, the
> strategy stays pure/deterministic so backtest reproduces live, money stays `decimal`, no LLM in the live
> loop, and the flow-route change is **subtractive** (route a losing flow class to `skip`) — it can only
> reduce risk-taking, never increase it. The milestone is explicitly built around the **B5 shadow-fill
> gate**: the one item that needs proven v3 PnL (D1) is gated on B5 closing; the geometry item (D2) and the
> selectivity investigation (D3) do not need B5 and ship first.

> **Sample-size discipline (governs the whole milestone).** The soak window is **n=27 closed v2 trades,
> single regime, no held-out sub-period** (analysis §intro, line 14; §4.1 window note, lines 228–232). The
> analysis is **directional, not conclusive** (line 16). M43 therefore ships only the changes whose
> justification is **robust to sample size** — RR geometry (breakeven algebra, not a fitted parameter) and
> flow-routing (a 14-trade, −39 USDT structural signal that matches the strategy's known design gap). It
> **does not** re-tune ATR/sigma/time-stop on n=27 (§5, lines 293–295). See cross-cutting non-goals.

## Findings → scope decision (at a glance)

| # | Finding (analysis ref) | Severity | M43 scope |
|---|------------------------|----------|-----------|
| D1 | `catalyst_risk` mis-route: v2 follows catalyst-driven spikes as if they were trends; 14/27 trades, **−39.29 USDT**, 0/14 ever reached the TP band, MAE ~4× MFE (§flow-split lines 63–75; §4.1② lines 249–264). `forced_exhaustion` is a **second mis-route in the same family** — v2 *follows* 4 trades the design says to *fade* (§2.1 lines 150–154). v3 (hybrid router) already routes `catalyst_risk → skip` and `forced_exhaustion → mean-reversion` (`V3HybridRouterStrategy.ts:11,14,26`). | **HIGH (structural)** | **D1 — IN, B5-GATED.** Investigation-first. (a) wait for B5; (b) run `compareVersions(v2, v3)` on post-restart shadow data; (c) promote v3 active **iff** the soak-comparison evidence threshold (§D1) holds. Fallback: add `catalyst_risk → skip` to v2 directly if v3 PnL is uncomputable/insufficient. `forced_exhaustion` is **subsumed by D1** — no separate strategy change. |
| D2 | Long-book reward:risk inverted: ATR TP ~0.9–1.6% vs VWAP structural SL ~2.5–3.4% → RR ≈ 0.5–0.6 on longs (shorts ≈1.0). 9 `tp_below_cost` gate rejects, **all 9 tier2** — the 2× tier2 slippage (0.50%) alone exceeds the entire ATR TP distance (§SL/TP lines 99–119; §Q2 lines 187–193; §4.1③ lines 266–282). | **HIGH (structural)** | **D2 — IN, ships first (no B5 dependency).** Tier-aware long-book RR repair. **Investigation-first** (D2.0) to size the exact gap, then the smallest geometric change that lifts long-side RR toward ≥ ~1.4 **without** rebasing the structural SL (ADR 0045 §D1 line 52) and **without** weakening the `tp_below_cost` gate (which is working). |
| D3 | Time-stop dead signals: 17/27 exits at the 15-min time-stop with +0.3% MFE — non-events, weak entries (§exit-dist lines 43–58; §3 lines 207–210). Analysis: this is a **selectivity** problem, not a stop/TP tuning problem. | **MEDIUM** | **D3 — INVESTIGATION ONLY (no code in M43).** D1's flow-route removes the dominant dead bucket (`catalyst_risk` = 11 of the 17 time-stops). Quantify the residual after D1, then decide a *future* milestone on `require_exhaustion_confirmation`. **Do not tune the time-stop.** |
| D4 | tier2 dollar drag (tier2 −31.05, tier2 longs −27.42); 9 `tp_below_cost` rejects all tier2 (§tier-split lines 78–87; §4.1③). | LOW (known) | **Out (reinforces policy).** Consistent with locked tier-1-only live start. No exposure change. D2's RR fix must be **tier-aware** so it does not silently re-enable tier2 TPs. |
| D5 | v3 emits **zero** `simulated_fill` (NULL on all 28–32 shadow opens) — the *missing-fill* mode, distinct from v1's degenerate fills (§cross-version lines 122–139; §4.1① lines 234–247). | **HIGH (blocks D1)** | **Folded into B5 / D1.** §4.1① surfaces a concrete sub-task — **wire v3 shadow opens into the fill simulator**. Fixing v1 fidelity alone does not unblock the v3 head-to-head. See §B5. |

---

## B5 dependency — the gate that orders this milestone

D1's promotion decision consumes the **realized shadow PnL series**. That series is **not yet computable**:
M40 D2 left the prod-verification gate (B5) open, and §4.1① of the analysis confirms `compareVersions(v2,
v3)` **cannot return a PnL today** (v3 = 0 simulated fills; v1 mostly degenerate; only 2 clean v1 fills in
the last 3h).

**B5 is the M40 D2 acceptance criterion** (M40 spec lines 226–233): after deploy, `shadow_decisions` shows
non-zero `simulated_fill` for gate-allowed opens **over ≥1 full soak day** AND the `close_reason`
distribution among populated fills is **non-degenerate** — a non-trivial fraction of `sl` / `tp` /
`time_stop`, **not ~100% `force_close`**. The B5 window `from` must be **≥ the M40+M42 engine-restart
timestamp** (the restart that just started the shadow series counting — STATUS.md line 9; M40 B6 window
discipline).

**B5 closes when ALL of the following hold (operator + scribe verify before D1 step (b) runs):**

1. **v3 emits non-null `simulated_fill`** for its gate-allowed shadow opens (the §4.1① *missing-fill* mode
   is fixed — v3 opens are handed to the fill simulator). This is the **D5 sub-task**; it is a prerequisite
   for any v2↔v3 PnL join and is the single most likely thing still blocking B5.
2. The populated v3 fills show a **non-degenerate `close_reason` distribution** (not ~100% `force_close`) —
   i.e. the deferred-walk **upgrade** is landing for the shadow series, not just the synchronous W1 write
   (M40 B5 / `:522-530`).
3. Coverage spans **≥1 full soak day** strictly **after** the M40+M42 restart timestamp.

> **D5 status check is the first action of D1.** If, after ≥1 soak day, v3 still emits zero fills, B5 is NOT
> closed and D1 step (b) **must not run** — the milestone falls back to the §D1 fallback (v2 direct skip) or
> defers D1 to the next soak window. **Do not promote v3 on selectivity alone** (analysis §5 lines 296–298)
> and **do not backfill degenerate rows** to fake B5 (M40 non-goal; M43 non-goal below).

---

## D1 (HIGH, structural, B5-GATED) — Route `catalyst_risk` to skip via v3 promotion (or v2 fallback)

### Root cause (confirmed by analysis + code read)

v2 is **pure momentum with no flow router** — it follows every triggered move (analysis §2.1 lines 145–149).
`catalyst_risk` events (liquidation / event-driven one-and-done spikes) do not continue; they revert or
chop. §4.1② is the strongest evidence in the analysis and is a **path statistic independent of where SL/TP
sit** (lines 258–264): **not one of the 14 `catalyst_risk` trades ever reached the TP band; best excursion
+0.61%, MAE −1.03% ≈ 4× the upside.** `trend_initiation` is the mirror image (MFE +1.04% ≫ MAE −0.46%, 3/8
reached TP, net +27.77). The flow classifier is already separating dead events from real ones — **v2 simply
isn't acting on it.** This is precisely the gap `V3HybridRouterStrategy` exists to close:

```text
forced_exhaustion → mean-reversion core (the valid fade case)   // V3HybridRouterStrategy.ts:11
catalyst_risk     → skip (FLOW_ROUTED_SKIP)                     // V3HybridRouterStrategy.ts:14,26,36
```

`forced_exhaustion` is the **second mis-route in the same family** (analysis §2.1 lines 150–154): v2
*follows* the 4 `forced_exhaustion` trades; the design *fades* them (`meanReversionCore` is shared by v1 and
v3's `forced_exhaustion` route — `meanReversionCore.ts:25`). They net ~flat in-window (−0.90) so this is a
*directional design-conformance* fix, not a PnL-proven one — which is exactly why it is **subsumed by D1's
v3 promotion** (v3 already routes it correctly) and is **not** scoped as a standalone v2 change.

### The decision tree (B5-gated, evidence-thresholded)

D1 is **investigation-led**. No strategy/version change lands until the comparison runs.

**(a) Wait for B5** (§B5 above). The D5 v3-fill sub-task is a prerequisite and is the first concrete action.

**(b) Run `compareVersions(v2, v3)`** on the **post-restart** shadow window only (B6 window discipline:
`from` ≥ M40+M42 restart timestamp). The join is structurally ready — 161 shared v2↔v3 `event_id` pairs
exist (§4.1① line 241); it is purely PnL-blocked.

**(c) Promote v3 as the active version IFF the soak-comparison evidence threshold holds** (defined below).
Otherwise take the **fallback** (v2 direct skip) or defer.

#### The evidence threshold for promoting v3 on **soak** data (not the full ADR 0019 gate)

> **Why this needs its own threshold.** ADR 0019's promotion gate (criterion 6) requires **≥200 trades
> total, ≥100 in target regime, ≥30 days shadow** on **OOS backtest folds** — unreachable on a 27-trade,
> single-regime live soak. The formal ADR 0019 gate is the bar for a *general* promotion. M43 promotes v3
> for a *narrow, pre-stated structural reason* (route out the proven-dead `catalyst_risk` bucket), so it
> defines an **interim soak-comparison threshold** and records the divergence from ADR 0019 as an explicit,
> auditable exception (ADR 0019 amendment, §ADRs). This is the architect's call and must be argued in the
> ADR, not buried in config.

D1 step (c) promotes v3 **only if every one of these holds** on the post-restart shadow window:

1. **B5 closed** — v3's realized shadow series is non-degenerate (non-null fills, non-`force_close`-dominated
   `close_reason` distribution). A series that is populated-but-all-`force_close` **fails** this (M40 B5).
2. **v3 PnL ≥ v2 PnL** on the **same `event_id` set** (paired comparison), OR v3 dominates on a stated
   risk-adjusted axis (lower realized drawdown AND ≥ v2 net PnL) — the comparison must be **paired on
   events**, never two independent aggregates.
3. **The win is mechanism-attributable, not noise:** v3's edge over v2 is concentrated in the
   `catalyst_risk` / `forced_exhaustion` events it skips/fades (the routed buckets), reproducing §4.1②'s
   flow-split — i.e. the PnL delta comes from the trades v3 *didn't take*, not from a lucky residual.
4. **Minimum paired-event count** for the routed buckets is met (the impl brief pins the exact n; the
   analysis fill pace is ≈26–27 closed/24h, so ≥1 soak day yields a comparable n to the original window).
   This is a **soak floor**, explicitly weaker than ADR 0019 criterion 6 and **documented as such**.

If 1 fails → B5 not closed → **do not run (c)**; fall back or defer. If 2–4 fail → **do not promote**; take
the fallback below or defer to a longer soak. **Promotion on selectivity alone is forbidden** (analysis §5).

#### Promotion mechanism (if (c) fires)

Per ADR 0019 §2.5 and ADR 0016 §2.2: `PromotionService.promote` flips the `active` row to v3 in a
transaction; the **engine restart** picks up the new `active` via `StrategyVersionRepository.findActive` at
boot (the live engine does **not** reload mid-session). No live trade-loop code changes — the engine's only
contract is "read the row marked `active`."

#### Fallback — add `catalyst_risk → skip` to v2 directly (only if (c) cannot fire)

If B5 cannot close within the milestone window, or v3 PnL is computable but insufficient/inconclusive while
the §4.1② `catalyst_risk` dead-flow signal remains decisive, scope a **minimal additive skip** in the v2
momentum path: when the orchestrator-stamped `flow_type === catalyst_risk`, v2 emits `SKIP` with
`FLOW_ROUTED_SKIP` **before** building a momentum signal. Constraints:

- **Routing reads the orchestrator-stamped `flow_type`** (ADR 0003 §4 lines 205–212) — v2 must **not**
  re-classify (single-source-of-truth; M8 comparability).
- **Subtractive only** — this can only turn an OPEN into a SKIP; it never changes direction, sizing, or
  exits. It is the v3 `catalyst_risk` branch transplanted into v2, nothing more.
- **`forced_exhaustion` is NOT added to the v2 fallback** — fading requires the mean-reversion core, which
  is a behavior change, not a skip; that belongs to v3 only. The fallback handles `catalyst_risk → skip`
  exclusively (the −39 USDT bucket); `forced_exhaustion` waits for the v3 path.
- This is a **strategy-behavior change to the active version** — it needs paired backtest parity (live ==
  backtest) tests, not just unit tests, because v2 also runs in the backtest harness.

> **Architect preference: v3 promotion over the v2 fallback.** v3 already encodes both routes correctly and
> has been shadow-validated for selectivity; the fallback duplicates one branch into v2 and leaves
> `forced_exhaustion` mis-routed. The fallback exists only so the −39 USDT bleed is not held hostage to B5
> if the soak stalls. Prefer (c); use the fallback only with explicit operator sign-off.

### Files (indicative; ≤5 per dispatch — split across waves)

**Investigation / D5 (no strategy change):**
1. `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` — wire v3 shadow opens into the
   fill simulator (the §4.1① *missing-fill* fix; confirm the actual mechanism first, mirror M40 D2.0 style).
2. Paired specs under `strategy/service/__tests__/`.

**Promotion path (if (c) fires) — no engine code, operator + harness:**
3. `comparison_reports` row via `pnpm engine strategy compare …` (operator action; no source edit).
4. `pnpm engine strategy promote --version-id=<v3> --report-id=<M> --note=…` (operator action).

**Fallback path (only if (c) cannot fire):**
5. `apps/engine/src/strategy/strategies/momentumCore.ts` (or the v2 entry seam) — pre-signal
   `catalyst_risk → SKIP` branch reading the stamped `flow_type`; + paired backtest-parity specs.

> The promotion path adds **no source change**; the fallback path is a single strategy file + tests. The two
> are mutually exclusive — never both in one wave.

### Acceptance criteria (D1)

- **A0 (B5 closed — the gate):** the scribe records, with date + count + `close_reason` distribution
  evidence from `shadow_decisions`, that v3 emits non-null, non-degenerate `simulated_fill` over ≥1 full soak
  day **after** the M40+M42 restart. D1 step (b) is **forbidden** until A0 is recorded. (If A0 cannot be met
  in-window, D1 routes to the fallback or defers — recorded in the work-log.)
- **A1 (D5 fill-simulator wiring):** a gate-allowed v3 shadow OPEN produces a **non-null `simulated_fill`**
  (the *missing-fill* mode is fixed) — asserted in a unit test against the orchestrator path. The conservative
  "no signal-bar ticks" decline still produces a miss, never a fabricated fill (mirror M40 B2).
- **A2 (paired comparison, post-restart window):** `compareVersions(v2, v3)` runs on the **same `event_id`
  set**, window `from` ≥ M40+M42 restart timestamp, and returns a computable PnL for **both** versions (no
  NULL-fill denominator). The June-10 → M40 degenerate window is excluded (M40 B6).
- **A3 (promotion only on the threshold):** v3 is promoted **iff** §D1 (c) criteria 1–4 all hold; the
  promotion writes a `comparison_reports` row and the `active` flip is transactional (ADR 0016 §2.2). A test
  / harness check asserts the engine reads v3 as `active` only after restart (no mid-session reload).
- **A4 (no promotion on a failing threshold):** if any of §D1 (c) 1–4 fails, the harness records `reject` /
  `inconclusive` with the failed criterion and **does not flip `active`** — v2 stays active. Asserted.
- **A5 (fallback equivalence + parity, only if used):** the v2 `catalyst_risk → SKIP` branch (a) reads the
  **orchestrator-stamped** `flow_type`, never re-classifies; (b) emits `FLOW_ROUTED_SKIP`; (c) is **purely
  subtractive** — a `trend_initiation` event is unaffected (still opens), only `catalyst_risk` flips to skip;
  (d) **live == backtest** for the same event (parity test), since v2 runs in the harness. `forced_exhaustion`
  remains a *follow* in the v2 fallback (NOT faded) — asserted, so the fallback's scope is explicit.
- **A6 (determinism preserved):** whichever path lands, the strategy stays pure — no `Date.now()`/
  `Math.random()`/I/O in the decision; routing depends only on the stamped `flow_type` and event fields.

---

## D2 (HIGH, structural, ships first) — Long-book tier-aware reward:risk repair

### Root cause (confirmed by analysis + code read)

v2's stop is the **VWAP structural stop** (`stopLossPrice: new Money(event.vwapSession)`,
`momentumCore.ts:48`, `StopTypeEnum.STRUCTURAL`); the take-profit is the **ATR leg**
(`referencePrice ± atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER`, multiplier = **2.0**,
`momentumCore.ts:42–43`, `strategyConsts.ts:45`). In-window the realized geometry is wide-stop / tight-target
on longs: SL ~2.5–3.4% out, ATR TP ~0.9–1.6% out → **RR ≈ 0.5–0.6 on longs, ≈1.0 on shorts** (§SL/TP lines
108–119). A 42%-win-rate book needs **RR ≥ ~1.4** to be positive (§Q2 line 193). The asymmetry is
**long-specific** because the VWAP stop on a long sits *below* entry by the full session-deviation distance,
while on a short the VWAP stop sits much closer.

The 9 `tp_below_cost` rejects are the **same disease at the gate** and are **tier2-specific** (§4.1③ lines
266–282): all 9 are tier2, where the reconstructed ATR TP (0.46–0.78%) cannot clear the tier2 cost floor
(≈1.09%, dominated by 2× tier2 slippage at 0.50%). On tier1 the floor is ≈0.39% and the ATR TP (~0.6–1.2%)
clears it. **The gate is working** — it correctly kills geometrically-impossible tier2 TPs. The fix is
therefore **tier-aware**: it must lift long-side RR **without** re-enabling tier2 TPs the gate is right to
reject (analysis §4.1③ line 281: "tier2 needs a wider TP multiplier or exclusion, not a global TP change").

### Investigation-first (D2.0 — mandatory, no fix code in this step)

> **The analysis flags an instrumentation gap (§4.1③ lines 269–271):** `take_profit` is not stamped on the
> `tp_below_cost` rejects (the gate fires before TP is committed), so the §4.1③ TP/floor numbers are
> *reconstructed* (`atr_14 × 1.5 / price` vs a cost-floor estimate). The 1.5 the analysis used to reconstruct
> differs from the live `MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER = 2.0` — **D2.0 must reconcile this** before
> sizing the fix.

D2.0 (engine specialist, against the soak DB) must, before any geometry change:
- (a) Confirm the **realized** long-side RR distribution (VWAP-SL distance vs ATR-TP distance) per tier from
  `positions`, separating tier1 from tier2, so the fix is sized on real fills not reconstructions.
- (b) Confirm the **exact** tier1 vs tier2 cost floor (round-trip fee + per-tier slippage consts) from the
  actual config — the §4.1③ 0.09% fee is an estimate (line 282).
- (c) Decide the **minimal geometric lever** that lifts long RR toward ≥ ~1.4: candidates, in preference
  order — (i) a **tier-aware TP anchor** `TP = entry_side ± max(atr14 × k, cost_floor + margin)` so the TP is
  never placed below a cost-aware floor (analysis §3.2 line 206: "anchor TP to `cost + k·ATR`, not a fixed
  fraction"); (ii) raise the long-side ATR multiplier; (iii) tighten the VWAP SL. The architect adjudicates;
  **(iii) is disfavored** because it touches the structural stop (see invariant below).
- Write the finding into the impl brief / work-log (not a standalone report file), mirroring M40 D2.0.

### The hard invariant the fix must NOT violate (ADR 0045 §D1)

**The realized stop price comes from the STRUCTURAL stop and the SL is NEVER rebased after entry**
(`momentumCore.ts:47–48`; ADR 0045 §D1 line 52: "SL is never rebased — the structural one-R VWAP budget is
preserved"). Therefore:

- The fix **may not** re-anchor or move the structural SL off `event.vwapSession`. Lifting RR by *tightening*
  the SL is only acceptable if it remains a **structural price level** (not an ATR-distance stop, not a
  fill-rebased stop) and the architect signs off — preference is to move the **TP**, leaving the SL untouched.
- A TP change to `momentumCore.buildMomentumExit` must keep the M38 rebase contract intact: the TP stays
  **rebase-eligible** (`tpRebaseEligible: true`) and `atrDistance` is still **computed once in the strategy
  layer and consumed verbatim** at the live arm seam AND `BacktestOrchestrator.buildPosition` (ADR 0045 §D1.2
  lines 65–73) — neither seam may re-derive the distance, or the parity test fails. If the TP becomes
  `max(atr×k, floor)`, the **same** value must flow through `atrDistance` so the rebase re-anchors the same
  geometry from the fill price.
- The change **must not weaken the `tp_below_cost` gate** — the gate stays the backstop. A correctly-anchored
  TP simply stops *producing* sub-cost tier2 TPs; the gate still rejects any that slip through.

### Files (indicative; ≤5 per dispatch)

1. `apps/engine/src/strategy/strategies/momentumCore.ts` — `buildMomentumExit` TP anchor change (tier-aware,
   cost-floor-anchored per D2.0).
2. `apps/engine/src/strategy/const/strategyConsts.ts` — any new/changed multiplier or cost-floor-margin
   constant (named `UPPER_SNAKE_CASE`, at the highest level; never a magic number in the function).
3. Paired specs under `strategy/strategies/__tests__/` — incl. an M38-parity test that the new
   `atrDistance` still rebases identically live vs backtest.
4. `apps/engine/src/backtest/service/BacktestOrchestrator.ts` only if the rebase consumer needs the same new
   value (it consumes `atrDistance` verbatim, so usually no change — confirm in the brief).

> No `packages/shared` change expected (the TP geometry is engine-local per ADR 0045 §D1.2). If a cost-floor
> constant must be shared with the gate, route it through `bot-shared-maintainer` (architect call).

### Acceptance criteria (D2)

- **B0 (D2.0 recorded):** the impl brief / work-log states the confirmed realized per-tier long RR and the
  exact per-tier cost floor, with the discriminating query — and reconciles the §4.1③ reconstruction (1.5×)
  against the live `2.0×` multiplier. No fix code lands before B0.
- **B1 (long RR lifted):** for a representative long signal, the proposed TP distance relative to the VWAP
  structural SL distance yields RR ≥ the target (≈1.4; exact target pinned in the brief from B0) — asserted
  on the **proposed geometry** (a strategy-layer unit test on `buildMomentumExit`), not on realized fills
  (which need a fresh soak to confirm). Shorts are **unchanged** (already ≈1.0) — asserted.
- **B2 (SL untouched — the invariant):** the structural SL stays `event.vwapSession`,
  `StopTypeEnum.STRUCTURAL`, and is **never rebased** (ADR 0045 §D1). A test asserts the SL price/type is
  unchanged by the D2 fix. If the architect approved an SL tightening, it asserts the SL remains a structural
  price level, not an ATR-distance stop.
- **B3 (cost-floor anchor):** the TP is anchored so it is **never placed below** the tier-aware cost floor
  (`TP = side ± max(atr×k, floor + margin)` or the chosen lever) — a tier2 signal that previously produced a
  sub-cost TP now produces either a floor-clearing TP **or** continues to be correctly rejected by
  `tp_below_cost`; it must **not** silently re-enable a geometrically-impossible tier2 TP. Asserted for both a
  tier1 and a tier2 fixture.
- **B4 (M38 rebase parity intact):** `tpRebaseEligible` stays `true`; `atrDistance` carries the **new**
  anchored distance and is consumed **verbatim** at the live arm seam and `BacktestOrchestrator.buildPosition`
  — a parity test asserts live-rebased TP == backtest-rebased TP for the same fill (ADR 0045 §D1.2).
- **B5 (gate not weakened):** the `tp_below_cost` gate logic is unchanged and still rejects any sub-cost TP
  that reaches it. Asserted (regression).
- **B6 (determinism + decimal):** the TP math is pure, decimal-only (`Money`), no `Date.now()`/`Math.random()`,
  reproducible live == backtest.
- **B7 (tier-aware, not global):** the fix does **not** alter the short-side geometry and does **not** make a
  global TP-multiplier change that would re-admit the tier2 TPs the gate is right to reject (§4.1③ line 281).
  Asserted via the tier1/tier2 fixtures of B3.

---

## D3 (MEDIUM) — Time-stop dead-signal selectivity — INVESTIGATION ONLY (no code in M43)

### Why investigation-only

17/27 exits hit the 15-min time-stop with **+0.3% MFE** — the entries carry no follow-through (§exit-dist
lines 50–58). The analysis is explicit (§3 lines 207–210; §5 lines 293–295): this is a **selectivity (skip)
problem, not a stop/TP tuning problem** — and **the time-stop minutes / ATR / sigma must NOT be tuned on
n=27** (tuning the stop treats the symptom and risks destroying the `trend_initiation` edge that is currently
paying). 11 of the 17 time-stops are `catalyst_risk` (§flow-split line 66), so **D1 removes the bulk of this
bucket on its own.**

### Scope in M43

A single investigation deliverable (engine specialist, against the soak DB, **after D1 lands or after a
fresh post-D1 soak day**): quantify the **residual** dead-time-stop bucket once `catalyst_risk` is routed
out. If a material residual of dead non-events remains in `trend_initiation` / other live flows, write a
**proposal stub** for a future milestone on entry-confirmation selectivity (v1 already carries
`require_exhaustion_confirmation` — `strategy/const/strategyConsts.ts:33–38`, `VOLUME_DECELERATION_RATIO` /
`OI_NOT_RISING_THRESHOLD_PCT`). **No strategy/const change in M43.**

### Acceptance criteria (D3)

- **E0:** a work-log note quantifies the post-D1 residual dead-time-stop count by flow type, on a window with
  `from` ≥ the D1 change (or the v2-fallback) deploy.
- **E1:** if a future milestone is warranted, a one-paragraph proposal stub is filed (queue, not built). No
  time-stop / ATR / sigma constant is changed in M43.

---

## Cross-cutting non-goals (explicit)

- **Do not tune ATR / sigma / time-stop minutes on n=27** (analysis §5 lines 293–295). The only geometric
  change permitted is D2's **tier-aware long-side TP anchor**, justified by breakeven algebra (sample-size
  robust), not by a fitted parameter.
- **Do not promote v3 before B5 closes**, and **never on selectivity alone** (analysis §5 lines 296–298).
  Promotion requires the §D1 (c) evidence threshold; a populated-but-all-`force_close` shadow series fails it.
- **Do not backfill degenerate / legacy hollow shadow rows** to fake B5 (M40 non-goal carried forward); the
  D1 comparison window `from` must be ≥ the M40+M42 restart timestamp.
- **Do not widen tier exposure** — tier2 is −31.05 in-window; the locked policy is tier-1-only live (§5 line
  299). D2 stays tier-aware and must not silently re-enable tier2 TPs.
- **Do not weaken the `tp_below_cost` gate** — it is working (§4.1③). The TP anchor stops *producing*
  sub-cost TPs; the gate stays the backstop.
- **Do not rebase the structural SL** (ADR 0045 §D1) — the VWAP one-R budget is preserved; D2 moves the TP,
  not the SL.
- **Do not declare the strategy "broken"** — `trend_initiation` + tier1 is profitable; the fix is subtractive
  (route out `catalyst_risk`) + geometric (long RR), not a rebuild (§5 lines 300–302).
- **Do not change direction/sizing in any path** — D1's routing and fallback are purely subtractive (OPEN →
  SKIP), never a direction flip.
- **Do not add a daily-profit-target** — `skip` is the expected outcome; D1 *increases* skips by design
  (`docs/plans/00-overview.md` locked decisions).

## ADRs

- **ADR 0019 amendment (D1, required if v3 is promoted on soak data):** record the **interim
  soak-comparison evidence threshold** (§D1 (c) 1–4) as an explicit, time-boxed exception to ADR 0019's
  backtest-fold gate (criterion 6: ≥200 trades / ≥30 days). State *why* the formal gate is unreachable on
  live soak, *what* narrower structural justification permits the promotion (the §4.1② proven-dead
  `catalyst_risk` bucket), and that the next full ADR 0019 backtest gate still applies for any *general*
  promotion. Architect writes this **before** the promotion step runs.
- **ADR 0003 amendment (D1, on promotion):** note the active-version change v2 → v3 and that v3's routing
  (`catalyst_risk → skip`, `forced_exhaustion → mean-reversion`) is now the live behavior, with the soak
  evidence pointer. (ADR 0003 §4 already documents v3 as the hybrid router — this records the version flip
  and its evidence, not a design change.)
- **ADR 0045 — referenced, not amended (D2):** D2 must conform to §D1 (SL never rebased; `atrDistance`
  computed once, consumed verbatim). An ADR 0045 touch is needed **only** if the TP anchor changes the
  rebase contract shape (e.g. a `max(atr×k, floor)` value flowing through `atrDistance`) — architect decides
  after D2.0. A pure constant/multiplier change does not need an ADR.
- **No ADR for D3** (investigation only) and **no new shared-contract type** unless D2's cost floor must be
  shared with the gate (route via `bot-shared-maintainer`; architect call).

## Dispatch waves

D2 ships first (no B5 dependency); D1 is investigation-led and B5-gated. Keep each wave ≤5 items/files
(`dev-qa-cycle.md`).

1. **Serial (architect):** adjudicate (a) the D2 geometric lever + whether ADR 0045 needs a touch (after
   D2.0); (b) the ADR 0019 interim-threshold amendment + ADR 0003 version-flip note (drafted now, finalized
   at promotion); (c) whether D1 takes the v3-promotion or v2-fallback path. Architect on every contract
   touch.
2. **Serial (engine, investigation ONLY — no fix code):**
   - **D2.0** — confirm per-tier realized long RR + exact cost floor against the soak DB; reconcile the
     §4.1③ 1.5× reconstruction vs live 2.0×.
   - **D5 / B5 status** — confirm whether v3 emits non-null shadow fills post-restart; wire v3 shadow opens
     into the fill simulator if still in the *missing-fill* mode (the §4.1① sub-task). Record B5 status.
3. **Parallel (engine, fixes):**
   - **D2** — `momentumCore.buildMomentumExit` tier-aware TP anchor + const (≤5 files w/ specs).
   - **D5** — fill-simulator wiring fix (if step 2 found v3 still emits zero fills) + specs.
   Sequenced per the ≤5-file rule; D2 and D5 are independent and can run together.
4. **B5-GATE CHECKPOINT (operator + scribe, between waves):** verify B5 (A0) on ≥1 post-restart soak day.
   **Only if B5 closes** does D1 step (b)/(c) proceed (the `compareVersions` run + conditional promotion).
   If B5 does not close in-window → D1 routes to the v2 fallback (a new ≤5-file engine wave) or defers,
   recorded in the work-log.
5. **Serial (QA, adversarial):** paired tests per item — D2 B0–B7 (incl. SL-never-rebased invariant,
   tier1/tier2 floor fixtures, M38 rebase parity), D1 A1–A6 (incl. v3-fill non-null, paired post-restart
   comparison, promote-only-on-threshold, no-promote-on-fail, fallback subtractive-equivalence + parity).
   Failing adversarial tests route to the **architect**, not back to the developer.
6. **Parallel (reviewers):** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   `bot-review-quant`. **Quant owns the D1 evidence-threshold rigor** (paired comparison, mechanism
   attribution, B5 non-degeneracy) and the **D2 RR/cost-floor math**. Cycle until zero blockers, zero highs,
   majority of mediums resolved; reviewer continuity across rounds.
7. **Serial (scribe):** work-log + STATUS (B5 status, D2 shipped, D1 outcome) + milestone-log (M43 forensics:
   evidence threshold, B5-gate timeline, promote/fallback/defer decision) + ADR index (0019/0003 amendments
   if promotion fired). Single writer.

## Post-deploy verification (operator + scribe)

- **D2:** on the next post-deploy soak day, confirm long-side realized RR has risen toward the target and
  the tier2 `tp_below_cost` reject rate is unchanged-or-lower (the gate still firing, not bypassed). RR is a
  *directional* check on a fresh window, not a locked number.
- **D1 (if v3 promoted):** confirm at boot the engine reads v3 as `active` (`findActive`); confirm
  `catalyst_risk` events now stamp `FLOW_ROUTED_SKIP` and the dead `catalyst_risk` time-stop bucket
  collapses on the next soak day. Feeds D3's residual investigation.
- **D1 (if fallback):** confirm v2 emits `FLOW_ROUTED_SKIP` on `catalyst_risk` and still opens
  `trend_initiation`.
- **B5:** confirm v3's `simulated_fill` is non-null with a non-degenerate `close_reason` distribution over
  ≥1 full post-restart soak day (the gate that licensed D1).
