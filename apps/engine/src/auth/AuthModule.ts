import { AuthFailureReasonEnum, AuthScopeEnum, IAuthFailure, IAuthSubject } from '@bot/shared';
import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';

import { AlertSinkModule } from '../alert/sink/AlertSinkModule';
import { CLOCK, SystemClock } from '../common/clock/Clock';
import { AppConfigModule } from '../config/AppConfigModule';
import { AppConfigService } from '../config/service';
import { AuthCorsInterceptor } from './AuthCorsInterceptor';
import { AUTH_HS256_HEADER_B64URL, AUTH_MIN_SECRET_BYTES, AUTH_TOKEN_DEFAULT_TTL_SEC } from './const/authConsts';
import { DerivedKeyService, DERIVED_KEY_SERVICE } from './DerivedKeyService';
import { RevokedJtiEntity } from './entity/RevokedJtiEntity';
import { RevokedJtiPruneScheduler } from './RevokedJtiPruneScheduler';

// M9 W2 (ADR 0020).
//
// `AuthModule` wires the bearer-auth stack: secret provider, HS256 signer +
// verifier, revocation repository, the guard (exported from `AuthGuard.ts`),
// the `@RequiredScopes(...)` decorator, and the WS handshake helper consumed
// by W5's `LiveGateway`.
//
// Wiring is deliberately self-contained: no controller / no global guard
// registration. Controllers opt in with `@UseGuards(AuthGuard) @RequiredScopes(...)`
// as they ship in W3 / W4 / W5.

// ---------------------------------------------------------------------------
// Tokens / ports
// ---------------------------------------------------------------------------

export const AUTH_SECRET_PROVIDER = Symbol('AUTH_SECRET_PROVIDER');
export const REVOKED_JTI_REPOSITORY = Symbol('REVOKED_JTI_REPOSITORY');

// The secret provider is a port (ADR 0020 §2.4) so M11 can swap the env
// adapter for SSM / Vault / 1Password without touching the guard.
export interface IAuthSecretProvider {
    getSigningSecret(): Buffer;
}

// Persistence port — the service depends on this, not on TypeORM's Repository,
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

// WS handshake contract consumed by W5. Pure function shape — takes a raw
// token string, returns a typed result. No exception thrown so the gateway
// can choose how to surface the failure (close socket vs ack-fail).
export interface IWsAuthHandshake {
    verify(rawToken: string): IAuthSubject | IAuthFailure;
}

// ---------------------------------------------------------------------------
// Env-backed secret provider
// ---------------------------------------------------------------------------

@Injectable()
export class EnvAuthSecretProvider implements IAuthSecretProvider, OnModuleInit {
    private readonly logger = new Logger(EnvAuthSecretProvider.name);

    private secret: Buffer | null = null;

    constructor(private readonly appConfig: AppConfigService) {}

    onModuleInit(): void {
        // M9 R1 #4 — the secret is sourced from `AppConfigService.authHmacSecret`
        // which (a) enforces the prod-only required rule, (b) refuses well-known
        // sentinels, and (c) generates a per-process random secret in dev/test
        // instead of a hard-coded literal. We re-check the byte-length here as a
        // defence-in-depth assertion against any future loosening of the
        // AppConfigService contract.
        const raw = this.appConfig.authHmacSecret;
        const buf = Buffer.from(raw, 'utf8');

        if (buf.byteLength < AUTH_MIN_SECRET_BYTES) {
            throw new Error(`AUTH_HMAC_SECRET must be >= ${AUTH_MIN_SECRET_BYTES} bytes (got ${buf.byteLength})`);
        }

        this.secret = buf;
    }

    getSigningSecret(): Buffer {
        if (this.secret === null) {
            throw new Error('AuthSecretProvider not initialised (onModuleInit did not run)');
        }

        return this.secret;
    }
}

// ---------------------------------------------------------------------------
// HS256 JWT helpers (no external dep — node `crypto`)
// ---------------------------------------------------------------------------

interface IJwtPayload {
    sub: string;
    jti: string;
    scopes: AuthScopeEnum[];
    iat: number;
    exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;

    return buf.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function base64UrlDecode(input: string): Buffer {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    const normalised = input.replace(/-/gu, '+').replace(/_/gu, '/') + pad;

    return Buffer.from(normalised, 'base64');
}

function signHs256(headerAndPayload: string, secret: Buffer): string {
    const mac = createHmac('sha256', secret).update(headerAndPayload).digest();

    return base64UrlEncode(mac);
}

// ---------------------------------------------------------------------------
// AuthTokenService — sign + verify
// ---------------------------------------------------------------------------

export interface IIssueTokenInput {
    sub: string;
    scopes: AuthScopeEnum[];
    ttlSec: number;
    now: Date;
}

export interface IIssuedToken {
    token: string;
    jti: string;
    exp: number;
}

@Injectable()
export class AuthTokenService {
    private readonly logger = new Logger(AuthTokenService.name);

    // M11a W1.7 — JWT signing keys are derived from the master via HKDF
    // (info='auth v1'). Domain separation from the cursor MAC key (CursorCodec
    // uses info='cursor v1'). Both rotate atomically on AUTH_HMAC_SECRET
    // restart; rotation overlap is M11b scope.
    constructor(@Inject(DERIVED_KEY_SERVICE) private readonly derivedKeys: { getAuthKey(): Buffer }) {}

    issue(input: IIssueTokenInput): IIssuedToken {
        const iat = Math.floor(input.now.getTime() / 1000);
        const exp = iat + (input.ttlSec > 0 ? input.ttlSec : AUTH_TOKEN_DEFAULT_TTL_SEC);
        const jti = randomUUID();

        const payload: IJwtPayload = {
            sub: input.sub,
            jti,
            scopes: input.scopes,
            iat,
            exp,
        };

        const headerAndPayload = `${AUTH_HS256_HEADER_B64URL}.${base64UrlEncode(JSON.stringify(payload))}`;
        const signature = signHs256(headerAndPayload, this.derivedKeys.getAuthKey());

        return { token: `${headerAndPayload}.${signature}`, jti, exp };
    }

    // Returns the verified subject OR an IAuthFailure. The guard layers a
    // `revoked_jti` check + scope check on top of this — those are the only
    // I/O-touching steps and don't belong in pure crypto verification.
    verify(rawToken: string, now: Date): IAuthSubject | IAuthFailure {
        const parts = rawToken.split('.');

        if (parts.length !== 3) {
            return failure(AuthFailureReasonEnum.MALFORMED);
        }

        const [headerSeg, payloadSeg, signatureSeg] = parts;

        if (headerSeg !== AUTH_HS256_HEADER_B64URL) {
            return failure(AuthFailureReasonEnum.MALFORMED);
        }

        const expected = signHs256(`${headerSeg}.${payloadSeg}`, this.derivedKeys.getAuthKey());
        const expectedBuf = Buffer.from(expected, 'utf8');
        const actualBuf = Buffer.from(signatureSeg, 'utf8');

        if (expectedBuf.byteLength !== actualBuf.byteLength || !timingSafeEqual(expectedBuf, actualBuf)) {
            // M11a W1.5 follow-up — `AuthFailureReasonEnum.BAD_SIGNATURE` now
            // exists in `@bot/shared` (commit e14b098). Promote the engine
            // discriminator onto the wire so signature-verification failures
            // surface as BAD_SIGNATURE instead of MALFORMED. The non-enumerable
            // `engineReason` is retained for backward-compatible audit/metric
            // routing.
            this.logger.warn('auth.verify.failure reason=BAD_SIGNATURE engineReason=BAD_SIGNATURE signatureMismatch=true');

            return failureWithSignal(AuthFailureReasonEnum.BAD_SIGNATURE, 'BAD_SIGNATURE');
        }

        let parsed: IJwtPayload;

        try {
            parsed = JSON.parse(base64UrlDecode(payloadSeg).toString('utf8')) as IJwtPayload;
        } catch {
            return failure(AuthFailureReasonEnum.MALFORMED);
        }

        if (!isWellFormedPayload(parsed)) {
            return failure(AuthFailureReasonEnum.MALFORMED);
        }

        const nowSec = Math.floor(now.getTime() / 1000);

        if (parsed.exp <= nowSec) {
            return failure(AuthFailureReasonEnum.EXPIRED);
        }

        return {
            sub: parsed.sub,
            jti: parsed.jti,
            scopes: parsed.scopes,
            iat: parsed.iat,
            exp: parsed.exp,
        };
    }
}

function failure(reason: AuthFailureReasonEnum): IAuthFailure {
    return { error: 'AUTH_FAILED', reason };
}

// M11a W1.5 — engine-side discriminator riding alongside the wire reason.
// `engineReason` is non-enumerable so it does not serialise into the response
// body (the wire contract stays in `IAuthFailure.reason`); inspectors that
// know about the field (the guard's audit/metric path) read it via the typed
// helper `getEngineReason` and route the signal to the audit row + Telegram.
// When bot-shared-maintainer adds `BAD_SIGNATURE` to `AuthFailureReasonEnum`,
// `failureWithSignal` is the single edit point that promotes the engine
// reason onto the wire.
export type EngineAuthFailureReason = 'BAD_SIGNATURE';

const ENGINE_REASON_KEY = '__engineReason';

function failureWithSignal(reason: AuthFailureReasonEnum, engineReason: EngineAuthFailureReason): IAuthFailure {
    const payload: IAuthFailure & { [ENGINE_REASON_KEY]?: EngineAuthFailureReason } = { error: 'AUTH_FAILED', reason };

    Object.defineProperty(payload, ENGINE_REASON_KEY, {
        value: engineReason,
        enumerable: false,
        writable: false,
        configurable: false,
    });

    return payload;
}

export function getEngineReason(failureBody: IAuthFailure): EngineAuthFailureReason | null {
    const value = (failureBody as { [ENGINE_REASON_KEY]?: EngineAuthFailureReason })[ENGINE_REASON_KEY];

    return value ?? null;
}

function isWellFormedPayload(value: unknown): value is IJwtPayload {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const v = value as Record<string, unknown>;

    if (typeof v.sub !== 'string' || typeof v.jti !== 'string') {
        return false;
    }

    if (typeof v.iat !== 'number' || typeof v.exp !== 'number') {
        return false;
    }

    if (!Array.isArray(v.scopes)) {
        return false;
    }

    return v.scopes.every((s) => typeof s === 'string' && (Object.values(AuthScopeEnum) as string[]).includes(s));
}

// ---------------------------------------------------------------------------
// Revoked JTI repository
// ---------------------------------------------------------------------------

@Injectable()
export class RevokedJtiRepository implements IRevokedJtiRepositoryPort {
    // M9 R1 #5 — switched to @InjectRepository to match the project-wide
    // repository-pattern (every other module-owned repository uses this DI
    // shape rather than DataSource.getRepository). RevokedJtiEntity has a
    // non-numeric primary key (`jti: string`), so it does not satisfy the
    // `BaseRepository<T extends { id: number }>` constraint — extending
    // BaseRepository here is deferred to a small future widening of that
    // generic to accept string PKs (out of scope for this pure refactor).
    constructor(@InjectRepository(RevokedJtiEntity) private readonly repository: Repository<RevokedJtiEntity>) {}

    async isRevoked(jti: string): Promise<boolean> {
        const row = await this.repository.findOne({ where: { jti } });

        return row !== null;
    }

    async revoke(jti: string, revokedBy: string, reason: string | null): Promise<void> {
        // Upsert-safe: re-revoke must be a no-op, not an error. ON CONFLICT DO
        // NOTHING preserves the original revocation timestamp + actor.
        await this.repository.createQueryBuilder().insert().values({ jti, revokedBy, reason }).orIgnore().execute();
    }

    async pruneOlderThan(cutoff: Date): Promise<number> {
        // M11a W1.6 (ADR 0031 §2.5). Single indexed DELETE on `revoked_at`;
        // idx_revoked_jti_revoked_at is present from the M9 migration. Returns
        // the affected row count so the scheduler logs + alerts.
        const result = await this.repository.createQueryBuilder().delete().where('revoked_at < :cutoff', { cutoff }).execute();

        return result.affected ?? 0;
    }

    async countAll(): Promise<number> {
        return this.repository.count();
    }
}

// ---------------------------------------------------------------------------
// WS handshake helper
// ---------------------------------------------------------------------------

@Injectable()
export class WsAuthHandshake implements IWsAuthHandshake {
    constructor(private readonly tokens: AuthTokenService) {}

    verify(rawToken: string): IAuthSubject | IAuthFailure {
        if (typeof rawToken !== 'string' || rawToken.length === 0) {
            return { error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.MISSING };
        }

        return this.tokens.verify(rawToken, new Date());
    }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@Module({
    imports: [AppConfigModule, AlertSinkModule, TypeOrmModule.forFeature([RevokedJtiEntity])],
    providers: [
        { provide: AUTH_SECRET_PROVIDER, useClass: EnvAuthSecretProvider },
        // M11a W1.7 — derived per-domain sub-keys (cursor + auth) computed
        // at boot from the master signing secret via HKDF-Expand. Provided
        // before AuthTokenService so DI ordering matches construction order.
        DerivedKeyService,
        { provide: DERIVED_KEY_SERVICE, useExisting: DerivedKeyService },
        AuthTokenService,
        { provide: REVOKED_JTI_REPOSITORY, useClass: RevokedJtiRepository },
        RevokedJtiRepository,
        WsAuthHandshake,
        AuthCorsInterceptor,
        // M11a W1.6 — local CLOCK provider so the scheduler stays decoupled
        // from ControlModule's CLOCK (CLOCK is a port; duplicate providers are
        // safe by ADR 0024 §IClock).
        { provide: CLOCK, useClass: SystemClock },
        RevokedJtiPruneScheduler,
    ],
    exports: [
        AuthTokenService,
        AUTH_SECRET_PROVIDER,
        DERIVED_KEY_SERVICE,
        DerivedKeyService,
        REVOKED_JTI_REPOSITORY,
        RevokedJtiRepository,
        WsAuthHandshake,
        AuthCorsInterceptor,
    ],
})
export class AuthModule {}
