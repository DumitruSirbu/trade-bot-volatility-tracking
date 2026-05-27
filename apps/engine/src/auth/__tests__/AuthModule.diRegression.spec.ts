/**
 * M11a triage regression test.
 *
 * Asserts the AuthModule <-> DerivedKeyService circular-import bug stays
 * fixed. Before the `authTokens.ts` extraction, the booting Nest container
 * failed with:
 *
 *   "Nest can't resolve dependencies of the DerivedKeyService (?).
 *    Please make sure that the argument at index [0] is available in the
 *    current module."
 *
 * Root cause: `AUTH_SECRET_PROVIDER` was defined in AuthModule.ts and
 * imported from DerivedKeyService.ts; AuthModule.ts also imported
 * DerivedKeyService.ts. At class-decoration time the symbol was undefined,
 * so `@Inject(AUTH_SECRET_PROVIDER)` registered an undefined token.
 *
 * This test imports both files in the same order Nest does and asserts the
 * token is a real Symbol at module-load time — failing fast on any future
 * re-introduction of the cycle.
 */

import { AUTH_SECRET_PROVIDER, REVOKED_JTI_REPOSITORY } from '../AuthModule';
import { AUTH_SECRET_PROVIDER as TOKEN_FROM_DERIVED_SIDE, REVOKED_JTI_REPOSITORY as REVOKED_TOKEN_FROM_LEAF } from '../authTokens';
import { DerivedKeyService } from '../DerivedKeyService';
import { RevokedJtiPruneScheduler } from '../RevokedJtiPruneScheduler';

describe('AuthModule DI regression (M11a triage)', () => {
    it('exports AUTH_SECRET_PROVIDER as a defined Symbol at import time', () => {
        expect(typeof AUTH_SECRET_PROVIDER).toBe('symbol');
        expect(AUTH_SECRET_PROVIDER).toBeDefined();
    });

    it('shares the same token identity between AuthModule re-export and authTokens leaf module', () => {
        // Same Symbol instance — re-export from AuthModule must not shadow the
        // leaf-module symbol. Identity equality is what Nest's DI registry
        // keys off, so a subtle re-declaration would silently break injection.
        expect(AUTH_SECRET_PROVIDER).toBe(TOKEN_FROM_DERIVED_SIDE);
    });

    it('constructs DerivedKeyService with an injected secret provider (no DI cycle)', () => {
        // If the @Inject token resolved to undefined at decorator time, the
        // Nest container would fail to build this class. Constructing it
        // directly here mirrors what Nest does after resolveSingleParam.
        const secretProvider = { getSigningSecret: () => Buffer.alloc(32, 1) };
        const service = new DerivedKeyService(secretProvider as never);

        expect(service).toBeInstanceOf(DerivedKeyService);

        service.onModuleInit();

        expect(service.getAuthKey().byteLength).toBe(32);
        expect(service.getCursorKey().byteLength).toBe(32);
    });

    // M11a triage follow-on — same cycle pattern, second symbol.
    it('exports REVOKED_JTI_REPOSITORY as a defined Symbol at import time', () => {
        expect(typeof REVOKED_JTI_REPOSITORY).toBe('symbol');
        expect(REVOKED_JTI_REPOSITORY).toBeDefined();
    });

    it('shares the same REVOKED_JTI_REPOSITORY token identity between AuthModule re-export and authTokens leaf module', () => {
        expect(REVOKED_JTI_REPOSITORY).toBe(REVOKED_TOKEN_FROM_LEAF);
    });

    it('constructs RevokedJtiPruneScheduler with injected dependencies (no DI cycle)', () => {
        // Mirrors what Nest does after resolveSingleParam. If the token had
        // resolved to undefined at decorator-time, this would have thrown the
        // "argument at index [0] is undefined" error at boot.
        const revoked = {
            isRevoked: async () => false,
            revoke: async () => {},
            pruneOlderThan: async () => 0,
            countAll: async () => 0,
        };
        const alerts = { publish: async () => {} };
        const clock = { now: () => new Date() };
        const appConfig = { revokedJtiPruneAfterSec: 7200, revokedJtiMaxRows: 10_000 };

        const scheduler = new RevokedJtiPruneScheduler(revoked as never, alerts as never, clock as never, appConfig as never);

        expect(scheduler).toBeInstanceOf(RevokedJtiPruneScheduler);
    });
});
