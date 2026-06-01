# ADR 0021 — Kill-switch contract (M9)

**Status:** Accepted (M9 design wave)
**Date:** 2026-05-24
**Milestone:** M9
**Depends on:** ADR 0020 (auth), M0 (halt flag), M4 (risk halts), M5 (execution honors halt), ADR 0014 (recovery rejects exposure-increasing intents).
**Consumed by:** ADR 0022 (read-API exposes halt state), ADR 0023 (WS pushes halt transitions), ADR 0024 (Telegram alert on halt).

## 1. Context

M0 shipped a process-local halt flag; M4 added programmatic risk-halts (global market-stress, model-divergence kill-switch, daily/weekly loss windows); M5 made the executor refuse exposure-increasing intents while halted. M9 adds the **operator-driven** path: a single authenticated HTTP action that flips the same flag, with audit + rate-limit + alert.

The invariant is `no order path bypasses the risk gate, including the kill-switch flatten`. The kill-switch is therefore **not** a backdoor to the exchange — it sets a flag the gate and executor already honor.

## 2. Decision

### 2.1 Endpoint shape

```
POST /v1/control/halt
Authorization: Bearer <token with scope=halt>
Body: { "reason": "<free-text, max 256 chars>", "flattenOpenPositions": <boolean, optional> }
→ 200 { "haltState": "HALTED", "haltedAt": "<ISO>", "haltReason": "OPERATOR:<reason>", "flattenRequested": <bool>, "auditId": "<uuid>" }

POST /v1/control/resume
Authorization: Bearer <token with scope=halt>
Body: { "reason": "<free-text, max 256 chars>" }
→ 200 { "haltState": "RUNNING", "resumedAt": "<ISO>", "auditId": "<uuid>" }

GET /v1/control/halt
Authorization: Bearer <token with scope=read>
→ 200 IKillSwitchState  (shape in packages/shared, see §2.6)
```

Idempotency: a second `POST /halt` while already halted returns `200` with the same `haltState` but a fresh `auditId` (the operator action is still audited). It does **not** re-trigger a flatten — the flatten flag is bound to the first transition.

### 2.2 Rate-limit policy

Per token `sub`: max **5 halt/resume toggles per 60 seconds**, sliding window. Exceeded → HTTP `429` with `Retry-After`. Rationale: the kill-switch is a panic button, not a polling mechanism; an operator slamming it repeatedly is either confused or compromised — either way, throttle.

Rate-limit is enforced server-side in an interceptor; bypass for `scope=admin` is **not** granted (the admin token is for revocation/rotation, not for control-plane spam).

### 2.3 Audit-log schema

A new table `control_audit` (one row per accepted toggle):

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | server-minted |
| `occurred_at` | `timestamptz` NOT NULL | event-time, monotonic via injected clock (live↔backtest determinism — even though no replay path uses this, the convention holds) |
| `actor_sub` | `text` NOT NULL | from `IAuthSubject.sub` |
| `actor_jti` | `text` NOT NULL | for forensic correlation with revocation |
| `source_ip` | `inet` NULL | from the proxied request; null if loopback |
| `action` | `text` NOT NULL | `HALT` \| `RESUME` |
| `reason` | `text` NOT NULL | operator-supplied, truncated server-side at 256 |
| `flatten_requested` | `boolean` NOT NULL DEFAULT false | only meaningful on `HALT` |
| `previous_state` | `text` NOT NULL | `RUNNING` \| `HALTED` |
| `new_state` | `text` NOT NULL | `RUNNING` \| `HALTED` |
| `correlation_event_id` | `text` NULL | set when the toggle was triggered by a programmatic source (e.g., the alert side-channel hits the same endpoint) — null for operator |

Indexed on `(occurred_at DESC)` and `(actor_sub, occurred_at DESC)`.

**Pagination codec (M9 R1 adjudication D).** `GET /v1/control/halt/history` MUST use the shared `CursorCodec` (HMAC tamper-guarded, same key as the rest of W4) — not plaintext base64. The audit log is read-scoped but operator-authored: an attacker who somehow obtains a read token should not be able to construct cursors that probe row existence beyond their authenticated session, and consistency across the read API eases the dashboard's cursor handling. Decision is: one codec, one rule.

`control_audit` is **append-only**. No update/delete from the engine; operator-driven deletion requires a manual migration.

**Halt source-of-truth split (M9 R1 adjudication A — Option β chosen).** The dual-storage problem (M4 `RiskGateService.persistHalt` writing `risk_state.is_halted` AND the W3 listener writing `control_audit` for the same event) is resolved by separating concerns by surface:

- `risk_state.is_halted` (UTC-day row, written by `persistHalt`) is the **hot-path source of truth for the risk gate's GLOBAL_HALT check**. It is DB-canonical, replay-safe, idempotent on the UTC-day key, and is what the gate consults each `evaluate(...)`. This must not change — the live-vs-backtest determinism contract depends on it.
- `control_audit` is the **operator audit log + boot-recovery source for the in-process halt flag**. It is the SoT for `GET /v1/control/halt/history` and for `HaltStateRestoreService` PHASE 3 boot replay.
- `RiskListeners.onRiskHalt` / `onModelDivergence` (W6) are **alert-only**. They MUST NOT call `HaltService.engageHalt(...)`. They publish the `IAlertPayload` and update the in-memory halt flag via `HaltFlagService` only (so M5's flag-based refusal works in the same tick). They do NOT write a `control_audit` row; the programmatic halt is already durable in `risk_state.is_halted`.
- `control_audit` rows are written exclusively by the **operator path** (`POST /v1/control/halt`, `POST /v1/control/resume`) and (later, M11) any external programmatic resume. `GET /v1/control/halt/history` therefore returns operator history only; the dashboard surfaces programmatic halts via the `IRiskHaltEvent` bus stream (ADR 0023) + the per-day `risk_state.haltReason`.

Consequences locked here:

1. The `actor_sub = 'SYSTEM:<source>'` convention is REMOVED from this ADR — `control_audit` rows always carry a real `actor_sub`.
2. `IKillSwitchState.haltSource` is derived as: if `risk_state.is_halted=true AND no operator audit row newer than the risk-day's start` → the persisted `risk_state.haltReason` maps to a `HaltSourceEnum`; otherwise the latest `control_audit` row wins.
3. `HaltStateRestoreService` PHASE 3 reads BOTH: it picks the more-recent of (latest `control_audit` row, `risk_state` for today with `is_halted=true`). Whichever is newer drives the in-process halt flag on boot.
4. `IHaltChangedEvent` bus emit (W3) fires from BOTH `HaltService.engageHalt` (operator path) AND from `RiskListeners` after they flip the in-memory flag (programmatic path). The event is the unified stream for the WS gateway.

Why not Option α (`control_audit` as sole SoT): the gate would need to consult `control_audit` on the hot path, which (a) breaks the gate's "reads `risk_state` snapshot once per evaluate" invariant and (b) introduces a dependency from the deterministic gate into the operator audit table. Not worth it.

Why not Option γ ("passive" engage): it requires `HaltService` to silently no-op the flag-flip branch when called from the listener, which is exactly the side-effect-on-flag-state coupling Option β removes by making the listener own the in-memory flip directly.

### 2.4 `flattenOpenPositions` default & semantics

Default = `false`. Rationale: a panic halt should **stop new risk** but leave existing positions under their stops; force-closing into a stressed tape is often worse than holding to the SL. The operator opts in to flatten by explicitly setting `flattenOpenPositions: true`.

The default is config-overridable via env `KILL_SWITCH_FLATTEN_DEFAULT` (false by default). **The value is read once at boot by `AppConfigService` with typed boolean coercion** (ADR 0020 §2.7) and injected into `HaltController` as a constant; `HaltController` MUST NOT touch `process.env` per request (M9 R1 adjudication E). Rationale: per-request `process.env` parsing is allergic to typos (a stray `'False'` casing slips through the truthy check) and silently differs from any other env-coerced value in the engine.

When `flattenOpenPositions = true`:

- The halt flag flips first.
- The engine enqueues a `CLOSE` intent (`OrderIntentActionEnum.CLOSE`) for each open position via the **normal risk gate + executor path**, NOT a direct exchange call. The gate's "de-risking always allowed during halt" rule (ADR 0014 §1 revision) lets these through. ExecutionModule routes each through `REDUCE_MARKET` policy (ADR 0005).
- A `flatten_requested` audit row is written; per-position close events surface via existing M6/M5 instrumentation.

If a programmatic halt (e.g., model-divergence kill-switch) wants to flatten, it sets the same flag and emits the same intents — no special code path.

### 2.5 How ExecutionModule consumes the halt state

No change to M5: the executor already reads the halt flag via the M0 `IHaltFlag` port and refuses exposure-increasing intents. M9 only adds **two write paths** into the same flag:

1. operator `POST /halt` / `POST /resume`,
2. programmatic risk halts (M4) — already wired pre-M9; this ADR formalises that they also emit a `control_audit` row.

The flag itself stays in-process (no migration; recovery on restart loads the most recent `control_audit` row to re-establish state — added in W1 of M9 to the boot pipeline).

### 2.6 Shared state shape

`IKillSwitchState` (locked in `packages/shared/src/interface/IKillSwitchState.ts`, added by shared-maintainer in W0):

```
{
  haltState: 'RUNNING' | 'HALTED',
  haltedAt: string | null,        // ISO; null when RUNNING
  haltReason: string | null,      // null when RUNNING
  haltSource: HaltSourceEnum,     // OPERATOR | MARKET_STRESS | MODEL_DIVERGENCE | DAILY_LOSS | WEEKLY_LOSS | RECOVERY | OTHER
  flattenInProgress: boolean,     // true while flatten intents are in-flight
  lastTransitionAuditId: string,  // uuid into control_audit
}
```

`HaltSourceEnum` is a new shared enum (W0). The string `haltReason` is the operator-supplied or M4-supplied reason verbatim, redacted of any secret-shaped substring (regex strip in the alert layer per ADR 0024).

## 3. Consequences

- The kill-switch never reaches the exchange directly — it flips one flag the rest of the engine already respects. This preserves the "no order path bypasses the risk gate" invariant.
- Every halt — operator or programmatic — produces a `control_audit` row and a Telegram alert (ADR 0024). Single source of truth for both forensic review and dashboard timelines.
- Boot-pipeline now must load the last `control_audit` row to restore halt state; documented in §2.5 and folded into M9 W1.
- Rate-limit is per-`sub`, not per-IP — correct for a single-operator system; revisit for multi-operator in M11.
- `flattenOpenPositions` defaults to `false` and is loud about it in the response — surprise-free.

## 4. Alternatives considered

- **Flatten by default.** Rejected: forced exits into stress (the most common reason to halt) often realise worse fills than the standing SLs. The cautious default is "stop new risk, preserve existing stops."
- **Direct exchange-side cancelAll on halt.** Rejected: this is the bypass path the project invariants forbid. Cancels go through the executor like any other order.
- **No rate-limit (panic button should never throttle).** Rejected: the first toggle is unthrottled (rate-limit starts at the 6th in 60s). The operator's first jab always lands.
- **Audit in a JSON log file only.** Rejected: the dashboard (M10) needs queryable history; a table is cheaper than parsing logs from the UI.
- **Kill-switch as a WS command.** Rejected: per M9 "Telegram is never a control path" and the WS is similarly read-only — control-plane stays HTTP for explicit, auditable, idempotent semantics.

## 5. Addendum — operator resume clears `risk_state.is_halted` (M11a soak fix)

**Status:** Accepted (M11a soak hardening)
**Date:** 2026-05-28
**Trigger:** PAPER-soak operator-control validation surfaced a confirmed bug: `POST /v1/control/resume` had **zero persistent effect** on the risk gate.

### 5.1 The gap (confirmed, not intentional)

The §2.3 Option-β SoT split says programmatic halts are owned by `risk_state.is_halted` (the gate's hot-path SoT) and operator actions are owned by `control_audit` + the in-memory halt flag. That split is correct for the **halt** direction, where both writers run: `RiskGateService.persistHalt(...)` writes `risk_state.is_halted=true` for a programmatic halt, and `RiskListeners` flips the in-memory flag. But the split left a hole on the **resume** direction:

`HaltService.resume(...)` only:

1. writes a `RESUME` row to `control_audit`, and
2. clears the in-memory flag via `HaltFlagService.resume()`.

It never clears `risk_state.is_halted`. Meanwhile `RiskGateService.evaluate(...)` loads `risk_state` for the UTC day on **every call** and rejects with `GLOBAL_HALT` whenever `risk_state.is_halted = true`. So once any programmatic halt has persisted `is_halted=true` for today, an operator resume clears the flag the executor reads but **not** the column the gate reads — every subsequent trigger still rejects `GLOBAL_HALT`. The operator's resume button looks like it worked (response is `200 RUNNING`, in-memory flag cleared, executor would accept) but the gate that runs first on every trigger silently keeps rejecting.

The gap compounds on reboot. `HaltStateRestoreService` PHASE 3 (§2.3 consequence 3) applies a **halt-wins tie-break** while `risk_state.updated_at` does not yet exist: if the latest `control_audit` row says `RUNNING` but `risk_state` for today says `HALTED`, `risk_state` wins and the halt is re-engaged. So even after a clean operator resume, the next boot re-halts the engine from the stale `risk_state` row. Net: the operator resume has **zero persistent effect** against a programmatic halt — neither in the live gate nor across a restart.

This is a gap, not a deliberate design choice. §2.3 explicitly preserved the operator↔programmatic write asymmetry only for the **audit table** (operators write `control_audit`, programmatic halts do not). It never intended the gate's GLOBAL_HALT state to be un-clearable by the only human-facing resume path. The original §2.3 enumerated the halt-direction double-write (`persistHalt` + flag) but did not state a symmetric resume-direction double-clear; that omission is the bug.

### 5.2 Decision (locked)

`HaltService.resume(...)` MUST clear the gate-hot-path SoT in addition to the audit row and the in-memory flag, mirroring how a programmatic halt writes to **both** `risk_state` and the in-memory flag. Concretely:

1. `RiskStateRepository` gains a targeted method:

   ```
   clearHaltForDate(utcDate: string): Promise<void>
   ```

   It performs a narrow `UPDATE` of `is_halted = false, halt_reason = null` for **today's UTC-day row only**. It MUST NOT touch `realized_pnl_day`, `open_exposure`, or `trades_count` — the operator is lifting the halt, not resetting the day's loss accounting (the daily/weekly loss windows must still bind after resume). If today's row does not exist, it is a no-op (there is nothing to clear; a halt always wrote a row first).

2. `HaltService.resume(...)` calls `clearHaltForDate(todayUtc)` as part of the resume transition. Ordering follows the existing write-then-flip discipline: the audit row is written first (durable evidence), then `risk_state` is cleared, then the in-memory flag is cleared. A failure to clear `risk_state` after the audit row is written fires a CRITICAL alert and re-raises (same pattern as the existing flag-flip failure branch) — a half-cleared resume must be loud, not silent.

3. The UTC date passed to `clearHaltForDate` is the same `now`-derived UTC-day string the gate uses, taken from the injected clock — never `Date.now()` directly, preserving the determinism convention even though resume is operator-only and not on the replay path.

This keeps the Option-β SoT split intact: the gate still reads `risk_state` as its single hot-path source; the operator resume now writes to **both** `control_audit` AND `risk_state`, exactly mirroring the halt direction. It also fixes the boot tie-break for free — once `risk_state.is_halted=false` for today, the PHASE 3 halt-wins tie-break has nothing to re-engage, and the latest `control_audit` `RUNNING` row governs unopposed.

**Scope boundary.** This addendum covers the operator resume path only. The programmatic auto-clear paths (`RateLimitHaltAdapter.autoClear`, future loss-window expiry) already own their own `risk_state` semantics and are out of scope; they are not changed here. The §2.4 flatten semantics are unchanged.

### 5.3 DI direction — no circular dependency, port token required

`HaltService` lives in `ControlModule`; `RiskStateRepository` lives in `RiskModule`. Injecting the concrete `RiskStateRepository` directly into `HaltService` would force `ControlModule` to import `RiskModule`, which **closes a module cycle**:

```
ControlModule → RiskModule → PositionModule → ExchangeModule → ControlModule
                                              (ExchangeModule imports ControlModule
                                               for RATE_LIMIT_HALT_PORT, no forwardRef)
```

All four edges are plain imports today, so a direct `RiskModule` import from `ControlModule` would introduce a four-module NestJS DI cycle. This is the same class of cycle the project already solved in the opposite direction.

**Decision: use a port token with local provision in `ControlModule`, not a module import** — `HaltService` injects the `RISK_HALT_STATE_PORT` token (a single-method interface), never the concrete `RiskStateRepository`. `RiskModule` is **not** involved in the token binding; it neither provides the adapter nor exports the token. Instead `ControlModule` wires the whole chain locally:

- `ControlModule` defines a small port — `RISK_HALT_STATE_PORT` with an interface exposing a single method `clearHaltForDate(utcDate: string): Promise<void>` (and nothing else — least surface). The token + interface live under `control/interface/`.
- `ControlModule` provides `RiskStateRepository` locally by adding `RiskStateEntity` to its own `TypeOrmModule.forFeature([...])`, then listing `RiskStateRepository` in its `providers`. This gives `ControlModule` its own instance of the repository without importing `RiskModule`.
- `RiskHaltStatePortAdapter` (the class that wraps `RiskStateRepository` and fulfils the port) is imported by **file path** into `ControlModule` and listed in `ControlModule`'s `providers`. `ControlModule` binds the token with `{ provide: RISK_HALT_STATE_PORT, useExisting: RiskHaltStatePortAdapter }`.
- `HaltService` injects the token, not the repository.

Note on the adapter's physical location: `RiskHaltStatePortAdapter` lives under `risk/service/` because it depends on `RiskStateRepository` and sits naturally beside the other risk-state code. But it is **registered by `ControlModule`**, not by `RiskModule` — `RiskModule` does not provide or export it. A class file under `risk/` referenced by a file-path import is not a module-import edge; only an entry in `ControlModule`'s `imports: [...]` would be. So no new module-import edge is created and the cycle is not formed.

Why local provision rather than having `RiskModule` export the token: exporting the adapter/token from `RiskModule` would still require `ControlModule` to import `RiskModule` to consume the export, which is exactly the module-import edge that closes the cycle. Providing `RiskStateRepository` + the adapter locally in `ControlModule` (the same way `ControlModule` already provides `CursorCodec` locally to stay independent of the read-API import graph) keeps `ControlModule` cycle-free while still routing through a narrow token. This mirrors the intent of the `RATE_LIMIT_HALT_PORT` inversion (ADR 0030 §2.6.2) — a single-method port, no cross-module import — even though the binding here is provided rather than exported.

Rationale for the port over a `forwardRef`: `forwardRef` would paper over the cycle but leaves `ControlModule` structurally depending on the full `RiskModule` surface, which is the coupling the rest of the engine deliberately avoids (see RiskModule's own header note on collapsing forwardRefs). A single-method port keeps `ControlModule` ignorant of risk-state internals beyond the one clear method.

Note: `HaltStateRestoreService` (in `bootstrap/`) already injects `RiskStateRepository` concretely and reads it at PHASE 3 — that is fine because `BootstrapModule` is a top-level composition module that imports both and is imported by no one, so it cannot be part of a cycle. The port is needed specifically because `ControlModule` sits inside the `Exchange ↔ Control` import ring.

### 5.4 Consequences

- The operator resume button now has the persistent effect operators expect: it clears the gate's GLOBAL_HALT for today and survives a reboot.
- The Option-β SoT split is preserved and made symmetric: halt writes both `risk_state` + flag; resume clears both `risk_state` + flag. The gate's "read `risk_state` once per evaluate" invariant is untouched.
- Daily/weekly loss-window accounting is preserved — resume clears only `is_halted`/`halt_reason`, never the PnL/exposure/trade columns, so an operator cannot accidentally launder a loss-limit halt into more trading capacity.
- The boot halt-wins tie-break (§2.3 consequence 3) is no longer a trap for operator resume; the deferred `risk_state.updated_at` true-newer-wins work (M9 deferred list) is now lower urgency, though still desirable for full timestamp ordering.
- No change to the strategy, the executor order path, or live↔backtest determinism. The new write is operator-control-plane only.

### 5.5 Alternatives considered

- **Make the gate also consult `control_audit` on resume (Option α revisited).** Rejected for the same reason §2.3 rejected Option α: the deterministic gate must not read the operator audit table on the hot path.
- **`forwardRef(() => RiskModule)` in `ControlModule`.** Rejected: resolves the cycle mechanically but couples `ControlModule` to the whole `RiskModule` surface; the single-method port is narrower and matches the established `RATE_LIMIT_HALT_PORT` inversion.
- **Have `RiskGateService` clear its own halt when it observes a newer operator `RESUME` audit row.** Rejected: pushes operator-audit awareness into the gate (Option-α coupling again) and makes the clear lazy/implicit instead of an explicit write at the moment of resume.
- **Clear the whole `risk_state` row (reset PnL/exposure) on resume.** Rejected: that would erase the day's loss accounting and let an operator resume defeat the daily/weekly loss windows — directly against the conservative-survival invariant. The clear is surgically limited to `is_halted` + `halt_reason`.
