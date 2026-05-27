import { Injectable } from '@nestjs/common';
import { hkdfSync } from 'node:crypto';

import { AppConfigService } from '../../config/service';
import { SUBKEY_BYTES } from '../const';

// Per-purpose sub-key derivation from `AUTH_BOOTSTRAP_SECRET` via the same
// HKDF primitive used by DerivedKeyService for the auth + cursor sub-keys
// (ADR 0032 §D6 — HMAC subkey derivation). The two services derive from
// DIFFERENT master secrets: DerivedKeyService uses the
// HS256 signing secret (AUTH_HMAC_SECRET), this one uses the bootstrap
// secret (AUTH_BOOTSTRAP_SECRET). A leak of one master does not compromise
// the other (ADR 0027 §2.3 already enforces the two MUST differ).
//
// Why a separate service rather than extending DerivedKeyService: domain
// separation. DerivedKeyService's port (`IAuthSecretProvider.getSigningSecret`)
// returns the HS256 signing secret. The boot-mode chain MUST key on the
// bootstrap secret per ADR 0032 §D6, and routing that through the auth
// provider port would couple two unrelated trust domains. This service is
// thin (one HKDF call per sub-key) and reuses node's `hkdfSync` — same
// primitive as DerivedKeyService, no second HKDF implementation.

@Injectable()
export class BootstrapSubkeyDeriver {
    constructor(private readonly appConfig: AppConfigService) {}

    // info: caller-supplied HKDF info string (e.g. 'boot_mode_history v1').
    // Identical pattern to DerivedKeyService — the info string carries the
    // domain + version so a future v2 derivation can ship alongside v1.
    deriveSubkey(info: string): Buffer {
        const master = Buffer.from(this.appConfig.authBootstrapSecret, 'utf8');
        const arrayBuffer = hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), SUBKEY_BYTES);

        return Buffer.from(arrayBuffer);
    }
}
