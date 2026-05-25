import { AuthFailureReasonEnum, AuthScopeEnum, IAuthFailure, IAuthSubject } from '@bot/shared';
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthTokenService, IRevokedJtiRepositoryPort, REVOKED_JTI_REPOSITORY } from './AuthModule';
import { AUTH_BEARER_PREFIX, REQUIRED_SCOPES_METADATA_KEY } from './const/authConsts';
import { IAuthenticatedRequest } from './interface/IAuthenticatedRequest';

// M9 W2 (ADR 0020). NestJS guard that gates every controller marked with
// `@UseGuards(AuthGuard) @RequiredScopes(...)`. Not registered globally — W3 /
// W4 / W5 controllers opt in explicitly so the engine has zero
// "internal-only" bypass routes (ADR 0020 §3).
//
// Failure shape is locked to `IAuthFailure` (typed reason enum). We never
// echo claim contents, never log the bearer, and never leak stack traces in
// the response — secrets stay redacted by construction.

// Controller-scoped decorator. Multiple scopes act as ALL-of (the subject
// must hold each); the W2 brief documents this as the contract for `read`,
// `halt`, `admin`.
export const RequiredScopes = (...scopes: AuthScopeEnum[]): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_SCOPES_METADATA_KEY, scopes);

@Injectable()
export class AuthGuard implements CanActivate {
    private readonly logger = new Logger(AuthGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly tokens: AuthTokenService,
        @Inject(REVOKED_JTI_REPOSITORY) private readonly revoked: IRevokedJtiRepositoryPort,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<IAuthenticatedRequest>();
        const requiredScopes = this.resolveRequiredScopes(context);

        const header = request.headers?.authorization;

        if (typeof header !== 'string' || header.length === 0) {
            this.deny(AuthFailureReasonEnum.MISSING);
        }

        const token = this.stripBearer(header);

        if (token === null) {
            this.deny(AuthFailureReasonEnum.MALFORMED);
        }

        const verified = this.tokens.verify(token, new Date());

        if (this.isFailure(verified)) {
            this.deny(verified.reason);
        }

        if (await this.revoked.isRevoked(verified.jti)) {
            this.deny(AuthFailureReasonEnum.REVOKED);
        }

        if (!this.hasAllScopes(verified, requiredScopes)) {
            this.deny(AuthFailureReasonEnum.BAD_SCOPE);
        }

        request.authSubject = verified;

        return true;
    }

    private resolveRequiredScopes(context: ExecutionContext): ReadonlyArray<AuthScopeEnum> {
        const fromHandler = this.reflector.get<AuthScopeEnum[] | undefined>(REQUIRED_SCOPES_METADATA_KEY, context.getHandler());

        if (fromHandler !== undefined) {
            return fromHandler;
        }

        const fromClass = this.reflector.get<AuthScopeEnum[] | undefined>(REQUIRED_SCOPES_METADATA_KEY, context.getClass());

        return fromClass ?? [];
    }

    private stripBearer(header: string): string | null {
        const lower = header.toLowerCase();

        if (!lower.startsWith(AUTH_BEARER_PREFIX)) {
            return null;
        }

        const token = header.slice(AUTH_BEARER_PREFIX.length).trim();

        if (token.length === 0) {
            return null;
        }

        return token;
    }

    private isFailure(value: IAuthSubject | IAuthFailure): value is IAuthFailure {
        return (value as IAuthFailure).error === 'AUTH_FAILED';
    }

    private hasAllScopes(subject: IAuthSubject, required: ReadonlyArray<AuthScopeEnum>): boolean {
        if (required.length === 0) {
            return true;
        }

        const held = new Set(subject.scopes);

        return required.every((scope) => held.has(scope));
    }

    // Throws an UnauthorizedException whose response body is the locked
    // `IAuthFailure` shape. Never returns. The shared exception filter
    // serialises this directly without re-wrapping.
    private deny(reason: AuthFailureReasonEnum): never {
        const body: IAuthFailure = { error: 'AUTH_FAILED', reason };

        this.logger.warn(`auth.denied reason=${reason}`);

        throw new UnauthorizedException(body);
    }
}
