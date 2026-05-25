import { AuthFailureReasonEnum, IAuthFailure } from '@bot/shared';
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { AppConfigService } from '../config/service';

// M9 W2 (ADR 0020 §2.3). Origin allow-list middleware. Implemented as a
// NestJS middleware (not an interceptor in the RxJS sense — interceptors run
// AFTER guards, which is too late for preflight) so it can short-circuit
// `OPTIONS` requests from disallowed origins before any route handler / guard
// is consulted.
//
// Naming follows the W2 brief (`AuthCorsInterceptor`); behaviourally it
// implements the cross-origin gate described in ADR 0020 §2.3.
//
// Source of truth: `AppConfigService.corsAllowlist`, parsed once at boot from
// `AUTH_CORS_ALLOWLIST` (M9 R1 #4 — process.env stays inside AppConfigService).
// Empty / unset means "deny all cross-origin" (default-deny in prod per ADR
// §2.3). Same-origin requests (no `Origin` header) pass through untouched —
// the auth guard still gates them on bearer presence.

@Injectable()
export class AuthCorsInterceptor implements NestMiddleware {
    private readonly logger = new Logger(AuthCorsInterceptor.name);

    private readonly allowList: ReadonlySet<string>;

    constructor(appConfig: AppConfigService) {
        this.allowList = new Set(appConfig.corsAllowlist);
    }

    use(req: Request, res: Response, next: NextFunction): void {
        const origin = req.headers.origin;

        // Same-origin / non-browser requests do not send `Origin`. Let them
        // through; the auth guard remains the gate on the bearer.
        if (typeof origin !== 'string' || origin.length === 0) {
            next();

            return;
        }

        if (!this.allowList.has(origin)) {
            this.logger.warn(`cors.denied origin=${origin}`);
            this.rejectForbidden(res);

            return;
        }

        // Origin is allowed — set the canonical CORS response headers. We
        // never echo `*` (ADR 0020 §2.3) and we set credentials=true so the
        // dashboard can send the bearer in a header without a separate
        // preflight failure for credentialed requests.
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

        if (req.method === 'OPTIONS') {
            res.status(204).end();

            return;
        }

        next();
    }

    private rejectForbidden(res: Response): void {
        const body: IAuthFailure = {
            error: 'AUTH_FAILED',
            reason: AuthFailureReasonEnum.CORS_FORBIDDEN,
        };

        res.status(403).json(body);
    }
}
