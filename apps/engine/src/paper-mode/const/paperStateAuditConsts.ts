// Constants for the paper_state_audit HMAC chain (ADR 0032 §D6 / §D16).
// Mirrors the boot-mode-history const file shape so a reviewer reads one
// vocabulary across both chains.

// HKDF info string for per-purpose sub-key derivation. SECURITY-CRITICAL: this
// value MUST differ from the boot-mode-history info strings so a leak / forgery
// of any one sub-key does NOT cross-contaminate the other chains (ADR 0032 §D6
// HMAC subkey derivation). The 'v1' suffix lets a future change to the
// derivation parameters ship as 'v2' while v1 stays readable for an existing
// chain.
export const HKDF_INFO_PAPER_STATE_AUDIT = 'paper_state_audit v1';

// Canonical chain-domain name. Prepended as the first ['__chain', '<name>']
// pair of the codec's signed payload so a signed payload from this chain is
// structurally distinct from any signed payload from boot_mode_history /
// boot_mode_chain_rotations even when every downstream field happens to
// match. Cross-chain payload replay becomes impossible by construction.
export const CHAIN_NAME_PAPER_STATE_AUDIT = 'paper_state_audit';

// String-literal narrowing of the canonical chain-domain name. The codec
// accepts only this single value so a typo at the call site is a TS compile
// error rather than a silently forgeable cross-chain payload. Defence in
// depth on top of the runtime per-purpose sub-key.
export type PaperStateAuditChainName = typeof CHAIN_NAME_PAPER_STATE_AUDIT;

// HMAC-SHA256 output width. Same constant value as
// `boot-mode-history/const/SUBKEY_BYTES`; duplicated here so this module does
// not couple to boot-mode-history's const surface for an unrelated chain.
export const PAPER_STATE_AUDIT_SUBKEY_BYTES = 32;

// SHA-256 output width. Used as the canonical `payload_hash` column width;
// CHECK constraint pins `octet_length(payload_hash) = 32`.
export const PAPER_STATE_AUDIT_PAYLOAD_HASH_BYTES = 32;

// Fixed 64-bit Postgres advisory-lock key for the paper-state-audit chain.
// Taken inside the transaction via `pg_advisory_xact_lock(<key>)` at the
// start of every audited mutation so two PaperAccountStateService callers
// (or a service + reconciliation drain) cannot race on the chain tip.
// SECURITY-CRITICAL: MUST differ from the boot-mode-history advisory-lock
// key so the two chains never block on the same lock. Value:
// SHA-256("paper_state_audit advisory lock v1") truncated to 63 bits
// (sign-positive) → 0x4d7e_9a2f_1b8c_3055. Stable BIGINT literal so the
// value is grep-able for operator runbooks.
export const PAPER_STATE_AUDIT_ADVISORY_LOCK_KEY: bigint = 0x4d7e_9a2f_1b8c_3055n;

// Default starting equity (USDT) when no `PAPER_STARTING_EQUITY_USDT` env
// var is set (ADR 0032 §D11). Matches the live restricted-profile lower
// bound; surfaced through AppConfigService so the magic number lives at
// the config boundary rather than embedded in service code.
export const PAPER_STARTING_EQUITY_USDT_DEFAULT = 500;

// Drawdown abort threshold (ADR 0032 §D5 / §D11). The drawdown evaluator
// trips when `equity <= peak_equity * (1 - DRAWDOWN_ABORT_THRESHOLD)`.
// 15% adverse mark from peak equity is the locked R3.1 boundary.
//
// Surfaced as a JS number for documentation / logging only — money math
// MUST use `DRAWDOWN_ABORT_REMAINING_FRACTION_STR` so float subtraction
// (e.g. `1 - 0.15 = 0.8500000000000001`) cannot leak into the evaluator.
export const DRAWDOWN_ABORT_THRESHOLD = 0.15;

// Decimal-precise remaining-equity fraction. `evaluateDrawdownAbort` trips
// when `currentEquity <= peakEquity * DRAWDOWN_ABORT_REMAINING_FRACTION`.
// String literal so the Money constructor sees the exact value, not a float.
// Pinned at 0.85 = 1 - DRAWDOWN_ABORT_THRESHOLD; any threshold change MUST
// update both constants in lock-step.
export const DRAWDOWN_ABORT_REMAINING_FRACTION_STR = '0.85';

// MTM throttle window (ms) per held symbol (ADR 0032 §D5). Coalesces
// recompute-unrealised + drawdown evaluations to at most once per
// throttle window per symbol unless a tick-size move or a funding event
// force-flushes earlier.
export const PAPER_MTM_THROTTLE_MS = 100;

// HKDF info-string version recorded in paper_account_state_meta. Bumped
// alongside any change to the derivation chain that would invalidate a
// pre-existing soak.
export const PAPER_HKDF_INFO_VERSION = 'v1';

// Seed-version label written to paper_account_state_meta.seed_version_label
// for the simulator PRNG (ADR 0032 §D3). Cross-checked at boot — a stored
// value differing from this constant indicates a different binary wrote
// the soak's meta row.
export const PAPER_SIMULATOR_SEED_VERSION_LABEL = 'paper_simulator_seed v1';
