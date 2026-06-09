# ADR 0042 — Paper exploration profile (M25)

Status: Accepted
Date: 2026-06-08
Milestone: M25 — Paper exploration enablement
Amends: ADR 0004 §6 (stress halt), §4 (slot model), §8 (sizing); ADR 0032 (paper mode);
preserves ADR 0029 (backtest determinism), ADR 0030 (rate-limit invariant).

## Context

After M24 a gate-approved open actually fills, but the 14-day paper soak still produces
almost nothing to label. The funnel analysis
(`docs/wip/main-architector-paper-soak-fill-and-gate-analysis.md`, items P1–P3) proves three
binding constraints, all of them **correct for live capital** but **mis-tuned for a paper
*exploration* soak** whose entire purpose is to collect labeled win/loss outcomes — including
some bad ones:

- **Strategy (P1).** The active version is v1 mean-reversion, deliberately ultra-conservative:
  761 `skip`s, only 350 open intents reaching the gate in 14 days. Shadow v2 momentum emits
  583 open intents on the same `event_id` tape. v2 is the version with appetite to generate
  volume; v1 produces no labelable outcome stream.
- **Gate (P2).** ~78% of those 350 intents are rejected by day-level stress halts
  (`global_halt` 66% + `market_stress` 12%). Once a UTC day is halted, even deep tier-1 names
  reject. The stress thresholds are engine constants (`StressHaltEvaluator`); M23 auto-resume
  only clears the **breadth** leg. BTC/ETH 5m shock, OI, funding, spread, same-bar, and
  multi-leg halts lock the full UTC day (ADR 0004 §6d).
- **Concurrency (P3).** The gate ignores `MAX_OPEN_POSITIONS` for slot purposes; concurrency
  is a hard-coded 3-slot model (`SlotManager`: `MAX_IDIOSYNCRATIC_SLOTS=2` + slot-C borrow +
  `MAX_BTC_CORRELATED_POSITIONS=1`). Adding capital alone changes nothing — the binding
  constraints are slot count and the per-coin / same-direction exposure caps, not
  `ACCOUNT_CAPITAL_USDT`.

This ADR exists because M25 is a **deliberate risk-loosening milestone**. Per the
dev-qa-cycle, a multi-concept risk change that loosens a risk gate gets an architect pass and
a visible review trail before any code — not a silent `.env` edit. The locked decisions below
are the contract the engine and QA agents implement.

**The defining invariant of this ADR:** every M25 relaxation is gated on
`EXCHANGE_ENV=paper` and is default-off in code. **Live, testnet, and backtest defaults are
frozen.** A non-paper boot must produce byte-identical gate / stress / slot / sizing behaviour
to pre-M25. Every knob below exists *solely* to widen the paper exploration funnel so the soak
yields analyzable outcomes; none changes the live risk posture.

## Decision

### 1. Paper-gating semantics — `EXCHANGE_ENV=paper` is the single switch

- **Two-condition gate.** Every relaxation is a no-op unless **both** `EXCHANGE_ENV=paper`
  **and** the specific feature flag is set. Either condition false → pre-M25 behaviour.
- **Default-off in code.** New flags default to off (or, for the slot guard, reject-on-misuse).
  Opt-in lives only in the paper `.env`. There is no env-derived "on by default in paper"
  inheritance for the P2 relax flag (contrast M23's `MARKET_STRESS_AUTO_RESUME_ENABLED`, which
  derives on in paper — the M25 relax is a sharper loosening and is opt-in even in paper).
- **Gate path is never bypassed.** No relaxation skips `RiskGateService`. The gate still
  evaluates every intent; M25 loosens *thresholds*, never the *path*. The trading-safety
  invariant "no order path bypasses the risk gate" holds unchanged.
- **Determinism preserved.** Flags are typed config read through `AppConfigService`, constant
  within a run. Backtest reads `riskConsts` and explicit construction inputs directly (ADR
  0029) — paper `.env` bumps do not reach M7 replay.

### 2. P2 — Paper-only stress relaxation: the per-leg relax table (A2)

`PAPER_RELAX_MARKET_STRESS=true` (with `EXCHANGE_ENV=paper`) relaxes specific **global**
stress legs. The decision logic in `StressHaltEvaluator` has two coupled surfaces —
`isStressed()` (the verdict) and `classifyHaltLeg()` (the persisted `halt_reason` suffix that
M23 resume eligibility parses). **They MUST stay consistent.** A relaxation that touches one
surface but not the other would let `isStressed` say "not stressed" while `classifyHaltLeg`
still classifies a now-inactive leg, or vice versa, corrupting the M23 resume contract.

**Locked: a single shared relax helper is the only source of "is this leg relaxed under the
paper profile".** Both `isStressed()` and `activeStressLegs()` (which feeds `classifyHaltLeg()`)
consume it. `RiskGateService` passes the typed `paperRelaxMarketStress` config through to the
evaluator; it contains **no duplicate relax logic** of its own.

**Per-leg behaviour when the flag is on (`EXCHANGE_ENV=paper` + `PAPER_RELAX_MARKET_STRESS=true`):**

| Leg | Relaxed? | Rule |
|-----|----------|------|
| `hasInvalidStressInputs` (NaN/non-finite guard) | **NEVER** | Fail-closed always. Never trade on a malformed snapshot, in any env, under any flag. The guard is evaluated before, and independent of, the relax helper. |
| Breadth (`\|breadth−50\| ≥ STRESS_BREADTH_DISTANCE_PCT = 40`) | **NEVER** | M23 engage + auto-resume are untouched. `PAPER_RELAX_MARKET_STRESS` must not disable breadth engage, the breadth leg classification, or the M23 resume path. |
| `same_bar_trigger_count` | **NEVER (M28 update)** | **Superseded by ADR 0004 §6e (M28).** The same-bar engage threshold moved engine-side to the const `STRESS_SAME_BAR_HALT_COUNT = 20`; the strategy param `stress_same_bar_trigger_count` (still 5) is now consumed **only** by `classifyFlowType` and no longer governs the halt. This leg is therefore **never** relaxed by `PAPER_RELAX_MARKET_STRESS` and is **not** tunable via the param either — it is recalibrated engine-side, not relaxed (ADR 0042 §2 invariant intact; same_bar is never in `PAPER_RELAXABLE_LEGS`). |
| BTC 5m shock (`STRESS_BTC_5M_SHOCK_PCT`) | **Yes** | Skipped under the paper profile. |
| ETH 5m shock (`STRESS_ETH_5M_SHOCK_PCT`) | **Yes** | Skipped under the paper profile. |
| OI 5m shock (`STRESS_OI_CHANGE_5M_PCT`) | **Yes** | Skipped under the paper profile. |
| Funding extreme (`STRESS_FUNDING_ANNUALIZED_PCT`, global stress leg) | **Yes** | Skipped under the paper profile. |
| Spread blowout (`STRESS_SPREAD_PCT`, global liquidity-shock leg) | **Yes** | Skipped under the paper profile. |
| `multi` | **Derived** | `classifyHaltLeg` returns `multi` only when **two or more *still-active* legs** engage under the paper profile. A relaxed leg is not counted. (Example below.) |

**Relax method — skip, not raise (locked).** The relaxed legs are **skipped** (treated as
not-engaging) under the paper profile, not re-thresholded to an explicit paper number. The
plan offered "skip or raise to an explicit paper threshold — pick one"; this ADR picks
**skip**, for two reasons: (1) the exploration goal is *maximum analyzable approvals*, and a
half-loosened threshold reintroduces day-halts that mask the data the soak is collecting;
(2) a single boolean "is this leg active under the profile" helper is simpler to single-source
across both surfaces than per-leg paper thresholds, reducing the A2 drift surface. If a future
soak shows the skip is *too* loose (outcomes meaningless), reintroduce per-leg paper thresholds
as a follow-on — do not silently re-tighten by editing the live consts.

**`multi`-classification consistency (worked example, locked).** Snapshot engages **breadth +
BTC 5m shock** with the flag on:

- BTC shock is relaxed → not an active leg under the paper profile.
- Breadth is never relaxed → still active, and it is the **sole** active global leg.
- `isStressed()` returns `true` (breadth alone halts).
- `classifyHaltLeg()` returns `breadth` (not `multi`), so the persisted `halt_reason` is
  `market_stress:breadth` — **resume-eligible** under M23.

This is the load-bearing consistency property: `isStressed` and `classifyHaltLeg` must agree
on the *set of active legs* under the profile. QA pins exactly this case.

**Per-coin spread / liquidity gates are SEPARATE — NOT covered by P2 (locked).** The per-coin
spread ceiling (`SPREAD_TOO_WIDE`, `TIER_SPREAD_CEILING_PCT`) and the per-coin book-depth floor
(`COIN_BOOK_TOO_THIN`, ADR 0004 §6a) are per-decision eligibility skips inside
`firstFailingTierFilter`, **not** global stress legs. `PAPER_RELAX_MARKET_STRESS` does not
touch them. Operators **will still see `spread_too_wide` / `coin_book_too_thin` per-coin
rejects with the flag on** — that is correct behaviour, not a P2 failure. Per-coin liquidity
remains protected even in the paper exploration profile, because a thin-coin fill produces
*unrepresentative* slippage data, which corrupts rather than enriches the soak.

### 3. P3a — The 3-slot ceiling stays in ALL envs (A1)

**The physical concurrency ceiling is 3 (slots A, B, C) in every environment, including paper.
M25 does not raise the slot count.**

- `PositionSlotEnum` has exactly `{ A, B, C }` (`packages/shared/src/enum/PositionSlotEnum.ts`).
  The honest physical ceiling is 3, matching ADR 0004 §4. The "5 positions" framing in early
  P3 discussion is **not achievable** without a shared-contract change.
- **`MAX_IDIOSYNCRATIC_SLOTS` stays 2.** The third concurrent idiosyncratic position takes slot
  C via the `isSlotCFreeForIdiosyncratic` borrow, which fires **only when**
  `idiosyncraticCount >= MAX_IDIOSYNCRATIC_SLOTS` (`SlotManager.ts:61-66`). Raising the
  constant above 2 is actively **harmful**: with only A/B as idiosyncratic-named slots, the
  count can never reach a threshold > 2, so the C-borrow never fires and capacity **regresses
  to 2**. This is a trap, documented here so no future reader "raises the slot limit" by
  bumping this constant.
- **`PAPER_MAX_IDIOSYNCRATIC_SLOTS > 2` is REJECTED at boot, never silently applied.** If such
  an env is introduced at all (it need not be for M25), it is validated to `≤ 2` in
  `EnvironmentVariables` and throws at boot otherwise. It must never silently reduce capacity.
  QA asserts the boot rejection.
- **No `SlotManager` code change and no `packages/shared/` change in M25.** The slot model is
  frozen. Paper and non-paper both cap at 3.

**True N-slot concurrency expansion (> 3) is a deferred, separate follow-on.** It is a
shared-contract change touching, at minimum: `PositionSlotEnum` (enum + barrel),
`SlotManager` (assignment + the C-borrow logic generalized), read-api mappers, the dashboard,
backtest replay (ADR 0029 determinism — new slot ids must replay byte-identically),
persistence (`positions.position_slot` CHECK / enum), and its own ADR. It is explicitly **out
of scope for M25**.

The paper exploration profile increases **approved days** (P2) and **sizing headroom** (P3b),
not the number of concurrent slots.

### 4. P3b — Sizing / exposure headroom incl. the same-direction cap (A4)

The live source for the exposure caps and account capital is `AppConfigService` (env), threaded
into `IRiskGateContext.limits`; the `riskConsts` values (`MAX_EXPOSURE_PER_COIN_USDT = 250`,
`MAX_SAME_DIRECTION_EXPOSURE_USDT = 600`) are **backtest-seed defaults only** and are not read
by the live gate (confirmed: `riskConsts.ts:51-57`, `AppConfigService.ts:220-242`). So the
paper `.env` raises these without touching live or backtest.

`checkExposureCaps` enforces **both** per-coin **and** same-direction caps. Raising only
per-coin + capital would leave **same-direction** as the new binding ceiling (with three
same-side $250 positions = $750 > the $600 default). The profile therefore raises all of:

- **`MAX_EXPOSURE_PER_COIN_USDT`** — must clear one max-size position with headroom.
- **`MAX_SAME_DIRECTION_EXPOSURE_USDT`** — must be **≥ 3 × per-coin** so it is not the new
  ceiling when all three slots are the same side (the common case in a momentum regime).
- **`ACCOUNT_CAPITAL_USDT`** — the sizing denominator (`riskPerTradeUsdt = capital ×
  RISK_PER_TRADE_PCT`); raised so per-position size scales up to the per-coin cap rather than
  the sizer floor-rounding to dust.

**`PAPER_STARTING_EQUITY_USDT` decision (locked): keep the current $500 default, with the
drawdown-telemetry note below.** This value seeds `PaperAccountStateService.balanceUsdt` and
`peakEquity` only at **cold start** (ADR 0032 §D11); on a soak that already has
`paper_account_snapshots` rows it is ignored (restore wins). Two consequences the operator must
understand:

- **It is the denominator for drawdown %.** Max-drawdown and equity-curve percentages are
  computed against `peakEquity`, which seeds from `PAPER_STARTING_EQUITY_USDT`. Keeping it at
  $500 while raising `ACCOUNT_CAPITAL_USDT` to ~$1,500 means the **sizing capital and the
  drawdown-baseline equity differ by 3×**. A $150 drawdown reads as **30% of starting equity**
  even though it is **10% of the sizing capital**. Drawdown telemetry will look ~3× more severe
  than the capital-relative reality.
- **Why keep it anyway.** The running soak already has snapshot rows; changing
  `PAPER_STARTING_EQUITY_USDT` does **not** retroactively rebase them (it only affects a fresh
  cold start), so raising it mid-soak buys nothing for the existing curve and would only matter
  on a wipe-and-restart. **If the operator wants drawdown % to read against the new capital,
  the correct action is a clean-slate restart with `PAPER_STARTING_EQUITY_USDT` raised to match
  `ACCOUNT_CAPITAL_USDT`** — a deliberate, separate decision, not a side effect of M25. Absent
  that, read absolute-USD drawdown, not the %, during the M25 soak.

**Rate-limit invariant (ADR 0030, locked).** `RateLimitPolicyService` throws
`RateLimitConfigInvariantException` at boot when
`MAX_OPEN_POSITIONS × PER_SYMBOL_ORDERS_SHARE > 1.0` (`RateLimitPolicyService.ts:116-119`).
`PER_SYMBOL_ORDERS_SHARE = 0.3`. So `MAX_OPEN_POSITIONS = 3 → 0.9 ≤ 1.0` (boots);
`MAX_OPEN_POSITIONS = 4 → 1.2 > 1.0` (boot crash). Set **`MAX_OPEN_POSITIONS = 3`** in the
paper `.env` so the rate-limit math holds. **`MAX_OPEN_POSITIONS` governs only the rate-limit
sub-bucket math — it does NOT govern slots** (the gate ignores it for concurrency, which the
3-slot model owns, §3).

**No `PositionSizer` code change.** P3b is config-only: the sizer already consumes the threaded
config values; raising them scales position size and lowers `exposure_cap_per_coin` /
`same_direction_exposure_cap` rejects without touching sizer code.

### 5. P1 — Activate v2 momentum (config-only)

Set **`ACTIVE_STRATEGY_VERSION_ID = 3`** (DB id 3 = strategy version 2 momentum) in the paper
`.env`. v2 is the open-volume driver (583 shadow open intents vs v1's 0 gate approvals on the
same tape). This is the no-code lever that makes the gate *receive* enough intents for the P2
relaxation to matter.

- **Warning (locked): id `4` is WRONG.** DB id 4 = strategy version 3 hybrid, which skips all
  catalyst flow and would reproduce the low-volume problem. Use id 3.
- **Pre-restart verification (A5).** Confirm id 3 is v2 momentum and is loadable by the active
  loader **even if its row `status=shadow`**. If the loader requires `status=active`, flipping
  it is a `strategy_versions` **DB write** → the CLAUDE.md pg_dump + explicit-confirmation rules
  (#8/#9) apply, and the "config-only, no DB write" framing no longer holds. The config-only
  path is valid **only** if the loader accepts a shadow row by id.

### 6. Typed config only (A3)

All new flags route through `EnvironmentVariables` (class-validator schema) + `AppConfigService`
(typed getters injected into services). **No risk service reads `process.env` directly.**

- **`PAPER_RELAX_MARKET_STRESS`** — `@IsOptional` boolean, **strict parse**: only the exact
  string `'true'` (case-insensitive, trimmed) is true; any other value is false (fail-safe to
  off), mirroring the existing `MARKET_STRESS_AUTO_RESUME_ENABLED` transform
  (`EnvironmentVariables.ts:256-259`). The string `"false"` is **not** truthy. Default-off.
  `AppConfigService.paperRelaxMarketStress` returns the effective value (off unless
  `EXCHANGE_ENV=paper` **and** the flag is true — the env-gate may live in the getter or at the
  call site, but the two-condition contract of §1 is what QA asserts).
- **`PAPER_MAX_IDIOSYNCRATIC_SLOTS`** (only if introduced) — validated `≤ 2`, **rejected at
  boot** otherwise (§3).
- `validateEnv.spec.ts` covers each new var: strict-boolean parse, default-off, and the
  slot-var boot rejection.

### 7. What is frozen — live / testnet / backtest defaults (load-bearing)

Stated explicitly so reviewers can prove it:

- **Live + testnet stress thresholds, slot model, and sizing caps are unchanged.** A
  non-paper / testnet boot produces **byte-identical** gate / stress / slot / sizing behaviour
  to pre-M25, proven against a fixture table of stress snapshots + slot occupancies (incl.
  invalid-input and same-bar cases).
- **Backtest is unchanged (ADR 0029 preserved).** M7 replay reads `riskConsts` and explicit
  construction inputs, not the paper `.env`; the paper exposure/capital bumps and the relax flag
  do not reach replay. Backtest determinism and the live↔backtest equivalence contract hold.
- **Breadth engage + M23 auto-resume are unchanged** (§2, never-relaxed).
- **The risk-gate path is unchanged** — every intent still flows through `RiskGateService` (§1).

### 8. Recommended paper `.env` values (concrete)

For ~$1,500–$2,000 sizing capital supporting 3 concurrent $250 positions at ≤ 2× leverage:

| Var | Value | Why |
|-----|-------|-----|
| `EXCHANGE_ENV` | `paper` | The single gating switch; every relaxation below is inert without it. |
| `ACTIVE_STRATEGY_VERSION_ID` | `3` | v2 momentum — the volume driver. **Not 4** (v3 hybrid skips catalyst flow). |
| `PAPER_RELAX_MARKET_STRESS` | `true` | Skips non-breadth global stress legs (§2). Strict-`true` only. |
| `stress_same_bar_trigger_count` (strategy param) | **leave at 5 (M28 update)** | **Superseded by ADR 0004 §6e (M28).** No longer a same-bar halt lever — the halt threshold is the engine const `STRESS_SAME_BAR_HALT_COUNT = 20`. The param stays at 5 and is read **only** by `classifyFlowType` MARKET_BETA routing; raising it would silently change flow classification, not the halt. Do not tune the halt via this param. |
| `MARKET_STRESS_AUTO_RESUME_ENABLED` | leave unset (paper-derives on) | M23 breadth auto-resume stays on in paper (unchanged). |
| `MAX_EXPOSURE_PER_COIN_USDT` | `500` | Clears one max-size $250 position with 2× headroom. |
| `MAX_SAME_DIRECTION_EXPOSURE_USDT` | `1500` | `= 3 × per-coin`, so same-direction is not the new ceiling when all 3 slots are same-side. |
| `ACCOUNT_CAPITAL_USDT` | `1500` (range $1,500–$2,000) | Sizing denominator; scales position size up to the per-coin cap. |
| `PAPER_STARTING_EQUITY_USDT` | keep `500` (default) | Drawdown-baseline equity. **Note (§4):** with capital at $1,500 the drawdown % reads ~3× harsher than capital-relative; read absolute-USD drawdown, or do a clean-slate restart with this raised to $1,500 if % must match capital. |
| `MAX_OPEN_POSITIONS` | `3` | Rate-limit math only (`3 × 0.3 = 0.9 ≤ 1.0`); does **not** govern slots. `4` crashes at boot (`1.2 > 1.0`). |
| `PAPER_MAX_IDIOSYNCRATIC_SLOTS` | omit | Slot ceiling stays 3; `> 2` is rejected at boot. |

`.env.example` documents every new flag with the paper-only caveat so a live operator cannot
copy them in by accident.

## Consequences

- **Positive.** The paper soak begins producing a real win/loss outcome stream: v2 generates
  open intents, the relaxed non-breadth stress legs stop locking whole days, and the sizing
  headroom lets up to 3 concurrent positions of representative size open. The operator gets the
  labeled data M26/M27 will consume.
- **Positive.** The loosening is auditable: one ADR, one visible review trail, two-condition
  gating, default-off in code. A live/testnet/backtest boot is provably unchanged.
- **Negative (accepted).** The paper soak is now a *looser* risk regime than live. Outcomes
  collected under it are exploration data, **not** a live-edge proof. The promotion gate (ADR
  0019) and the live-activation gates (ADR 0004 §6d, M21/M22 telemetry) still bind before any
  live change; M25 unlocks none of them.
- **Negative (accepted, §4).** With `PAPER_STARTING_EQUITY_USDT` kept at $500 while capital
  rises to ~$1,500, drawdown % telemetry reads ~3× harsher than capital-relative. Mitigation:
  read absolute-USD drawdown during the M25 soak, or restart clean with the equity raised.
- **Operational.** Post-deploy, an **evidence-gated** `clearHaltForDate` may be needed so a
  stale pre-M25 halt does not mask the relaxation — only when the current row is halted, the
  halt predates M25 or was caused by a now-relaxed leg, breadth is not currently stressed, and
  the operator confirms the date. Take a `pg_dump` first (CLAUDE.md #8/#9). This is not a
  routine "clear whatever blocks trading" habit.
- **Sequencing.** M24 must be merged and green (gate-approved crossing IOC fills, non-zero
  price, event-time `tsMs`) before any M25 flag is enabled. M25 on a broken M24 fill path
  reproduces "zero positions" and looks like a gate/strategy failure.

## Alternatives considered

- **Edit live stress consts / slot count / sizing caps directly (silent `.env` or const
  bumps).** Rejected: it would change the live risk posture, break the byte-identical
  non-paper-boot guarantee, and leave no review trail for a deliberate risk-loosening. The
  whole point of M25 is paper-gated, auditable loosening.
- **Relax the breadth leg too (full stress disable in paper).** Rejected: breadth is the one
  fast mean-reverting global signal with a working M23 engage/resume, and a momentary
  correlated flush is exactly the kind of event whose fills produce unrepresentative slippage.
  Keeping breadth + per-coin liquidity guards live means the soak data stays analyzable rather
  than polluted.
- **Raise `MAX_IDIOSYNCRATIC_SLOTS` to reach more concurrency.** Rejected: it regresses capacity
  to 2 (the C-borrow never fires with only A/B as idiosyncratic-named slots), the opposite of
  the intent (§3, A1).
- **Extend `PositionSlotEnum` to A–E for true 5-slot concurrency now.** Rejected for M25: it is
  a shared-contract change (enum + SlotManager + read-api + dashboard + backtest replay +
  persistence + ADR) and must not ride a paper-config milestone. Deferred to a dedicated
  follow-on.
- **Re-threshold relaxed legs to explicit paper numbers instead of skipping.** Rejected for the
  first cut (§2): it reintroduces day-halts that mask the exploration data and multiplies the
  A2 single-source surface. Reintroducible as a follow-on if the skip proves too loose.
- **Raise per-coin and capital but leave `MAX_SAME_DIRECTION_EXPOSURE_USDT` at $600.** Rejected:
  `checkExposureCaps` would make same-direction the new ceiling at three same-side positions
  ($750 > $600), silently re-binding the funnel (A4).
- **Raise `PAPER_STARTING_EQUITY_USDT` to match capital mid-soak.** Rejected as the default
  M25 action: it does not retroactively rebase existing `paper_account_snapshots` (cold-start
  only), so it buys nothing for the running curve; the correct way to rebase drawdown % is a
  deliberate clean-slate restart, kept as a separate operator decision (§4).
- **Derive `PAPER_RELAX_MARKET_STRESS` on-by-default in paper (like M23's auto-resume flag).**
  Rejected: skipping multiple stress legs is a sharper loosening than the breadth auto-resume;
  it should require an explicit opt-in even in paper, default-off in code.

## See also

- `docs/plans/M25-paper-exploration-enablement.md` (milestone plan, amendments A1–A6)
- `docs/architecture/adr/0004-risk-management.md` (§4 slot model, §6/§6a–§6d stress halt + M23
  auto-resume, §8 sizing — the surfaces this ADR amends for paper)
- `docs/architecture/adr/0032-paper-mode-architecture.md` (`EXCHANGE_ENV`, paper account state,
  `PAPER_STARTING_EQUITY_USDT` §D11)
- `docs/architecture/adr/0029-shadow-counterfactual-and-fill-simulator-pipeline.md` (backtest
  determinism — preserved; paper env bumps do not reach replay)
- `docs/architecture/adr/0030-in-engine-rate-limit-token-bucket-policy.md` (the
  `MAX_OPEN_POSITIONS × PER_SYMBOL_ORDERS_SHARE ≤ 1.0` invariant)
- `docs/best-practices/code-conventions.md` (constants placement, strict env parsing, decimal
  money — authoritative)
- Key source files: `apps/engine/src/risk/service/StressHaltEvaluator.ts` (P2),
  `apps/engine/src/risk/service/SlotManager.ts` (unchanged, §3),
  `apps/engine/src/risk/service/RiskGateService.ts` (passes typed config through),
  `apps/engine/src/config/EnvironmentVariables.ts` + `.../service/AppConfigService.ts` (A3),
  `packages/shared/src/enum/PositionSlotEnum.ts` (3-slot physical ceiling)
