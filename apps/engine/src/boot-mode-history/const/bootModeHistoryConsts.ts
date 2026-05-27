// Constants for the boot-mode-history HMAC chain (ADR 0032 §D6 / §D7).
// Centralised so every reviewer reads one file when auditing the
// security-critical primitives.

// HKDF info strings for per-purpose sub-key derivation. The 'v1' suffix lets a
// future change to the derivation parameters ship as 'v2' while v1 stays
// readable for an existing chain. Identical pattern to DerivedKeyService's
// 'cursor v1' / 'auth v1' (ADR 0031 §2.4).
//
// SECURITY-CRITICAL: the two info strings MUST be distinct so the
// boot_mode_history and boot_mode_chain_rotations chains derive independent
// sub-keys (per ADR 0032 §D6 — per-purpose subkey separation). A leak / forgery
// of one sub-key MUST NOT cross-contaminate the other chain.
export const HKDF_INFO_BOOT_MODE_HISTORY = 'boot_mode_history v1';
export const HKDF_INFO_BOOT_MODE_CHAIN_ROTATIONS = 'boot_mode_chain_rotations v1';

// Canonical chain-domain names. Prepended as the first ['__chain', '<name>']
// pair of the codec's signed payload so a signed payload from chain A is
// structurally distinct from a signed payload from chain B even when every
// downstream field happens to match. Cross-chain payload collisions become
// impossible: an attacker cannot replay a signed `boot_mode_history` row's
// bytes as a `boot_mode_chain_rotations` row's bytes.
export const CHAIN_NAME_BOOT_MODE_HISTORY = 'boot_mode_history';
export const CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS = 'boot_mode_chain_rotations';

// String-literal union of the canonical chain-domain names. The codec accepts
// only these two values, so a typo at the call site collides into a TS
// compile error rather than silently producing a forgeable cross-chain
// payload. Defence in depth on top of the runtime per-purpose sub-key.
export type ChainNameValue = typeof CHAIN_NAME_BOOT_MODE_HISTORY | typeof CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS;

// Per-purpose sub-key length. 32 bytes is the SHA-256 block / HMAC-SHA256
// recommended key size; identical to DerivedKeyService.
export const SUBKEY_BYTES = 32;

// Maximum size of a transition-token file. Matches LIVE_GO_AHEAD_MAX_BYTES in
// LiveGoAheadVerifier. Bounds OOM if the operator points an env var at a log
// file or other arbitrary blob.
export const TRANSITION_TOKEN_MAX_BYTES = 4096;

// Group + other permission mask on transition-token files. A non-zero result
// means the file is readable outside the owning user, which defeats the
// "operator dropped a private file" intent — same posture as the
// LiveGoAheadVerifier check.
export const TRANSITION_TOKEN_FILE_MODE_NON_OWNER_MASK = 0o077;

// Process exit code on a chain-integrity failure or unauthorized mode
// mismatch. Non-zero so a supervisor sees the failed start; distinct from the
// generic exit(1) so the operator can grep audit logs for "security exit".
export const BOOT_MODE_HISTORY_SECURITY_EXIT_CODE = 78;

// Fixed 64-bit Postgres advisory-lock key for the boot-mode sequence. Taken
// inside the transaction via `pg_advisory_xact_lock(<key>)` at the start of
// `runBootSequence` so two engines cold-starting concurrently against the
// same Postgres database cannot race on the chain tip (one waits, the other
// proceeds). Chosen as a fixed BIGINT literal so the value is grep-able for
// operator runbooks. Value: SHA-256("boot_mode_history advisory lock v1")
// truncated to 63 bits (sign-positive) → 0x5b3f_c6c1_4b29_4f93. Stability
// over an opaque hash is more useful here than the small risk of collision
// with another advisory-lock user (the codebase has no other consumer today).
export const BOOT_MODE_HISTORY_ADVISORY_LOCK_KEY: bigint = 0x5b3f_c6c1_4b29_4f93n;

// Env-var names for the transition tokens. Each transition is single-use and
// gated by a separate file + hash pair (analogous to LIVE_GO_AHEAD).
// Documented in .env.example. Only the matching pair is consulted on any boot;
// mismatched pairs are ignored.
//
// Remaining D7 rows (TESTNET<->LIVE, PAPER<->TESTNET, LIVE->PAPER with
// prior-env credential source, LIVE->TESTNET requires MACHINE_REPURPOSE_WIPE)
// are operator-runbook gated; see ADR 0032 §3 D7 + M11b plan.
// String-literal unions of the env-var names looked up by BootModeChainService
// through AppConfigService. Constraining the helper signatures to this union
// means a mistyped env-var name is a compile error, not a silent `undefined`
// at runtime that would otherwise route into the unset-env-var abort path.
export type TransitionTokenFileEnvName = 'TESTNET_TO_PAPER_TOKEN_FILE' | 'PAPER_TO_LIVE_TOKEN_FILE';
export type TransitionTokenHashEnvName = 'TESTNET_TO_PAPER_TOKEN_HASH' | 'PAPER_TO_LIVE_TOKEN_HASH';

export const TRANSITION_ENV_VARS: Readonly<Record<string, { tokenFileEnv: TransitionTokenFileEnvName; tokenHashEnv: TransitionTokenHashEnvName }>> =
    Object.freeze({
        TESTNET_PAPER: { tokenFileEnv: 'TESTNET_TO_PAPER_TOKEN_FILE', tokenHashEnv: 'TESTNET_TO_PAPER_TOKEN_HASH' },
        PAPER_LIVE: { tokenFileEnv: 'PAPER_TO_LIVE_TOKEN_FILE', tokenHashEnv: 'PAPER_TO_LIVE_TOKEN_HASH' },
    });
