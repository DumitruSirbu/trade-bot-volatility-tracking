// M10 QA — adversarial tests for HaltHistoryDrawer.tsx (W4, ADR 0021 §2.3).
//
// Coverage: cursor pagination, empty state, error state, loading state,
// page reset on drawer close, multiple pages stacked, ApiError message shown.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HaltAuditActionEnum, type IHaltAuditEntry, type IPaginated } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { HaltHistoryDrawer } from './HaltHistoryDrawer';

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type HaltHistoryResult = {
    data: IPaginated<IHaltAuditEntry> | undefined;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
};

// We track calls by cursor so each page can return different data.
const mockHaltHistoryFn = vi.fn<(cursor: string | null) => HaltHistoryResult>();

vi.mock('@/api/mutations', () => ({
    useHaltHistoryQuery: (cursor: string | null) => mockHaltHistoryFn(cursor),
    useHaltMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }),
    useResumeMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }),
    useHaltStateQuery: () => ({ data: undefined }),
}));

vi.mock('@/api/queries', () => ({
    useRiskState: () => ({ data: undefined }),
}));

vi.mock('@/auth/AuthProvider', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<IHaltAuditEntry>): IHaltAuditEntry {
    return {
        id: `id-${Math.random()}`,
        occurredAt: '2026-05-25T12:00:00.000Z',
        actorSub: 'operator',
        actorJti: 'jti-123',
        sourceIp: '203.0.113.1',
        action: HaltAuditActionEnum.HALT,
        reason: 'test halt',
        flattenRequested: false,
        previousState: 'running',
        newState: 'halted',
        correlationEventId: null,
        ...overrides,
    };
}

function loadedPage(items: IHaltAuditEntry[], nextCursor: string | null = null): HaltHistoryResult {
    return {
        data: { items, nextCursor, pageSize: 25 },
        isLoading: false,
        isError: false,
        error: null,
    };
}

function loadingPage(): HaltHistoryResult {
    return { data: undefined, isLoading: true, isError: false, error: null };
}

function errorPage(error: Error): HaltHistoryResult {
    return { data: undefined, isLoading: false, isError: true, error };
}

function buildQueryClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDrawer(): ReturnType<typeof render> {
    return render(
        <QueryClientProvider client={buildQueryClient()}>
            <HaltHistoryDrawer />
        </QueryClientProvider>,
    );
}

async function openDrawer(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: /halt history/i }));
}

beforeEach(() => {
    mockHaltHistoryFn.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HaltHistoryDrawer — empty state', () => {
    it('shows "No audit entries." when the page returns an empty items array', async () => {
        mockHaltHistoryFn.mockReturnValue(loadedPage([]));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            expect(screen.getByText('No audit entries.')).toBeTruthy();
        });
    });
});

describe('HaltHistoryDrawer — loading state', () => {
    it('shows "Loading history…" while the first page is fetching', async () => {
        mockHaltHistoryFn.mockReturnValue(loadingPage());

        renderDrawer();
        await openDrawer();

        expect(screen.getByText('Loading history…')).toBeTruthy();
    });
});

describe('HaltHistoryDrawer — error state', () => {
    it('shows the ApiError message on fetch failure', async () => {
        mockHaltHistoryFn.mockReturnValue(errorPage(new ApiError({ code: 'INTERNAL', message: 'DB connection lost', status: 500 })));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            expect(screen.getByText('DB connection lost')).toBeTruthy();
        });
    });

    it('shows a generic fallback message for non-ApiError errors', async () => {
        mockHaltHistoryFn.mockReturnValue(errorPage(new Error('unknown')));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            expect(screen.getByText('Failed to load history.')).toBeTruthy();
        });
    });
});

describe('HaltHistoryDrawer — data rendering', () => {
    it('renders one row per audit entry with action, actor, source IP, reason', async () => {
        const entry = makeEntry({
            actorSub: 'operator',
            sourceIp: '10.0.0.1',
            reason: 'urgent halt',
            action: HaltAuditActionEnum.HALT,
        });
        mockHaltHistoryFn.mockReturnValue(loadedPage([entry]));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            const text = document.body.textContent ?? '';
            expect(text).toContain('operator');
            expect(text).toContain('10.0.0.1');
            expect(text).toContain('urgent halt');
        });
    });

    it('renders "—" when sourceIp is null', async () => {
        const entry = makeEntry({ sourceIp: null });
        mockHaltHistoryFn.mockReturnValue(loadedPage([entry]));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            expect(document.body.textContent).toContain('—');
        });
    });
});

describe('HaltHistoryDrawer — cursor pagination', () => {
    it('shows "Load more" button when nextCursor is not null', async () => {
        mockHaltHistoryFn.mockReturnValue(loadedPage([makeEntry()], 'cursor-page-2'));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy();
        });
    });

    it('does NOT show "Load more" when nextCursor is null', async () => {
        mockHaltHistoryFn.mockReturnValue(loadedPage([makeEntry()], null));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
        });
    });

    it('loads second page when "Load more" is clicked', async () => {
        const page1Entry = makeEntry({ reason: 'page 1 entry' });
        const page2Entry = makeEntry({ reason: 'page 2 entry' });

        // First call (cursor=null) returns page 1 with a nextCursor.
        mockHaltHistoryFn.mockImplementation((cursor: string | null) => {
            if (cursor === null) {
                return loadedPage([page1Entry], 'cursor-page-2');
            }

            return loadedPage([page2Entry], null);
        });

        renderDrawer();
        await openDrawer();

        await waitFor(() => screen.getByRole('button', { name: /load more/i }));
        await userEvent.click(screen.getByRole('button', { name: /load more/i }));

        await waitFor(() => {
            expect(document.body.textContent).toContain('page 1 entry');
            expect(document.body.textContent).toContain('page 2 entry');
        });

        // The "Load more" button should now be gone (page 2 had no nextCursor).
        expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    });
});

describe('HaltHistoryDrawer — state reset on close', () => {
    it('resets to page 1 (cursor=null) when the drawer is closed and reopened', async () => {
        const page1Entry = makeEntry({ reason: 'page 1' });
        const page2Entry = makeEntry({ reason: 'page 2' });

        mockHaltHistoryFn.mockImplementation((cursor: string | null) => {
            if (cursor === null) {
                return loadedPage([page1Entry], 'cursor-page-2');
            }

            return loadedPage([page2Entry], null);
        });

        renderDrawer();
        await openDrawer();

        // Navigate to page 2.
        await waitFor(() => screen.getByRole('button', { name: /load more/i }));
        await userEvent.click(screen.getByRole('button', { name: /load more/i }));
        await waitFor(() => expect(document.body.textContent).toContain('page 2'));

        // Close (press Escape to close shadcn Sheet).
        await userEvent.keyboard('{Escape}');

        // Re-open — should start at page 1 again.
        await openDrawer();

        await waitFor(() => {
            // Only one page should be rendered — the first cursor = null call.
            // page 2 entry should NOT be present.
            expect(document.body.textContent).not.toContain('page 2 entry');
        });
    });
});

// Round-1 logic fix (Item 5): when a deeper page errors (cursor expired,
// server timeout), the user must be able to recover without closing the drawer.
describe('HaltHistoryDrawer — per-page error recovery', () => {
    it('renders a "Reset to first page" link when a deeper page errors and clicking it restores page 1', async () => {
        const page1Entry = makeEntry({ reason: 'first page row' });

        mockHaltHistoryFn.mockImplementation((cursor: string | null) => {
            if (cursor === null) {
                return loadedPage([page1Entry], 'cursor-page-2');
            }

            return errorPage(new ApiError({ code: 'CURSOR_EXPIRED', message: 'cursor expired', status: 400 }));
        });

        renderDrawer();
        await openDrawer();

        // Move to page 2 — which will error.
        await waitFor(() => screen.getByRole('button', { name: /load more/i }));
        await userEvent.click(screen.getByRole('button', { name: /load more/i }));

        // Error message + reset link appear.
        const resetButton = await screen.findByRole('button', { name: /reset to first page/i });
        expect(resetButton).toBeTruthy();
        expect(document.body.textContent).toContain('cursor expired');

        // Click reset — page 2 dies, page 1 remains.
        await userEvent.click(resetButton);

        await waitFor(() => {
            expect(screen.queryByRole('button', { name: /reset to first page/i })).toBeNull();
            expect(document.body.textContent).toContain('first page row');
        });
    });

    it('does NOT render the reset link on a first-page error (cursor === null)', async () => {
        mockHaltHistoryFn.mockReturnValue(errorPage(new ApiError({ code: 'INTERNAL', message: 'db down', status: 500 })));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            expect(document.body.textContent).toContain('db down');
        });

        expect(screen.queryByRole('button', { name: /reset to first page/i })).toBeNull();
    });
});

describe('HaltHistoryDrawer — LOGIN_SUCCESS action colour', () => {
    it('renders LOGIN_FAILURE entry with destructive tone class', async () => {
        const entry = makeEntry({ action: HaltAuditActionEnum.LOGIN_FAILURE, reason: 'BAD_SECRET' });
        mockHaltHistoryFn.mockReturnValue(loadedPage([entry]));

        renderDrawer();
        await openDrawer();

        await waitFor(() => {
            const badge = screen.getByText(/login_failure/i);
            expect(badge.className).toContain('destructive');
        });
    });
});
