# ADR 0022 — Read API surface (M9)

**Status:** Accepted (M9 design wave)
**Date:** 2026-05-24
**Milestone:** M9
**Depends on:** ADR 0020 (auth), ADR 0021 (halt state DTO), ADR 0002 (persistence), ADR 0016 (strategy versioning).
**Consumed by:** ADR 0023 (WS topology mirrors REST DTOs), M10 (dashboard).

## 1. Context

The dashboard (M10) and the operator's curl are the only read clients. The read API must:

- expose enough to render the dashboard's positions / PnL / decisions / per-version performance views (M10 task list),
- expose halt state + recent risk-halt history (ADR 0021),
- **leak nothing** the operator does not need (least-disclosure — exchange API keys, signing secret, raw token claims, in-memory ledger internals are all out),
- be cheap (snapshots, not streams — streaming is ADR 0023's job),
- carry **only persisted, derivable data** so the live engine is not the source of truth for fields a backtest could not replay (preserves the strategy/risk path's separation from the observability surface).

## 2. Decision

### 2.1 Versioned prefix

All endpoints live under `/v1/`. A future breaking change ships under `/v2/` while `/v1/` stays; the auth and rate-limit interceptors are version-agnostic. No content-negotiation `Accept: vnd.bot+json;v=1`; URL prefix is simpler and visible in logs.

### 2.2 Endpoints

| Method + path | Scope | Returns | Notes |
|---|---|---|---|
| `GET /v1/health` | none | `{ status: 'ok' \| 'degraded', uptimeSec, schemaValid }` | Unauthenticated. No secrets; only liveness + schema-gate result. |
| `GET /v1/control/halt` | `read` | `IKillSwitchState` (ADR 0021 §2.6) | |
| `GET /v1/control/halt/history?limit=50&before=<ISO>` | `read` | `IPaginated<IHaltAuditEntry>` | Reads `control_audit`. |
| `GET /v1/positions/open` | `read` | `IOpenPositionView[]` | Pulled from `positions WHERE status='open'`. |
| `GET /v1/positions/closed?limit=50&before=<ISO>` | `read` | `IPaginated<IClosedPositionView>` | |
| `GET /v1/positions/:id` | `read` | `IPositionDetailView` | 404 if not found / wrong tenant. |
| `GET /v1/decisions/recent?limit=100&before=<ISO>` | `read` | `IPaginated<IDecisionView>` | Reads `decisions`. Includes `action`, `flowType`, `signalScore`, `reason`. |
| `GET /v1/account/equity` | `read` | `IAccountEquityView` | Reads latest `account_snapshots` row (ADR 0014 / M6 W7). |
| `GET /v1/performance/by-version?windowDays=30` | `read` | `IPerformanceByVersionView[]` | Aggregates `positions` + `transactions` per `strategy_version_id`. |
| `GET /v1/risk/state` | `read` | `IRiskStateView` | Reads `risk_state` row for current UTC day + window aggregates. |
| `POST /v1/control/halt` | `halt` | per ADR 0021 §2.1 | |
| `POST /v1/control/resume` | `halt` | per ADR 0021 §2.1 | |
| `POST /v1/auth/revoke` | `admin` | per ADR 0020 §2.2 | |

### 2.3 DTOs — least-disclosure rules

Every read DTO is a **new shared interface** under `packages/shared/src/interface/` (added by shared-maintainer in W0). The entities are NOT serialised directly — a mapper in the read-API layer projects entity → DTO, dropping internal fields. The minimum included set, per DTO:

- `IOpenPositionView`: `id, symbol, side, entryPrice, currentPrice, qty, leverage, unrealizedPnlPriceUsd, unrealizedPnlFundingUsd, openedAt, slot, strategyVersionId, eventId, state, protectiveOrderType, slPrice, tpPrice`. **Excluded:** raw `clientOrderId`, `reservation_id`, `recovery_phase`, `adoption_*` flags (operator-internal; surface only on `IPositionDetailView`).
- `IDecisionView`: `id, occurredAt, symbol, action, flowType, signalScore, reason, strategyVersionId, eventId, positionId? `. **Excluded:** strategy-internal scoring vectors and per-band raw inputs.
- `IPerformanceByVersionView`: `strategyVersionId, label, status, windowDays, tradeCount, winRate, netPnlUsd, maxDrawdownUsd, sharpe, sortino, expectancyPerUnitRisk`. **Excluded:** per-trade enumerations (dashboard fetches `/positions/closed` if it wants the raw list).
- `IAccountEquityView`: `equityUsd, marginUsed, freeMargin, openExposureUsd, asOf`. **Excluded:** raw exchange response, sub-account ids.
- `IPerformanceByVersionView`: `strategyVersionId, label, status, windowDays, tradeCount, winRate, netPnlUsd, maxDrawdownUsd, sharpe, sortino, expectancyPerUnitRisk`. **Excluded:** per-trade enumerations.
- `IRiskStateView`: `date, realizedPnlDay, openExposure, tradesCount, isHalted, haltReason, lossWindowsState`. **Excluded:** reservation-ledger internals.

**Hard rule:** no DTO ever includes `AUTH_SIGNING_SECRET`, exchange API key/secret, raw token, or the contents of `.env`. Enforced by:

1. construction-only-from-entities pattern (DTO classes accept the entity in their constructor; no `Object.assign(dto, req.body)`);
2. a reviewer-side checklist item in W2;
3. a unit test per DTO asserting the JSON-serialised shape against a snapshot of permitted keys (anti-coverage per dev-qa-cycle §2.2).

### 2.3.1 Nullability — `null` means "unknown / not yet computed" (M9 R1 adjudication C)

Sentinel strings (`'0'`, `''`, `entryPrice` fabricated as `exitPrice`) silently fabricate values the engine does not actually have. The dashboard cannot distinguish "true zero" from "missing field" — quant blocker. The rule for M9:

| DTO field | Type | Sentinel previously? | New nullability | Rationale |
|---|---|---|---|---|
| `IAccountEquityView.marginUsed` | `string \| null` | `'0'` | **null** until M6 W7 ships discrete columns | DB doesn't store it; faking zero misleads the operator |
| `IAccountEquityView.freeMargin` | `string \| null` | `'0'` (currently `formatMoneyString(balance)` — wrong) | **null** until persisted | balance is not free margin |
| `IAccountEquityView.openExposureUsd` | `string \| null` | derived guess | **null** until persisted | speculative arithmetic is worse than absence |
| `IPerformanceByVersionView.maxDrawdownUsd` | `string \| null` | `'0'` | **null** | live engine has no per-version equity series; backtest report has the real number |
| `IPerformanceByVersionView.sharpe` | `string \| null` | `'0'` | **null** | same |
| `IPerformanceByVersionView.sortino` | `string \| null` | `'0'` | **null** | same |
| `IPerformanceByVersionView.expectancyPerUnitRisk` | `string \| null` | `'0'` | **null** | same |
| `IModelDivergenceEvent.observedSlippageBps` | `string \| null` | `'0'` | **null** when `sampleCount === 0` | divide-by-zero is not a slippage |
| `IModelDivergenceEvent.modeledSlippageBps` | `string \| null` | `'0'` | **null** when `sampleCount === 0` | same |
| `IOpenPositionView.unrealizedPnlUsd` | renamed | merged price-only number | **split** into `unrealizedPnlPriceUsd: string` (price-only, always computable) + `unrealizedPnlFundingUsd: string \| null` (null until M6 W5 funding accrual surfaces on the entity) | precision: the dashboard must not silently treat a price-only estimate as accounting-grade |
| `IClosedPositionView.exitPrice` | `string \| null` | fabricated `entryPrice` | **null** when row has no `exitPrice` | fabrication corrupts trade-blotter reads |
| `IClosedPositionView.realizedPnlUsd` | `string \| null` | `'0'` for null | **null** when entity column is null | same |
| `IDecisionView.reason` | `string \| null` | `''` | **null** when DB column is null | empty string ambiguous |
| `IDecisionView.signalScore` | `string \| null` | `'0'` | **null** when not in `market_snapshot` | distinguishes "score=0" from "skip decision had no score" |
| `IRiskStateView.haltReason` | `string \| null` (already) | — | unchanged | already correct |

The DTO TypeScript types in `packages/shared/src/interface/` widen these fields to `string | null`. Mappers in `apps/engine/src/read-api/mappers/` return `null` instead of sentinels. The permitted-key snapshot test stays the gate against accidental re-introduction of `'0'`.

The renaming `unrealizedPnlUsd` → `unrealizedPnlPriceUsd` is a **breaking** change inside `/v1/`, accepted now (M9 is still pre-dashboard); after M10 ships, any further rename requires a `/v2/` bump.

### 2.4 Money serialisation

Money fields cross the boundary as **strings** (decimal-safe), never `number`. The shared package already enforces this convention (M4 §2.5). Read-API DTOs carry `*Usd: string`. Dashboard re-parses with `decimal.js`.

### 2.5 Pagination

Uniform shape `IPaginated<T> { items: T[]; nextCursor: string | null; pageSize: number }`. Cursor = HMAC-tagged base64 of `(occurredAt, id)` tuple via the shared `CursorCodec` (M9 R1 adjudication D — applies to **every** paginated read endpoint including `/v1/control/halt/history`; no plaintext-base64 carve-out). Monotonic descending. No offset pagination (breaks under writes). Max `pageSize = 200`, default `50`. Server-validated.

### 2.6 Version negotiation

URL-prefix only (`/v1/...`). The shared package exports a `READ_API_VERSION = 'v1' as const` constant so the dashboard pins against a compile-time mismatch. Breaking field changes within `/v1/` are forbidden post-M9; additive fields are allowed.

### 2.7 No write endpoints outside `/v1/control/*` and `/v1/auth/*`

Read API never accepts mutations on domain rows (positions, decisions, versions). Strategy promotion stays on the CLI (ADR 0019). This keeps the live trade loop's write surface unchanged from M8 — observability is a side-channel, never a back-door.

## 3. Consequences

- The dashboard (M10) has a stable, narrow, typed contract — shared package owns every DTO.
- The read-API layer is a thin mapper over repositories; no business logic, no risk-gate calls, no event bus reads. This keeps the surface auditable and easy to reason about for security review.
- Adding a new read view is a 3-step recipe: add interface in shared, add mapper + controller in engine, add a key-snapshot test. Predictable wave scope.
- Cursor pagination plus least-disclosure mapping costs a little dev time vs `JSON.stringify(entity)` — accepted; the alternative is a 12-month-out leak.

## 4. Alternatives considered

- **Serialise entities directly with `class-transformer` `@Expose/@Exclude`.** Rejected: couples the persistence layer to the wire contract; every entity change risks accidental disclosure. The mapper pattern keeps boundaries crisp.
- **GraphQL.** Rejected: over-engineered for one consumer, one operator. REST + WS suffices and is trivially curl-able.
- **Offset pagination.** Rejected: silently skips/duplicates rows under concurrent writes. Cursor is the standard for time-ordered domain feeds.
- **Embed live in-memory state (reservation ledger, monitor arm map) in the DTOs.** Rejected: those are engine internals; surfacing them invites the dashboard to depend on transient state that backtest cannot reproduce. The DTOs are derivable from persisted rows only.
- **Drop `/v1/` prefix.** Rejected: cheap insurance against a breaking schema change in M11.
