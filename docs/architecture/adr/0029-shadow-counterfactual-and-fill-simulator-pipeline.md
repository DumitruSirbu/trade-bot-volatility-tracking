# ADR 0029 — Shadow-mode counterfactual + fill-simulator pipeline (M11a)

**Status:** Accepted (M11a W0 design wave)
**Date:** 2026-05-25
**Milestone:** M11a (local soak hardening)
**Depends on:** ADR 0015 (BacktestModule + fill simulator), ADR 0017 (same-event comparison),
ADR 0018 (paired circular-block bootstrap on expectancy-per-unit-risk),
ADR 0019 (12-criterion promotion gate — criterion 12 `lowFidelity` rule).
**Related:** `docs/plans/M11a-local-soak.md` §W0.5 (`shadow_decisions` table + `simulated_fill`
JSONB schema), §W0.6 (the contracts this ADR locks), §W4.2 (how shadow runs over
the live event tape), §"Soak exit criteria → M11b" (the "active version beats
shadow v2/v3" gate).

**Numbering note:** the key-permission ADR (`IKeyPermissionSnapshot` + ccxt port,
M11a W0.2) is being authored in parallel and claims 0028. This ADR claims the
next free index 0029.

## 1. Context

The M11a soak runs v1 live against Binance demo trading while v0/v2/v3 emit
decisions over the same `event_id` tape without ever being routed to the
exchange. The soak's reduced-gate exit criterion **"active version beats
shadow v2/v3"** (M11a §"Soak exit criteria → M11b") feeds those non-executed
versions into the paired circular-block bootstrap defined in ADR 0018. Two
independent reviewers flagged that this comparison is statistically unsound
without two pieces of machinery being explicit upfront:

1. A non-executed version that is **filtered by v1's slot state** is not a
   counterfactual — it is a censored, anti-conservative subset of its own
   decisions. v2/v3 must each be evaluated against their **own** restricted-
   profile state, on the **same event tape** v1 sees.

2. A non-executed version scored at **decision price** trivially beats v1 by
   construction. v1 pays real adverse selection, latency, spread, partial
   fills, and missed-fill cancellations; awarding v2/v3 the decision-price PnL
   while charging v1 the live fill is not a comparison, it is a bias.

The M11a plan pins both contracts inline in §W0.6 so W4 has nothing left to
design. This ADR makes them permanent and binds them by name to the M7 fill
simulator (ADR 0015) and the M8 statistical machinery (ADRs 0017–0019).

## 2. Decision

### 2.1 Independent virtual ledgers per shadow version

Each shadow version maintains its **own** `IVirtualPositionLedger` instance
honouring the same restricted-profile gates the live v1 honours:

| Gate | Source (M11a §W4.1 restricted profile) |
|---|---|
| `max_open_positions` | `1` |
| `max_trades_per_day` | `3` |
| `halt_after_consecutive_losses` | `2` |
| `require_exhaustion_confirmation` | `true` |
| `skip_market_stress` | `true` |
| `margin_mode` | `isolated` |

**Cardinal rule:** a shadow version is *never* filtered by v1's slot state.
At each event in the tape the orchestrator presents the same input to v1 (the
live `StrategyService` path) and to each shadow version (`v0`, `v2`, `v3`),
where each shadow version's gate-evaluation reads **only its own ledger** and
its own per-version `risk_state`-shaped counters. This is the counterfactual:
"what would version X have decided with its own state at this event."

#### 2.1.1 The interface

`packages/shared/` exposes `IVirtualPositionLedger`. Naming follows the
project convention (`I`-prefix, PascalCase, camelCase methods; `code-conventions.md`
§ "Naming Conventions"). The exact method surface is implementation-detail
for W0 dispatch, but the contract this ADR locks is:

```text
interface IVirtualPositionLedger {
    // Read — pure projections, never mutate.
    snapshotForDecision(nowMs: number): IVirtualLedgerSnapshot;
    isHalted(nowMs: number): boolean;
    countOpenPositions(): number;
    countTradesOpenedOnRiskDay(riskDayUtcDate: string): number;
    countConsecutiveLossesInRiskDay(riskDayUtcDate: string): number;

    // Gate — composes the restricted-profile checks above; returns the
    // structured outcome the orchestrator records on the shadow_decisions row.
    evaluateGates(input: IVirtualGateInput): IVirtualGateOutcome;

    // Mutate — invoked only by the orchestrator after a shadow decision has
    // been routed through the fill simulator (§2.3) and produced a simulated
    // fill record. Idempotent on `eventId` — replay must not double-open.
    tryOpen(open: IVirtualOpenInput): IVirtualMutationResult;
    tryClose(close: IVirtualCloseInput): IVirtualMutationResult;
}
```

`IVirtualLedgerSnapshot` is the JSONB shape stamped into
`shadow_decisions.virtual_slot_state_snapshot` (M11a §W0.5). It is the per-
event ledger state at the moment the gate was evaluated; the simulated fill
result that follows is stamped into the sibling `simulated_fill` column.

#### 2.1.2 What is stored per ledger

The ledger holds enough to make the gates deterministic:

- An open-positions list (length ≤ `max_open_positions`) of
  `{ symbol, side, openedAtMs, openedAtEventId, entryPrice, qty, stopLoss,
    takeProfit, virtualOrderId }`.
- A closed-positions log keyed by `(riskDayUtcDate, closeReason)` sufficient
  to count consecutive losses and trades-per-day.
- A `haltedUntilRiskDayUtcDate: string | null` field set when
  `halt_after_consecutive_losses` fires; cleared on the next risk-day rollover.
- The per-version `lastEventIdProcessed` (idempotency cursor for replay).

The ledger is **in-memory per run** (counterpart to ADR 0015 §4.5's
`BacktestReservationLedgerAdapter` and `BacktestPositionAdapter`). A soak
restart rebuilds each ledger by replaying `shadow_decisions` rows for the
version in `event_id` order — the rows are the durable record; the ledger is
a projection.

#### 2.1.3 Shadow-close semantics (pinned)

`halt_after_consecutive_losses` and `max_trades_per_day` require a definition
of "loss" and "day" for the virtual ledger. This ADR pins both:

A shadow position closes on exactly one of:

1. **Simulated SL/TP intra-bar stop** — the M7 `IntrabarStopSimulator` (ADR
   0015 §4.6) signals SL, TP, time-stop, or liquidation. `closeReason ∈
   { 'sl', 'tp', 'intra_bar_stop' }`. PnL sign determines "loss".
2. **M7 end-of-window force-close** — at `IBacktestConfig.toMs`, any still-
   open virtual position is force-closed at the last available reference
   price. `closeReason = 'force_close'`. Treated as **realised PnL** at the
   force-close price (sign determines "loss"); this is the M7 force-close
   convention reused unchanged.
3. **Reverse-signal from the same version** — the same shadow version emits a
   decision on a later event that, were it routed live, would close the
   existing position (an opposite-side open under `max_open_positions: 1`).
   `closeReason = 'reverse_signal'`. PnL sign determines "loss".

No other close path exists for the virtual ledger. In particular, v1's close
events do **not** close shadow positions — each version's ledger is sovereign.

**"Day" definition.** The risk-day boundary follows the live `risk_day`
boundary exactly: the UTC date string derived from `nowMs` via
`new Date(nowMs).toISOString().slice(0, 10)`. The source of truth in code is
`RiskGateService` (`apps/engine/src/risk/service/RiskGateService.ts`) which
computes `utcDateString` at every gate evaluation; the virtual ledger reuses
this exact derivation so the `halt_after_consecutive_losses` and
`max_trades_per_day` gates behave identically to v1's. Whether the project
later promotes this derivation to a shared helper (`startOfUtcDayMs` already
exists in the bootstrap module) is implementation detail — the contract is
"same string v1's gate computes for the same `nowMs`."

### 2.2 Each shadow version evaluates the same event tape

The W4.2 orchestrator presents every event in v1's tape to **every** shadow
version. Filtering happens inside the version's own gate evaluation against
its own ledger, never at the orchestrator. Concretely:

```text
for each event in eventTape:
    v1_outcome   = liveStrategyServiceEvaluate(event)        // unchanged
    for each shadow_version in [v0, v2, v3]:
        ledger    = ledgers[shadow_version]
        decision  = shadow_version.evaluate(event)            // pure
        gateOutcome = ledger.evaluateGates({ event, decision, ... })
        simFill   = fillSimulator.simulate(decision, marketSnapshot, tier, ledger.snapshotForDecision(event.nowMs))   // §2.3
        recordShadowDecision({
            eventId: event.eventId,
            shadowVersion: shadow_version.id,
            virtualSlotStateSnapshot: ledger.snapshotForDecision(event.nowMs),
            simulatedFill: simFill,
            decision, gateOutcome,
        })
        if simFill.opened:  ledger.tryOpen(...)
        if simFill.closed:  ledger.tryClose(...)
```

The orchestrator's loop is the only place that touches multiple ledgers; the
ledgers themselves are isolated.

### 2.3 Fill-simulator pipeline (hard rule)

**Every shadow decision is routed through the M7
`BacktestRunnerService` fill simulator (ADR 0015 §4.6) before any comparison
metric is computed.** Raw "filled at decision price" PnL is **forbidden** as a
comparison input, full stop. Rationale: decision-price PnL ignores adverse
selection, partial fills, latency, missed limit fills, and the spread v1
actually pays — using it would make every shadow version beat v1 by
construction and the comparison would be a tautology, not evidence.

#### 2.3.1 Input contract

The simulator receives the same shape it receives in M7 backtests, with one
addition (the virtual-ledger snapshot, so the simulator can short-circuit
when the gate refused the trade):

```text
ISimulatedFillInput {
    decision:               IStrategyDecision;        // shadow strategy output
    marketSnapshot:         IMarketSnapshot;          // tier, last/mark, spread, bookSnapshotRowOrNull
    tier:                   CoinTierEnum;
    virtualLedgerSnapshot:  IVirtualLedgerSnapshot;   // §2.1.2
    nowMs:                  number;
    eventId:                string;
}
```

If `decision.action ∈ { 'skip' }` or `gateOutcome.allowed === false`, the
simulator emits a `missed: false, opened: false` record (no fill — the gate
denied or the strategy declined). If `decision.action === 'open'` and the
gate allowed it, the simulator runs the full pipeline from ADR 0015 §4.6:
`LatencyModel` → `MissedFillModel` → `TierSlippageModel` → optional
`DepthAwareSlippageExtension` → final fill price. Exit-side fills are driven
by `IntrabarStopSimulator` exactly as M7 does.

#### 2.3.2 Output contract

The output is the `ISimulatedFill` JSONB shape pinned in M11a §W0.5 and
reproduced here verbatim for permanence:

```ts
interface ISimulatedFill {
    entryPrice:          string;          // decimal
    exitPrice:           string | null;   // null until close
    slippageEntryPct:    string;          // decimal, signed
    slippageExitPct:     string | null;
    slippageComponents: {
        tierBase:        string;
        latency:         string;
        crossingSpread:  string;
    };
    missed:              boolean;         // true if simulator skipped the fill
    forceClose:          boolean;         // true if closed by end-of-window rule
    lowFidelity:         boolean;         // mirrors M7 IBacktestReport
    closedAt:            string | null;   // ISO timestamp of simulated close
    closeReason:         'sl' | 'tp' | 'force_close' | 'intra_bar_stop' | null;
}
```

This shape is stored in `shadow_decisions.simulated_fill` (jsonb). Adding a
sibling boolean (`opened`) inside the row that mirrors `decision.action ===
'open' && gateOutcome.allowed === true` is a recording detail for W0; this
ADR fixes the simulated-fill shape, not the wrapper row schema beyond what
M11a §W0.5 already pins.

#### 2.3.3 Hard rule restated

> **Raw decision-price PnL is forbidden as a comparison input.** Every per-
> event outcome series fed into ADR 0018's bootstrap is derived from
> `ISimulatedFill` — entry/exit prices, slippage components, and the
> close-reason driven exit. A future contributor who wants to add an
> "ideal-fill" diagnostic series may do so as a **separate** report column
> labelled clearly as a counterfactual upper bound; it never enters the
> comparison gate.

### 2.4 `lowFidelity` propagation — mirrors ADR 0019 criterion 12

Every shadow trade carries the M7 `lowFidelity` flag (ADR 0015 §4.6 — set
`true` when `book_snapshots` rows are missing for the trigger window and the
simulator falls back to bar-extreme heuristics; currently `lowFidelity`
defaults to `true` for all trades until the depth-aware extension lands —
M11a §"Soak exit criteria" + M8 deferred list).

The shadow-comparison report **must** produce two rankings:

- **Full-set ranking** — over all shadow trades.
- **`lowFidelity`-excluded ranking** — recomputed with `lowFidelity === true`
  trades removed from both v1's realised series and each shadow version's
  simulated series (paired removal — if event `e` is `lowFidelity` for any
  participant, it is removed from the difference series for that pair, the
  same removal rule M8 ADR-0019 criterion 12 applies).

The "active version beats shadow v2/v3" soak exit criterion requires the
**same winner on both rankings**. If they disagree, the criterion is marked
**inconclusive** (mirroring ADR 0018's third-state outcome) and the soak
gate downgrades to the v1-only expectancy-CI rule from M11a §"Soak exit
criteria" ("Net positive expectancy on v1's executed trades after fees +
funding + realised slippage, with bootstrap 95% CI excluding zero").

### 2.5 Comparison metric

The metric reused for "active version beats shadow v2/v3" is **exactly** ADR
0018's paired circular-block bootstrap on expectancy-per-unit-risk
differences:

- **Unit of analysis (`r`)** — per ADR 0018 §2.1: `r_t = netPnl_t /
  riskBudgetSpent_t`, with `netPnl_t` after fees + funding + simulated
  slippage and `riskBudgetSpent_t` read from the position's post-clamp
  stop-distance × qty. For shadow versions, `netPnl_t` is derived from
  `ISimulatedFill` (entry/exit prices, slippageComponents). For v1, the live
  realised PnL series is used unchanged.
- **Pairing** — by `event_id`, per ADR 0017. Same-event comparison is what
  makes v1's executed outcomes commensurable with v2/v3's simulated outcomes
  on a per-event basis. Source of truth: ADR 0017 §2 + ADR 0018 §2.2.
- **Block-length selection** — Politis–White automatic selection on the
  difference series (ADR 0018 §2.3), floor of 4, upper bound `|D| / 5`.
- **n** — fixed at **10,000 resamples**. Not a config knob (ADR 0018 §2.4).
- **CI level** — **95% two-sided**. Not a config knob (ADR 0018 §2.4).
- **Seed** — deterministic hash of `(run_label, pair_id)` per ADR 0018 §2.4.

The source of truth in code for `n`, the CI level, the Politis–White
implementation, and the seeded PRNG is the M8 statistics module (M8 W3 owns
the implementation). The shadow-comparison report **imports** that module;
it does not re-derive any of these constants. Drift between the soak gate
and the M8 promotion gate would defeat the purpose of mirroring ADR 0018.

### 2.6 Fail-safe — gate suspension at soak-start

If either the `IVirtualPositionLedger` or the fill-simulator pipeline is
missing at soak-start (W0 dispatch incomplete; partial deployment; deferred
implementation), the **"active version beats shadow v2/v3" exit criterion is
suspended**. The soak still runs, and `shadow_decisions` rows may still be
recorded with whatever shape is available, but the gate evaluation
downgrades to:

- **Only** the M11a "Net positive expectancy on v1's executed trades, 95%
  bootstrap CI excludes zero" rule applies for the "active version beats
  shadow" comparison criterion.
- The shadow-comparison report explicitly labels the missing component
  (`ledger_missing` or `fill_simulator_missing` or both) so the operator
  cannot mistake the downgrade for a passing comparison.

This codifies the M11a §"Soak exit criteria" note: "The 'beats shadow' exit
criterion is suspended if either the ledger or the fill-simulator pipeline
is missing at soak-start." The same fail-safe applies if, mid-soak, the
fill-simulator's `book_snapshots` history is so sparse that every shadow
trade is `lowFidelity` — the two-ranking rule (§2.4) then collapses the
ranking-disagreement path into "inconclusive" and the v1-only gate is the
operative one.

## 3. Consequences

**Positive**

- Shadow comparison is structurally fair: each version evaluates the same
  events against its own state, scored through the same fill simulator v1
  would be scored against in a backtest.
- The comparison metric is **identical** to ADR 0018's promotion-gate metric.
  A version that beats v1 in shadow is on the same statistical bar a future
  M8 promotion candidate would face.
- The `lowFidelity` two-ranking rule prevents the soak from promoting a
  version whose edge exists only on bars the depth-aware extension would
  reject.
- The fail-safe means a partial W0 dispatch does **not** silently weaken the
  gate — it explicitly downgrades.

**Negative**

- Per-event ledger evaluation × 4 versions × every event multiplies the
  orchestrator's per-event work by ~4. Acceptable: shadow ledgers are pure
  in-memory `Map` operations and the strategies themselves are already pure
  and cheap.
- `shadow_decisions` volume scales with the event tape, not with executed
  trades. Sizing falls under M11a §W3.10 retention (decisions floor at soak-
  duration + 30 days); shadow_decisions inherits the same floor because the
  exit-gate evaluator reads them. The M11a W4.4 calibration day must
  measure shadow-decisions growth alongside `decisions`.
- A reverse-signal close on a shadow position requires the same version to
  emit an opposite-side signal — a v2/v3 strategy that rarely signals
  opposite sides will rely on M7 force-close for most exits. This is
  acceptable; force-close is a documented closure path with realised PnL
  semantics (ADR 0015 §4.6).

## 4. Alternatives considered

1. **Filter shadow versions by v1's slot state ("only consider shadow
   decisions on events v1 chose to act on").** Rejected — this is anti-
   conservative censoring. It throws away every event where v1 sat out and
   v2/v3 would have entered. The whole point of shadow mode is to ask "what
   would version X have done if it were live"; pinning to v1's slot timing
   answers a different question.

2. **Single shared virtual ledger across all shadow versions.** Rejected —
   then shadow v2 occupies the slot, shadow v3 sees no slot, and the
   comparison is again censored. Every version must reason about its own
   capacity in isolation.

3. **Score shadow decisions at decision price (raw counterfactual PnL).**
   Rejected — see §2.3. Decision-price PnL is a tautological win for the
   non-executed version. The whole reason M7 ships a fill simulator is so a
   non-executed decision can be evaluated against the same costs the live
   path pays.

4. **Run shadow versions through a *separate* "shadow fill simulator" tuned
   to demo-trading conditions.** Rejected — two implementations of the same
   pipeline create the exact drift ADR 0015 §5 was designed to prevent.
   Demo-trading realised slippage diverges from M7's testnet-tuned tier
   model — this is acknowledged in M11a §"Soak exit criteria" ("Realized
   slippage recorded and recalibrated") — but the *correction* is a single
   tier-model recalibration (M8 deferred depth-aware extension), not a
   forked simulator.

5. **Defer the `lowFidelity` two-ranking rule until the depth-aware
   extension lands.** Rejected — the M8 ADR-0019 criterion 12 rule applies
   here for exactly the same reason it applies there: until depth-aware
   data is universally available, every shadow trade is `lowFidelity` and
   the report must surface that. Without the two-ranking rule the soak
   would accept a winner driven entirely by trades the simulator marks as
   not-yet-trusted.

6. **Bonferroni-correct across the three shadow comparisons (v0 vs v1,
   v2 vs v1, v3 vs v1).** Considered. Rejected by symmetry with ADR 0018
   §2.7: the shadow report logs the raw CIs and a `multipleComparisonNote`,
   and the soak exit criterion's "same winner on both rankings" rule is a
   stronger filter than Bonferroni in practice. v0 has no fill events so its
   pairwise CI is effectively "v1 vs zero" — that case is already the v1-
   only expectancy gate.

7. **Stream shadow decisions to a sidecar JSONL file instead of a Postgres
   table.** Rejected at the M11a §W0.5 level (untyped, not queryable from
   the read API, fails the "criteria must be measurable from recorded data"
   rule). This ADR inherits that decision and assumes `shadow_decisions` is
   the recording surface.

## 5. Open questions

- **Per-version `risk_state`-shaped counters in the ledger.** The virtual
  ledger needs the equivalent of the live `risk_state` row's daily/weekly
  loss windows for the `halt_after_consecutive_losses` gate. M11a §W2.4 fixes
  the live `risk_state.updated_at` newer-wins concern but does not extend
  `risk_state` to shadow versions. Decision deferred to W0 dispatch: either
  (a) hold the per-version counters inside `IVirtualPositionLedger` only and
  never persist them (rebuilt on restart by replaying `shadow_decisions`),
  or (b) add a `shadow_risk_state` table. Option (a) is preferred — fewer
  moving parts, the ledger is already authoritative — and is the assumed
  default unless W0 surfaces a reason to persist.

- **`event_id` continuity across shadow restarts.** The ledger's
  `lastEventIdProcessed` cursor must survive an engine restart so a shadow
  version does not double-open on replay. The `shadow_decisions` row itself
  is sufficient to rebuild the cursor (max `event_id` per `shadow_version`),
  but the rebuild path should be exercised in the M11a §W4.3 crash-recovery
  drill. W4 owns this drill update.

- **Shadow position sizing input.** The fill simulator needs a notional/qty
  for the simulated fill. Decision: shadow versions size against a notional
  pool **scaled to the live restricted profile** (same `risk_per_trade_pct`,
  same `max_coin_tier`, same account-equity reference snapshot v1 uses for
  the event). This keeps v2/v3's simulated PnL on the same monetary scale as
  v1's realised PnL, so the per-event `r` series is dimensionally
  comparable. The exact mechanism (read v1's account equity at the event, or
  hold a per-shadow virtual equity?) is a W0 implementation question; this
  ADR locks "same scale, same `risk_per_trade_pct`," not the bookkeeping.
