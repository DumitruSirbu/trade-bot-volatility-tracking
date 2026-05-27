# ADR 0028 — Key-permission assertion port (M11a)

**Status:** Accepted (M11a W0 design wave); amended 2026-05-26 by the M11a paper-mode addendum (R0.2) to reflect the `DEMO` → `PAPER` course correction.
**Date:** 2026-05-25 (amended 2026-05-26)
**Milestone:** M11a — Local soak hardening
**Depends on:** M11a W0.1 (`ExchangeEnvironmentEnum`), M11a W0.3 (`ILiveModeProfile`), ADR 0024 (Telegram alerts), ADR 0025 (startup schema-validation gate). Sibling: ADR 0032 (PAPER mode architecture).
**Consumed by:** M11a W0.2 (shared interface + DTO), M11a W1.2 (`verifyKeyPermissionsOrAbort` on boot), M11a R1.4 (PAPER mode-aware branch).
**Round-2 security escalation:** allowlist-not-denylist semantics.

## Amendment log

- **2026-05-27 (post-R4 live-smoke):** §2.2 and §2.4 amended to reflect bugs caught in smoke: (1) `/sapi/v1/account/apiRestrictions/ipRestriction` endpoint was **discontinued by Binance on 2021-11-17** — removed from provider table; only surviving `/sapi/v1/account/apiRestrictions` is now documented. (2) Sub-account vs master-account response shape divergence: Binance omits sub-account-irrelevant fields (`enableSubAccountManagement`, `enableWithdrawals`, `enableInternalTransfer`, `enableMargin`, `enableVanillaOptions`, `permitsUniversalTransfer`) from sub-account key responses. §2.4 defaults updated: sub-account-irrelevant fields now default to `false` (was `true`); `tradingAuthorityExpirationTime` marked optional (null acceptable when Binance omits for sub-accounts). Trade-off documented: this lowers safety floor for LIVE if Binance master-account response shape ever omits a field; **Pre-M11b validation required** before LIVE go-live (verify LIVE master-account response includes all expected fields per Binance docs). Amendment-log entry added.
- **2026-05-26 (R0.4, Fallback Profile promotion):** §2.4 amended to document the operative Fallback Profile (dedicated zero-balance sub-account with `enableFutures: true`, resolved by gbt R2-M1 endpoint-accessibility blocker). Cross-reference ADR 0032 §D8 for the full specification. Added note that R1.4 will reconcile the mismatch between the predicate's `mode = 'paper'` baseline and the operative profile.
- **2026-05-26 (R0.2, paper-mode addendum):** §2.3 rewritten — `DEMO` is renamed to `PAPER`; the prior claim that "demo trading reaches `fapi.binance.com`" is removed (it conflated Binance USDT-M Futures demo trading with the testnet alias `demo-fapi.binance.com`). §2.4 extended with a `mode: 'paper' | 'live'` parameter (D8) so PAPER **rejects** `enableFutures: true` while sharing the rest of the allowlist with LIVE. §2.5 records that `LIVE_GO_AHEAD_TOKEN` is LIVE-only (D9) — PAPER's read-only-only assertion is its safety teeth. PAPER calls live `/sapi`; only TESTNET skips.

## 1. Context

M11a W1.2 requires the engine to refuse to boot under DEMO or LIVE unless the
configured exchange API key carries **exactly** `{ enableReading, enableFutures }`
plus a non-empty IP allow-list and a non-expired trading authority. The previous
draft (M11 single-wave) leaned on the human checklist in the runbook — round-2
security review escalated this to a startup-blocking allowlist check because:

- A misconfigured key with `enableWithdrawals` or `enableInternalTransfer` makes
  a key leak catastrophic; the runbook alone is one operator-error away from
  full loss.
- A denylist (refuse only when `enableWithdrawals` is true) silently passes any
  Binance-side capability added in a future API tier (e.g. a new
  `enableFiatPayment` flag), defeating the check forever.
- An allowlist forces the engine to fail-closed on any unknown future flag —
  the operator must whitelist it explicitly before boot.

ccxt 4.5.x does **not** uniformly surface Binance futures key restrictions
through a unified method. The relevant restriction endpoints live on the spot
(`/sapi`) plumbing — `sapiGetAccountApiRestrictions` and
`sapiGetAccountApiRestrictionsIpRestriction`. The futures-private endpoint
`fapiPrivateGetApiTradingStatus` returns trading-status-only (locked/banned),
not the capability bitset. ccxt 4.5.54 source confirms (verified against
`node_modules/ccxt/dist/cjs/src/binance.js` lines 365–477 and 855–897, and
`sapiGetAccountApiRestrictionsIpRestriction` at line 371):

| Endpoint | ccxt method | What it returns |
|---|---|---|
| `GET /sapi/v1/account/apiRestrictions` | `sapiGetAccountApiRestrictions()` | The capability bitset: `enableReading`, `enableSpotAndMarginTrading`, `enableMargin`, `enableFutures`, `enableWithdrawals`, `enableInternalTransfer`, `permitsUniversalTransfer`, `enableVanillaOptions`, `enableSubAccountManagement`, `enableSpot` (alias of `enableSpotAndMarginTrading` on newer accounts), `ipRestrict`, `tradingAuthorityExpirationTime`, `createTime` |
| `GET /sapi/v1/account/apiRestrictions/ipRestriction` | `sapiGetAccountApiRestrictionsIpRestriction()` | The current IP allow-list state: `ipRestrict`, `ipList[]`, `updateTime` |
| `GET /fapi/v1/apiTradingStatus` | `fapiPrivateGetApiTradingStatus()` | Per-symbol futures trading-status (locked/banned reasons). Out of scope for this ADR — not a capability gate. |

Both `sapi*` endpoints are reachable with a **futures-only** key: Binance gates
them on key-existence and account-level access, not on the spot trading scope
itself. Empirically a `{ enableReading, enableFutures }` key signs and reads
both endpoints (any auth failure here is itself a fail-closed signal — see §2.5).
This is the load-bearing assumption that makes a single unified port possible.

The shared port `IExchangeClient.fetchKeyPermissions()` must abstract this
multi-endpoint merge so `verifyKeyPermissionsOrAbort` reads exactly one snapshot
and the engine has a single chokepoint to swap if Binance retires either
endpoint mid-soak.

This ADR locks the shape; `bot-shared-maintainer` implements TypeScript in W0.

## 2. Decision

### 2.1 Shared snapshot DTO — `IKeyPermissionSnapshot`

Declared in `packages/shared/`. Boundary type — every field is concrete, every
boolean is non-optional (no `undefined`; missing-from-payload coerces to a
conservative value documented per-field).

```ts
interface IKeyPermissionSnapshot {
  // --- capability bits, sapiGetAccountApiRestrictions ---
  enableReading: boolean;                 // expected true under allowlist
  enableFutures: boolean;                 // expected true under allowlist
  enableSpot: boolean;                    // expected false (alias of enableSpotAndMarginTrading; merge both sources, take logical OR)
  enableWithdrawals: boolean;             // expected false
  enableInternalTransfer: boolean;        // expected false
  permitsUniversalTransfer: boolean;      // expected false
  enableMargin: boolean;                  // expected false
  enableVanillaOptions: boolean;          // expected false
  enableSubAccountManagement: boolean;    // expected false

  // --- IP allow-list, MERGED from both endpoints ---
  ipRestrict: boolean;                    // true iff IP restriction is enforced; merge sapiGetAccountApiRestrictions.ipRestrict with sapiGetAccountApiRestrictionsIpRestriction.ipRestrict via logical AND
  ipAllowList: readonly string[];         // sapiGetAccountApiRestrictionsIpRestriction.ipList; never null — empty array if not present in payload

  // --- trading-authority expiry ---
  tradingAuthorityExpirationTime: number | null; // epoch ms; null means "no expiry configured" -> treated as expired under allowlist (see §2.4)

  // --- provenance ---
  fetchedAtMs: number;                    // server-side clock from the engine boundary at fetch completion; used only for audit, never as a freshness gate
  sourceEndpoints: readonly string[];     // ['sapiGetAccountApiRestrictions', 'sapiGetAccountApiRestrictionsIpRestriction']; lets the audit row name the providers
}
```

**No `unknown` / `any` / index signature.** Fields not in the ccxt payload
default to the conservative value per the §2.2 table; an attacker injecting a
new flag through a man-in-the-middle proxy cannot smuggle a capability past the
allowlist by virtue of an unknown name.

**No raw `info` blob is exported.** The boundary mapper reads `response.info`
internally (ccxt parks venue-specific fields there), maps each known key into
the typed surface, and **drops the rest**. Any field present in `info` but not
in `IKeyPermissionSnapshot` is logged at DEBUG with the field name only (no
value) and discarded. Logging field-names-only catches genuine Binance API
surface expansion without leaking key state.

### 2.2 Port — `IExchangeClient.fetchKeyPermissions()`

Added to `apps/engine/src/exchange/interface/IExchangeClient.ts`:

```ts
interface IExchangeClient {
  // ... existing methods unchanged ...

  // M11a W1.2: capability snapshot for the startup allowlist gate.
  // Implementations MUST merge sapiGetAccountApiRestrictions +
  // sapiGetAccountApiRestrictionsIpRestriction in a single call. Throws
  // ExchangeRequestException on any underlying ccxt failure (the caller
  // treats that as assertion-failure, never as "skip and continue" — see §2.5).
  fetchKeyPermissions(): Promise<IKeyPermissionSnapshot>;
}
```

**Per-field provider table** — which call populates which field:

| Field | Endpoint | Default-when-missing |
|---|---|---|
| `enableReading` | `sapiGetAccountApiRestrictions.enableReading` | `false` |
| `enableFutures` | `sapiGetAccountApiRestrictions.enableFutures` | `false` |
| `enableSpot` | `sapiGetAccountApiRestrictions.enableSpotAndMarginTrading OR sapiGetAccountApiRestrictions.enableSpot` | `false` (so a key that lacks the field treats spot as off; the allowlist still passes because the expected value is `false`) |
| `enableWithdrawals` | `sapiGetAccountApiRestrictions.enableWithdrawals` | `false` — **amended post-smoke**: Binance omits this field for sub-account keys (they structurally cannot have withdrawals). Master-account keys always include the field; sub-account keys omit it. Omitted ≠ unsafe for sub-accounts. |
| `enableInternalTransfer` | `sapiGetAccountApiRestrictions.enableInternalTransfer` | `false` — **amended post-smoke**: omitted for sub-accounts; default changed from `true` to `false` to match sub-account structural constraint. |
| `permitsUniversalTransfer` | `sapiGetAccountApiRestrictions.permitsUniversalTransfer` | `false` — **amended post-smoke**: omitted for sub-accounts; default changed from `true`. |
| `enableMargin` | `sapiGetAccountApiRestrictions.enableMargin` | `false` — **amended post-smoke**: omitted for sub-accounts; default changed from `true`. |
| `enableVanillaOptions` | `sapiGetAccountApiRestrictions.enableVanillaOptions` | `false` — **amended post-smoke**: omitted for sub-accounts; default changed from `true`. |
| `enableSubAccountManagement` | `sapiGetAccountApiRestrictions.enableSubAccountManagement` | **REMOVED** — not a real `/sapi/v1/account/apiRestrictions` response field; engine added speculatively. Not validated in allowlist. |
| `ipRestrict` | `sapiGetAccountApiRestrictions.ipRestrict` only (DEPRECATED: second endpoint `/sapi/v1/account/apiRestrictions/ipRestriction` was discontinued by Binance 2021-11-17 and no longer called) | `false` (conservative — fails allowlist) |
| `ipAllowList` | Surviving endpoint's `sapiGetAccountApiRestrictions` does **not** expose the IP list. Only Binance UI exposes actual IPs. | `[]` (conservative — fails allowlist). Operator verifies IP allow-list via Binance UI per runbook. |
| `tradingAuthorityExpirationTime` | `sapiGetAccountApiRestrictions.tradingAuthorityExpirationTime` (epoch ms or `-1` per Binance docs) | `null` — **amended post-smoke**: marked optional (null accepted when Binance omits for sub-accounts). Treated as expired in §2.4 when null or in the past. |

**Default-when-missing rule:** for capabilities the allowlist expects to be
`false`, missing-means-`true`. For capabilities the allowlist expects to be
`true`, missing-means-`false`. The rule collapses to one sentence: *missing
fields fail the allowlist.*

**Binance `-1` sentinel for `tradingAuthorityExpirationTime`:** the API uses
`-1` to mean "never expires." The mapper translates `-1` to **`null`**, which
the allowlist (§2.4) treats as expired. Rationale: a non-expiring trading
authority on a trading key is itself a posture failure for a multi-week soak —
the operator must rotate periodically, and "never expires" is indistinguishable
from "key was issued with the wrong scope choice" without a runbook check the
ADR cannot enforce. If a future operational requirement forces non-expiring
keys, it lands as a new explicit `tradingAuthorityNeverExpires: true` flag on
the snapshot and a separate ADR amendment — not by silently accepting `-1`.

### 2.3 TESTNET exemption (PAPER and LIVE both call live `/sapi`)

The Binance testnet at `testnet.binancefuture.com` returns HTTP 404 / 401 / a
permission-error for `sapiGetAccountApiRestrictions` because the spot endpoints
do not exist on the futures testnet host. ccxt's `enableDemoTrading(true)`
swaps `urls.api` to a `urls.demo` block that is an **alias of the testnet
host** (`demo-fapi.binance.com === testnet.binancefuture.com` for USDT-M
Futures — confirmed against the Binance developer docs and ccxt 4.5.54
source). There is no separate Binance-hosted paper-trading endpoint for
USDT-M Futures. The assertion is therefore exempted on TESTNET only; PAPER
and LIVE both call live `/sapi`.

**Exemption shape (post-amendment):**

- `verifyKeyPermissionsOrAbort()` reads `ExchangeEnvironmentEnum` (W0.1) via
  `AppConfigService`. Three branches:

  - `ExchangeEnvironmentEnum.TESTNET` → the function does **not** call
    `fetchKeyPermissions()` at all. It logs a single line at WARN level
    (`"key-permission assertion: TESTNET exemption — endpoint not surfaced on testnet host"`),
    writes one `control_audit` row with `action='KEY_PERMISSION_ASSERTION_SKIPPED'`,
    `reason='TESTNET_EXEMPT'`, and returns. No Telegram alert (testnet boots
    are routine and an alert would train operators to ignore it).
  - `ExchangeEnvironmentEnum.PAPER` → calls `fetchKeyPermissions()` against
    the **live** `/sapi` host (PAPER is engine-local paper trading — market
    data hits live `fapi.binance.com` and the configured PAPER key signs
    the same `/sapi` reads a LIVE key does). Applies §2.4 with
    `mode = 'paper'`: PAPER **rejects** `enableFutures: true`. Same IP-restrict
    and non-expired trading-authority requirements as LIVE. The fallback
    profile in ADR 0032 §D8 (zero-balance dedicated sub-account with
    `enableFutures: true`) is the documented exception — applied only when
    endpoint-accessibility verification rules it required, and additionally
    asserted by the D13 nullity probe at runtime.
  - `ExchangeEnvironmentEnum.LIVE` → calls `fetchKeyPermissions()` and
    applies §2.4 with `mode = 'live'` verbatim. The two-token
    `LIVE_GO_AHEAD_TOKEN` gate (W0.1) is additionally required for LIVE,
    not for PAPER (see §2.5 and D9 in ADR 0032).

**Misconfig defence (cross-cutting with W0.1):** the exemption is keyed
**only** on `ExchangeEnvironmentEnum.TESTNET`. The enum is loaded once at boot
via `AppConfigService`, validated against the live-go-ahead two-token rule
from W0.1, and **not re-read** by the assertion. A misconfigured operator
flipping `EXCHANGE_ENV` post-boot cannot extend the exemption, because the
engine restarts under the new value and the relevant token gate fires (LIVE's
`LIVE_GO_AHEAD_TOKEN`, or D7's transition-matrix token for PAPER↔TESTNET↔LIVE
crossings recorded in `boot_mode_history`; see ADR 0032 §D6/§D7).
Additionally, `verifyKeyPermissionsOrAbort()` MUST cross-check that the
resolved environment string baked into the boot Telegram alert (W0.1) matches
the value the assertion read; any mismatch is itself an abort. This catches
the failure mode "config loaded TESTNET but a hot-reload mutated the enum
in-process."

### 2.4 Allowlist predicate (mode-aware, per D8 & Fallback Profile)

Single boolean expression — the entire predicate fits on screen so a security
reviewer audits it in one read. Implemented as a pure function in `packages/
shared/` consuming `IKeyPermissionSnapshot` + a `nowMs: number` argument
+ a `mode: 'paper' | 'live'` selector (injectable for test, never reads
`Date.now()` inside the function — keeps the predicate deterministic per
the project's purity rule). The `mode` parameter is the **only** shape
difference between PAPER and LIVE allowlists; every other clause is shared:

```ts
function isKeyPermissionSnapshotAcceptable(
  snapshot: IKeyPermissionSnapshot,
  nowMs: number,
  options: { mode: 'paper' | 'live' },
): boolean {
  return (
    snapshot.enableReading === true &&
    snapshot.enableFutures === (options.mode === 'live') &&  // PAPER baseline rejects enableFutures: true
    snapshot.enableSpot === false &&
    snapshot.enableWithdrawals === false &&
    snapshot.enableInternalTransfer === false &&
    snapshot.permitsUniversalTransfer === false &&
    snapshot.enableMargin === false &&
    snapshot.enableVanillaOptions === false &&
    snapshot.enableSubAccountManagement === false &&
    snapshot.ipRestrict === true &&
    snapshot.ipAllowList.length > 0 &&
    snapshot.tradingAuthorityExpirationTime !== null &&
    snapshot.tradingAuthorityExpirationTime > nowMs
  );
}
```

**Per-mode interpretation:**

- **`mode = 'live'`** — `enableFutures === true` (the key must be tradeable).
  All other clauses identical to the original LIVE predicate.
- **`mode = 'paper'`** — `enableFutures === false` (a tradeable key paired
  with PAPER is a **hard error**, not silent permission — the safety teeth
  PAPER substitutes for the missing `LIVE_GO_AHEAD_TOKEN` gate per §2.5).
  IP-restrict + non-empty allow-list + non-expired trading authority remain
  required: a read-only key on unrestricted IP is still a credential-replay
  risk against the account-state endpoints.

**Operative Fallback Profile (gbt R2-M1 resolved).** Endpoint-accessibility
verification (ADR 0032 §D8, resolved 2026-05-26) determined that Binance's
signed `/fapi` endpoints required by D13's nullity probe require the
`enableFutures` permission. The operative PAPER mode runs under a **dedicated
zero-balance sub-account** with `enableFutures: true`, gated by D13's
extended runtime invariants (zero balance, zero positions, zero open orders,
no transfer permissions, IP-restrict, non-expired trading authority).
See ADR 0032 §D8 for the full Fallback Profile specification and D13 for
the sub-account invariants. R1.4 will reconcile the mismatch between this
predicate's `mode = 'paper' → enableFutures: false` baseline and the
operative `enableFutures: true` Fallback Profile.

**Why allowlist, not denylist** (round-2 security):

- A denylist enumerates *forbidden* capabilities. Any capability Binance adds
  to the apiRestrictions payload post-soak-start that the denylist did not
  name silently passes. The blast radius of "any future Binance flag" is
  unbounded — past additions have included options, sub-account control,
  universal transfer, internal transfer; future additions could include
  withdraw-to-fiat or staking authority.
- An allowlist enumerates *required-true* + *required-false* capabilities.
  Any new flag (true or false) trips the predicate by virtue of not being
  named. Operator response is forced into the open: read the new flag, decide
  if it changes the trust posture, amend this ADR, redeploy.
- Cost of the allowlist: a Binance-side rename of a flag from
  `enableInternalTransfer` to (say) `enableInternalTransferV2` breaks the
  boot until the operator updates the mapper. This is acceptable — a silent
  pass would be worse, and ccxt's release notes surface such renames.

The predicate **only** uses the snapshot — no environment variable, no
operator-toggleable override. There is intentionally **no escape hatch in
config to disable the assertion**. The only way to boot PAPER/LIVE without
passing is to take a code path off (which a code review catches) or to lie
about `ExchangeEnvironmentEnum` (which W0.1's two-token gate catches).

### 2.5 `LIVE_GO_AHEAD_TOKEN` scope (D9 — PAPER does not require it)

The two-token `LIVE_GO_AHEAD_TOKEN` gate from W0.1 is **LIVE-only**. PAPER
does not call it and `LiveGoAheadVerifier` is not invoked on PAPER boots
(per ADR 0032 §D9 — locked decision, not an open question).

Rationale: PAPER never reaches real-money execution because order intents
are intercepted by `PaperExecutionClient` and routed to
`PaperFillSimulator` (ADR 0032 §D2/§D15). The safety teeth that prevent
"PAPER is silently treated as LIVE" therefore live in this ADR's
`mode = 'paper'` predicate — a tradeable key paired with PAPER fails the
allowlist and halts boot — combined with the D6 `boot_mode_history`
HMAC-chain mode-switch predicate. A `LIVE_GO_AHEAD_TOKEN` requirement on
PAPER would add no safety beyond the allowlist gate (a leaked PAPER key
cannot place real orders even if PAPER boot succeeded with a misconfigured
mode), and would train operators to handle the go-ahead token routinely —
defeating its purpose as a deliberate friction step before live exposure.

A future reader must not re-introduce a PAPER token gate by analogy to
LIVE. The transition matrix in ADR 0032 §D7 is the correct primitive for
gating PAPER↔LIVE crossings (each crossing carries its own single-use
transition token recorded in `boot_mode_chain_rotations`).

### 2.6 Failure path

`verifyKeyPermissionsOrAbort()` is called from the engine's bootstrap before
any module that touches the exchange (ExchangeModule constructor, ExecutionService,
ReconciliationService). The expected boot order is:

1. `AppConfigService` loaded and validated (W0.1 two-token check for LIVE).
2. Database connection established.
3. `verifyKeyPermissionsOrAbort()` — this ADR.
4. ExchangeModule + downstream wiring.

On failure (predicate returns `false`, or `fetchKeyPermissions()` throws, or
the TESTNET/PAPER/LIVE cross-check from §2.3 fails):

- **Process exits with non-zero status.** Not a logged-and-continue, not a
  "halt the trade loop but stay up." The engine refuses to be a long-running
  process under a misconfigured key. Exit code is documented in the runbook;
  Docker compose treats the exit as a failed health-start (W3.7 `start_period`
  is unaffected — the failure happens before the health probe starts).
- **One Telegram CRITICAL alert** fires via the W0.1 boot-alert path (the
  same channel that announces the resolved env + key fingerprint), with body:

  ```
  KEY PERMISSION ASSERTION FAILED — engine refuses to start.
  Env: PAPER|LIVE
  Key fingerprint: <first4>...<last4>
  Reasons: <comma-separated list of failing predicate clauses>
  ```

  The reasons list names which clauses of §2.4 returned false (e.g.
  `enableWithdrawals=true, ipAllowList.length=0`). It does **not** echo the
  IP allow-list contents, the trading-authority expiry timestamp, or any
  other snapshot value beyond the boolean clause outcome. Field names only.
- **One `control_audit` row** is written before exit, with:
  - `action='KEY_PERMISSION_ASSERTION_FAILED'`
  - `actor_sub='system'`
  - `source_ip=null`
  - `reason` = same comma-separated clause list as the Telegram body
  - `previous_state` / `new_state` carry the boot halt state (always
    `HALTED` pre-boot)
  - A `snapshot_redacted` JSONB column: the full snapshot with every
    `enable*` boolean preserved, `ipAllowList` replaced with `["<redacted: N entries>"]`,
    `tradingAuthorityExpirationTime` replaced with `"<redacted: epoch>"`, and
    `fetchedAtMs` preserved. The auditor knows which capability tripped, the
    operator knows the count of IPs and that an expiry exists; neither
    learns the secret values from this row alone.

  The audit-write uses the same transactional semantics as the M9 halt audit:
  if the database write fails, the engine still exits, and the failure is
  logged to stderr with the same reasons string. The Telegram alert is the
  ultimate fallback — the audit row is best-effort under boot-time DB
  unreachability.
- **`fetchKeyPermissions()` throwing is itself a failure.** A network error,
  a 401 from Binance, a ccxt parse error — all map to "assertion failed,
  exit." A misconfigured key that cannot read its own restrictions
  endpoint is not a key the engine trusts.

There is no retry loop. A flaky boot under a transient Binance outage is
acceptable; the engine restarts under Docker compose's `restart: on-failure`
and tries again on the next supervisor cycle.

## 3. Consequences

- **Boot becomes strictly gated on a network round-trip to Binance.** A
  Binance API-side outage prevents boot. This is acceptable for a soak: if
  the assertion endpoint is unreachable, the bot cannot validate its trust
  posture and should not be trading.
- **Mapper is the single point of truth for the field set.** Adding a flag
  to the allowlist (e.g. when Binance ships a new capability the operator
  decides to allow-false) is a three-line edit: extend the DTO, extend the
  predicate, extend the mapper. A reviewer sees all three sites in one diff.
- **TESTNET / PAPER / LIVE divergence is one switch in one function.** Audit
  is straightforward; the "did PAPER just get treated as testnet" failure
  mode is a single-line check (§2.3 cross-check against the W0.1 boot
  alert).
- **Audit trail records every assertion outcome** — including the testnet
  exemption — so a forensic reader can answer "did the bot ever boot without
  this check" by querying `control_audit`.
- **`enable*: true` defaults for missing fields trade boot-stability for
  trust posture.** A Binance API change that drops a known field (rare —
  field removals announce 30+ days in advance) will fail the soak boot
  until the mapper is updated. This is the intended bias.
- **Cross-cutting with M9 schema-validation gate (ADR 0025):** the schema
  gate enforces `revoked_jti` and other read-side tables exist before boot;
  this ADR adds one more pre-flight check after that gate. The two run in
  series (schema then key-permissions), never in parallel.
- **No silent override path.** There is intentionally no env var to skip
  the assertion on PAPER/LIVE. An operator who needs to debug a misconfigured
  key changes the code (and that change goes through the review wave).

## 4. Alternatives considered

- **Denylist (refuse only when `enableWithdrawals === true`).** Rejected
  per §2.4: unbounded blast radius from any future Binance flag.
- **Runbook-only enforcement (operator checks manually before boot).**
  Rejected: this was the M11 draft; security review flagged that a single
  operator error during a multi-week soak with a $500–$1000 live account
  defeats every other safety invariant.
- **Capability check via `fapiPrivateGetApiTradingStatus` alone.**
  Rejected: that endpoint returns symbol-level trading-status flags
  (locked, banned, GTC-only) — not the key capability bitset. The capability
  surface lives on the `/sapi` endpoints. Confirmed against ccxt 4.5.54
  source.
- **Skip merging the IP allow-list endpoint, infer `ipRestrict` from the
  primary restrictions payload alone.** Rejected: `sapiGetAccountApiRestrictions`
  carries `ipRestrict: boolean` but **not** the IP list. The allowlist
  predicate requires `ipAllowList.length > 0`. A single-endpoint snapshot
  cannot enforce non-empty.
- **Accept the `-1` sentinel for `tradingAuthorityExpirationTime` as
  non-expiring and pass.** Rejected per §2.2: a non-expiring trading
  authority on a live key is a trust-posture failure for a multi-week soak.
  Future amendment can lift this with an explicit flag.
- **Cache the snapshot for the lifetime of the process and re-check
  hourly.** Rejected for M11a: boot-time check is sufficient because keys
  are rotated by stop-the-engine + swap-env. M11b (cloud) may revisit when
  rolling-deployment introduces re-key without restart.
- **Allow a config override (`DISABLE_KEY_PERMISSION_ASSERTION=true`).**
  Rejected per §2.5: the override would defeat the entire purpose; any
  operator who needs to debug a misconfigured key edits the code and goes
  through review. The M11a soak abort-trigger list (M11a §"Soak abort
  thresholds") explicitly names "key-permission assertion failure that
  required operator override" as a soak-abort condition.
- **Inline the assertion in `CcxtBinanceExchangeClient` constructor.**
  Rejected: the constructor is wired by Nest DI and runs before the
  audit + Telegram channels are guaranteed available. The boot orchestrator
  is the right caller because it controls the order (config → DB → audit
  channel ready → key check → exchange module).
- **Return a richer error type than `boolean` from the predicate (e.g.
  `Result<void, FailureReason[]>`).** Considered. The predicate stays
  boolean for auditability; the **caller** of the predicate (the boot
  orchestrator) computes the failing-clause list by evaluating each clause
  independently for the Telegram + audit body. Keeps the predicate itself
  trivially testable and the failure-report logic explicit.
