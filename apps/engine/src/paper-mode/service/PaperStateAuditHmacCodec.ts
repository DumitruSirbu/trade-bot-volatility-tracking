import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';

import { CHAIN_NAME_PAPER_STATE_AUDIT, PaperStateAuditChainName } from '../const';

// Canonical-encoding + HMAC computation for the paper_state_audit chain
// (ADR 0032 §D6 + §D16). Sibling of `BootModeHmacCodec` — same primitive
// (HMAC-SHA256 over a chain-domain-prefixed canonical JSON payload) but
// scoped to this chain's row shape and its own chain-domain name so the
// signed bytes of a paper_state_audit row CANNOT be replayed as bytes from
// boot_mode_history / boot_mode_chain_rotations even when downstream fields
// happen to coincide.
//
// Canonical form (security-critical — do not change without an ADR bump and
// a `v2` HKDF info string in `paperStateAuditConsts`):
//   JSON.stringify of an array of [key, value] pairs in a FROZEN ORDER with
//   no whitespace. The FIRST pair is always ['__chain', '<chain-name>'].
//
// Field encodings:
//   - seq          : decimal string as returned by Postgres BIGINT.
//   - recordedAt   : ISO-8601 with millisecond precision (Date.toISOString()).
//   - mutationKind : MutationKindEnum literal verbatim.
//   - subjectKind  : SubjectKindEnum literal verbatim.
//   - subjectId    : uuid text verbatim.
//   - payloadHash  : hex of the 32-byte SHA-256 digest.
//   - prevRowHash  : hex string; `null` for the genesis row.

interface IPaperStateAuditSignedPayload {
    seq: string;
    recordedAt: Date;
    mutationKind: string;
    subjectKind: string;
    subjectId: string;
    payloadHash: Buffer;
    prevRowHash: Buffer | null;
}

@Injectable()
export class PaperStateAuditHmacCodec {
    encodePayload(chainName: PaperStateAuditChainName, payload: IPaperStateAuditSignedPayload): Buffer {
        const ordered: Array<[string, string | null]> = [
            ['__chain', chainName],
            ['seq', payload.seq],
            ['recorded_at', payload.recordedAt.toISOString()],
            ['mutation_kind', payload.mutationKind],
            ['subject_kind', payload.subjectKind],
            ['subject_id', payload.subjectId],
            ['payload_hash', payload.payloadHash.toString('hex')],
            ['prev_row_hash', payload.prevRowHash === null ? null : payload.prevRowHash.toString('hex')],
        ];

        return Buffer.from(JSON.stringify(ordered), 'utf8');
    }

    computeHmac(subkey: Buffer, payload: Buffer): Buffer {
        return createHmac('sha256', subkey).update(payload).digest();
    }

    // Canonical payload-hash helper. Services compute the audit row's
    // `payload_hash` by hashing a stable JSON projection of the mutation
    // (entity row before/after, snapshot row, meta-init descriptor, etc.).
    // Kept on the codec so all hashing primitives live in one place and a
    // future canonical-form bump bumps both the HMAC and the payload-hash
    // version atomically.
    hashPayload(canonicalPayload: Buffer): Buffer {
        return createHash('sha256').update(canonicalPayload).digest();
    }

    // Helper that bundles the typical pattern: subject + key/value pairs of
    // the canonical payload → SHA-256(payload bytes). Services pass an
    // already-ordered list of pairs so map-iteration order can never leak
    // into the hash (same defence the HMAC payload uses).
    hashOrderedPayload(orderedPairs: ReadonlyArray<[string, string | number | null]>): Buffer {
        return this.hashPayload(Buffer.from(JSON.stringify(orderedPairs), 'utf8'));
    }

    // Convenience constructor for the chain name — call sites never have to
    // remember the literal. Centralised so a `v2` rename touches one file.
    get chainName(): PaperStateAuditChainName {
        return CHAIN_NAME_PAPER_STATE_AUDIT;
    }
}
