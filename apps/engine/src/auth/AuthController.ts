import { AuthFailureReasonEnum, AuthScopeEnum, HaltAuditActionEnum, IAuthFailure, ILoginResponse, IRateLimitFailure } from '@bot/shared';
import {
    ArgumentsHost,
    BadRequestException,
    Body,
    Catch,
    Controller,
    ExceptionFilter,
    HttpCode,
    HttpException,
    Inject,
    Logger,
    Post,
    Req,
    Res,
    UnauthorizedException,
    UseFilters,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

import { CLOCK, IClock } from '../common/clock/Clock';
import { HaltFlagService } from '../common/service/HaltFlagService';
import { AppConfigService } from '../config/service';
import { ControlAuditRepository } from '../control/repository/ControlAuditRepository';
import { AuthTokenService } from './AuthModule';
import { LoginRequestDto } from './dto/LoginRequestDto';
import { LoginRateLimiter } from './LoginRateLimiter';
import { AUTH_BASE_PATH, AUTH_LOGIN_PATH, AUTH_LOGIN_SUBJECT, AUTH_TOKEN_DEFAULT_TTL_SEC } from './const/authConsts';

// M10 W0.5 (ADR 0027). POST /v1/auth/login.
//
// Bootstrap path — unauthenticated by design. The CORS allow-list middleware
// (AuthCorsInterceptor, applied globally upstream) still gates origin. The
// endpoint exchanges the long-lived AUTH_BOOTSTRAP_SECRET for a short-lived
// HS256 JWT with scopes from AppConfigService.authLoginScopes (default
// read+halt; admin rejected at boot).
//
// Failure shapes per ADR 0027 §2.2/§2.4 use the existing IAuthFailure /
// IRateLimitFailure envelopes from @bot/shared. The 401 BAD_SECRET reason is
// returned for every secret-comparison failure regardless of internal cause
// (no oracle — ADR 0027 §2.1).
//
// Audit: every outcome (success, failure, throttled) writes ONE row through
// ControlAuditRepository.appendLoginAudit. The bootstrap secret is NEVER
// referenced in the body, logger, exception body, or audit row — secrets stay
// in env-loader memory only.
//
// M10 R2 #1 — the global ValidationPipe (main.ts: whitelist + forbidNonWhitelisted
// + transform) validates LoginRequestDto BEFORE the handler runs. Extra
// fields (e.g. `{ scope: 'admin' }`), wrong types, oversized secrets all
// reject with a 400 from the pipe. The route-scoped LoginValidationFilter
// below intercepts those 400s, writes a LOGIN_FAILURE audit row, and remaps
// the response to the canonical 401 MALFORMED IAuthFailure envelope (ADR
// 0027 §2.2 — there is one wire shape for "bad body").
//
// M10 R2 #2 — `expectedHashCached` is computed ONCE at construction from
// `AppConfigService.authBootstrapSecret`. Per-request only the candidate is
// hashed; the raw env-resident bootstrap secret is never reachable from
// request handlers after boot.

// ---------------------------------------------------------------------------
// Route-scoped filter: remap pipe-side BadRequestException → 401 MALFORMED
// + write the audit row. DI-injected so it can reach the audit repo + halt
// flag + clock without leaking those into the pipe.
// ---------------------------------------------------------------------------

@Catch(BadRequestException)
export class LoginValidationFilter implements ExceptionFilter {
    private readonly logger = new Logger(LoginValidationFilter.name);

    constructor(
        private readonly auditRepo: ControlAuditRepository,
        private readonly haltFlag: HaltFlagService,
        @Inject(CLOCK) private readonly clock: IClock,
    ) {}

    async catch(exception: BadRequestException, host: ArgumentsHost): Promise<void> {
        const ctx = host.switchToHttp();
        const req = ctx.getRequest<Request>();
        const res = ctx.getResponse<Response>();
        const sourceIp = extractSourceIp(req);
        const now = this.clock.now();
        const previousHaltState: 'RUNNING' | 'HALTED' = this.haltFlag.isHalted() ? 'HALTED' : 'RUNNING';

        // Best-effort audit (ADR 0027 §2.5). Never re-throw on audit failure;
        // the canonical 401 MALFORMED response is the operator-facing signal.
        try {
            await this.auditRepo.appendLoginAudit({
                occurredAt: now,
                action: HaltAuditActionEnum.LOGIN_FAILURE,
                sourceIp,
                actorSub: null,
                actorJti: null,
                reason: AuthFailureReasonEnum.MALFORMED,
                previousState: previousHaltState,
            });
        } catch (cause) {
            this.logger.error(`auth.login.audit_failed action=${HaltAuditActionEnum.LOGIN_FAILURE} cause=${(cause as Error).message}`);
        }

        // Log the pipe rejection with source IP for forensic attribution.
        // The bootstrap secret is never in the pipe-error payload (the pipe
        // reports field-level errors only), so no redaction needed beyond
        // discarding the raw exception body.
        this.logger.warn(`auth.login.denied reason=${AuthFailureReasonEnum.MALFORMED} sourceIp=${sourceIp ?? 'unknown'}`);

        const body: IAuthFailure = { error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.MALFORMED };
        // Bypass the original 400 status; the canonical shape is 401.
        res.status(401).json(body);
        // Mute the unused-param warning — we use ctx, not the exception body.
        void exception;
    }
}

@Controller(AUTH_BASE_PATH)
@UseFilters(LoginValidationFilter)
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    // M10 R2 #2 — pre-hashed expected secret. Computed once at boot so:
    //   (a) per-request work shrinks to one SHA-256 + one timingSafeEqual;
    //   (b) the raw bootstrap secret never appears on a request stack frame;
    //   (c) hot-reload of the secret is explicitly out of scope (operator
    //       must restart — same model as AUTH_HMAC_SECRET rotation).
    private readonly expectedHashCached: Buffer;

    constructor(
        private readonly rateLimiter: LoginRateLimiter,
        private readonly tokens: AuthTokenService,
        private readonly auditRepo: ControlAuditRepository,
        private readonly appConfig: AppConfigService,
        private readonly haltFlag: HaltFlagService,
        @Inject(CLOCK) private readonly clock: IClock,
    ) {
        this.expectedHashCached = createHash('sha256').update(this.appConfig.authBootstrapSecret, 'utf8').digest();
    }

    @Post(AUTH_LOGIN_PATH)
    @HttpCode(200)
    async login(@Body() body: LoginRequestDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ILoginResponse> {
        const sourceIp = extractSourceIp(req);
        const now = this.clock.now();
        const previousHaltState: 'RUNNING' | 'HALTED' = this.haltFlag.isHalted() ? 'HALTED' : 'RUNNING';

        // Rate-limit BEFORE secret compare so a flood of garbage bodies cannot
        // amplify hash CPU. (Body shape was already validated by the global
        // ValidationPipe; pipe-side rejections are routed through
        // LoginValidationFilter and never reach this handler.)
        try {
            this.rateLimiter.enforce(sourceIp ?? 'unknown', now);
        } catch (cause) {
            if (cause instanceof HttpException && cause.getStatus() === 429) {
                const rateBody = cause.getResponse() as Partial<IRateLimitFailure>;

                if (typeof rateBody.retryAfterSec === 'number' && rateBody.retryAfterSec > 0) {
                    res.setHeader('Retry-After', String(rateBody.retryAfterSec));
                }

                await this.writeAudit(HaltAuditActionEnum.LOGIN_THROTTLED, {
                    occurredAt: now,
                    sourceIp,
                    actorSub: null,
                    actorJti: null,
                    reason: 'TOO_MANY_LOGIN_ATTEMPTS',
                    previousState: previousHaltState,
                });
            }

            throw cause;
        }

        if (!this.secretMatches(body.secret)) {
            await this.writeAudit(HaltAuditActionEnum.LOGIN_FAILURE, {
                occurredAt: now,
                sourceIp,
                actorSub: null,
                actorJti: null,
                reason: AuthFailureReasonEnum.BAD_SECRET,
                previousState: previousHaltState,
            });

            throw this.authFailure(AuthFailureReasonEnum.BAD_SECRET, sourceIp);
        }

        // Defence-in-depth: the AppConfigService boot check refuses 'admin' in
        // AUTH_LOGIN_SCOPES, but we re-filter at mint time so a future config
        // drift never escalates a login-path token to admin.
        const scopes = this.appConfig.authLoginScopes.filter((s) => s !== AuthScopeEnum.ADMIN);
        const issued = this.tokens.issue({
            sub: AUTH_LOGIN_SUBJECT,
            scopes,
            ttlSec: AUTH_TOKEN_DEFAULT_TTL_SEC,
            now,
        });

        await this.writeAudit(HaltAuditActionEnum.LOGIN_SUCCESS, {
            occurredAt: now,
            sourceIp,
            actorSub: AUTH_LOGIN_SUBJECT,
            actorJti: issued.jti,
            reason: 'login',
            previousState: previousHaltState,
        });

        res.setHeader('Cache-Control', 'no-store');

        return {
            token: issued.token,
            expiresAt: new Date(issued.exp * 1_000).toISOString(),
            scopes,
            subject: AUTH_LOGIN_SUBJECT,
        };
    }

    private secretMatches(candidate: string): boolean {
        // M10 R2 #2 — only the candidate is hashed per request; the expected
        // hash buffer is cached at construction time. timingSafeEqual still
        // sees equal-length buffers (ADR 0027 §2.3) so no length oracle.
        const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();

        return candidateHash.length === this.expectedHashCached.length && timingSafeEqual(candidateHash, this.expectedHashCached);
    }

    private authFailure(reason: AuthFailureReasonEnum, sourceIp: string | null): HttpException {
        const failureBody: IAuthFailure = { error: 'AUTH_FAILED', reason };

        // M10 R2 #4 — include sourceIp in the warn line for forensic
        // attribution. The bootstrap secret is never logged; reason +
        // sourceIp are operational and safe to surface.
        this.logger.warn(`auth.login.denied reason=${reason} sourceIp=${sourceIp ?? 'unknown'}`);

        return new UnauthorizedException(failureBody);
    }

    private async writeAudit(
        action: HaltAuditActionEnum.LOGIN_SUCCESS | HaltAuditActionEnum.LOGIN_FAILURE | HaltAuditActionEnum.LOGIN_THROTTLED,
        params: {
            occurredAt: Date;
            sourceIp: string | null;
            actorSub: string | null;
            actorJti: string | null;
            reason: string;
            previousState: 'RUNNING' | 'HALTED';
        },
    ): Promise<void> {
        try {
            await this.auditRepo.appendLoginAudit({
                occurredAt: params.occurredAt,
                action,
                sourceIp: params.sourceIp,
                actorSub: params.actorSub,
                actorJti: params.actorJti,
                reason: params.reason,
                previousState: params.previousState,
            });
        } catch (cause) {
            // Audit failure must NOT leak the secret. Log only the action +
            // cause; never re-throw — the operator must still see the 401/200
            // so they can react. ADR 0027 §2.5 audit is best-effort under DB
            // pressure; loss is preferable to a request-amplification path.
            this.logger.error(`auth.login.audit_failed action=${action} cause=${(cause as Error).message}`);
        }
    }
}

// M10 R1 #1 (Security HIGH). Source IP is read from `req.ip`, which already
// honours the configured Express `trust proxy` / `TRUST_PROXY_HOPS` setting
// (AppConfigService.trustProxy, ADR 0020 §2.7). Reading `X-Forwarded-For`
// directly let an attacker rotate the first hop per request and defeat the
// per-IP rate-limit windows entirely — the limiter saw a fresh bucket each
// attempt. Mirrors `HaltController.extractSourceIp` (control/HaltController.ts
// line ~273). When trust-proxy is unconfigured or the request is direct,
// `req.ip` collapses to the socket remote address, preserving the previous
// fallback behaviour for non-proxied dev / loopback callers.
function extractSourceIp(req: Request): string | null {
    const raw = req.ip;

    if (typeof raw === 'string' && raw.length > 0) {
        return raw;
    }

    return null;
}
