# ADR 0032 — PAPER mode architecture (engine-local paper trading)

**Status:** Accepted (M11a paper-mode addendum — R0.3 design wave); amended 2026-05-27 (post-R4 live-smoke)
**Date:** 2026-05-26 (amended 2026-05-27)
**Milestone:** M11a — Local soak hardening (PAPER course correction)
**Depends on:** ADR 0014 (crash recovery, amended R0.4 for `IBootStateSource`), ADR 0015 (backtest module — seed-locking rationale cited by D3), ADR 0024 (Telegram alerts), ADR 0025 (startup schema-validation gate), ADR 0028 (key-permission assertion port, amended R0.2 for mode-aware allowlist + D9 scope), ADR 0030 (in-engine rate-limit token bucket — explicitly **not** reachable from PAPER per D2), M11a W0.1 (`ExchangeEnvironmentEnum`).
**Consumed by:** M11a R1 (DEMO strip), R2a–R2d (engine implementation), R3 (adversarial QA), R4 (reviewer + scribe), M11a W4 (soak), M11b (cloud go-live gate).
**Replaces:** the `DEMO = Binance demo trading` design from the original M11a W1.1 wording, which rested on the false premise that Binance USDT-M Futures hosts a paper-trading endpoint separate from the testnet alias.

## 1. Context

### 1.1 The course correction

M11a W1's first review round surfaced a blocker: ccxt 4.5.x's
`enableDemoTrading(true)` swaps `urls.api` to a `urls.demo` block whose
host (`demo-fapi.binance.com`) is an **alias of the futures testnet
host** (`testnet.binancefuture.com`). The block exposes only
`fapi/dapi/v1/public/private` keys — no `sapi*` keys —
so any boot that calls `sapiGetAccountApiRestrictions` (ADR 0028)
throws `fetch_error` and the engine exits. Investigation against the
Binance developer docs and the Binance dev forum confirmed: **there is
no separate paper-trading endpoint for USDT-M Futures.** ccxt's
`enableDemoTrading()` is a Futures-side rename of testnet, not a
distinct mode.

The original design treated `DEMO` as "Binance-hosted live-data paper
trading." That construct does not exist. This ADR replaces it with an
**engine-local PAPER mode**: live market data, locally simulated fills,
locally simulated account state.

### 1.2 What PAPER is and is not (invariant)

**PAPER validates strategy / risk / operational behaviour against live
market data. PAPER does not validate live exchange execution semantics.**

PAPER does **not** test: Binance order acceptance, rejections, partial
fills, cancel semantics, protective-order behaviour at the matching
engine, rate-limit-ban responses against real orders, or any other
property of the exchange's order lifecycle. Those still require TESTNET
drills (see §4 below).

A successful PAPER soak is a **necessary but not sufficient** condition
for M11b. Real-money go-live requires both PAPER's
statistical/operational evidence **and** TESTNET's exchange-contract
evidence.

### 1.3 What this ADR locks

- The `PaperModeModule` component set and its boundaries with the rest
  of the engine (§2).
- D1–D17, the seventeen locked architectural decisions feeding the
  M11a R0–R4 dispatch (§3). Anchor IDs `D1`…`D17` are preserved so
  cross-references from other ADRs, the soak plan, and the dev/QA
  cycle continue to resolve after the addendum file is merged and
  deleted at R4.2.
- The DB schema set for the PAPER state machine (§3 D16/D17) and the
  HMAC-chained audit primitives that protect it.
- The TESTNET pre-M11b drill requirement (§4) — PAPER and TESTNET are
  complementary gates, both required.

## 2. Decision — `PaperModeModule`

`PaperModeModule` is a NestJS module loaded **only when
`EXCHANGE_ENV === PAPER`**. The module binds:

| Provider | Role | Implements | Notes |
|---|---|---|---|
| `PaperExecutionClient` | Intercepts order intents and routes them to the local fill simulator | `IExecutionClient` (D2) | **Must not import `RateLimitPolicyService`** — compile-time split per D2; PAPER never reaches the token-bucket policy because no order leaves the process |
| `PaperFillSimulator` | Deterministic fill resolution for paper orders | (engine-internal) | Wraps `StreamingFillAdapter` (D15) over the shared `FillSimulatorCore` |
| `PaperAccountStateService` | In-memory + persisted-projection paper account state | (engine-internal) | Atomic three-table writes per D16 |
| `PaperAccountStateSource` | Account-state port implementation for PAPER | `IAccountStateSource` (D14) | Bound module-wide; the live `ExchangeAccountStateSource` is not loaded under PAPER |
| `PaperReconciliationAdapter` | Drift detection between in-memory service and persisted projection | (engine-internal) | Inherits M6 W4b triggers; drift = CRITICAL (D12) |
| `PaperExchangeNullityProbe` | Defence-in-depth: asserts the live exchange holds no engine-attributed positions/orders for the PAPER key | (engine-internal) | Calls live `IExchangeClient` on a whitelisted seam (D14 exception list); 2-call probe per D13 |
| `PaperFundingAccrualService` | Applies live funding rates to simulated positions at Binance's funding timestamp | (engine-internal) | D4 sign convention; magnitude-bound = warn-and-apply, not reject |
| `PaperBootStateSource` | Phase-1 crash-recovery state source | `IBootStateSource` (ADR 0014 R0.4 amendment) | Reads `paper_account_state` + `paper_account_state_history` + `paper_account_snapshots` |

**Compile-time invariants (D2):**

- `PaperExecutionClient` **does not import** the rate-limit module — a
  build error fires if an engineer ever wires the two. PAPER orders
  never reach the token bucket because they never leave the process.
- `PaperAccountStateService` and `PaperAccountStateSource` **do not
  import any ccxt module**. The only PAPER providers permitted to
  reach ccxt are `PaperExchangeNullityProbe` (D13) and
  `KeyPermissionAssertionService` (boot-time `/sapi` per ADR 0028).
- A dependency-direction lint enforces that `@bot/shared/fill-simulator/`
  has zero dependencies on `apps/engine/` (D15 placement).

**Runtime invariants (D14):**

- A capability-tagged `AsyncLocalStorage` proxy on the whitelisted
  account-state methods rejects any call that arrives without the
  matching tag in the active context with
  `UnauthorizedLiveAccountStateCallException`. This catches the
  `ModuleRef.get(IExchangeClient)` / `forwardRef` escape hatch the
  static module-graph walk cannot see.
- An ESLint CI gate bans `ModuleRef.get(IExchangeClient)`,
  `@Inject('IExchangeClient')`, and `injector.get(IExchangeClient)`
  outside `KeyPermissionAssertionService` and
  `PaperExchangeNullityProbe`.

## 3. Locked decisions D1–D17

### D1 — `paper_account_state` is a dedicated table

The `mode` discriminator on `positions` alternative is rejected.
Reasons:
- PAPER retention follows a different policy from live positions.
- Crash recovery's phase-1 reader (ADR 0014 §2 R0.4 amendment) is
  simpler with a dedicated table.
- No risk of a PAPER position being read by a LIVE-mode read-API query.
- `paper_account_state` writes are restricted to the engine DB role;
  the read-API role gets `SELECT` only.

### D2 — `IExecutionClient` surface (frozen — order commands only)

`IExecutionClient` is **order-command-only**. Methods:
- `placeOrder(intent: IOrderIntent): Promise<IOrder>`
- `cancelOrder(symbol: string, id: string): Promise<void>`
- `cancelAllOrdersForSymbol(symbol: string): Promise<void>`
- `fetchOrderStatus(symbol: string, id: string): Promise<IOrder>`
- `fetchOpenOrders(symbol?: string): Promise<IOrder[]>` (kept here
  because the engine treats it as part of the order-lifecycle surface
  — pair with cancel/status)

Two implementations:
- `CcxtExecutionClient` (LIVE / TESTNET) — delegates to ccxt.
- `PaperExecutionClient` (PAPER) — delegates to `PaperFillSimulator`.

**Account-state reads (balance, positions, funding history) are NOT on
`IExecutionClient`.** They live on `IAccountStateSource` per D14.

**Compile-time split:** `PaperExecutionClient` does **not** import the
`RateLimitPolicyService` module (an accidental rate-limit call from
PAPER is a build-time error, not a runtime assertion). Same compile-
time rule extends to `PaperAccountStateSource` — it does not import
any ccxt module.

### D3 — `PaperFillSimulator` determinism

Per-order PRNG seed schema (stateless derivation):

```
seed_master  = HKDF(bootstrap_secret, info='paper_simulator_seed v1')
order_seed   = HMAC-SHA256(seed_master, event_id || symbol || order_intent_id || version_namespace)
```

`seed_master` is **never persisted**. It is re-derived at every boot
from the bootstrap secret via HKDF. `order_seed` for any specific
order is recomputed from the persisted decision row at any time. No
long-lived secret-equivalent material lives in the database. (Cites
ADR 0015 §"Seed locking" for the original deterministic-PRNG
rationale; PAPER reuses the same primitive, scoped to a different
salt-info pair.)

**Idempotency ledger, not an event cursor.** A single market event can
produce multiple order intents across active (v1 PAPER) and shadow
(v2/v3) versions; event-level cursoring would collide. The
`paper_simulator_idempotency` table is keyed by
`(event_id, order_intent_id, version_namespace)` and records the
`simulated_fill_id` produced. On restart the simulator looks up by key
before rolling; if a fill already exists for the key, it is returned
verbatim (numerically equal to pre-crash per D15's whitelisted
tolerance).

**Retention floor:** the idempotency ledger retains for
**soak_duration + 30 days**, identical to `paper_account_state`. A
SIGKILL replay after GC'd ledger rows would silently break replay
determinism otherwise.

`paper_account_state_meta` stores only **non-secret derived
metadata**: seed version label, HKDF info-string version, simulator
config hash, soak start timestamp, `soak_start_id`, and
`bootstrap_at_start_fingerprint`. No secret material.

**Configuration provenance.** Simulator parameters (tier slippage
table, missed-fill probability, intra-bar stop rules) are sourced
**only** from the M7 configuration committed to version control. R3.1
asserts the simulator refuses to start if its config file hash differs
from the M7 commit-pinned hash. Defence against an operator tuning
the simulator to flatter v1.

### D4 — Funding ordering and math

`PaperFundingAccrualService` applies live funding rates to
`PaperAccountStateService` positions at the **Binance-published
funding timestamp**, not local processing time.

**Sign convention (account-PnL form, operator-intuition: longs pay
shorts when funding rate is positive):**

```
funding_pnl = -position_notional × funding_rate × side_sign
  where side_sign(LONG)  = +1
        side_sign(SHORT) = -1
```

- For `rate > 0`: long → `funding_pnl < 0` (long pays);
  short → `funding_pnl > 0` (short receives).
- For `rate < 0`: long receives, short pays.

`position_notional` is the position size marked to market at the
funding timestamp using the live mark price. A position accrues
funding iff `position.openedAt ≤ funding.ts ≤ position.closedAt` —
local clock is irrelevant.

**Data sources:**
- Funding rate values: Binance REST `/fapi/v1/fundingRate` at the
  moment of accrual.
- Next-funding metadata visibility: Binance mark-price WebSocket
  stream (`!markPrice@arr` / `<symbol>@markPrice`).

**Magnitude bound is a warning, not a hard reject.** Funding-rate
ingest passes the same M1 validator chain (sanity bounds, monotonic
timestamps, signed-source check). Binance's per-funding-window
absolute cap (per current Binance docs) is enforced as:
- Apply the rate to the position.
- Write an audit row.
- Emit a CRITICAL Telegram alert.

A simulator that silently zeroes funding during a stress regime
flatters expectancy at exactly the moment funding cost matters most
for shorts. Operator decides response, not the simulator.

**Funding / PnL ordering inside a tick batch** is pinned:
`apply_funding → recompute_unrealised_pnl → evaluate_drawdown_abort`.

**Funding force-flushes the MTM throttle** (D5). A funding event
arriving mid-throttle-window would otherwise wait up to 100 ms before
being applied — and a coincident adverse mark could delay the abort
by the same window. Funding arrival is a throttle-exemption trigger:
immediate `apply_funding + recompute_unrealised + evaluate_abort`,
regardless of throttle state.

**Timing approximation noted.** Applying funding at local receipt of
the Binance funding timestamp may have sub-second desync with
Binance's own snapshot. Acceptable for paper trading; documented here
as a known minor divergence.

### D5 — Mark-to-market cadence + drawdown denominator

`PaperAccountStateService` unrealised PnL is recomputed on price
updates for held symbols at a **throttled cadence**. Binance mark-
price ticks fire multiple times per second under volatility; running
MTM + drawdown abort on every raw tick would saturate the Node.js
event loop and delay critical order-execution paths.

**Throttle rule:**
- Coalesce updates per held symbol to at most **once per 100 ms**, OR
  immediately when the cumulative price move since the last MTM
  exceeds one tick size (whichever comes first). The 100 ms ceiling
  protects the event loop; the tick-size early-trip protects abort-
  threshold latency during fast moves.
- Inside the throttle window, the latest tick is retained and applied
  when the throttle fires (no dropped data, only deferred work).
- Funding arrival force-flushes the throttle (D4).

Restricted-profile soak has `max_open_positions: 1`, so total MTM
cost is bounded. If the profile relaxes, the throttle parameters must
be re-validated.

**Drawdown denominator pinned to running peak equity:**

```
drawdown(t)    = (peak_equity(t) - equity(t)) / peak_equity(t)
peak_equity(t) = max(equity(τ)) for τ ∈ [soak_start, t]
peak_equity(0) = PAPER_STARTING_EQUITY_USDT   // cold start; not the first MTM tick
```

The cold-start pin prevents an adverse first tick from lowering
`peak_equity` below the starting value, which would delay the abort
threshold's first meaningful trigger. With D11's $500 starting equity
and 0.25% risk per trade, the peak-equity denominator means the abort
fires on a true regime break, not on a routine losing streak from a
high-water mark. `peak_equity` is derived from audited
`paper_account_snapshots` (D16) — the in-memory peak is computed at
evaluation time, not mutated in place.

### D6 — Mode-switch predicate + integrity

Predicate: **persisted last-known boot mode ≠ current `EXCHANGE_ENV`**
→ abort with a clear error. Recorded in a new `boot_mode_history`
table written **at successful boot** (not at shutdown — crash-safety):

```
boot_mode_history (
  id              uuid PK,
  seq             BIGSERIAL NOT NULL UNIQUE,  -- monotonic ordering independent of clock
  booted_at       timestamptz NOT NULL DEFAULT now(),
  row_kind        text NOT NULL,              -- 'BOOT' | 'TRANSITION' | 'KEY_ROTATION_WITNESS' | 'CHAIN_RESTORE' | 'MACHINE_REPURPOSE_WIPE'
  exchange_env    text NOT NULL,              -- env in effect AFTER this row applies
  from_env        text,                       -- src env (only set on TRANSITION rows; NULL otherwise)
  to_env          text,                       -- dst env (only set on TRANSITION rows; NULL otherwise)
  prev_row_hash   bytea,                      -- HMAC over prev row's signed payload (incl seq)
  this_row_hmac   bytea NOT NULL              -- HMAC over this row's signed payload (incl seq)
)
```

**HMAC computation — implementation detail (amended post-smoke):** the
append operation must use raw `INSERT...RETURNING` to atomically capture the
DB-assigned `seq` and `booted_at`/`rotated_at` columns within a single statement.
`INSERT...RETURNING` allows the HMAC to be computed from the same row that is
inserted, binding the final `seq` value into the hash in the same transaction.
Do **NOT** use TypeORM's `manager.save()` two-phase write (INSERT placeholder
→ UPDATE with computed value), as `manager.save()` does not refresh BIGSERIAL
or `DEFAULT` columns from the `RETURNING` clause — causing the write-time
HMAC to be computed with `seq: undefined` while read-time uses the actual DB
sequence value, breaking every subsequent verification.

`exchange_env` is always the env in force **after** the row applies.
On TRANSITION rows, the `(from_env, to_env)` pair carries the
directional intent. The signed payload includes all three of
`exchange_env`, `from_env`, `to_env` so a forged row cannot
misrepresent the transition. `seq BIGSERIAL` is included so clock-
skew cannot let an attacker insert a row appearing "earlier" than tip
by manipulating `booted_at`.

**HMAC subkey derivation.** The chain HMAC key is **not** the raw
bootstrap secret. Per-purpose subkeys via HKDF:
```
boot_mode_history_key  = HKDF(bootstrap_secret, info='boot_mode_history v1')
paper_state_audit_key  = HKDF(bootstrap_secret, info='paper_state_audit v1')
```
A leak of the `boot_mode_history` key does not compromise
`paper_state_audit` or login HMAC, and vice versa.

**Threat model — tamper-evidence, not tamper-proofing.** The HMAC
chains catch accidental corruption and unauthorized DB-only
modification by a process that does not have the host's bootstrap
secret. They do **not** protect against an attacker who gains host
shell access — that attacker can read the bootstrap secret from
`.env`, re-derive sub-keys, and forge any history. Legitimate DB
restores from backups also break the chain.

Mitigations within M11a scope:
- Append each chain's tip hash to the **encrypted offsite backup**
  (W3.9) and a local **append-only operator log** at every successful
  boot. An attacker who tampers with the live DB cannot retroactively
  edit those tips.
- A daily operator-signed work-log entry records the tip hash.
- After a sanctioned DB restore, the runbook documents a
  `CHAIN_RESTORE` row appended under the new sub-key, witnessed by
  the most recent external tip hash. The chain is not "fixed" — it is
  explicitly reset-with-witness.

**Boot sequence (executable ordering):**

```
1. Load config (including EXCHANGE_ENV).
2. Verify boot_mode_history chain integrity (HMAC walk from row 0).
3. If chain is broken: ABORT (security-critical; runbook recovery only).
4. Read the chain tip's exchange_env.
5. If tip.exchange_env === EXCHANGE_ENV:
     a. Begin transaction.
     b. Append a BOOT row (kind='BOOT', exchange_env=current).
     c. Commit. Continue startup.
6. Else (mode mismatch):
     a. Check D7 transition matrix for (tip.exchange_env -> EXCHANGE_ENV).
     b. If transition is rejected: ABORT.
     c. Verify the transition token file matches the operator-baked hash.
     d. If token invalid: ABORT (no chain mutation).
     e. Begin transaction.
     f. Append a TRANSITION_<FROM>_TO_<TO> row (with src/dst per D7).
     g. Append a BOOT row.
     h. Append a boot_mode_chain_rotations row with the transition_token_hash.
     i. Commit (single transaction; partial states are structurally impossible).
     j. Continue startup.
```

**Bootstrap-secret rotation interaction (W1.8).** Rotation produces
fresh sub-keys for both chains. The pre-rotation chain tip is
witnessed by appending a typed `KEY_ROTATION_WITNESS` row referencing
the old tip hash, signed with the **new** sub-key.

Phase-1 crash recovery (ADR 0014 §2 R0.4) verifies the chain and
refuses to proceed if it is broken or if the last row's
`exchange_env` differs from the current `EXCHANGE_ENV`. Non-empty
`paper_account_state` is a **secondary** defence inside the mode-
switch branch, not the primary predicate.

**Mid-soak chain break action.** A chain-integrity failure detected
during the soak (e.g. by the soak-exit-gate evaluator verifying the
chain before reading state) is CRITICAL: alert, halt new decision
routing, **invalidate the soak result**. Mid-soak chain breaks never
silently downgrade — they disqualify the run.

### D7 — Mode-transition matrix (append-only, never truncate the chain)

Every legitimate transition is recorded as an **append-only typed
row** (e.g. `TRANSITION_TESTNET_TO_PAPER`) referencing the prior
tip's HMAC, signed under the appropriate sub-key. The chain is
**never truncated**. Rotation events themselves are persisted in a
separate `boot_mode_chain_rotations` table (also HMAC-chained) so a
forensic auditor can distinguish a sanctioned transition from a
compromise.

```
boot_mode_chain_rotations (
  id              uuid PK,
  seq             BIGSERIAL NOT NULL UNIQUE,
  rotated_at      timestamptz NOT NULL DEFAULT now(),
  from_env        text NOT NULL,
  to_env          text NOT NULL,
  pre_tip_hash    bytea NOT NULL,           -- HMAC of the boot_mode_history tip before transition
  transition_token_hash bytea NOT NULL,     -- sha256 of the operator-provided transition token
  prev_row_hash   bytea,
  this_row_hmac   bytea NOT NULL
)
```

Each transition requires a **separate transition token** (analogous
to `LIVE_GO_AHEAD_TOKEN`): a file whose hash is baked into config
and matched at boot. The transition is single-use — once a
`TRANSITION_*` row is written, the same token cannot drive another
transition without rotating.

| From | To | Procedure |
|------|----|-----------|
| TESTNET | PAPER | Confirm `paper_account_state` empty; operator provides `TESTNET_TO_PAPER_TOKEN_FILE` (hash baked at build); boot appends `TRANSITION_TESTNET_TO_PAPER` row + records rotation; proceeds. |
| TESTNET | LIVE | Operator provides both `TESTNET_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; standard LIVE allowlist applies; CRITICAL alert. |
| PAPER | TESTNET | Reject unless `paper_account_state` is empty; operator provides `PAPER_TO_TESTNET_TOKEN_FILE`; runbook documents the paper-position-cleanup step. |
| PAPER | LIVE | Reject unless `paper_account_state` empty; operator provides `PAPER_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; CRITICAL Telegram alert at boot. |
| LIVE | PAPER | Reject unless no open live positions; operator provides `LIVE_TO_PAPER_TOKEN_FILE` (separate from `LIVE_GO_AHEAD`); CRITICAL alert; never re-uses any prior token. **Predicate routing fix:** at LIVE→PAPER boot, `EXCHANGE_ENV` is already PAPER so the bound `IAccountStateSource` is `PaperAccountStateSource` (returns empty trivially). The "no open live positions" predicate **must use a transition-only `ExchangeAccountStateSource(prior_env_credentials)`** that reads the live exchange under the prior LIVE key. The transition-time source is bound by the boot sequence (D6 step 6) under a dedicated provider name; the normal port binding is restored after the transition row commits. |
| LIVE | TESTNET | Reject. Operationally: use a separate machine, **or** execute the documented destructive-wipe runbook step that records a `MACHINE_REPURPOSE_WIPE` row before re-init. |

**Undocumented transitions are rejected at boot.**

### D8 — PAPER allowlist & Fallback Profile (LOCKED)

**Outcome:** Fallback Profile is in force (gbt R2-M1 endpoint-accessibility
blocker resolved 2026-05-26). Reason: Binance signed `/fapi` endpoints
(`/fapi/v1/openOrders`, `/fapi/v2/positionRisk`) required by D13's nullity
probe require the `enableFutures` permission; a key with `enableFutures: false`
returns `-2015`. PAPER therefore runs under a **dedicated zero-balance Binance
USDT-M Futures sub-account** with `enableFutures: true`, gated by D13's
extended invariants.

**PAPER Fallback Profile (operative predicate):**

The operative PAPER allowlist requires `enableReading: true` AND
`enableFutures: true` paired with the sub-account zero-state invariants,
plus all other capability flags false:

```ts
isKeyPermissionSnapshotAcceptable(snapshot, nowMs, { mode: 'paper' | 'live' })
  =>
    snapshot.enableReading === true
    && snapshot.enableFutures === (mode === 'live' ? true : false)
    && snapshot.enableSpot === false
    && snapshot.enableWithdrawals === false
    && snapshot.enableInternalTransfer === false
    && snapshot.permitsUniversalTransfer === false
    && snapshot.enableMargin === false
    && snapshot.enableVanillaOptions === false
    && snapshot.enableSubAccountManagement === false
    && snapshot.ipRestrict === true
    && snapshot.ipAllowList.length > 0
    && snapshot.tradingAuthorityExpirationTime !== null
    && snapshot.tradingAuthorityExpirationTime > nowMs
```

Under the Fallback Profile, `mode = 'paper'` reuses the `enableFutures: true`
clause (same as LIVE). The shared predicate in ADR 0028 §2.4 currently maps
`mode = 'paper'` to `enableFutures: false` — a mismatch documented as a known
follow-up to be reconciled in R1 (the shared predicate is not edited here).
D13's runtime invariants provide the safety substitute: zero balance, zero
positions, zero open orders, no transfer permissions, IP-restrict,
non-expired trading authority.

**Sub-account invariants (Fallback Profile):**

- API key on a dedicated Binance sub-account whose sole purpose is to
  host the PAPER probe key. The main account is never reachable via
  this key.
- Allowlist enforced: `{enableReading: true, enableFutures: true}` on
  this key — plus **the engine refuses to boot if any of the following
  is true**:
  - Sub-account balance ≠ 0 at boot or at any reconciliation tick.
  - Sub-account has any open position at boot or at any tick.
  - Sub-account has any open order at boot or at any tick.
  - Key has any transfer permission (`enableInternalTransfer`,
    `permitsUniversalTransfer`) — must remain false.
  - IP allow-list is empty.
  - Trading authority is expired or null.
- D13 probe asserts (a) zero balance, (b) zero positions, (c) zero open
  orders every cycle. Any non-zero → CRITICAL halt + invalidate soak.
- Operator runbook documents the sub-account creation procedure with
  no-balance and no-transfer invariants pinned.

**Sub-account response-shape constraint (amended post-smoke):** Binance's
`/sapi/v1/account/apiRestrictions` response **omits fields not applicable to
sub-account keys** (`enableSubAccountManagement`, `enableWithdrawals`,
`enableInternalTransfer`, `enableMargin`, `enableVanillaOptions`,
`permitsUniversalTransfer`, `tradingAuthorityExpirationTime`). The allowlist
predicate and the mapper (in ADR 0028 §2.2) have been adjusted to reflect this
divergence: fields omitted for sub-accounts now default to `false` (structurally
Binance prevents sub-accounts from having these permissions). This makes the
predicate passable for sub-account keys. However, **the predicate still
structurally cannot validate the safety of a master-account key by looking at
a sub-account response shape** — if Binance ever changes master-account
responses to omit a field that the predicate expects, the predicate would
silently pass an unsafe key in LIVE mode. The **Pre-M11b validation** deferred
item requires verifying LIVE master-account response shape against Binance
docs before go-live. Confirmation: **PAPER's safety teeth come from D13's
runtime nullity probe, not the boot-time predicate alone.** The boot predicate
is structurally weaker for sub-account keys than the original design implied.

**Known mismatch in R1 reconciliation:** The shared predicate
`isKeyPermissionSnapshotAcceptable` in `packages/shared/` was drafted with
`mode = 'paper' → enableFutures: false`. The Fallback Profile requires
`enableFutures: true` for endpoint accessibility. R1 will reconcile this by
either (a) extending the shared predicate to express the fallback via a
nested option (e.g. `{ mode: 'paper', profile: 'fallback' }`), or
(b) accepting that the predicate's `mode = 'paper'` clause is technically
violated by the Fallback Profile's operation and relying solely on D13's
runtime invariants. Either path lands in R1.4 with architect input.

### D9 — `LIVE_GO_AHEAD_TOKEN` is LIVE-only

PAPER does **not** require the go-ahead token. The read-only-only
assertion (D8) is PAPER's safety teeth. ADR 0028 §2.5 records this
explicitly so a future reader does not re-introduce a PAPER token
gate by analogy.

### D10 — Closed-trade counting (full enumeration)

| `closeReason` | Counts toward ≥80-trade floor? | Notes |
|--------------|-------------------------------|-------|
| `sl` | Yes | Stop-loss intra-bar fill. |
| `tp` | Yes | Take-profit intra-bar fill. |
| `intra_bar_stop` | Yes | Generic intra-bar protective stop. |
| `force_close` | No (excluded) | M7 end-of-window. Surfaced in a separate evaluator panel for visibility. |
| Operator drain (halt + close) | No (excluded) | Operator-initiated close during incident or transition. |
| Reconciliation-forced close | No (excluded) | Engine-internal cleanup. |

Additionally:
- A simulator decision with `missed: true` does **not** consume the
  restricted profile's `max_trades_per_day: 3` slot. Missed fills are
  observability only — they do not crowd out future decisions in the
  same risk-day.
- The soak evaluator emits an "excluded fills" report alongside the
  primary trade count so excluded-but-real PnL is auditable.

### D11 — PAPER starting equity

PAPER starting equity defaults to **$500** to match the live
restricted profile's lower bound. Surfaced as
`PAPER_STARTING_EQUITY_USDT` env var (keeps trust-posture-relevant
magic numbers out of code), validated by Zod schema with `$500` as
the default. A 15% adverse mark from peak equity triggers the abort
within one MTM-throttle window per D5.

### D12 — Reconciliation in PAPER

`PaperReconciliationAdapter` inherits the **same triggers** as M6
W4b live reconciliation (event-driven on position events; periodic
poll at the same cadence) — source swapped from exchange to
`PaperAccountStateService`. Drift event types are reused from
`@bot/shared` (no new event shapes).

**Drift action in PAPER is more severe than in LIVE.** In LIVE,
drift can have an exchange-clock cause; in PAPER, there is no
exchange to blame, so any drift between in-memory
`PaperAccountStateService` and the persisted `paper_account_state`
rows is a production bug. Action: CRITICAL Telegram alert (not
WARNING), audit row, halt new decision routing, await operator
intervention. The existing M6 W4b drift handler gains a `mode`-aware
severity rule.

### D13 — `PaperExchangeNullityProbe` (defence in depth)

Independent of `PaperExecutionClient`'s internal invariants, the
reconciliation cycle calls **both** `fetchOpenOrders()` **and**
`fetchPositions()` against the live exchange and asserts both are
empty (filtered as described below). Two readers because
`fetchOpenOrders` only sees resting orders — an accidental market-
order or marketable-IOC fill closes immediately and leaves a
position with no open order trace. The probe must catch that case
too.

**Dedicated PAPER sub-account, strongly preferred.** A dedicated
Binance sub-account whose only role is to hold the read-only PAPER
key trivially lets the probe assert **absolute nullity**: zero open
orders AND zero positions across all symbols, without the brittle
client-ID-prefix filter. The runbook makes this the documented
recommended path; the prefix-filtered path is a fallback.

**Capability preflight at PAPER boot.** The probe must not be
allowed to silently become decorative. Before the soak starts:
- The engine performs one `fetchOpenOrders` + one `fetchPositions`
  call against the configured PAPER key.
- Three branches:
  1. **Both succeed and both are empty** → probe is operational;
     soak proceeds.
  2. **Both succeed and a non-empty engine-attributed entry exists**
     → CRITICAL halt before soak starts; runbook says drain the
     account.
  3. **Either call returns 401/403/permission/malformed credential**
     → PAPER startup aborts with a clear error. The probe cannot run
     with this key; either fix the key (per D8 endpoint-accessibility
     verification) or disable PAPER. Soak does **not** start with a
     decorative probe.

**Runtime failure-class taxonomy.** Once the soak is running, probe
responses are classified explicitly:
- `Network / 5xx / timeout` → log and continue for up to 5
  consecutive failures (bounded window). On the 6th consecutive
  failure, emit a WARNING and switch the probe to exponential
  backoff (cap 1/hr) while the soak continues. Binance outage cannot
  halt the soak.
- `401 / 403 / permission / malformed credential` → CRITICAL halt.
  The key changed mid-soak; soak result is invalidated until the new
  key is re-attested per D8.
- `Non-empty engine-attributed response (orders or positions)` →
  CRITICAL halt + audit row. The leak case the probe exists for.

**Cadence + budget.** Probe runs **once per minute** for each of
`fetchOpenOrders` and `fetchPositions`. The cost (2 read calls/min ×
symbol fan-out) is reserved in the W1.4 token-bucket policy before
R1 starts. ADR 0030's constants table is updated.

**Symbol fan-out budget (forward-looking).** If the symbol universe
expands beyond the restricted-profile single-symbol-per-trade
assumption, the per-minute probe cost grows linearly. Before any
future universe expansion, the W1.4 token-bucket policy must be re-
checked against `(2 calls × universe_size + reconciliation cadence
+ funding poller)` — Binance per-IP REQUEST_WEIGHT_1M is the binding
constraint. For M11a's single-position profile this is not load-
bearing; flagged so M11b / scaling waves don't silently break the
budget.

### D14 — `IAccountStateSource` port (full surface, not only orders)

Splitting only `IExecutionClient` is not enough. `fetchBalance`,
`fetchPositions`, `fetchOpenOrders`, and funding-history reads stay
on `IExchangeClient` after D2 — but the engine has existing callers
that hit those methods directly:
- `AccountSnapshotWriter` → `fetchBalance`.
- `ReconciliationService` → `fetchPositions` + `fetchOpenOrders`.
- Funding accrual paths → funding-history surfaces.

If those callers reach the live exchange in PAPER, the "engine-
local" property is violated (and the soak measures a different
account state than PAPER is supposed to be simulating).

**Decision: introduce `IAccountStateSource`** as a second port:

```
IAccountStateSource {
  fetchBalance(): Promise<Balance>
  fetchPositions(symbol?): Promise<Position[]>
  fetchOpenOrders(symbol?): Promise<Order[]>
  fetchFundingHistory(symbol, since): Promise<Funding[]>
}
```

Two implementations:
- `ExchangeAccountStateSource` (LIVE / TESTNET) — delegates to ccxt.
- `PaperAccountStateSource` (PAPER) — backed by
  `PaperAccountStateService`.

`AccountSnapshotWriter`, reconciliation phase 1, funding cashflow
readers, and the read-API account projections are bound to **this
port**, not to `IExchangeClient`. Module-level provider dispatch on
`exchange_env`.

**The exception list** (rows the LIVE ccxt account-state methods are
still allowed to be called from in PAPER) is exactly two:
1. `KeyPermissionAssertionService` (boot-time `/sapi` calls).
2. `PaperExchangeNullityProbe` (D13).

**Module-graph test (static).** Walks the Nest DI graph from
strategy → risk → execution loop and fails if any provider reachable
from the live decision path can inject `IExchangeClient`'s account-
state methods. Only the two whitelisted providers above may have
that reach.

**Runtime guard, not only static graph.** Nest's
`ModuleRef.get(IExchangeClient)`, `Reflector`, `useFactory(injector)`,
and `forwardRef` resolve providers at runtime in a way the static-
graph walk cannot see. Pair the static check with:

1. **Capability-tagged proxy** on the two whitelisted methods
   (`KeyPermissionAssertionService.fetchKeyPermissions`,
   `PaperExchangeNullityProbe.fetchOpenOrders` /
   `PaperExchangeNullityProbe.fetchPositions`). The proxy uses
   `AsyncLocalStorage` to tag the call-stack origin at the
   whitelisted entry point. Any call to ccxt account-state methods
   on the live key without the matching tag in the active context
   throws `UnauthorizedLiveAccountStateCallException`.
2. **ESLint rule** banning the strings
   `ModuleRef.get(IExchangeClient)`, `@Inject('IExchangeClient')`,
   and `injector.get(IExchangeClient)` outside the whitelisted file
   set (`/auth/KeyPermissionAssertionService.ts` and
   `/paper/PaperExchangeNullityProbe.ts`). CI gate, not just
   convention.

### D15 — `PaperFillSimulator` is **not** `BacktestRunnerService` reuse

M7's `BacktestRunnerService` is a **historical replay** engine. Its
fill model expects to see the full bar's path (high, low, close,
intra-bar ticks) **before** deciding whether an IOC filled, an SL
was hit, or a TP was hit intra-bar. PAPER runs in **live event-
time** — at decision time the future tick stream does not yet exist.
Two options, both wrong:

- Wait for future ticks before deciding → PAPER is no longer
  simulating live execution; the simulator decides retrospectively
  after the bar closes.
- Decide immediately from the current snapshot → no longer the same
  algorithm as M7's replay path; the soak measures a different model
  than the backtest.

**Decision: extract a pure shared fill library, two adapters.**

**Placement:** `FillSimulatorCore` lives in **`packages/shared/`**
because both `@bot/engine` (PAPER's `StreamingFillAdapter` + M7's
`HistoricalFillAdapter`) consume it from the same boundary. The core
is **dependency-light**: pure functions, no TypeORM entities, no
Nest providers, no engine imports. Money helpers (decimal
arithmetic, tier-size lookups) that the core needs are duplicated
into the shared package as pure utilities if they currently live
engine-side. A dependency-direction lint fails the build if a shared
module imports from `apps/engine/`.

```
@bot/shared/fill-simulator/
  FillSimulatorCore       // pure functions: applyFill(snapshot, intent, seed) → ISimulatedFill
                          // applyIntraBarStop(snapshot, position, seed)       → ISimulatedFill | null

  HistoricalFillAdapter   // backtest: replay with complete tick paths
                          // wraps Core; pre-resolved future ticks available

  StreamingFillAdapter    // PAPER: live event-time; subscribes to live tick
                          // stream; reacts to ticks as they arrive (no
                          // setTimeout scheduling — see SL/TP rule below)
                          // honours intra-bar semantics by event ordering
```

`BacktestRunnerService` is rewritten to delegate its fill logic to
`FillSimulatorCore` via `HistoricalFillAdapter`. `PaperFillSimulator`
delegates to `FillSimulatorCore` via `StreamingFillAdapter`. The two
adapters have different inputs and different scheduling, but
identical `applyFill` semantics for the same snapshot.

**SL/TP evaluation is event-driven, never timer-driven.** The
`StreamingFillAdapter` evaluates intra-bar SL/TP triggers on **tick
arrival** from the live WS feed. A `setTimeout` against wall clock
would drift relative to Binance's tick cadence under event-loop
load, producing non-deterministic intra-bar timing. SL evaluation
fires within one tick of the triggering price (not within one wall-
clock interval).

**Causality test (mandatory):** at time `t`, the streaming adapter
cannot read tick / book-snapshot data with timestamp `> t`. R3.1
asserts this by giving the adapter a clock-skewed market snapshot
fixture and asserting the produced `ISimulatedFill` does not depend
on the future-tick portion.

**Equivalence is numerical, not byte-for-byte.** Decimal
serialization, map-iteration order, and floating-point summation
order can produce non-byte-identical output for numerically
equivalent results. The equivalence test asserts per-field numerical
equality on `simulated_fill` rows with documented tolerance for
fields where order-dependent serialization is unavoidable
(`slippageComponents` sub-field ordering, JSON key ordering). The
whitelist is in the test fixture, not hidden in the implementation.
This ADR references M7's backtest-equivalence test as a permanent
regression guard.

**Backtest equivalence rerun (R0.5).** The M7 backtest is rerun
against the extracted core as the R0.5 validation step — any
divergence between pre-extraction and post-extraction backtest
output is a blocker.

### D16 — Paper-state source-of-truth (per datum)

PAPER is fully separate from live position tables. Each datum has
exactly one source-of-truth:

| Datum | Source-of-truth in PAPER |
|-------|--------------------------|
| Open paper-position state | `paper_account_state` |
| Closed paper-trade PnL | `paper_account_state_history` (closed-trade ledger; sibling table) |
| Fees / funding / slippage | columns on `paper_account_state_history` |
| Risk-day trade count | computed from `paper_account_state_history.closed_at` per D10 |
| Account equity curve | snapshot rows in `paper_account_snapshots` (sibling of `account_snapshots`) |
| Read-API dashboard display | read from the four paper tables (separate read-API filter `mode=paper`) |
| Soak-exit evaluator input | read from `paper_account_state_history` exclusively |

The live tables `positions`, `transactions`, `risk_state`,
`account_snapshots` are **never written** in PAPER. They are
**read** only during TESTNET drills and LIVE.

D12 reconciliation is reworded accordingly: `PaperReconciliationAdapter`
reconciles `PaperAccountStateService` against `paper_account_state`
rows (the in-memory service vs the persisted projection) — **not**
against `IPositionRepository`. Drift between in-memory and persisted
state catches the engine-internal bug class D12 was designed to
catch, without mixing the source-of-truth chains.

**Atomicity guarantee.** Every paper fill writes to
`paper_account_state` (current state mutation) +
`paper_account_state_history` (append the closed-trade record if
applicable) + `paper_state_audit` (HMAC-chained audit) in **one
transaction**. A crash between writes leaves the engine state
structurally consistent — not "consistent after later
reconciliation." The audit row's signed payload **includes the
post-allocation `seq`** — implemented via a CTE / RETURNING-clause
so the assigned `seq` value is bound into the HMAC within the same
SQL statement. This prevents a crash-replay window where the chain
tip and the row don't agree on `seq`.

**Unrealised PnL is derived, not state.** The `paper_account_state`
table holds only state that is genuinely position-defining (entry
price, size, side, leverage, opened-at, client_order_id, …). MTM
evaluations for drawdown-abort and read-API projection compute:

```
unrealised_pnl = (mark_price - entry_price) × size × side_sign
equity         = realised_pnl + sum(unrealised_pnl per open position) + funding_accrued
peak_equity    = max over the soak window of equity readings, persisted in
                 paper_account_snapshots (which IS audited)
```

`paper_account_snapshots` is a sibling of `account_snapshots`,
written at coarser cadence (every minute + on every position
event), goes through the three-table atomic-write path, and is
itself audit-chained. Drawdown abort reads from a derived
`unrealised_pnl` plus the audited `peak_equity` snapshot — tampering
either input (`mark_price` from WS or the audited snapshot) is
detectable.

This drops the MTM-throttle requirement for atomicity (the throttle
in D5 still applies to evaluation cadence — but evaluation does not
mutate audited state).

**Retention floor for paper tables (W3.10):**
- `paper_account_state`: retain soak duration + 30 days.
- `paper_account_state_history`: retain soak duration + 30 days.
- `paper_state_audit`: **archive, not prune**, for the soak window.
- `paper_account_state_meta`: retain at least through M11b decision.
- `paper_account_snapshots`: soak duration + 30 days.
- `paper_simulator_idempotency`: retain soak duration + 30 days
  (D3 floor).
- `boot_mode_history` + `boot_mode_chain_rotations`: retain forever
  (security audit trail across milestones).

### D17 — Shadow randomness: independence + paired common-random-numbers

There is a contradiction between:
- D3 (v1 and v2/v3 use independent order-intent namespaces so they
  do not receive correlated rolls), and
- the lowFidelity argument that v1 vs shadow v2/v3 is load-bearing
  because the shared simulator and same noise let bias cancel.

These pull in opposite directions for the comparison test.

**Decision: separate active execution from offline comparison.**

- **Active PAPER execution** uses deterministic, idempotent per-
  version order seeds (`order_seed = HMAC(seed_master, event_id ||
  symbol || order_intent_id || version_namespace)`). Each version's
  actual decisions are scored independently — that is the realistic
  counterfactual.
- **Offline same-event strategy comparison** uses a **pre-registered
  Common Random Numbers (CRN) scheme** keyed by
  `(event_id, simulator_component, pair_id)`.

**Per-soak CRN root.** The CRN root is **not** derived from the
live bootstrap secret. W1.8 rotates the bootstrap secret during the
soak; a CRN tape keyed on the live secret would silently change
derivation mid-soak and break the offline evaluator's ability to
recompute the tape. Instead:

```
soak_start_id      = uuid generated at soak start
bootstrap_at_start = bootstrap_secret captured at soak start (immutable for the soak)
crn_root           = HKDF(bootstrap_at_start, info='paper_crn v1', salt=soak_start_id)
crn_tape[i]        = HMAC(crn_root, event_id_i || simulator_component_i || pair_id_i)
```

`bootstrap_at_start` is **never persisted in plaintext**; only its
fingerprint (e.g. SHA-256 of the secret) goes into the audit row.
The evaluator post-soak re-captures the secret value the operator
names in the runbook and re-derives `crn_root`; mismatch with the
stored fingerprint invalidates the soak.

**Commit-reveal audit-row pattern.** At soak start, write a single
audit row to `paper_state_audit` under a dedicated subkey
(`paper_crn_audit v1` HKDF info string):

```
crn_commitment = HMAC(crn_root, soak_start_ts
                              || bootstrap_at_start_fingerprint
                              || symbol_universe_hash
                              || pair_list_hash
                              || PAPER_STARTING_EQUITY_USDT)
```

Only the commitment (a single HMAC) goes into the audit row pre-
soak. The CRN tape itself is **not revealed mid-soak** — an operator
with engine-role DB access cannot predict future paired rolls and
time decisions out-of-band. The tape is materialised by the
evaluator post-soak from `crn_root`; the commitment row binds it.

**Tape storage.** The full tape can be megabytes. Store a content
hash (`SHA-256(tape_bytes)`) in the audit row and the tape itself in
a separate `paper_crn_tape` blob table keyed by `soak_start_id`,
written once post-soak by the evaluator (write-once, append-only, no
overwrites).

**Skip-case pairing.** v1 and v2 generally produce different order
intents on the same event: one trades, the other skips, or both
skip. A `pair_id` keyed on `event_id` alone collapses to "same event
→ same roll" only when both strategies trade; otherwise CRN does
not actually pair, and the variance-reduction claim is structurally
false.

**Roll consumption rule.** Per `(event_id, simulator_component)`,
the CRN roll is consumed by **whichever version trades**. If both
trade, they consume the same roll (true pairing). If only one
trades, the roll is consumed by the trader.

**Selectivity bias.** Restricting the paired difference series to
events where **both** versions traded biases the comparison toward
events where both versions were already willing to trade. Skip is
first-class in this bot — a strategy that earns its edge by being
**more selective** would look weaker against one that's less
selective on the trade-vs-trade subset. The soak reports **two
paired cohorts**:

1. **Trade-vs-trade CRN cohort.** Both versions traded; same
   simulator roll; isolates fill-noise differences and pure decision-
   edge conditional on willingness to trade. The variance-reduction
   claim applies here.
2. **Full same-event cohort with skip-handling.** All events where
   at least one version traded. For events where one trades and one
   skips, the skipping version's contribution is `pnl = 0` (no
   trade, no PnL). No CRN pairing on these — independent / no-fill
   roll handling. This cohort captures **selectivity edge** that the
   trade-vs-trade cohort discards.

The "active version beats shadow v2/v3" criterion **requires the
same winner on both cohorts** (mirroring the same-winner rule across
the `lowFidelity`-included / -excluded rankings). If the trade-vs-
trade cohort says v1 wins but the full cohort says v2 wins because
v2's selectivity advantage dominates, the criterion is marked
**inconclusive** — do not promote on the trade-vs-trade subset
alone.

The `lowFidelity`-included and -excluded rankings (ADR 0019
criterion 12) operate on **each** of the two cohorts independently.

**Two evaluator outputs + inconclusive truth table.** The soak-exit
report produces two CIs on `E[v1] − E[v2]`:

1. **Paired CRN CI**: same simulator rolls on the same events;
   variance reduction is real; simulator bias cancels.
2. **Independent-noise robustness CI**: computed from the live PAPER
   + live shadow runs (each version's actual decisions scored under
   independent rolls). Wider, less powerful, but checks the CRN
   didn't smuggle in a spurious winner.

Truth table for the "active version beats shadow v2/v3" criterion:

| Paired CRN CI | Independent-noise CI | Result |
|--------------|---------------------|--------|
| Decisive, v1 wins | Decisive, v1 wins | **Pass.** Same winner; CRN result corroborated. |
| Decisive, v1 wins | Decisive, v2 wins | **Fail.** Contradictory; not safe to promote. |
| Decisive, v1 wins | Inconclusive (straddles zero) | **Inconclusive.** Not a pass on CRN alone — the independent-noise cross-check is the whole point of dual-CI. |
| Inconclusive | Decisive | **Inconclusive.** Same logic mirrored. |
| Both inconclusive | — | **Inconclusive.** Extend or accept exploratory. |

**Mid-soak rotation invariance.** Because `crn_root` is keyed on
`bootstrap_at_start` (captured at soak start), W1.8 mid-soak
rotation does **not** invalidate the CRN tape. The bootstrap secret
rotates for ongoing HMAC chains (`boot_mode_history`,
`paper_state_audit`) but the CRN derivation key is frozen. R3.1
asserts "soak-start CRN survives mid-soak bootstrap-secret
rotation."

## 4. TESTNET pre-M11b drill (codified requirement)

PAPER validates strategy / risk / operational behaviour on live
market data, but **never** exercises Binance's order-placement
contract — order acceptance, rejection, partial fills, cancel
semantics, protective-order behaviour at the matching engine. Those
still need **Binance Futures testnet** to drill.

TESTNET is a separate **required gate** before M11b, run after
PAPER soak success. Scope:

- Place / cancel / open / close / protective-order lifecycle on
  Binance testnet; assert every state transition matches the
  engine's state machine.
- Reconciliation against exchange state — `PaperReconciliationAdapter`
  is not exercised; the live `ExchangeAccountStateSource` path is.
- Rate-limit policy under harmless burst load (W1.4 token bucket
  against testnet REST + WS).

PAPER and TESTNET are complementary:
- **PAPER:** live-market operational + statistical soak.
- **TESTNET:** exchange execution-contract drill.

M11b begins only when **both** have passed. The soak runbook
records this as two independent green checks.

## 5. DB schema set (per D16 + D17)

Locked tables introduced by PAPER mode (migrations owned by the
M11a R2b sub-wave):

| Table | Purpose | Notes |
|---|---|---|
| `paper_account_state` | Current open paper positions (entry price, size, side, leverage, opened-at, client_order_id, …) | No `unrealised_pnl` column (D16 — derived) |
| `paper_account_state_history` | Closed-trade ledger; per-trade PnL, fees, funding, slippage; `closed_at`; `close_reason` | Source for the trade-count floor (D10) |
| `paper_account_state_meta` | Non-secret derived metadata: seed version label, HKDF info-string version, simulator config hash, `soak_start_id`, `bootstrap_at_start_fingerprint`, soak start timestamp | **No secret material** |
| `paper_account_snapshots` | Audited equity snapshots (cadence: every minute + on every position event) | Feeds `peak_equity` for drawdown abort (D5) |
| `paper_simulator_idempotency` | Idempotency ledger keyed by `(event_id, order_intent_id, version_namespace)` → `simulated_fill_id` | D3 — retain soak + 30 days |
| `paper_state_audit` | HMAC-chained mutation audit; per-purpose subkey from HKDF (`paper_state_audit v1`, `paper_crn_audit v1`) | Atomic three-table-write partner of `paper_account_state` + `paper_account_state_history` |
| `paper_crn_tape` | Post-soak CRN tape blob keyed by `soak_start_id` | Write-once, append-only; content hash bound by audit-row commitment |
| `boot_mode_history` | HMAC-chained boot/transition log (D6) | Retained forever |
| `boot_mode_chain_rotations` | HMAC-chained record of sanctioned transitions (D7) | Retained forever |

## 6. Consequences

- **PAPER is operationally indistinguishable from LIVE for the
  strategy and risk layers**, but order intents never leave the
  process. The dev/QA boundary between "edge validation" and
  "exchange-contract validation" is now structural, not procedural.
- **State surface grows by nine tables** (eight PAPER-specific +
  the boot-mode-history pair). Crash recovery's phase 1 dispatches
  on `EXCHANGE_ENV` via `IBootStateSource` (ADR 0014 R0.4) — no
  cross-mode leakage of position data.
- **Determinism is preserved end-to-end.** The same shared
  `FillSimulatorCore` powers M7 backtests and PAPER soaks; the
  causality test prevents the streaming adapter from peeking at
  future ticks. A SIGKILL mid-trade replays via the
  `paper_simulator_idempotency` ledger to numerically equivalent
  fills.
- **Tamper-evidence is layered, not absolute.** The boot-mode and
  paper-state HMAC chains plus the encrypted-offsite and operator-
  log tip witnesses raise the bar against silent corruption; they
  cannot defeat a host-shell attacker by themselves.
- **The PAPER soak is a joint test** of `(strategy edge + M7 fill-
  model bias)` while `lowFidelity` covers every fill, not a
  validation of strategy edge alone. The lowFidelity-empty-subset
  downgrade and the M11b hardening clauses (depth-aware rerun,
  micro-probe milestone, or architect-approved waiver) are
  load-bearing.
- **PAPER does not gate M11b alone.** TESTNET pre-M11b drill is a
  parallel required gate codified in §4. M11b begins only when both
  green.

## 7. Alternatives considered

- **Use ccxt `enableDemoTrading(true)` directly.** Rejected: for
  USDT-M Futures it is a rename of the testnet host and surfaces no
  `/sapi*` endpoints. The original `DEMO` mode design rested on the
  false premise that this was a distinct paper-trading endpoint. The
  M11a course correction (this ADR) replaces it with engine-local
  PAPER.
- **Add a `mode` discriminator column on `positions` instead of a
  dedicated `paper_account_state` table.** Rejected per D1:
  different retention policies, simpler crash recovery with a
  dedicated table, no risk of a PAPER position leaking into LIVE
  read-API queries, separate write role.
- **Single `IExchangeClient` interface carrying both order commands
  and account-state reads.** Rejected per D2/D14: PAPER's "engine-
  local" property is violated if any account-state caller reaches
  ccxt under PAPER. Two ports + an explicit two-element exception
  list make the boundary mechanical.
- **Reuse `BacktestRunnerService` as the PAPER fill simulator.**
  Rejected per D15: the backtester sees future ticks at decision
  time; PAPER cannot. Extracting a pure `FillSimulatorCore` lets
  both modes share the model without sharing the scheduler.
- **Event-cursor-based idempotency on the simulator.** Rejected per
  D3: shadow versions emit multiple order intents per event;
  event-level cursors collide. The
  `(event_id, order_intent_id, version_namespace)` ledger is
  collision-free by construction.
- **Persist the per-boot seed master to survive restarts.**
  Rejected per D3: HKDF re-derivation from the bootstrap secret is
  cheaper than persisting a secret-equivalent value, and stateless
  derivation eliminates a leakage class.
- **Hard-reject Binance's per-funding-window absolute cap (D4).**
  Rejected: silently zeroing funding during a stress regime
  flatters expectancy at exactly the moment funding cost matters
  most for shorts. Apply-and-alert keeps the simulator faithful and
  the operator informed.
- **Drawdown denominator = starting equity instead of running peak
  equity.** Rejected per D5: starting-equity drawdown fires the
  abort on routine losing streaks from a high-water mark; peak-
  equity drawdown fires it on true regime breaks. The cold-start
  pin (`peak_equity(0) = PAPER_STARTING_EQUITY_USDT`) prevents an
  adverse first tick from disabling the abort.
- **"Clear and resign" the boot-mode HMAC chain on a sanctioned
  transition.** Rejected per D7: it creates an escape hatch from
  the tamper-evidence guarantee D6 establishes. Append-only typed
  rows with a separate `boot_mode_chain_rotations` table preserve
  the audit trail and let a forensic auditor distinguish a
  sanctioned transition from a compromise.
- **`LIVE_GO_AHEAD_TOKEN` required on PAPER as well.** Rejected
  per D9: PAPER never reaches real-money execution; the safety
  teeth live in the D8 allowlist (a tradeable key on PAPER fails
  boot). A go-ahead token on PAPER would train operators to handle
  it routinely, defeating its purpose for LIVE.
- **Single-call nullity probe (`fetchOpenOrders` only).** Rejected
  per D13: an accidental market-order / marketable-IOC fill closes
  immediately and leaves a position with no open-order trace. The
  two-call probe catches that case.
- **Persist `unrealised_pnl` on `paper_account_state`.** Rejected
  per D16: those mutations bypass the three-table atomic-write +
  audit path; a tamper of `unrealised_pnl` (which drives the
  drawdown abort threshold) would be invisible to the audit chain.
  Derived-on-demand from `(position, mark_price)` keeps the audit
  surface honest.
- **CRN root derived from the live bootstrap secret.** Rejected
  per D17: W1.8 rotates the bootstrap secret mid-soak; a CRN tape
  keyed on the live secret would change derivation silently and
  break the post-soak evaluator. Capturing `bootstrap_at_start`
  once at soak start and salting with `soak_start_id` keeps the
  derivation stable across rotation.
- **Pair CRN only on events where both versions traded.**
  Rejected per D17 selectivity-bias clause: a more-selective
  strategy looks weaker on the trade-vs-trade subset. Reporting
  both cohorts (CRN paired + full same-event with skip-handling)
  and requiring agreement avoids the bias.

## 8. See also

- `docs/architecture/adr/0014-crash-recovery.md` (amended R0.4 —
  `IBootStateSource` dispatch in phase 1)
- `docs/architecture/adr/0015-backtest-module.md` (seed-locking
  rationale cited by D3)
- `docs/architecture/adr/0019-promotion-gate.md` (criterion 12 —
  `lowFidelity`-included / -excluded rankings operate per D17
  cohort)
- `docs/architecture/adr/0028-key-permission-assertion-port.md`
  (amended R0.2 — mode-aware allowlist per D8; D9 LIVE-only scope)
- `docs/architecture/adr/0029-shadow-counterfactual-and-fill-simulator-pipeline.md`
  (`lowFidelity` semantics referenced by D17)
- `docs/architecture/adr/0030-in-engine-rate-limit-token-bucket-policy.md`
  (explicitly **not** reachable from PAPER per D2; D13 probe cost
  reserved in the token-bucket constants table)
- `docs/plans/M11a-paper-mode-addendum.md` (source of D1–D17; will
  be merged into `docs/plans/M11a-local-soak.md` and deleted at
  R4.2)
- `docs/plans/M11a-local-soak.md` (soak runbook + exit criteria)
