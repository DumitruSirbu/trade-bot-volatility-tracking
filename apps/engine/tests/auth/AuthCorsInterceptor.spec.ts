import { AuthFailureReasonEnum } from '@bot/shared';
import type { NextFunction, Request, Response } from 'express';

import { AuthCorsInterceptor } from '../../src/auth/AuthCorsInterceptor';
import { AppConfigService } from '../../src/config/service';

// M9 R1 #4 — AuthCorsInterceptor is now actually wired in AppModule. These
// adversarial tests cover the wired behaviour: preflight + actual disallowed
// origin, allowed origin sets the canonical CORS response headers, and the
// allow-list is sourced from AppConfigService (single source of truth).

function buildAppConfig(allowList: string[]): AppConfigService {
    return { corsAllowlist: allowList } as unknown as AppConfigService;
}

function buildResponse(): { res: Response; setHeader: jest.Mock; status: jest.Mock; json: jest.Mock; end: jest.Mock } {
    const json = jest.fn();
    const end = jest.fn();
    const status = jest.fn().mockReturnValue({ json, end });
    const setHeader = jest.fn();
    const res = { setHeader, status } as unknown as Response;

    return { res, setHeader, status, json, end };
}

function buildRequest(opts: { origin?: string; method?: string }): Request {
    return {
        headers: opts.origin === undefined ? {} : { origin: opts.origin },
        method: opts.method ?? 'GET',
    } as unknown as Request;
}

describe('AuthCorsInterceptor', () => {
    it('allows requests with no Origin header (same-origin / CLI) — auth guard remains the gate', () => {
        const interceptor = new AuthCorsInterceptor(buildAppConfig(['http://localhost:5173']));
        const { res } = buildResponse();
        const next = jest.fn() as NextFunction;

        interceptor.use(buildRequest({}), res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows requests whose Origin is in the AppConfigService allow-list and sets canonical CORS headers', () => {
        const interceptor = new AuthCorsInterceptor(buildAppConfig(['http://localhost:5173']));
        const { res, setHeader } = buildResponse();
        const next = jest.fn() as NextFunction;

        interceptor.use(buildRequest({ origin: 'http://localhost:5173' }), res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost:5173');
        expect(setHeader).toHaveBeenCalledWith('Vary', 'Origin');
        expect(setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
    });

    it('short-circuits OPTIONS preflight with 204 for allowed origins (no next() call)', () => {
        const interceptor = new AuthCorsInterceptor(buildAppConfig(['http://localhost:5173']));
        const { res, status, end } = buildResponse();
        const next = jest.fn() as NextFunction;

        interceptor.use(buildRequest({ origin: 'http://localhost:5173', method: 'OPTIONS' }), res, next);

        expect(status).toHaveBeenCalledWith(204);
        expect(end).toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects preflight from a disallowed origin with 403 + IAuthFailure { CORS_FORBIDDEN }', () => {
        const interceptor = new AuthCorsInterceptor(buildAppConfig(['http://localhost:5173']));
        const { res, status, json } = buildResponse();
        const next = jest.fn() as NextFunction;

        interceptor.use(buildRequest({ origin: 'https://evil.example.com', method: 'OPTIONS' }), res, next);

        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'AUTH_FAILED', reason: AuthFailureReasonEnum.CORS_FORBIDDEN }));
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects an actual (non-preflight) GET from a disallowed origin with 403', () => {
        const interceptor = new AuthCorsInterceptor(buildAppConfig(['http://localhost:5173']));
        const { res, status, json } = buildResponse();
        const next = jest.fn() as NextFunction;

        interceptor.use(buildRequest({ origin: 'https://evil.example.com', method: 'GET' }), res, next);

        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ reason: AuthFailureReasonEnum.CORS_FORBIDDEN }));
        expect(next).not.toHaveBeenCalled();
    });

    it('with an empty allow-list (prod default), every cross-origin request is denied', () => {
        const interceptor = new AuthCorsInterceptor(buildAppConfig([]));
        const { res, status } = buildResponse();
        const next = jest.fn() as NextFunction;

        interceptor.use(buildRequest({ origin: 'http://localhost:5173' }), res, next);

        expect(status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });
});
