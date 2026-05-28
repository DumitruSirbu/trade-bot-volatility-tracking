// M13 W1.B (ADR 0038 §2.2) — HS256 bearer verifier for the MCP HTTP transport.
//
// Re-implemented locally inside `apps/mcp/` rather than imported from
// `apps/engine/` to preserve ADR 0033's structural boundary. The verifier
// mirrors the engine's AuthTokenService format byte-for-byte (HS256 only,
// fixed `{"alg":"HS256","typ":"JWT"}` header, base64url segments) and adds
// the `aud === 'mcp'` audience check that ADR 0038 §2.2 mandates for tokens
// minted against the HTTP transport.
//
// Boundary invariant: imports only node `crypto` + `@bot/shared` + sibling
// MCP files. Zero edges to @bot/engine.

import { createHmac, timingSafeEqual } from 'crypto';
import { AuthFailureReasonEnum } from '@bot/shared';

/** Fixed HS256 header `{"alg":"HS256","typ":"JWT"}` base64url-encoded. */
export const MCP_AUTH_HS256_HEADER_B64URL = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';

/** Required audience claim for tokens accepted on the MCP HTTP transport. */
export const MCP_AUTH_REQUIRED_AUDIENCE = 'mcp';

/**
 * Persistence port for the `revoked_jti` SELECT. Decoupled from TypeORM so
 * tests can supply a deterministic Map-backed fake. Production wires the
 * adapter built from the analysis DataSource.
 */
export interface IRevokedJtiChecker {
    isRevoked(jti: string): Promise<boolean>;
}

/** Verified-subject view returned to the transport on success. */
export interface IVerifiedBearer {
    readonly sub: string;
    readonly aud: string;
    readonly jti: string;
    readonly exp: number;
}

/**
 * Thrown on any verification failure. The transport translates the typed
 * reason into the JSON-RPC `-32000 AUTH_FAILED` envelope.
 */
export class BearerVerificationError extends Error {
    readonly reason: AuthFailureReasonEnum;

    constructor(reason: AuthFailureReasonEnum, message: string) {
        super(message);
        this.name = 'BearerVerificationError';
        this.reason = reason;
    }
}

interface IBearerPayload {
    sub: string;
    jti: string;
    aud: string;
    exp: number;
}

function base64UrlDecode(input: string): Buffer {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    const normalised = input.replace(/-/gu, '+').replace(/_/gu, '/') + pad;

    return Buffer.from(normalised, 'base64');
}

function signHs256(headerAndPayload: string, secret: Buffer): string {
    const mac = createHmac('sha256', secret).update(headerAndPayload).digest();

    return mac.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function isWellFormedPayload(value: unknown): value is IBearerPayload {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const v = value as Record<string, unknown>;

    return typeof v.sub === 'string' && typeof v.jti === 'string' && typeof v.aud === 'string' && typeof v.exp === 'number';
}

/**
 * Verify a Bearer token for the MCP HTTP transport.
 *
 * Checks (in order, fail-fast): structural shape, HS256 signature (constant-
 * time), payload well-formedness, `exp` not in the past, `aud === 'mcp'`, and
 * `jti` not present in `revoked_jti`.
 *
 * Throws `BearerVerificationError` carrying the typed `AuthFailureReasonEnum`
 * on any failure. The transport NEVER logs the raw token; only the reason
 * code is surfaced.
 */
export async function verifyBearer(token: string, secret: Buffer, revoked: IRevokedJtiChecker, now: Date): Promise<IVerifiedBearer> {
    if (typeof token !== 'string' || token.length === 0) {
        throw new BearerVerificationError(AuthFailureReasonEnum.MISSING, 'bearer token missing');
    }

    const parts = token.split('.');

    if (parts.length !== 3) {
        throw new BearerVerificationError(AuthFailureReasonEnum.MALFORMED, 'token must have three segments');
    }

    const [headerSeg, payloadSeg, signatureSeg] = parts;

    if (headerSeg !== MCP_AUTH_HS256_HEADER_B64URL) {
        throw new BearerVerificationError(AuthFailureReasonEnum.MALFORMED, 'unsupported header');
    }

    const expectedSig = signHs256(`${headerSeg}.${payloadSeg}`, secret);
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    const actualBuf = Buffer.from(signatureSeg, 'utf8');

    if (expectedBuf.byteLength !== actualBuf.byteLength || !timingSafeEqual(expectedBuf, actualBuf)) {
        throw new BearerVerificationError(AuthFailureReasonEnum.BAD_SIGNATURE, 'signature mismatch');
    }

    let parsed: IBearerPayload;

    try {
        parsed = JSON.parse(base64UrlDecode(payloadSeg).toString('utf8')) as IBearerPayload;
    } catch {
        throw new BearerVerificationError(AuthFailureReasonEnum.MALFORMED, 'payload JSON decode failed');
    }

    if (!isWellFormedPayload(parsed)) {
        throw new BearerVerificationError(AuthFailureReasonEnum.MALFORMED, 'payload missing required claims');
    }

    const nowSec = Math.floor(now.getTime() / 1000);

    if (parsed.exp <= nowSec) {
        throw new BearerVerificationError(AuthFailureReasonEnum.EXPIRED, 'token expired');
    }

    if (parsed.aud !== MCP_AUTH_REQUIRED_AUDIENCE) {
        // ADR 0038 §2.2 names a `BAD_AUDIENCE` reason. The shared enum
        // currently exposes only the M9-era reasons; adding BAD_AUDIENCE is a
        // packages/shared change that must route through bot-shared-maintainer
        // — deferred. BAD_SCOPE is the closest existing semantic (token does
        // not bear the required surface scope).
        throw new BearerVerificationError(AuthFailureReasonEnum.BAD_SCOPE, 'audience mismatch');
    }

    if (await revoked.isRevoked(parsed.jti)) {
        throw new BearerVerificationError(AuthFailureReasonEnum.REVOKED, 'token revoked');
    }

    return { sub: parsed.sub, aud: parsed.aud, jti: parsed.jti, exp: parsed.exp };
}
