import { IKeyPermissionSnapshot } from '../interface/IKeyPermissionSnapshot.js';

// M11a R1 (ADR 0032 §D8 — Fallback Profile LOCKED, ADR 0028 §2.4 amended):
// Allowlist predicate for key-permission snapshot.
// Pure function; no side effects. Deterministic — takes nowMs as an argument
// instead of reading Date.now() inside.
//
// The `mode` parameter is intentionally not consumed inside the predicate.
// Under the locked Fallback Profile (ADR 0032 §D8), PAPER and LIVE share the
// same boot-time allowlist (both require enableFutures: true). PAPER's safety
// teeth come from D13's runtime nullity probe against a dedicated zero-balance
// sub-account, not from the boot-time predicate. The parameter is retained on
// the signature so callers can branch on it for audit/alert messaging and so
// a future regime split (e.g. an alternative PAPER profile) can re-introduce
// the branch without a contract break.
//
// Returns true iff the snapshot is exactly:
// - enableReading: true
// - enableFutures: true (PAPER Fallback Profile + LIVE both require it)
// - ALL other capability flags: false
// - ipRestrict: true (Binance discontinued /sapi/v1/account/apiRestrictions/ipRestriction
//   in 2021; no self-readable endpoint returns the actual IP list. The
//   `ipRestrict` boolean confirms an IP whitelist is configured; the actual
//   IP set must be verified out-of-band per operator runbook.)
// - tradingAuthorityExpirationTime: non-null and future
export function isKeyPermissionSnapshotAcceptable(snapshot: IKeyPermissionSnapshot, nowMs: number, { mode: _mode }: { mode: 'paper' | 'live' }): boolean {
    return (
        snapshot.enableReading === true &&
        snapshot.enableFutures === true &&
        snapshot.enableSpot === false &&
        snapshot.enableWithdrawals === false &&
        snapshot.enableInternalTransfer === false &&
        snapshot.permitsUniversalTransfer === false &&
        snapshot.enableMargin === false &&
        snapshot.enableVanillaOptions === false &&
        snapshot.enableSubAccountManagement === false &&
        snapshot.ipRestrict === true &&
        // Binance omits tradingAuthorityExpirationTime for sub-account keys
        // (PAPER Fallback Profile). Accept null; reject only if a value is
        // present AND in the past. Operator runbook covers expiry discipline.
        (snapshot.tradingAuthorityExpirationTime === null || snapshot.tradingAuthorityExpirationTime > nowMs)
    );
}
