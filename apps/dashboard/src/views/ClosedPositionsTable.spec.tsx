// Tests for ClosedPositionsTable.tsx — closed-position columns, null rendering,
// PnL sign tinting, cursor-stack paging, empty state, row-click navigation, and
// the formatDurationMs helper boundaries.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IClosedPositionView, IPaginated } from '@bot/shared';
import { ExitReasonEnum, PositionSideEnum } from '@bot/shared';

import { formatDurationMs } from '@/lib/utils';
import { ClosedPositionsTable } from './ClosedPositionsTable';

// ---------------------------------------------------------------------------
// Cursor-aware mock: the hook returns a page keyed by the cursor it is called
// with, so Next/Previous navigation can be observed end-to-end.
// ---------------------------------------------------------------------------

type ClosedResult = {
    data: IPaginated<IClosedPositionView> | undefined;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
};

const pageByCursor = new Map<string | null, ClosedResult>();
const mockNavigate = vi.fn();

vi.mock('@/api/queries', () => ({
    usePositionsClosed: (cursor: string | null) =>
        pageByCursor.get(cursor) ?? { data: { items: [], nextCursor: null, pageSize: 50 }, isLoading: false, isError: false, error: null },
}));

vi.mock('react-router-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-router-dom')>();
    return { ...actual, useNavigate: () => mockNavigate };
});

function makeClosed(overrides: Partial<IClosedPositionView> = {}): IClosedPositionView {
    return {
        id: `pos-${Math.random().toString(36).slice(2)}`,
        symbol: 'BTC/USDT:USDT',
        side: PositionSideEnum.LONG,
        entryPrice: '64250.1234',
        exitPrice: '63900.5',
        qty: '0.01',
        leverage: '3',
        realizedPnlUsd: '12.18',
        openedAt: '2026-05-28T10:00:00.000Z',
        closedAt: '2026-05-28T11:42:00.000Z',
        exitReason: ExitReasonEnum.TAKE_PROFIT,
        strategyVersionId: 'v3',
        ...overrides,
    };
}

function page(items: IClosedPositionView[], nextCursor: string | null = null): IPaginated<IClosedPositionView> {
    return { items, nextCursor, pageSize: 50 };
}

function setPage(cursor: string | null, items: IClosedPositionView[], nextCursor: string | null = null): void {
    pageByCursor.set(cursor, { data: page(items, nextCursor), isLoading: false, isError: false, error: null });
}

function buildQueryClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderTable(): ReturnType<typeof render> {
    return render(
        <QueryClientProvider client={buildQueryClient()}>
            <MemoryRouter>
                <ClosedPositionsTable />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    pageByCursor.clear();
    mockNavigate.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Columns / rendering
// ---------------------------------------------------------------------------

describe('ClosedPositionsTable — columns', () => {
    it('renders all closed-position columns from the row data', () => {
        setPage(null, [makeClosed()]);
        renderTable();

        expect(screen.getByText('BTC/USDT:USDT')).toBeInTheDocument();
        expect(screen.getByText('LONG')).toBeInTheDocument();
        expect(screen.getByText('3x')).toBeInTheDocument();
        expect(screen.getByText('64,250.1234')).toBeInTheDocument();
        expect(screen.getByText('63,900.5000')).toBeInTheDocument();
        expect(screen.getByText('12.18')).toBeInTheDocument();
        expect(screen.getByText('take_profit')).toBeInTheDocument();
        expect(screen.getByText('1h 42m')).toBeInTheDocument();
        expect(screen.getByText('v3')).toBeInTheDocument();
    });

    it('renders leverage as {n}x, not as a money value', () => {
        setPage(null, [makeClosed({ leverage: '5' })]);
        renderTable();

        expect(screen.getByText('5x')).toBeInTheDocument();
        expect(screen.queryByText('$5')).not.toBeInTheDocument();
    });

    it('renders an em dash for a null exit price', () => {
        setPage(null, [makeClosed({ exitPrice: null })]);
        renderTable();

        expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });

    it('renders an em dash for a null realized PnL', () => {
        setPage(null, [makeClosed({ exitPrice: '63900.5', realizedPnlUsd: null })]);
        renderTable();

        expect(screen.getByText('—')).toBeInTheDocument();
    });
});

describe('ClosedPositionsTable — PnL sign tint', () => {
    it('tints a positive realized PnL green', () => {
        setPage(null, [makeClosed({ realizedPnlUsd: '12.18' })]);
        renderTable();

        expect(screen.getByText('12.18').className).toContain('text-emerald-600');
    });

    it('tints a negative realized PnL red', () => {
        setPage(null, [makeClosed({ realizedPnlUsd: '-8.40' })]);
        renderTable();

        expect(screen.getByText('-8.40').className).toContain('text-destructive');
    });

    it('does not apply a red tint for a zero realized PnL', () => {
        setPage(null, [makeClosed({ realizedPnlUsd: '0.00' })]);
        renderTable();

        const cell = screen.getByText('0.00');

        expect(cell.className).not.toContain('text-destructive');
    });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('ClosedPositionsTable — empty state', () => {
    it('renders "No closed positions." when there are no rows', () => {
        setPage(null, []);
        renderTable();

        expect(screen.getByText('No closed positions.')).toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
// Row click → navigation
// ---------------------------------------------------------------------------

describe('ClosedPositionsTable — row click', () => {
    it('navigates to the detail route with the row id', async () => {
        const user = userEvent.setup();
        setPage(null, [makeClosed({ id: 'pos-xyz' })]);
        renderTable();

        await user.click(screen.getByText('BTC/USDT:USDT'));

        expect(mockNavigate).toHaveBeenCalledWith('/positions/pos-xyz');
    });
});

// ---------------------------------------------------------------------------
// Cursor-stack paging
// ---------------------------------------------------------------------------

describe('ClosedPositionsTable — paging', () => {
    it('disables Previous on page 1', () => {
        setPage(null, [makeClosed()], 'cursor-2');
        renderTable();

        expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    });

    it('disables Next when there is no next cursor', () => {
        setPage(null, [makeClosed()], null);
        renderTable();

        expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    });

    it('advances to the next page and retreats with Previous', async () => {
        const user = userEvent.setup();
        setPage(null, [makeClosed({ symbol: 'PAGE1/USDT:USDT' })], 'cursor-2');
        setPage('cursor-2', [makeClosed({ symbol: 'PAGE2/USDT:USDT' })], null);
        renderTable();

        expect(screen.getByText('PAGE1/USDT:USDT')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /next/i }));
        expect(screen.getByText('PAGE2/USDT:USDT')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /previous/i })).not.toBeDisabled();

        await user.click(screen.getByRole('button', { name: /previous/i }));
        expect(screen.getByText('PAGE1/USDT:USDT')).toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
// formatDurationMs — pure helper boundaries
// ---------------------------------------------------------------------------

describe('formatDurationMs', () => {
    const opened = '2026-05-28T10:00:00.000Z';

    it('returns an em dash when closedAt is null', () => {
        expect(formatDurationMs(opened, null)).toBe('—');
    });

    it('returns 0s when the delta is zero', () => {
        expect(formatDurationMs(opened, opened)).toBe('0s');
    });

    it('returns 0s when the delta is negative (clock skew guard)', () => {
        expect(formatDurationMs(opened, '2026-05-28T09:59:59.000Z')).toBe('0s');
    });

    it('formats sub-minute spans as Xs', () => {
        expect(formatDurationMs(opened, '2026-05-28T10:00:45.000Z')).toBe('45s');
    });

    it('formats sub-hour spans as Xm Ys', () => {
        expect(formatDurationMs(opened, '2026-05-28T10:23:12.000Z')).toBe('23m 12s');
    });

    it('formats sub-day spans as Xh Ym', () => {
        expect(formatDurationMs(opened, '2026-05-28T11:42:00.000Z')).toBe('1h 42m');
    });

    it('formats multi-day spans as Xd Yh', () => {
        expect(formatDurationMs(opened, '2026-05-30T13:00:00.000Z')).toBe('2d 3h');
    });
});
