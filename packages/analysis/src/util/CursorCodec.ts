// M12 W1 — parallel pure-TS cursor codec for the analysis layer.
//
// **R5 architect decision pending** (M12 plan §risks R5): the engine ships a
// HMAC-tamper-guarded CursorCodec at `apps/engine/src/read-api/pagination/
// CursorCodec.ts`, signed with an HKDF-derived sub-key from the engine's
// AUTH_HMAC_SECRET (M11a W1.7). The boundary rule (ADR 0033 §2.2) forbids
// `apps/mcp` and `packages/analysis` from importing engine source; the clean
// fix is to reshuffle the codec into `@bot/shared/util` and have both engine
// and analysis depend on it.
//
// For W1 we ship a parallel, dependency-free implementation here. The
// difference vs the engine variant:
//   - **No HMAC signing.** MCP cursors are not authenticated to a request
//     subject — the MCP transport is stdio (no network, no auth surface per
//     ADR 0033). A forged cursor on stdio is equivalent to a forged tool-
//     call argument; the agent already has read access. The tamper guard in
//     the engine's variant exists because a public HTTP cursor is forgeable
//     across requests; that threat model does not apply to stdio.
//   - Wire format is base64url(JSON({id, createdAtMs})).
//
// The orchestrator MUST adjudicate before W4 whether MCP cursors should also
// be HMAC-bound (e.g., if M13 introduces a localhost-bound HTTP transport).
// Flag for review: R5 reshuffle to `@bot/shared/util`.

const MAX_RAW_LENGTH = 256;
const MAX_ID_STRING_LENGTH = 64;

export interface ICursorPayload {
    readonly id: number | string;
    readonly createdAtMs: number;
    /**
     * Optional fingerprint over the issuing query's filter set. When present
     * on inbound cursors, the call site recomputes the fingerprint from the
     * current call's filters and rejects mismatches — pagination requires
     * filters to stay constant across page requests. Absent on legacy/first
     * cursors; the call site treats `undefined` as "no constraint" for
     * backward compat.
     */
    readonly filterHash?: string;
}

export function encodeCursor(payload: ICursorPayload): string {
    const body: Record<string, unknown> = { id: payload.id, createdAtMs: payload.createdAtMs };

    if (payload.filterHash !== undefined) {
        body.filterHash = payload.filterHash;
    }

    const json = JSON.stringify(body);

    return base64UrlEncode(Buffer.from(json, 'utf8'));
}

// Returns `null` on any malformed input — the call site treats `null` as
// "start of page" (first-page semantics), matching the engine's
// forgiving-decode convention.
export function decodeCursor(raw: string | null | undefined): ICursorPayload | null {
    if (raw === null || raw === undefined || raw.length === 0) {
        return null;
    }

    if (raw.length > MAX_RAW_LENGTH) {
        return null;
    }

    let decoded: Buffer;

    try {
        decoded = base64UrlDecode(raw);
    } catch {
        return null;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(decoded.toString('utf8'));
    } catch {
        return null;
    }

    if (parsed === null || typeof parsed !== 'object') {
        return null;
    }

    const record = parsed as Record<string, unknown>;
    const id = record.id;
    const createdAtMs = record.createdAtMs;

    if (typeof id === 'number') {
        if (!Number.isFinite(id) || !Number.isInteger(id) || id < 0) {
            return null;
        }
    } else if (typeof id === 'string') {
        if (id.length === 0 || id.length > MAX_ID_STRING_LENGTH) {
            return null;
        }
        // why: keep non-numeric forged ids out of the downstream `::bigint`
        // cast in `listPositions.ts`. Relax this to allow UUID charset when
        // the deferred BaseRepository uuid-PK widening lands (pre-M15 item).
        if (!/^[0-9]+$/u.test(id)) {
            return null;
        }
    } else {
        return null;
    }

    if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs) || !Number.isInteger(createdAtMs)) {
        return null;
    }

    const filterHash = record.filterHash;

    if (filterHash !== undefined && (typeof filterHash !== 'string' || filterHash.length === 0 || filterHash.length > 64)) {
        return null;
    }

    return filterHash === undefined ? { id, createdAtMs } : { id, createdAtMs, filterHash };
}

function base64UrlEncode(input: Buffer): string {
    return input.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function base64UrlDecode(input: string): Buffer {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    const normalised = input.replace(/-/gu, '+').replace(/_/gu, '/') + pad;

    return Buffer.from(normalised, 'base64');
}
