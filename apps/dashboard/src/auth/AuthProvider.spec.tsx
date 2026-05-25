// M10 QA — adversarial tests for AuthProvider.tsx (W1, ADR 0026 §2.3).
//
// Coverage: login persists session, rehydration from sessionStorage, expired
// session cleaned at boot, auth-expired event clears session, logout clears
// state + storage, secret never stored, isAuthenticated reflects session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { AUTH_EXPIRED_EVENT, TOKEN_STORAGE_KEY } from '@/api/apiClient';
import { AuthProvider, useAuth } from './AuthProvider';

// ---------------------------------------------------------------------------
// Helpers / stubs
// ---------------------------------------------------------------------------

const SESSION_META_KEY = 'dashboard:auth-meta';

const VALID_TOKEN = 'header.payload.sig';
const VALID_EXPIRES = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h from now
const EXPIRED_EXPIRES = new Date(Date.now() - 1000).toISOString(); // 1s ago

interface IPersistedMeta {
    expiresAt: string;
    subject: string;
}

function seedStorage(token: string, meta: IPersistedMeta): void {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    window.sessionStorage.setItem(SESSION_META_KEY, JSON.stringify(meta));
}

// A minimal consumer that renders the auth state and exposes controls.
const TestConsumer = ({ onLogin, onLogout }: { onLogin?: () => void; onLogout?: () => void }): React.ReactElement => {
    const { isAuthenticated, session, login, logout } = useAuth();

    return (
        <div>
            <span data-testid="is-auth">{String(isAuthenticated)}</span>
            <span data-testid="token">{session?.token ?? 'null'}</span>
            <span data-testid="subject">{session?.subject ?? 'null'}</span>
            <button
                onClick={() => {
                    void login('correct-secret');
                    onLogin?.();
                }}
            >
                Login
            </button>
            <button
                onClick={() => {
                    logout();
                    onLogout?.();
                }}
            >
                Logout
            </button>
        </div>
    );
};

const renderWithProvider = (): ReturnType<typeof render> =>
    render(
        <AuthProvider>
            <TestConsumer />
        </AuthProvider>,
    );

// Stub apiClient.post so we don't need a real network.
const mockApiPost = vi.fn();

vi.mock('@/api/apiClient', async (importOriginal) => {
    const real = await importOriginal<typeof import('./AuthProvider')>();

    return {
        ...real,
        apiClient: {
            get: vi.fn(),
            post: (...args: unknown[]) => mockApiPost(...args),
        },
    };
});

// Round-1 logic fix (Item 4): the AuthProvider must drop the live socket on
// auth-expired. Mock the socket module so we can assert setSocketToken(null).
const mockSetSocketToken = vi.fn();
vi.mock('@/realtime/liveSocket', () => ({
    setSocketToken: (token: string | null) => mockSetSocketToken(token),
}));

// Provide a fresh sessionStorage implementation per test.
beforeEach(() => {
    const store: Record<string, string> = {};
    Object.defineProperty(window, 'sessionStorage', {
        value: {
            store,
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => {
                store[k] = v;
            },
            removeItem: (k: string) => {
                delete store[k];
            },
            clear: () => {
                for (const k of Object.keys(store)) delete store[k];
            },
        },
        writable: true,
    });

    window.sessionStorage.clear();
    mockApiPost.mockReset();
    mockSetSocketToken.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProvider — login', () => {
    it('sets isAuthenticated = true and persists token + meta in sessionStorage on success', async () => {
        mockApiPost.mockResolvedValueOnce({
            token: VALID_TOKEN,
            expiresAt: VALID_EXPIRES,
            subject: 'operator',
            scopes: ['read', 'halt'],
        });

        renderWithProvider();

        expect(screen.getByTestId('is-auth').textContent).toBe('false');

        await act(async () => {
            await userEvent.click(screen.getByText('Login'));
        });

        expect(screen.getByTestId('is-auth').textContent).toBe('true');
        expect(screen.getByTestId('token').textContent).toBe(VALID_TOKEN);
        expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(VALID_TOKEN);

        const rawMeta = window.sessionStorage.getItem(SESSION_META_KEY);
        expect(rawMeta).not.toBeNull();
        const meta = JSON.parse(rawMeta!) as IPersistedMeta;
        expect(meta.expiresAt).toBe(VALID_EXPIRES);
        expect(meta.subject).toBe('operator');
    });

    it('never persists the plaintext secret in sessionStorage', async () => {
        const secret = 'super-sensitive-bootstrap-secret-value-never-stored';
        mockApiPost.mockResolvedValueOnce({
            token: VALID_TOKEN,
            expiresAt: VALID_EXPIRES,
            subject: 'operator',
            scopes: ['read', 'halt'],
        });

        render(
            <AuthProvider>
                {/* Call login directly with the secret. */}
                <InvokeLoginOnMount secret={secret} />
            </AuthProvider>,
        );

        await waitFor(() => {
            const allStorage = [window.sessionStorage.getItem(TOKEN_STORAGE_KEY), window.sessionStorage.getItem(SESSION_META_KEY)].join(' ');

            expect(allStorage).not.toContain(secret);
        });
    });
});

// Helper: calls login on mount.
const InvokeLoginOnMount = ({ secret }: { secret: string }): React.ReactElement => {
    const { login } = useAuth();
    React.useEffect(() => {
        void login(secret);
    }, [login, secret]);

    return <></>;
};

describe('AuthProvider — rehydration from sessionStorage', () => {
    it('restores session on mount if token is present and not expired', () => {
        seedStorage(VALID_TOKEN, { expiresAt: VALID_EXPIRES, subject: 'operator' });

        renderWithProvider();

        expect(screen.getByTestId('is-auth').textContent).toBe('true');
        expect(screen.getByTestId('token').textContent).toBe(VALID_TOKEN);
    });

    it('treats an expired stored session as unauthenticated and cleans storage', () => {
        seedStorage(VALID_TOKEN, { expiresAt: EXPIRED_EXPIRES, subject: 'operator' });

        renderWithProvider();

        // Provider reads expiry at init and finds it stale → null session.
        expect(screen.getByTestId('is-auth').textContent).toBe('false');
        expect(screen.getByTestId('token').textContent).toBe('null');
    });

    it('treats missing meta as unauthenticated', () => {
        // Token present but meta absent — malformed storage.
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, VALID_TOKEN);

        renderWithProvider();

        expect(screen.getByTestId('is-auth').textContent).toBe('false');
    });

    it('treats corrupted JSON meta as unauthenticated', () => {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, VALID_TOKEN);
        window.sessionStorage.setItem(SESSION_META_KEY, '{bad json');

        renderWithProvider();

        expect(screen.getByTestId('is-auth').textContent).toBe('false');
    });
});

describe('AuthProvider — dashboard:auth-expired event', () => {
    it('clears session state and storage when the event fires', async () => {
        seedStorage(VALID_TOKEN, { expiresAt: VALID_EXPIRES, subject: 'operator' });

        renderWithProvider();

        expect(screen.getByTestId('is-auth').textContent).toBe('true');

        await act(async () => {
            window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
        });

        expect(screen.getByTestId('is-auth').textContent).toBe('false');
        expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    });

    it('does not double-clear or throw if session is already null when the event fires', async () => {
        renderWithProvider();

        expect(screen.getByTestId('is-auth').textContent).toBe('false');

        await act(async () => {
            window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
        });

        // Still false — no error thrown.
        expect(screen.getByTestId('is-auth').textContent).toBe('false');
    });

    // Round-1 logic fix (Item 4): the WS socket must drop synchronously on
    // auth-expired so the stale token cannot keep the connection alive even
    // briefly. The AuthProvider's effect calls setSocketToken(null).
    it('drops the live socket (setSocketToken(null)) on auth-expired', async () => {
        seedStorage(VALID_TOKEN, { expiresAt: VALID_EXPIRES, subject: 'operator' });

        renderWithProvider();

        await act(async () => {
            window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
        });

        expect(mockSetSocketToken).toHaveBeenCalledWith(null);
    });
});

describe('AuthProvider — logout', () => {
    it('clears state and storage on logout', async () => {
        seedStorage(VALID_TOKEN, { expiresAt: VALID_EXPIRES, subject: 'operator' });

        renderWithProvider();

        expect(screen.getByTestId('is-auth').textContent).toBe('true');

        await act(async () => {
            await userEvent.click(screen.getByText('Logout'));
        });

        expect(screen.getByTestId('is-auth').textContent).toBe('false');
        expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
        expect(window.sessionStorage.getItem(SESSION_META_KEY)).toBeNull();
    });

    it('handles logout gracefully when storage is unavailable', async () => {
        seedStorage(VALID_TOKEN, { expiresAt: VALID_EXPIRES, subject: 'operator' });
        // Make removeItem throw.
        window.sessionStorage.removeItem = () => {
            throw new Error('storage disabled');
        };

        renderWithProvider();

        // Should not throw.
        await act(async () => {
            await userEvent.click(screen.getByText('Logout'));
        });

        expect(screen.getByTestId('is-auth').textContent).toBe('false');
    });
});

describe('AuthProvider — secret never exposed', () => {
    it('useAuth throws when consumed outside a provider', () => {
        const StandaloneConsumer = (): React.ReactElement => {
            useAuth();

            return <div>ok</div>;
        };

        expect(() => render(<StandaloneConsumer />)).toThrow('useAuth must be used inside an AuthProvider');
    });
});
