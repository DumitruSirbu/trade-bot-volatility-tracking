# M25 — Paper exploration enablement (activate v2, paper-only stress relaxation, slot/exposure/capital bump)

> **Sequencing note:** M25 is the second milestone of the data-fix arc (M24→M25→M26→M27) from the
> architect analysis [main-architector-paper-soak-fill-and-gate-analysis.md](../../wip/done/main-architector-paper-soak-fill-and-gate-analysis.md)
> (analysis items **P1+P2+P3**). It lands **strictly after M24** — M24 makes a gate-approved open
> actually fill; M25 makes the gate *approve* opens (and approve more of them, concurrently) so the
> paper soak produces a real win/loss outcome stream. **Every relaxation in M25 is gated on
> `EXCHANGE_ENV=paper`**; live and backtest defaults are untouched, preserving the live/backtest
> determinism contract (ADR 0029, ADR 0032) and the trading-safety invariants in `CLAUDE.md`. This is
> an explicit **risk-loosening** milestone for *exploration data collection*, not a change to live risk
> posture — which is exactly why it gets its own visible review trail rather than silent env edits.

## Context

After M24, opens fill — but the soak still produces almost nothing to label, for two reasons the
analysis proves with the 14-day funnel:

- **Strategy (P1):** the active version is **v1 mean-reversion**, deliberately ultra-conservative —
  it emits `skip` 761× and reaches the gate with only 350 open intents in 14 days. Shadow **v2
  momentum** emits **583** open intents on the same `event_id` tape (v3 hybrid skips all catalyst
  flow). v2 is the version with appetite to generate volume.
- **Gate (P2):** of those 350, ~78% are rejected by **day-level stress halts** (`global_halt` 66% +
  `market_stress` 12%). Once a UTC day is halted, even deep tier-1 names are rejected. The stress
  thresholds are **engine constants** (`StressHaltEvaluator`), and M23 auto-resume only clears the
  **breadth** leg — BTC/ETH shock, OI, funding, spread, and multi-leg halts lock the full day.
- **Concurrency (P3 — the "5 positions" ask):** the live gate **ignores `MAX_OPEN_POSITIONS`**.
  Concurrency is a hard-coded **3-slot model** (`SlotManager`: `MAX_IDIOSYNCRATIC_SLOTS=2` +
  `MAX_BTC_CORRELATED_POSITIONS=1`). Adding capital alone changes nothing — the binding constraints
  are slot count and `MAX_EXPOSURE_PER_COIN_USDT` ($100 default), not `ACCOUNT_CAPITAL_USDT` ($500).

```461:480:apps/engine/src/risk/service/RiskGateService.ts
    private async firstFailingHaltCheck(context: IRiskGateContext, state: ILoadedState): Promise<RejectReasonEnum | null> {
        if (!Number.isFinite(context.nowMs)) {
            return RejectReasonEnum.GLOBAL_HALT;
        }
        // ... M23 UTC rollover resets ...
        if (context.modelDivergenceDetected) {
            return RejectReasonEnum.MODEL_DIVERGENCE_HALT;
        }
        if (state.today !== null && state.today.isHalted) {
            const dayHaltReason = await this.resolveDayHalt(context, state);
            if (dayHaltReason !== null) {
                return dayHaltReason;
            }
        }
```

The gate's conservatism is **correct for live capital**; it is mis-tuned for a paper *exploration*
soak whose whole purpose is to collect labeled outcomes — including some bad ones.

## Review amendments (locked 2026-06-08 — 3 independent analysts)

Independent reviews (`docs/archive/independent-analysis/{composer,gbt,gemini}/M25-*`) **approve the direction**
(v2 activation + paper-gated non-breadth stress relax + sizing headroom, architect-first, gate-in-path,
M24 prerequisite) but flagged **code-verified** corrections. All are folded into the scope below:

- **A1 (must-fix) — P3 cannot reach 5 concurrent positions; target is 3.** `PositionSlotEnum` has only
  `{A, B, C}` (`packages/shared/src/enum/PositionSlotEnum.ts`) — the physical ceiling is **3**, matching
  architect §3. Worse, `isSlotCFreeForIdiosyncratic` borrows slot C only when
  `idiosyncraticCount >= MAX_IDIOSYNCRATIC_SLOTS` (`SlotManager.ts:61-66`); raising the constant above 2
  means the count can never reach the threshold (only A/B exist), so **C never opens and capacity drops
  to 2** — a regression. **Decision (user, 2026-06-08): keep the A/B/C contract, honest target = 3
  concurrent, sizing/exposure env headroom only.** `MAX_IDIOSYNCRATIC_SLOTS` stays **2** (and a paper
  override `> 2` is **rejected at boot**, not silently applied). True N-slot expansion is deferred to a
  separate follow-on (shared-contract change: enum + `SlotManager` + read-api mappers + dashboard +
  backtest replay + persistence + ADR). **No `packages/shared/` change in M25.**
- **A2 (must-fix) — P2 leg semantics must be exact and single-sourced.** `StressHaltEvaluator` has two
  coupled surfaces (`isStressed` and `classifyHaltLeg`); if the flag relaxes one but not the other, the
  stress verdict and persisted `halt_reason` suffix diverge and break M23 resume eligibility. Lock the
  per-leg table (below) and require **one shared helper** consumed by both surfaces.
- **A3 (must-fix) — typed, fail-safe env validation.** New flags route through `EnvironmentVariables` +
  `AppConfigService` with strict parsing (exact `true`, not string truthiness), default-off, typed
  getters injected into services — no ad-hoc `process.env` reads in risk services. `validateEnv.spec.ts`
  covers each new var; the paper slot var rejects `> 2`.
- **A4 (must-fix) — sizing headroom is incomplete.** `checkExposureCaps` also enforces
  `maxSameDirectionExposureUsdt` (`RiskGateService.ts:1068-1081`), so raising only per-coin + capital
  leaves same-direction as the new ceiling. Include `MAX_SAME_DIRECTION_EXPOSURE_USDT` in the profile,
  and **decide `PAPER_STARTING_EQUITY_USDT`** (raise with capital for a fresh soak, or keep $500 with an
  explicit note on what that means for drawdown telemetry). Also verify the rate-limit invariant
  `MAX_OPEN_POSITIONS × PER_SYMBOL_ORDERS_SHARE ≤ 1.0` — may require `MAX_OPEN_POSITIONS=3` in paper
  `.env` for the rate-limit math even though the gate ignores it for slots.
- **A5 (should-fix) — strategy-version row.** Before restart, confirm DB id `3` is **v2 momentum** and
  loadable by the active loader even if its row `status=shadow`. If the loader requires `status=active`,
  that is a `strategy_versions` **DB write** → pg_dump + confirmation rules apply (the "config-only, no
  DB write" framing holds only if the loader accepts a shadow row). Warn against accidental id `4`
  (v3 hybrid skips catalyst flow — wrong for volume).
- **A6 (should-fix) — acceptance gates.** (a) Verify **M24 actually landed** (unit proof: gate-approved
  crossing IOC fills, non-zero price, event-time `tsMs`) before enabling M25 flags. (b) `clearHaltForDate`
  is **evidence-gated**: current row halted, halt predates M25 / is caused by a relaxed leg, breadth not
  currently stressed, operator confirms the date. (c) Funnel check splits outcomes into *no approvals* /
  *approvals with missed fills* / *approvals with filled opens*, with quantified targets.

## Scope

M25 has three sub-changes, ordered by how much code they touch. P1 is config-only; P2 and P3 are
small, **paper-gated** code changes.

### P1 — Activate v2 momentum (config-only)
1. Set `ACTIVE_STRATEGY_VERSION_ID=3` (DB id 3 = strategy version 2 momentum) in the paper `.env`.
   No code change. This is the open-volume driver (shadow proved 583 open intents vs v1's 0 gate
   approvals on the same tape).

### P2 — Paper-only stress relaxation (small code + a no-code lever)
2. **No-code lever first:** raise the active version's strategy param `stress_same_bar_trigger_count`
   (the only stress threshold that is a strategy param, default ≥5) and confirm
   `MARKET_STRESS_AUTO_RESUME_ENABLED=true` (paper default-on per M23).
3. **`PAPER_RELAX_MARKET_STRESS` env flag** honored when `EXCHANGE_ENV=paper`, implemented through a
   **single shared helper in `StressHaltEvaluator`** consumed by **both** `isStressed` and
   `classifyHaltLeg` (A2) so the stress verdict and the persisted `halt_reason` suffix cannot diverge.
   `RiskGateService` only passes the typed `paperRelaxMarketStress` config through — no duplicate relax
   logic. When unset, or when `EXCHANGE_ENV!=paper`, behaviour is **identical to today**. Exact per-leg
   behaviour when the flag is on:

   | Leg | Relaxed when flag on? |
   |-----|-----------------------|
   | `hasInvalidStressInputs` | **No** — fail-closed always (never trade on malformed snapshots) |
   | Breadth | **No** — keeps M23 engage (`\|breadth−50\| ≥ 40`) + auto-resume |
   | `same_bar_trigger_count` | Governed **only** by the raised strategy param (item 2), **not** by the flag — avoid relaxing it twice |
   | BTC / ETH shock | Yes — skipped (or raised to an explicit paper threshold; pick one, document it) |
   | OI / funding / spread | Yes — skipped (or explicit paper threshold) |
   | `multi` | Derived only from the legs still active under the paper profile |

   Per-coin spread/liquidity gates are **separate** from the global spread leg — operators may still see
   `spread_too_wide` per-coin rejects with the flag on; that is not a P2 failure.
4. **Operational (evidence-gated, per A6):** confirm `risk_state.is_halted=false` for the current UTC day
   (dashboard Resume / `clearHaltForDate`) after the flag lands so a stale pre-M25 halt does not mask the
   change — only when the row is halted, the halt predates M25 or was caused by a now-relaxed leg, breadth
   is not currently stressed, and the operator confirms the date.

### P3 — Sizing/exposure headroom within the 3-slot contract (config + boot guard, per A1/A4)
5. **Concurrency stays at the A/B/C ceiling of 3.** M25 does **not** raise the slot count — the slot
   model physically supports 3 and raising `MAX_IDIOSYNCRATIC_SLOTS` alone regresses capacity (A1).
   `MAX_IDIOSYNCRATIC_SLOTS` stays **2** (3 concurrent via C-borrow). If a `PAPER_MAX_IDIOSYNCRATIC_SLOTS`
   env is introduced at all, it is **clamped/validated to ≤ 2 and rejected at boot otherwise** — it must
   never silently reduce capacity. True 5-slot concurrency is a deferred follow-on (shared-contract).
6. **Sizing headroom (config + same-direction cap):** raise `MAX_EXPOSURE_PER_COIN_USDT`,
   `MAX_SAME_DIRECTION_EXPOSURE_USDT`, and `ACCOUNT_CAPITAL_USDT` in the paper `.env` so neither per-coin
   **nor same-direction** exposure (both enforced by `checkExposureCaps`) becomes the new ceiling. Decide
   `PAPER_STARTING_EQUITY_USDT` (A4). Verify the rate-limit invariant
   `MAX_OPEN_POSITIONS × PER_SYMBOL_ORDERS_SHARE ≤ 1.0` (set `MAX_OPEN_POSITIONS=3` in paper `.env` if the
   rate-limit math needs it — it does not govern slots). Confirm `StrategyService`/`PositionSizer` consume
   the raised values (config-only, no sizer code change) and that `exposure_cap_per_coin` /
   `same_direction_exposure_cap` rejects fall. Backtest reads `riskConsts` directly, so paper env bumps
   do not affect M7 replay (ADR 0029 preserved).

**Out of scope:**
- The paper open-fill fix itself — that is M24 (P0), a hard prerequisite.
- Shadow counterfactual fills — M26 (P4).
- Decision/position data-capture columns — M27 (P5).
- **Any change to live or backtest stress thresholds, slot counts, or sizing.** Live defaults are
  frozen; every M25 relaxation is `EXCHANGE_ENV=paper`-gated.
- Changing the breadth leg's M23 engage/resume logic.
- Strategy-core edits (v2 is already implemented; M25 only *activates* it via env).
- **True N-slot concurrency expansion (>3).** Extending `PositionSlotEnum` past A/B/C is a shared-contract
  change (enum + `SlotManager` + read-api mappers + dashboard + backtest replay + persistence + ADR) —
  deferred to a separate follow-on milestone (A1). M25 stays within the 3-slot contract.

## Paper-gating semantics (lock before QA)

- **`EXCHANGE_ENV=paper` is the single switch.** Every code relaxation (P2 flag, P3 slot override)
  must be a no-op unless `EXCHANGE_ENV=paper` **and** its specific flag is set. Default-off in code;
  opt-in via paper `.env`. A non-paper boot must produce byte-identical gate behaviour to pre-M25.
- **Breadth leg untouched.** P2 relaxes only the non-breadth legs; breadth keeps M23 engage
  (`|breadth−50| ≥ 40`) and auto-resume. Do not let `PAPER_RELAX_MARKET_STRESS` disable breadth.
- **Gate still runs in paper.** No relaxation bypasses `RiskGateService` — the gate evaluates every
  intent; M25 only loosens *thresholds*, never the *path*. Trading-safety invariant "no order path
  bypasses the risk gate" holds.
- **Live slot model frozen.** P3 must not change the live ceiling (2 idiosyncratic + 1 correlated).
  QA asserts a non-paper boot still caps at 3.
- **Paper slot ceiling also 3 (A1).** M25 does not raise the slot count in *any* env. The paper
  exploration profile increases *approved days* (P2) and *sizing headroom* (P3 env), not the number of
  concurrent slots. Any `PAPER_MAX_IDIOSYNCRATIC_SLOTS > 2` is rejected at boot.
- **Typed config only (A3).** New flags are read via `AppConfigService`, validated in
  `EnvironmentVariables`, parsed strictly (exact `true`), default-off. No risk service reads
  `process.env` directly.

## Change set

| Workspace        | Files (representative)                                                                                       | Item |
|------------------|-------------------------------------------------------------------------------------------------------------|------|
| config           | paper `.env` (`ACTIVE_STRATEGY_VERSION_ID=3`, `PAPER_RELAX_MARKET_STRESS`, raised `MAX_EXPOSURE_PER_COIN_USDT` + `MAX_SAME_DIRECTION_EXPOSURE_USDT` + `ACCOUNT_CAPITAL_USDT`, `PAPER_STARTING_EQUITY_USDT` decision, `MAX_OPEN_POSITIONS=3` if rate-limit math needs it); `.env.example` documents all new flags with paper-only caveats | 1,6 |
| `apps/engine/`   | `src/config/EnvironmentVariables.ts` + `src/config/AppConfigService.ts` (typed `paperRelaxMarketStress` getter, strict boolean parse, default-off; reject `PAPER_MAX_IDIOSYNCRATIC_SLOTS > 2` if introduced) | 3 (A3) |
| `apps/engine/`   | `src/risk/service/StressHaltEvaluator.ts` (single relax helper consumed by both `isStressed` and `classifyHaltLeg`; non-breadth legs per the A2 table) | 3 |
| `apps/engine/`   | `src/risk/service/RiskGateService.ts` (pass typed `paperRelaxMarketStress` through — no duplicate relax logic) | 3 |
| `apps/engine/` (tests) | risk-gate + stress + slot + config specs (paper relax on/off; non-paper + testnet unchanged; slot ceiling still 3 in all envs; same-direction + per-coin headroom; `validateEnv` for new vars) | QA |

No `packages/shared/` change (engine-side risk config; no new reject reason — `global_halt`,
`market_stress`, `exposure_cap_per_coin`, `same_direction_exposure_cap`, `no_eligible_slot` all already
exist). **No `SlotManager` code change** — P3 stays within the A/B/C contract (A1), so the slot count is
not overridable. No migration. A **dashboard note may be warranted** only if the operator needs to *see*
the relax state — defer unless asked; no new funnel surface is introduced.

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

> **Architect first — this touches more than one risk concept (stress + slots + sizing) and loosens
> a risk gate.** Per dev-qa-cycle, a multi-concept risk change gets an architect pass before code.

1. **Serial — `bot-architect`**: record an ADR 0004 amendment (or a new short ADR) for the
   **paper-only exploration profile**: the **exact P2 per-leg relax table** (A2 — invalid-inputs and
   breadth never relaxed, same-bar via param only), the **3-slot ceiling stays in all envs** (A1, with
   the rationale that raising `MAX_IDIOSYNCRATIC_SLOTS` regresses capacity and true expansion is a
   deferred shared-contract follow-on), the **sizing headroom incl. same-direction cap and the
   `PAPER_STARTING_EQUITY_USDT` decision** (A4), and the recommended paper env values — stating
   explicitly that **live/testnet/backtest defaults are unchanged** and these knobs exist solely for
   paper exploration. Visible review trail for a deliberate risk-loosening.
2. **Serial — `bot-engine-nestjs`** (split into ≤5-file dispatches):
   - **Dispatch A (config plumbing, A3):** add `paperRelaxMarketStress` (and reject any
     `PAPER_MAX_IDIOSYNCRATIC_SLOTS > 2`) to `EnvironmentVariables` + `AppConfigService` — typed getter,
     strict boolean parse, default-off.
   - **Dispatch B (P2):** single paper-relax helper in `StressHaltEvaluator` consumed by **both**
     `isStressed` and `classifyHaltLeg` (non-breadth legs per the A2 table; invalid-inputs fail-closed);
     `RiskGateService` passes the typed config through (no duplicate logic). Default-off; non-paper +
     testnet unchanged.
   - **No `SlotManager` change (A1).** P3 is config-only: `.env.example` documents the raised
     exposure/same-direction/capital values, the `PAPER_STARTING_EQUITY_USDT` decision, and the
     `MAX_OPEN_POSITIONS=3` rate-limit note — all with paper-only caveats.
3. **Serial — `bot-qa-engineer`**: paired tests per fix item —
   - **P2 relax on:** with `EXCHANGE_ENV=paper` + flag set, a non-breadth stress condition that
     halts today does **not** halt; breadth still halts/engages per M23; **invalid inputs still
     fail-closed**; `classifyHaltLeg` suffix stays consistent with `isStressed` (e.g. breadth+BTC with
     BTC relaxed classifies as `breadth`, not `multi`).
   - **P2 off / non-paper / testnet:** flag unset, or `EXCHANGE_ENV∈{live,testnet}`, → **identical**
     halt behaviour to pre-M25 (regression guard for the live contract — run a fixture table of stress
     snapshots and assert identical reject reasons).
   - **Slot ceiling unchanged:** paper and non-paper both cap at **3** (2 idiosyncratic + C-borrow);
     a `PAPER_MAX_IDIOSYNCRATIC_SLOTS > 2` is **rejected at boot**, never silently applied.
   - **Sizing headroom:** raised `MAX_EXPOSURE_PER_COIN_USDT` **and** `MAX_SAME_DIRECTION_EXPOSURE_USDT`
     reduce `exposure_cap_per_coin` / `same_direction_exposure_cap` rejects; sizing scales with raised
     capital without breaking `PositionSizer` invariants; rate-limit invariant holds.
   - **Env validation (A3):** `validateEnv` rejects malformed new vars; string `"false"` is not truthy.
   - **Gate path intact:** every intent still flows through `RiskGateService` (no bypass).
4. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   **`bot-review-quant`**. Security/logic own the **paper-gating proof** (no relaxation leaks to live
   or backtest). Quant owns whether the relaxed paper profile still yields *analyzable* data (enough
   approvals, not so loose the outcomes are meaningless). Cycle fix → re-review until zero blockers,
   zero highs, majority mediums.
5. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, CLAUDE.md status line,
   `docs/plans/00-overview.md` RiskModule note (paper exploration profile), and the ADR amendment
   link. Record the activated strategy id (3 = v2 momentum; warn against id 4 = v3 hybrid), the relaxed
   legs (A2 table), the **3-slot ceiling unchanged** (true 5-slot deferred to a follow-on), the sizing
   profile incl. same-direction cap and the `PAPER_STARTING_EQUITY_USDT` decision, and the
   evidence-gated `clearHaltForDate` step taken on deploy.

Orchestrator verifies the actual diff after every wave and **explicitly confirms** (a) every relaxation
is `EXCHANGE_ENV=paper`-gated and default-off — a non-paper/testnet boot is byte-identical to pre-M25;
(b) **no `SlotManager` and no `packages/shared/` change** — the slot ceiling is still 3 in every env;
(c) the P2 relax flows through one helper used by both `isStressed` and `classifyHaltLeg`; and (d) M24
is merged and green before the engine wave.

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M25 is migration-free.** The only DB interaction is operational: after deploy, **clear a stale UTC
halt** for the current day so the pre-M25 halt does not mask the relaxation. Clearing a halt is a
scoped `risk_state` update via the existing `clearHaltForDate` / dashboard Resume path — **not** a
destructive op, no `-v`, no down/revert, no `TRUNCATE`/`DELETE`.

**Backup rotation:** before the engine restart **and** before the `clearHaltForDate`, take a routine
`pg_dump`
(`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`).
**Keep the 2 most recent `backup_` files; prune older ones.** Show the user the dump path and confirm
before clearing the halt.

> **Strategy activation is a config flip, not a DB write — verify the row first (A5).** Before restart,
> confirm DB id `3` is **v2 momentum** and is loadable by the active strategy loader **even if its row
> `status=shadow`**. If the loader requires `status=active`, flipping it is a `strategy_versions`
> **UPDATE** → the pg_dump + user-confirmation rules apply, and the "no DB write" framing no longer
> holds. The config-only path is valid **only** if the loader accepts a shadow row by id.

## Post-deploy steps

0. **M24-landed gate (A6):** before enabling any M25 flag, confirm M24 is merged and green via its unit
   proof (gate-approved crossing IOC fills with a non-zero price and event-time `tsMs`). M25 on top of a
   broken M24 fill path reproduces "zero positions" and looks like a gate/strategy failure.
1. Take `pg_dump` before the engine restart (prune to 2-deep retention); show the user the path.
2. Apply the paper `.env` changes; **engine restart** (no migration).
3. **Evidence-gated `clearHaltForDate`** for the current UTC day (after backup, A6): only if the row is
   halted, the halt predates M25 or was caused by a now-relaxed leg, breadth is not currently stressed,
   and the operator confirms the date. Read the existing halt first; confirm with the user before the
   write. This is not a routine "clear whatever blocks trading" habit.
4. **10-min live smoke** per `feedback-milestone-app-smoke` — fix-and-report boot errors before the
   scribe. Confirm the active version is v2, the engine stays running, and the cleared halt does **not**
   immediately re-assert on the next tick (if it does, the relaxation is insufficient — investigate).
5. **First-transactions confirmation (24–48h):** confirm `positions`/`transactions` rows now appear
   (the M24+M25 combination is the first point at which trades exist), with a mix of wins and losses,
   and that up to **3** concurrent positions are held. Read-only DB querying.
6. **Funnel-mix check (quantified, A6):** confirm `global_halt`/`market_stress` share **falls** vs the
   prior 14d, `positions` count > 0 within 48h, and the funnel now surfaces *fill outcomes* rather than
   day-halt rejections. Split residual rejections into *no approvals* / *approvals with missed fills* /
   *approvals with filled opens*. Read-only.

## Verification

- **Unit:** `src/risk` + `src/config` suites green (gate, stress, slot, sizer, env validation);
  paper-relax on/off both covered; non-paper **and testnet** regression covered.
- **Paper-gating proof (load-bearing):** a non-paper/testnet boot produces byte-identical
  gate/stress/slot behaviour to pre-M25 (proven against a fixture table of stress snapshots + slot
  occupancies, incl. invalid-input and same-bar cases); every relaxation requires `EXCHANGE_ENV=paper`
  **and** its flag.
- **P2 single-helper consistency:** `isStressed` and `classifyHaltLeg` agree under relax (no
  verdict/suffix drift); invalid inputs and breadth never relaxed.
- **Concurrency:** paper **and** live cap at **3** (A1); a `PAPER_MAX_IDIOSYNCRATIC_SLOTS > 2` is
  rejected at boot, never silently applied.
- **Sizing:** raised per-coin **and same-direction** caps reduce their respective rejects; rate-limit
  invariant `MAX_OPEN_POSITIONS × PER_SYMBOL_ORDERS_SHARE ≤ 1.0` holds.
- **Outcome stream:** after deploy, real `positions`/`transactions` rows accrue with wins and losses
  (the actual data the operator asked for).
- **Boot:** engine boots and stays **running** after restart; active version is v2 (id 3).

## References

- Architect analysis (P1/P2/P3): [main-architector-paper-soak-fill-and-gate-analysis.md](../../wip/done/main-architector-paper-soak-fill-and-gate-analysis.md) §1 Q2–Q4, §2.2, §3, §5 P1–P3
- Independent reviews (2026-06-08, source of amendments A1–A6):
  [composer](../../archive/independent-analysis/composer/M25-paper-exploration-enablement-review.md),
  [gbt](../../archive/independent-analysis/gbt/M25-paper-exploration-enablement.md),
  [gemini](../../archive/independent-analysis/gemini/M25-paper-exploration-enablement.md)
- Risk management + halt legs + M23 auto-resume: [docs/architecture/adr/0004-risk-management.md](../../architecture/adr/0004-risk-management.md)
- M23 market-stress adaptive resume: [docs/plans/archive/M23-market-stress-adaptive-resume.md](M23-market-stress-adaptive-resume.md)
- Hard prerequisite: M24 (paper open-fill wiring)
- Follow-on: M26 (shadow fills), M27 (data capture)

### Key source files

| Concern | Path |
|---|---|
| Live gate pipeline | `apps/engine/src/risk/service/RiskGateService.ts` |
| Stress legs | `apps/engine/src/risk/service/StressHaltEvaluator.ts` |
| Slot model | `apps/engine/src/risk/service/SlotManager.ts` |
| Risk constants | `apps/engine/src/risk/const/riskConsts.ts` |
| Position sizer | `apps/engine/src/risk/service/PositionSizer.ts` |
