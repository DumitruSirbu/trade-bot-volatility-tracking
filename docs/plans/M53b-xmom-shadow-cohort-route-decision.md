# M53b (DRAFT / WIP) — xmom TP-arm shadow cohort: route decision for measuring the R:R promotion

> **STATUS: WIP DRAFT — architect analysis for user review. NOT a finalized milestone plan or ADR
> amendment yet.** This is the durable write-up of the D2/D3 route decision that M53 deliberately
> deferred (M53 shipped D1 + D4 only). Once the user signs off on the recommended route, this becomes a
> real M53b milestone plan and the accepted call is folded into the ADR 0029 deferral note (currently at
> `0029-shadow-counterfactual-and-fill-simulator-pipeline.md` §"Deferral note — M53") and ADR 0047 §6.
>
> **Scope of this doc:** *how* we measure which arm ratio (1.5 / 1.8 / 2.0 / 2.5) is best during the
> current paper soak — not *whether* to promote one. The promotion read is a separate, later,
> pre-registered milestone. This doc picks the measurement instrument and the sequencing that maximizes
> the confidence and efficiency of that eventual decision.

---

## 1. The user's goal (what this decision must serve)

Use the current paper-soak data-gathering window as efficiently as possible to reach a **confident,
data-backed** answer on which take-profit arm ratio is best. Maximize the *value and confidence* of the
eventual promotion decision — not just ship the minimum scaffold. The user will invest more
design/engineering effort **if it meaningfully improves the quality or speed of the answer**, but is not
asking to skip safety gates.

So the decision criterion here is not "which route is cheapest" — it is **"which route (or sequence)
gets us to a defensible R:R call fastest, without ever risking the live/paper order path."**

## 2. Why xmom shadow cohorts are NOT "free" (the premise that broke M53's D2)

M53's D2 assumed inserting `strategy_versions` rows with `status='shadow'` and different
`xmom_tp_arm_rr` would automatically be fanned out by the existing shadow pipeline. **That is false for
a portfolio strategy.** Verified against the code and pinned in the ADR 0029 deferral note:

- `ShadowStrategyOrchestratorService.runShadows(...)` is invoked **only** by
  `StrategyService.onVolatilityDetected` — the single-symbol VWAP trigger path. It resolves each cohort
  through the per-symbol `IStrategy.evaluate(...)` API and `StrategyRegistry`, which registers **only**
  `volatility-vwap` v0–v3.
- xmom is an `IPortfolioStrategy` (ADR 0047/0048): a cron-driven, universe-ranking **rebalance cascade**
  (`MomentumOrchestratorService`, ADR 0050). It never flows through `onVolatilityDetected`. A
  `name='xmom'` shadow row throws in `resolveShadow`, is skipped, and is never evaluated.
- Worse: whenever xmom is the active strategy (`ACTIVE_STRATEGY_VERSION_ID` unset, ADR 0049), the VWAP
  path is **dormant**, so `runShadows` is not called at all.

**Conclusion:** measuring xmom arm cohorts requires *new plumbing*, not row inserts. There are two
candidate routes.

## 3. The two routes

### Route 1 — rebalance-cascade fan-out (live-path, honest counterfactual)

At the `MomentumOrchestratorService` intent-build seam (`buildOpenIntent` → before `evaluateAndEmit`),
after building each live OPEN intent, **also** build the same intent under each `status='shadow'` xmom
cohort's `xmom_tp_arm_rr`, and record it to a per-cohort virtual ledger (`shadow_decisions` +
`simulated_fill`, ADR 0029). Ranking/selection is shared across cohorts; only the TP geometry and the
fill-accept outcome diverge.

- **What it buys:** an honest forward counterfactual on the *live tape* — the ranking that actually fired,
  the fill simulator, and (critically) a **post-fill exit path** for rescued fills and truncation-free
  outcomes for widened winners. This is the only route that can, in principle, settle **post-fill
  expectancy** (the metric EXP-018 proved is the decisive one).
- **Load-bearing risk (security-critical):** a `status='shadow'` cohort intent must record **only** to
  `shadow_decisions`/`simulated_fill` and must **NEVER** reach `emitApproval`, the executor, or the risk
  gate. A leaked cohort intent would place a real / paper-live order at a wider, un-promoted arm. This
  touches the live rebalance code path directly — it is exactly the invariant CLAUDE.md ("no order path
  bypasses the risk gate") and ADR 0029 §"topology reaffirmed" exist to protect.
- **Concentrated feasibility risk (the fill simulator):** if the paper/shadow fill path fills flat at
  best-quote with zero slippage (`s ≈ 0`), realized R:R ≈ arm ratio for **every** cohort, force_close
  rate collapses toward ~0 uniformly, and the cohorts become **indistinguishable** — the whole
  measurement is void. This flat-fill risk is already an open M51/M52 finding.

### Route 2 — offline periodic replay (read-only, real fill tape)

A scheduled read-only analysis job building on the existing
`packages/analysis/research/xmom_tp_ratio_replay.mjs` (already built, ~279 lines): it fetches real
Binance 1m OHLCV for each recorded position and replays bar-by-bar against the shared
`simulateIntrabarStop` touch convention, recomputing per cohort which barrier (widened TP / frozen SL /
time-stop) is touched first. Zero engine-code contact.

- **What it buys:** faithful force_close / fill / barrier-mix per cohort, priced off the **real recorded
  fill** — so it is **immune to the flat-fill risk** (route 1 gate (a) does not apply). Already validated:
  the 1.5 arm reproduced 19/19 recorded force_closes and 11/12 barriers (EXP-018 real-price replay).
- **Its hard wall (EXP-018):** it **cannot settle post-fill expectancy on its own**. Winner MFE is
  truncated at the actual 1.5 exit (the position closed there, so there is no data on whether price would
  have reached a wider TP), and the 0-duration rescued force_closes have **no post-fill path at all**. It
  measures the *barrier mix* honestly but cannot price the *rescued winners/losers* that are the whole
  point of headroom.

## 4. Recommendation — staged hybrid: Route 2 first (now), Route 1 only if gated-in later

**Run Route 2 immediately as the fast, safe first read. Treat Route 1 as a slower, separately-scoped
investment that we commit to ONLY if (a) Route 2's barrier-mix read is directionally inconclusive or
favorable enough to justify chasing post-fill expectancy, AND (b) a fill-fidelity spike proves Route 1
can actually distinguish cohorts.** Do not build Route 1 speculatively.

### Why this ordering serves the goal better than "pick one route"

1. **The current data already points against widening — Route 2 can confirm or overturn that cheaply,
   now.** The EXP-018 real-price replay (n=31) showed the filled-book TP:SL ratio *degrades* as the arm
   widens (0.71 at 1.5 → 0.44 at 2.5/3.0): the marginal fills that headroom rescues disproportionately
   hit the frozen SL. PnL was noisy, non-monotonic, and **gross** (wider arms roughly double taker fees +
   funding, a drag invisible in gross). "The conservative 1.5 default is not contradicted by the
   evidence." If that pattern holds as the soak grows the sample, **Route 2 alone may kill the wider-arm
   hypothesis** without ever needing Route 1's live-path risk. That is the most efficient possible
   outcome, and it is a real possibility, not a hedge.

2. **Route 2 keeps running on the same tape Route 1 would use — there is no wasted work.** It reads
   `positions` as the soak accumulates. Every day of soak makes the Route 2 read stronger *and* builds
   the exact sample Route 1 would later score. Starting Route 2 now loses nothing if we later add Route 1.

3. **Route 1's incremental value is contingent, and its risk is not.** Route 1 buys *one* thing Route 2
   cannot: post-fill expectancy on rescued fills. But that value only matters **if the barrier mix is not
   already decisive** and **if the fill simulator can distinguish cohorts at all** (gate (a)). Its risk —
   touching the live rebalance intent path with a containment invariant that, if violated, places a real
   order at an un-promoted arm — is paid up front and in full regardless of whether the value
   materializes. Spending that risk *before* Route 2 has shown the barrier mix is inconclusive is
   premature: we might take the live-path risk to answer a question the cheap route already closed.

4. **Efficiency of *effort* and confidence in the *answer* both point the same way here.** The user wants
   both. Route 2 first maximizes both: it is the fastest read (script exists), the safest (no engine
   touch), and it directly de-risks the Route 1 decision by telling us whether post-fill expectancy is
   even the binding question. This is not "do the minimum" — it is "spend the expensive, risky effort only
   where it is proven to add confidence."

**Net:** Route 2 is not a consolation prize; it is the correct first instrument *and* the gate that tells
us whether Route 1's live-path risk is justified. Route 1 stays fully specified and staged behind an
explicit go/no-go so we can move fast if warranted — but we do not pre-pay its risk.

## 5. How the feasibility-spike gates change (or don't change) the preference

The M53 plan specified two spike gates. Under the staged hybrid:

- **Gate (a) — realistic entry slippage.** Applies to **Route 1 only**. Route 2 is immune (it prices off
  the real recorded fill; the arm only moves the TP, not the entry). This asymmetry is a **strong reason
  to lead with Route 2**: Route 2 sidesteps the single most dangerous failure mode (flat-fill collapse to
  indistinguishable cohorts) entirely. Gate (a) becomes a **precondition to *starting* Route 1**, not
  something discovered mid-build — if the sim cannot inject realistic slippage, Route 1 is not built at
  all and Route 2 (plus the follow-up decision) is the answer.
- **Gate (b) — 1.5-cohort baseline calibration.** Applies to **both** routes and is **already partly
  discharged for Route 2**: the 1.5 replay reproduced 19/19 force_closes and 11/12 barriers on the n=31
  sample. Route 2's D3-scale run must re-confirm this on the larger soak sample before any 1.8/2.0/2.5
  delta is read as signal. For Route 1, gate (b) is the acceptance test that the fan-out's 1.5 cohort
  reproduces the live active version's force_close rate + barrier mix.

**The gates reinforce the staged-hybrid preference:** Route 2 clears the more dangerous gate (a) by
construction and has already largely passed gate (b); Route 1 must pass both before it earns the right to
touch the live path.

## 6. Concrete next-milestone scope (M53b, Route-2-first)

The very next milestone is **Route 2 only**, plus the instrumentation/registration scaffolding that both
routes share. Route 1 is written up as a *staged, gated follow-up* (M53c) and not built yet.

### M53b deliverables (Route 2 — offline replay + instrumentation)

| # | Deliverable | Reused vs new | Notes |
|---|-------------|---------------|-------|
| B1 | **Productionize the replay as a scheduled cohort read.** Wrap `xmom_tp_ratio_replay.mjs` into a repeatable analysis job that runs over the growing soak `positions` set for the 1.5 / 1.8 / 2.0 / 2.5 arm sweep and writes a per-cohort result surface the analysis layer can query. | **Reuses** the existing script + `simulateIntrabarStop`; **new**: scheduling/persistence wrapper, read-layer surface. | Read-only. Zero engine-code contact. No migration, no `strategy_versions` cohort rows needed (offline replay does not use them). |
| B2 | **Per-cohort go/no-go instrumentation (M53 D3, scoped to what Route 2 can honestly report).** Force_close rate, fill rate, and **barrier mix (TP:SL)** per cohort — net-of-fees where computable, **explicitly flagged gross where not** (EXP-018 rule: gross-only misled once). Trade-count / turnover / avg-hold line per cohort (wider arms ~2× trades, more funding intervals). | **New** query set in `packages/analysis/`. | **Honest scope label:** Route 2 reports barrier mix faithfully but **must annotate that post-fill expectancy for rescued fills is NOT measured here** (the EXP-018 truncation wall). No expectancy-promotion claim is drawn. |
| B3 | **Statistical-design capture from day one.** Paired/blocked per-symbol design (cohorts are correlated — same book, different arm — so per-cohort `n` overstates independent power; use paired deltas per ADR 0018 discipline). **Sub-period/regime tags on every observation** (impossible to add retroactively; the replay PnL is noisy/non-monotonic across ratios → real multiple-comparisons exposure across 3–4 ratios). | **New** design applied inside B2's queries. | These cost nothing now and are load-bearing for the eventual pre-registered promotion read. |
| B4 | **Register EXP-019** in `docs/analysis/README.md` ("xmom TP-arm headroom: does a wider arm reduce force_close without buying stop-out adverse selection?"), seeded from EXP-018, scoped to Route 2's barrier-mix read + the explicit post-fill-expectancy gap. | **New** registry row. | No promotion claim. Records the gate to Route 1. |
| B5 | **Route-1 staged-follow-up spec (M53c), gated, NOT built.** Document the fan-out design, the containment invariant + adversarial test, and gate (a)/(b) as *entry conditions*. Decision rule for committing to M53c: only if B2's barrier mix is favorable/inconclusive enough that post-fill expectancy is the binding question AND a fill-fidelity spike passes gate (a). | **New** doc section (this file → promoted). | Keeps Route 1 ready-to-go without pre-paying its risk. |

### What stays gated behind a spike (M53c — Route 1, only if warranted)

- **Fill-fidelity spike (gate (a)) is the entry condition, run first.** Prove the shadow/paper fill path
  injects realistic entry slippage (or prices cohort fills off the real fill tape). If it fills flat,
  **STOP — Route 1 is void**, and Route 2 + the follow-up promotion read is the answer.
- **Containment invariant as an adversarial acceptance test (High).** A `status='shadow'` cohort intent
  is asserted to reach **only** `shadow_decisions`/`simulated_fill` — never `emitApproval`, the executor,
  or the risk gate. This is the load-bearing safety property; it gates the whole route.
- **Baseline calibration (gate (b)).** The `arm=1.5` fan-out cohort must reproduce the live active
  version's force_close rate + barrier mix within tolerance before any wider-arm delta is read.
- **Cohort-seed migration** (`strategy_versions` rows, `status='shadow'`, `params={"xmom_tp_arm_rr": …}`)
  — only if Route 1 is committed; dump-first per CLAUDE.md rule-9.

### Explicitly out of scope for M53b (unchanged from M53)

No promotion of any wider ratio to live; no change to `xmom_min_rr` (the guard floor); no fill-time TP
rebase; no break-even stop; no touch to the ADR 0045 fill-acceptance guard, the risk gate, the slot
model, or the M52 retry mechanism. The active version stays at the 1.5 no-op.

## 7. ADR impact (once finalized)

- **ADR 0029** — extend the existing M53 deferral note: record the Route-2-first decision, that the
  portfolio-shadow fan-out (Route 1) remains gated/deferred to M53c, and the entry conditions for building
  it.
- **ADR 0047 §6** — note that the `xmom_tp_arm_rr` decouple's measurement instrument is the offline replay
  (Route 2) with the Route-1 fan-out staged behind fidelity + containment gates.
- **New ADR** — warranted **only if M53c (Route 1) is actually committed**, since a portfolio-shadow
  evaluation loop is a genuinely new mechanism outside the single-symbol ADR 0029 pipeline. Not needed for
  M53b (Route 2 is pure analysis-layer, no topology change).

## 8. Open questions carried forward

1. **Cohort ratio set.** 1.8 / 2.0 / 2.5 is the EXP-018 span; the replay showed 2.5/3.0 skew hard to
   stop-outs, so a tight **1.8 / 2.0** pair may be the more informative spend. Confirm at B2 design.
2. **Pre-registered decision rule** for the eventual promotion milestone (winning ratio, metric,
   threshold) — must be fixed *before* reading the data given the multiple-comparisons exposure. B3's
   sub-period tags exist to support this. Not an M53b deliverable; recorded so it is not lost.
3. **Sample-size bar** — n≈300+ per EXP-011/012 precedent, but cohorts are correlated so per-cohort `n`
   overstates power; the read uses paired/blocked per-symbol deltas, not independent means.
