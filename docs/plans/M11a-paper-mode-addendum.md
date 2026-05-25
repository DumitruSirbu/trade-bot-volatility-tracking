# M11a — Paper-mode addendum (DEMO → PAPER course correction)

**Status:** Draft v6 — folds independent r2 reviews (GBT + Gemini) on top
of v5. GBT R2's verdict on v5: *"Go for the PAPER architecture after a
cleanup pass."* The architectural decisions D1–D17 are accepted; this pass
sweeps stale wording in older sections that contradicted those decisions,
plus addresses one new quant concern (CRN paired sample excludes
one-trades-one-skips events — biases the comparison toward events where
both versions were already willing to trade). Replaces the `DEMO` mode
introduced in W0.1 / W1.1.

## PAPER is not exchange demo trading (invariant)

This must be visible to every reader before they read anything else:

**PAPER validates strategy / risk / operational behaviour against live
market data. PAPER does not validate live exchange execution semantics.**

That means PAPER does **not** test: Binance order acceptance, rejections,
partial fills, cancel semantics, protective-order behaviour at the
matching engine, rate-limit-ban responses against real orders, or any
other property of the exchange's order lifecycle. Those properties still
require TESTNET drills (see §"TESTNET pre-M11b drill" below).

A successful PAPER soak is a **necessary but not sufficient** condition
for M11b. Real-money go-live requires both PAPER's statistical/operational
evidence and TESTNET's exchange-contract evidence.

**Depends on:** the rest of M11a as previously planned and partially
implemented (W0 shared contracts + W1 engine wave both landed; the rename in
this addendum is a course correction, not a restart).

**Replaces in M11a §W1.1:** the `DEMO = Binance demo trading` design, which
was based on the false premise that Binance USDT-M Futures has an
API-accessible paper-trading host separate from testnet.

## Why this addendum

W1 reviewer cycle (round 1) surfaced a blocker: ccxt's `enableDemoTrading(true)`
swaps `urls.api` to a `urls.demo` block that contains only `fapi/dapi/v1/
public/private` keys — no `sapi*` keys. `KeyPermissionAssertionService` calls
`sapiGetAccountApiRestrictions` + `sapiGetAccountApiRestrictionsIpRestriction`,
so a DEMO boot throws `fetch_error` and the engine exits.

Investigation against the current Binance developer docs and the Binance dev
forum confirmed: `demo-fapi.binance.com` and `testnet.binancefuture.com` are
aliases for the same testnet environment. No separate paper-trading endpoint
exists for USDT-M Futures. ccxt's `enableDemoTrading()` is a rename of
testnet for Futures, not a separate mode.

## The `PAPER` design

Rename `DEMO` → `PAPER` and make it an **engine-local paper-trading mode**:

- WebSocket connects to **live** `fapi.binance.com` for market data + funding
  (real prices, real depth, real spread, real OI, real funding rates).
- Orders are intercepted before reaching ccxt and routed to a local
  `PaperFillSimulator`, which uses `FillSimulatorCore` (D15 — pure shared
  module; M7 backtests use the same core via `HistoricalFillAdapter`,
  PAPER uses `StreamingFillAdapter` on live event-time; causality test
  asserts no future-tick read).
- Account state (positions, balances, margin) is simulated locally in a new
  `PaperAccountStateService`; never reads or writes a real Binance account.
- Reconciliation in PAPER mode runs against the local simulated state plus a
  periodic null-probe against the exchange (catches engine-internal drift
  **and** the worst-case "did we accidentally leak an order" failure mode).
- Key-permission assertion is **mode-aware** and **stricter** in PAPER than in
  LIVE.

## Locked decisions (folded from reviewer round 1)

The previous draft left several "Open Questions" — they are now decisions
written into the plan so R0 dispatches against a frozen contract.

### D1 — `paper_account_state` is a dedicated table

Reject the `mode` discriminator on `positions` alternative. Reasons:
- PAPER retention follows a different policy from live positions.
- Crash recovery's phase-1 reader is simpler with a dedicated table.
- No risk of a PAPER position accidentally being read by a LIVE-mode read API
  query.
- `paper_account_state` writes are restricted to the engine DB role; the
  read-API role gets `SELECT` only.

### D2 — `IExecutionClient` surface (frozen — order commands only)

`IExecutionClient` is **order-command-only**. Methods:
- `placeOrder(intent: IOrderIntent): Promise<IOrder>`
- `cancelOrder(symbol: string, id: string): Promise<void>`
- `cancelAllOrdersForSymbol(symbol: string): Promise<void>`
- `fetchOrderStatus(symbol: string, id: string): Promise<IOrder>`
- `fetchOpenOrders(symbol?: string): Promise<IOrder[]>` (here because
  the engine treats it as part of the order-lifecycle surface — pair
  with cancel/status)

Two implementations:
- `CcxtExecutionClient` (LIVE / TESTNET) — delegates to ccxt.
- `PaperExecutionClient` (PAPER) — delegates to `PaperFillSimulator`.

**Account-state reads (balance, positions, funding history) are NOT on
`IExecutionClient`.** They live on `IAccountStateSource` per D14
(`fetchBalance`, `fetchPositions`, `fetchOpenOrders`, `fetchFundingHistory`).
v5 said those stayed on `IExchangeClient`; that left a contract conflict
with D14 that GBT R2-H2 flagged. The corrected boundary:

- `IExecutionClient` — order-command verbs.
- `IAccountStateSource` — account-state nouns.
- `IExchangeClient` — the concrete ccxt adapter; **never injected into the
  PAPER decision loop**. The only callers reaching `IExchangeClient`
  account-state methods directly are the two D14 whitelisted services
  (`KeyPermissionAssertionService`, `PaperExchangeNullityProbe`).

Compile-time split: `PaperExecutionClient` does **not** import the
`RateLimitPolicyService` module, so an accidental rate-limit call from PAPER
is a build-time error, not a runtime assertion. Same compile-time rule
extends to `PaperAccountStateSource` — it does not import any ccxt module.

### D3 — PaperFillSimulator determinism

Per-order PRNG seed schema (stateless derivation):
```
seed_master  = HKDF(bootstrap_secret, info='paper_simulator_seed v1')
order_seed   = HMAC-SHA256(seed_master, event_id || symbol || order_intent_id || version_namespace)
```

`seed_master` is **never persisted**. It is re-derived at every boot from
the bootstrap secret via HKDF. `order_seed` for any specific order is
recomputed from the persisted decision row at any time. No long-lived
secret-equivalent material lives in the database. (Resolves the v3
self-contradiction: v3 said "derived at boot, not stored" then later said
"persist `(boot_seed, last_consumed_event_id)`" — gbt-review H2.)

**Idempotency ledger, not an event cursor.** A single market event can
produce multiple order intents across active (v1 PAPER) and shadow (v2/v3)
versions; event-level cursoring is too coarse and would collide. Replace
with a `paper_simulator_idempotency` table keyed by
`(event_id, order_intent_id, version_namespace)` recording the
`simulated_fill_id` produced. On restart, the simulator looks up by key
before rolling; if a fill already exists for the key, return it verbatim
(byte-identical replay).

**Retention floor pinned (logic round-3 M3):** the idempotency ledger
retains for **soak_duration + 30 days**, identical to `paper_account_state`.
A SIGKILL replay after GC'd ledger rows would silently break replay
determinism otherwise. The ledger goes on W3.10's paper-table retention
list.

`paper_account_state_meta` stores only **non-secret derived metadata**:
seed version label, HKDF info string version, simulator config hash, and
soak start timestamp. No secret material.

**Configuration provenance.** Simulator parameters (tier slippage table,
missed-fill probability, intra-bar stop rules) are sourced **only** from
the M7 configuration committed to version control. R3.1 asserts the
simulator refuses to start if its config file hash differs from the M7
commit-pinned hash. Defence against an operator tuning the simulator to
flatter v1.

**Replay determinism R3.1.** A SIGKILL mid-trade followed by restart
replays the recent decision window via idempotency-ledger lookup
(not re-rolling) and produces `simulated_fill` rows numerically equal
to the pre-crash values per D15's whitelisted-tolerance equivalence.
A separate offline replay using the same decision tape produces
numerically equal `simulated_fill` rows independently.

**Common Random Numbers vs cross-version independence** — see D17.

### D4 — Funding ordering and math

`PaperFundingAccrualService` applies live funding rates to
`PaperAccountStateService` positions at the **Binance-published funding
timestamp**, not local processing time.

**Sign convention pinned in account-PnL terms** (gbt-review H7 — the v3
`side_sign × funding_paid > 0` formula obscured what is actually being
asserted). The convention follows the operator's intuition: a positive
funding rate is paid by longs to shorts.

```
funding_pnl = -position_notional × funding_rate × side_sign
  where side_sign(LONG)  = +1
        side_sign(SHORT) = -1
```

Equivalently:
- For `rate > 0`: long → funding_pnl is **negative** (long pays);
  short → funding_pnl is **positive** (short receives).
- For `rate < 0`: long receives, short pays.

`position_notional` is the position size marked to market at the funding
timestamp using the live mark price. A position accrues funding iff
`position.openedAt ≤ funding.ts ≤ position.closedAt` — local clock is
irrelevant.

R3.1 paired tests assert the account-PnL direction directly:
- LONG + `rate > 0` → `funding_pnl < 0`.
- SHORT + `rate > 0` → `funding_pnl > 0`.

**Data sources** (gbt-review H7). Funding rate values are sourced from
Binance's funding-history REST endpoint at the moment of accrual; the next
funding metadata is observed from the mark-price WebSocket stream
(`!markPrice@arr` / `<symbol>@markPrice`) for visibility into the
upcoming event. The text "funding WS stream" is replaced with the
explicit (stream-name, REST-endpoint) pair in ADR 0032.

**Magnitude bound is a warning, not a hard reject.** Funding-rate ingest
passes the same M1 validator chain (rate sanity bounds, monotonic
timestamps, signed-source check). Binance's per-funding-window absolute
cap (cited from current Binance docs in ADR 0032) is enforced as:
- Apply the rate to the position.
- Write an audit row.
- Emit a CRITICAL Telegram alert.

R2.7 and R3.1 are reworded to "bound audited and alerted; raw rate still
applied" (resolving the v3 inconsistency where D4 said warning but R2.7 /
R3.1 said enforce). A simulator that silently zeroes funding during a
stress regime flatters expectancy at exactly the moment funding cost
matters most for shorts. Operator decides response, not the simulator.

**Funding / PnL ordering inside a tick batch** is pinned: `apply_funding
→ recompute_unrealised_pnl → evaluate_drawdown_abort`. R3.1 adds a test
for a funding event coincident with an adverse mark.

**Funding force-flushes the MTM throttle** (quant round-3 M3). D5 throttles
unrealised-PnL evaluation to one per 100 ms per held symbol. A funding
event arriving mid-throttle-window would otherwise wait up to 100 ms
before being applied — and a coincident adverse mark could delay the
abort by the same window. Funding event arrival is therefore a
throttle-exemption trigger: immediate `apply_funding +
recompute_unrealised + evaluate_abort`, regardless of throttle state.
R3.1 explicitly asserts no throttle delay on this path.

**Timing approximation noted.** Applying funding at local receipt of the
Binance funding timestamp may have sub-second desync with Binance's
own snapshot. Acceptable for paper trading; documented in ADR 0032 as a
known minor divergence (gemini-review 3.6).

### D5 — Mark-to-market cadence + drawdown denominator

PaperAccountStateService unrealised PnL is recomputed on price updates for
held symbols at a **throttled cadence** (gemini-review 3.2). Binance
mark-price ticks fire multiple times per second under volatility; running
MTM + drawdown abort on every raw tick would saturate the Node.js event
loop and delay critical order-execution paths.

Throttle rule (pin in ADR 0032):
- Coalesce updates per held symbol to at most **once per 100 ms**, OR
  immediately when the cumulative price move since the last MTM exceeds
  one tick size (whichever comes first). The 100 ms ceiling protects the
  event loop; the tick-size early-trip protects abort-threshold latency
  during fast moves.
- Inside the throttle window, the latest tick is retained and applied
  when the throttle fires (no dropped data, only deferred work).
- R3.1 includes an event-loop-lag boundary test: under a 1000 ticks/sec
  synthetic burst, MTM completes at ≤100 ms per held symbol and the
  abort-threshold check still fires within one throttle window of the
  trigger condition.

Restricted-profile soak has `max_open_positions: 1`, so total MTM cost is
bounded. If the profile relaxes, the throttle parameters must be
re-validated (quant round 2 L2).

**Drawdown denominator pinned to running peak equity** (quant round 2 H1).
The drawdown abort threshold (15%) compares against `peak_equity`, not
starting equity:
```
drawdown(t)    = (peak_equity(t) - equity(t)) / peak_equity(t)
peak_equity(t) = max(equity(τ)) for τ ∈ [soak_start, t]
peak_equity(0) = PAPER_STARTING_EQUITY_USDT   // cold start; not the first MTM tick
```
The cold-start pin (quant round-3 L1) prevents an adverse first tick from
lowering `peak_equity` below the starting value, which would delay the
abort threshold's first meaningful trigger.
With D11's $500 starting equity and 0.25% risk per trade, peak-equity
denominator means the abort fires on a true regime break, not on a routine
losing streak from a high-water mark. Re-evaluated per D5 throttle
(coalesced once per 100 ms per held symbol, or immediately on a
>=1 tick-size move or on a funding-event force-flush). Note: `peak_equity`
itself is derived from audited `paper_account_snapshots` per D16 — the
in-memory peak is computed at evaluation time, not mutated in place.

### D6 — Mode-switch predicate + integrity

Predicate: **persisted last-known boot mode ≠ current `EXCHANGE_ENV`** →
abort with a clear error. Recorded in a new `boot_mode_history` table
written **at successful boot** (not at shutdown — crash-safety):

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

`exchange_env` is always the env in force **after** the row applies. On
TRANSITION rows, the `(from_env, to_env)` pair carries the directional
intent that the single `exchange_env` column could not express (gbt-review
H1). The signed payload includes all three of `exchange_env`, `from_env`,
`to_env` so a forged row cannot misrepresent the transition.

`seq BIGSERIAL` is included in the signed payload (security round 2 M3) so
clock-skew cannot let an attacker insert a row appearing "earlier" than tip
by manipulating `booted_at`.

**HMAC subkey derivation** (security round 2 H2). The chain HMAC key is
**not** the raw bootstrap secret. Per-purpose subkeys via HKDF:
```
boot_mode_history_key  = HKDF(bootstrap_secret, info='boot_mode_history v1')
paper_state_audit_key  = HKDF(bootstrap_secret, info='paper_state_audit v1')
```
Same primitive as W1.7's `cursor v1` / `auth v1`. A leak of the
boot_mode_history key does not compromise paper_state_audit or login HMAC,
and vice versa.

**Threat model — tamper-evidence, not tamper-proofing** (gbt-review M4 +
gemini-review 3.3). The HMAC chains catch accidental corruption and
unauthorized DB-only modification by a process that does not have the
host's bootstrap secret. They do **not** protect against an attacker who
gains host shell access — that attacker can read the bootstrap secret
from `.env`, re-derive sub-keys, and forge any history. Legitimate DB
restores from backups will also break the chain.

Mitigations within scope of M11a:
- Append each chain's tip hash to the **encrypted offsite backup**
  (W3.9) and a local **append-only operator log** at every successful
  boot. An attacker who tampers with the live DB cannot retroactively
  edit those tips.
- A daily operator-signed work-log entry records the tip hash. Out-of-band
  attestation cheap to maintain.
- After a sanctioned DB restore, the runbook documents a `CHAIN_RESTORE`
  row appended under the new sub-key, witnessed by the most recent
  external tip hash. The chain is not "fixed" — it is explicitly
  reset-with-witness.

**Boot sequence (executable ordering)** (gbt-review H1). The v3 text was
ambiguous about whether mode-mismatch detection or transition-row append
ran first. The frozen order is:

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

R1.5 R3.1 tests both branches:
- Unauthorized mismatch aborts with **no chain mutation**.
- Authorized transition appends **exactly one** TRANSITION row + one BOOT
  row + one rotation row, all in one transaction.

**Bootstrap-secret rotation interaction (W1.8).** Rotation produces fresh
sub-keys for both chains. The pre-rotation chain tip is witnessed by
appending a typed `KEY_ROTATION_WITNESS` row referencing the old tip hash,
signed with the **new** sub-key. R3.1 includes a test that a rotation
followed by tampering with a pre-rotation row is detected via the witness.

Phase-1 crash recovery verifies the chain and refuses to proceed if it is
broken or if the last row's `exchange_env` differs from the current
`EXCHANGE_ENV`. Non-empty `paper_account_state` is a **secondary** defence
inside the mode-switch branch, not the primary predicate.

**Mid-soak chain break action** (security round 2 M4). A chain-integrity
failure detected during the soak (e.g. by the soak-exit-gate evaluator
verifying the chain before reading state) is CRITICAL: alert, halt new
decision routing, **invalidate the soak result**. Mid-soak chain breaks
never silently downgrade — they disqualify the run.

### D7 — Mode-transition matrix (append-only, never truncate the chain)

ADR 0032 includes the transition matrix; the operator must follow the
documented drain procedure for each transition. **Undocumented transitions
are rejected at boot**.

**Chain rotation primitive: append-only typed rows.** Three reviewers
(architect, logic, security) converged on the round-2 finding that "clear
and resign" creates a sanctioned escape hatch from D6's tamper-evidence
guarantee. Every legitimate transition is now recorded as an **append-only
typed row** (e.g. `TRANSITION_TESTNET_TO_PAPER`) that references the prior
tip's HMAC, signed under the appropriate sub-key. The chain is **never
truncated**. Rotation events themselves are persisted in a separate
`boot_mode_chain_rotations` table (also HMAC-chained) so a forensic auditor
can distinguish a sanctioned transition from a compromise.

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

Each transition requires a **separate transition token** (analogous to
`LIVE_GO_AHEAD_TOKEN`): a file whose hash is baked into config and matched
at boot. The transition is single-use — once a `TRANSITION_*` row is
written, the same token cannot drive another transition without rotating.

| From | To | Procedure |
|------|----|-----------|
| TESTNET | PAPER | Confirm `paper_account_state` empty; operator provides `TESTNET_TO_PAPER_TOKEN_FILE` (hash baked at build); boot appends `TRANSITION_TESTNET_TO_PAPER` row + records rotation; proceeds. |
| TESTNET | LIVE | Operator provides both `TESTNET_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; standard LIVE allowlist applies; CRITICAL alert. |
| PAPER | TESTNET | Reject unless `paper_account_state` is empty; operator provides `PAPER_TO_TESTNET_TOKEN_FILE`; runbook documents the paper-position-cleanup step. |
| PAPER | LIVE | Reject unless `paper_account_state` empty; operator provides `PAPER_TO_LIVE_TOKEN_FILE` **and** `LIVE_GO_AHEAD_TOKEN_FILE`; CRITICAL Telegram alert at boot. |
| LIVE | PAPER | Reject unless no open live positions; operator provides `LIVE_TO_PAPER_TOKEN_FILE` (separate from `LIVE_GO_AHEAD`); CRITICAL alert; never re-uses any prior token. **Predicate routing fix** (logic round-3 M1): at LIVE→PAPER boot, `EXCHANGE_ENV` is already PAPER so the bound `IAccountStateSource` is `PaperAccountStateSource` (returns empty trivially). The "no open live positions" predicate **must use a transition-only `ExchangeAccountStateSource(prior_env_credentials)`** that reads the live exchange under the prior LIVE key. The transition-time source is bound by the boot sequence (D6 step 6) under a dedicated provider name; the normal port binding is restored after the transition row commits. R3.1 includes a test asserting the predicate sees real positions when they exist. |
| LIVE | TESTNET | Reject. Operationally: use a separate machine, **or** execute the documented destructive-wipe runbook step that records a `MACHINE_REPURPOSE_WIPE` row before re-init (logic round 2 H2 + security round 2 L1). |

### D8 — PAPER allowlist (full enumeration)

The PAPER allowlist is the full snapshot predicate, just with
`enableFutures` flipped:

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

The `mode` parameter is the shape of the predicate change (not a second
function variant). PAPER **rejects** `enableFutures: true` — a tradeable
key paired with PAPER mode is a hard error, not silent permission.
IP-restrict + allow-list + non-expired authority remain required (a
read-only key on unrestricted IP is still a credential-replay risk against
account-state endpoints).

**Endpoint-accessibility verification — promoted to R0 blocker
(gbt R2-M1).** Before **R0** finishes (not R1), the engine team must
verify against current Binance documentation that every futures
endpoint PAPER needs (funding history `/fapi/v1/fundingRate`, exchange
info `/fapi/v1/exchangeInfo`, mark price `/fapi/v1/premiumIndex`,
order-book depth `/fapi/v1/depth`, the `/fapi/v1/openOrders` and
`/fapi/v2/positionRisk` reads needed by D13's nullity probe, and any
signed account-state reads required for the M11b TESTNET drill) is
accessible to a key whose `enableFutures === false`.

Three outcomes:
1. **All endpoints accessible without `enableFutures`** → D8 profile
   stands; R1 dispatches normally.
2. **Some endpoints require `enableFutures: true`** → D8 amends to the
   **Fallback Profile** (defined below). R1 dispatches under the
   fallback.
3. **Endpoints inaccessible under any non-tradeable profile** → M11a
   blocker; design decision required (skip nullity probe and accept
   the safety regression, or change PAPER scope).

**Fallback Profile (R2-M1, define now so R1 has a deterministic spec).**
If `enableFutures: true` is required, PAPER runs under a **dedicated
zero-balance sub-account**:

- API key on a dedicated Binance sub-account whose sole purpose is to
  host the PAPER probe key. The main account is never reachable via
  this key.
- Allowlist amended: `{enableReading: true, enableFutures: true}` on
  this key — but **the engine refuses to boot if any of the following
  is true**:
  - Sub-account balance ≠ 0 at boot or at any reconciliation tick.
  - Sub-account has any open position at boot or at any tick.
  - Key has any transfer permission (`enableInternalTransfer`,
    `permitsUniversalTransfer`) — these must remain false.
  - IP allow-list is empty.
  - Trading authority is expired or null.
- D13 probe extended: every cycle asserts (a) zero balance, (b) zero
  positions, (c) zero open orders. Any non-zero → CRITICAL halt +
  invalidate soak.
- Operator runbook documents the sub-account creation procedure,
  including the no-balance and no-transfer invariants.

Verification result + selected profile is recorded in
`docs/work-log.md` before R1 dispatch.

### D9 — `LIVE_GO_AHEAD_TOKEN` is LIVE-only (decision, not open question)

PAPER does **not** require the go-ahead token. The read-only-only assertion
(D8) is PAPER's safety teeth. ADR 0028 records this explicitly so a future
reader does not re-introduce a PAPER token gate by analogy.

### D10 — Closed-trade counting (full enumeration)

Logic round 2 M3: enumerate the full `closeReason` set against the floor,
not only the excluded one. Quant round 2 M4: missed fills do not consume
the `max_trades_per_day` daily slot. Architect round 2 L1: excluded
`force_close` PnL is still reported in a separate soak-evaluator panel so
the operator sees what was discarded.

| `closeReason` | Counts toward ≥80-trade floor? | Notes |
|--------------|-------------------------------|-------|
| `sl` | ✅ Yes | Stop-loss intra-bar fill. |
| `tp` | ✅ Yes | Take-profit intra-bar fill. |
| `intra_bar_stop` | ✅ Yes | Generic intra-bar protective stop. |
| `force_close` | ❌ No (excluded) | M7 end-of-window. Surfaced in a separate evaluator panel for visibility. |
| Operator drain (halt + close) | ❌ No (excluded) | Operator-initiated close during incident or transition. |
| Reconciliation-forced close | ❌ No (excluded) | Engine-internal cleanup. |

Additionally:
- A simulator decision with `missed: true` does **not** consume the
  restricted profile's `max_trades_per_day: 3` slot (quant round 2 M4).
  Missed fills are observability only — they do not crowd out future
  decisions in the same risk-day.
- The soak evaluator emits a "excluded fills" report alongside the
  primary trade count so excluded-but-real PnL is auditable.

M11a §"Minimum trade count" gets a cross-reference in the same fold-in
pass.

### D11 — PAPER starting equity

PAPER starting equity defaults to **$500** to match the live restricted
profile's lower bound. Surfaced as `PAPER_STARTING_EQUITY_USDT` env var
(security round 2 L2 — keeps trust-posture-relevant magic numbers out of
code), validated by Zod schema with `$500` as the default. R3.1 includes
a boundary test that a 15% adverse mark from peak equity triggers the
abort within one MTM-throttle window per D5 (architect round 3 L1).

### D12 — Reconciliation in PAPER

PaperReconciliationAdapter inherits the **same triggers** as M6 W4b live
reconciliation (event-driven on position events; periodic poll at the same
cadence) — source swapped from exchange to PaperAccountStateService. Drift
event types are reused from `@bot/shared` (no new event shapes).

**Drift action in PAPER is more severe than in LIVE.** In LIVE, drift can
have an exchange-clock cause; in PAPER, there is no exchange to blame, so
any drift between in-memory `PaperAccountStateService` and the persisted
`paper_account_state` rows is
a production bug. Action: CRITICAL Telegram alert (not WARNING), audit
row, halt new decision routing, await operator intervention. The existing
M6 W4b drift handler gains a `mode`-aware severity rule.

### D13 — PaperExchangeNullityProbe (defence in depth)

Independent of `PaperExecutionClient`'s internal invariants, the
reconciliation cycle calls **both** `fetchOpenOrders()` **and**
`fetchPositions()` against the live exchange and asserts both are empty
(filtered as described below). Two readers, not one, because
`fetchOpenOrders` only sees resting orders — an accidental market-order or
marketable-IOC fill closes immediately and leaves a position with no open
order trace (gemini-review 3.1). The probe must catch that case too.

**Dedicated PAPER sub-account, strongly preferred.** A dedicated Binance
sub-account whose only role is to hold the read-only PAPER key trivially
lets the probe assert **absolute nullity**: zero open orders AND zero
positions across all symbols, without the brittle client-ID-prefix
filter. The runbook makes this the documented recommended path; the
prefix-filtered path is a fallback.

**Capability preflight at PAPER boot** (gbt-review H3). The probe must
not be allowed to silently become decorative. Before the soak starts:
- The engine performs one `fetchOpenOrders` + one `fetchPositions` call
  against the configured PAPER key.
- Three branches:
  1. **Both succeed and both are empty** → probe is operational; soak
     proceeds.
  2. **Both succeed and a non-empty engine-attributed entry exists** →
     CRITICAL halt before soak starts; runbook says drain the account.
  3. **Either call returns 401/403/permission/malformed credential** →
     PAPER startup aborts with a clear error. The probe cannot run with
     this key; either fix the key (per D8 endpoint-accessibility
     verification) or disable PAPER. Soak does **not** start with a
     decorative probe.

**Runtime failure-class taxonomy.** Once the soak is running, probe
responses are classified explicitly:
- `Network / 5xx / timeout` → log and continue for up to 5 consecutive
  failures (bounded window). On the 6th consecutive failure, emit a
  WARNING and switch the probe to exponential backoff (cap 1/hr) while
  the soak continues. Binance outage cannot halt the soak.
- `401 / 403 / permission / malformed credential` → CRITICAL halt. The
  key changed mid-soak; soak result is invalidated until the new key is
  re-attested per D8.
- `Non-empty engine-attributed response (orders or positions)` →
  CRITICAL halt + audit row. The leak case the probe exists for.

**Cadence + budget.** Probe runs **once per minute** for each of
`fetchOpenOrders` and `fetchPositions` (security round 2 M2). The cost
(2 read calls/min × symbol fan-out) is reserved in the W1.4 token-bucket
policy before R1 starts. ADR 0030 constants table is updated.

**Symbol fan-out budget (gemini r2 forward-looking).** If the symbol
universe expands beyond the restricted-profile single-symbol-per-trade
assumption, the per-minute probe cost grows linearly. Before any future
universe expansion, the W1.4 token-bucket policy must be re-checked
against `(2 calls × universe_size + reconciliation cadence + funding
poller)` — Binance per-IP REQUEST_WEIGHT_1M is the binding constraint.
For M11a's single-position profile this is not load-bearing; flagged so
M11b / scaling waves don't silently break the budget.

### D14 — `IAccountStateSource` port (full surface, not only orders)

gbt-review H4: splitting only `IExecutionClient` is not enough.
`fetchBalance`, `fetchPositions`, `fetchOpenOrders`, and funding-history
reads stay on `IExchangeClient` after D2 — but the engine has existing
callers that hit those methods directly:
- `AccountSnapshotWriter` → `fetchBalance`.
- `ReconciliationService` → `fetchPositions` + `fetchOpenOrders`.
- Funding accrual paths → funding-history surfaces.

If those callers reach the live exchange in PAPER, the "engine-local"
property is violated (and the soak measures a different account state than
PAPER is supposed to be simulating).

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
- `PaperAccountStateSource` (PAPER) — backed by `PaperAccountStateService`.

`AccountSnapshotWriter`, reconciliation phase 1, funding cashflow readers,
and the read-API account projections are bound to **this port**, not to
`IExchangeClient`. Module-level provider dispatch on `exchange_env`.

**The exception list** (rows the LIVE ccxt account-state methods are still
allowed to be called from in PAPER) is exactly two:
1. `KeyPermissionAssertionService` (boot-time `/sapi` calls).
2. `PaperExchangeNullityProbe` (D13).

R3.1 adds a **module-graph test**: walks the Nest DI graph from the
strategy → risk → execution loop and fails if any provider reachable from
the live decision path can inject `IExchangeClient`'s account-state
methods. Only the two whitelisted providers above may have that reach.

**Runtime guard, not only static graph (security round-3 H1).** Nest's
`ModuleRef.get(IExchangeClient)`, `Reflector`, `useFactory(injector)`, and
`forwardRef` resolve providers at runtime in a way the static-graph walk
cannot see. A reviewer-time refactor that swaps a constructor inject for
`moduleRef.get(IExchangeClient)` would silently bypass the test. Pair the
static check with:

1. **Capability-tagged proxy** on the two whitelisted methods
   (`KeyPermissionAssertionService.fetchKeyPermissions`,
   `PaperExchangeNullityProbe.fetchOpenOrders` /
   `PaperExchangeNullityProbe.fetchPositions`). The proxy uses
   `AsyncLocalStorage` to tag the call-stack origin at the whitelisted
   entry point. Any call to ccxt account-state methods on the live key
   without the matching tag in the active context throws
   `UnauthorizedLiveAccountStateCallException`.

2. **ESLint rule** banning the strings `ModuleRef.get(IExchangeClient)`,
   `@Inject('IExchangeClient')`, and `injector.get(IExchangeClient)`
   outside the whitelisted file set (`/auth/KeyPermissionAssertionService.ts`
   and `/paper/PaperExchangeNullityProbe.ts`). CI gate, not just convention.

R3.1 tests the runtime guard with a synthetic service that resolves
`IExchangeClient` via `ModuleRef.get` and calls `fetchBalance` — assert
the throw fires. The static-graph test stays as the first line of defence;
the runtime guard is the second.

### D15 — `PaperFillSimulator` is **not** `BacktestRunnerService` reuse

gbt-review H5 surfaced the most serious correctness issue: M7's
`BacktestRunnerService` is a **historical replay** engine. Its fill model
expects to see the full bar's path (high, low, close, intra-bar ticks)
**before** deciding whether an IOC filled, an SL was hit, or a TP was hit
intra-bar. PAPER runs in **live event-time** — at decision time the
future tick stream does not yet exist. Two options, both wrong:

- Wait for future ticks before deciding → PAPER is no longer simulating
  live execution; the simulator decides retrospectively after the bar
  closes.
- Decide immediately from the current snapshot → no longer the same
  algorithm as M7's replay path; the soak measures a different model
  than the backtest.

**Decision: extract a pure shared fill library, two adapters.**

**Placement (gbt R2-M2):** `FillSimulatorCore` lives in
**`packages/shared/`** because both `@bot/engine` (PAPER's
`StreamingFillAdapter` + M7's `HistoricalFillAdapter`) consume it from
the same boundary. The core is **dependency-light**: pure functions, no
TypeORM entities, no Nest providers, no engine imports. Money helpers
(decimal arithmetic, tier-size lookups) that the core needs are
duplicated into the shared package as pure utilities if they currently
live engine-side — the rule is that `packages/shared/fill-simulator/`
has zero dependencies on `apps/engine/`. R2c.1 includes a
dependency-direction lint that fails the build if a shared module
imports from `apps/engine/`.

```
@bot/shared/fill-simulator/
  FillSimulatorCore   // pure functions: applyFill(snapshot, intent, seed) → ISimulatedFill
                      // applyIntraBarStop(snapshot, position, seed)       → ISimulatedFill | null

  HistoricalFillAdapter  // backtest: replay with complete tick paths
                         // wraps Core; pre-resolved future ticks available

  StreamingFillAdapter   // PAPER: live event-time; subscribes to live tick
                         // stream; reacts to ticks as they arrive (no
                         // setTimeout scheduling — see SL/TP rule below)
                         // honours intra-bar semantics by event ordering
```

The `BacktestRunnerService` is rewritten to delegate its fill logic to
`FillSimulatorCore` via `HistoricalFillAdapter`. `PaperFillSimulator`
delegates to `FillSimulatorCore` via `StreamingFillAdapter`. The two
adapters have different inputs and different scheduling, but identical
`applyFill` semantics for the same snapshot.

**SL/TP evaluation is event-driven, never timer-driven** (quant round-3 L2).
The `StreamingFillAdapter` evaluates intra-bar SL/TP triggers on **tick
arrival** from the live WS feed. A `setTimeout` against wall clock would
drift relative to Binance's tick cadence under event-loop load, producing
non-deterministic intra-bar timing. R3.1 asserts SL evaluation fires
within one tick of the triggering price (not within one wall-clock
interval).

**Causality test (R3.1 mandatory)**: at time `t`, the streaming adapter
cannot read tick / book-snapshot data with timestamp `> t`. The test
asserts this by giving the adapter a clock-skewed market snapshot fixture
and asserting the produced `ISimulatedFill` does not depend on the
future-tick portion.

**The M7 backtest is rerun against the extracted core** as the R0.5
validation step — any divergence between pre-extraction and post-
extraction backtest output is a blocker.

**Equivalence is numerical, not byte-for-byte** (quant round-3 M5). v4
said "byte-for-byte" — but Decimal serialization, map-iteration order,
and floating-point summation order can produce non-byte-identical
output for numerically equivalent results, leading to false-positive
regression failures. The equivalence test asserts per-field numerical
equality on `simulated_fill` rows with documented tolerance for fields
where order-dependent serialization is unavoidable (`slippageComponents`
sub-field ordering, JSON key ordering). The whitelist is in the test
fixture, not hidden in the implementation. ADR 0032 references M7's
backtest-equivalence test as a permanent regression guard.

### D16 — Paper-state source-of-truth (per datum)

gbt-review H6: v3 chose a dedicated `paper_account_state` table (D1) but
D12 still talks about reconciling against `IPositionRepository` (which
historically writes to `positions`), and the soak exit criteria depend on
metrics derived from `positions`, `transactions`, `risk_state`, and
`account_snapshots`. That mixed model is ambiguous.

**Decision: PAPER is fully separate from live position tables.** Each
datum has exactly one source-of-truth:

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
`account_snapshots` are **never written** in PAPER. They are **read** only
during TESTNET drills and LIVE.

D12 reconciliation is reworded: `PaperReconciliationAdapter` reconciles
`PaperAccountStateService` against `paper_account_state` rows (the
in-memory service vs the persisted projection) — **not** against
`IPositionRepository`. Drift between in-memory and persisted state
catches the engine-internal bug class D12 was designed to catch, without
mixing the source-of-truth chains.

**Atomicity guarantee.** Every paper fill writes to
`paper_account_state` (current state mutation) + `paper_account_state_history`
(append the closed-trade record if applicable) + `paper_state_audit`
(HMAC-chained audit) in **one transaction**. A crash between writes leaves
the engine state structurally consistent — not "consistent after later
reconciliation." The audit row's signed payload **includes the
post-allocation `seq`** (security round-3 M4) — implemented via a CTE /
RETURNING-clause so the assigned `seq` value is bound into the HMAC
within the same SQL statement. This prevents a crash-replay window where
the chain tip and the row don't agree on `seq`.

**Unrealised PnL is derived, not state (logic round-3 H2).** v4 had MTM
mutating `paper_account_state.unrealised_pnl` on every coalesced WS tick
(D5). Those mutations bypass the three-table atomic write — a tamper of
`unrealised_pnl` (which drives the drawdown abort threshold) would be
invisible to the audit chain.

Decision: **`unrealised_pnl` is computed on demand**, never persisted.
The `paper_account_state` table holds only state that is genuinely
position-defining (entry price, size, side, leverage, opened-at,
client_order_id, …). MTM evaluations for drawdown-abort and read-API
projection compute:
```
unrealised_pnl = (mark_price - entry_price) × size × side_sign
equity         = realised_pnl + sum(unrealised_pnl per open position) + funding_accrued
peak_equity    = max over the soak window of equity readings, persisted in
                 paper_account_snapshots (which IS audited)
```

`paper_account_snapshots` is a sibling of `account_snapshots` and is
written at coarser cadence (suggest: every minute + on every position
event), goes through the three-table atomic-write path, and is itself
audit-chained. Drawdown abort reads from a derived `unrealised_pnl`
plus the audited `peak_equity` snapshot — tampering either input
(`mark_price` from WS or the audited snapshot) is detectable.

This drops the MTM-throttle requirement for atomicity (the throttle in
D5 still applies to evaluation cadence — but evaluation does not mutate
audited state).

W3.10 retention floor for paper tables (folded from gbt-review M3 +
quant round 2 retention concerns):
- `paper_account_state`: retain soak duration + 30 days.
- `paper_account_state_history`: retain soak duration + 30 days.
- `paper_state_audit`: **archive, not prune**, for the soak window.
- `paper_account_state_meta`: retain at least through M11b decision.
- `paper_account_snapshots`: soak duration + 30 days.
- `boot_mode_history` + `boot_mode_chain_rotations`: retain forever
  (security audit trail across milestones).

### D17 — Shadow randomness: independence + paired common-random-numbers

gbt-review H8 surfaced a contradiction in v3:
- D3 said v1 and v2/v3 use independent order-intent namespaces so they do
  not receive correlated rolls.
- The lowFidelity section said v1 vs shadow v2/v3 was load-bearing
  because the shared simulator and same noise let bias cancel.

These pull in opposite directions for the comparison test.

**Decision: separate active execution from offline comparison.**

- **Active PAPER execution** uses deterministic, idempotent per-version
  order seeds (`order_seed = HMAC(seed_master, event_id || symbol ||
  order_intent_id || version_namespace)`). Each version's actual decisions
  are scored independently — that is the realistic counterfactual.

- **Offline same-event strategy comparison** uses a **pre-registered
  Common Random Numbers (CRN) scheme** keyed by
  `(event_id, simulator_component, pair_id)`.

**Per-soak CRN root (round-3 highs — architect M4 + quant H1 + security M2).**
The CRN root is **not** derived from the live bootstrap secret. W1.8 rotates
the bootstrap secret during the soak; a CRN tape keyed on the live secret
would silently change derivation mid-soak and break the offline evaluator's
ability to recompute the tape. Instead:

```
soak_start_id     = uuid generated at soak start
bootstrap_at_start = bootstrap_secret captured at soak start (immutable for the soak)
crn_root          = HKDF(bootstrap_at_start, info='paper_crn v1', salt=soak_start_id)
crn_tape[i]       = HMAC(crn_root, event_id_i || simulator_component_i || pair_id_i)
```

`bootstrap_at_start` is **never persisted in plaintext**; only its
fingerprint (e.g. SHA-256 of the secret) goes into the audit row. The
evaluator post-soak re-captures the secret value the operator names in the
runbook and re-derives `crn_root`; mismatch with the stored fingerprint
invalidates the soak.

**Commit-reveal audit-row pattern (security M3).** At soak start, write a
single audit row to `paper_state_audit` under a dedicated subkey
(`paper_crn_audit v1` HKDF info string):

```
crn_commitment = HMAC(crn_root, soak_start_ts
                              || bootstrap_at_start_fingerprint
                              || symbol_universe_hash
                              || pair_list_hash
                              || PAPER_STARTING_EQUITY_USDT)
```

Only the commitment (a single HMAC) goes into the audit row pre-soak. The
CRN tape itself is **not revealed mid-soak** — an operator with engine-role
DB access cannot predict future paired rolls and time decisions out-of-band.
The tape is materialised by the evaluator post-soak from `crn_root`; the
commitment row binds it.

**Tape storage (quant L3).** The full tape can be megabytes. Store a
content hash (`SHA-256(tape_bytes)`) in the audit row and the tape itself in
a separate `paper_crn_tape` blob table keyed by `soak_start_id`, written
once post-soak by the evaluator (write-once, append-only, no overwrites).

**Skip-case pairing (logic H1).** v1 and v2 generally produce different
order intents on the same event: one trades, the other skips, or both skip.
A `pair_id` keyed on `event_id` alone collapses to "same event → same roll"
only when both strategies trade; otherwise CRN does not actually pair, and
the variance-reduction claim is structurally false.

**Roll consumption rule.** Per `(event_id, simulator_component)`, the CRN
roll is consumed by **whichever version trades**. If both trade, they
consume the same roll (true pairing). If only one trades, the roll is
consumed by the trader.

**Selectivity bias (gbt R2-M3).** Restricting the paired difference
series to events where **both** versions traded biases the comparison
toward events where both versions were already willing to trade. Skip is
first-class in this bot — a strategy that earns its edge by being
**more selective** would look weaker against one that's less selective
on the trade-vs-trade subset. v6 mitigates by reporting **two paired
cohorts**, not one:

1. **Trade-vs-trade CRN cohort.** Both versions traded; same simulator
   roll; isolates fill-noise differences and pure decision-edge
   conditional on willingness to trade. The variance-reduction claim
   applies here.
2. **Full same-event cohort with skip-handling.** All events where at
   least one version traded. For events where one trades and one skips,
   the skipping version's contribution is `pnl = 0` (no trade, no PnL).
   No CRN pairing on these — independent / no-fill roll handling. This
   cohort captures **selectivity edge** that the trade-vs-trade cohort
   discards.

The "active version beats shadow v2/v3" criterion **requires the same
winner on both cohorts** (mirroring the same-winner rule across the
lowFidelity-included / -excluded rankings). If the trade-vs-trade
cohort says v1 wins but the full cohort says v2 wins because v2's
selectivity advantage dominates, the criterion is marked **inconclusive**
— do not promote on the trade-vs-trade subset alone.

The truth table from D17's "two evaluator outputs" extends accordingly:
both cohorts × both lowFidelity rankings = up to four sub-criteria, all
of which must agree on the winner for a pass. Disagreement on any pair
→ inconclusive.

The `lowFidelity`-included and -excluded rankings (D17 §"Two evaluator
outputs" + ADR 0019 criterion 12) operate on **each** of the two
cohorts independently.

**Two evaluator outputs + inconclusive truth table (quant M2).**
The soak-exit report produces two CIs on `E[v1] − E[v2]`:

1. **Paired CRN CI**: same simulator rolls on the same events; variance
   reduction is real; simulator bias cancels.
2. **Independent-noise robustness CI**: computed from the live PAPER + live
   shadow runs (each version's actual decisions scored under independent
   rolls). Wider, less powerful, but checks the CRN didn't smuggle in a
   spurious winner.

Truth table for the "active version beats shadow v2/v3" criterion:

| Paired CRN CI | Independent-noise CI | Result |
|--------------|---------------------|--------|
| Decisive, v1 wins | Decisive, v1 wins | **Pass.** Same winner; CRN result corroborated. |
| Decisive, v1 wins | Decisive, v2 wins | **Fail.** Contradictory; not safe to promote. |
| Decisive, v1 wins | Inconclusive (straddles zero) | **Inconclusive.** Not a pass on CRN alone — the independent-noise cross-check is the whole point of dual-CI. |
| Inconclusive | Decisive | **Inconclusive.** Same logic mirrored. |
| Both inconclusive | — | **Inconclusive.** Extend or accept exploratory. |

**Mid-soak rotation invariance.** Because `crn_root` is keyed on
`bootstrap_at_start` (captured at soak start), W1.8 mid-soak rotation does
**not** invalidate the CRN tape. The bootstrap secret rotates for ongoing
HMAC chains (boot_mode_history, paper_state_audit) but the CRN derivation
key is frozen. R3.1 includes a test for "soak-start CRN survives mid-soak
bootstrap-secret rotation."

## TESTNET pre-M11b drill (complementary, required)

gbt-review M6: PAPER validates strategy / risk / operational behaviour
on live market data, but **never** exercises Binance's order-placement
contract — order acceptance, rejection, partial fills, cancel semantics,
protective-order behaviour at the matching engine. Those still need
**Binance Futures testnet** to drill.

TESTNET is therefore a separate **required gate** before M11b, run after
PAPER soak success. Scope:
- Place / cancel / open / close / protective-order lifecycle on Binance
  testnet; assert every state transition matches the engine's state
  machine.
- Reconciliation against exchange state — `PaperReconciliationAdapter`
  is not exercised; the live `ExchangeAccountStateSource` path is.
- Rate-limit policy under harmless burst load (W1.4 token bucket against
  testnet REST + WS).

PAPER and TESTNET are complementary:
- **PAPER**: live-market operational + statistical soak.
- **TESTNET**: exchange execution-contract drill.

M11b begins only when **both** have passed. Soak runbook records this as
two independent green checks; ADR 0032 codifies the requirement.

## lowFidelity behaviour in PAPER (load-bearing for the soak gate)

M7's fill simulator currently sets `lowFidelity: true` on every fill (no
depth-aware extension yet). So **every v1 PAPER fill is `lowFidelity`** for
the duration of M11a. This changes how ADR 0019 criterion 12 and ADR 0029
§2.4 apply:

- The "two rankings — full-set + `lowFidelity`-excluded" rule is
  unsatisfiable on PAPER fills as written. The `lowFidelity`-excluded subset
  is empty for v1; the "same winner on both rankings" check is undefined.

- **Explicit downgrade.** If either side of the shadow comparison has an
  empty `lowFidelity`-excluded subset, the "active version beats shadow
  v2/v3" criterion is **automatically marked inconclusive** and the soak
  gate downgrades to "v1's own expectancy CI excludes zero" alone (same
  fail-safe as W4.2's missing-contracts downgrade). M11a §"Reduced
  evaluation gate" picks up this branch in the same fold-in pass.

- **Joint-test acknowledgement.** "v1's expectancy CI excludes zero" in
  PAPER is a joint test of `(strategy edge + M7 fill model bias)`, not of
  strategy edge alone. M11b's go-live decision must treat the PAPER CI as
  a **necessary but not sufficient** condition.

- **M11b gate hardening when all PAPER fills are `lowFidelity`** (gbt-
  review M1). A positive PAPER CI under an all-`lowFidelity` simulator
  is not strong enough on its own to justify scale-up. If the soak
  closes with every fill flagged `lowFidelity`, M11a's outcome is
  "operational soak passed, trading edge still provisional." Entering
  M11b then requires **one** of:
  1. The M7 depth-aware extension lands, the soak is rerun, and the
     `lowFidelity`-excluded ranking is non-empty + the comparison passes
     on both rankings.
  2. A **tightly capped live micro-probe** milestone (separately
     planned): $100–$200 of real capital, one position max, one to two
     weeks, with an explicit stop condition (drawdown ≥ 5%, ≥1
     reconciliation drift, ≥1 unhandled rejection from Binance).
     M11b proper begins only after the micro-probe completes without
     triggering its stop.
  3. An **architect-approved waiver** documented in ADR 0032 (or its
     successor), stating in writing that the first real-money period is
     still validation, not scale-up, and naming the operator who
     accepted the residual risk.

  This is recorded in the soak runbook as a hard branch at soak close:
  the soak's outcome bucket determines which of the three M11b entry
  paths is open. No silent "good enough" promotion.

- **Pre-soak sanity step (mandatory, asymmetric TOST equivalence).** Logic
  round-2 H1 + quant round-2 M2 introduced TOST. gbt-review M2 +
  gemini-review 3.4 flagged two problems with the v3 formulation:
  1. `ε = 25% of v1's backtested expectancy` is **circular** — if v1
     backtest is near zero, negative, or unstable, the tolerance becomes
     meaningless or impossible to satisfy. The simulator-bias tolerance
     should not depend on the edge the simulator is supposed to validate.
  2. The band was **symmetric**, which means a pessimistically-biased
     simulator (e.g. always 1 tick of slippage) gets rejected. But
     pessimistic bias is **safer** for a conservative bot than optimistic
     bias — over-rejecting pessimism is counter-productive.

  **v4 TOST procedure:**
  - Run the simulator over the prior 60 days of the same symbol universe
    with the known-zero-edge strategy (random entries respecting the
    restricted profile gates), and **additionally** a small panel of
    diverse zero-edge policies (random direction, alternating direction,
    spread-only entries) so the calibration is not anchored on one
    arbitrary process (gbt-review M2).
  - Compute the **90% CI on residual expectancy** in risk units:
    `residual_R = residual_expectancy / per_trade_risk_budget`.
  - Tolerance band, asymmetric:
    - `ε_upper = 0.05 R` (5% of per-trade risk; **strict on optimistic
      bias** — a simulator that flatters fills cannot pass).
    - `ε_lower = −0.15 R` (15% of per-trade risk; **looser on pessimistic
      bias** — pessimism is safe; the MDE calculations in the
      sample-size pre-flight must account for it).
  - The secondary cap (`|ε| ≤ 50% of v1's backtested expectancy`) is
    **removed entirely** in v5 (quant round-3 M4). The asymmetric primary
    band `[-0.15R, +0.05R]` in risk units is the load-bearing test; the
    secondary cap still leaked circularity through the back door
    (loose when simulator was upward-biased on backtest; waived when v1
    backtest was near zero). Risk-unit-only tolerance is cleaner.
  - **Pass criterion:** the 90% CI on `residual_R` must lie within
    `[ε_lower, ε_upper]`. The interval can extend further negative
    (pessimistic) than positive (optimistic).
  - If the CI is outside the band, the runbook documents the decision:
    extend the calibration window, or accept the soak as exploratory
    only with operator sign-off.
  - **Power check** to prevent trivial pass on small N: the calibration
    sample must produce at least 200 simulated fills, otherwise the test
    is inconclusive and the calibration window is extended.
  - **Calibration-window extension allowance (gemini r2 note)**: if the
    restricted profile is selective enough that 60 days does not produce
    200 calibration fills across the diverse zero-edge policy panel, the
    runbook permits extending the window to **90 or 120 days** for the
    TOST calibration only — provided the operator confirms market
    regimes over the extended window are comparable to the soak target
    period (no obvious regime break). The extension does not change the
    soak window itself; it only widens the calibration tape.

  This step lands in M11a §W4.4 alongside the existing calibration day.

- **v1 vs v0 reframing.** v0 is exactly zero with zero variance, so "v1's
  CI excludes zero from above" is a one-sided test against a degenerate
  null. This is a sanity floor, **not** evidence of edge. The load-bearing
  criterion is v1 vs shadow v2/v3 in **paired** difference (same
  simulator, same noise, simulator bias cancels). The local-soak plan's
  exit criteria gets reworded accordingly.

## Soak sample-size pre-flight (mandatory)

If `Var(simulator_noise) ≫ E[v1] − E[v2]`, the bootstrap CI never excludes
zero regardless of strategy edge. Required pre-soak step:

1. Run M7 over the same symbol universe + 60-day window.
2. Compute per-trade variance attributable to missed-fill + slippage rolls
   by holding strategy decisions fixed and varying only the simulator seed
   across N=1000 runs.
3. **Also report `Var(E[v1] − E[v2])` across the same N=1000 paired runs**
   (both strategies decide on the same tape, both go through the
   simulator). This is the paired-difference variance the soak's bootstrap
   actually estimates — the isolated noise estimate from step 2 alone
   under-estimates the real floor when missed-fill is correlated with
   adverse selection (quant round 2 M3).
4. Derive the minimum detectable effect size at n=80 with α=0.05 from the
   paired-difference variance.
5. If the MDE exceeds the historical between-version expectancy gap on
   backtest, the soak is statistically underpowered before it starts. The
   trade floor must be raised (or the soak is acknowledged as
   exploratory).

This step lands in W4.4 (calibration day).

## Scope of work — wave structure

### Wave R0 — Rename + ADR updates (shared + architect)

**R0.1 — Shared rename.** `bot-shared-maintainer` renames
`ExchangeEnvironmentEnum.DEMO` → `PAPER`. Updates `exchangeEnvironmentSchema`
Zod validator. Adds the `mode: 'paper' | 'live'` parameter to
`isKeyPermissionSnapshotAcceptable` per D8. No structural change beyond the
rename + parameter addition.

**R0.2 — ADR 0028 update.** `bot-architect` updates
`0028-key-permission-assertion-port.md`:
- §2.3 removes the false *"Demo trading reaches `fapi.binance.com`"* claim;
  reflects the testnet-alias reality.
- §2.4 enumerates the PAPER allowlist exactly per D8 (full predicate, only
  `enableFutures` differs).
- PAPER calls live `/sapi`; only TESTNET skips. PAPER + LIVE share the
  IP-restrict + non-expired-authority checks.
- Records D9 (PAPER does not require `LIVE_GO_AHEAD_TOKEN`).

**R0.3 — ADR 0032 (new) — PAPER mode architecture.** `bot-architect` authors:
- `PaperModeModule` containing `PaperExecutionClient`,
  `PaperFillSimulator`, `PaperAccountStateService`,
  `PaperReconciliationAdapter`, `PaperExchangeNullityProbe`,
  `PaperFundingAccrualService`.
- D1–D17 reproduced verbatim as the architectural decisions of the ADR.
- Compile-time split (D2) called out — `PaperExecutionClient` must not
  import the rate-limit module.
- DB schema for the full paper-sibling table set (per D16 + D17):
  - `paper_account_state` (current position state, no derived MTM column),
  - `paper_account_state_history` (closed-trade ledger),
  - `paper_account_state_meta` (non-secret derived metadata only — seed
    version label, HKDF info string version, simulator config hash,
    `soak_start_id`, `bootstrap_at_start_fingerprint`; **no secret
    material**, per D3 + D17),
  - `paper_account_snapshots` (audited equity snapshots feeding the
    drawdown abort path),
  - `paper_simulator_idempotency` (D3),
  - `paper_state_audit` (HMAC-chained mutation audit, per-purpose
    subkey),
  - `paper_crn_tape` (post-soak blob, content-hash-bound by the
    commitment row in `paper_state_audit`, per D17),
  - `boot_mode_history` (D6),
  - `boot_mode_chain_rotations` (D7).
- Cites M7's seed-locking ADR for the deterministic-PRNG rationale (D3).
- Transition matrix (D7) reproduced.

**R0.4 — ADR 0014 amendment** (new sub-task; architect, parallel to R0.3).
ADR 0014's phase-1 names the exchange as the source of truth. Amend phase 1
to read an `IBootStateSource` dispatched on `EXCHANGE_ENV` to
`ExchangeBootStateSource` (LIVE/TESTNET) or `PaperBootStateSource` (PAPER).
Other phases unchanged.

### Wave R1 — Strip the broken DEMO wiring (engine, ≤5 items)

**R1.1 — Strip `enableDemoTrading` and DEMO URL handling.**
`apps/engine/src/exchange/service/CcxtBinanceExchangeClient.ts` —
`selectEnvironmentUrls` drops the DEMO branch. TESTNET stays on
`setSandboxMode(true)`; PAPER uses the LIVE URL block (because market data
hits live `fapi.binance.com` in PAPER); LIVE unchanged. `enableDemoTrading`
call is removed entirely. **Add a sentinel test asserting
`enableDemoTrading` is never called in any environment** (regression guard
against silent resurrection).

**R1.2 — Update `LiveGoAheadVerifier` callers.** The two-token boot gate
stays for LIVE only. PAPER does not call it (D9).

**R1.3 — Update `.env.example`.** `EXCHANGE_ENV=` (no default) — comment
lists `testnet | paper | live`.

**R1.4 — Update `KeyPermissionAssertionService` for mode-aware allowlist.**
Three branches per updated ADR 0028:
- `TESTNET` → skip (audit `KEY_PERMISSION_ASSERTION_SKIPPED`, no exchange
  call).
- `PAPER` → call live `/sapi`, allowlist per D8 with `mode='paper'`.
- `LIVE` → call live `/sapi`, allowlist per D8 with `mode='live'` (existing
  behaviour).
Failure path unchanged: Telegram CRITICAL + audit row + `process.exit(1)`.

**R1.5 — Boot mode history HMAC chain.** Add the `boot_mode_history`
migration + entity + repository. Engine implements the **D6 boot
sequence verbatim** (verify chain integrity → on mismatch, check D7
transition matrix + verify transition token → either ABORT with zero
mutation or append TRANSITION + BOOT + rotation rows in a single
transaction). The mismatch path is not a hard abort — it is conditional
on whether an authorized transition exists per D7. R3.1 tests both
branches: unauthorized mismatch aborts without mutation; authorized
transition appends exactly one transition row + one boot row + one
rotation row, all atomically.

### Wave R2 — PAPER mode core (engine, MANDATORY split into R2a–R2d)

gbt-review M5: R2 as written is larger than the dev-qa-cycle ≤5-file soft
cap. The split is **mandatory**, not optional. Each sub-wave runs its own
QA + reviewer mini-pass before the next sub-wave dispatches.

#### R2a — Account-state port + execution-client split

- **R2a.1 — `IAccountStateSource` port (D14).** New port in shared.
  Two implementations: `ExchangeAccountStateSource` (LIVE/TESTNET),
  `PaperAccountStateSource` (PAPER).
- **R2a.2 — Rebind existing account-state callers.**
  `AccountSnapshotWriter`, reconciliation phase 1, funding cashflow
  readers, read-API account projections — all bind to
  `IAccountStateSource` instead of `IExchangeClient`. The exception list
  (callers still allowed to use `IExchangeClient`'s account-state
  methods directly in PAPER) is exactly two: `KeyPermissionAssertionService`
  and `PaperExchangeNullityProbe`.
- **R2a.3 — `IExecutionClient` split (D2).** Existing
  `CcxtBinanceExchangeClient` implements both. New `PaperExecutionClient`
  stub (R2c fills in the real logic). Module-level provider keyed on
  `exchange_env`. Compile-time guarantee: `PaperModeModule` does not
  import `RateLimitPolicyService`.
- **R2a.4 — No-ccxt-order sentinel + module-graph test.** Walks the DI
  graph from the live decision loop. Fails if any provider reachable
  from the live path can inject ccxt order methods, except the two
  whitelisted account-state probes.

QA mini-pass between R2a and R2b.

#### R2b — Paper account state + atomic persistence

- **R2b.1 — `paper_account_state` table + entity + repository (D1).**
- **R2b.2 — `paper_account_state_history` table** (sibling, closed-trade
  ledger).
- **R2b.3 — `paper_account_state_meta` table** (non-secret metadata
  only: seed version label, HKDF info version, simulator config hash,
  soak start timestamp — D3).
- **R2b.4 — `paper_account_snapshots` table** (sibling of
  `account_snapshots`).
- **R2b.5 — `paper_simulator_idempotency` table** (D3 idempotency
  ledger keyed by `(event_id, order_intent_id, version_namespace)`).
- **R2b.6 — `paper_state_audit` HMAC-chained mutation audit** (D6 +
  D16; per-purpose subkey from HKDF). Every mutation to
  `paper_account_state` + `paper_account_state_history` writes the audit
  row **in the same transaction**. R3.1 atomicity test asserts a crash
  between the writes is structurally impossible.
- **R2b.7 — `PaperAccountStateService` + `PaperAccountStateSource`.**
  Local source of truth per D16 (atomic three-table writes).
  Mark-to-market per D5 (throttled). Implements `IAccountStateSource`.

QA mini-pass between R2b and R2c.

#### R2c — Streaming fill simulator + funding + MTM

- **R2c.1 — `FillSimulatorCore` extracted to `@bot/shared`** (D15).
  Pure functions. Backtest equivalence regression test asserts
  pre-extraction and post-extraction M7 outputs match.
- **R2c.2 — `HistoricalFillAdapter` wires `BacktestRunnerService`
  to `FillSimulatorCore`** (preserves the M7 backtest interface).
- **R2c.3 — `StreamingFillAdapter` for PAPER (D15).** Subscribes to
  live ticks; evaluates intra-bar SL/TP **on tick arrival**, never via
  wall-clock `setTimeout` (D15 SL/TP rule). **Callback / subscription
  lifecycle (gemini r2 forward-looking note)**: every tick subscription
  and pending evaluator created for an open position is registered in a
  per-position cleanup set, and **explicitly released** on position close,
  cancel, or shutdown. R3.1 includes a long-running-soak memory-leak
  test that opens/closes 1000 positions and asserts the adapter's
  per-position registry is empty + total listener count stable.
- **R2c.4 — `PaperFillSimulator`** (delegates to
  `StreamingFillAdapter`). Causality test asserts no future-tick read.
- **R2c.5 — `PaperExecutionClient`** (D2 / D15 — real logic now).
  Routes order intents to `PaperFillSimulator`. Returns deterministic
  `IOrder` responses.
- **R2c.6 — `PaperFundingAccrualService`** (D4). Reuses live funding
  data (mark-price WS for next-funding metadata; funding-history REST
  at the funding-timestamp event). Applies rates per D4 sign convention.
  Magnitude warning + audit + CRITICAL alert (not hard reject) per D4.

QA mini-pass between R2c and R2d.

#### R2d — Reconciliation + nullity probe + crash recovery

- **R2d.1 — `PaperReconciliationAdapter`** (D12 + D16). Reconciles
  in-memory `PaperAccountStateService` against the persisted
  `paper_account_state` rows. Drift = CRITICAL halt.
- **R2d.2 — `PaperExchangeNullityProbe`** (D13). Two-call probe
  (`fetchOpenOrders` + `fetchPositions`); capability preflight at boot
  with three branches; runtime failure-class taxonomy.
- **R2d.3 — Crash-recovery integration.** Phase 1 in PAPER reads
  `PaperBootStateSource` (per amended ADR 0014). Boot verifies
  `boot_mode_history` chain per D6 boot sequence; refuses mode mismatch.
  Replay determinism: same decision tape produces byte-identical
  `simulated_fill` rows via the `paper_simulator_idempotency` table
  lookup.

QA mini-pass between R2d and R3 (final wave).

### Wave R3 — Tests + QA

**R3.1 — Adversarial coverage.** `bot-qa-engineer`:
- PAPER boot with `{enableReading, enableFutures}` key → assertion fails.
- PAPER boot with a TESTNET-fingerprinted last `boot_mode_history` row →
  aborts.
- PAPER boot with `EXCHANGE_ENV` unset → aborts (the W0.1 Zod schema
  already throws — regression guard).
- PAPER order placement never calls **any** execution method on ccxt
  (mock ccxt, assert zero calls on `createOrder`, `cancelOrder`,
  `cancelAllOrdersForSymbol`, `fetchOrderStatus`, plus the D2 surface —
  security round 2 L3). A missed mock must not silently let an execution
  call slip through.
- `enableDemoTrading` is never called in any environment (sentinel).
- PaperFillSimulator deterministic across SIGKILL replay via the
  `paper_simulator_idempotency` ledger keyed by
  `(event_id, order_intent_id, version_namespace)`: kill mid-trade,
  restart, every previously-recorded fill returns by ledger lookup
  (not by re-rolling) and is numerically equal to the pre-crash value
  per D15's whitelisted-tolerance equivalence (no byte-for-byte
  requirement on the persisted JSON).
- Funding accrual sign convention (per D4 account-PnL form):
  `LONG + rate>0 → funding_pnl < 0`; `SHORT + rate>0 → funding_pnl > 0`.
- Paper position closed at T−1ms before funding ts does not accrue.
- Mark-to-market: drawdown abort triggers intra-bar on a fast adverse
  move (no decision-boundary lag).
- `PaperReconciliationAdapter` drift between in-memory `PaperAccountStateService`
  and persisted `paper_account_state` rows (D16)
  emits CRITICAL (not WARNING) + halts.
- `PaperExchangeNullityProbe`: non-empty `fetchOpenOrders` triggers
  CRITICAL + halt; non-empty `fetchPositions` triggers CRITICAL + halt
  (catches the immediately-filled-and-closed leak case `fetchOpenOrders`
  alone misses — gemini-review 3.1).
- `PaperExchangeNullityProbe` boot capability preflight: 401/403 from
  the probe call aborts PAPER startup; transport-error path logs and
  continues; non-empty engine-attributed result halts.
- `PaperExchangeNullityProbe` mid-soak 401/403: CRITICAL halt + soak
  invalidated. Mid-soak transport error: backoff to 1/hr after 5
  consecutive failures.
- `boot_mode_history` HMAC chain: tampering with a row produces a chain
  verification failure on next boot.
- Pre-soak sanity step's TOST band rejects the start when the 90% CI on
  residual expectancy is not contained in `[−ε, +ε]`.
- Funding event coincident with adverse mark: ordering is
  apply_funding → recompute_unrealised → evaluate_abort; the abort
  decision incorporates the funding hit.
- $75 drawdown boundary test from peak equity fires the abort intra-bar.
- Funding `|rate| > 0.0075` writes audit row + CRITICAL alert, applies
  the rate (does not zero it).
- Soak fills replayable identically by an offline M7 run against the
  same decision tape (D3 cross-run determinism check; logic round 2 L1).
- `boot_mode_history` chain: tampering with a pre-rotation row after a
  bootstrap-secret rotation is detected via the `KEY_ROTATION_WITNESS`
  row (D6 rotation interaction).
- `seq` ordering protects against clock-skew row-insertion attacks.
- Mid-soak chain break → CRITICAL + halt + soak result invalidated.
- D7 transition: a single-use transition token cannot drive a second
  transition without rotating.
- **Boot ordering**: an unauthorized mode mismatch aborts with **zero**
  rows appended to `boot_mode_history` / `boot_mode_chain_rotations`.
  An authorized transition appends **exactly one** TRANSITION row +
  one BOOT row + one rotation row, all in **one transaction** (no
  partial state observable).
- **Causality (D15)**: at simulated time `t`, the `StreamingFillAdapter`
  cannot read tick or book-snapshot data with timestamp `> t`. Test
  feeds a clock-skewed fixture and asserts the produced `ISimulatedFill`
  does not depend on the future-tick portion.
- **Module-graph (D14)**: walks the DI graph from strategy → risk →
  execution. Fails if any non-whitelisted provider on that path can
  inject ccxt's order-placement or account-state methods directly.
- **Atomicity (D16)**: a synthetic crash injected between the
  `paper_account_state` mutation and the `paper_state_audit` row write
  leaves the database in a state where neither write is visible (single
  transaction, no partial commit).
- **TOST asymmetric bands**: an optimistic-biased simulator (residual
  > `ε_upper = +0.05R`) fails the gate; a pessimistic-biased one
  (residual between `ε_lower = −0.15R` and 0) passes.
- **TOST power floor**: a calibration window producing <200 fills
  produces an "inconclusive — extend window" outcome, not a trivial
  pass.
- **MTM throttle (D5)**: under a 1000 ticks/sec synthetic burst,
  per-symbol MTM completes within 100 ms; abort-threshold check fires
  within one throttle window of the trigger condition.
- **M7 backtest equivalence (D15 / R2c.1)**: pre-extraction and
  post-extraction backtest output match byte-for-byte on a fixed
  decision tape.
- **Idempotency ledger (D3)**: a re-issued order intent with the same
  `(event_id, order_intent_id, version_namespace)` returns the
  previously recorded `simulated_fill` verbatim; no second roll is
  performed.
- **CRN survives mid-soak bootstrap rotation (D17)**: bootstrap secret
  rotates via W1.8 during the soak; the CRN tape is still derivable
  post-soak from the captured `bootstrap_at_start` value (named in the
  runbook); offline evaluator's recomputed `crn_root` matches the
  commitment row.
- **CRN re-derivation attempt detected (D17)**: an attempt to rewrite
  the commitment row with a fresh `soak_start_ts` produces a chain HMAC
  mismatch; the soak is invalidated.
- **CRN skip-case pairing (D17)**: paired difference series excludes
  events where only one version traded; both-skip events excluded;
  both-trade events include the same simulator roll for both versions.
- **CRN inconclusive truth table (D17)**: when paired CRN CI is
  decisive and independent-noise CI straddles zero, the criterion is
  marked inconclusive (not pass-by-CRN-alone).
- **D14 runtime guard**: a synthetic service resolving `IExchangeClient`
  via `ModuleRef.get` and calling `fetchBalance` throws
  `UnauthorizedLiveAccountStateCallException`. CI ESLint gate fails
  if `ModuleRef.get(IExchangeClient)` appears outside the whitelist.
- **D16 unrealised_pnl is derived**: the `paper_account_state` row has
  no `unrealised_pnl` column; drawdown abort reads compute it from
  `(position, mark_price)` at evaluation time; an attempt to "tamper"
  it has nothing to write to.
- **D7 LIVE→PAPER predicate sees real positions**: with simulated
  open live positions on the prior LIVE key, the transition-time
  `ExchangeAccountStateSource(prior_env_credentials)` returns them and
  the transition is rejected.
- **D6 audit HMAC includes assigned seq**: CTE / RETURNING test —
  the HMAC computed against a row's pre-allocation payload (without
  seq) does not match the persisted HMAC; only the post-allocation
  payload reproduces it.
- **D5 cold start**: peak_equity at t=0 equals
  `PAPER_STARTING_EQUITY_USDT`, not the first MTM reading.
- **D15 SL/TP event-driven**: replaying a tick stream against a fixed
  position fires SL on the tick boundary, not on a wall-clock delay.
- **D4 funding force-flushes throttle**: funding event coincident
  with adverse mark inside an MTM throttle window triggers immediate
  `apply_funding + recompute + evaluate_abort` (no 100 ms delay).

### Wave R4 — Reviewer round + scribe

**R4.1 — Reviewer round** on R0–R3 (security + logic + quant + clean-code;
devops if compose changes).

**R4.2 — Scribe.** Merge this addendum into `M11a-local-soak.md` (replace
W1.1 wording with the PAPER design; integrate D10 / lowFidelity / pre-soak
sanity into §"Reduced evaluation gate" + §"Minimum trade count" + §W4.4).
Delete this addendum file. **Preserve anchor IDs D1–D17** (logic round 2 L3)
in the merged content so existing cross-references survive. Update
`CLAUDE.md` status. Append a single work-log line referencing the merged
commit.

## Migration of work already landed

| Component | Status | Action |
|-----------|--------|--------|
| `ExchangeEnvironmentEnum` | Landed with `DEMO` | Rename `DEMO` → `PAPER` (R0.1) |
| `exchangeEnvironmentSchema` | Landed | Rename literal (R0.1) |
| `IKeyPermissionSnapshot` | Landed | Unchanged |
| `isKeyPermissionSnapshotAcceptable` | Landed (LIVE allowlist) | Add `mode` param per D8 (R0.1) |
| `AuthFailureReasonEnum.BAD_SIGNATURE` | Landed | Unchanged |
| `ILiveModeProfile` | Landed | Unchanged |
| `IShadowDecision` / `ISimulatedFill` / `IVirtualPositionLedger` | Landed | Reused by PAPER + shadow alike |
| `IExchangeNotInDbDriftEvent` | Landed | Reused for PAPER reconciliation drift |
| ADR 0028 | Landed | Update §2.3 + §2.4 per R0.2 |
| ADR 0029 | Landed | Unchanged |
| ADR 0030 | Landed | Unchanged. PAPER never reaches it. Compile-time split (D2) enforces. |
| ADR 0031 | Landed | Unchanged |
| ADR 0014 | Landed (M6) | Phase-1 amendment per R0.4 |
| `CcxtBinanceExchangeClient.selectEnvironmentUrls` | Landed with DEMO branch | Strip DEMO; PAPER uses LIVE URLs (R1.1) |
| `LiveGoAheadVerifier` | Landed | Unchanged (LIVE-only per D9) |
| `KeyPermissionAssertionService` | Landed (TESTNET/DEMO/LIVE branches) | Rewrite branches per R1.4 |
| `RateLimitPolicyService` | Landed | Unchanged. Compile-time split (D2). |
| `LoginRateLimiter` / `DerivedKeyService` / `RevokedJtiPruneScheduler` | Landed | Unchanged |
| W1 QA adversarial tests | Landed | Tests asserting `DEMO`-specific behaviour rewritten for `PAPER`; tests asserting `enableDemoTrading()` is called → deleted + replaced with sentinel asserting never-called. |

## Risks

- **Scope creep.** R0–R3 add ~8 new engine modules + 1 ADR + 4 new tables
  + 1 ADR amendment + contract changes. Realistic effort: comparable to
  or slightly larger than the original W1. R2 is **mandatorily** split
  four-way (R2a/R2b/R2c/R2d) per the QA cadence section above; ADR 0032
  covers D1–D17; 7 new tables; FillSimulatorCore extraction (D15)
  touches the M7 backtest path.
- **PaperFillSimulator inherits M7's `lowFidelity` flag.** Mitigated by
  the lowFidelity-empty-subset downgrade + pre-soak sanity step + joint-
  test acknowledgement.
- **State surface grows.** Three new tables + HMAC-chained audits. Crash
  recovery's phase 1 dispatches on env. Mitigation: ADR 0014 amendment
  + R3.1 SIGKILL drill.
- **Mode-switch silent data loss.** Mitigated by D6 HMAC chain + D7
  transition matrix + R1.5 boot integrity check.
- **One-time rename churn.** Renaming DEMO → PAPER touches ~10 files. Low
  technical risk. Single shared-maintainer dispatch (R0.1), single engine
  dispatch (R1).

## Definition of done

The PAPER mode is complete when:

- `ExchangeEnvironmentEnum` is `{TESTNET, PAPER, LIVE}`.
- ADR 0028 reflects the corrected understanding + PAPER allowlist (D8).
- ADR 0032 locks PAPER mode architecture with D1–D17 inline.
- ADR 0014 phase-1 amended for `IBootStateSource` dispatch.
- A PAPER boot:
  - rejects any key with capability flags beyond `enableReading` (CRITICAL
    alert + audit + exit);
  - verifies `boot_mode_history` HMAC chain + matches `EXCHANGE_ENV`;
  - subscribes to **live** market data;
  - never calls `ccxt.createOrder` / `cancelOrder` / order-placement
    methods (sentinel test enforces);
  - simulates fills deterministically via `PaperFillSimulator` (HMAC seed
    schema, M7 config-hash-pinned);
  - reconciles **in-memory `PaperAccountStateService` against persisted
    `paper_account_state` rows** (drift = CRITICAL halt — D12 + D16); 
    `PaperExchangeNullityProbe` asserts **both** `fetchOpenOrders` AND
    `fetchPositions` empty (engine-attributed, with capability preflight
    + failure-class taxonomy per D13);
  - applies live funding rates with correct side-sign convention +
    mark-to-market notional; **magnitude bound is audited + alerted,
    not enforced** (raw rate still applied — D4);
  - evaluates derived unrealised PnL within D5's throttled cadence
    (coalesced once per 100 ms, or immediately on a >=1 tick-size move,
    or on a funding-event force-flush); drawdown abort reads against
    audited `peak_equity` from `paper_account_snapshots` per D16, fires
    within one MTM-throttle window of the trigger condition;
  - recovers from a SIGKILL mid-trade via the
    `paper_simulator_idempotency` ledger (numerical equivalence per
    D15's whitelisted-tolerance rule, not byte-for-byte);
  - refuses to silently switch to TESTNET or LIVE if any condition in D7
    fails.
- Pre-soak sanity step (asymmetric TOST equivalence per the updated
  formulation) passes the calibration window.
- Adversarial QA (R3.1) covering each path passes, including the
  causality test (R3.1 asserts `PaperFillSimulator` cannot read future
  ticks/book data), the module-graph test (no provider reachable from
  the live decision loop can inject ccxt order methods), the atomicity
  test (paper account mutations + history + audit row written in one
  transaction; a mid-write crash leaves the state structurally
  consistent), the nullity-probe capability preflight branches, the
  authorized-vs-unauthorized boot-mode transition path tests, and the
  M7 backtest equivalence regression test after `FillSimulatorCore`
  extraction.
- Reviewer round (R4.1) green (zero blockers, zero highs).
- **TESTNET pre-M11b drill** complete (separate gate): order lifecycle
  + reconciliation against exchange + rate-limit policy under burst
  load — all green.
- Soak outcome bucket recorded explicitly:
  - "operational + edge confirmed" (depth-aware extension landed, both
    rankings pass), OR
  - "operational only, edge provisional" (all `lowFidelity`; entry to
    M11b requires depth-aware rerun, live micro-probe milestone, or
    architect waiver per the three-branch rule in the lowFidelity
    section).
- Scribe (R4.2) merged this addendum into `M11a-local-soak.md` + deleted
  this file, preserving D1–D17 anchor IDs.

Only on full pass does the soak enter the proper W4 start (calibration
day + drill + restricted-profile commit). And only on full pass + TESTNET
drill green + soak outcome bucket resolved does M11a release to M11b.
