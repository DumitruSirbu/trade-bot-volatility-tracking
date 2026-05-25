// M10 QA — adversarial tests for apiClient.ts (W1, ADR 0026 §2.3).
//
// Coverage target: Authorization header attachment, 401 → auth-expired event,
// non-JSON response handling, network failure, IApiError shape, rate-limit
// retryAfterSec propagation. No real fetch — controlled via vi.stubGlobal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, AUTH_EXPIRED_EVENT, TOKEN_STORAGE_KEY, apiClient } from './apiClient';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_TOKEN = 'fake.jwt.token';

function makeJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    const allHeaders = new Headers({ 'Content-Type': 'application/json', ...headers });

    return new Response(JSON.stringify(body), { status, headers: allHeaders });
}

function makeTextResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: new Headers({ 'Content-Type': 'text/plain' }) });
}

function makeEmptyResponse(status = 204): Response {
    return new Response(null, { status });
}

// Captures every CustomEvent dispatched on window during a test.
function captureWindowEvents(eventName: string): { captured: Event[] } {
    const captured: Event[] = [];
    const handler = (e: Event): void => {
        captured.push(e);
    };

    window.addEventListener(eventName, handler);

    return { captured };
}

// ---------------------------------------------------------------------------
// Setup: stub sessionStorage + fetch
// ---------------------------------------------------------------------------

beforeEach(() => {
    // Provide a clean sessionStorage stub per test.
    Object.defineProperty(window, 'sessionStorage', {
        value: {
            store: {} as Record<string, string>,
            getItem(key: string) {
                return this.store[key] ?? null;
            },
            setItem(key: string, value: string) {
                this.store[key] = value;
            },
            removeItem(key: string) {
                delete this.store[key];
            },
            clear() {
                this.store = {};
            },
        },
        writable: true,
    });

    window.sessionStorage.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Authorization header tests
// ---------------------------------------------------------------------------

describe('apiClient — Authorization header', () => {
    it('attaches Bearer header when a token exists in sessionStorage', async () => {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, FAKE_TOKEN);
        const fetchFn = vi.fn().mockResolvedValueOnce(makeJsonResponse({ ok: true }));
        vi.stubGlobal('fetch', fetchFn);

        await apiClient.get('/v1/test');

        const calls = fetchFn.mock.calls as Array<[string, RequestInit]>;
        const [, init] = calls[0];
        const headersObj = init.headers as Headers;
        expect(headersObj.get('Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    });

    it('omits Authorization header when no token is present', async () => {
        // sessionStorage is empty — no token set.
        const fetchFn = vi.fn().mockResolvedValueOnce(makeJsonResponse({ ok: true }));
        vi.stubGlobal('fetch', fetchFn);

        await apiClient.get('/v1/health');

        const calls = fetchFn.mock.calls as Array<[string, RequestInit]>;
        const [, init] = calls[0];
        const headersObj = init.headers as Headers;
        expect(headersObj.get('Authorization')).toBeNull();
    });

    it('omits Authorization header when skipAuth is true even if token exists', async () => {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, FAKE_TOKEN);
        const fetchFn = vi.fn().mockResolvedValueOnce(makeJsonResponse({ token: 'new' }));
        vi.stubGlobal('fetch', fetchFn);

        await apiClient.post('/v1/auth/login', { secret: 'x' }, { skipAuth: true });

        const calls = fetchFn.mock.calls as Array<[string, RequestInit]>;
        const [, init] = calls[0];
        const headersObj = init.headers as Headers;
        expect(headersObj.get('Authorization')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 401 auth-expired event
// ---------------------------------------------------------------------------

describe('apiClient — 401 dispatches auth-expired event', () => {
    it('dispatches dashboard:auth-expired on 401 with an AUTH_FAILED expired reason', async () => {
        const { captured } = captureWindowEvents(AUTH_EXPIRED_EVENT);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'AUTH_FAILED', reason: 'expired' }, 401)));

        await expect(apiClient.get('/v1/positions')).rejects.toBeInstanceOf(ApiError);
        expect(captured).toHaveLength(1);
    });

    it('dispatches dashboard:auth-expired on 401 with a revoked reason', async () => {
        const { captured } = captureWindowEvents(AUTH_EXPIRED_EVENT);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'AUTH_FAILED', reason: 'revoked' }, 401)));

        await expect(apiClient.get('/v1/positions')).rejects.toBeInstanceOf(ApiError);
        expect(captured).toHaveLength(1);
    });

    it('removes the token from sessionStorage when 401 fires', async () => {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, FAKE_TOKEN);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'AUTH_FAILED', reason: 'expired' }, 401)));

        await expect(apiClient.get('/v1/positions')).rejects.toBeInstanceOf(ApiError);
        expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    });

    it('does NOT dispatch auth-expired on 401 with BAD_SECRET (login failure, not session expiry)', async () => {
        const { captured } = captureWindowEvents(AUTH_EXPIRED_EVENT);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'AUTH_FAILED', reason: 'BAD_SECRET' }, 401)));

        await expect(apiClient.post('/v1/auth/login', { secret: 'wrong' }, { skipAuth: true })).rejects.toBeInstanceOf(ApiError);
        expect(captured).toHaveLength(0);
    });

    it('does NOT dispatch auth-expired on a 403 (scope failure)', async () => {
        const { captured } = captureWindowEvents(AUTH_EXPIRED_EVENT);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'FORBIDDEN' }, 403)));

        await expect(apiClient.get('/v1/control/halt')).rejects.toBeInstanceOf(ApiError);
        expect(captured).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Non-JSON response
// ---------------------------------------------------------------------------

describe('apiClient — non-JSON response handling', () => {
    it('handles a plain-text error body without throwing a parse error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeTextResponse('Bad Gateway', 502)));

        const err = (await apiClient.get('/v1/positions').catch((e: unknown) => e as ApiError)) as ApiError;

        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(502);
        // Should still produce a meaningful message from the text body.
        expect(err.message).toBeTruthy();
    });

    it('handles an empty 204 response without throwing', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeEmptyResponse(204)));

        const result = await apiClient.post('/v1/something', {});
        expect(result).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Network failure
// ---------------------------------------------------------------------------

describe('apiClient — network failure', () => {
    it('propagates a TypeError when fetch itself rejects (network down)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));

        await expect(apiClient.get('/v1/health')).rejects.toBeInstanceOf(TypeError);
    });

    it('does NOT wrap a network TypeError in ApiError (caller checks instance)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));

        const err = await apiClient.get('/v1/health').catch((e) => e);
        expect(err).not.toBeInstanceOf(ApiError);
    });
});

// ---------------------------------------------------------------------------
// ApiError shape (IApiError contract)
// ---------------------------------------------------------------------------

describe('apiClient — ApiError shape satisfies IApiError', () => {
    it('throws ApiError with code, message, status populated', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'NOT_FOUND', message: 'position not found' }, 404)));

        const err = (await apiClient.get('/v1/positions/bad-id').catch((e: unknown) => e as ApiError)) as ApiError;

        expect(err.code).toBeTruthy();
        expect(err.message).toBeTruthy();
        expect(err.status).toBe(404);
        expect(err.name).toBe('ApiError');
    });

    it('extracts requestId from x-request-id header', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'SERVER_ERROR' }, 500, { 'x-request-id': 'req-abc-123' })));

        const err = (await apiClient.get('/v1/positions').catch((e: unknown) => e as ApiError)) as ApiError;
        expect(err.requestId).toBe('req-abc-123');
    });

    it('extracts retryAfterSec from a 429 RATE_LIMITED response body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'RATE_LIMITED', reason: 'TOO_MANY_LOGIN_ATTEMPTS', retryAfterSec: 42 }, 429)),
        );

        const err = (await apiClient.post('/v1/auth/login', { secret: 'x' }, { skipAuth: true }).catch((e: unknown) => e as ApiError)) as ApiError;
        expect(err.status).toBe(429);
        expect(err.retryAfterSec).toBe(42);
    });

    // BUG FOUND (M10 QA): When the body IS a RATE_LIMITED shape but does NOT
    // include retryAfterSec, the Retry-After header is silently ignored because
    // the ternary in toApiError() short-circuits on isRateLimitFailure(payload).
    // Production path: engine sends { error:'RATE_LIMITED' } + Retry-After: 30 header
    // → retryAfterSec comes back undefined, countdown banner shows wrong value.
    // Fix: change the ternary to: payload.retryAfterSec ?? parseRetryAfter(header).
    // FLAG: route to bot-engine-nestjs/bot-dashboard-react for fix wave.
    it('[BUG] Retry-After header ignored when RATE_LIMITED body lacks retryAfterSec', async () => {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.set('retry-after', '30');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'RATE_LIMITED', reason: 'TOO_MANY_LOGIN_ATTEMPTS' }), { status: 429, headers })),
        );

        const err = (await apiClient.get('/v1/control/halt').catch((e: unknown) => e as ApiError)) as ApiError;
        // This currently fails: retryAfterSec is undefined, not 30.
        expect(err.retryAfterSec).toBe(30);
    });

    it('reads retryAfterSec from body when body has the RATE_LIMITED shape with retryAfterSec', async () => {
        // When the body IS a rate-limit failure AND includes retryAfterSec,
        // the apiClient should use that value (not the header).
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValueOnce(makeJsonResponse({ error: 'RATE_LIMITED', reason: 'TOO_MANY_LOGIN_ATTEMPTS', retryAfterSec: 30 }, 429)),
        );

        const err = (await apiClient.post('/v1/auth/login', {}, { skipAuth: true }).catch((e: unknown) => e as ApiError)) as ApiError;
        expect(err.retryAfterSec).toBe(30);
    });
});

// ---------------------------------------------------------------------------
// Boundary: zero-length token
// ---------------------------------------------------------------------------

describe('apiClient — boundary: empty string token', () => {
    it('omits Authorization header when token is an empty string', async () => {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, '');
        const fetchFn = vi.fn().mockResolvedValueOnce(makeJsonResponse({ ok: true }));
        vi.stubGlobal('fetch', fetchFn);

        await apiClient.get('/v1/health');

        const calls = fetchFn.mock.calls as Array<[string, RequestInit]>;
        const [, init] = calls[0];
        const headersObj = init.headers as Headers;
        // An empty token must not produce `Authorization: Bearer `
        expect(headersObj.get('Authorization')).toBeNull();
    });
});
