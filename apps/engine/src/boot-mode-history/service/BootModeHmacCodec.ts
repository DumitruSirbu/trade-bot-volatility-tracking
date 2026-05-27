import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { ChainNameValue } from '../const';

// Canonical-encoding + HMAC computation for the boot_mode_history +
// boot_mode_chain_rotations chains (ADR 0032 §D6).
//
// Canonical form (security-critical — do not change without an ADR bump and a
// `v2` HKDF info string):
//   JSON.stringify with the SIGNED-PAYLOAD KEYS LISTED IN A FROZEN ORDER and
//   NO WHITESPACE. We do not rely on JS object iteration order — keys are
//   read explicitly into an array of [key, value] pairs.
//
//   The FIRST pair is always ['__chain', '<chain-name>']. Prepending a
//   chain-domain prefix makes cross-chain payload collisions structurally
//   impossible: a signed `boot_mode_history` payload's bytes cannot be
//   replayed as a `boot_mode_chain_rotations` payload's bytes (and vice
//   versa) even if every downstream field happens to match. Defence in depth
//   on top of the per-purpose HKDF sub-key separation.
//
// Field encodings:
//   - seq         : decimal string as returned by Postgres BIGINT.
//   - bootedAt /  : ISO-8601 with millisecond precision (Date.toISOString()).
//     rotatedAt
//   - rowKind /   : enum literal verbatim.
//     fromEnv /
//     toEnv /
//     exchangeEnv
//   - prevRowHash / : hex string; `null` (the JSON literal) for the genesis
//     pre_tip_hash    row in boot_mode_history.
//   - transitionTokenHash : hex string.

interface IBootModeHistorySignedPayload {
    seq: string;
    bootedAt: Date;
    rowKind: string;
    exchangeEnv: string;
    fromEnv: string | null;
    toEnv: string | null;
    prevRowHash: Buffer | null;
}

interface IBootModeChainRotationSignedPayload {
    seq: string;
    rotatedAt: Date;
    fromEnv: string;
    toEnv: string;
    preTipHash: Buffer;
    transitionTokenHash: Buffer;
    prevRowHash: Buffer | null;
}

@Injectable()
export class BootModeHmacCodec {
    encodeBootModeHistoryPayload(chainName: ChainNameValue, payload: IBootModeHistorySignedPayload): Buffer {
        const ordered: Array<[string, string | null]> = [
            ['__chain', chainName],
            ['seq', payload.seq],
            ['booted_at', payload.bootedAt.toISOString()],
            ['row_kind', payload.rowKind],
            ['exchange_env', payload.exchangeEnv],
            ['from_env', payload.fromEnv],
            ['to_env', payload.toEnv],
            ['prev_row_hash', payload.prevRowHash === null ? null : payload.prevRowHash.toString('hex')],
        ];

        return Buffer.from(JSON.stringify(ordered), 'utf8');
    }

    encodeBootModeChainRotationPayload(chainName: ChainNameValue, payload: IBootModeChainRotationSignedPayload): Buffer {
        const ordered: Array<[string, string | null]> = [
            ['__chain', chainName],
            ['seq', payload.seq],
            ['rotated_at', payload.rotatedAt.toISOString()],
            ['from_env', payload.fromEnv],
            ['to_env', payload.toEnv],
            ['pre_tip_hash', payload.preTipHash.toString('hex')],
            ['transition_token_hash', payload.transitionTokenHash.toString('hex')],
            ['prev_row_hash', payload.prevRowHash === null ? null : payload.prevRowHash.toString('hex')],
        ];

        return Buffer.from(JSON.stringify(ordered), 'utf8');
    }

    computeHmac(subkey: Buffer, payload: Buffer): Buffer {
        return createHmac('sha256', subkey).update(payload).digest();
    }
}
