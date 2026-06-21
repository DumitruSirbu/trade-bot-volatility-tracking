# M43 — Strategy selectivity (flow-routing) + long-book reward:risk geometry

> **Sequencing note:** M43 is a **strategy-edge** milestone surfaced by the 2026-06-21 24h paper-soak
> trade analysis (`docs/wip/2026-06-21-vwap-edge-24h-soak-analysis.md`; quant + logic reviewers passed,
> two HIGH corrections applied). It is **not** a safety hotfix and **not** a go-live milestone (M15 keeps
> that slot). Every `CLAUDE.md` trading-safety invariant holds: no order path bypasses the risk gate, the
> strategy stays pure/deterministic so backtest reproduces live, money stays `decimal`, no LLM in the live
> loop, and the flow-route change is **subtractive** (route a losing flow class to `skip`) — it can only
> reduce risk-taking, never increase it.
>
> **Scope correction (post-review).** The original spec described promoting v3 as the active version via
> `pnpm engine strategy promote …`. That path **cannot execute**: the engine resolves the active strategy by
> the `ACTIVE_STRATEGY_VERSION_ID` env-var primary key (`StrategyService.ts:110-111`, not by `status`);
> `PromotionService.promote` rejects any non-`draft` candidate (`PromotionService.ts:181-183`) and v3 is a
> **shadow** row; and `PromotionGateService.evaluate` runs only the 12-criterion OOS-backtest gate
> (`PromotionGateService.ts:61-97`) with no soak-data path. M43 therefore **ships the v2 direct fallback
> (D1a)** — add `catalyst_risk → skip` to the active v2 momentum path — and **defers v3 promotion (D1b)** to a
> separate milestone once the engine has a soak-promotion mechanism. D1a does **not** depend on B5; the
> geometry item (D2), the selectivity investigation (D3), and D1a all ship without B5. B5 (the shadow-fill
> timing gap, D5) is now a **fidelity improvement that unblocks the eventual D1b**, not an M43 gate.

> **Sample-size discipline (governs the whole milestone).** The soak window is **n=27 closed v2 trades,
> single regime, no held-out sub-period** (analysis §intro, line 14; §4.1 window note, lines 228–232). The
> analysis is **directional, not conclusive** (line 16). M43 therefore ships only the changes whose
> justification is **robust to sample size** — RR geometry (breakeven algebra, not a fitted parameter) and
> flow-routing (a 14-trade, −39 USDT structural signal that matches the strategy's known design gap). It
> **does not** re-tune ATR/sigma/time-stop on n=27 (§5, lines 293–295). See cross-cutting non-goals.

## Findings → scope decision (at a glance)

| # | Finding (analysis ref) | Severity | M43 scope |
|---|------------------------|----------|-----------|
| D1 | `catalyst_risk` mis-route: v2 follows catalyst-driven spikes as if they were trends; 14/27 trades, **−39.29 USDT**, 0/14 ever reached the TP band, MAE ~4× MFE (§flow-split lines 63–75; §4.1② lines 249–264). `forced_exhaustion` is a **second mis-route in the same family** — v2 *follows* 4 trades the design says to *fade* (§2.1 lines 150–154). v3 (hybrid router) already routes `catalyst_risk → skip` and `forced_exhaustion → mean-reversion` (`V3HybridRouterStrategy.ts:11,14,26`). | **HIGH (structural)** | **D1 — SPLIT into two independent paths (see §D1 scope decision).** **D1a (the shipping path): v2 direct fallback** — add `catalyst_risk → skip` to v2's momentum entry (the proven −39 USDT bucket), gated only on a recomputed paired floor, NOT on v3 promotion. **D1b (v3 promotion) is DEFERRED out of M43** — the engine's promotion path (`PromotionService.promote` requires `status='draft'`; `PromotionGateService` runs only the 12-criterion OOS-backtest gate; the engine resolves the active strategy by `ACTIVE_STRATEGY_VERSION_ID` env-var PK, not by `status`) has **no soak-data promotion mechanism**, so v3 promotion cannot execute as M43 originally described. v3 promotion (which intentionally also flips direction on `forced_exhaustion`) requires its own milestone once the engine gains a soak-promotion path. |
| D2 | Long-book reward:risk inverted: ATR TP ~0.9–1.6% vs VWAP structural SL ~2.5–3.4% → RR ≈ 0.5–0.6 on longs (shorts ≈1.0). 9 `tp_below_cost` gate rejects, **all 9 tier2** — the 2× tier2 slippage (0.50%) alone exceeds the entire ATR TP distance (§SL/TP lines 99–119; §Q2 lines 187–193; §4.1③ lines 266–282). | **HIGH (structural)** | **D2 — IN, ships first (no B5 dependency).** Tier-aware long-book RR repair. **Investigation-first** (D2.0) to size the exact gap, then the smallest geometric change that lifts long-side RR toward ≥ ~1.4 **without** rebasing the structural SL (ADR 0045 §D1 line 52) and **without** weakening the `tp_below_cost` gate (which is working). |
| D3 | Time-stop dead signals: 17/27 exits at the 15-min time-stop with +0.3% MFE — non-events, weak entries (§exit-dist lines 43–58; §3 lines 207–210). Analysis: this is a **selectivity** problem, not a stop/TP tuning problem. | **MEDIUM** | **D3 — INVESTIGATION ONLY (no code in M43).** D1's flow-route removes the dominant dead bucket (`catalyst_risk` = 11 of the 17 time-stops). Quantify the residual after D1, then decide a *future* milestone on `require_exhaustion_confirmation`. **Do not tune the time-stop.** |
| D4 | tier2 dollar drag (tier2 −31.05, tier2 longs −27.42); 9 `tp_below_cost` rejects all tier2 (§tier-split lines 78–87; §4.1③). | LOW (known) | **Out (reinforces policy).** Consistent with locked tier-1-only live start. No exposure change. D2's RR fix must be **tier-aware** so it does not silently re-enable tier2 TPs. |
| D5 | Shadow opens emit `simulated_fill: null` on the `!hasNextBarEntry` path — `evidence.nextBarOpenPrice === null`, i.e. **no signal-bar `tick_aggregates` at event time** (§cross-version lines 122–139; §4.1① lines 234–247). | **HIGH (improves B5 fidelity).** | **D5 = the M40 D2 unfinished residual** — the **signal-bar-tick timing gap** (M40 D2 §Fix mechanism (a)/(b), M40 archive lines 145–177). v3 is **already wired identically to v0/v1/v2** through the shared `runOneShadow → shouldSimulateFill → simulateShadowFill` path (`ShadowStrategyOrchestratorService.ts:245-247, 280-443`) — there is **no v3-specific wiring to add**. M40 chose the re-anchor fix (which fixed v1 wrong-side-of-stop censoring) but did **not** implement the timing fix for the `!hasNextBarEntry` path. **First action: confirm whether the post-M40 restart already reduced the `!hasNextBarEntry` rate** (the re-anchor may have unmasked the true count). If still material, the fix is a **bounded retry / backfill of signal-bar evidence**, shared across all versions (benefits v1/v2/v3 equally). |

---

## B5 — shadow-fill fidelity (the M40 D2 timing-gap residual; unblocks deferred D1b, not an M43 gate)

**Re-framing (post-review).** B5 is **not** a gate that orders M43. The shipping selectivity change (D1a, v2
direct fallback) does not consume the shadow PnL series. B5 matters only for the **deferred** v3-promotion
work (D1b) and as a general fidelity improvement to the shadow comparison surface. M43 advances B5 because the
work is cheap and shared, but **no M43 deliverable blocks on B5 closing.**

**B5 is the M40 D2 acceptance criterion** (M40 archive lines 145–177, 226–233): after deploy,
`shadow_decisions` shows non-zero `simulated_fill` for gate-allowed opens **over ≥1 full soak day** AND the
`close_reason` distribution among populated fills is **non-degenerate**. "Non-degenerate" is now pinned
numerically (per reviewer H3/Q1): the populated, non-null fill count must be **≥ `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN`
(30)** (`packages/shared/src/const/comparisonConsts.ts`) AND the `force_close` fraction must be **≤
`MAX_FORCE_CLOSE_FRACTION` (0.5)** — not a qualitative "non-trivial fraction." The window `from` must be **≥
the engine-restart timestamp**.

> **Restart status (post-review).** The engine **has been restarted** since M40 merged (STATUS.md's "restart
> required" line predates the actual restart). The B5 window therefore starts at the timestamp of that
> restart — the operator must **record that exact timestamp** in the work-log; all B5 / D5 counts use
> `from ≥ <recorded restart ts>` (M40 B6 window discipline; degenerate pre-restart rows excluded).

**B5 closes when ALL of the following hold (operator + scribe record; not a precondition for any M43 ship):**

1. **Shadow opens emit non-null `simulated_fill`** on the previously-NULL `!hasNextBarEntry` path — the
   signal-bar-tick timing gap (D5) is fixed for the **shared** orchestrator path (all versions). This is the
   **D5 carry-over**, not v3-specific wiring.
2. The populated fills show a **non-degenerate `close_reason` distribution**: `force_close` fraction ≤
   `MAX_FORCE_CLOSE_FRACTION` (0.5) — i.e. the deferred-walk **upgrade** is landing for the shadow series, not
   just the synchronous W1 write (M40 B5 / `:522-530`).
3. Non-null fill count ≥ `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` (30) over **≥1 full soak day** strictly
   **after** the recorded restart timestamp.

> **D5 first action = a measurement, not a fix.** Before writing any fill-simulator change, confirm on the
> soak DB whether the post-restart `!hasNextBarEntry` rate is still material (the M40 re-anchor fixed v1
> wrong-side-of-stop censoring and may have unmasked the true count of timing-gap misses). Only if the rate is
> still material does the bounded-retry / signal-bar-evidence-backfill fix land. **Do not backfill degenerate
> rows** to fake B5 (M40 non-goal; M43 non-goal below).

---

## D1 (HIGH, structural) — Route `catalyst_risk` to skip. **Ships as the v2 direct fallback (D1a); v3 promotion (D1b) is deferred.**

> **Scope decision (post-review B1).** The original spec promoted v3 as the active version. That path cannot
> execute against the current engine:
> - The engine resolves the active strategy by `ACTIVE_STRATEGY_VERSION_ID` env-var **primary key**
>   (`StrategyService.ts:110-111`; ADR 0003 §7; `20260708000004-PromoteMomentumStrategyVersionActive.ts:6`),
>   **not** by `status`. Flipping `status` to active leaves the engine on v2 after restart unless the env var
>   also changes.
> - `PromotionService.promote` requires `candidate.status === 'draft'` (`PromotionService.ts:181-183`). v3 is a
>   **shadow** row, so `promote(v3)` throws `PromotionStateException`.
> - `PromotionGateService.evaluate` runs the full **12-criterion OOS-backtest gate**
>   (`PromotionGateService.ts:61-97`) with no soak-data path. The §D1b soak criteria 1–4 cannot be enforced
>   by it.
>
> **Therefore M43 ships D1a (the v2 direct `catalyst_risk → skip` fallback) as the primary path**, gated only
> on a recomputed paired-event floor (below), **not** on v3 promotion or B5. **D1b (v3 promotion) is deferred
> out of M43**: it needs a new, code-level promotion pathway (env-var flip + a documented env-change mechanism,
> *or* a soak-data variant of the gate), which is **engine work with its own ADR entry and acceptance test**,
> plus B5 closed. D1b also **intentionally flips direction** on `forced_exhaustion` (v3 fades where v2 follows
> — `V3HybridRouterStrategy.ts:26-27`, ADR 0003 line 186 marks it "fade-able"), so it cannot ship under M43's
> "subtractive only" envelope. M43 records the D1b prerequisites and queues it; it does **not** attempt the
> operator `promote` commands (they would throw).

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
*directional design-conformance* fix (a direction flip, not a skip), not a PnL-proven one — which is exactly
why it belongs to **deferred D1b** (v3 already routes it correctly via the mean-reversion core) and is
**explicitly excluded from D1a**: D1a is subtractive-only and handles `catalyst_risk → skip` exclusively. The
`forced_exhaustion` fade waits for the v3-promotion milestone.

### D1a (SHIPS) — add `catalyst_risk → skip` to v2 directly

Scope a **minimal additive skip** in the active v2 momentum path: when the orchestrator-stamped
`flow_type === catalyst_risk`, v2 emits `SKIP` with `FLOW_ROUTED_SKIP` **before** building a momentum signal.
Constraints:

- **Routing reads the orchestrator-stamped `flow_type`** (ADR 0003 §4 lines 205–212) — v2 must **not**
  re-classify (single-source-of-truth; M8 comparability).
- **Subtractive only** — this can only turn an OPEN into a SKIP; it never changes direction, sizing, or
  exits. It is the v3 `catalyst_risk` branch transplanted into v2, nothing more.
- **`forced_exhaustion` is NOT added to v2** — fading requires the mean-reversion core, which is a direction
  change, not a skip; that belongs to v3 (D1b) only. D1a handles `catalyst_risk → skip` exclusively (the −39
  USDT bucket).
- This is a **strategy-behavior change to the active version** — it needs paired backtest parity (live ==
  backtest) tests, not just unit tests, because v2 also runs in the backtest harness.

#### The paired-event floor that licenses D1a

D1a is justified by the §4.1② path statistic — **0/14 `catalyst_risk` trades reached the TP band, MAE ≈4×
MFE** — which is structural and **independent of where SL/TP sit** (lines 258–264), not a fitted PnL edge. The
shipping condition is therefore a **sample-size sanity floor on the routed bucket itself**, not a v2↔v3
comparison:

1. The `catalyst_risk` bucket on the soak window (`from` ≥ recorded restart timestamp) holds **≥
   `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` (30)** closed, force-close-excluded events, **or** the operator
   explicitly signs off in the work-log that the original §4.1② n=14 window remains the decisive evidence and
   the structural path-statistic (0/14 TP, MAE≈4×MFE) is unchanged in the extended window.
2. The bucket's directional signal is **unchanged in sign** in the extended window (still net-negative with no
   TP reach) — recompute and record. If the extended window contradicts §4.1② (the bucket turns net-positive
   with TP reaches), **do not ship D1a**; re-investigate.

This floor is **evaluated and recorded in a `compareVersions` / `compareVersions`-style analysis artefact or a
documented operator sign-off in the work-log** (per reviewer H1) — there is no harness surface that enforces
soak criteria, so the record is the executable surface.

### D1b (DEFERRED) — v3 promotion prerequisites (queued, not built in M43)

v3 already encodes both routes (`catalyst_risk → skip`, `forced_exhaustion → mean-reversion`) and is the
correct long-term home for the fix, but promotion is **out of M43 scope**. Before a future milestone can
promote v3 it must build, with its own ADR entry and acceptance test:

- **A soak-data promotion pathway.** The current `promote`/`PromotionGateService` accepts only `draft`
  candidates and only the 12-criterion OOS-backtest gate. A new path is required — either a documented
  **env-var flip mechanism** (change `ACTIVE_STRATEGY_VERSION_ID` to v3 + restart, with an auditable
  env-change record) or a **soak-data variant of the gate** that evaluates the criteria below. This is engine
  work, not an operator command. **The "no source change / `pnpm engine strategy promote …` works today"
  claim is removed** — those commands throw against the current code.

- **B5 closed** — v3's realized shadow series is non-degenerate (non-null fills, `force_close` fraction ≤
  `MAX_FORCE_CLOSE_FRACTION`, count ≥ `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN`). A populated-but-all-`force_close`
  series fails (M40 B5).

- **The soak-comparison evidence threshold** (an explicit, time-boxed exception to ADR 0019's backtest-fold
  gate; see §ADRs). v3 is promoted only if **every** one of these holds on the post-restart shadow window:

  1. **B5 closed** (above).
  2. **The paired-bootstrap CI on ΔPnL (v3 − v2) excludes zero**, consistent with ADR 0019 criterion 5 and
     `compareVersions` behavior — **not** a bare `v3 ≥ v2` point estimate. (At n≈27 the per-trade PnL SD ≈4.2
     USDT gives SE(mean Δ) ≈ 0.81 USDT/trade, so a strict point inequality promotes on noise.) The comparison
     is **paired on `event_id`**, never two independent aggregates.
  3. **The win is mechanism-attributable, not noise.** Partition the shared `event_id` set into
     **{routed buckets: `catalyst_risk` + `forced_exhaustion`}** vs **{non-routed: `trend_initiation`}** and
     compute paired ΔPnL within each partition. Require **(a)** ΔPnL_routed > 0 and accounting for the
     majority of total ΔPnL, reproducing §4.1②'s flow-split; **(b)** ΔPnL_non-routed ≈ 0 — since v3 and v2 run
     identical momentum on `trend_initiation`, any material non-routed delta signals a **fill-sim artefact**,
     not edge, and **fails** the criterion.
  4. **Minimum paired-event count.** The routed-bucket paired, force-close-excluded event count is **≥
     `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` (30)** — below this, `compareVersions` suppresses `meanPnlDeltaUsd`
     (`belowSampleFloor: true`) so criterion 2 is mechanically uncomputable. At the analysis fill pace
     (≈26–27 closed/24h), reaching **30 paired (both-traded), force-close-excluded** events takes **≈1.2–1.3
     soak days**, not 1.0 — budget accordingly. This is a **soak floor**, explicitly weaker than ADR 0019
     criterion 6 and documented as such.

  If criterion 1 fails → B5 not closed → do not run the comparison. If 2–4 fail → do not promote. **Promotion
  on selectivity alone is forbidden** (analysis §5).

> **Why D1a ships and D1b waits.** D1a removes the proven −39 USDT bleed today with a one-branch subtractive
> change to v2. D1b is the cleaner long-term design (it also fixes `forced_exhaustion` by *fading*, a direction
> flip) but needs a promotion mechanism the engine does not yet have, plus B5. Shipping D1a now does not block
> D1b later — when D1b lands, the v2 `catalyst_risk → skip` branch becomes redundant with v3's router and can
> be removed.

### Files (indicative; ≤5 per dispatch — split across waves)

**D1a (SHIPS) — v2 direct `catalyst_risk → skip`:**
1. `apps/engine/src/strategy/strategies/momentumCore.ts` (or the v2 entry seam) — pre-signal
   `catalyst_risk → SKIP` branch reading the orchestrator-stamped `flow_type`; + paired backtest-parity specs.

**D5 (SHARED fidelity fix; benefits all versions; only if the measurement step finds the timing gap still
material):**
2. `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` — bounded retry / signal-bar
   evidence backfill on the `!hasNextBarEntry` path (the M40 D2 §Fix mechanism (a)/(b) remedy). **Not** a
   v3-specific change — v3 is already wired identically to v0/v1/v2 (`:245-247, 280-443`).
3. Paired specs under `strategy/service/__tests__/`.

> **No operator `promote`/`compare` commands in M43.** v3 promotion (D1b) is deferred; the original
> `pnpm engine strategy promote …` path throws against the current engine and is removed from M43 scope.

### Acceptance criteria (D1)

**D1a (the shipping path):**

- **A1a (subtractive equivalence + parity):** the v2 `catalyst_risk → SKIP` branch (a) reads the
  **orchestrator-stamped** `flow_type`, never re-classifies; (b) emits `FLOW_ROUTED_SKIP`; (c) is **purely
  subtractive** — a `trend_initiation` event is unaffected (still opens), only `catalyst_risk` flips to skip;
  (d) **live == backtest** for the same event (parity test), since v2 runs in the harness. `forced_exhaustion`
  remains a *follow* in v2 (NOT faded) — asserted, so D1a's scope is explicit.
- **A2a (paired-event floor recorded):** before D1a ships, the work-log records — via a `compareVersions`-style
  analysis artefact or a documented operator sign-off (per reviewer H1; there is no harness surface) — that the
  `catalyst_risk` bucket on `from ≥ recorded restart ts` meets the §D1a floor (≥30 force-close-excluded events
  **or** signed-off n=14 §4.1② decisiveness) **and** the bucket's net-negative / no-TP-reach sign is unchanged.
- **A3a (determinism + decimal):** the routing decision is pure — no `Date.now()`/`Math.random()`/I/O; depends
  only on the stamped `flow_type` and event fields; reproducible live == backtest.

**D5 (shared fidelity, ships if the timing gap is still material):**

- **A4 (timing-gap measured first):** the work-log records the post-restart `!hasNextBarEntry` rate on
  `shadow_decisions` (`from ≥ recorded restart ts`). The D5 fill-simulator change lands **only if** that rate
  is still material; otherwise D5 is recorded as already-resolved-by-restart and no code lands.
- **A5 (non-null fill, no fabrication):** if the fix lands, a shadow OPEN whose signal-bar ticks land (after
  the bounded retry / backfill) produces a **non-null `simulated_fill`** — asserted against the orchestrator
  path. A genuinely tick-less bar still produces a conservative miss, **never** a fabricated fill (mirror M40
  B2). The fix is shared (no per-version branch).

**D1b (deferred — recorded, not asserted in M43):**

- **A6 (D1b prerequisites queued):** the spec / ADR records the D1b prerequisites — a soak-data promotion
  pathway (engine work, own ADR + acceptance test), B5 closed, and the §D1b soak-comparison threshold
  (paired-CI-excludes-zero, mechanism-attribution partition, ≥30 paired floor). M43 files **no** operator
  `promote`/`compare` commands and makes **no** assertion that they execute. v3 promotion is queued for a
  future milestone.

---

## D2 (HIGH, structural, ships first) — Long-book tier-aware reward:risk repair

### Root cause (confirmed by analysis + code read)

v2's stop is the **VWAP structural stop** (`stopLossPrice: new Money(event.vwapSession)`,
`momentumCore.ts:48`, `StopTypeEnum.STRUCTURAL`); the take-profit is the **ATR leg**
(`referencePrice ± atr14 × MOMENTUM_TAKE_PROFIT_ATR_MULTIPLIER`, multiplier = **2.0**,
`momentumCore.ts:42–43`, `strategyConsts.ts:45`). In-window the realized geometry is wide-stop / tight-target
on longs: SL ~2.5–3.4% out, ATR TP ~0.9–1.6% out → **RR ≈ 0.5–0.6 on longs, ≈1.0 on shorts** (§SL/TP lines
108–119). The asymmetry is **long-specific** because the VWAP stop on a long sits *below* entry by the full
session-deviation distance, while on a short the VWAP stop sits much closer.

> **The RR floor is a placeholder, not a fitted target (per reviewer Q3).** "RR ≥ ~1.4" is derived from the
> **full-book 42.3% win rate** (breakeven RR ≈ 1.36). It is **stale for the as-shipped book** in two ways: on
> the n=27 window (one extra `catalyst_risk` loss) the win rate is 11/27 = 40.7% → breakeven 1.46 (so 1.4 is
> *below* breakeven there); and **after D1a routes `catalyst_risk` out**, the surviving book's win rate
> **rises** (`trend_initiation` is 50%), which **lowers** the required RR. **D2.0 / B0 must recompute the RR
> floor from the post-route win-rate estimate** (after `catalyst_risk` is excluded). Do not hard-code 1.4 as
> the breakeven for the as-shipped book — it is a starting anchor only.

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
> sizing the fix. **Direction of error (per reviewer Q6):** the 1.5× reconstruction *understated* the TP. At
> the live 2.0× the intended TPs are **~33% larger**, which **narrows** the tier2 shortfall the analysis
> reported. B0 must recompute the tier2 shortfall at the live 2.0× explicitly — the gap may be smaller than
> §4.1③ suggests.

D2.0 (engine specialist, against the soak DB) must, before any geometry change:
- (a) Confirm the **realized** long-side RR distribution (VWAP-SL distance vs ATR-TP distance) per tier from
  `positions`, separating tier1 from tier2, so the fix is sized on real fills not reconstructions.
- (b) Confirm the **exact** tier1 vs tier2 cost floor (round-trip fee + per-tier slippage consts) from the
  actual config — the §4.1③ 0.09% fee is an estimate (line 282).
- (c) Decide the **minimal geometric lever** that lifts long RR toward the **recomputed post-route floor**
  (§root-cause; not a hard-coded 1.4): candidates, in preference order — (i) a **long-side-conditional TP
  anchor** `TP = entry + max(atr14 × k, cost_floor + margin)` (LONG only) so the long TP is never placed below
  a cost-aware floor (analysis §3.2 line 206: "anchor TP to `cost + k·ATR`, not a fixed fraction"); (ii) raise
  the long-side ATR multiplier; (iii) tighten the VWAP SL. The architect adjudicates; **(iii) is disfavored**
  because it touches the structural stop (see invariant below).
  > **The lever must be long-side-conditional (per reviewer Q7).** `momentumCore.ts:42-43` computes a single
  > `atrTarget` *before* the `tradeSide` branch and uses it for both sides. A **global** change to that
  > distance would alter shorts (currently ≈1.0 RR, no fix needed). The fix **must branch on
  > `tradeSide === LONG`** (floor/lift the long anchor only); a global `atrTarget`/`atrDistance` change is
  > **forbidden**. The short-side distance must be byte-for-byte unchanged.
- (d) **Characterize the TP-anchor behavior at ATR extremes** (per reviewer M1): at **high ATR** the `atr×k`
  leg dominates → a very distant TP that may be unreachable and recreates the time-stop bucket; at **low ATR**
  the `cost_floor + margin` leg dominates → a near-constant TP decoupled from price action. Record both regimes
  in the brief and pin fixtures at each extreme (asserted in B8 below). If either extreme produces a
  pathological TP, the brief must state the chosen bound (e.g. cap the floor leg, or accept the high-ATR
  time-stop as designed).
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
  exact per-tier cost floor, with the discriminating query; reconciles the §4.1③ reconstruction (1.5×) against
  the live `2.0×` multiplier **and recomputes the tier2 shortfall at 2.0×** (the live TP is ~33% larger, may
  narrow the gap); and **recomputes the RR floor from the post-route (catalyst_risk-excluded) win-rate
  estimate** — the floor is derived, not the hard-coded 1.4. No fix code lands before B0.
- **B1 (long RR lifted):** for a representative long signal, the proposed TP distance relative to the VWAP
  structural SL distance yields RR ≥ the **B0-recomputed post-route floor** (anchored on ~1.4 but pinned in the
  brief) — asserted on the **proposed geometry** (a strategy-layer unit test on `buildMomentumExit`), not on
  realized fills (which need a fresh soak to confirm). Shorts are **unchanged** (already ≈1.0) — asserted.
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
- **B5g (gate not weakened):** the `tp_below_cost` gate logic is unchanged and still rejects any sub-cost TP
  that reaches it. Asserted (regression). *(Renamed from "B5" to avoid collision with the milestone-level B5
  shadow-fill item.)*
- **B6 (determinism + decimal):** the TP math is pure, decimal-only (`Money`), no `Date.now()`/`Math.random()`,
  reproducible live == backtest.
- **B7 (long-side-conditional, not global):** the TP-anchor fix branches on `tradeSide === LONG`. The
  **short-side `atrTarget`/`atrDistance` is byte-for-byte unchanged** — asserted directly (a short fixture's TP
  distance equals the pre-fix value exactly), not merely "shorts ≈1.0." A global multiplier/constant change
  that touches both sides is **forbidden** (§4.1③ line 281; would re-admit tier2 TPs the gate is right to
  reject). Asserted via the tier1/tier2 fixtures of B3 plus a short-side fixture.
- **B8 (ATR-extreme behavior characterized):** assertions at a **high-ATR** fixture (the `atr×k` leg dominates)
  and a **low-ATR** fixture (the `cost_floor + margin` leg dominates) confirm the TP behaves per the D2.0(d)
  characterization — no pathological/unbounded TP beyond the bound the brief chose, and the low-ATR floor leg
  does not silently re-enable a sub-cost tier2 TP.

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
- **Do not attempt v3 promotion in M43.** D1b is deferred — the engine has no soak-data promotion path
  (`promote` requires `draft`; the gate is OOS-backtest-only; the engine resolves active by env-var PK). When a
  future milestone does promote v3, it must clear the §D1b threshold and **never** promote on selectivity alone
  (analysis §5 lines 296–298); a populated-but-all-`force_close` shadow series fails B5.
- **Do not backfill degenerate / legacy hollow shadow rows** to fake B5 (M40 non-goal carried forward); any
  shadow-comparison window `from` must be ≥ the recorded engine-restart timestamp.
- **Do not widen tier exposure** — tier2 is −31.05 in-window; the locked policy is tier-1-only live (§5 line
  299). D2 stays tier-aware and must not silently re-enable tier2 TPs.
- **Do not weaken the `tp_below_cost` gate** — it is working (§4.1③). The TP anchor stops *producing*
  sub-cost TPs; the gate stays the backstop.
- **Do not rebase the structural SL** (ADR 0045 §D1) — the VWAP one-R budget is preserved; D2 moves the TP,
  not the SL.
- **Do not declare the strategy "broken"** — `trend_initiation` + tier1 is profitable; the fix is subtractive
  (route out `catalyst_risk`) + geometric (long RR), not a rebuild (§5 lines 300–302).
- **Do not change direction or sizing in the M43-shipping paths (D1a + D2).** D1a's routing is purely
  subtractive (OPEN → SKIP), never a direction flip; D2 moves the long TP only and never changes sizing.
  *(Carve-out per reviewer H2: the **deferred** D1b v3 promotion **intentionally** flips direction on
  `forced_exhaustion` — v3 fades [SHORT] where v2 follows [LONG], per ADR 0003 line 186 "fade-able". That
  direction change is design-correct and is precisely why D1b cannot ship under M43's subtractive envelope and
  is queued separately.)*
- **Do not add a daily-profit-target** — `skip` is the expected outcome; D1a *increases* skips by design
  (`docs/plans/00-overview.md` locked decisions).

## ADRs

- **D1a (the shipping path) needs no new ADR.** It is a subtractive `catalyst_risk → SKIP` branch in the
  already-active v2 strategy, reading the orchestrator-stamped `flow_type` (ADR 0003 §4 already documents flow
  stamping). No promotion, no version flip, no direction change. The change is recorded in the work-log +
  milestone-log only.
- **ADR for D1b (DEFERRED — written by the future milestone, drafted/queued by M43):** v3 promotion requires
  (a) an ADR for the **new soak-data promotion pathway** (the engine cannot promote a shadow row on soak data
  today — `promote` requires `draft`, the gate is OOS-backtest-only, the engine resolves active by env-var PK);
  this ADR must define the mechanism (env-var flip + auditable env-change record, or a soak-gate variant) and
  its acceptance test. (b) an **ADR 0019 amendment** recording the §D1b interim soak-comparison threshold
  (paired-CI-excludes-zero, mechanism-attribution partition, ≥30 paired floor) as an explicit, time-boxed
  exception to criterion 6 (≥200 trades / ≥30 days), stating why the formal gate is unreachable on live soak
  and that it still applies for any *general* promotion. (c) an **ADR 0003 amendment** noting the v2 → v3
  active-version change and that v3's routing (`catalyst_risk → skip`, `forced_exhaustion → mean-reversion`,
  including the `forced_exhaustion` **direction flip**) becomes live behavior. **M43 does not write these
  amendments** — it records them as D1b prerequisites in the milestone-log queue.
- **ADR 0045 — referenced, not amended (D2):** D2 must conform to §D1 (SL never rebased; `atrDistance`
  computed once, consumed verbatim). An ADR 0045 touch is needed **only** if the TP anchor changes the
  rebase contract shape (e.g. a `max(atr×k, floor)` value flowing through `atrDistance`) — architect decides
  after D2.0. A pure constant/multiplier change does not need an ADR.
- **No ADR for D3** (investigation only) and **no new shared-contract type** unless D2's cost floor must be
  shared with the gate (route via `bot-shared-maintainer`; architect call).

## Dispatch waves

D1a (v2 `catalyst_risk → skip`) and D2 (long-RR repair) both **ship in M43** with no B5 dependency. D5 is a
shared fidelity fix that ships only if the measurement step finds the timing gap still material. D1b (v3
promotion) is **deferred** — recorded, not built. Keep each wave ≤5 items/files (`dev-qa-cycle.md`).

1. **Serial (architect):** adjudicate (a) the D2 geometric lever (long-side-conditional anchor) + whether ADR
   0045 needs a touch (after D2.0); (b) confirm D1a is the shipping path and **record the D1b deferral + its
   ADR prerequisites** (soak-promotion pathway ADR, ADR 0019 amendment, ADR 0003 amendment) in the
   milestone-log queue — **none written in M43**; (c) confirm the D1a paired-event floor decision (≥30
   force-close-excluded **or** signed-off n=14). Architect on every contract touch.
2. **Serial (engine, investigation ONLY — no fix code):**
   - **D2.0** — confirm per-tier realized long RR + exact cost floor against the soak DB; reconcile the §4.1③
     1.5× reconstruction vs live 2.0× and recompute the shortfall at 2.0×; recompute the RR floor from the
     post-route win rate; characterize ATR-extreme TP behavior.
   - **D1a floor** — recompute the `catalyst_risk` bucket on `from ≥ recorded restart ts`; record the floor
     decision + the unchanged net-negative/no-TP-reach sign in the work-log.
   - **D5 measurement** — confirm whether the post-restart `!hasNextBarEntry` rate is still material on
     `shadow_decisions`. Record B5 status. **No v3-specific wiring** — v3 already routes through the shared
     path; the fix (if needed) is the M40 D2 §Fix mechanism (a)/(b) backfill on the shared orchestrator.
3. **Parallel (engine, fixes):**
   - **D1a** — `momentumCore` (or v2 entry seam) `catalyst_risk → SKIP` branch + paired backtest-parity specs.
   - **D2** — `momentumCore.buildMomentumExit` long-side-conditional TP anchor + const + specs.
   - **D5** — shared signal-bar-evidence backfill (only if step 2 found the gap still material) + specs.
   Sequenced per the ≤5-file rule; the three are independent.
4. **Serial (QA, adversarial):** paired tests per item — D2 B0–B8 (incl. SL-never-rebased invariant,
   tier1/tier2 floor fixtures, short-side byte-for-byte unchanged, ATR-extreme fixtures, M38 rebase parity);
   D1a A1a/A2a/A3a (subtractive-equivalence + parity, floor recorded, determinism); D5 A4/A5 (gap measured,
   non-null fill without fabrication). Failing adversarial tests route to the **architect**, not the developer.
5. **Parallel (reviewers):** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   `bot-review-quant`. **Quant owns** the D2 RR/cost-floor math and the D1a floor recompute (and reviews the
   recorded D1b threshold for when it is eventually built). Cycle until zero blockers, zero highs, majority of
   mediums resolved; reviewer continuity across rounds.
6. **Serial (scribe):** work-log + STATUS (D1a + D2 shipped, D5/B5 status, restart timestamp recorded) +
   milestone-log (M43 forensics: D1a floor decision, D2 lever, B5/D5 status, **D1b deferral + ADR
   prerequisites queued**) + ADR index. Single writer. **No 0019/0003 amendments in M43** (they belong to the
   deferred D1b milestone).

> **No B5-gate checkpoint in the M43 critical path.** B5 was the gate for the now-deferred v3 promotion; since
> D1a and D2 do not consume the shadow PnL series, M43 ships without waiting on B5. B5/D5 status is recorded for
> the future D1b milestone.

## Post-deploy verification (operator + scribe)

- **D2:** on the next post-deploy soak day, confirm long-side realized RR has risen toward the B0-recomputed
  floor and the tier2 `tp_below_cost` reject rate is unchanged-or-lower (the gate still firing, not bypassed).
  RR is a *directional* check on a fresh window, not a locked number.
- **D1a:** confirm v2 emits `FLOW_ROUTED_SKIP` on `catalyst_risk` and still opens `trend_initiation`; confirm
  the dead `catalyst_risk` time-stop bucket collapses on the next soak day. Feeds D3's residual investigation.
- **D5 / B5 (for the deferred D1b):** if the fix landed, confirm shadow `simulated_fill` is non-null with a
  `force_close` fraction ≤ `MAX_FORCE_CLOSE_FRACTION` and count ≥ `MIN_PAIRED_EVENTS_FOR_RELIABLE_MEAN` over ≥1
  full post-restart soak day. This unblocks (but does not trigger) the future D1b promotion milestone.
