// M13 live-smoke gap #5 — MCP/engine HS256 key parity.
//
// The engine signs JWTs with HKDF-Expand(master=AUTH_HMAC_SECRET, info='auth v1', 32B)
// (see apps/engine/src/auth/DerivedKeyService.ts). Previously MCP read a raw
// AUTH_HS256_KEY env var and treated it AS the signing key — so engine-issued
// tokens always failed verification with BAD_SIGNATURE.
//
// We replicate the engine's HKDF derivation locally (10 lines, no shared-package
// churn) so MCP verifies with the same key the engine signs with. The 'auth v1'
// info string is the implicit cross-process contract: if the engine ever bumps
// to 'auth v2', this constant must move in lockstep.
//
// Boundary invariant: imports only node `crypto`. Zero edges to @bot/engine.

import { hkdfSync } from 'node:crypto';

const HKDF_INFO_AUTH = 'auth v1';
const HKDF_OUTPUT_BYTES = 32;

/**
 * Derive the HS256 verification key from the master AUTH_HMAC_SECRET, matching
 * the engine's DerivedKeyService exactly (HKDF-SHA256, empty salt, info 'auth v1',
 * 32-byte output).
 */
export function deriveAuthKey(masterSecret: Buffer | string): Buffer {
    const master = typeof masterSecret === 'string' ? Buffer.from(masterSecret, 'utf8') : masterSecret;

    return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(HKDF_INFO_AUTH, 'utf8'), HKDF_OUTPUT_BYTES));
}
