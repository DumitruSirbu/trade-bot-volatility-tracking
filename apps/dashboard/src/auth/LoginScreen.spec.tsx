// M10 QA — adversarial tests for LoginScreen.tsx (W1, ADR 0026 §2.3, ADR 0027).
//
// Coverage: submit disabled when secret empty/whitespace/pending; secret
// cleared on success, failure, error; BAD_SECRET / RATE_LIMITED (Retry-After)
// / MALFORMED / network errors mapped to inline messages; double-submit
// prevented; secret never echoed back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthFailureReasonEnum } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { LoginScreen } from './LoginScreen';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// useAuth.login is the seam we control. AuthProvider is integration-level;
// here we test the UI layer only.
const mockLogin = vi.fn<(secret: string) => Promise<void>>();

vi.mock('./AuthProvider', () => ({
    useAuth: () => ({
        login: mockLogin,
        logout: vi.fn(),
        isAuthenticated: false,
        session: null,
    }),
}));

function renderScreen(): ReturnType<typeof render> {
    return render(<LoginScreen />);
}

function secretInput(): HTMLElement {
    return screen.getByLabelText('Bootstrap secret');
}

function submitButton(): HTMLElement {
    return screen.getByRole('button', { name: /sign in/i });
}

beforeEach(() => {
    mockLogin.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — submit disabled states
// ---------------------------------------------------------------------------

describe('LoginScreen — submit disabled conditions', () => {
    it('submit button is disabled when the secret field is empty', () => {
        renderScreen();
        expect(submitButton()).toBeDisabled();
    });

    it('submit button is disabled when the secret contains only whitespace', async () => {
        renderScreen();
        await userEvent.type(secretInput(), '   ');
        expect(submitButton()).toBeDisabled();
    });

    it('submit button is enabled when secret has at least one non-whitespace character', async () => {
        renderScreen();
        await userEvent.type(secretInput(), 's');
        expect(submitButton()).not.toBeDisabled();
    });

    it('submit button shows "Signing in…" and is disabled while the request is in flight', async () => {
        // Never resolves during this test — simulates a slow network.
        mockLogin.mockReturnValue(new Promise(() => undefined));

        renderScreen();
        await userEvent.type(secretInput(), 'valid-secret');
        await userEvent.click(submitButton());

        // The pending state must disable the button.
        const btn = screen.getByRole('button', { name: /signing in/i });
        expect(btn).toBeDisabled();
    });
});

// ---------------------------------------------------------------------------
// Tests — secret cleared on every outcome
// ---------------------------------------------------------------------------

describe('LoginScreen — secret cleared on submit outcome', () => {
    it('clears the secret field on successful login', async () => {
        mockLogin.mockResolvedValueOnce(undefined);

        renderScreen();
        await userEvent.type(secretInput(), 'correct-secret');
        await userEvent.click(submitButton());

        await waitFor(() => {
            expect((secretInput() as HTMLInputElement).value).toBe('');
        });
    });

    it('clears the secret field on a BAD_SECRET failure', async () => {
        mockLogin.mockRejectedValueOnce(new ApiError({ code: AuthFailureReasonEnum.BAD_SECRET.toUpperCase(), message: 'bad secret', status: 401 }));

        renderScreen();
        await userEvent.type(secretInput(), 'wrong-secret');
        await userEvent.click(submitButton());

        await waitFor(() => {
            expect((secretInput() as HTMLInputElement).value).toBe('');
        });
    });

    it('clears the secret field on a network error', async () => {
        mockLogin.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        renderScreen();
        await userEvent.type(secretInput(), 'some-secret');
        await userEvent.click(submitButton());

        await waitFor(() => {
            expect((secretInput() as HTMLInputElement).value).toBe('');
        });
    });
});

// ---------------------------------------------------------------------------
// Tests — error messages
// ---------------------------------------------------------------------------

describe('LoginScreen — error message mapping', () => {
    it('shows "Wrong bootstrap secret." on BAD_SECRET', async () => {
        mockLogin.mockRejectedValueOnce(new ApiError({ code: 'BAD_SECRET', message: 'bad secret', status: 401 }));

        renderScreen();
        await userEvent.type(secretInput(), 'wrong');
        await userEvent.click(submitButton());

        await waitFor(() => {
            expect(screen.getByRole('alert').textContent).toBe('Wrong bootstrap secret.');
        });
    });

    it('shows "Malformed login request." on MALFORMED', async () => {
        mockLogin.mockRejectedValueOnce(new ApiError({ code: 'MALFORMED', message: 'malformed', status: 400 }));

        renderScreen();
        await userEvent.type(secretInput(), 'x');
        await userEvent.click(submitButton());

        await waitFor(() => {
            expect(screen.getByRole('alert').textContent).toMatch(/malformed login request/i);
        });
    });

    it('shows Retry-After countdown on 429 RATE_LIMITED', async () => {
        mockLogin.mockRejectedValueOnce(new ApiError({ code: 'TOO_MANY_LOGIN_ATTEMPTS', message: 'rate limited', status: 429, retryAfterSec: 42 }));

        renderScreen();
        await userEvent.type(secretInput(), 'x');
        await userEvent.click(submitButton());

        await waitFor(() => {
            const alertText = screen.getByRole('alert').textContent ?? '';
            expect(alertText).toContain('42');
        });
    });

    it('shows a network-error message on TypeError (fetch failure)', async () => {
        mockLogin.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        renderScreen();
        await userEvent.type(secretInput(), 'x');
        await userEvent.click(submitButton());

        await waitFor(() => {
            const alertText = screen.getByRole('alert').textContent ?? '';
            expect(alertText).toMatch(/network|engine/i);
        });
    });

    it('clears the error message before the next submission attempt', async () => {
        mockLogin.mockRejectedValueOnce(new ApiError({ code: 'BAD_SECRET', message: 'bad', status: 401 })).mockResolvedValueOnce(undefined);

        renderScreen();
        await userEvent.type(secretInput(), 'wrong');
        await userEvent.click(submitButton());

        await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

        // Second attempt — the error must clear during the request.
        await userEvent.type(secretInput(), 'correct');
        await userEvent.click(submitButton());

        await waitFor(() => {
            expect(screen.queryByRole('alert')).toBeNull();
        });
    });

    it('never echoes the secret back into the DOM after submit (even in the error message)', async () => {
        const secret = 'ultra-sensitive-bootstrap-12345';
        mockLogin.mockRejectedValueOnce(new ApiError({ code: 'BAD_SECRET', message: `bad secret was ${secret}`, status: 401 }));

        renderScreen();
        await userEvent.type(secretInput(), secret);
        await userEvent.click(submitButton());

        await waitFor(() => screen.getByRole('alert'));

        // The secret must not appear as visible text anywhere in the DOM.
        // The input is type="password" so the browser won't render it, but
        // the error message must not embed it either.
        expect(document.body.textContent).not.toContain(secret);
    });
});

// ---------------------------------------------------------------------------
// Tests — double-submit prevention
// ---------------------------------------------------------------------------

describe('LoginScreen — double-submit prevention', () => {
    it('calls login exactly once even if the button is clicked rapidly', async () => {
        // Slow response that never resolves.
        mockLogin.mockReturnValue(new Promise(() => undefined));

        renderScreen();
        await userEvent.type(secretInput(), 'valid');
        await userEvent.click(submitButton());

        // After first click the button label changes to "Signing in…" and is
        // disabled — userEvent.click on a disabled button is a no-op.
        const pendingBtn = screen.getByRole('button', { name: /signing in/i });
        expect(pendingBtn).toBeDisabled();

        // Attempt to click the disabled button — should not call login again.
        await userEvent.click(pendingBtn);

        expect(mockLogin).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Tests — secret field type
// ---------------------------------------------------------------------------

describe('LoginScreen — secret field is type=password', () => {
    it('the secret input has type="password" so the value is masked', () => {
        renderScreen();
        expect((secretInput() as HTMLInputElement).type).toBe('password');
    });
});
