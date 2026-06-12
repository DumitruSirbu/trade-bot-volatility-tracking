# M9 — Execution plan (dispatch waves)

**Sibling to:** `docs/plans/archive/M9-observability-control.md` (task list / DoD).
**Authoritative ADRs:** 0020 (auth), 0021 (kill-switch), 0022 (read API), 0023 (WS/SSE), 0024 (Telegram), 0025 (schema-validation gate).
**Process rules:** `docs/best-practices/dev-qa-cycle.md` (≤5 files / ≤5 items per dispatch, paired tests, adversarial QA, reviewer continuity, architect on contract touches, orchestrator verifies diff).

## Wave summary

| Wave | Scope | Files (target) | Prereq |
|---|---|---|---|
| **W0** | Shared contracts (enums + DTOs + auth-failure shape) | shared/ only | — |
| **W1 (GATE)** | Startup schema-validation gate + AlertModule wiring + boot-pipeline reshuffle + `control_audit` migration | ≤5 engine | W0 |
| **W2 (GATE)** | Auth: guard + token issuance/revocation + CORS interceptor + secret loader | ≤5 engine | W0 |
| **W3** | Kill-switch endpoints + audit-log writer + halt-state restore at boot + flatten path | ≤5 engine | W0, W1, W2 |
| **W4** | Read API: REST controllers + entity→DTO mappers + cursor pagination | ≤5 engine | W0, W2 |
| **W5** | WS/SSE gateway: socket.io gateway + room subscriptions + backpressure + re-auth sweeper | ≤5 engine | W0, W2, W4 |
| **W6** | Telegram alert pipeline: sender + redactor + rate-limiter + scheduler + risk-halt/model-divergence surfacing | ≤5 engine | W0, W1, W3 |
| **QA** | Adversarial coverage across waves (see §QA) | tests only | W1–W6 |
| **REVIEW** | Parallel security + logic + clean-code + quant | — | QA |
| **SCRIBE** | Outcome section, runbooks (schema-fail recovery, kill-switch ops), live-app smoke | docs | review-clean |

**Prerequisite gates:** W1 (schema validation) and W2 (auth) MUST land and be reviewed clean before any other engine wave dispatches. W2 may dispatch in parallel with W1 because they touch disjoint files (auth lives under `apps/engine/src/auth/`, schema-gate under `apps/engine/src/bootstrap/`); both must be green before W3.

## W0 — Shared contracts (bot-shared-maintainer)

Adds to `packages/shared/src/`:

### Enums (new)

- `HaltSourceEnum` — `OPERATOR | MARKET_STRESS | MODEL_DIVERGENCE | DAILY_LOSS | WEEKLY_LOSS | RECOVERY | OTHER` (ADR 0021).
- `HaltStateEnum` — `RUNNING | HALTED` (ADR 0021).
- `AuthScopeEnum` — `READ | HALT | ADMIN` (ADR 0020).
- `AuthFailureReasonEnum` — `EXPIRED | REVOKED | MALFORMED | MISSING | BAD_SCOPE | CORS_FORBIDDEN` (ADR 0020).
- `AlertSeverityEnum` — `INFO | WARN | CRITICAL` (ADR 0024).
- `AlertTypeEnum` — `POSITION_OPENED | POSITION_CLOSED | ORDER_REJECTED_TERMINAL | RISK_HALT_ENGAGED | MODEL_DIVERGENCE_ENGAGED | OPERATOR_HALT | OPERATOR_RESUME | BOOT_SCHEMA_GATE_FAILED | RECONCILIATION_DRIFT_UNRESOLVED | UNHANDLED_EXCEPTION | DAILY_PNL_SUMMARY` (ADR 0024).
- `WsRoomEnum` — `POSITIONS | DECISIONS | PNL | CONTROL` (ADR 0023).

### Interfaces (new)

- `IAuthSubject` — `{ sub: string; jti: string; scopes: AuthScopeEnum[]; exp: number; iat: number }` (ADR 0020).
- `IAuthFailure` — `{ error: 'AUTH_FAILED'; reason: AuthFailureReasonEnum }` (ADR 0020).
- `IKillSwitchState` — per ADR 0021 §2.6.
- `IHaltAuditEntry` — projection of `control_audit` row (ADR 0021 §2.3).
- `IRiskHaltEvent` — `{ source: HaltSourceEnum; reason: string; engagedAt: string; metrics: Record<string, string> }` (M4 surfacing).
- `IModelDivergenceEvent` — `{ engagedAt: string; reason: string; observedSlippageBps: string; modeledSlippageBps: string; sampleCount: number }`.
- `IOpenPositionView`, `IClosedPositionView`, `IPositionDetailView` — ADR 0022 §2.3.
- `IDecisionView` — ADR 0022 §2.3.
- `IAccountEquityView`, `IRiskStateView`, `IPerformanceByVersionView` — ADR 0022 §2.3.
- `IPaginated<T>` — `{ items: T[]; nextCursor: string | null; pageSize: number }`.
- `IAlertPayload` — `{ type: AlertTypeEnum; severity: AlertSeverityEnum; occurredAt: string; title: string; body: string; data?: Record<string, string> }` (ADR 0024).
- `IHealthView` — `{ status: 'ok' | 'degraded'; uptimeSec: number; schemaValid: boolean }`.

### Constants

- `READ_API_VERSION = 'v1' as const` (ADR 0022 §2.6).

All money fields on DTOs are `string` (decimal-safe), confirmed against the existing M4 convention.

## W1 — Schema-validation gate + AlertModule + boot reshuffle (GATE)

Files (target ≤5):

1. `apps/engine/src/bootstrap/SchemaValidationService.ts` — the `PHASE 0` service + `REQUIRED_SCHEMA_MANIFEST`.
2. `apps/engine/src/bootstrap/BootstrapModule.ts` — wires `SchemaValidationService` + new ordering.
3. `apps/engine/src/alert/AlertModule.ts` + `IAlertSink` port (sender lives in W6; W1 ships a no-op sink so `BOOT_SCHEMA_GATE_FAILED` has a sink to publish to even before W6).
4. `apps/engine/src/persistence/migrations/<ts>-create-control-audit.ts` — table from ADR 0021 §2.3.
5. Test: `SchemaValidationService.spec.ts` (paired tests: present-all ok; missing-table fails; drift fails; partition warn-not-fail).

Acceptance: engine refuses to boot when a manifest table is missing; clean boot when all present; emits a noop-sink alert on failure.

## W2 — Auth (GATE, parallel to W1)

Files (target ≤5):

1. `apps/engine/src/auth/AuthGuard.ts` — verifies bearer, checks `revoked_jti`, attaches `IAuthSubject`.
2. `apps/engine/src/auth/AuthModule.ts` + token signer/verifier + `IAuthSecretProvider` env adapter.
3. `apps/engine/src/auth/AuthCorsInterceptor.ts` — allow-list per ADR 0020 §2.3.
4. `apps/engine/src/auth/cli/IssueRevokeCommands.ts` — `pnpm engine auth issue|revoke`.
5. `apps/engine/src/persistence/migrations/<ts>-create-revoked-jti.ts`.

Acceptance: any test endpoint behind the guard rejects missing/expired/revoked/cross-origin requests with the `IAuthFailure` shape; a fresh CLI-issued token unlocks it; revoke takes effect within one request.

## W3 — Kill-switch endpoints + audit + halt-state restore

Files (target ≤5):

1. `apps/engine/src/control/HaltController.ts` — POST halt / POST resume / GET halt + GET halt/history.
2. `apps/engine/src/control/HaltService.ts` — toggles M0 halt flag, writes `control_audit`, fires `IAlertPayload`, kicks flatten path (delegates to existing risk-gate CLOSE intents).
3. `apps/engine/src/control/HaltRateLimiter.ts` — sliding-window per `sub`.
4. `apps/engine/src/bootstrap/HaltStateRestoreService.ts` — `PHASE 3` reads latest `control_audit`.
5. Test: end-to-end controller test (auth + rate-limit + audit-row + flatten path uses risk gate, not the exchange directly).

Acceptance: halt + resume both write audit rows; flatten flag honored; programmatic halts (M4) also write audit; recovery restores last state.

## W4 — Read API

Files (target ≤5):

1. `apps/engine/src/read-api/ReadApiModule.ts` + controller group.
2. `apps/engine/src/read-api/mappers/<all DTOs>.ts` — one mapper per DTO (likely split — if it exceeds the file budget, split W4 into W4a/W4b along positions-vs-everything-else).
3. `apps/engine/src/read-api/pagination/CursorCodec.ts`.
4. `apps/engine/src/read-api/HealthController.ts`.
5. Test: snapshot-against-permitted-keys per DTO (anti-coverage per dev-qa-cycle §2.2).

Acceptance: every endpoint per ADR 0022 §2.2 reachable, scoped, paginated, money-as-string, no excluded fields in serialised output.

## W5 — WS/SSE gateway

Files (target ≤5):

1. `apps/engine/src/ws/LiveGateway.ts` — `@WebSocketGateway`, room subscribes, scope check.
2. `apps/engine/src/ws/auth/WsAuthHandshake.ts` + sweeper.
3. `apps/engine/src/ws/backpressure/PerSocketQueue.ts`.
4. `apps/engine/src/ws/coalescing/{PnlThrottle,PositionCoalescer}.ts` (may split if needed).
5. Test: handshake reject, mid-stream expiry, slow-client disconnect, coalesce semantics.

Acceptance: client receives live `position.updated` ticks while token valid; receives `auth.expired` + clean close on expiry; receives `stream.lagged` on overflow.

## W6 — Telegram alerts + risk-halt + model-divergence surfacing

Files (target ≤5):

1. `apps/engine/src/alert/TelegramAlertSink.ts` — replaces the W1 no-op sink.
2. `apps/engine/src/alert/AlertRedactor.ts` — pure redaction function + fixtures.
3. `apps/engine/src/alert/AlertRateLimiter.ts` — coalescing + global ceiling.
4. `apps/engine/src/alert/DailyPnlSummaryScheduler.ts` — 00:00 UTC tick, injected clock.
5. `apps/engine/src/alert/listeners/RiskHaltListener.ts` + `ModelDivergenceListener.ts` — subscribe to M4 events, emit `IAlertPayload`s + write `control_audit`.

Acceptance: each event in ADR 0024 §2.2 fires a redacted message on the dev chat; coalescing observable; daily summary fires at the UTC tick.

## QA wave (after W6)

Adversarial coverage per dev-qa-cycle §2.2. Must include:

- **Auth:** expired-in-flight, revoked-mid-WS, malformed JWT, scope downgrade attempt, CORS preflight from disallowed origin, header injection in `reason` field.
- **Kill-switch:** halt-while-halted idempotency, rate-limit at boundary (5th and 6th hit), flatten with zero open positions, flatten with an in-flight ADD intent, programmatic + operator halt in the same millisecond, halt during recovery.
- **Schema gate:** missing one column on `control_audit`, drift where DB ahead of code, drift where code ahead of DB, partition for today missing (warn-not-fail).
- **Read API:** cursor reuse after a row deletion, pagination across a write storm, DTO key-snapshot for every interface (no leakage), `before=` in the future, oversized `pageSize`.
- **WS:** token expiring 1ms before next emit, sweeper races with emit, queue overflow exactly at cap, slow-client at 9.99s queue-full.
- **Telegram:** redactor against JWT-in-`reason`, redactor against `process.env` dump in stack trace, global ceiling exhaustion with a critical pending, daily summary at DST-irrelevant UTC midnight, missing token in prod profile.
- **Live-app smoke:** 10-minute boot, dashboard fakery via curl + websocat, halt+resume cycle, observe audit + alert + WS event for each.

Failures route per dev-qa-cycle §2.2: implementation bug → engineer; contract gap → architect.

## REVIEW wave

Four parallel reviewers (security, logic, clean-code, quant). Round 2+ resumed via `SendMessage` against the round-1 agentId. Continue until zero blockers, zero highs, majority of mediums resolved.

## SCRIBE

- `docs/runbooks/schema-fail-recovery.md`,
- `docs/runbooks/kill-switch-operations.md`,
- M9 outcome section in `docs/work-log.md`,
- CLAUDE.md status flip M9 → DONE.

## Live-vs-backtest invariant — confirmed

None of W0–W6 touches the strategy, the risk gate, the executor's order path, the reservation ledger, or the deterministic clock. All M9 surfaces are read-side (observability), write-side only against `control_audit` + `revoked_jti` + the in-memory halt flag. The kill-switch flatten emits intents through the same risk gate + executor path the rest of the engine uses — no shortcut, no bypass. Live↔backtest contract (`docs/architecture/live-vs-backtest-contract.md`) is unchanged.

## Risks / open questions for the orchestrator before W0

1. **Operator count.** Confirmed single-operator? If a second human gets a token in M10/M11, the per-`sub` rate-limit math (ADR 0021 §2.2) and the audit `actor_sub` queries stay correct, but the revoke ceremony scales linearly — flag for M11.
2. **Where does the operator get the bearer?** Decision needed: ship a `pnpm engine auth issue` CLI in W2 (current plan), or also expose a one-time login endpoint guarded by a static bootstrap secret? Current plan is CLI-only — confirm.
3. **`flattenOpenPositions` default.** ADR 0021 §2.4 picks `false` (preserve stops). Confirm this matches operator preference; the alternative is `true` (panic = exit). Both are defensible; this is a policy call.
4. **Telegram in dev.** Plan is "undefined token → no-op sink." Confirm dev runs should be alert-silent by default rather than alerting a dev chat.
5. **WS transport.** ADR 0023 picks socket.io to match the dashboard agent contract. If M10 has not been re-baselined, confirm dashboard team still expects socket.io (vs raw `ws` / SSE).
6. **`control_audit` retention.** Currently append-only with no TTL. If the operator hits resume/halt frequently in dev, the table grows. Acceptable for M9; flag a partition + retention policy decision for M11.

## M9 R1 contract adjudications

Decisions made by the architect after R1 reviewers surfaced contract-level questions. Each updates the noted ADR; the engineer's fix wave touches the file paths listed.

| ID | Decision | One-line rationale | Files |
|---|---|---|---|
| **A** | Halt SoT = **Option β** (split): `risk_state.is_halted` stays gate-hot-path SoT (deterministic, replay-safe); `control_audit` is operator audit + boot-recovery SoT; `RiskListeners` becomes alert-only and flips the in-memory halt flag directly, does NOT call `HaltService.engageHalt`, does NOT write `control_audit` (ADR 0021 §2.3). | Programmatic halts are already durable in `risk_state`; routing them through `control_audit` introduced double-writes + double-emits and coupled the deterministic gate to the operator audit table. | `apps/engine/src/alert/listeners/RiskListeners.ts` (drop `engageHalt` call; replace with `haltFlag.halt(...)` + alert publish), `apps/engine/src/control/HaltService.ts` (remove `'SYSTEM:<source>'` paths from `writeAudit`), `apps/engine/src/control/repository/ControlAuditRepository.ts` (drop `appendProgrammatic`), `apps/engine/src/bootstrap/HaltStateRestoreService.ts` (read both `control_audit` AND `risk_state` for today, newer wins). |
| **B** | Halt emit dedupe = **add `wasAlreadyHalted: boolean` to `IHaltChangedEvent`** (option ii). Still emit + still Telegram-alert; consumer decides loudness. | Operator audit row is real and must update the dashboard timeline; suppression hides operator action acknowledgement. | `packages/shared/src/interface/IHaltChangedEvent.ts` (W0 contract bump), `apps/engine/src/control/HaltService.ts` (`emitHaltChanged` sets flag from `previousState === newState`). |
| **C** | DTO nullability = **widen to `string \| null`** for every unknown field (table in ADR 0022 §2.3.1). Rename `unrealizedPnlUsd` → `unrealizedPnlPriceUsd`; add `unrealizedPnlFundingUsd: string \| null` sibling. | Sentinels (`'0'`, fabricated `entryPrice`) corrupt operator reads; null says "unknown" honestly. Splitting unrealized PnL prevents the dashboard mistaking a price-only estimate for accounting-grade. | `packages/shared/src/interface/I{AccountEquityView,PerformanceByVersionView,ModelDivergenceEvent,OpenPositionView,ClosedPositionView,DecisionView,PositionDetailView}.ts` (W0 contract bump), `apps/engine/src/read-api/mappers/readApiMappers.ts` (return `null` instead of `'0'` / `entryPrice` / `''`; update `OPEN_POSITION_VIEW_KEYS` + `POSITION_DETAIL_VIEW_KEYS` for the rename), `apps/engine/src/alert/listeners/RiskListeners.ts` (emit `null` slippage when sampleCount=0). |
| **D** | History pagination cursor = **route through `CursorCodec` (HMAC)**, same as every other paginated endpoint. No plaintext-base64 carve-out. | One codec, one rule; consistency for the dashboard; pre-empts the next reviewer flagging the inconsistency. | `apps/engine/src/control/HaltController.ts` (use `CursorCodec.encode/decode` instead of `Buffer.from(...).toString('base64')`), `apps/engine/src/control/repository/ControlAuditRepository.ts` (`findHistoryPage` accepts decoded `(occurredAt, id)` tuple). |
| **E** | `KILL_SWITCH_FLATTEN_DEFAULT` = **read via `AppConfigService`** with typed boolean coercion. No per-request `process.env` access. | Per-request env reads are typo-allergic and bypass the typed config layer; AppConfigService already exists for AUTH_* / ALERTS_*. | `apps/engine/src/common/config/AppConfigService.ts` (add `killSwitchFlattenDefault: boolean`), `apps/engine/src/control/HaltController.ts` (inject config, drop `process.env`). |
| **F** | CORS allow-list = **single source via `AppConfigService.corsAllowlist: readonly string[]`**. Both `AuthCorsInterceptor` and the `@WebSocketGateway` inject the config; neither reads `process.env`. ADR 0020 §2.3 + §2.7 updated. | Two readers of the same env drift on hot-edit / casing / typos; gateway boot-time reads diverged from interceptor request-time reads. | `apps/engine/src/common/config/AppConfigService.ts` (typed list), `apps/engine/src/auth/AuthCorsInterceptor.ts` (inject), `apps/engine/src/ws/LiveGateway.ts` (inject; `@WebSocketGateway(...)` decorator pulls from a static factory wired in `WsModule`). |

### Fix-wave grouping (each dispatch ≤5 files)

**Fix dispatch 1 — shared contracts (bot-shared-maintainer, serial, BEFORE engine fixes):**

- `packages/shared/src/interface/IHaltChangedEvent.ts` — add `wasAlreadyHalted: boolean`.
- `packages/shared/src/interface/IOpenPositionView.ts` — rename `unrealizedPnlUsd` → `unrealizedPnlPriceUsd`; add `unrealizedPnlFundingUsd: string | null`.
- `packages/shared/src/interface/IPositionDetailView.ts` — mirror the rename + add.
- `packages/shared/src/interface/IClosedPositionView.ts` — `exitPrice: string | null`, `realizedPnlUsd: string | null`.
- `packages/shared/src/interface/IAccountEquityView.ts` + `IPerformanceByVersionView.ts` + `IModelDivergenceEvent.ts` + `IDecisionView.ts` — widen per §C table (treat as one mechanical edit pass; barrel re-export is a sibling mechanical touch and does not count against the cap per `feedback-file-cap-pragmatism`).

**Fix dispatch 2 — halt SoT split (bot-engine-nestjs):**

- `apps/engine/src/alert/listeners/RiskListeners.ts`
- `apps/engine/src/control/HaltService.ts`
- `apps/engine/src/control/repository/ControlAuditRepository.ts`
- `apps/engine/src/bootstrap/HaltStateRestoreService.ts`
- Paired test: `apps/engine/src/alert/listeners/RiskListeners.spec.ts` (assert listener does NOT call `engageHalt`; does flip halt flag; does publish alert).

**Fix dispatch 3 — DTO nullability mappers (bot-engine-nestjs, parallel to dispatch 2):**

- `apps/engine/src/read-api/mappers/readApiMappers.ts` (mapper updates + permitted-key arrays for renames)
- Paired test: `apps/engine/src/read-api/mappers/readApiMappers.spec.ts` (anti-coverage snapshot: assert `null` not `'0'` on each widened field; assert `unrealizedPnlPriceUsd` + `unrealizedPnlFundingUsd` shape).

**Fix dispatch 4 — config + cursor + emit-flag (bot-engine-nestjs):**

- `apps/engine/src/common/config/AppConfigService.ts` (add `killSwitchFlattenDefault`, `corsAllowlist`)
- `apps/engine/src/control/HaltController.ts` (inject config; CursorCodec for history)
- `apps/engine/src/auth/AuthCorsInterceptor.ts` (inject config)
- `apps/engine/src/ws/LiveGateway.ts` (inject config via module factory)
- Paired test: `apps/engine/src/control/HaltController.spec.ts` (cursor round-trip with HMAC; flatten-default via config; halt-while-halted sets `wasAlreadyHalted=true` on emit).

**Live-vs-backtest invariant — re-confirmed.** None of these adjudications change `RiskGateService.evaluate(...)`'s inputs, outputs, or determinism: persistHalt stays the gate's hot-path SoT (Decision A keeps it); mapper changes are read-side only; config / cursor / emit-flag changes are observability-side. The strategy and risk path are untouched.
