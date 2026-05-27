import { timingSafeEqual } from 'node:crypto';

// Constant-time buffer comparison used by HMAC-chain walkers
// (BootModeChainService, PaperAccountStateService, PaperExchangeNullityProbe
// preflight). Length pre-check is required because `timingSafeEqual` throws
// on unequal-length inputs — the pre-check short-circuits with `false`
// without ever entering the cmp primitive.
//
// M11a R4 Item 5: extracted to one location so the three chain walkers stop
// duplicating the same primitive (mechanical DRY).
export function bufferEquals(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) {
        return false;
    }

    return timingSafeEqual(a, b);
}
