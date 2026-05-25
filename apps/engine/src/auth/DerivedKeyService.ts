import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { hkdfSync } from 'node:crypto';

import { AUTH_SECRET_PROVIDER, IAuthSecretProvider } from './AuthModule';

// M11a W1.7. HKDF-Expand-based sub-key derivation from the single master
// signing secret. Two domains are derived at boot and held in memory:
//
//   - 'cursor v1'  -> opaque pagination-cursor MAC key (CursorCodec)
//   - 'auth v1'    -> JWT signing key (AuthTokenService)
//
// Why HKDF: the previous code path reused the raw master secret for both
// cursor signing and JWT signing. A leak of a cursor MAC value would not have
// helped an attacker forge JWTs (the cursor MAC binds payload -> MAC and
// reveals neither key), but operationally the two functions deserve domain
// separation: rotating one without the other is otherwise impossible, and a
// future zero-knowledge audit of the cursor surface should not need to
// access the JWT signing path.
//
// Migration / rotation path (documented in RUNBOOK):
//   - Rotating AUTH_HMAC_SECRET rotates BOTH derived sub-keys atomically at
//     restart. In-flight JWTs and in-flight cursors are invalidated together
//     — same property as the pre-W1.7 code. A graceful overlap window is
//     M11b scope and would require a second master secret + dual-verify.
//   - The `info` strings below are versioned ('v1') so a future change to
//     the derivation parameters (algorithm, salt strategy) can ship as 'v2'
//     while v1 keeps decoding existing cursors during a cutover.
//
// We do NOT include the existing master secret in either derived key by
// concatenation — the HKDF expand step produces a 32-byte buffer that
// `createHmac`/`timingSafeEqual` consume directly.

const HKDF_INFO_CURSOR = 'cursor v1';
const HKDF_INFO_AUTH = 'auth v1';
const DERIVED_KEY_BYTES = 32;

export const DERIVED_KEY_SERVICE = Symbol('DERIVED_KEY_SERVICE');

export interface IDerivedKeyService {
    getCursorKey(): Buffer;
    getAuthKey(): Buffer;
}

@Injectable()
export class DerivedKeyService implements IDerivedKeyService, OnModuleInit {
    private readonly logger = new Logger(DerivedKeyService.name);

    private cursorKey: Buffer | null = null;
    private authKey: Buffer | null = null;

    constructor(@Inject(AUTH_SECRET_PROVIDER) private readonly secrets: IAuthSecretProvider) {}

    onModuleInit(): void {
        const master = this.secrets.getSigningSecret();

        this.cursorKey = this.derive(master, HKDF_INFO_CURSOR);
        this.authKey = this.derive(master, HKDF_INFO_AUTH);
        this.logger.log('derivedKey.ready domains=cursor,auth');
    }

    getCursorKey(): Buffer {
        if (this.cursorKey === null) {
            throw new Error('DerivedKeyService not initialised (onModuleInit did not run)');
        }

        return this.cursorKey;
    }

    getAuthKey(): Buffer {
        if (this.authKey === null) {
            throw new Error('DerivedKeyService not initialised (onModuleInit did not run)');
        }

        return this.authKey;
    }

    private derive(master: Buffer, info: string): Buffer {
        // HKDF-Expand-only path: node's `hkdfSync` runs the full HKDF (extract
        // + expand). We use an empty salt — HKDF without explicit salt is the
        // documented "info-only domain separation" mode, which is what we
        // want here. The output is a 32-byte sub-key.
        const arrayBuffer = hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), DERIVED_KEY_BYTES);

        return Buffer.from(arrayBuffer);
    }
}
