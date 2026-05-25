import { AuthScopeEnum, HaltSourceEnum, IHaltAuditEntry, IKillSwitchState, IPaginated } from '@bot/shared';
import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpException,
    Inject,
    Logger,
    Optional,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { AuthGuard, RequiredScopes } from '../auth/AuthGuard';
import { IAuthenticatedRequest } from '../auth/interface/IAuthenticatedRequest';
import { CLOCK, IClock } from '../common/clock/Clock';
import { AppConfigService } from '../config/service';
import { HALT_BASE_PATH, HALT_PATH, HALT_REASON_MAX_LEN, HISTORY_PATH, RESUME_PATH } from './const/controlConsts';
import { ControlAuditRepository } from './repository/ControlAuditRepository';
import { HaltRateLimiter, IRateLimitFailure } from './HaltRateLimiter';
import { HaltService } from './HaltService';

// M9 W3 (ADR 0021 §2.1). Operator control-plane endpoints.
//
// Routes:
//   POST /v1/control/halt         scope=halt   body: { reason, flatten? }
//   POST /v1/control/resume       scope=halt   body: { reason }
//   GET  /v1/control/halt         scope=read   → IKillSwitchState
//   GET  /v1/control/halt/history scope=read   → IPaginated<IHaltAuditEntry>
//
// All guarded by `AuthGuard` + `@RequiredScopes(...)`. Body is validated by a
// tiny local schema validator (zod is a transitive dep through @bot/shared and
// we'd rather not import it directly into the engine package). The validator
// rejects with 400 + a typed envelope; the rate limiter throws 429 with
// `Retry-After`.
//
// All clocks are read here at the controller boundary so the service stays
// pure (HaltService accepts `now: Date`).

export interface IHaltRequestBody {
    reason: string;
    flatten?: boolean;
}

export interface IResumeRequestBody {
    reason: string;
}

export interface IHaltResponseBody {
    haltState: 'running' | 'halted';
    haltedAt: string;
    haltReason: string;
    flattenRequested: boolean;
    auditId: string;
}

export interface IResumeResponseBody {
    haltState: 'running' | 'halted';
    resumedAt: string;
    auditId: string;
}

@Controller(HALT_BASE_PATH)
export class HaltController {
    private readonly logger = new Logger(HaltController.name);

    constructor(
        private readonly haltService: HaltService,
        private readonly rateLimiter: HaltRateLimiter,
        private readonly auditRepo: ControlAuditRepository,
        @Inject(CLOCK) private readonly clock: IClock,
        // M9 R1 #4 / R2 wave B (security medium) — @Optional kept so unit-test
        // harnesses that construct the controller without the config service
        // continue to compile. Production wiring (HaltModule) DOES inject
        // AppConfigService; if resolution ever returns undefined at boot we
        // emit a WARN once so operators see the silent flatten-default
        // collapse to `false` rather than discovering it during a live halt.
        @Optional() private readonly appConfig?: AppConfigService,
    ) {
        if (this.appConfig === undefined) {
            this.logger.warn(
                'AppConfigService not resolved; `flatten` operator default collapses to false. ' +
                    'Acceptable in test harnesses — must NOT occur in production wiring.',
            );
        }
    }

    @Post(HALT_PATH)
    @HttpCode(200)
    @UseGuards(AuthGuard)
    @RequiredScopes(AuthScopeEnum.HALT)
    async halt(@Body() rawBody: unknown, @Req() req: IAuthenticatedRequest, @Res({ passthrough: true }) res: Response): Promise<IHaltResponseBody> {
        const subject = requireSubject(req);
        const now = this.clock.now();

        // M9 R1 H + #4 — enforce rate-limit BEFORE body parse so a flood of
        // garbage bodies cannot bypass the throttle by tripping 400 first. On
        // limit-hit we set the `Retry-After` header (RFC 6585) before
        // rethrowing so RFC-conforming clients back off correctly.
        this.applyRateLimit(subject.sub, now, res);

        const body = parseHaltBody(rawBody);
        const flatten = this.resolveFlatten(body.flatten);

        const result = await this.haltService.engageHalt({
            source: HaltSourceEnum.OPERATOR,
            reason: body.reason,
            actorSub: subject.sub,
            actorJti: subject.jti,
            sourceIp: extractSourceIp(req),
            flatten,
            now,
        });

        res.setHeader('Cache-Control', 'no-store');

        return {
            haltState: result.state.haltState,
            haltedAt: result.audit.occurredAt,
            haltReason: `OPERATOR:${body.reason}`,
            flattenRequested: flatten,
            auditId: result.audit.id,
        };
    }

    @Post(RESUME_PATH)
    @HttpCode(200)
    @UseGuards(AuthGuard)
    @RequiredScopes(AuthScopeEnum.HALT)
    async resume(@Body() rawBody: unknown, @Req() req: IAuthenticatedRequest, @Res({ passthrough: true }) res: Response): Promise<IResumeResponseBody> {
        const subject = requireSubject(req);
        const now = this.clock.now();

        this.applyRateLimit(subject.sub, now, res);

        const body = parseResumeBody(rawBody);

        const result = await this.haltService.resume({
            source: HaltSourceEnum.OPERATOR,
            reason: body.reason,
            actorSub: subject.sub,
            actorJti: subject.jti,
            sourceIp: extractSourceIp(req),
            now,
        });

        res.setHeader('Cache-Control', 'no-store');

        return {
            haltState: result.state.haltState,
            resumedAt: result.audit.occurredAt,
            auditId: result.audit.id,
        };
    }

    @Get(HALT_PATH)
    @UseGuards(AuthGuard)
    @RequiredScopes(AuthScopeEnum.READ)
    getState(): IKillSwitchState {
        return this.haltService.getState();
    }

    // M9 R1 #4 — wraps rateLimiter.enforce so the Retry-After header is set
    // BEFORE the HttpException propagates. Pure pass-through on success.
    private applyRateLimit(sub: string, now: Date, res: Response): void {
        try {
            this.rateLimiter.enforce(sub, now);
        } catch (cause) {
            if (cause instanceof HttpException && cause.getStatus() === 429) {
                const body = cause.getResponse() as Partial<IRateLimitFailure>;

                if (typeof body.retryAfterSec === 'number' && body.retryAfterSec > 0) {
                    res.setHeader('Retry-After', String(body.retryAfterSec));
                }
            }

            throw cause;
        }
    }

    // M9 R1 #4 — explicit operator value wins; otherwise the AppConfigService
    // boot-resolved default (defaults to false when AppConfigService absent,
    // e.g. unit-test harnesses).
    private resolveFlatten(explicit: boolean | undefined): boolean {
        if (explicit !== undefined) {
            return explicit;
        }

        return this.appConfig?.flattenDefault ?? false;
    }

    @Get(HISTORY_PATH)
    @UseGuards(AuthGuard)
    @RequiredScopes(AuthScopeEnum.READ)
    async getHistory(@Query('cursor') cursor?: string, @Query('pageSize') pageSize?: string): Promise<IPaginated<IHaltAuditEntry>> {
        const parsedPageSize = parsePageSize(pageSize);
        const page = await this.auditRepo.findHistoryPage(cursor ?? null, parsedPageSize);

        return {
            items: page.items,
            nextCursor: page.nextCursor,
            pageSize: page.pageSize,
        };
    }
}

// ---------------------------------------------------------------------------
// Body validation — hand-rolled, no zod dep. Each failure throws
// BadRequestException with a `IValidationFailure` envelope.
// ---------------------------------------------------------------------------

interface IValidationFailure {
    error: 'VALIDATION_FAILED';
    reason: string;
}

function parseHaltBody(raw: unknown): IHaltRequestBody {
    const obj = requireObject(raw);
    const reason = requireReason(obj.reason);
    const flatten = optionalBoolean(obj.flatten, 'flatten');

    return { reason, flatten };
}

function parseResumeBody(raw: unknown): IResumeRequestBody {
    const obj = requireObject(raw);
    const reason = requireReason(obj.reason);

    return { reason };
}

function requireObject(raw: unknown): Record<string, unknown> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw badRequest('body must be a JSON object');
    }

    return raw as Record<string, unknown>;
}

function requireReason(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw badRequest('reason must be a non-empty string');
    }

    if (value.length > HALT_REASON_MAX_LEN) {
        throw badRequest(`reason exceeds ${HALT_REASON_MAX_LEN} chars`);
    }

    return value;
}

function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'boolean') {
        throw badRequest(`${fieldName} must be a boolean`);
    }

    return value;
}

function badRequest(reason: string): BadRequestException {
    const body: IValidationFailure = { error: 'VALIDATION_FAILED', reason };

    return new BadRequestException(body);
}

function requireSubject(req: IAuthenticatedRequest): { sub: string; jti: string } {
    const subject = req.authSubject;

    if (subject === undefined) {
        // AuthGuard ran before us — this should be unreachable. Defensive
        // rather than relying on the type assertion.
        throw new BadRequestException({ error: 'VALIDATION_FAILED', reason: 'missing auth subject' });
    }

    return { sub: subject.sub, jti: subject.jti };
}

function extractSourceIp(req: Request): string | null {
    const raw = req.ip;

    if (typeof raw !== 'string' || raw.length === 0) {
        return null;
    }

    // Loopback addresses normalise to null per ADR 0021 §2.3.
    if (raw === '::1' || raw === '127.0.0.1' || raw === '::ffff:127.0.0.1') {
        return null;
    }

    return raw;
}

function parsePageSize(raw: string | undefined): number | null {
    if (raw === undefined || raw.length === 0) {
        return null;
    }

    const parsed = Number.parseInt(raw, 10);

    if (Number.isNaN(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}
