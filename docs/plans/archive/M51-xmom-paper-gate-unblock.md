# M51 — Unblock the xmom PAPER soak (time-stop gate alignment + paper-only liquidity relax)

> **What M51 is.** A PAPER-mode **soak-enablement** fix. The cross-sectional momentum strategy
> (`xmom`, `strategy_versions` id=20) has approved **zero** positions across two paper-soak eras —
> **0 fills in 185 gate attempts** — so the M50 soak has produced no end-to-end trade lifecycle to
> observe. M51 removes the two mechanical blockers the paper-soak analysis identified: (1) a
> config mismatch between the momentum time-stop the orchestrator proposes (2× the rebalance
> interval, intentional per ADR 0048) and the ceiling the risk gate derives (1×), which rejects
> **every** deep-book symbol on `time_stop_missing_or_invalid`; and (2) tier1 per-coin liquidity
> floors that block the thin momentum leaders (ranks 1–7) even after (1) is fixed, addressed with a
> **paper-only, env-gated** liquidity relax that never touches live tier1 floors.
>
> Every `CLAUDE.md` trading-safety invariant holds: **no order path bypasses the risk gate** (the
> gate stays the sole path; M51 only aligns one of its ceilings and adds a paper-only relaxed floor
> behind a default-off flag), strategies stay pure/deterministic (no strategy-core change, no signal
> change), money stays `decimal`, no LLM in the loop. **No live tier1 floor is touched; no live
> capital is enabled; the rebalance cadence and the momentum signal are unchanged.**
>
> This milestone **implements the recommendations** of
> [`docs/wip/2026-07-01-xmom-paper-liquidity-gate-analysis.md`](../wip/2026-07-01-xmom-paper-liquidity-gate-analysis.md)
> (P0/P1 blocking; P3/P4 as stretch). That analysis is the source of every number cited below.

---

## Problem statement

The `xmom` PAPER soak (M50 / M50b, `strategy_versions` id=20, `EXCHANGE_ENV=paper`) has approved
**0 positions across 185 gate attempts** spanning two soak eras (source:
[`docs/wip/2026-07-01-xmom-paper-liquidity-gate-analysis.md`](../wip/2026-07-01-xmom-paper-liquidity-gate-analysis.md)):

| Era | When | Attempts | Dominant reject | Root cause |
|-----|------|----------|-----------------|------------|
| **Smoke** | 2026-07-01, 5-min interval override | 85 | `coin_book_too_thin` (91%) | Tier1 depth floor ($10k) vs thin momentum leaders |
| **Cron 01:07** | 2026-07-02 01:07 UTC, params `{}` | 100 (full universe cascade) | `time_stop_missing_or_invalid` (84%) | Intent proposes 2× rebalance-interval hold; gate ceiling allows 1× |

Because the M50b cascade walks the **entire ranked universe** in one cycle until `top_n` slots fill
(ADR 0050), a single systematic reject reason produces ~100 decision rows and **zero** fills. The net
effect is that the soak — whose entire purpose is to accumulate a real, multi-regime end-to-end trade
record to eventually evaluate against the M50 promotion gate — has **never opened a position**. There
is nothing to observe, no realized PnL, no reconciliation exercise, no fill-fidelity data.

Both root causes were independently verified by the quant and logic reviewers. Neither is a signal or
strategy problem — they are a gate-ceiling config mismatch and an over-conservative-for-paper
liquidity floor.

### Root cause 1 — P0: time-stop ceiling derives from 1× while the intent proposes 2×

- `MomentumOrchestratorService.ts:384` sets `timeStopAtMs = nowMs + params.rebalance_interval_ms * 2`
  — the **2× margin is intentional** (ADR 0048: the time-stop enforcer must not fire *before* the next
  scheduled rebalance runs; it is a failsafe backstop for "the rebalance mechanism itself failed to
  run", not the primary exit — the primary exit is the next day's re-rank).
- `buildGateStrategyParams` (`MomentumOrchestratorService.ts:539`) derives the gate ceiling
  `time_stop_minutes` from a straight **1×** `rebalance_interval_ms`.
- `RiskGateService.checkTimeStop` (`RiskGateService.ts:1303-1306`) rejects
  `TIME_STOP_MISSING_OR_INVALID` when `timeStopAtMs > nowMs + time_stop_minutes × MS_PER_MINUTE`.

With the default 24h rebalance interval the intent asks for a **48h** hold against a **24h** ceiling,
so every symbol that clears the earlier liquidity checks is rejected on time-stop. At the 01:07 cron
this was **84 of 100** attempts (`depth p50 = $73,326` — deep books that pass spread/depth and would
otherwise be tradeable).

### Root cause 2 — P1: tier1 liquidity floors block the thin momentum leaders

The gate evaluates checks in a fixed order (`RiskGateService.firstFailingCheck`): halts → **spread →
depth** → stateful/time-stop. Liquidity is evaluated **before** time-stop, so fixing P0 alone only
unblocks deep-book symbols at ranks 8+; the thin momentum leaders at ranks 1–7 (the actual signal
targets) still fail liquidity first. Current tier1 per-coin gates
(`apps/engine/src/risk/const/riskConsts.ts`): spread ceiling `TIER_SPREAD_CEILING_PCT.tier1 = 0.15%`,
depth floor `COIN_DEPTH_FLOOR_10BPS_USDT.tier1 = $10,000`. In the smoke era **0 of 85** rows had depth
above $9k (max observed thin-book depth was $7,818); the momentum leaders NFP/TAIKO carried depth
p50 ≈ $1,581–$2,557.

`PAPER_RELAX_MARKET_STRESS` (ADR 0042) does **not** relax per-coin spread/depth, so no existing flag
addresses this.

---

## Goals / non-goals

### Goals

1. **Unblock the PAPER soak so positions actually open**, enabling the first real end-to-end xmom
   trade lifecycle (open → reconcile → time-stop / next-rebalance flatten → realized PnL) to be
   observed and measured.
2. Fix the P0 time-stop ceiling so it is derived from the **same 2× constant** the intent uses,
   centralized in one source of truth so the two sides can never drift again.
3. Add a **paper-only, default-off** per-coin liquidity relax (`PAPER_RELAX_PER_COIN_LIQUIDITY`) so
   thin momentum leaders can clear the gate in PAPER without ever weakening live tier1 floors.

### Non-goals (explicitly out of scope)

- **No change to live tier1 floors.** `COIN_DEPTH_FLOOR_10BPS_USDT.tier1` / `TIER_SPREAD_CEILING_PCT.tier1`
  stay exactly as they are for LIVE. (This is P2 in the source doc, deliberately rejected — max
  observed thin-book depth was $7,818, so lowering tier1 to ~$8k buys almost nothing.)
- **No change to the rebalance cadence.** See "Rebalance cadence — decided, not relitigated" below.
- **No change to the momentum signal, ranking, `top_n`, or the pure core.** M51 touches only the gate
  ceiling and a paper-only floor.
- **No live-capital path.** All M50 live-promotion gates remain closed; M51 changes nothing about
  promotion eligibility. The relax is PAPER-only by construction and reviewer-verified.
- **No relaxation of the `depth=0` / `spread_too_wide` fail-closed behavior** (P3 is investigation-only
  — the fail-closed reject on a `depth=0` feed artifact is *correct* and must not be relaxed).
- **No new rate-limit bucket, no new order type, no execution change.**

---

## Rebalance cadence — decided, do NOT relitigate

The quant reviewer raised (and the user decided) that the cadence must stay the fixed 24h cron. **Keep
`MOMENTUM_REBALANCE_CRON_EXPRESSION = '7 1 * * *'` (`strategyConsts.ts`) exactly as-is. No ADR 0050
amendment, no cron code change.** Reasoning captured here so nobody re-proposes hourly without
re-reading it:

- The xmom signal is a **24h-lookback** ranking. Hour-to-hour the ranking barely moves, so an hourly
  cadence would collapse the intended daily exit into **noise-trading** — reshuffling a top-3 basket on
  rank jitter rather than on a real signal change.
- It would add **fee-churn drag**: `RebalanceSchedulerService.ts` (docstring ~line 381–383) already
  warns that a still-ranked winner closed then reopened pays **double fees**. Hourly churn multiplies
  that.
- It would **corrupt the daily-signal PnL data** the soak is meant to collect — the whole point of the
  soak is a clean daily-cadence trade record comparable to EXP-011/012's 24h/24h operating point.

**The sanctioned way to force extra observation cycles during tuning** is the existing **M50c
manual-trigger surface** — `pnpm rebalance:trigger` (CLI) / `POST /v1/control/trigger-rebalance`
(REST, admin-only, 5-min cooldown guard, `positions.trigger_source` attribution). That lets an
operator drive additional rebalances on demand to watch the fix take effect, **without** polluting the
daily-signal series with hourly noise (manual triggers are attributed via `trigger_source` and can be
excluded from analysis — ADR 0048 § M50c). D5 documents this workflow.

---

## Design

### D1 (P0) — align the time-stop gate ceiling with the 2× intent margin

**One source of truth for the 2× multiplier.** Introduce a single named constant for the momentum
time-stop margin (proposed: `MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER = 2` in `strategyConsts.ts`, replacing
the inline `* 2` literal at `MomentumOrchestratorService.ts:384`). Both the intent and the gate ceiling
derive from it:

- **Intent (unchanged behavior, de-magic-numbered):** `timeStopAtMs = nowMs + rebalance_interval_ms ×
  MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER`.
- **Ceiling (the fix):** `buildGateStrategyParams` derives
  `time_stop_minutes = ceil(rebalance_interval_ms × MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER / MS_PER_MINUTE)`
  instead of `ceil(rebalance_interval_ms / MS_PER_MINUTE)`.

Net: on the default 24h interval the ceiling becomes 48h and the 48h intent passes. `RiskGateService`
is **not** modified — the ceiling is still server-derived from `context.params` (built from the
`strategy_versions` row), never from the intent.

**Why this is not a gate loophole (logic reviewer verified):**

- The ceiling is computed by `buildGateStrategyParams` from the **strategy_versions row**
  (`context.params`), *not* from the incoming intent. A malformed or malicious intent **cannot inflate
  its own ceiling** — it can only propose a `timeStopAtMs`, which the server-derived ceiling then
  bounds. This is the same trust boundary as before; only the numeric ceiling widens.
- The existing **lower-bound guard stays**: `checkTimeStop` still rejects `timeStopAtMs <= nowMs`.
- We **do NOT** add an xmom-specific waiver that skips the upper bound. Skipping the upper bound would
  permit unbounded holds — the opposite of a failsafe. The bound stays; it is just derived from the
  correct multiplier.

**Quant sign-off on the resulting hold:** a 48h max hold on a 24h rebalance cadence is an acceptable
failsafe backstop. The SL still protects intra-hold; the 2× time-stop is insurance for "the rebalance
mechanism failed to run", not the primary exit (the primary exit is the next 01:07 re-rank). If the
scheduler runs normally the time-stop never fires.

**ADR impact:** ADR 0048 already documents the 2× intent margin (D7 hold geometry) and the time-stop
gate-ceiling coupling. D1 is an ADR 0048 **amendment/clarification**, not a new ADR: state that the
gate ceiling MUST be derived from the same `MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER` as the intent, with
the constant as the single source of truth, and that the prior 1× ceiling was the defect. (Architect
confirms whether this rises to an amendment section or a clarifying sentence when authoring.)

### D2 (P1) — paper-only per-coin liquidity relax behind an env flag + ADR

A new **default-off** env flag `PAPER_RELAX_PER_COIN_LIQUIDITY` (boolean) that, **only when
`EXCHANGE_ENV=paper` AND the flag is on**, applies a relaxed per-coin liquidity floor to the gate's
spread/depth checks:

- **Relaxed depth floor candidate: $2,500** (10bps one-sided). Rationale (quant-verified,
  PAPER-specific): a $500 max-per-coin order is **20%** of a $2,500 one-sided 10bps book → ~2 bps linear
  market-impact estimate, a defensible order/book-impact ratio for paper pipeline validation. **Do not
  go below $2,500** — the source doc's book-consumption table shows $2,000 = 25% and $1,500 = 33% are
  too aggressive.
- **Relaxed spread ceiling candidate: 0.30%.**

**Combine per-tier so the relax is never stricter than live (M51 QA-D2b, 2026-07-02).** The relaxed
candidate is NOT applied as a flat unconditional override. A flat $2,500 / 0.30% is looser than live for
tier1 (the intended unblock) and equal for tier2, but **stricter than live for tier3** (live depth floor
$2,000 < $2,500; live spread ceiling 0.50% > 0.30%) — a tier3 symbol that clears the live gate today
would be newly rejected once the flag is turned on, contradicting the design intent ("relaxed rule must
be strictly looser, never accidentally stricter"). The gate instead applies the per-tier combination:

- `effectiveDepthFloor = min(PAPER_RELAX_COIN_DEPTH_FLOOR_10BPS_USDT, COIN_DEPTH_FLOOR_10BPS_USDT[tier])`
- `effectiveSpreadCeiling = max(PAPER_RELAX_SPREAD_CEILING_PCT, TIER_SPREAD_CEILING_PCT[tier])`

For tier1/tier2 (the momentum leaders `xmom` actually targets) this yields the same $2,500 / 0.30% as the
flat value, so the soak-enablement goal is byte-identical; only tier3 is corrected back to its live floor.
Fail-closed on an unknown tier is preserved: the live tier lookup runs first and rejects (too-thin) if it
returns `undefined`, in every env including paper relax. See ADR 0042 §9 item 3 for the blessed contract.

Hard constraints on the design:

- **Paper-only by construction.** The relax path must be unreachable when `EXCHANGE_ENV != paper`,
  regardless of the flag. It reads the *relaxed* floor **only** under `paper` + flag-on; every other
  configuration reads the existing tier-keyed live floors unchanged. Security reviewer greps for any
  path that lets this relax reach a LIVE gate.
- **Never mutates the live tier1 constants.** `COIN_DEPTH_FLOOR_10BPS_USDT` / `TIER_SPREAD_CEILING_PCT`
  are untouched; the relaxed values are separate paper-only constants selected at gate-context build
  time (mirror the `PAPER_RELAX_MARKET_STRESS` precedent, ADR 0042).
- **Default off.** With the flag unset the gate behaves exactly as today (the current soak behavior),
  so turning M51 on is an explicit operator action.

**Fill-simulator fidelity caveat (quant — must be verified during implementation/QA and surfaced in
whatever doc/dashboard reports early PnL).** Determine whether the paper fill simulator charges
book-impact slippage on these relaxed (tier2-thin) fills, or fills flat at mid/best. If it fills flat,
the PnL from tier2-relaxed fills is **pipeline-validation only, not edge** — it would understate the
real slippage a thin-book momentum leader incurs. This must be flagged wherever early M51-era PnL is
surfaced so nobody reads a flat-fill number as realized edge. (This is a verification/annotation
requirement, not a simulator change in M51 — if the simulator needs a slippage model, that is a
separate follow-up.)

**ADR impact:** this is a **new risk-gate behavior** (a paper-conditional liquidity floor), so it needs
an ADR. Per the ADR README topic map, per-coin liquidity floors live in **ADR 0004 § 6a** (depth) and
the paper profile lives in **ADR 0042**. Recommended: an **ADR 0042 amendment** ("Paper exploration
profile") adding the per-coin liquidity relax as a new paper-only relaxation alongside
`PAPER_RELAX_MARKET_STRESS`, with a cross-reference note added to ADR 0004 § 6a stating the live floors
are unchanged and the paper relax is env-gated. The architect confirms amendment-vs-new-ADR when
authoring; the deciding factor is that ADR 0042 already owns "what paper relaxes and why", so the relax
belongs there, with ADR 0004 § 6a carrying only the pointer. Author the ADR **before** the engine
wave (contract touch — `dev-qa-cycle.md` §1.3).

### D3 (P3, stretch) — investigate `depth=0` on `spread_too_wide` rejects

Investigation-only (no relax). The `spread_too_wide` rows in both eras carry
`book_depth_10bps_usdt = 0` at the decision checkpoint (a feed/timing artifact — the book snapshot was
empty when spread was sampled). The logic reviewer confirmed **fail-closed on a `depth=0` row is
correct** — a zero-depth book must reject. D3 is to characterize *why* the snapshot shows `depth=0`
(ingestion timing vs a genuine empty book) and decide whether a snapshot-freshness guard is warranted,
**without** relaxing the fail-closed reject. Output is findings + a tech-debt entry if a real feed-timing
bug is found; **not blocking** for the soak unblock.

### D4 (P4, stretch) — pre-gate-skip visibility

The smoke era logged only **2 of ~100** symbols at the gate because ranks 3+ **skip pre-gate** (no
price/ATR/instrument/sizing → no decision row), leaving the operator blind to *why* most of the
universe never reached the gate. D4 surfaces a `momentum open skipped — no price/ATR/instrument/sizing`
event/metric so the decisions feed / dashboard shows pre-gate skips as first-class rows or counters,
not silent drops. **Not blocking** for the soak unblock; improves observability of the post-fix soak.

### D5 — document the manual-trigger tuning workflow (no code)

Documentation-only. Record, in this plan and (if not already sufficiently covered) as a short operator
note, that the sanctioned way to force extra observation cycles during M51 tuning is the M50c manual
trigger (`pnpm rebalance:trigger` / `POST /v1/control/trigger-rebalance`, 5-min cooldown,
`trigger_source` attribution), **not** a cadence change. Captures the "cadence considered and
deliberately rejected" decision and the reviewer reasoning (see "Rebalance cadence" above) so it is not
re-proposed. No engine code.

---

## Deliverables / tasks (≤ 5 items, minimum surface)

> Per `docs/best-practices/dev-qa-cycle.md` §1: touch the minimum surface, each code item ships a paired
> test that fails before / passes after, and any contract re-interpretation STOPs and surfaces to the
> architect (the ADR touches below pre-bless the contract). Blocking deliverables are **D1 + D2**; D3/D4
> are stretch and may split into a follow-up dispatch; D5 is docs.

| # | Deliverable | Blocking? | Primary files (indicative) | Tests |
|---|-------------|-----------|----------------------------|-------|
| **D1** | P0 time-stop gate-ceiling alignment: centralize the 2× margin in one constant; derive both the intent `timeStopAtMs` and the `buildGateStrategyParams` `time_stop_minutes` ceiling from it | **Yes** | `strategy/const/strategyConsts.ts` (new const), `strategy/service/MomentumOrchestratorService.ts` (intent + `buildGateStrategyParams`) | Paired unit tests: intent proposes 2× and gate ceiling now admits it (fails before: `time_stop_missing_or_invalid`; passes after); lower-bound guard (`timeStopAtMs <= nowMs`) still rejects; ceiling is server-derived (an inflated intent cannot widen its own ceiling) |
| **D2** | P1 paper-only per-coin liquidity relax behind `PAPER_RELAX_PER_COIN_LIQUIDITY` (default off): relaxed depth > $2,500, spread ≤ 0.30%, reachable only under `EXCHANGE_ENV=paper` + flag-on; live floors untouched | **Yes** | risk gate-context build (`risk/service/RiskGateService.ts` context assembly or its params builder), `risk/const/riskConsts.ts` (new paper-only relaxed consts), `config/service/AppConfigService.ts` (flag read), ADR (0042 amendment + 0004 §6a pointer) | Paired unit tests: flag off → current behavior (thin leader still `coin_book_too_thin`); flag on + paper → thin leader at depth $2,600 passes, at $2,400 still fails; **flag on + LIVE `EXCHANGE_ENV` → live tier1 floor still applied (anti-coverage: relax NOT reachable)**; spread 0.29% passes / 0.31% rejects |
| **D3** | (Stretch) `depth=0` `spread_too_wide` investigation — characterize the feed/timing artifact; keep fail-closed; findings + tech-debt entry if a real bug | No | investigation; possible tech-debt note only | n/a (investigation) or a regression test asserting `depth=0` still rejects (fail-closed preserved) |
| **D4** | (Stretch) pre-gate-skip visibility — surface `momentum open skipped — no price/ATR/instrument/sizing` as a decision-feed event/metric | No | `strategy/service/MomentumOrchestratorService.ts` (emit on pre-gate skip) + shared event/enum if it crosses the package boundary (route through `bot-shared-maintainer`) | Test: a ranked symbol missing price/ATR emits the skip event and is counted, does not crash the cascade |
| **D5** | Manual-trigger tuning-workflow documentation (no code) — sanctioned way to force observation cycles; cadence-change considered and rejected | Docs | this plan + operator note if needed | n/a |

**Wave/dispatch note.** D1 and D2 are separable and should be **two sequential engine dispatches** with
a mini-review between (D1 first — it is the dominant blocker and unblocks deep books; then D2 for the
thin leaders), keeping each within the ≤5-file cap. D2 is a contract touch (new risk-gate behavior +
new env flag + ADR) — the architect authors the ADR 0042 amendment **before** the D2 engine dispatch.
D4, if a shared event/enum is added, routes through `bot-shared-maintainer` first (Phase-1 serial),
before the engine emit.

---

## Testing strategy

Per `dev-qa-cycle.md` §2/§4 — each blocking deliverable ships a paired test (fails before / passes
after); adversarial coverage is the bar for done; adversarial failures route to the architect.

**Happy path (regression backbone):**

1. **D1 — deep-book symbol now fills.** A symbol that passes spread/depth with a 2× (48h) `timeStopAtMs`
   on a 24h interval is **approved** (fails before: `time_stop_missing_or_invalid`).
2. **D2 — thin momentum leader now fills in paper.** With `PAPER_RELAX_PER_COIN_LIQUIDITY=true` +
   `EXCHANGE_ENV=paper`, a leader at depth $2,600 / spread 0.10% is **approved** (fails before:
   `coin_book_too_thin`).

**Adversarial (the bar for done):**

3. **D1 — inflated intent cannot widen its own ceiling.** An intent proposing a `timeStopAtMs` far
   beyond 2× is still bounded by the server-derived ceiling and rejected — the ceiling comes from
   `context.params`, not the intent.
4. **D1 — lower-bound guard intact.** `timeStopAtMs <= nowMs` still rejects `TIME_STOP_MISSING_OR_INVALID`.
5. **D1 — no drift.** Changing the rebalance interval keeps intent and ceiling in lockstep (both derive
   from the single `MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER` constant) — a boundary test at a non-default
   interval.
6. **D2 — anti-coverage: relax never reaches LIVE.** Flag on **but** `EXCHANGE_ENV` LIVE → the live
   tier1 floor ($10k / 0.15%) is applied; the relaxed floor is asserted **not** used. This is the
   security-critical test.
7. **D2 — default off.** Flag unset → identical to current behavior (thin leader still `coin_book_too_thin`).
8. **D2 — floor boundaries.** Depth exactly at $2,500 rejects (boundary is `<=`), $2,501 passes; spread
   0.30% vs 0.31% at the ceiling.
9. **D2 — live floors byte-for-byte unchanged.** Assert `COIN_DEPTH_FLOOR_10BPS_USDT` /
   `TIER_SPREAD_CEILING_PCT` values are not mutated.
10. **D3 (if done) — `depth=0` still rejects.** Fail-closed preserved on a zero-depth snapshot.
11. **D4 (if done) — pre-gate skip surfaces.** A ranked symbol with no price/ATR emits the skip
    event/metric and the cascade continues without crashing.

**Live-app PAPER smoke (mandatory before close, `dev-qa-cycle.md` §6.4).** Boot the app in PAPER with
`PAPER_RELAX_PER_COIN_LIQUIDITY=true`, drive `pnpm rebalance:trigger` end-to-end at least once, and
confirm ≥1 gate **approval** and a position opening (the outcome the whole milestone exists to enable),
with no `ERROR` / DI-cycle / boot-pipeline failure.

---

## Rollout / reversibility

- **D1** is a pure config-ceiling alignment: it takes effect for all PAPER (and, harmlessly, any future
  momentum) rebalances immediately on deploy. Reversible by reverting the constant derivation. It does
  not change LIVE behavior because no live momentum path is enabled.
- **D2** is **default-off and paper-only**: shipping the code changes nothing until an operator sets
  `PAPER_RELAX_PER_COIN_LIQUIDITY=true` in a PAPER environment. Reversible by unsetting the flag (no
  redeploy needed). It can never affect LIVE (reviewer-verified, test #6).
- **No DB migration** expected (config + gate-context logic only). If implementation discovers a
  migration is unavoidable, the engineer STOPs and surfaces it (CLAUDE.md rule-9 dump + confirm flow).
- **Operator runbook after deploy:** set `PAPER_RELAX_PER_COIN_LIQUIDITY=true` in the paper soak env,
  confirm `strategy_versions` id=20 params are reset to `{}` (24h defaults) per the M50b operator note,
  then either wait for the 01:07 cron or drive `pnpm rebalance:trigger`. Expected: ≤3 gate approvals
  per cycle (cascade stops at `top_n=3`), **not** ~100 rejects. First fills should appear.

---

## ADR impact

- **ADR 0048 (Rebalance orchestrator) — AMEND/clarify (D1).** State that the momentum time-stop gate
  ceiling (`buildGateStrategyParams.time_stop_minutes`) MUST be derived from the **same**
  `MOMENTUM_TIME_STOP_MARGIN_MULTIPLIER` (2×) as the intent's `timeStopAtMs`, with the constant as the
  single source of truth; the prior 1× ceiling was the defect that rejected every deep-book symbol on
  `time_stop_missing_or_invalid`. The lower-bound guard and the server-derived (not intent-derived)
  ceiling are unchanged.
- **ADR 0042 (Paper exploration profile) — AMEND (D2, primary).** Add the paper-only per-coin liquidity
  relax (`PAPER_RELAX_PER_COIN_LIQUIDITY`, default off): relaxed depth > $2,500, spread ≤ 0.30%,
  reachable only under `EXCHANGE_ENV=paper` + flag-on, never mutating the live tier1 constants — mirrors
  the existing `PAPER_RELAX_MARKET_STRESS` relaxation.
- **ADR 0004 § 6a (per-coin depth floor) — additive pointer note (D2).** Record that the live tier1/2/3
  floors are unchanged and that a paper-only env-gated relax exists (owned by ADR 0042), so a future
  reader of § 6a does not think the live floor moved.
- **No new ADR required.** The architect signs off on the ADR 0048 clarification, the ADR 0042 amendment,
  and the ADR 0004 § 6a pointer before the engine waves. Update `docs/architecture/adr/README.md` if the
  ADR 0042/0048 anchors change.

---

## What NOT to change (scope boundaries)

- **Live tier1 floors** (`COIN_DEPTH_FLOOR_10BPS_USDT` / `TIER_SPREAD_CEILING_PCT`) stay byte-for-byte
  unchanged (P2 rejected).
- **Rebalance cadence** — the `7 1 * * *` UTC cron is unchanged; no ADR 0050 amendment, no cron code.
- **The momentum signal / pure core / `top_n` / ranking** — untouched.
- **`RiskGateService.checkTimeStop`** logic — untouched; only the *ceiling value* fed to it via
  `context.params` changes (D1). No xmom-specific waiver, no upper-bound skip.
- **`depth=0` / `spread_too_wide` fail-closed reject** — preserved (P3 is investigation, not relax).
- **No live-capital path, no promotion-gate change, no new order type, no new rate-limit bucket.**

---

## Open questions

1. **Fill-simulator slippage on relaxed tier2 fills (D2 caveat).** Does `StreamingFillAdapter` charge
   book-impact slippage on a thin-book fill, or fill flat at mid/best? Must be verified during D2
   implementation/QA. If flat, early M51-era PnL is **pipeline-validation only, not edge**, and must be
   annotated as such wherever it surfaces. A slippage model, if needed, is a separate follow-up — not
   opened here.
2. **Amendment vs new ADR for D2** (recommend ADR 0042 amendment + ADR 0004 §6a pointer) — architect
   confirms when authoring.
3. **D3/D4 sequencing** — stretch; may ship as a follow-up dispatch after D1/D2 land and the soak is
   confirmed unblocked, rather than blocking milestone close.
4. **How many approvals-per-cycle is "healthy"?** After the fix the cascade should stop at `top_n=3`;
   rank-1 may still be illiquid so 3 fills every cycle is not guaranteed (source doc "expected outcome"
   §). The success criterion for M51 is **≥1 fill and a full observed lifecycle**, not a fixed daily
   fill count.

---

## Supersedes / links

- **Implements** the P0/P1 (blocking) and P3/P4 (stretch) recommendations of
  [`docs/wip/2026-07-01-xmom-paper-liquidity-gate-analysis.md`](../wip/2026-07-01-xmom-paper-liquidity-gate-analysis.md).
  That doc's `Status:` line is updated to reference M51 as the implementing milestone.
- **Builds on** M50 / M50b (ADR 0048, 0050) and M50c (manual-trigger surface, ADR 0048 § M50c amendment).
- **Does not affect** the M44 shadow-fidelity soak gate or the M50 live-promotion gate — both remain
  open and unchanged.
