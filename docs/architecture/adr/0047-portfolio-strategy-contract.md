# ADR 0047 — Portfolio-strategy contract (`IPortfolioStrategy`)

- **Status:** Accepted
- **Date:** 2026-07-01
- **Milestone:** M50 (D1)
- **Composes with:** ADR 0003 (single-symbol `IStrategy`, purity/determinism rule),
  ADR 0016 (strategy-version lineage), ADR 0004 (risk gate — unchanged), ADR 0042
  (paper exploration profile), ADR 0029 (shadow pipeline). Companion: ADR 0048
  (rebalance orchestrator — the impure outer loop that drives this pure core).
- **Amended by:** [ADR 0050](0050-xmom-cascade-topn-rebalance-anchor.md) §2.1 / §2.5 (M50b) —
  `selected` → `ranked` (full list); core no longer slices to `top_n`; `top_n` is orchestrator-only.

> **ADR numbering note.** The next free number after `0046` is **0047**; this ADR uses it.

---

## 1. Context

Every strategy to date (v0–v3) implements `IStrategy` (ADR 0003): a **single-symbol**
contract — `evaluate(input) → ISignal` for one symbol's market state at one bar. The VWAP
detector fires per symbol; `StrategyService` runs the active `IStrategy` against that one
symbol's snapshot.

Cross-sectional momentum (EXP-011/012) is a fundamentally different shape: its decision is
**relative across a universe**. "Buy the strongest of the last 24h" cannot be expressed as a
per-symbol `evaluate` — the answer for `ETHUSDT` depends on every other symbol's trailing
return. It needs a contract that takes the **whole universe** in and returns a **ranked
selection** out.

The constraint that does *not* change: the ranking logic must remain **pure and
deterministic** so the same code ranks identically in paper, shadow, and a future backtest
replay (the ADR 0003 §1 invariant, restated for the portfolio shape). All clock, I/O, and
universe-snapshot acquisition stay **outside** the core (ADR 0048).

EXP-012 is positive post-cost on only **one up-regime** with `t < 2`; live promotion is
gated on a down-regime soak. M50 is therefore **paper + shadow only — no live capital**.

---

## 2. Decision

### 2.1 `IPortfolioStrategy` — a new, separate extension point (OCP)

> **ADR 0050 amendment (M50b).** `IPortfolioSelection.selected` is renamed `ranked` and returns
> the **full** eligible universe (dense rank 1..M). The core ranks only; `top_n` is consumed by
> the orchestrator cascade (ADR 0048 §2.4, amended). Code is authoritative over this snippet.

A new interface, **distinct from and not extending `IStrategy`**. It operates over a
universe snapshot and returns a ranked, sized-by-rank selection of symbols:

```
interface IPortfolioStrategy {
  readonly name: string;            // matches strategy_versions.name
  readonly version: number;         // matches strategy_versions.version
  readonly direction: StrategyDirectionEnum;   // 'momentum' for xmom
  selectUniverse(input: IPortfolioStrategyInput): IPortfolioSelection;
}

interface IPortfolioStrategyInput {
  readonly universe: ReadonlyArray<UniverseEntry>;  // trailing-return-bearing snapshot
  readonly params: IMomentumParams;                 // validated by momentumParamsSchema
  readonly nowMs: number;                           // injected; core never reads a clock
}

interface IPortfolioSelection {
  readonly selected: ReadonlyArray<ISelectedSymbol>;  // ranked best-first, length ≤ topN
  readonly reason: PortfolioSelectionReasonEnum;       // ranked | universe_too_small | no_eligible_symbols
}

interface ISelectedSymbol {
  readonly symbol: string;
  readonly rank: number;            // 1 = strongest; deterministic, dense
  readonly trailingReturnPct: number;  // the ranking key (the value it was chosen on)
}
```

**Purity/determinism (the hard rule, restated for the portfolio shape).** `selectUniverse`
MUST be a pure function of `(universe, params, nowMs)`: no I/O, no logging, no DB, no
exchange calls, no `Date.now()`, no `Math.random()`, no mutation of inputs. `skip` for the
whole universe is expressed as `selected: []` with a `reason` — selection ALWAYS returns an
`IPortfolioSelection`, never throws for the empty case. Persistence/logging is the
orchestrator's job (ADR 0048). `nowMs` is passed in so the function stays reproducible.

`UniverseEntry` is the **M50 ranking-input type** and is intentionally *distinct* from
market-data's existing engine-internal `IUniverseEntry` (membership/tier/volume only — it
carries no return). The orchestrator (ADR 0048) builds `UniverseEntry[]` by joining
membership with a per-symbol trailing return. Minimum fields the core reads:
`{ symbol, trailingReturnPct, tier }` — see ADR 0048 §5 for how it is sourced and the
NaN/undefined exclusion guard.

### 2.2 `IPortfolioStrategyVersion` — versioning wrapper, analogous to the VWAP path

Portfolio strategies are versioned and selected by the **same lineage model** as `IStrategy`
(ADR 0016): a registry, a `strategy_versions` row, and an env-selected active id — but on a
**separate selection axis** so the two paths never collide:

```
interface IPortfolioStrategyVersion {
  readonly versionId: number;       // strategy_versions.id (numeric, like the VWAP path)
  readonly name: string;            // e.g. 'xmom'
  readonly strategy: IPortfolioStrategy;
}
```

- **Env selector:** `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` (numeric), the portfolio analogue
  of the existing `ACTIVE_STRATEGY_VERSION_ID`. Unset/absent ⇒ the portfolio path is dormant
  (no scheduler, no orchestrator activity); the VWAP path is wholly unaffected.
- **Persistence reuse:** a portfolio version is an ordinary `strategy_versions` row
  (`direction = 'momentum'`, `params` = the momentum params). No new versions table, no
  migration. Its positions/decisions carry that `strategy_version_id` (ADR 0048 §7).

### 2.3 OCP constraint — `IStrategy` and the VWAP path are untouched

`IPortfolioStrategy` does **not** extend, wrap, replace, or modify `IStrategy`,
`StrategyService`, `IStrategyInput`, `ISignal`, or any v0–v3 implementation. It is a parallel
extension point added by **new code**, not by editing existing code (open for extension,
closed for modification). The VWAP detector → `StrategyService` → risk-gate flow is
byte-identical to pre-M50. A reader scanning v0–v3 sees nothing new.

### 2.4 Slot sharing in M50 — explicit: shared A/B/C pool now, disjoint namespace is M50b

In M50 the momentum path **shares the global A/B/C slot pool** with the VWAP path. The
single-slot long-only proxy (`topN = 1`) is one position and fits the existing architectural
3-slot model (ADR 0004) **with no cap change**. The consequence is explicit and accepted:
**a momentum rebalance can gate-reject with `max_positions_reached` when VWAP holds all
slots** — momentum has no reserved capacity in M50. This is a known, logged outcome, not a
bug.

A **disjoint slot namespace** (a per-strategy position + notional cap so momentum and VWAP do
not starve each other) and the **N-long basket** (`topN > 1`) are deferred to **M50b**. M50
ships the single-slot proxy only.

### 2.5 `momentumParamsSchema` — separate Zod schema, deliberately NOT `.strict()`

A **new, separate** Zod schema in `packages/shared/`, independent of the VWAP
`strategyParamsSchema`. The two never share a key namespace. Unlike the VWAP schema (which is
`.strict()` and rejects unknown keys), `momentumParamsSchema` is **not `.strict()` for now**:
the momentum param set is expected to grow through M50/M50b (basket sizing, vol-scaling,
skip-recent-bar lookback), and a non-strict schema lets a forward param land without a
lockstep shared-package bump. It will be tightened to `.strict()` once the param set settles
(tracked as M50b follow-up).

Initial params (snake_case, persisted in `strategy_versions.params`):

| Param | Type / bound | Default | Meaning |
|-------|--------------|---------|---------|
| `top_n` | int ≥ 1 | **1** | Number of strongest symbols to hold (M50: 1 only) |
| `lookback_ms` | int ≥ 1 | **86_400_000** (24h) | Trailing-return window the ranking is computed over |
| `rebalance_interval_ms` | int ≥ 1 | **86_400_000** (24h) | Re-rank cadence; drives the scheduler (ADR 0048 §1) |
| `min_universe_size` | int ≥ 1 | (e.g. 20) | Minimum eligible symbols required to rank; below ⇒ empty selection |

Money/notional sizing is **not** a momentum param — it stays operator-level in the risk gate
/ `PositionSizer` (ADR 0004 §8), exactly as for VWAP. The momentum schema governs **ranking
shape only**.

### 2.6 Paper + shadow only in M50 — env-gated, hard fail-closed on any other env

`ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` **only activates the momentum path when
`EXCHANGE_ENV = paper`** (the existing `ExchangeEnvironmentEnum.PAPER`). On boot:

- `EXCHANGE_ENV = paper` **and** the env var set ⇒ portfolio path active (paper fills +
  shadow record).
- Any other `EXCHANGE_ENV` (`live`, `testnet`) with the env var set ⇒ **log a WARN and skip**
  — the scheduler and orchestrator do not register/emit. No live or testnet capital can ever
  reach the momentum path in M50. This mirrors the two-condition paper gate used by ADR 0042
  (`paperRelaxMarketStress`) and ADR 0036, so a non-paper boot is byte-identical to pre-M50.

This is a **code-enforced** boot gate, not a config convention.

---

## 3. Invariants this ADR defends

- **Same code, every mode.** `selectUniverse` is pure and deterministic — identical ranking
  in paper, shadow, and future backtest. No wall-clock, no RNG, no I/O in the core.
- **The risk gate is not bypassed.** This ADR defines selection only; *every* selected leg
  routes through the unchanged ADR 0004 risk gate → `PositionSizer` → execution (enforced in
  ADR 0048 §3). `IPortfolioStrategy` cannot place an order.
- **No LLM in the loop.** The momentum core is deterministic ranking math; no model call.
- **Money is `decimal`.** The core ranks on `trailingReturnPct` (a ratio scalar, not money);
  all sizing/notional/PnL downstream stays `decimal.js` in the unchanged risk/execution path.
- **VWAP untouched.** v0–v3 and `StrategyService` are not modified (§2.3).
- **No live capital in M50.** Hard paper-only boot gate (§2.6).

---

## 4. Consequences

- A second strategy *shape* exists alongside the per-symbol shape, with its own registry,
  active-version env, and Zod schema — no change to `IStrategy` or any v0–v3 code.
- `strategy_versions` is reused as-is for portfolio versions (no migration); positions and
  decisions distinguish momentum by `strategy_version_id`.
- The shared A/B/C slot pool means momentum can lose to VWAP for a slot in M50 (§2.4) — an
  accepted, logged outcome until M50b adds a disjoint namespace.
- `momentumParamsSchema` being non-strict trades a little boot-time validation tightness for
  param-evolution velocity during the experimental phase; tightened in M50b.
- Determinism is preserved end-to-end, so an M50 momentum version can later be backtested
  through the same `selectUniverse` for the down-regime promotion gate.

---

## 5. Alternatives considered

- **Extend `IStrategy` with an optional `selectUniverse`.** Rejected. Pollutes the
  single-symbol contract every v0–v3 impl satisfies, forces a no-op on each, and violates
  OCP/ISP — a per-symbol strategy has no business carrying a universe method. A separate
  interface keeps each contract cohesive (one reason to change).
- **Express momentum as a per-symbol `IStrategy` that reads peers from a shared cache.**
  Rejected. Breaks purity (the "snapshot" would be impure ambient state), makes the decision
  order-dependent and non-reproducible, and smuggles cross-sectional state into a contract
  whose whole premise is single-symbol isolation.
- **Make `momentumParamsSchema` `.strict()` immediately like the VWAP schema.** Rejected for
  M50 only. The param set is still moving (basket sizing, vol-scaling in M50b); strict mode
  would force a shared-package bump per param. Revisited (and adopted) once the set settles.
- **Give momentum its own slot pool now (disjoint namespace in M50).** Rejected as scope.
  The `topN = 1` proxy fits the existing 3-slot model with zero cap change; building a
  per-strategy capacity model is real work with its own review surface — deferred to M50b so
  M50 proves the ranking edge first, survival-first.
- **Run momentum live at minimal size immediately.** Rejected. EXP-012 is post-cost positive
  on a single up-regime with `t < 2`; the locked policy (00-overview) is no live capital
  without out-of-sample/down-regime evidence. Paper + shadow only.
</content>
</invoke>
