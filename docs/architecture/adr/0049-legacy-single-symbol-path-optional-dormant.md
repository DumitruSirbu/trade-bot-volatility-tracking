# ADR 0049 — Legacy single-symbol (VWAP) path becomes optional and dormant

- **Status:** Accepted
- **Date:** 2026-07-01
- **Milestone:** M50 (operational follow-on)
- **Composes with:** ADR 0003 (single-symbol `IStrategy` / `StrategyService`), ADR 0016
  (strategy-version lineage), ADR 0047 §2.6 + ADR 0048 (portfolio-path dormancy pattern this
  ADR mirrors), ADR 0032 (`EXCHANGE_ENV` boot profile).

> **ADR numbering note.** The next free number after `0048` is **0049**; this ADR uses it.

---

## 1. Context

The engine has two strategy paths:

1. **Legacy single-symbol path** — `StrategyService` (ADR 0003), selected by the env var
   `ACTIVE_STRATEGY_VERSION_ID`. That var is currently **mandatory**
   (`EnvironmentVariables.ts`: `@IsInt() @Min(1)`, non-optional `ACTIVE_STRATEGY_VERSION_ID!`).
   `StrategyService.onModuleInit()` reads it, calls `strategyVersions.findById(...)`, and
   **throws** `StrategyConfigException` if the row is missing/unregistered. Its
   `@OnEvent(VOLATILITY_DETECTED_EVENT)` handler assumes `activeStrategy` is resolved.
2. **Portfolio (cross-sectional momentum / xmom) path** — ADR 0047/0048, selected by the
   **optional** `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID`. When unset (or env ≠ paper) the whole
   path is dormant per ADR 0047 §2.6.

VWAP — the only strategy the single-symbol path was built for — was **retired 2026-07-01**
(persistent negative PnL, no cost-surviving edge; project memory `project-vwap-retired.md`).
xmom (portfolio `strategy_versions.id = 20`) is now the sole active strategy. The operator's
`.env` therefore sets only `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID=20` and leaves
`ACTIVE_STRATEGY_VERSION_ID` unset.

**The operational failure:** because `ACTIVE_STRATEGY_VERSION_ID` is mandatory, the engine
**crash-loops on boot** — "Invalid environment configuration … ACTIVE_STRATEGY_VERSION_ID
must not be less than 1, must be an integer number." A retired strategy's env var is blocking
startup of the active one.

The user's intent is explicit: VWAP is deprecated but **may return in the future** — so the
implementation code and its `strategy_versions` rows must be **kept**, not deleted. The only
change wanted is to make the legacy bootstrap **optional and dormant**, symmetrical with the
portfolio-path dormancy that already exists.

---

## 2. Decision

Make the legacy single-symbol path **opt-in and fully dormant when unselected**, mirroring the
ADR 0047 §2.6 portfolio-path pattern. This is a **bootstrap-behavior change only** — no schema
change, no data change, no strategy-implementation change.

### 2.1 `ACTIVE_STRATEGY_VERSION_ID` becomes optional

In `EnvironmentVariables.ts`, `ACTIVE_STRATEGY_VERSION_ID` changes from mandatory to optional,
using the **exact pattern already proven** by `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID`
(§2 above / lines 180–187): `@IsOptional()`, an undefined-safe `@Transform` that maps
absent/empty to `undefined`, then `@IsInt() @Min(1)` (which only run when a value is present).
Absent ⇒ the legacy path is dormant. Present and ≥ 1 ⇒ the legacy path activates exactly as
today (re-enabling VWAP later is *only* setting this env var again).

The field becomes optional (`?`), so the boot no longer aborts when the key is missing. A
**present but malformed** value (e.g. `0`, `abc`) still fails boot loudly — an operator who
*intends* to run the legacy path must not have a typo silently disable it.

### 2.2 `AppConfigService.activeStrategyVersionId` returns `number | null`

The getter changes signature from `number` to `number | null`, returning `raw ?? null`,
identical to the existing `activePortfolioStrategyVersionId` getter (lines 283–287). Null
means "legacy path not selected."

### 2.3 `StrategyService.onModuleInit()` skips resolution when unset — no throw

`onModuleInit()` reads the (now nullable) config. When it is **null**, the service records a
one-line INFO log ("legacy single-symbol strategy path dormant — ACTIVE_STRATEGY_VERSION_ID
unset") and **returns without resolving** — `activeStrategy` / `activeParams` /
`activeStrategyVersionId` are left unset and a private dormant flag is raised. **No
`StrategyConfigException`, no `findById`, no registry resolve.**

When it is **non-null**, behavior is **byte-identical to today**: `findById`, the
missing/unregistered-row throw (§onModuleInit lines 113–115), registry resolve, and the
"Active strategy … resolved" log all run unchanged. The missing-row throw is preserved for the
opted-in case — a selected id that matches no row is still a fatal misconfiguration.

Introduce a private readiness predicate (e.g. `isActive` / `isDormant`) so every entry point
in §2.4 tests one intention-revealing condition rather than probing an unset field.

### 2.4 Every legacy entry point no-ops safely when dormant

The `@OnEvent(VOLATILITY_DETECTED_EVENT)` handler (`onVolatilityDetected`) must **guard at the
top**: when the path is dormant, `return` immediately — before any access to `activeParams` /
`activeStrategy`, before `flushClosedBars`, before `classifyFlowType` / `computeSignalScore`,
and before the shadow-orchestrator fire-and-forget. No decision is recorded, nothing is
persisted, nothing throws. A retired path must be a silent no-op, not a per-trigger error.

The volatility **detector itself is not changed** — `MarketDataService` still emits
`VOLATILITY_DETECTED_EVENT`, and `MarketDataPersistenceListener` still records the event.
Detection/telemetry is independent of whether a legacy strategy is selected; only the
strategy *consumer* goes dormant. (If the detector's own event volume is later deemed wasteful
with VWAP retired, that is a separate optimization, out of scope here.)

Any other method on `StrategyService` reachable while dormant (there are none today beyond the
event handler and private helpers it calls) must likewise assume the readiness predicate has
gated entry; private helpers are unreachable when the public handler returns early.

### 2.5 Reversibility — no data or schema change

Re-enabling VWAP in the future is **purely** setting `ACTIVE_STRATEGY_VERSION_ID=<id>` and
restarting. This ADR mandates that:

- The legacy strategy implementations (v0–v3), `StrategyService`, `StrategyRegistry`,
  `IStrategy`, and the VWAP-related shared contracts are **not deleted or modified** beyond the
  optional-guard wiring above.
- The `strategy_versions` rows for legacy versions are **not deleted** (CLAUDE.md rule 8 — no
  destructive DB ops; and reversibility requires the rows to still exist).

Dormancy is a runtime state selected by config, fully reversible with a config edit.

---

## 3. Invariants this ADR defends

- **No order path bypasses the risk gate.** Dormancy only prevents the legacy path from
  producing intents at all; when active, it routes through the unchanged ADR 0004 gate exactly
  as before.
- **Strategies stay pure/deterministic.** No strategy code changes; only bootstrap wiring.
- **Fail loud on real misconfiguration, silent on intended absence.** Absent var ⇒ dormant
  (INFO). Present-but-invalid var, or a selected id matching no row ⇒ boot/init throw as today.
- **No destructive change.** No migration, no row deletion, no schema edit — reversible by
  config (CLAUDE.md rules 8/9 respected; nothing here touches the DB).
- **Symmetry with the portfolio path.** The legacy path now follows the same
  optional-select-then-dormant shape as ADR 0047 §2.6, so both strategy shapes share one
  mental model.

---

## 4. Consequences

- With only `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID` set, the engine boots cleanly: the legacy
  path is dormant, the xmom portfolio path is active — the intended M50 operating state.
- The `VOLATILITY_DETECTED_EVENT` stream still flows and is still persisted, but no legacy
  decision rows are produced while dormant. Analysts reading `decisions` will see the legacy
  strategy simply stop contributing from the cutover — expected, not a data gap.
- Two independent activation switches now exist (`ACTIVE_STRATEGY_VERSION_ID` and
  `ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID`); either, both, or neither may be set. "Neither set"
  is a legal (idle-strategy) boot rather than a crash — acceptable, since the operator may run
  the engine for market-data capture alone.
- A latent risk removed: a stale mandatory var for a retired strategy can no longer block the
  active strategy's startup.

---

## 5. Alternatives considered

- **Keep `ACTIVE_STRATEGY_VERSION_ID` mandatory; point it at a live/no-op sentinel row.**
  Rejected. Forces the operator to carry a meaningless value for a retired strategy, and a
  sentinel row would still resolve a real (or fake) `IStrategy` that then consumes every
  volatility trigger — either producing junk decisions or needing its own special-casing.
  Worse than clean dormancy.
- **Delete the VWAP implementation and its `strategy_versions` rows.** Rejected. The user
  explicitly wants VWAP recoverable ("maybe in future will return"). Deleting rows also
  violates the no-destructive-DB rule (CLAUDE.md rule 8) and would break historical
  `decisions`/`positions` foreign-key context. Dormancy preserves everything.
- **Default `ACTIVE_STRATEGY_VERSION_ID` to a fixed legacy id in the schema.** Rejected. A
  field default silently re-activates the retired path on any profile that forgets to unset it
  — the opposite of the intent, and a footgun for a strategy known to lose money.
- **Make `onModuleInit` throw a friendlier message but stay mandatory.** Rejected. Improves the
  error text but does not solve the operational problem — the engine still cannot boot on a
  portfolio-only `.env`.
- **Silently swallow a present-but-invalid value (treat malformed as dormant).** Rejected. An
  operator who *sets* the var intends to run the legacy path; a typo must fail loud, not
  silently disable trading. Only true absence means dormant.
