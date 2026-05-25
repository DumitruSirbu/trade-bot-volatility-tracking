import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

import { AUTH_SECRET_PROVIDER, IAuthSecretProvider } from '../../auth/AuthModule';

// M9 W4 (ADR 0022 §2.5). Opaque, HMAC-tamper-guarded cursor codec for the read
// API's cursor pagination.
//
// Wire format (base64url, no padding):  `<payload>.<mac>` where
//   payload = base64url(JSON.stringify({ id: number; ts: string }))
//   mac     = base64url(HMAC-SHA256(secret, payload))
//
// The HMAC binds the cursor to this engine's signing secret, so a client cannot
// forge a cursor pointing at an arbitrary (id, ts) pair to enumerate rows out
// of band. Verification uses `timingSafeEqual`. Decoding returns null on any
// failure (mac mismatch, malformed JSON, missing fields, bad types); the
// controllers treat null as "start of page" rather than throwing — that keeps
// the client surface forgiving while still rejecting tampering.
//
// Why bind to the auth signing secret: the engine already provisions one
// 32-byte HMAC secret (ADR 0020 §2.1). A separate cursor secret would add an
// operator-facing knob with zero security benefit — both rotate together on a
// secret rotation. The codec depends on the `IAuthSecretProvider` port so the
// future Vault/SSM adapter swap (ADR 0020 §2.4) propagates here for free.
//
// Limits:
//   - max cursor length cap (decoded payload) guards against memory abuse on
//     a flood of oversized cursor params;
//   - the codec encodes ONLY (id, ts) — no row contents leak, no PII, no
//     internal flags.

const MAX_RAW_LENGTH = 256;
const MAC_LENGTH_BYTES = 32; // SHA-256 output

// `id` widened to `number | string` so the shared codec is the single
// pagination cursor across the engine (M9 R1 wave #6 / architect D):
// numeric SERIAL ids (positions / decisions / snapshots) and UUID string ids
// (control_audit) ride the same MAC-bound envelope. The decoder validates
// each variant separately so a forged "id":"<sql>" cannot escape the
// `parsePayload` type guards.
export interface ICursorTuple {
    readonly id: number | string;
    readonly ts: Date;
}

@Injectable()
export class CursorCodec {
    constructor(@Inject(AUTH_SECRET_PROVIDER) private readonly secrets: IAuthSecretProvider) {}

    encode(tuple: ICursorTuple): string {
        const payload = base64UrlEncode(Buffer.from(JSON.stringify({ id: tuple.id, ts: tuple.ts.toISOString() }), 'utf8'));
        const mac = this.signPayload(payload);

        return `${payload}.${mac}`;
    }

    // Returns the decoded tuple, or null when the cursor is missing / forged /
    // malformed. Callers treat a null decode as "no cursor" — equivalent to
    // first page — instead of surfacing a 400 (forgiving by design).
    decode(rawCursor: string | null | undefined): ICursorTuple | null {
        if (rawCursor === null || rawCursor === undefined || rawCursor.length === 0) {
            return null;
        }

        if (rawCursor.length > MAX_RAW_LENGTH) {
            return null;
        }

        const dotIndex = rawCursor.indexOf('.');

        if (dotIndex <= 0 || dotIndex === rawCursor.length - 1) {
            return null;
        }

        const payload = rawCursor.slice(0, dotIndex);
        const presentedMac = rawCursor.slice(dotIndex + 1);

        if (!this.verifyMac(payload, presentedMac)) {
            return null;
        }

        return parsePayload(payload);
    }

    private signPayload(payload: string): string {
        const mac = createHmac('sha256', this.secrets.getSigningSecret()).update(payload).digest();

        return base64UrlEncode(mac);
    }

    private verifyMac(payload: string, presentedMac: string): boolean {
        const expected = this.signPayload(payload);
        const expectedBuf = Buffer.from(expected, 'utf8');
        const actualBuf = Buffer.from(presentedMac, 'utf8');

        if (expectedBuf.byteLength !== actualBuf.byteLength) {
            return false;
        }

        // Belt-and-braces — also require the decoded MAC byte length to match SHA-256
        // output. Resists a future swap that might silently shorten the digest.
        if (base64UrlDecode(expected).byteLength !== MAC_LENGTH_BYTES) {
            return false;
        }

        return timingSafeEqual(expectedBuf, actualBuf);
    }
}

function parsePayload(payload: string): ICursorTuple | null {
    let decoded: Buffer;

    try {
        decoded = base64UrlDecode(payload);
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
    const ts = record.ts;

    if (typeof id === 'number') {
        if (!Number.isFinite(id) || !Number.isInteger(id) || id < 0) {
            return null;
        }
    } else if (typeof id === 'string') {
        // String ids are UUIDs in the engine (control_audit). Reject empty +
        // pathologically long strings so a forged cursor can't smuggle a
        // multi-MB payload through the codec.
        if (id.length === 0 || id.length > 64) {
            return null;
        }
    } else {
        return null;
    }

    if (typeof ts !== 'string') {
        return null;
    }

    const date = new Date(ts);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return { id, ts: date };
}

function base64UrlEncode(input: Buffer): string {
    return input.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function base64UrlDecode(input: string): Buffer {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    const normalised = input.replace(/-/gu, '+').replace(/_/gu, '/') + pad;

    return Buffer.from(normalised, 'base64');
}
