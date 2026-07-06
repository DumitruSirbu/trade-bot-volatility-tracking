# M53 — xmom take-profit arm headroom (decouple arm ratio from the fill guard) + multi-ratio shadow cohort

> **What M53 is.** A small, **no-op-on-ship** contract change that *decouples* the one number xmom
> currently overloads. Today `xmom_min_rr` (default 1.5) does two unrelated jobs with **zero slack
> between them**: it (a) arms the signal-time take-profit at exactly `1.5·stopDistance`
> (`MomentumOrchestratorService.ts:618`) **and** (b) is the fill-acceptance guard floor
> (`geometryParams.min_rr` → `exitGeometryHelper.ts` `isRrInsufficient`, reason
> `degenerate_geometry_at_fill`). Because the arm sits *exactly on* the reject floor, ordinary entry
> slippage on a long tips realized R:R below 1.5 and the guard `force_close`s the fill at 0-duration.
> In the EXP-018 24h sample that was ~2/3 of opens (inflated by manual triggering, but structurally real).
>
> M53 introduces a **second param — `xmom_tp_arm_rr`** — that drives the arm only, and leaves
> `xmom_min_rr` as the guard floor only. **It ships defaulted to 1.5 (an exact no-op) on the live/active
> strategy version (`strategy_versions.id=20`)** — zero behavior change from the code alone. Any wider
> arm (1.8 / 2.0 / …) is introduced **only** as separate `status=shadow` cohort rows and measured in a
> paper soak before any promotion decision (which is itself a **future** milestone, out of scope here).
>
> M53 also does two hygiene jobs: it stands up the **multi-ratio shadow cohort** that will feed that
> future decision, and it **archives seven stale `volatility-vwap` shadow rows** that the shadow
> orchestrator has been fanning out over for no purpose since VWAP was retired (2026-07-01).
>
> **This is not a bug fix, and it is not a promotion.** The guard is behaving exactly as specified —
> M53 does not touch it. The 1.5 default preserves current behavior byte-for-behavior. Every `CLAUDE.md`
> trading-safety invariant holds: **no order path bypasses the risk gate** (the wider arm produces a
> *wider* TP that still clears the unchanged `min_rr` floor — ADR 0045 pre-fill guarantee intact),
> strategies stay pure/deterministic (the new param is plain data read inside the pure sizing/geometry
> path, no clock/RNG/I-O added at `:618`), money stays `decimal`, no LLM in the loop, **no live capital**
> (active version stays at the 1.5 no-op; wider ratios live only on shadow rows; xmom keeps its HIGH
> go-live blockers).
>
> **Source analysis:** `docs/analysis/20260704-m52-force-close-retry-soak-analysis.md` (EXP-018) — four
> independently-run, converged reviews (logic, quant-design, offline-validation-feasibility,
> real-price-replay). Read it before implementing; it is the authority for every decision below.

---

## Problem statement

xmom (`strategy_versions.id=20`, ADR 0048/0050, `MomentumOrchestratorService`) arms every long
take-profit at `entryPrice + stopDistance × params.xmom_min_rr` with the TP **frozen at the signal**
(`tpRebaseEligible = false`, `MomentumOrchestratorService.ts:617-618,667`). The **same**
`xmom_min_rr` value is threaded to `gateStrategyParams.min_rr` → stamped as `geometryParams.min_rr`
on the OPEN approval → consumed by the fill-acceptance guard `isRrInsufficient(ratio, min_rr)`
(`exitGeometryHelper.ts`), which force-closes a fill whose realized `tpDist/slDist < min_rr`.

Because arm ratio == guard floor == one number, the position is armed **exactly on the reject
threshold**. For a long that fills *above* the signal price: `slDist = fill − SL` grows, `tpDist =
TP − fill` shrinks (TP frozen) → realized R:R drops below 1.5 → the guard rejects and unwinds at
0-duration (fee-only). Slippage *direction* alone decides ~2/3 of outcomes on thin books.

The EXP-018 data confirms the split is razor-sharp: id 243 (XPL) at realized R:R **1.50** was
rejected; id 247 (MAGMA) at **1.51** filled and traded. The guard is correct; **the entry geometry
gives it nothing to work with** — we arm at the floor, then reject anything below the floor.

**Why the fix is mandatory but the *value* is not.** All four EXP-018 reviews agree the arm and the
guard **must be decoupled** — bumping `xmom_min_rr` alone moves both together and buys zero slack (the
whole bug). But they equally agree that **no wider ratio is proven**: the real-price replay (actual
Binance 1m OHLCV, same `simulateIntrabarStop` touch logic as the engine) on all 31 historical xmom
positions found that widening rescues more force_closes but they **skew to stop-outs** (filled-book
TP:SL degrades 0.71 → 0.44 as the arm widens 1.5 → 2.5/3.0), PnL is noisy/non-monotonic and gross
(pre-fee), and n=31 is one-to-two orders of magnitude below this repo's decision-grade bar (n≈300, per
EXP-011/012). **The conservative 1.5 default is not contradicted by the evidence** — so M53 ships the
*mechanism* (decoupled param) at a no-op default and defers the *value* to a paper shadow soak.

**Second problem (hygiene).** VWAP was fully retired 2026-07-01; xmom (id=20) is the sole active
strategy. But seven `volatility-vwap` **shadow** rows were never archived (ids **1, 2, 4, 15, 16, 17,
19**). `StrategyVersionRepository.findActiveShadows()` filters only on `status = 'shadow'` with no
name/strategy filter, so `ShadowStrategyOrchestratorService` **still evaluates all seven dead cohorts
on every live tick** — pure waste, and clutter the new xmom-ratio cohorts would be added alongside.

---

## Goals / non-goals

### Goals

1. **Decouple the arm ratio from the guard floor** — add `xmom_tp_arm_rr` (drives the arm at
   `MomentumOrchestratorService.ts:618` only); keep `xmom_min_rr` as the guard floor only. Default the
   new param to **1.5 (exact no-op)** on the active version.
2. **Stand up a multi-ratio shadow cohort** (e.g. 1.8 / 2.0 / 2.5) that measures **force_close rate,
   retry-recovery rate, AND traded-book expectancy together** per cohort, targeting EXP-011/012-scale
   samples (n≈300+) — the only instrument that observes the post-fill path for rescued fills and the
   truncation-free outcome for widened winners.
3. **Archive the seven retired `volatility-vwap` shadow rows** (via migration) so the shadow
   orchestrator stops fanning out over dead cohorts and the xmom-ratio cohorts run clean.
4. **Keep it safe by construction** — active version stays at the 1.5 no-op; wider ratios never touch
   live; the guard, gate, slot model, and pure core are untouched.

### Non-goals (explicitly out of scope — do not do these here)

- **No promotion of any wider ratio to live.** M53 ships the mechanism at 1.5 and the shadow cohorts.
  Choosing 1.8-vs-anything and promoting it is a **future** milestone gated on the soak read (n≈300+).
  Do not raise the active version's arm above 1.5 in this milestone.
- **No change to `xmom_min_rr` itself** — it stays the guard floor. Raising it re-couples the two seams
  and reintroduces the bug (logic + quant review, EXP-018).
- **No fill-time TP rebase** (`tpRebaseEligible = true`). Both EXP-018 reviews flag the wired rebase
  offset is mis-wired for momentum (`atr24h` = 0.5·D → guard rejects *every* open) and that a correct
  rebase re-opens the single-leg-rebase-voids-the-gate hazard `momentumCore.ts:86-95` documents as
  REJECTED. Headroom is the smaller, gate-safe first step. Rebase is a separate future proposal.
- **No change to the ADR 0045 fill-acceptance guard** — `evaluateFillGeometry` / `isRrInsufficient` /
  synthetic-FLATTEN unwind byte-for-byte unchanged. The wider arm only makes fills *easier* to clear.
- **No break-even / partial-de-risk stop** (EXP-018 §4 seed) — separate experiment; not this milestone.
- **No touch to the M52 retry mechanism** (ADR 0051) — orthogonal. Its breaker keys on
  `atrUnitsDrift` (independent of TP width), so widening the arm needs no recalibration of
  `MOMENTUM_RETRY_MAX_ATR_DRIFT`.
- **No touch to `volatility-vwap` id=3 (`status='active'`)** — it is a *second active row* (legal: the
  unique-active constraint is per `name`), not a shadow row, and was **not** requested. See Open
  Questions Q1 — flag it, do not silently change it.

---

## Design

### D1 — decouple the arm ratio into a new `xmom_tp_arm_rr` param (no-op default)

The load-bearing change. A `packages/shared` contract touch → **`bot-shared-maintainer` runs first**
(serial), before any engine wiring.

- **Schema (`packages/shared/src/schema/momentumParamsSchema.ts`).** Add
  `xmom_tp_arm_rr: z.number().positive().default(1.5)`. Keep `xmom_min_rr` unchanged (default 1.5,
  guard floor). The schema is deliberately non-`.strict()` (forward-compat), so existing `params = {}`
  rows parse to `xmom_tp_arm_rr = 1.5` automatically — **the active version needs no data change to
  stay a no-op.** `IMomentumParams` picks up the field via `z.infer` (no manual type edit).
- **Arm wiring (`MomentumOrchestratorService.ts:618`).** Change *only* the arm to read the new field:
  `takeProfitPrice = entryPrice + stopDistance × params.xmom_tp_arm_rr`. Leave the guard-floor thread
  (`params.xmom_min_rr` → `gateStrategyParams.min_rr`, ~`:857`) **untouched**. This is the entire
  behavioral seam: at `xmom_tp_arm_rr = xmom_min_rr = 1.5` the arithmetic is identical to today; at
  `xmom_tp_arm_rr > xmom_min_rr` the TP sits above the reject floor and normal slippage clears it.
- **Determinism preserved.** The new field is plain versioned data read inside the existing pure
  sizing/geometry path — no clock, RNG, or I/O added. Backtest/live parity intact.
- **Side symmetry (forward note, not a change).** The xmom arm is hardcoded LONG (`:618` `.plus(...)`).
  When a SHORT xmom path is ever introduced, `xmom_tp_arm_rr` must apply symmetrically
  (`entryPrice − stopDistance × xmom_tp_arm_rr`) so the two seams never diverge by side. No SHORT path
  exists today; nothing to implement now — record it so the future author does not miss it.
- **`.env.example` / docs.** No new env var (this is a JSONB param, not a flag), so no `.env.example`
  change — but note the new param in the momentum-params doc / ADR 0047 params table so operators know
  it exists and that 1.5 is the no-op baseline.

### D2 — multi-ratio shadow cohort (feasibility MUST be resolved first — see the caveat)

The measurement instrument for the future promotion decision: run several arm ratios side-by-side
against the live tape with independent virtual ledgers, reading **force_close rate + retry-recovery
rate + traded-book expectancy together** per cohort, targeting n≈300+.

**⚠️ Architectural caveat — the "shadow array is free plumbing" premise is NOT confirmed by the code
and is very likely false as stated.** The brief's assumption was that
`ShadowStrategyOrchestratorService` already fans out every `status='shadow'` row against the live
decision/tick stream, so xmom-ratio cohorts cost only new DB rows. Verification of the current code
does **not** support this for a *portfolio* strategy:

- `ShadowStrategyOrchestratorService.runShadows(event: IVolatilityDetectedEvent, …)` is invoked by
  `StrategyService.onVolatilityDetected` — the **single-symbol VWAP trigger path**. Each shadow
  re-classifies per-symbol flow (`classifyFlowType`) and resolves a per-event strategy **core** via
  `StrategyRegistry`. This is the VWAP counterfactual engine.
- xmom is a **portfolio** strategy: `MomentumOrchestratorService` is a cron-driven, universe-ranking
  **rebalance cascade** (ADR 0048/0050). It does **not** flow through `onVolatilityDetected` /
  `runShadows`, and it has no per-symbol `IVolatilityDetected` core to resolve.
- So adding `name=xmom, status=shadow` rows today will either fail to resolve in `resolveShadow` or be
  evaluated against the wrong (single-symbol) event stream with wrong semantics. `findActiveShadows()`
  returning them without a name filter does **not** mean the momentum path evaluates them.

**Therefore D2's first task is a design decision, not row inserts.** The implementing wave must resolve
how xmom shadow cohorts are actually evaluated. Two candidate routes (architect to pick during D2
design; this is a strategy/shadow contract touch → involve `bot-architect` + likely
`bot-shadow`/engine):

1. **Rebalance-cascade fan-out (honest counterfactual, but higher engine risk).** Have
   `MomentumOrchestratorService`'s rebalance, after building each live OPEN intent, *also* build the
   same intent under each `status='shadow'` xmom cohort's `xmom_tp_arm_rr` and record it to a
   per-cohort virtual ledger (reusing `shadow_decisions` + `simulated_fill`, ADR 0029). The arm ratio
   is the *only* param that differs across cohorts, so the ranking/selection is shared — only the TP
   geometry and the fill-accept outcome diverge. **Mandatory containment invariant (testable, High):**
   a `status='shadow'` cohort intent must record **only** to `shadow_decisions` / `simulated_fill` and
   must **never** reach `emitApproval`, the executor, or the risk gate. This is the load-bearing safety
   property of route 1 — a leaked cohort intent would place a real (or paper-live) order at a wider
   arm that was never promotion-approved. Pinned as an adversarial acceptance test (see Testing
   Strategy). **Fill-fidelity is the concentrated risk of this route** — see the feasibility-spike gate
   below.
2. **Offline periodic replay job (lower engine risk, bounded reach).** A read-only analysis job that
   re-derives each cohort's force_close / fill / barrier outcome from `positions` + real price (the
   `xmom_tp_ratio_replay.mjs` methodology already built), run on a schedule as the soak accumulates.
   **No selection-bias problem** — the recorded fill price is arm-invariant (the arm only moves the TP,
   not the entry), so the job correctly recomputes accept/reject and barrier order per cohort off the
   *real* fill tape. Its only limit is the EXP-018 data wall: winner MFE is truncated at the actual
   1.5 exit and 0-duration rescues have no post-fill path, so this route measures force_close / fill /
   barrier mix faithfully but **cannot settle post-fill expectancy on its own**. It does not carry
   route 1's fill-simulator fidelity risk (it prices off real ticks).

**Feasibility-spike gate — the spike must PROVE these before any cohort delta is treated as signal
(quant blockers):**

- **(a) Realistic entry slippage (route 1 only).** Prove the shadow/paper fill simulator injects
  realistic entry slippage — **or** that route 1 prices cohort fills off the real fill tape, not
  flat-at-best-quote. If fills are flat (`s ≈ 0`), realized R:R `≈ arm ratio` for *every* cohort, so
  force_close rate collapses toward ~0 uniformly and **every wider arm looks costless** — the cohorts
  become indistinguishable and the whole measurement is void. This is the single most important gate
  on route 1. (Route 2 is immune — it uses the real recorded fill.)
- **(b) Baseline calibration gate.** The `arm=1.5` shadow cohort must reproduce the **live active
  version's** actual force_close rate **and** barrier mix (TP/SL split) within a stated tolerance
  before any 1.8/2.0/2.5 delta is read as signal. This is exactly the validation the real-price replay
  itself used (EXP-018 analysis §"Validation (ratio 1.5 must reproduce recorded reality)", ~lines
  418–426: 19/19 force_close reproduced, 11/12 barrier-faithful). If the 1.5 cohort can't reproduce
  live reality, the cohort machinery is miscalibrated and no delta is trustworthy.

Whichever route is chosen, the cohort definition is the same: additional `strategy_versions` rows
(name e.g. `xmom`, `status='shadow'`, `params = {"xmom_tp_arm_rr": <1.8|2.0|2.5>}`, else 24h defaults),
added **after** D4's archival so they don't mingle with dead VWAP rows. **The cohort rows are a DB
change** → seeded via migration (CLAUDE.md dump-first rule applies, same as D4). Do **not** hand-insert.

> **Scope guard:** if route 1 turns out to be more than a small, contained fan-out at the intent-build
> seam — or if gate (a) shows the sim can't inject realistic slippage — the engine agent **STOPs and
> surfaces to the architect** rather than expanding the milestone (route 2, or a follow-up milestone,
> may be the answer). M53's *mandatory, shippable* core is D1 (+ D4); D2/D3 are the measurement
> scaffold and may be staged.

### D3 — per-cohort go/no-go instrumentation

The read that a future promotion milestone will consume. Instrument the cohort ledgers so each arm
ratio reports, side by side:

1. **Force_close rate** — opens rejected by the guard vs filled, per cohort.
2. **Retry-recovery rate** — of the M52 retry entries, how many survive to a live position, per cohort
   (the headroom is theorized to lift this; measure it, don't assume). **Recovery rate alone can mask a
   loss engine** — pair it with metric 4 below.
3. **Traded-book expectancy — net of fees AND funding (High).** Realized/simulated PnL on the *filled*
   book per cohort, **net of taker fees and funding**, with the TP:SL mix — the decisive test (EXP-018
   real-price replay showed widening degrades TP:SL to stop-outs). **Gross-only PnL already misled once
   in that replay**, so gross is not acceptable here. Report alongside a per-cohort **trade count /
   turnover / average hold time** line: wider arms roughly double trade count (more round-trip taker
   fees) and hold longer (more 8h funding intervals), and both drags are invisible in gross PnL.
4. **Rescued-subset expectancy (isolated).** Report the expectancy of the *marginal rescued* subset
   specifically — positions that **fill at a wider arm but were force_closed at 1.5** — separately from
   the blended cohort book. Higher recovery rate + negative rescued expectancy = **worse**, not better;
   the blended number can hide this. This is the honest read of what headroom actually buys.
5. **Sample count toward n≈300+** per cohort — but see the power caveat below (cohorts are correlated,
   so per-cohort `n` overstates independent power).

**Statistical-design requirements (fold into the query set from day one):**

- **Paired / blocked per-symbol comparison (Medium).** Cohorts share the same underlying book and
  positions — they are **correlated, not independent** samples — so treating each cohort's `n` as
  independently approaching 300 overstates statistical power. Specify a **paired/blocked per-symbol**
  comparison design (same symbol/event, arm 1.5 vs 1.8 vs …), matching the paired-block-bootstrap
  discipline the repo already uses for promotion (ADR 0018). Report paired deltas, not two independent
  means.
- **Capture sub-period / regime tags now (Medium).** Tag every cohort observation with a sub-period /
  regime label from day one so the **future promotion milestone** can require sub-period robustness. The
  replay PnL was noisy and non-monotonic across ratios, and 3–4 ratios will be tested — a real
  multiple-comparisons / overfitting risk. The tags cost nothing now and are impossible to add
  retroactively.

Register the experiment in `docs/analysis/README.md` as **EXP-019** ("xmom TP-arm headroom: does a
wider arm reduce force_close without buying stop-out adverse selection?"). **No promotion claim is
drawn in M53** — D3 is the scaffold; the decision is a future milestone that **must pre-register its
decision rule** (which ratio wins on what metric, at what threshold) before reading the data, given the
multiple-comparisons exposure above.

**Fill-simulator fidelity caveat (carry over from M51/M52 — and see D2 gate (a)).** If the paper/shadow
fill simulator fills flat at best-quote with zero slippage, the *rescued-fill* expectancy (the whole
point of headroom) is optimistic **and** — worse — force_close rate collapses toward ~0 uniformly
across cohorts, making them indistinguishable (D2 gate (a) is the hard stop for this). Annotate every
M53-era cohort PnL surface as pipeline-validation-until-proven, per M51's High finding.

### D4 — archive the seven retired `volatility-vwap` shadow rows (migration)

A forward-only migration (mirroring the `PromoteMomentumStrategyVersionActive` / `PromoteShadowStrategyVersions`
precedents) that flips the seven dead VWAP **shadow** rows to archived and stamps `archived_at`:

- **Target set — bounded, explicit:** `WHERE name = 'volatility-vwap' AND status = 'shadow'` (ids 1, 2,
  4, 15, 16, 17, 19 — seven rows). Set `status = 'archived'` and `archived_at = now()`. The
  `name + status` predicate is idempotent (a re-run is a no-op) and **cannot** touch id=3
  (`status='active'`) or id=20 (`name='xmom'`).
- **Effect:** `findActiveShadows()` (filters `status='shadow'`) stops returning them → the shadow
  orchestrator no longer evaluates dead VWAP cohorts on every tick. `ARCHIVED` is already a valid
  `StrategyStatusEnum` value and the `archived_at` column already exists (`StrategyVersionEntity.ts:46`).
- **`down()`** restores `status='shadow'` and nulls `archived_at` for the same bounded set.
- **CLAUDE.md rule-9 (MANDATORY):** this is a bulk UPDATE touching seven rows → the executing agent
  **takes a `pg_dump` into `backups/` first, shows the user the dump path, and waits for explicit
  confirmation** before running the migration. Prune to the 2 most recent backups after. Do not run the
  migration until the user confirms the dump completed.

### D5 — QA + docs

Adversarial QA on D1 (the only behavioral code), migration test on D4, and doc close-out.

---

## Deliverables / tasks (≤ 5 items, minimum surface)

> Per `dev-qa-cycle.md` §1: minimum surface, each code item ships a paired test (fails before / passes
> after), contract touches route through `bot-shared-maintainer` first, and any contract
> re-interpretation STOPs to the architect. D1 + D4 are the mandatory shippable core; D2/D3 are the
> measurement scaffold and may be staged if D2's feasibility spike shows the cohort plumbing is larger
> than a contained fan-out.

| # | Deliverable | Blocking? | Primary files (indicative) | Tests |
|---|-------------|-----------|----------------------------|-------|
| **D1** | Decouple the arm: add `xmom_tp_arm_rr` (default 1.5) to `momentumParamsSchema`; wire it at the arm site only, leave `xmom_min_rr` as the guard floor. **No-op at default.** | **Yes** | `packages/shared/src/schema/momentumParamsSchema.ts` (shared-maintainer), `MomentumOrchestratorService.ts:618` (arm reads new field) | Paired unit: `params={}` → arm = 1.5·D (identical to today, guard floor still 1.5 — no-op); `xmom_tp_arm_rr=1.8` → arm = 1.8·D but `geometryParams.min_rr` still 1.5; **at a fixed slippage offset `s=0.10`** the same fill force_closes at arm 1.5 (realized R:R 1.27) and fills at arm 1.8 (realized R:R 1.545) — assert against the pinned `s`, not a bare ratio (realized R:R is arm-dependent); determinism/purity of `:618` unchanged |
| **D2** | Multi-ratio shadow cohort — **first resolve the feasibility spike** (portfolio strategy is not on the existing single-symbol shadow path); pick route 1 (rebalance-cascade fan-out) or route 2 (offline replay job); **spike must pass gate (a) realistic entry slippage and gate (b) 1.5-cohort reproduces live reality**; seed cohort `strategy_versions` rows (1.8/2.0/2.5) via migration | **Yes (for the soak)** | design decision + `MomentumOrchestratorService` fan-out **or** analysis replay job; cohort-seed migration; reuse `shadow_decisions`/`simulated_fill` | Route-dependent; **route 1: cohort intent records ONLY to `shadow_decisions`/`simulated_fill`, never reaches `emitApproval`/executor/risk gate (adversarial, High)**; a cohort's arm produces a different fill-accept outcome than the 1.5 baseline on the same event; 1.5 cohort reproduces live force_close rate + barrier mix within tolerance; cohort ledger separable per ratio |
| **D3** | Per-cohort instrumentation — force_close rate, retry-recovery rate, **expectancy net of fees+funding** + trade-count/turnover/avg-hold line, **isolated rescued-subset expectancy**, paired/blocked per-symbol design, **sub-period/regime tags captured from day one**, sample count — + register **EXP-019** in `docs/analysis/README.md`; annotate the flat-fill sim caveat | **Yes (for a meaningful soak)** | metric labels at the cohort seams, analysis query set (`docs/analysis/`), `docs/analysis/README.md` | Test: cohort metrics increment on the right transitions and are separable per arm ratio; rescued subset is separable from the blended book; expectancy line carries fee+funding deductions; sub-period tag present on every observation |
| **D4** | Archive migration for the seven `volatility-vwap` shadow rows (`status→archived`, stamp `archived_at`, bounded by `name+status`, idempotent, reversible `down()`) — **pg_dump + user confirm first (CLAUDE.md rule-9)** | **Yes** | `apps/engine/src/database/migrations/<ts>-ArchiveRetiredVwapShadowRows.ts` | Migration test: up() archives exactly the 7 shadow rows, leaves id=3 (active) and id=20 (xmom) untouched; re-run is a no-op; down() restores |
| **D5** | QA (adversarial on D1, migration test on D4) + docs close-out (ADR references, milestone-log, work-log, README index status→DONE) | QA/docs | tests + docs | adversarial coverage is the bar |

**Wave/dispatch note.** (1) **`bot-shared-maintainer`** first (serial) — the `momentumParamsSchema`
field is a `packages/shared` contract touch. (2) **`bot-architect`** for the D2 feasibility decision
(portfolio-vs-single-symbol shadow path is a real architecture question, not a wiring detail). (3)
**`bot-engine-nestjs`** for D1 arm wiring, the D4 migration, and D2 route implementation. (4)
**`bot-qa-engineer`** (adversarial D1 + D4 migration test). (5) reviewers — **`bot-review-quant`** is
mandatory here (the whole milestone is a quant-geometry change and the "do not promote a wider ratio"
discipline must be enforced) alongside `bot-review-security` (anti-coverage: wider arm never reaches a
live promotion in this milestone), `bot-review-logic`, `bot-review-clean-code`. (6) **`bot-scribe`**.

---

## Testing strategy

Per `dev-qa-cycle.md` §2/§4 — paired tests, adversarial coverage is the bar, adversarial failures route
to the architect.

**Happy path / regression backbone:**

1. **D1 no-op at default.** `params={}` (or explicit `xmom_tp_arm_rr=1.5`) → TP armed at exactly
   `entryPrice + 1.5·stopDistance`, guard floor still 1.5 — byte-identical to today. (The safety of
   shipping to the active version.)
2. **D4 archives exactly the seven.** up() flips ids 1,2,4,15,16,17,19 to `archived` + stamps
   `archived_at`; id=3 (active VWAP) and id=20 (xmom active) untouched.

**Adversarial (the bar for done):**

3. **D1 decoupling proven — pin the slippage offset, not a single R:R number.** Realized R:R at the
   fill is `(a − s)/(1 + s)` where `a` is the arm ratio and `s` is the slippage offset (fraction of
   `D`), so the *same* fill has a *different* realized R:R at each arm — a test written as "a fill at
   R:R 1.6" is unanchored and can't be asserted. Instead **fix `s`** and derive both outcomes:
   choose `s = 0.10` (a filled-above-signal long). At `arm=1.5`: realized R:R `= (1.5−0.10)/1.10 =
   1.27 < 1.5` → **force_closed** (guard rejects). At `arm=1.8`: realized R:R `= (1.8−0.10)/1.10 =
   1.545 ≥ 1.5` → **fills** (clears the unchanged floor). Then a chase fill at `s = 0.9` gives R:R
   `= (1.8−0.9)/1.9 = 0.47 < 1.5` at arm 1.8 too → **still rejected** (headroom does not admit
   degenerate fills). QA asserts against the fixed `s`, not a bare ratio.
4. **D1 guard thread untouched.** Assert `gateStrategyParams.min_rr` / `geometryParams.min_rr` still
   read `xmom_min_rr`, not the new arm param (the two seams stay independent).
5. **D1 determinism.** No clock/RNG/I-O introduced at `:618`; same inputs → same TP.
6. **D4 idempotent + reversible.** Re-running up() is a no-op; down() restores `status='shadow'` and
   nulls `archived_at` for the seven.
7. **D4 blast-radius bound.** A row with `name='volatility-vwap' status='active'` (id=3) and a row with
   `name='xmom'` (id=20) are provably **not** modified by up().
8. **D2 cohort separability.** A shadow cohort at arm 1.8 records a different fill-accept outcome than
   the 1.5 baseline on the same live event, into a separable per-ratio ledger.
9. **D2 route-1 intent containment (High — security-critical).** A `status='shadow'` cohort intent is
   recorded **only** to `shadow_decisions` / `simulated_fill` and is asserted **never** to reach
   `emitApproval`, the executor, or the risk gate — no cohort intent can place a real/paper-live order
   at a wider, un-promoted arm. (Only applies if route 1 ships; the load-bearing safety property.)
10. **D2 gate (b) baseline calibration.** The `arm=1.5` cohort reproduces the live active version's
    force_close rate and TP/SL barrier mix within the stated tolerance; a miscalibrated 1.5 cohort
    fails the gate and blocks any wider-arm delta from being read.
11. **D3 rescued-subset isolation.** The marginal rescued subset (fills at wider arm that were
    force_closed at 1.5) is separable from the blended cohort book, and its expectancy is reported
    net of fees+funding — so a high-recovery / negative-rescued-expectancy cohort is detectable.

**Live-app PAPER smoke (mandatory before close, `dev-qa-cycle.md` §6.4).** Boot the app in PAPER after
the D4 archival, drive `pnpm rebalance:trigger`, and confirm: (a) no `ERROR` / DI-cycle / boot-pipeline
failure; (b) the shadow orchestrator init log no longer lists the seven `volatility-vwap` cohorts; (c)
xmom opens still arm at 1.5 (no-op verified end-to-end); (d) if D2 route 1 shipped, the cohort ledgers
record. Confirm the active version's behavior is unchanged from pre-M53.

---

## Rollout / reversibility

- **D1 is a no-op on ship.** The active version (`id=20`, `params={}`) parses `xmom_tp_arm_rr=1.5`,
  identical to today. No wider ratio touches the active version in M53. Reversible by removing the field
  (or it simply stays inert at 1.5).
- **D4 requires a pg_dump + explicit user confirmation before it runs** (CLAUDE.md rule-9 — bulk UPDATE
  of seven rows). Dump into `backups/`, show the path, wait for confirmation, prune to the 2 most
  recent after. Reversible via `down()`.
- **D2 cohort rows** are `status='shadow'` — they can never reach a live gate (shadow ledgers are
  virtual; ADR 0029). Adding/removing them is a migration, dump-first per rule-9. If the D2 feasibility
  spike shows route 1 is larger than a contained fan-out, **stage D2/D3 into a follow-up** and ship
  D1+D4 alone — D1 (no-op decouple) + D4 (archive) are independently valuable and low-risk.
- **The ADR 0045 guard, the risk gate, the slot model, `top_n`, ranking, and the pure core are
  unchanged** — M53 is additive.
- **Operator runbook after deploy:** confirm `strategy_versions.id=20 params` is `{}` (arm stays 1.5);
  run the D4 dump + archival; boot PAPER and verify the shadow init log dropped the seven VWAP cohorts;
  do **not** raise the active arm above 1.5 — that is a future, soak-gated decision.

---

## ADR impact

- **ADR 0047 (portfolio-strategy contract / `momentumParamsSchema`) — amend.** Add `xmom_tp_arm_rr` to
  the documented param set, its 1.5 no-op default, and the decoupling rationale (arm ≠ guard floor).
  This is the schema's home ADR.
- **ADR 0045 (fill-acceptance guard) — reference, not amended.** M53 *consumes* the guard unchanged;
  document that the arm now sits above the guard floor by design (headroom) and why that preserves the
  pre-fill-geometry guarantee.
- **ADR 0050 (xmom cascade / rebalance) — reference.** D2's cohort fan-out (if route 1) composes with
  the rebalance; note the shadow-cohort measurement pattern without changing the cascade.
- **ADR 0051 (M52 retry) — reference, not amended.** Note that widening the arm is orthogonal to the
  `atrUnitsDrift` breaker (no `MOMENTUM_RETRY_MAX_ATR_DRIFT` recalibration needed) and is expected to
  *lift* retry-recovery — measured in D3, not assumed.
- **ADR 0029 (shadow pipeline) — possible amendment if D2 route 1** extends the shadow path to portfolio
  strategies (the existing path is single-symbol only). If so, that extension needs its own ADR section
  — flag to the architect during the D2 spike. **New ADR may be warranted** if the portfolio-shadow
  evaluation is a genuinely new mechanism.
- Update `docs/architecture/adr/README.md` (Strategy section) with any new/amended ADR anchors.

---

## What NOT to change (scope boundaries)

- **The ADR 0045 fill-acceptance guard** (`evaluateFillGeometry` / `isRrInsufficient` / synthetic-FLATTEN
  unwind) — byte-for-byte unchanged.
- **`xmom_min_rr`** — stays the guard floor; not raised, not repurposed.
- **The active version's arm ratio** — stays 1.5 (no-op). No wider ratio promoted to live in M53.
- **The risk gate, slot model, exposure caps, `top_n`, ranking, rebalance cadence, pure core** — untouched.
- **The M52 retry mechanism / `MOMENTUM_RETRY_MAX_ATR_DRIFT`** — untouched.
- **`volatility-vwap` id=3 (`status='active'`)** — not a shadow row, not requested; do not modify (Q1).
- **No fill-time rebase, no break-even stop, no new env flag, no order-type change.**

---

## Open questions

1. **The second active `volatility-vwap` row (id=3, `status='active'`).** It is a leftover active row
   (legal — unique-active is per `name`) that the user did **not** ask to touch. Should it be archived
   too (VWAP is retired), or left as-is? **Flag, do not silently change** — decide with the user before
   any migration touches it. Out of scope for M53's requested archival set (the seven shadow rows).
2. **D2 shadow-path route (the load-bearing one).** Route 1 (rebalance-cascade fan-out — honest
   counterfactual, but a real engine change; the existing shadow path is single-symbol VWAP and does
   **not** cover portfolio strategies) vs route 2 (offline periodic replay — lower risk, but cannot
   settle post-fill expectancy alone, per the EXP-018 feasibility wall). Architect decides during the
   D2 spike; may split D2/D3 into a follow-up milestone if route 1 is large.
3. **Cohort ratios to seed.** 1.8 / 2.0 / 2.5 is the EXP-018 sweep span. Confirm the exact set (and
   whether 3.0 is worth a slot) at D2 design — the replay showed 2.5/3.0 skew hard to stop-outs, so a
   tight 1.8/2.0 pair may be the more informative spend.
4. **Sample size before any future promotion read.** n≈300+ per cohort (EXP-011/012 precedent) — **but
   cohorts are correlated** (same book, different arm), so per-cohort `n` overstates independent power;
   the read must use the paired/blocked per-symbol design (D3), not two independent means. M53 only
   stands up the measurement; the go/no-go read is a future milestone and stays open until the sample
   supports a defensible expectancy call.
5. **Pre-registered decision rule for the future promotion milestone.** With 3–4 ratios tested against
   noisy, non-monotonic replay PnL, the promotion read carries real multiple-comparisons / overfitting
   risk. That future milestone must **pre-register its decision rule** (winning ratio, metric,
   threshold) before looking at the data and require sub-period/regime robustness — which is why D3
   captures the sub-period tags from day one. Not an M53 deliverable; recorded here so it is not lost.

---

## Supersedes / links

- **Extends** ADR 0047/0048/0050 (xmom params + cascade) and consumes ADR 0045 (fill-acceptance guard)
  and ADR 0051 (M52 retry) unchanged.
- **Builds on** M50/M50b (xmom cascade), M51 (paper-gate unblock — the soak this rides on), M52/M52a
  (force_close slot recovery — EXP-018 is the M52 soak read that surfaced this finding).
- **Source analysis:** `docs/analysis/20260704-m52-force-close-retry-soak-analysis.md` (EXP-018);
  research scripts `packages/analysis/research/xmom_tp_arm_reconstruction.mjs` and
  `xmom_tp_ratio_replay.mjs`.
- **Does not affect** the M44 shadow-fidelity gate or the M50 live-promotion gate — both remain open.
