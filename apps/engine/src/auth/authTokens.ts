// M11a triage — DI token + port for the auth secret provider.
//
// Extracted from `AuthModule.ts` to break a circular import:
//
//   AuthModule.ts            -> imports DerivedKeyService
//   DerivedKeyService.ts     -> imports AUTH_SECRET_PROVIDER (was from AuthModule.ts)
//
// At class-decoration time, whichever side loaded second saw the other as a
// partially-initialised module, so `@Inject(AUTH_SECRET_PROVIDER)` resolved to
// `undefined` and Nest reported:
//
//   "Nest can't resolve dependencies of the DerivedKeyService (?).
//    Please make sure that the argument at index [0] is available..."
//
// Putting the token + port in a leaf file with no AuthModule import removes
// the cycle. AuthModule and DerivedKeyService both import from here; nothing
// here imports them.

export const AUTH_SECRET_PROVIDER = Symbol('AUTH_SECRET_PROVIDER');

// The secret provider is a port (ADR 0020 §2.4) so M11 can swap the env
// adapter for SSM / Vault / 1Password without touching the guard.
export interface IAuthSecretProvider {
    getSigningSecret(): Buffer;
}

// M11a triage follow-on — REVOKED_JTI_REPOSITORY token + IRevokedJtiRepositoryPort
// port extracted here for the same reason as AUTH_SECRET_PROVIDER. The cycle was:
//
//   AuthModule.ts                  -> imports RevokedJtiPruneScheduler + AuthGuard
//   RevokedJtiPruneScheduler.ts    -> imports REVOKED_JTI_REPOSITORY (was from AuthModule.ts)
//   AuthGuard.ts                   -> imports REVOKED_JTI_REPOSITORY (was from AuthModule.ts)
//
// At decorator-time the token was `undefined`, so Nest registered an undefined
// DI key and boot failed when resolving RevokedJtiPruneScheduler. The leaf
// module breaks the cycle — nothing here imports AuthModule.
export const REVOKED_JTI_REPOSITORY = Symbol('REVOKED_JTI_REPOSITORY');

// Persistence port — services depend on this, not on TypeORM's Repository,
// per code-conventions repository-pattern rule. Insert is upsert-safe so a
// re-revoke returns successfully instead of throwing on the PK conflict.
export interface IRevokedJtiRepositoryPort {
    isRevoked(jti: string): Promise<boolean>;
    revoke(jti: string, revokedBy: string, reason: string | null): Promise<void>;
    // M11a W1.6 (ADR 0031). Deletes rows with `revoked_at < cutoff`. Returns
    // the number of rows deleted so the scheduler can log + alert. Idempotent.
    pruneOlderThan(cutoff: Date): Promise<number>;
    // M11a W1.6 (ADR 0031 §2.4). Cheap COUNT(*) for the unbounded-growth
    // alert. The hourly cadence + indexed PK makes this a small scan.
    countAll(): Promise<number>;
}
