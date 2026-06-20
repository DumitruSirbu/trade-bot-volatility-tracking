# M40 — Halt must never block a protective close (go-live blocker) + shadow `simulated_fill` regression

> **Sequencing note:** M40 is a **trading-safety + measurement-integrity** milestone surfaced by the
> 2026-06-17 paper-soak trade analysis
> (`docs/wip/2026-06-17-halt-blocks-protective-close-and-shadow-fill-regression.md`). D1 is a
> **go-live blocker**: a global halt currently freezes every open position's stop-loss and time-stop.
> D2 repairs the shadow counterfactual fill series that collapsed to ~0/day since ~June 10 (contradicting
> STATUS.md). Every `CLAUDE.md` trading-safety invariant holds: no order path bypasses the risk gate,
> strategies stay pure/deterministic, money is `decimal`, no LLM in the live loop, and D1 *strengthens*
> the kill-switch rather than weakening it. D1 touches the live trade path; D2/D4 are shadow/lifecycle
> only and never touch the exchange.

## Findings → scope decision (at a glance)

| # | Finding | Severity | M40 scope |
|---|---------|----------|-----------|
| 1 | Global halt short-circuits *every* intent, including protective closes (position #101 frozen 2h12m through its stop) | **CRITICAL (go-live blocker)** | **D1 — IN.** ADR 0046 + three-gate executor fix + regression tests (non-clean-under-halt residual owned by D4). |
| 2 | Shadow `simulated_fill` collapsed to ~0/day since ~June 10 despite M37/M39 "fixed" claims | **HIGH** | **D2 — IN (investigation-first).** Confirm root cause, fix, re-qualify STATUS/milestone-log. |
| 3 | `market_stress:multi` halt did not auto-resume for 2h12m (manual resume required) | **MEDIUM** | **D3 — DEFERRED (documented).** By-design `multi`-lock; D1 removes the harm. See §D3. |
| 4 | Zombie `pending_open` row #38 (ZEC) stuck since 2026-06-15 | **MEDIUM** | **D4 — IN.** Paper-safe stuck-row sweep — orphaned `pending_open` + `RECONCILING`-parked (owns the D1 §2.1a residual). |
| 5 | TP-with-negative-PnL (monitor) | LOW | **Out.** Already clean on 6/17; monitor 2-3 more days (M37 P3 / M38 D1 follow-up). |

---

## D1 (CRITICAL, go-live blocker) — Halt blocks new risk only; closes always execute

### Root cause (confirmed by code read)

`ExecutionService.handleApproved` (`apps/engine/src/execution/service/ExecutionService.ts:163`)
short-circuits **every** approved intent under `haltFlag.isHalted()` with no action distinction.
The classifier `isOpenOrAddIntent` already exists (`:235`) and is used downstream (`:210`), but the
halt branch never consults it. Two upstream layers already assume the opposite scoping:

- **ADR 0004 §2** — the risk gate auto-approves de-risking; the enforcer/monitor treat a gate reject
  on a close as a *contract violation*. So a CLOSE arrives at `handleApproved` already APPROVED and is
  then dropped only by this executor short-circuit.
- **ADR 0021 §2.4/§2.5** — the operator kill-switch's `flattenOpenPositions: true` enqueues CLOSE
  intents expecting "de-risking always allowed during halt." That feature is **itself currently broken**
  by the same gates.

### The fix spans THREE halt gates, not one (BLOCKER from logic review — confirmed by code trace)

Narrowing only `:163` is **insufficient and self-defeating**. The executor has three halt gates on the
live order path; a de-risking close must pass all three to reach CLOSED:

1. **`handleApproved` entry gate (`:163`)** — drops the intent before `executeLive`.
2. **`runSubmitStateMachine` per-attempt gate (`:565`)** — returns `ABORTED, fillSummary=null` *before
   `submitOnce` is ever called* (`:570`), so the close order never reaches `submitter.submit` (`:615`).
   The null-fill reduce terminal then escalates via `ORDER_INTENT_UNKNOWN_EVENT` (`:272-278`) →
   `ReconciliationService.onOrderIntentUnknown` (`:297`) moves the row to `RECONCILING` →
   `runTickNow` is a **PAPER no-op** (`:433`) → the position parks in `RECONCILING` and **still never
   closes**, now having left the state the enforcer/monitor re-fire from. This is **worse** than the
   pre-fix retry loop.
3. **`resolveReduceTerminal` recursion guard (`:808`)** — aborts the reduce-remainder recursion; this
   path only ever runs for REDUCE_MARKET.

All three are scoped with the **same** `isOpenOrAddIntent` inverted-whitelist predicate so an intent
permitted at one gate is not aborted at the next (a value allowed at `:163` but aborted at `:565` would
be an inconsistent fail-direction — forbidden). See ADR 0046 §2.1.

### Production evidence

Position #101 INJ long: `market_stress:multi` halt at 18:05; time-stop (due 18:15) and SL breach both
short-circuited and retried unfilled for 2h12m until a manual `/v1/control/resume` at 20:17. (The exact
per-trade USDT delta is a single-sample observation, **not** a guaranteed fill improvement — it is NOT an
acceptance target; see A1.)

### Decision (ADR 0046) — exempt-closes (Option A), force-flatten stays opt-in

Scope all three halt gates to fire only for risk-increasing intents:

```ts
// at :163 and :565
if (this.haltFlag.isHalted() && this.isOpenOrAddIntent(event.intent.intentAction)) { /* abort OPEN/ADD only */ }
// at :808 — same predicate; in practice stops aborting the de-risking close entirely (REDUCE_MARKET-only path)
```

REDUCE / CLOSE / FLATTEN submit, recover, and fill **end-to-end** under halt; only OPEN / ADD abort.
**Force-flatten on a market-stress halt is NOT made the default** — the project's settled policy
(ADR 0021 §2.4) is "stop new risk, preserve existing stops"; forced exits into stress realise worse fills
than standing protective orders. The operator keeps `flattenOpenPositions: true` as the explicit opt-in
(which D1 makes functional for the first time). Rationale fully argued in ADR 0046 §2.2/§4.

### Files (indicative; ≤5 per dispatch)

1. `docs/architecture/adr/0046-halt-exempts-risk-reducing-intents.md` — **already written** (architect).
2. `apps/engine/src/execution/service/ExecutionService.ts` — the predicate narrowing at **all three**
   gates (`:163`, `:565`, `:808`), each with a comment cross-referencing ADR 0046 §2.1 and
   `isOpenOrAddIntent` as the single, uniform halt-scoping authority.
3. `apps/engine/src/execution/service/__tests__/ExecutionService.*.spec.ts` — paired regression tests
   (QA, see acceptance).

> **No shared-contract change, no migration, no new state.** The classifier and the enum already exist.

### Acceptance criteria (D1)

- **A1 (the core regression, end-to-end):** open position + `haltFlag` set + a CLOSE intent (time-stop or
  SL breach) **submits, fills, and the row transitions to CLOSED** — it passes all three gates, reaches
  `submitter.submit`, and finalizes. It must NOT emit `ORDER_INTENT_EXPIRED_REASON_HALTED` and must NOT
  park in `RECONCILING`. **Price-agnostic** — assert the close fills and the state reaches CLOSED, never a
  specific realized-PnL or exit-price figure (the 2h12m harm, not the exact USDT delta, is the defect).
- **A2:** an OPEN intent under halt **still** short-circuits at `:163` (releases reservation, emits
  `…_REASON_HALTED`) and, were it to reach `:565`, still aborts there. An ADD under halt likewise still
  aborts at every gate. Includes a `market_stress:multi` halt: D1 must not let new OPENs through for any
  halt suffix.
- **A3:** a FLATTEN intent under halt submits and fills end-to-end to CLOSED (covers M38 D2 unwind +
  ADR 0021 operator force-flatten).
- **A4 (adversarial, rewritten):** the close **submits and fills to a CLOSED row under halt**, exercising
  the `:565` gate specifically — i.e. a test where the intent passes `:163` and the halt is still set when
  `runSubmitStateMachine` runs must reach `submitter.submit`, not `ABORTED`. Separately: halt cleared
  mid-flight for an OPEN — no double-submit. (The earlier wording — "`:565`/`:808` unchanged" — was
  self-contradictory and is removed; those gates ARE changed.)
- **A5:** REDUCE (partial de-risk) under halt submits and fills (or partially fills) end-to-end, never
  aborting before `submitter.submit`.
- **A6 (slot lifecycle — CLEAN fill only):** along the **clean-fill** permitted-close path the shared
  close slot is released on the `CLOSING → CLOSED` transition by **both** producers —
  `PositionTimeStopEnforcer.onPositionStateTransitioned` (`:107`, time-stop path) **and**
  `LocalProtectiveMonitor.onPositionStateTransitioned` (`:227-232`, SL/TP-breach path; this is the actual
  #101 SL-breach case) — **not** via a `halted` expiry. Assert the slot is not leaked on the clean close.
  The genuinely-transient `RETRIABLE` reject is covered by the in-loop re-submit at `:564` (not a
  slot-release-and-re-fire) — assert that retry path resubmits rather than parks. See ADR 0046 §2.1a.
- **A6b (non-clean-under-halt residual — KNOWN, must be tested, NOT silently stranded):** a permitted
  close that terminally fails **non-clean** under halt (retry budget exhausted → `RECONCILE_REQUIRED`, or
  a TERMINAL/ABORTED reject) routes through `handleReduceTerminal` non-clean (`:267-285`), which releases
  only the order reservation and emits `ORDER_INTENT_UNKNOWN_EVENT` → row parks in `RECONCILING` with the
  close slot still held (no PAPER reconciliation driver). This is a **known residual of §2.1**, not solved
  by it. Assert that such a row is eventually reclaimed by **D4's stuck-row sweep** (extended to cover
  `RECONCILING`-parked rows; see D4 / C8): the close slot is released and the row finalized, so it is
  never permanently stranded. (Do NOT assert an executor-side re-fire — the engine has no such path.)
- **A7:** no regression to the dry-run path (`:157`) or the reduce-family escalation path (`:210`).

---

## D2 (HIGH) — Shadow `simulated_fill` collapsed to ~0/day since ~June 10

### Investigation-first (the report's suspected cause is likely WRONG — confirm before coding)

The report hypothesised the in-memory deferred-walk queue (`IPendingDeferredWalk`, M39 W2) is dropped on
restart so `simulated_fill` is never written. **A code read contradicts this as the primary cause:**
`simulated_fill` is written **synchronously** in `persistShadowDecision`
(`ShadowStrategyOrchestratorService.ts:770` — `simulatedFill: openData?.simulatedFill ?? null`). The
deferred walk only **upgrades** an already-written fill (`updateSimulatedFill`). So a dropped deferred
queue would leave W1-only ≈0-PnL fills, **not zero fills**.

The 0-fill symptom (47 gate-allowed opens, 0 populated fills on 6/17) means `openData` is `null`, which
happens when `shouldSimulateFill && !hasNextBarEntry` — i.e. `evidence.nextBarOpenPrice === null`, i.e.
`loadSignalBarEvidence` returned **no signal-bar `tick_aggregates`** (`:263-278`). The shadow path runs
at `nowMs = event.entryCandleOpenTime + CANDLE_INTERVAL_MS` (the instant the signal bar closes;
`StrategyService.ts:127`) and immediately reads `loadTicksForBar(symbol, event.entryCandleOpenTime)` over
`[barOpen, barOpen+5m)`. **Leading hypothesis: the signal-bar tick aggregates are not yet persisted at
the moment the volatility event fires** (a flush-timing / ordering gap between
`MarketDataPersistenceListener` and the volatility detector), so every accepted open is declined as a
"conservative missing-data miss" and `simulatedFill` is null.

**D2.0 (mandatory first work item):** the engine specialist confirms the actual mechanism on the soak DB
before any fix lands. Candidate mechanisms to discriminate, with the decisive query/log per item:
- **(a) signal-bar ticks absent at event time** (leading) — count gate-allowed shadow opens whose signal
  bar has zero `tick_aggregates` rows at `runShadows` time; check for the `loadSignalBarEvidence`
  "no tick_aggregates for signal bar" debug log volume since ~June 10.
- **(b) tick-aggregate partition/retention** — were the relevant daily partitions present/queryable in
  the window (`TickAggregatePartitionService`)? A dropped or not-yet-created partition would also yield
  empty `loadTicksForBar`.
- **(c) deferred-walk durability** — secondary; only explains W1-only (≈0 PnL) rows, not zero rows.
  Quantify how many fills are present-but-force_close vs. truly absent.

### Fix (scope per confirmed mechanism — decide in the impl brief after D2.0)

- If **(a)/(b)**: the fix is a **timing/ordering or read-window correction** so the shadow evaluation sees
  the signal bar's ticks. The **only** acceptable remedies are:
  - run the shadow pass off a **tick-persist-complete signal** (the shadow evaluates once the signal bar's
    `tick_aggregates` are durably written), or
  - a **bounded retry / backfill of the *signal-bar* evidence** (re-read `loadTicksForBar` after the ticks
    land).

  > **HIGH-1 (quant) — DO NOT "read the bar from the same source the live active path used."** False
  > premise: the live ACTIVE path reads **no** `tick_aggregates` — it derives the entry/reference price
  > from the event payload via `reconstructReferencePrice` (`StrategyService.ts:214` →
  > `apps/engine/src/strategy/utils/entryHelpers.ts:42`: `vwapSession × (1 + vwapDeviationPct/100)`).
  > The shadow path is the **only**
  > synchronous tick consumer at event time (`:264`) — that asymmetry is *why* a flush-timing gap degrades
  > only the shadow series (it confirms mechanism (a)). Substituting the event-derived live reference would
  > turn the counterfactual **fill** into a restatement of the live **decision** and risks look-ahead. The
  > entry reference MUST stay tick-derived (signal-bar last-tick close, `:275`).

  Determinism invariant holds: evidence and entry reference stay tick-derived, never wall-clock; the
  shadow path stays fire-and-forget and never blocks the live path.
- If **(c)** contributes materially: **persist pending deferred walks** (durable queue) OR add a
  **backfill sweep** that re-walks force_close rows once next-bar ticks exist, so a restart between bar N
  and N+1 does not orphan the upgrade. Prefer the backfill sweep (idempotent, restart-proof, no new
  hot-path state) unless D2.0 shows durability is cheaper.

### Re-qualification (mandatory, regardless of fix shape)

The M37 D1.6 / M39 W2 "fixed" claims and `STATUS.md` line 9 ("non-degenerate realized PnL") are
**contradicted by production**. The scribe MUST, once D2 lands and prod shows non-zero fills:
- correct `STATUS.md` to state the shadow fill series was degenerate ~June 10 → M40 and is now verified
  non-zero (with the date/count evidence);
- append a re-qualification note to `docs/milestone-log.md` against M37/M39 (claim held in test, regressed
  in prod, root cause + M40 fix).

### Files (indicative; ≤5 per dispatch)

1. `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` and/or
   `apps/engine/src/market-data/service/MarketDataPersistenceListener.ts` (per confirmed mechanism).
2. `apps/engine/src/market-data/repository/TickAggregateRepository.ts` (only if a read-window change).
3. Paired specs under `strategy/service/__tests__/` (and market-data if touched).
4. `docs/architecture/adr/0029-…` amendment (only if the shadow-evaluation timing contract changes —
   architect call; a pure timing-bug fix may not need an ADR touch).

### Acceptance criteria (D2)

- **B0:** D2.0 investigation note states the confirmed mechanism with the discriminating query/log
  evidence (in the impl brief / work-log, not a standalone report file).
- **B1 (CONDITIONAL on D2.0 = mechanism (a)/(b)):** after the fix, a gate-allowed shadow OPEN with
  signal-bar ticks present produces a non-null `simulated_fill` **in the same `runShadows` pass**
  (synchronous path) — asserted in a unit test. **If D2.0 finds the dominant mechanism is (c)
  deferred-walk durability**, a synchronous same-pass non-null fill is already produced (W1) and is NOT
  the gap; B3 governs instead and B1 is satisfied trivially by the existing synchronous write.
- **B2:** the "no signal-bar ticks" decline path still produces a conservative miss (not a fabricated
  fill) — the fix must not paper over genuinely-missing data.
- **B3 (if (c) in scope):** a force_close row whose next-bar ticks land after a simulated restart is still
  upgraded (durable queue) or swept (backfill); restart does not strand it.
- **B4:** determinism preserved — no `Date.now()` in the evidence/entry path; the entry reference stays
  the tick-derived signal-bar last-tick close (never the live event-derived `reconstructReferencePrice`);
  shadow run stays fire-and-forget (a shadow failure cannot cascade into the live path).
- **B5 (prod verification gate — distribution, not just count; HIGH-2):** after deploy, `shadow_decisions`
  shows non-zero `simulated_fill` for gate-allowed opens over ≥1 full soak day **AND** the `close_reason`
  distribution among populated fills is non-degenerate — a non-trivial fraction of `sl` / `tp` /
  `time_stop`, **not ~100% `force_close`**. A populated-but-all-`force_close` series (≈ −fees by
  construction, post-entry window ≈ entry tick in live eval) would pass a naïve "non-zero fills" check
  while realized PnL stays degenerate; B5 must confirm the deferred-walk **upgrade** (`:522-530`) is
  landing, not merely that the synchronous W1 fill is written. STATUS/milestone-log re-qualified only
  after this holds.
- **B6 (window discipline; quant MEDIUM):** any promotion/comparison query that consumes the realized
  series MUST **exclude the June-10 → M40 degenerate window** (near-zero populated-fill denominator) —
  pair this with the existing "do not backfill legacy hollow rows" non-goal. A version verdict spanning
  that span is statistically meaningless; the D3-gate window `from` must be ≥ the M40 D2 deploy timestamp.
  **Impl-brief check:** B6's *window* exclusion is a **distinct** mechanism from any *per-row* force_close
  exclusion (the existing `forceCloseAbstain` guard in `packages/analysis` — confirm it still exists and is
  wired where the `ShadowStrategyOrchestratorService` comment claims). Do not assume the two are the same
  guard; B6 must hold on its own window predicate even if `forceCloseAbstain` already filters per row.

---

## D3 (MEDIUM) — `market_stress:multi` did not auto-resume — DEFERRED (documented)

### Finding is by-design, not a bug

`MARKET_STRESS_RESUME_ELIGIBLE_LEGS` contains only `breadth` and `same_bar`
(`RiskGateService.isStressLegAutoResumeEligible`, `:664`; `StressHaltEvaluator` doc §6d). A `:multi`
suffix (≥2 stress legs engaging together) is the *most-conservative* classification and is intentionally
**full-day locked / manual-resume only** — every non-`breadth`/`same_bar` suffix stays locked
(M23/M28 design, ADR 0004 §6d/§6e). The 2h12m wait was the system behaving as specified for `multi`.

### Why deferred

D1 removes the *harm*: with closes exempt from the halt, an open position during a `:multi` halt closes
normally on its time-stop / SL, so the manual-resume latency no longer endangers open exposure — it only
delays *new* opens, which is exactly what a conservative `multi`-lock is supposed to do. Adding `multi`
auto-resume is a **risk-posture change** (relaxing the most conservative halt class) that deserves its own
milestone, evidence, and quant sign-off — not a rider on a safety hotfix. **Recommend a separate future
milestone** if soak data later shows `multi` locks are over-frequent. No code in M40.

> One thing to confirm in D1's test wave (cheap, no scope creep): that a `:multi` halt still blocks new
> OPENs (D1 must not accidentally let opens through for `multi`) — covered by D1 acceptance A2.

---

## D4 (MEDIUM) — Paper-safe stuck-row cleanup sweep (orphaned `pending_open` + `RECONCILING`-parked)

### Root cause (confirmed by code read)

Zombie #38 (ZEC) is `state=pending_open`, `qty=0`, stuck since 2026-06-15 (the
`pending_open → open` `protective.attached` transition never fired). It is **not** the M31 case (M31
handles `qty=0` rows mislabeled `open` and the close-path lifecycle; #38 never reached `open`). And it is
**not** caught by `ReconciliationService`: the entire reconciliation tick is a **no-op under PAPER mode**
(`ReconciliationService.runTickNow`, `:433`), and the soak runs PAPER. So nothing has a cleanup path for
an orphaned `pending_open` in paper.

### Design — a paper-safe, exchange-free stuck-row sweep (orphaned `pending_open` + `RECONCILING`-parked)

A periodic (and boot-time) sweep that transitions a **stuck non-terminal** row to a terminal state when
it has sat past a small multiple of the open timeout without progressing. It covers **two** stuck shapes,
both unreachable by the PAPER-no-op reconciler:

1. **Orphaned `pending_open`** (the #38 ZEC case) — a row that never fired
   `pending_open → open` (`protective.attached`).
2. **`RECONCILING`-parked** (the D1 / ADR 0046 §2.1a residual) — a row driven to `RECONCILING` by a
   non-clean permitted close under halt (or any `ORDER_INTENT_UNKNOWN_EVENT` escalation) that, under
   PAPER, has no reconciliation driver and would otherwise hold its close slot forever. **This sweep is
   the named owner of that residual** (A6b).

Constraints:

- **No exchange call** — works in PAPER (and live). A stuck `pending_open` with `qty=0` carries no
  exchange exposure (verified: `risk_state.open_exposure=0` with #38 present), so the sweep is a pure
  local lifecycle finalize.
- **PIN THE EXACT STATE-GRAPH ARROWS (logic MEDIUM — verified against `positionStateGraph.ts:26-31`).**
  From `PENDING_OPEN` the graph allows only `{ OPEN, RECONCILING }`; from `RECONCILING` only
  `{ OPEN, CLOSED, MANUAL_ADOPTED_UNMANAGED }`. So:
  - orphaned `pending_open` → terminal is the **two-step** `pending_open → reconciling → closed`
    (the same M6 R1.1.2 source-state routing `handleDbOpenNotOnExchange` uses for PENDING_OPEN,
    `:1111-1119`);
  - a `RECONCILING`-parked row → terminal is the **one-step** `reconciling → closed` (a legal arrow).

  The impl MUST route through `PositionService.transition` along these arrows — never assume a direct
  `pending_open → closed`. Exit reason: pick from the existing `ExitReasonEnum` (e.g. `FORCE_CLOSE`);
  **no new shared enum value unless unavoidable** (architect adjudicates; route any shared change through
  `bot-shared-maintainer`).
- **Reclaim the close-coordinator slot for the `RECONCILING`-parked case.** Unlike the never-filled
  `pending_open` (which holds no close slot), a `RECONCILING`-parked row reached its state via an
  in-flight close and **still holds the shared close slot** (`handleReduceTerminal` non-clean releases
  only the order reservation, `:285`, not the slot). The sweep MUST release the close slot
  (`closeCoordinator.release`) when finalizing such a row.
- **Release the slot reservation conditionally + idempotently.** #38 shows no exposure leak today
  (`open_exposure=0`), so a reservation may already be absent. Both the order-reservation release and the
  close-slot release MUST be no-ops when nothing is held (a blind `releaseReservationSafely` /
  `closeCoordinator.release` on an already-released slot must NOT double-release) — confirm presence first
  or use the existing safe/idempotent primitive. The sweep must leave `assertSlotAccountingInvariant`
  clean.
- **Threshold as a named constant** at the highest level (config/const), never a magic number buried in
  the sweep — mirrors the protective-attach timeout, with margin. The `RECONCILING`-parked threshold may
  reuse the same constant or a sibling; pin it in the impl brief.
- **Deterministic clock** — the `@Interval` boundary reads `Date.now()` once and injects it down (the
  documented reconciliation/enforcer exception); the comparison is `nowMs >= referenceTs + threshold`
  (use `openedAt` for `pending_open`; for `RECONCILING` use the row's last-transition timestamp so a
  freshly-reconciling row is not swept prematurely).
- **Scope guard:** only `pending_open` and `reconciling` rows older than the threshold; never touch
  `open`, `closing`, `manual_adopted_unmanaged`, or any row younger than the window. **Live-mode
  interaction:** in LIVE the real `ReconciliationService` owns `RECONCILING` rows — the sweep's
  `RECONCILING` branch must therefore be **PAPER-scoped** (or use a threshold safely larger than the
  reconciliation tick) so it never races the live reconciler. Pin the env-scoping in the impl brief.

> **Open question for the impl brief:** does this live as a new tiny service, or as a paper-safe branch
> inside an existing lifecycle sweeper? Prefer reusing an existing periodic sweeper (the time-stop
> enforcer's `@Interval` or a lifecycle-retention listener) over a brand-new service if it fits cleanly,
> to avoid a new DI surface. Architect/engine decide in the brief.

### Files (indicative; ≤5 per dispatch)

1. `apps/engine/src/position/service/…` — the sweep (new small service OR a paper-safe branch in an
   existing sweeper) + `PositionRepository` query for stale `pending_open` **and** `reconciling` rows.
2. `apps/engine/src/position/const/…` (or config) — the threshold constant(s).
3. Paired specs under `position/service/__tests__/`.

### Acceptance criteria (D4)

- **C1:** a `pending_open` row older than the threshold transitions to terminal via the **two-step**
  `pending_open → reconciling → closed` arrow (the only legal path; see design); a younger one is
  untouched. A test asserts the intermediate `RECONCILING` transition is legal and lands.
- **C2:** runs in **PAPER** (the reconciliation no-op does not apply) — explicitly asserted, since this is
  the whole point (#38 is a paper zombie).
- **C3:** no exchange call on the sweep path.
- **C4 (idempotent + conditional release):** re-running the sweep on an already-terminal row is a no-op;
  the order-reservation release **and** the close-slot release are each **conditional on something
  actually being held** — a blind release on an already-released/absent reservation or slot is a no-op,
  never a double-release — with no leak and no `assertSlotAccountingInvariant` violation.
- **C5:** boot-time pass catches a row already stale at startup (so #38 clears on the first M40 deploy).
- **C6 (determinism):** the deadline compares against the injected `@Interval` boundary clock, not an
  inline `Date.now()` in the comparison.
- **C7 (zero-PnL / not a trade; quant MEDIUM):** the swept **never-filled** orphaned row contributes
  **exactly zero** realized PnL and is **excluded** from `risk_state.trades_count`, win-rate, and drawdown
  denominators — an abandoned, never-filled open is not a trade. Assert the finalize writes
  `realizedPnl = 0` (or null, per the finalize contract for a never-filled row) and does not increment the
  trade counters that feed the soak's performance metrics.
- **C8 (RECONCILING-parked residual reclaim; owns ADR 0046 §2.1a / A6b):** a row driven to `RECONCILING`
  by a non-clean permitted close under halt (held close slot, PAPER, no reconciler) older than the
  threshold is finalized via the one-step `reconciling → closed` arrow **and its held close slot is
  released** (`closeCoordinator.release`), so the position is not permanently stranded and the slot is not
  leaked. A test reproduces the non-clean-close-under-halt → RECONCILING-park shape and asserts the sweep
  reclaims it. (A partially-filled `RECONCILING` row's realized PnL follows the finalize contract — it is
  NOT forced to zero like the never-filled C7 case.)

---

## Cross-cutting non-goals (explicit)

- **Do not make force-flatten the default halt behaviour** (ADR 0046 §2.2 / §4).
- **Do not relax the `:multi` halt class** (D3 deferred).
- **Do not raise `SHADOW_GATE_MAX_OPEN_POSITIONS`** or touch the live trade path from D2/D4.
- **Do not add a persisted shadow `realizedPnl` field** (settled in M39).
- **Do not backfill legacy hollow shadow rows**; D2's prod-verification window must be post-M40.
- **Do not introduce a new shared-contract type** unless D4's exit-reason genuinely has no fit in
  `ExitReasonEnum` (architect call; route any such change through `bot-shared-maintainer`).

## ADRs

- **ADR 0046 (new, written)** — halt blocks new risk only; risk-reducing closes always permitted;
  force-flatten stays opt-in. Registered in the ADR index.
- **ADR 0029 amendment (D2, conditional)** — only if the shadow-evaluation timing/evidence contract
  changes materially. A pure flush-timing bug fix may not need an ADR touch — architect decides after
  D2.0.
- **No ADR for D3** (no change) and **likely none for D4** (lifecycle hygiene within the existing state
  graph) unless D4 adds an exit reason.

## Dispatch waves

D1 is the go-live blocker and ships first; D2 (investigation-led) and D4 follow. Keep each wave ≤5
items/files (`dev-qa-cycle.md`).

1. **Serial (architect):** ADR 0046 (done) + adjudicate whether D2 needs an ADR 0029 amendment after
   D2.0, and the D4 exit-reason/host-service question. Architect on every contract touch.
2. **Serial (engine, D2.0 ONLY):** confirm the shadow 0-fill mechanism against the soak DB; write the
   finding into the work-log/impl brief. No fix code in this step.
3. **Parallel (engine):**
   - D1 — `ExecutionService` three-gate halt-predicate narrowing (`:163`/`:565`/`:808`, one file +
     per-gate comments; note `:808` reads `intent.intentAction`, not `event.intent…`).
   - D4 — stuck-row sweep (orphaned `pending_open` + `RECONCILING`-parked residual).
   - D2 — fix per the D2.0-confirmed mechanism.
   Sequenced per the ≤5-file rule. D1's **core** fix (closes execute end-to-end) deploys independently; the
   **non-clean-under-halt residual (A6b) is owned by D4 C8**, so D1 + D4 should land together for complete
   residual coverage (D1 alone still strictly improves on today — the rare non-clean case parks rather than
   the common case freezing).
4. **Serial (QA, adversarial):** paired tests per item — D1 A1-A7 (incl. halt-during-close end-to-end,
   OPEN-still-blocked at every gate, clean-fill slot release by BOTH producers, **A6b** non-clean-under-
   halt residual reclaimed by the D4 sweep), D2 B1-B6, D4 C1-C8 (incl. **C7** metrics-denominator exclusion
   and **C8** RECONCILING-parked reclaim). Failing tests route to the architect, not back to the developer.
5. **Parallel (reviewers):** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   `bot-review-quant` (quant on D2's series integrity + D3 deferral rationale). Cycle until zero
   blockers, zero highs, majority of mediums resolved; reviewer continuity across rounds.
6. **Serial (scribe):** work-log + STATUS (re-qualify the shadow-fill claim per D2 B5) + milestone-log
   (M37/M39 prod-regression note) + ADR index already updated.

## Post-deploy verification (operator + scribe)

- **D1:** next time any halt fires with an open position, confirm in logs that the time-stop / SL close
  fills under halt (no `…_REASON_HALTED` on the close eventId). This is the go-live unblock evidence.
- **D2:** `shadow_decisions` shows non-zero `simulated_fill` for gate-allowed opens over ≥1 full soak day
  (B5); then re-qualify STATUS + milestone-log.
- **D4:** #38 (ZEC) reaches a terminal state on first M40 boot; no new orphaned `pending_open` rows
  accumulate.
