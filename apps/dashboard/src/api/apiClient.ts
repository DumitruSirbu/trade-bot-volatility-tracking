import type { IApiError, IAuthFailure, IRateLimitFailure } from '@bot/shared';

// Token storage key — kept in sessionStorage per ADR 0026 §2.3 (bounded
// blast radius on tab close). The same key is read by AuthProvider on boot.
export const TOKEN_STORAGE_KEY = 'dashboard:auth-token';
export const AUTH_EXPIRED_EVENT = 'dashboard:auth-expired';

const RETRY_AFTER_HEADER = 'retry-after';
const REQUEST_ID_HEADER = 'x-request-id';

const AUTH_EXPIRED_REASONS = new Set(['expired', 'revoked', 'missing', 'malformed', 'bad_scope']);

export class ApiError extends Error implements IApiError {
    public readonly code: string;
    public readonly status: number;
    public readonly requestId?: string;
    public readonly retryAfterSec?: number;

    public constructor(args: { code: string; message: string; status: number; requestId?: string; retryAfterSec?: number }) {
        super(args.message);
        this.name = 'ApiError';
        this.code = args.code;
        this.status = args.status;
        this.requestId = args.requestId;
        this.retryAfterSec = args.retryAfterSec;
    }
}

export interface IApiRequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    body?: unknown;
    signal?: AbortSignal;
    skipAuth?: boolean;
}

const readToken = (): string | null => {
    try {
        return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
        return null;
    }
};

const buildHeaders = (skipAuth: boolean, hasBody: boolean): Headers => {
    const headers = new Headers();

    if (hasBody) {
        headers.set('Content-Type', 'application/json');
    }

    if (!skipAuth) {
        const token = readToken();

        if (token) {
            headers.set('Authorization', `Bearer ${token}`);
        }
    }

    return headers;
};

const parseRetryAfter = (raw: string | null): number | undefined => {
    if (!raw) {
        return undefined;
    }

    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const dispatchAuthExpired = (): void => {
    try {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
        /* storage may be disabled; AuthProvider will still reset state */
    }

    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
};

const isAuthExpiredFailure = (payload: unknown): payload is IAuthFailure => {
    if (typeof payload !== 'object' || payload === null) {
        return false;
    }

    const candidate = payload as Partial<IAuthFailure>;

    return candidate.error === 'AUTH_FAILED' && typeof candidate.reason === 'string' && AUTH_EXPIRED_REASONS.has(candidate.reason);
};

const isRateLimitFailure = (payload: unknown): payload is IRateLimitFailure => {
    if (typeof payload !== 'object' || payload === null) {
        return false;
    }

    const candidate = payload as Partial<IRateLimitFailure>;

    return candidate.error === 'RATE_LIMITED';
};

const readJsonSafely = async (response: Response): Promise<unknown> => {
    const text = await response.text();

    if (text.length === 0) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const extractMessage = (payload: unknown, fallback: string): string => {
    if (typeof payload === 'string') {
        return payload;
    }

    if (typeof payload === 'object' && payload !== null) {
        const candidate = payload as { message?: unknown; reason?: unknown };

        if (typeof candidate.message === 'string') {
            return candidate.message;
        }

        if (typeof candidate.reason === 'string') {
            return candidate.reason;
        }
    }

    return fallback;
};

const extractCode = (payload: unknown, status: number): string => {
    if (typeof payload === 'object' && payload !== null) {
        const candidate = payload as { error?: unknown; reason?: unknown; code?: unknown };

        if (typeof candidate.reason === 'string') {
            return candidate.reason.toUpperCase();
        }

        if (typeof candidate.error === 'string') {
            return candidate.error;
        }

        if (typeof candidate.code === 'string') {
            return candidate.code;
        }
    }

    return `HTTP_${status}`;
};

const toApiError = async (response: Response): Promise<ApiError> => {
    const payload = await readJsonSafely(response);
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    const code = extractCode(payload, response.status);
    const message = extractMessage(payload, response.statusText || 'Request failed');
    const retryAfterSec = isRateLimitFailure(payload)
        ? (payload.retryAfterSec ?? parseRetryAfter(response.headers.get(RETRY_AFTER_HEADER)))
        : parseRetryAfter(response.headers.get(RETRY_AFTER_HEADER));

    if (response.status === 401 && isAuthExpiredFailure(payload)) {
        dispatchAuthExpired();
    }

    return new ApiError({ code, message, status: response.status, requestId, retryAfterSec });
};

const performRequest = async <TResponse>(path: string, options: IApiRequestOptions): Promise<TResponse> => {
    const method = options.method ?? 'GET';
    const hasBody = options.body !== undefined;
    const headers = buildHeaders(options.skipAuth ?? false, hasBody);

    const response = await fetch(path, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
        credentials: 'same-origin',
    });

    if (!response.ok) {
        throw await toApiError(response);
    }

    if (response.status === 204) {
        return undefined as TResponse;
    }

    return (await readJsonSafely(response)) as TResponse;
};

export const apiClient = {
    get<TResponse>(path: string, options: Omit<IApiRequestOptions, 'method' | 'body'> = {}): Promise<TResponse> {
        return performRequest<TResponse>(path, { ...options, method: 'GET' });
    },
    post<TResponse>(path: string, body: unknown, options: Omit<IApiRequestOptions, 'method' | 'body'> = {}): Promise<TResponse> {
        return performRequest<TResponse>(path, { ...options, method: 'POST', body });
    },
};
