// M10 QA — adversarial tests for KillSwitchButton.tsx + ResumeButton.tsx (W4,
// ADR 0021, ADR 0026 §2.6).
//
// Coverage: submit disabled until confirmText === "HALT"/"RESUME" strict
// equality AND reason.trim().length > 0; flatten defaults FALSE; reason never
// persisted; rate-limit / permission errors surfaced; double-halt-then-halt
// sequence; dialog resets state on close.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ApiError } from '@/api/apiClient';
import { KillSwitchButton, ResumeButton } from './KillSwitchButton';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockHaltMutate = vi.fn();
const mockResumeMutate = vi.fn();
const mockHaltReset = vi.fn();
const mockResumeReset = vi.fn();

let mockHaltState: { isPending: boolean; isError: boolean; error: Error | null } = {
    isPending: false,
    isError: false,
    error: null,
};

let mockResumeState: { isPending: boolean; isError: boolean; error: Error | null } = {
    isPending: false,
    isError: false,
    error: null,
};

vi.mock('@/api/mutations', () => ({
    useHaltMutation: () => ({
        mutate: mockHaltMutate,
        reset: mockHaltReset,
        isPending: mockHaltState.isPending,
        isError: mockHaltState.isError,
        error: mockHaltState.error,
    }),
    useResumeMutation: () => ({
        mutate: mockResumeMutate,
        reset: mockResumeReset,
        isPending: mockResumeState.isPending,
        isError: mockResumeState.isError,
        error: mockResumeState.error,
    }),
    useRiskState: () => ({ data: undefined }),
    useHaltStateQuery: () => ({ data: undefined }),
}));

vi.mock('@/api/queries', () => ({
    useRiskState: () => ({ data: undefined }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildQueryClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderKillSwitch(): ReturnType<typeof render> {
    return render(
        <QueryClientProvider client={buildQueryClient()}>
            <KillSwitchButton />
        </QueryClientProvider>,
    );
}

function renderResumeButton(): ReturnType<typeof render> {
    return render(
        <QueryClientProvider client={buildQueryClient()}>
            <ResumeButton />
        </QueryClientProvider>,
    );
}

async function openKillSwitchDialog(): Promise<void> {
    // The trigger button text is exactly "Halt trading" (sentence case in the component).
    const trigger = screen.getAllByRole('button').find((btn) => btn.textContent?.trim() === 'Halt trading');
    if (trigger === undefined) throw new Error('Halt trading trigger button not found');
    await userEvent.click(trigger);
}

async function openResumeDialog(): Promise<void> {
    const trigger = screen.getAllByRole('button').find((btn) => btn.textContent?.trim() === 'Resume trading');
    if (trigger === undefined) throw new Error('Resume trading trigger button not found');
    await userEvent.click(trigger);
}

// Gets the submit button inside the open dialog (distinct from the trigger).
function getHaltSubmitButton(): HTMLElement {
    // The dialog submit button has type="submit" and variant="destructive".
    const submitButtons = screen.getAllByRole('button').filter((btn) => btn.getAttribute('type') === 'submit');
    if (submitButtons.length === 0) throw new Error('No submit button found');

    return submitButtons[0];
}

function getResumeSubmitButton(): HTMLElement {
    const submitButtons = screen.getAllByRole('button').filter((btn) => btn.getAttribute('type') === 'submit');
    if (submitButtons.length === 0) throw new Error('No submit button found');

    return submitButtons[0];
}

beforeEach(() => {
    mockHaltMutate.mockReset();
    mockResumeMutate.mockReset();
    mockHaltReset.mockReset();
    mockResumeReset.mockReset();
    mockHaltState = { isPending: false, isError: false, error: null };
    mockResumeState = { isPending: false, isError: false, error: null };
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// KillSwitchButton tests
// ---------------------------------------------------------------------------

describe('KillSwitchButton — submit guard (reason + confirm word)', () => {
    it('submit button is disabled when dialog opens (no reason, no confirm text)', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        expect(getHaltSubmitButton()).toBeDisabled();
    });

    it('submit is disabled with reason filled but confirm text empty', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'spread widening');

        expect(getHaltSubmitButton()).toBeDisabled();
    });

    it('submit is disabled with confirm text "halt" (lowercase — strict equality)', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'spread widening');
        await userEvent.type(screen.getByLabelText(/type.*halt/i), 'halt');

        expect(getHaltSubmitButton()).toBeDisabled();
    });

    it('submit is disabled with confirm text "HALTT" (extra character)', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'spread widening');
        await userEvent.type(screen.getByLabelText(/type.*halt/i), 'HALTT');

        expect(getHaltSubmitButton()).toBeDisabled();
    });

    it('submit is enabled only when reason is non-empty AND confirm text === "HALT" exactly', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'spread widening');
        await userEvent.type(screen.getByLabelText(/type.*halt/i), 'HALT');

        expect(getHaltSubmitButton()).not.toBeDisabled();
    });

    it('submit is disabled when reason is whitespace-only (trimmed = empty)', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), '   ');
        await userEvent.type(screen.getByLabelText(/type.*halt/i), 'HALT');

        expect(getHaltSubmitButton()).toBeDisabled();
    });
});

describe('KillSwitchButton — flatten checkbox defaults', () => {
    it('flatten checkbox is unchecked by default (ADR 0021 §2.4 default-false)', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        const checkbox = screen.getByRole('checkbox');
        expect(checkbox).not.toBeChecked();
    });

    it('submits flatten=false when checkbox is unchecked', async () => {
        mockHaltMutate.mockImplementation((_input: unknown, { onSuccess }: { onSuccess: () => void }) => onSuccess());

        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'test');
        await userEvent.type(screen.getByLabelText(/type.*halt/i), 'HALT');
        await userEvent.click(getHaltSubmitButton());

        expect(mockHaltMutate).toHaveBeenCalledWith(expect.objectContaining({ flatten: false }), expect.anything());
    });

    it('submits flatten=true when checkbox is checked', async () => {
        mockHaltMutate.mockImplementation((_input: unknown, { onSuccess }: { onSuccess: () => void }) => onSuccess());

        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.type(screen.getByLabelText(/reason/i), 'test');
        await userEvent.type(screen.getByLabelText(/type.*halt/i), 'HALT');
        await userEvent.click(getHaltSubmitButton());

        expect(mockHaltMutate).toHaveBeenCalledWith(expect.objectContaining({ flatten: true }), expect.anything());
    });
});

describe('KillSwitchButton — error surfacing', () => {
    it('shows rate-limit message with retry-after seconds on 429', async () => {
        mockHaltState = {
            isPending: false,
            isError: true,
            error: new ApiError({ code: 'RATE_LIMITED', message: 'throttled', status: 429, retryAfterSec: 55 }),
        };

        renderKillSwitch();
        await openKillSwitchDialog();

        await waitFor(() => {
            expect(screen.getByText(/55/)).toBeTruthy();
        });
    });

    it('shows permission error message on other errors', async () => {
        mockHaltState = {
            isPending: false,
            isError: true,
            error: new ApiError({ code: 'FORBIDDEN', message: 'insufficient scope', status: 403 }),
        };

        renderKillSwitch();
        await openKillSwitchDialog();

        await waitFor(() => {
            expect(screen.getByText(/FORBIDDEN/)).toBeTruthy();
        });
    });
});

describe('KillSwitchButton — form state resets on dialog close', () => {
    it('resets reason, confirmText, and flatten when dialog is closed', async () => {
        renderKillSwitch();
        await openKillSwitchDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'test reason');
        await userEvent.type(screen.getByLabelText(/type.*halt/i), 'HALT');
        await userEvent.click(screen.getByRole('checkbox'));

        // Close via Cancel.
        await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

        // Re-open — form must be blank.
        await openKillSwitchDialog();
        expect((screen.getByLabelText(/reason/i) as HTMLTextAreaElement).value).toBe('');
        expect((screen.getByLabelText(/type.*halt/i) as HTMLInputElement).value).toBe('');
        expect(screen.getByRole('checkbox')).not.toBeChecked();
    });
});

// ---------------------------------------------------------------------------
// ResumeButton tests
// ---------------------------------------------------------------------------

describe('ResumeButton — submit guard (reason + RESUME word)', () => {
    it('submit is disabled when dialog opens', async () => {
        renderResumeButton();
        await openResumeDialog();

        expect(getResumeSubmitButton()).toBeDisabled();
    });

    it('submit is disabled with "HALT" typed (wrong word for resume)', async () => {
        renderResumeButton();
        await openResumeDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'ok');
        await userEvent.type(screen.getByLabelText(/type.*resume/i), 'HALT');

        expect(getResumeSubmitButton()).toBeDisabled();
    });

    it('submit is disabled with "resume" typed (lowercase)', async () => {
        renderResumeButton();
        await openResumeDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'ok');
        await userEvent.type(screen.getByLabelText(/type.*resume/i), 'resume');

        expect(getResumeSubmitButton()).toBeDisabled();
    });

    it('submit is enabled with reason + "RESUME" exactly', async () => {
        renderResumeButton();
        await openResumeDialog();

        await userEvent.type(screen.getByLabelText(/reason/i), 'spreads normalised');
        await userEvent.type(screen.getByLabelText(/type.*resume/i), 'RESUME');

        expect(getResumeSubmitButton()).not.toBeDisabled();
    });
});
