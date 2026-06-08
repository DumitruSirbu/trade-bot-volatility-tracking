# M26 — Shadow counterfactual fill wiring (feed real bar evidence + tick_aggregates into simulateShadowFill)

> **Sequencing note:** M26 is the third milestone of the data-fix arc (M24→M25→M26→M27) from the
> architect analysis [main-architector-paper-soak-fill-and-gate-analysis.md](../wip/main-architector-paper-soak-fill-and-gate-analysis.md)
> (analysis item **P4**). It is a **separate, independent track** from M24/M25: those fix the *live
> paper* fill + gate; M26 fixes the *shadow counterfactual* fill so dormant strategy versions (v2
> momentum, v3 hybrid) produce virtual PnL for same-tape comparison. M26 can run in parallel with
> M24/M25 — it touches the shadow orchestrator, not the live gate or paper simulator. It is
> engine-only and migration-free (it reuses the existing `tick_aggregates` table that M7 already
> reads).

## Context

`ShadowStrategyOrchestratorService.simulateShadowFill` builds its fill request with **no real fill
evidence** — bar high/low collapsed to the entry price and an empty tick array:

```299:327:apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts
    private simulateShadowFill(
        shadow: IResolvedShadow,
        event: IVolatilityDetectedEvent,
        side: PositionSideEnum,
        // ...
            limitPrice: entryPrice,
            qty: new Money(qtyStr),
            coinTier: event.coinTier,
            signalBarOpenMs: event.entryCandleOpenTime,
            barHigh: entryPrice,
            barLow: entryPrice,
            // Shadow path has no historical tick replay or live book snapshot —
            // empty inputs force the simulator's bar-extreme fallback (lowFidelity
            // = true), matching ADR 0029 §2.4 "every shadow trade is lowFidelity
            // until the depth-aware extension lands".
            ticks: [],
            bookSnapshot: null,
```

Because the shared miss-detector marks an empty tick array on a limit policy as a **guaranteed miss**
(see M24 context / `missedFillDetector.ts`), every `simulated_fill` is
`{ "missed": true, "entryPrice": "0", "lowFidelity": true }`. `tryOpen()` is gated on
`!simulatedFill.missed`, so it **never runs** — the `VirtualPositionLedgerService` stays empty, and
there is **no shadow PnL, no virtual win/loss, no M11b counterfactual comparison** (ADR 0018
bootstrap needs realized shadow outcomes).

**Critically, changing only `barHigh`/`barLow` to real bar extremes does *not* fix it** — the
detector inspects `ticks`, not the bar. The orchestrator already has the join key
(`event.entryCandleOpenTime`, `event` symbol, `event.coinTier`); it simply never loads the ticks. M7
backtest works precisely because `BacktestOrchestrator` loads `tick_aggregates` for the signal bar and
passes them as `ticks`. M26 does the same on the shadow path.

## Review amendments (locked 2026-06-08 — 3 independent analysts)

Independent reviews (`docs/independent-analysis/{composer,gbt,gemini}/M26-*`) **approve the direction**
(Design A — DB-load `tick_aggregates` in the orchestrator, no shared core change, parallel with
M24/M25, `lowFidelity` preserved) but flagged **code-verified** corrections. All are folded in below:

- **A1 (must-fix) — DI must avoid a module cycle.** `StrategyModule → BacktestModule → StrategyModule`
  would form if the shadow orchestrator injected `CandleLoader` (it lives in `BacktestModule`, which
  imports `StrategyModule`). `StrategyModule` already imports `MarketDataModule`, which **exports
  `TickAggregateRepository`** (verified). Inject that repo and add a half-open
  `loadTicksForBar(symbol, barOpenMs)` method on it mirroring `CandleLoader`'s query — do **not** pull
  `BacktestModule` or use a raw `@InjectRepository` in `StrategyModule`.
- **A2 (must-fix) — load ticks once per event, not once per shadow version.** `runShadows` loops over
  every shadow (v2 + v3 + future); loading inside `runOneShadow` issues N identical SELECTs and creates
  a determinism surface if data lands late between versions. Load the evidence **once per event** in
  `runShadows` and thread an immutable evidence object into each `runOneShadow` (M7 does exactly this).
  Test: one DB call per event regardless of shadow count; all versions see the same verdict.
- **A3 (must-fix) — missing-data tagging is analysis-layer, durable field deferred to M27.**
  `ISimulatedFill` has **no** `missedReason`/`dataQuality` field and `lowFidelity` is already `true` for
  every shadow fill (verified), so item 5 cannot tag durably without a shared change. **Decision (user,
  2026-06-08):** keep M26 engine-only — represent missing-data misses via (a) the analysis-layer SQL
  pattern `missed=true AND no tick_aggregates for (symbol, bar)` and (b) a `debug` log carrying
  `eventId`/`symbol`/`barOpenMs` when the tick load returns `[]`. The **durable
  `ISimulatedFill.missedReason` field is deferred to M27** (the data-capture milestone). QA asserts
  join/log-detectability, **not** a stored field. Do **not** overload `slippageComponents.latency`.
- **A4 (must-fix) — mirror M7 next-bar entry (chosen contract).** M7 fills the entry at the **next bar
  open** (`BacktestOrchestrator` `ctx.nextBarOpen`; forward-look fix, ADR 0015 §6); shadow currently
  uses the **signal-bar** `reconstructReferencePrice`. **Decision (user, 2026-06-08): shadow mirrors M7
  next-bar entry.** Load/derive the next-bar open and use it consistently for `entryPrice`, sizing,
  `limitPrice`, and the fill-timestamp assumption. When no next bar exists (signal bar is the last
  replay bar for the symbol), **decline the shadow open and tag missing-data** — mirroring
  `BacktestOrchestrator` returning `null`. "Same-tape parity" QA now means **both** tick-source identity
  **and** next-bar entry alignment vs M7 for the same `event_id`; quant owns the counterfactual-validity
  sign-off. This is a deliberate behavior change to shadow entry pricing (beyond "just load ticks").
- **A5 (should-fix) — half-open tick window.** `TickAggregateRepository.findRange` uses `Between`
  (inclusive both ends, verified); a 5m bar is `[barOpen, barOpen + 5m)`. Use `tick.ts < barOpen + 5m`
  (mirror `CandleLoader`). Boundary tests at `barOpen`, `barOpen + 5m − 1s`, `barOpen + 5m` (the last
  must be excluded — it is the next bar's first tick).
- **A6 (should-fix) — bar high/low from the loaded tick set.** Derive `barHigh`/`barLow` from the
  loaded ticks' min/max (not a separate `candles` read — mixed sources contradict if persistence lags).
  For **opens** the bar extremes do not drive `isMissedFill` (ticks do); item 2 is snapshot consistency,
  not a second fix. When ticks are absent, keep the conservative miss — never load candle extremes while
  passing `ticks=[]`.
- **A7 (should-fix) — forward-only ledger.** `rebuildLedger` replays *persisted* `simulated_fill` rows;
  pre-M26 `shadow_decisions` stay `missed:true` after restart. The virtual ledger grows **from deploy
  forward**; full-14-day-window M11b comparison needs a separate backfill/replay job (out of scope —
  note in scribe/post-deploy).
- **A8 (should-fix) — close-side remains a known limitation.** Shadow still closes reverse signals at
  `reconstructReferencePrice` (close-side fill sim is deferred). Acceptance language is **"entry-side
  shadow PnL becomes computable, with the close-side reference-price proxy a known low-fidelity
  limitation"** — quant classifies whether that proxy is acceptable for M11b or needs a follow-up.
- **A9 (watch) — write-read race (Gemini).** Shadow runs off the live loop; `tick_aggregates` for the
  signal bar may not be flushed when the orchestrator queries. The conservative missing-tick path makes
  this safe (it tags, never fabricates), but post-deploy must confirm the miss rate reflects real
  no-touch, not a persistence lag — and the table must be indexed on `(symbol, ts)`.

## Scope

1. **Load `tick_aggregates` for the signal bar once per event** (A1/A2), keyed by
   `(symbol, entryCandleOpenTime)` over the **half-open window `[barOpen, barOpen + 5m)`** (A5), via a
   new `loadTicksForBar(symbol, barOpenMs)` on the `MarketDataModule`-exported `TickAggregateRepository`
   — **not** `CandleLoader`/`BacktestModule` (module cycle). Load in `runShadows` and thread an immutable
   evidence object into each `runOneShadow`; pass the ticks as `ticks` into `simulateShadowFill` instead
   of `[]`.
2. **Mirror M7 next-bar entry** (A4): load/derive the next-bar open and use it for `entryPrice`, sizing,
   `limitPrice`, and the fill timestamp — replacing the signal-bar `reconstructReferencePrice` entry. If
   no next bar exists, **decline + tag missing-data** (mirror `BacktestOrchestrator` returning `null`).
   Derive `barHigh`/`barLow` from the loaded tick set's min/max for snapshot consistency (A6); note that
   for opens the bar extremes do not drive `isMissedFill` (ticks do).
3. **Replace the stale comment** ("shadow path has no historical tick replay … bar-extreme fallback").
   After M26 the shadow path replays `tick_aggregates` for the signal bar and aligns entry to the next
   bar open like backtest — but state the residual gaps honestly (close-side proxy A8; forward-only
   ledger A7). Do **not** claim blanket "identical to backtest".
4. **Preserve `lowFidelity: true`** and `bookSnapshot: null` semantics (ADR 0029 §2.4 — shadow stays
   low-fidelity until the depth-aware extension). M26 unblocks the *fill*, not the depth model.
5. **Handle the missing-tick case explicitly (analysis-layer, A3):** if `tick_aggregates` for the bar
   are absent (or no next bar exists), keep the **conservative miss** (`ticks: []` → missed) and make it
   distinguishable from a price-not-touched miss via the SQL pattern
   (`missed=true AND no tick_aggregates for (symbol, bar)`) plus a `debug` log carrying
   `eventId`/`symbol`/`barOpenMs`. **Do not fabricate a tick.** The durable `ISimulatedFill.missedReason`
   field is **deferred to M27**.

**Out of scope:**
- The live paper fill path — M24 (P0).
- Strategy activation / gate relaxation / slots — M25 (P1/P2/P3).
- Decision/position data-capture columns — M27 (P5).
- **Durable `ISimulatedFill.missedReason` field — deferred to M27** (A3); M26 detects missing-data via
  analysis-layer SQL + debug log only.
- **Close-side fill simulation** — shadow still closes at the reference-price proxy; a dedicated
  `intent:'close'` simulation is a known follow-up (A8).
- **Backfill/replay of pre-M26 `shadow_decisions`** — the ledger is forward-only; full-window M11b
  needs a separate replay job (A7).
- Depth-aware shadow fidelity — `lowFidelity` stays true (ADR 0029 §2.4 deferred).
- Any change to the shared `missedFillDetector`/`fillSimulatorCore`/`ISimulatedFill` contract — M26 is
  engine-only (A1–A4 are all engine-side; the next-bar entry change is in the orchestrator).
- Changing the live `IVolatilityDetectedEvent` shape (Design A — DB load — avoids any shared change).

## Design choice (lock before implementation)

**Design A is LOCKED** (all three reviewers endorse it; user decisions 2026-06-08 keep M26 engine-only):

- **A — DB load in the orchestrator (engine-only, CHOSEN).** The orchestrator queries `tick_aggregates`
  for `(symbol, entryCandleOpenTime)` via `TickAggregateRepository.loadTicksForBar` (new half-open
  method, A1/A5) **once per event** (A2), derives bar extremes from the tick set (A6), and aligns entry
  to the next-bar open (A4). **No `packages/shared/` change.** Cost: one DB read per shadow event
  (already DB-bound; shadow runs off the live trade loop). Note the write-read race watch (A9).
- **B — Carry OHLC on `IVolatilityDetectedEvent` (REJECTED for M26).** A shared-contract change via
  `bot-shared-maintainer` touching the live producer — unnecessary, since `MarketDataModule` already
  exports the repo the orchestrator needs. Revisit only if a future consumer needs OHLC on the event.

## Change set (design A — engine-only)

| Workspace        | Files (representative)                                                                                          | Item |
|------------------|----------------------------------------------------------------------------------------------------------------|------|
| `apps/engine/`   | `src/market-data/repository/TickAggregateRepository.ts` (add half-open `loadTicksForBar(symbol, barOpenMs)` mirroring `CandleLoader`) | 1 (A1/A5) |
| `apps/engine/`   | `src/strategy/service/ShadowStrategyOrchestratorService.ts` (inject `TickAggregateRepository`; load ticks once per event in `runShadows`; next-bar entry + tick-derived bar extremes; decline+tag when no next bar/no ticks; debug log on empty load; replace stale comment) | 1,2,3,5 |
| `apps/engine/` (tests) | shadow orchestrator + repo specs (fill opens with real ticks; one DB load per event; next-bar entry alignment; no-next-bar declines; missing-tick miss is join/log-detectable; half-open boundary; lowFidelity preserved; determinism) | QA |

No `packages/shared/` change (no shared core / `ISimulatedFill` / `IVolatilityDetectedEvent` touch —
durable `missedReason` is deferred to M27, A3). No migration (reuses `tick_aggregates`; confirm the
`(symbol, ts)` index exists, A9). No dashboard change.

## Dispatch waves (per CLAUDE.md / dev-qa-cycle — ≤5 items/files per dispatch)

1. **Serial — `bot-architect`**: Design A is locked — amend ADR 0029 to record that the shadow path
   now (a) replays `tick_aggregates` for the signal bar via `TickAggregateRepository` (no longer "no
   historical tick replay"), (b) **aligns entry to the next-bar open like M7** (A4 — record this as a
   deliberate shadow entry-pricing change with the ADR 0015 §6 forward-look rationale), while
   `lowFidelity`/`bookSnapshot: null` stay until the depth-aware extension. Record the **analysis-layer
   missing-data detection** (A3, durable field deferred to M27), the **forward-only ledger** (A7), and
   the **close-side proxy limitation** (A8). No `bot-shared-maintainer` wave (Design B rejected).
2. **Serial — `bot-engine-nestjs`** (single focused dispatch, ≤5 files): add half-open
   `loadTicksForBar` to `TickAggregateRepository` (A5); inject it into the shadow orchestrator; load
   ticks **once per event** in `runShadows` and thread immutable evidence into each `runOneShadow` (A2);
   derive next-bar entry + tick-set bar extremes (A4/A6); decline+tag when no next bar or no ticks; emit
   the `debug` log on empty load (A3); replace the stale comment. No shared/`BacktestModule` touch.
3. **Serial — `bot-qa-engineer`**: paired tests per fix item —
   - **Shadow fill opens:** with ticks present + a next bar, a crossing shadow open → `missed=false`,
     non-zero next-bar `entryPrice`, `tryOpen()` records a virtual position.
   - **One load per event (A2):** two shadows (v2 + v3) on one event → `loadTicksForBar` called **once**
     (mock call count = 1); both shadows see the same evidence.
   - **No next bar (A4):** signal bar is the symbol's last replay bar → open **declined + tagged**
     missing-data (mirror backtest `null`).
   - **Missing-tick conservative (A3):** no `tick_aggregates` for the bar → **missed**, and
     join/log-detectable (assert the SQL pattern + debug log), **not** faked; durable field NOT asserted.
   - **Half-open boundary (A5):** ticks at `barOpen` and `barOpen + 5m − 1s` included; `barOpen + 5m`
     **excluded**.
   - **Bar geometry (A6):** `barHigh`/`barLow` come from the tick set min/max; ticks (not bar extremes)
     drive the open miss-detector.
   - **lowFidelity preserved:** shadow fills remain `lowFidelity: true`, `bookSnapshot: null`;
     `enableIntrabarStopSimulation` not accidentally enabled.
   - **Determinism:** same event + same `tick_aggregates` → identical virtual fill (ADR 0029/0032).
   - **Same-tape parity (A4):** for `event_id X`, shadow loads the **same tick rows** and uses the
     **same next-bar entry** M7 would — scope parity to source + entry alignment, not bitwise PnL.
   - **Forward-only (A7):** `rebuildLedger` over pre-M26 missed rows still skips (document behavior).
4. **Parallel — reviewers**: `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   **`bot-review-quant`**. Logic owns the module-boundary check (no `BacktestModule` cycle, A1) and the
   no-next-bar decline path. Quant owns counterfactual validity: shadow PnL is now computable and
   comparable to active-version PnL on the same `event_id` tape with **next-bar entry alignment**, the
   missing-data detection prevents survivorship bias (no-data misses must not be silently dropped), and
   classifies whether the **close-side reference proxy (A8)** is acceptable for M11b. Cycle fix →
   re-review until zero blockers, zero highs, majority mediums.
5. **Serial — `bot-scribe`**: `docs/milestone-log.md`, `docs/work-log.md`, CLAUDE.md status line,
   `docs/plans/00-overview.md` shadow note, and the ADR 0029 amendment link. Record that the virtual
   ledger now populates **from deploy forward** (A7), entry aligns to the next bar (A4), missing-data is
   analysis-layer-detectable (durable field → M27, A3), and the **close-side proxy** remains a known
   low-fidelity limitation (A8) — so acceptance is "entry-side counterfactual PnL computable", not
   "fully reliable shadow PnL".

Orchestrator verifies the actual diff after every wave and **explicitly confirms** (a) no
`packages/shared/` and no `BacktestModule` import was added (ticks load via `TickAggregateRepository`
from `MarketDataModule`, A1); (b) ticks load **once per event** (A2); (c) entry aligns to the next-bar
open with a decline+tag on no-next-bar (A4); and (d) `lowFidelity`/`bookSnapshot: null` preserved.

## DB safety (HARD — CLAUDE.md invariants #8/#9)

**M26 is migration-free and read-only against `tick_aggregates`** — it adds a SELECT, no schema
change, no write, no destructive op. Picking up the change requires only an **engine restart**.

**Backup rotation:** before the engine restart, take a routine `pg_dump`
(`docker compose exec postgres pg_dump -U trade_bot trade_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M).sql.gz`).
**Keep the 2 most recent `backup_` files; prune older ones.** Show the user the dump path before
restarting.

## Post-deploy steps

1. Take `pg_dump` before the engine restart (prune to 2-deep retention).
2. **Engine restart only** (no migration).
3. **10-min live smoke** per `feedback-milestone-app-smoke` — fix-and-report boot errors before the
   scribe. Confirm the shadow orchestrator boots with `TickAggregateRepository` injected (no module
   cycle).
4. **Shadow-fill confirmation (24–48h):** confirm **new** `shadow_decisions` OPEN rows now show a
   **mix** of `simulated_fill.missed=false` (ticks present + crossing) and `missed=true` (no touch or no
   ticks) — **not** 100% missed — and that `VirtualPositionLedgerService` records virtual positions.
   Confirm absent-tick bars are join/log-detectable (not fabricated). **Historical pre-M26 rows stay
   `missed:true`** (forward-only, A7). Read-only DB querying.
5. **Counterfactual sanity (A4):** spot-check that a shadow `event_id` loads the same `tick_aggregates`
   rows **and** the same next-bar entry the backtest would use for that bar. Read-only.
6. **Tick-coverage watch (A9):** if many signal bars return `[]`, investigate market-data persistence /
   the write-read race (WS gaps, missing partitions) — not shadow logic. Confirm the `(symbol, ts)`
   index is present.

## Verification

- **Unit:** shadow orchestrator + `TickAggregateRepository` suites green; `src/strategy` + `src/backtest`
  suites green (tick-source consistency — half-open window matches M7's `CandleLoader`).
- **Shadow opens:** present-tick crossing open → `missed=false`, non-zero **next-bar** entry (A4),
  virtual ledger populated.
- **One load per event (A2):** multi-shadow event issues a single `loadTicksForBar` call.
- **No next bar / missing-tick conservative (A3/A4):** declined or missed, join/log-detectable, **not**
  faked; durable field not asserted (deferred to M27).
- **Half-open boundary (A5):** `barOpen + 5m` tick excluded.
- **No module cycle (A1):** no `BacktestModule` import added to `StrategyModule`.
- **lowFidelity preserved; determinism holds** (same event + ticks → identical fill).
- **Boot:** engine boots and stays **running** after restart.

## References

- Architect analysis (P4): [main-architector-paper-soak-fill-and-gate-analysis.md](../wip/main-architector-paper-soak-fill-and-gate-analysis.md) §2.3, §5 P4
- Independent reviews (2026-06-08, source of amendments A1–A9):
  [composer](../independent-analysis/composer/M26-shadow-counterfactual-fill-wiring-review.md),
  [gbt](../independent-analysis/gbt/M26-shadow-counterfactual-fill-wiring.md),
  [gemini](../independent-analysis/gemini/M26-shadow-counterfactual-fill-wiring.md)
- Shadow counterfactual + fill simulator pipeline: [docs/architecture/adr/0029-shadow-counterfactual-and-fill-simulator-pipeline.md](../architecture/adr/0029-shadow-counterfactual-and-fill-simulator-pipeline.md)
- Missed-fill model: ADR 0015 §6
- M7 backtest tick sourcing (the pattern M26 mirrors): [docs/plans/M7-backtesting.md](M7-backtesting.md)
- Independent of: M24 (paper fill), M25 (gate/strategy). Companion: M27 (data capture)

### Key source files

| Concern | Path |
|---|---|
| Shadow orchestrator (changes here) | `apps/engine/src/strategy/service/ShadowStrategyOrchestratorService.ts` |
| Tick loader (add `loadTicksForBar`; inject here) | `apps/engine/src/market-data/repository/TickAggregateRepository.ts` |
| Virtual ledger | `apps/engine/src/strategy/service/VirtualPositionLedgerService.ts` |
| Missed-fill rule (unchanged) | `packages/shared/src/util/missedFillDetector.ts` |
| Fill core (unchanged) | `packages/shared/src/util/fillSimulatorCore.ts` |
| `ISimulatedFill` (unchanged — durable `missedReason` → M27) | `packages/shared/src/interface/ISimulatedFill.ts` |
| Next-bar entry + half-open tick window (pattern to mirror) | `apps/engine/src/backtest/service/BacktestOrchestrator.ts`, `apps/engine/src/backtest/service/CandleLoader.ts` |
