# M50 — Cross-sectional momentum (xmom) · Execution plan

Branch: `feat/m50-cross-sectional-momentum`

**Goal.** Add cross-sectional momentum as a NEW parallel strategy: rank the universe by
trailing 24h return, hold the top-ranked winner(s) 24h, re-rank on a 24h cadence
(EXP-011/012). **PAPER + shadow only — NO live capital** (EXP-012 post-cost `t < 2` on one
up-regime; live promotion gated on a down-regime soak).

**Scope locks (do not exceed):**
- `top_n = 1` single-slot long-only proxy; the N-long basket is **M50b** (deferred).
- Shares the global A/B/C slot pool; **disjoint slot namespace is M50b** (deferred).
- VWAP path (v0–v3, `StrategyService`) is **untouched** (OCP).
- **Zero migrations** — reuse `positions` / `decisions` / `strategy_versions`.

**Authoritative design:** ADR 0047 (portfolio-strategy contract), ADR 0048 (rebalance
orchestrator). Read both before any deliverable. Read `docs/best-practices/code-conventions.md`
before engine code and `docs/best-practices/dev-qa-cycle.md` before any fix/QA wave.

---

## Dispatch waves (per CLAUDE.md)

1. **Serial:** `bot-shared-maintainer` → **D1**.
2. **Parallel:** `bot-engine-nestjs` → **D2, D3, D4, D5** (D2 first; D3/D4/D5 can pipeline but
   land after D1).
3. **Serial:** `bot-qa-engineer` → **D6**.
4. **Parallel:** `bot-review-security` + `bot-review-logic` + `bot-review-clean-code` +
   `bot-review-quant` → **D7**.
5. **Serial:** `bot-scribe` → docs + work-log close-out.

Orchestrator verifies every diff after each wave (agent summaries describe intent, not
reality).

---

## D1 — Shared contract  ·  owner: `bot-shared-maintainer`

**Inputs:** ADR 0047 §2.1/§2.2/§2.5, ADR 0048 §2.1.

**Outputs (in `packages/shared/`):**
- `IPortfolioStrategy`, `IPortfolioStrategyInput`, `IPortfolioSelection`, `ISelectedSymbol`,
  `UniverseEntry` (the ranking-input type — distinct from engine `IUniverseEntry`).
- `IPortfolioStrategyVersion`.
- `IUniverseRebalanceDueEvent { nowMs: number }` + the `UNIVERSE_REBALANCE_DUE_EVENT` const.
- `PortfolioSelectionReasonEnum` (`ranked | universe_too_small | no_eligible_symbols`).
- `momentumParamsSchema` + inferred `IMomentumParams` — **separate file**, **NOT `.strict()`**
  (ADR 0047 §2.5). Params: `top_n` (int ≥1, default 1), `lookback_ms` (int ≥1, default
  86_400_000), `rebalance_interval_ms` (int ≥1, default 86_400_000), `min_universe_size`
  (int ≥1).
- Barrel exports in `packages/shared/src/interface/index.ts` + schema/enum barrels.
- Env typing for `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` (numeric, optional).

**Invariants/guards:**
- Do **not** modify `IStrategy`, `ISignal`, `strategyParamsSchema` (OCP).
- `momentumParamsSchema` shares **no** key namespace with `strategyParamsSchema`.
- Money/notional sizing is **not** a momentum param (stays risk-gate operator config).
- Pre-commit project-wide `tsc` must pass (update any mocks that touch the env type).

---

## D2 — `crossSectionalMomentumCore` (pure ranking) + unit tests  ·  owner: `bot-engine-nestjs`

**Location:** `apps/engine/src/strategy/strategies/` (alongside v0–v3) implementing
`IPortfolioStrategy`.

**Inputs:** ADR 0047 §2.1, ADR 0048 §5 (algorithm), D1 types.

**Outputs:**
- `crossSectionalMomentumCore(universe, params, nowMs): IPortfolioSelection` — pure.
- The `xmom` `IPortfolioStrategy` impl wrapping the core (`name`, `version`, `direction =
  momentum`).
- Co-located unit tests.

**Algorithm (ADR 0048 §5):** eligibility filter (drop `null`/`NaN`/`undefined`
`trailingReturnPct`) → min-universe guard (`< min_universe_size` ⇒ `{ selected: [],
universe_too_small }`) → sort by `trailingReturnPct` desc, tie-break `symbol` asc → take
`top_n`, dense `rank` 1..N.

**Invariants/guards:**
- **Pure & deterministic:** no `Date.now()`, no `Math.random()`, no I/O, no input mutation.
  `nowMs` is a parameter.
- Always returns an `IPortfolioSelection` (empty selection, never throw, for the skip case).
- Deterministic tie-break (`symbol` asc) — identical ordering every run.

---

## D3 — `RebalanceSchedulerService`  ·  owner: `bot-engine-nestjs`

**Inputs:** ADR 0048 §2.1/§2.2, ADR 0047 §2.6, D1 event/const.

**Outputs:**
- `RebalanceSchedulerService` — emits `UNIVERSE_REBALANCE_DUE_EVENT { nowMs }` on the
  `rebalance_interval_ms` cadence via `@nestjs/schedule`.
- `ClockPort` (`{ nowMs(): number }`) abstraction + production `Date.now()` adapter.

**Invariants/guards:**
- **Emit-only:** no ranking, no DB, no exchange — just read clock once and emit.
- **Clock injected** via `ClockPort` (no direct `Date.now()`), so tests control time.
- **Paper gate:** register/emit only when `EXCHANGE_ENV = paper` **and**
  `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` set; any other env ⇒ WARN + no-op.

---

## D4 — `MomentumOrchestratorService`  ·  owner: `bot-engine-nestjs`

**Inputs:** ADR 0048 §2.3–§2.6, §3, §5, §6; existing `RiskGateService.evaluate` +
`StrategyService.gateAndPersist` pattern; `UniverseService.getEntries()`;
`SymbolMarketState.movePctOverWindow`; `PositionService` open-position read.

**Outputs:**
- `MomentumOrchestratorService` listening for `UNIVERSE_REBALANCE_DUE_EVENT`:
  1. build `UniverseEntry[]` snapshot (§5) — membership join trailing return;
  2. call `crossSectionalMomentumCore`;
  3. diff selection vs open momentum positions → hold / open / close (§6);
  4. route each leg through the **unchanged** risk gate → `PositionSizer` → execution;
  5. write a `decisions` row per leg (open/close/skip + reason), stamped momentum
     `strategy_version_id`.

**Invariants/guards:**
- **Never bypass the risk gate; never call the exchange order API directly** (ADR 0005/0048).
- Closes-before-opens ordering within a rebalance (§2.4); deterministic ordering.
- Overlap guard: in-flight rebalance ⇒ skip next with `rebalance_overlap_skipped` (§2.5).
- **24h-coverage guard (§5):** when the in-memory price tape is shorter than `lookback_ms`,
  source the lookback close from the persisted 5m `candles` table — do not rank on a
  truncated window.
- Missing-return symbols excluded by the builder **and** re-guarded in the core.
- De-rank close = risk-reducing intent (gate auto-approve, passes under halt — ADR 0046).
- Momentum gate-reject (`max_positions_reached` under shared slots) is a **logged normal
  outcome**, not an error (ADR 0047 §2.4).

---

## D5 — `PortfolioStrategyModule` wiring  ·  owner: `bot-engine-nestjs`

**Inputs:** existing `StrategyModule` / `AppModule` wiring; D2–D4 services.

**Outputs:**
- New `PortfolioStrategyModule` registering the portfolio registry, `xmom` version,
  `RebalanceSchedulerService`, `MomentumOrchestratorService`, `ClockPort`.
- Imports the existing `RiskModule`, `MarketDataModule`, `PositionModule` (reuse exported
  providers; no new exports from those modules).
- Imported into `AppModule`.

**Invariants/guards:**
- Whole module is **dormant** unless `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` set **and**
  `EXCHANGE_ENV = paper` (ADR 0047 §2.6) — non-paper boot byte-identical to pre-M50.
- Do **not** modify `StrategyModule` provider/exports (OCP) beyond what reuse strictly needs.
- Boot smoke: app starts in paper with the env set (DI resolves) **and** in live without it
  (path dormant) — per the milestone live-app smoke rule.

---

## D6 — QA wave (adversarial)  ·  owner: `bot-qa-engineer`

**Inputs:** D2–D5 diffs; ADR 0047/0048 invariants; `dev-qa-cycle.md` (≤5 items/dispatch,
paired tests per fix item, edge/failure-mode focus).

**Adversarial cases (not happy-path):**
- **Ranking:** empty universe; universe exactly at / one below `min_universe_size`; all
  returns `null`/`NaN`; ties on `trailingReturnPct` (assert `symbol`-asc determinism);
  negative-only returns; `top_n` ≥ eligible count; single eligible symbol.
- **Rebalance timing:** `ClockPort` fake advances exactly one / many intervals; overlap (slow
  fill spanning the next tick ⇒ `rebalance_overlap_skipped`); first-tick cold boot with short
  price tape (assert `candles` fallback, no truncated-window rank).
- **Close-on-derank:** symbol drops out of top-N ⇒ close intent emitted; stays in ⇒ held (no
  re-entry, no duplicate open); selection unchanged across two rebalances ⇒ no churn.
- **Risk-gate rejection:** momentum open rejected when VWAP holds all slots
  (`max_positions_reached`) ⇒ no position, decision logged, no exception; open rejected under
  stress halt; de-rank close **passes** under halt (ADR 0046).
- **Determinism/parity:** same `(universe, params, nowMs)` ⇒ identical selection across runs.
- **Env gate:** `EXCHANGE_ENV = live` with the env var set ⇒ scheduler/orchestrator inert.

**Routing:** failing tests go to the architect (contract/design), not silently back to the
developer (adversarial-QA rule). Reviewer continuity across rounds.

---

## D7 — Review wave (parallel)  ·  owners: `bot-review-security` + `bot-review-logic` +
`bot-review-clean-code` + `bot-review-quant`

- **security:** no order path bypasses the gate; no direct exchange call; paper-only boot gate
  cannot be defeated by a non-paper env; no secret/log leakage.
- **logic:** hold/open/close diff correctness; overlap guard; closes-before-opens; missing-data
  guards (builder + core); 24h-coverage fallback; gate-context construction matches the VWAP
  path.
- **clean-code:** purity of the core; `ClockPort` seam; no DRY violation against
  `StrategyService.gateAndPersist`; naming per conventions; OCP (no v0–v3 edits).
- **quant:** ranking matches EXP-011/012 (trailing-return desc, 24h lookback, 24h hold);
  `signalScore`-from-rank monotonic and sane; no look-ahead in the lookback window; paper-only
  promotion discipline (no live capital).

Cycle review/fix until zero blockers, zero highs, majority of mediums resolved.

---

## Done criteria

- D1–D5 merged behind the dormant paper-only gate; **zero migrations**.
- D6 adversarial suite green; D7 reviewers clear per the bar above.
- 10-min live-app smoke: app boots in paper with the path active and in live with it dormant.
- Scribe updates `docs/STATUS.md`, `docs/plans/README.md` (M50 → DONE), `docs/milestone-log.md`,
  `docs/work-log.md`, and the ADR 0004 deferred note for the M50b momentum cap model.
</content>
