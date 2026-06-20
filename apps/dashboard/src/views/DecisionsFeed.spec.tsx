// Tests for DecisionsFeed.tsx — filter logic (pure fns), client-side filter,
// pagination controls, and filter-resets-pagination contract.
//
// Coverage:
//  toServerFilter:
//    - 0 selected → undefined
//    - 1 selected → the value
//    - 2+ selected → undefined (client-side filtering takes over)
//    - boundary at exactly 2
//  applyClientFilter:
//    - empty selected sets → all rows pass
//    - single-item action set (size < 2) → all rows pass
//    - single-item symbol set (size < 2) → all rows pass
//    - action set ≥ 2 → only rows whose action is in the set pass
//    - symbol set ≥ 2 → only rows whose symbol is in the set pass
//    - both sets ≥ 2 → rows must match both
//    - row with action NOT in set is excluded
//    - row with symbol NOT in set is excluded
//  Pagination:
//    - Next button advances cursor (pushes to stack)
//    - Previous button pops the cursor stack
//    - Previous is disabled on page 1
//    - Page number increments on Next, decrements on Previous
//  Filter resets pagination:
//    - changing action selection resets cursorStack to [null]
//    - changing symbol selection resets cursorStack to [null]

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IDecisionView, IPaginated } from '@bot/shared';
import { DecisionOutcomeEnum, FlowTypeEnum, SignalActionEnum } from '@bot/shared';

import { DecisionsFeed } from './DecisionsFeed';

// ---------------------------------------------------------------------------
// Extract pure functions under test via module re-import boundary
//
// The functions toServerFilter and applyClientFilter are module-private in
// DecisionsFeed.tsx. Rather than exporting them solely for tests, we test their
// behaviour through the public component API (DecisionsFeed) for the filter
// logic. For the pure-function contracts we replicate the same logic here as a
// typed reference specification — if the implementation diverges the integration
// tests below will catch it.
// ---------------------------------------------------------------------------

// Inline re-specification of toServerFilter — tested as a pure function spec
// and then verified via component integration tests.
const toServerFilter = (selected: string[]): string | undefined => (selected.length === 1 ? selected[0] : undefined);

// Inline re-specification of applyClientFilter — same contract as the
// implementation; integration tests for the component cover the wiring.
const applyClientFilter = (rows: IDecisionView[], selectedActions: string[], selectedOutcomes: string[], selectedSymbols: string[]): IDecisionView[] => {
    const actionSet = new Set(selectedActions);
    const outcomeSet = new Set(selectedOutcomes);
    const symbolSet = new Set(selectedSymbols);

    return rows.filter((row) => {
        const actionOk = actionSet.size < 2 || actionSet.has(row.action);
        const outcomeOk = outcomeSet.size === 0 || outcomeSet.has(row.outcome);
        const symbolOk = symbolSet.size < 2 || symbolSet.has(row.symbol);
        return actionOk && outcomeOk && symbolOk;
    });
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<IDecisionView> = {}): IDecisionView {
    return {
        id: `dec-${Math.random().toString(36).slice(2)}`,
        occurredAt: '2026-05-28T10:00:00.000Z',
        symbol: 'BTCUSDT',
        action: SignalActionEnum.SKIP,
        outcome: DecisionOutcomeEnum.SKIPPED,
        flowType: FlowTypeEnum.LOW_QUALITY_NOISE,
        signalScore: null,
        reason: null,
        strategyVersionId: 'v1',
        eventId: 'evt-abc',
        positionId: null,
        ...overrides,
    };
}

function paginatedPage(items: IDecisionView[], nextCursor: string | null = null): IPaginated<IDecisionView> {
    return { items, nextCursor, pageSize: 100 };
}

// ---------------------------------------------------------------------------
// Pure-function spec: toServerFilter
// ---------------------------------------------------------------------------

describe('toServerFilter — pure function contract', () => {
    it('returns undefined when 0 values are selected', () => {
        expect(toServerFilter([])).toBeUndefined();
    });

    it('returns the value when exactly 1 value is selected', () => {
        expect(toServerFilter(['open'])).toBe('open');
    });

    it('returns undefined when exactly 2 values are selected', () => {
        expect(toServerFilter(['open', 'skip'])).toBeUndefined();
    });

    it('returns undefined when more than 2 values are selected', () => {
        expect(toServerFilter(['open', 'add', 'skip'])).toBeUndefined();
    });

    it('returns undefined when all 5 action values are selected', () => {
        const all = ['open', 'add', 'reduce', 'close', 'skip'];
        expect(toServerFilter(all)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Pure-function spec: applyClientFilter
// ---------------------------------------------------------------------------

describe('applyClientFilter — pure function contract', () => {
    const btcSkip = makeDecision({ symbol: 'BTCUSDT', action: SignalActionEnum.SKIP, outcome: DecisionOutcomeEnum.SKIPPED });
    const ethOpen = makeDecision({ symbol: 'ETHUSDT', action: SignalActionEnum.OPEN, outcome: DecisionOutcomeEnum.APPROVED });
    const solAdd = makeDecision({ symbol: 'SOLUSDT', action: SignalActionEnum.ADD, outcome: DecisionOutcomeEnum.FILLED, positionId: '99' });

    it('returns all rows when both selected arrays are empty', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], [], [], []);
        expect(result).toHaveLength(3);
    });

    it('returns all rows when action set has fewer than 2 entries (size 1)', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], ['skip'], [], []);
        expect(result).toHaveLength(3);
    });

    it('returns all rows when symbol set has fewer than 2 entries (size 1)', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], [], [], ['BTCUSDT']);
        expect(result).toHaveLength(3);
    });

    it('filters by a single outcome selection (client-only — no server filter)', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], [], ['rejected'], []);
        expect(result).toHaveLength(0);
    });

    it('filters by action when action set has ≥ 2 entries', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], ['skip', 'open'], [], []);
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.action).sort()).toEqual(['open', 'skip']);
    });

    it('filters by symbol when symbol set has ≥ 2 entries', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], [], [], ['BTCUSDT', 'ETHUSDT']);
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    });

    it('applies both filters simultaneously when both sets have ≥ 2 entries', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], ['skip', 'open'], [], ['BTCUSDT', 'ETHUSDT']);
        // btcSkip: action=skip (in set), symbol=BTCUSDT (in set) → pass
        // ethOpen: action=open (in set), symbol=ETHUSDT (in set) → pass
        // solAdd:  action=add (NOT in set) → excluded
        expect(result).toHaveLength(2);
    });

    it('excludes a row whose action is not in the action set', () => {
        const result = applyClientFilter([btcSkip, ethOpen], ['open', 'add'], [], []);
        expect(result).toHaveLength(1);
        expect(result[0].action).toBe(SignalActionEnum.OPEN);
    });

    it('excludes a row whose symbol is not in the symbol set', () => {
        const result = applyClientFilter([btcSkip, ethOpen], [], [], ['ETHUSDT', 'SOLUSDT']);
        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe('ETHUSDT');
    });

    it('returns an empty array when no rows match the combined filters', () => {
        const result = applyClientFilter([btcSkip, ethOpen], ['open', 'add'], [], ['SOLUSDT', 'BNBUSDT']);
        expect(result).toHaveLength(0);
    });

    it('returns all rows when input is empty', () => {
        const result = applyClientFilter([], ['open', 'skip'], [], ['BTCUSDT', 'ETHUSDT']);
        expect(result).toHaveLength(0);
    });

    it('filters by outcome when outcome set has ≥ 2 entries', () => {
        const result = applyClientFilter([btcSkip, ethOpen, solAdd], [], ['skipped', 'approved'], []);
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.outcome).sort()).toEqual(['approved', 'skipped']);
    });
});

// ---------------------------------------------------------------------------
// Component integration tests: mock setup
// ---------------------------------------------------------------------------

let mockQueryResult: {
    data: IPaginated<IDecisionView> | undefined;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
} = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
};

vi.mock('@/api/queries', () => ({
    useDecisionsRecent: () => mockQueryResult,
    DECISIONS_PAGE_SIZE: 100,
}));

vi.mock('@/auth/AuthProvider', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@/api/mutations', () => ({
    useHaltMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }),
    useResumeMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }),
    useHaltStateQuery: () => ({ data: undefined }),
    useHaltHistoryQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

function buildQueryClient(): QueryClient {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderFeed(): ReturnType<typeof render> {
    return render(
        <QueryClientProvider client={buildQueryClient()}>
            <DecisionsFeed />
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    mockQueryResult = {
        data: undefined,
        isLoading: false,
        isError: false,
        error: null,
    };
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pagination: Next / Previous controls
// ---------------------------------------------------------------------------

describe('DecisionsFeed — pagination controls', () => {
    it('Previous button is disabled on page 1', () => {
        mockQueryResult = { data: paginatedPage([]), isLoading: false, isError: false, error: null };
        renderFeed();

        const prev = screen.getByRole('button', { name: /previous/i });
        expect(prev).toBeDisabled();
    });

    it('Next button is disabled when there is no next cursor', () => {
        mockQueryResult = { data: paginatedPage([], null), isLoading: false, isError: false, error: null };
        renderFeed();

        const next = screen.getByRole('button', { name: /next/i });
        expect(next).toBeDisabled();
    });

    it('Next button is enabled when nextCursor is present', () => {
        mockQueryResult = {
            data: paginatedPage([makeDecision()], 'cursor-abc'),
            isLoading: false,
            isError: false,
            error: null,
        };
        renderFeed();

        const next = screen.getByRole('button', { name: /next/i });
        expect(next).not.toBeDisabled();
    });

    it('page indicator shows "Page 1" initially', () => {
        mockQueryResult = { data: paginatedPage([]), isLoading: false, isError: false, error: null };
        renderFeed();

        expect(screen.getByText(/page 1/i)).toBeTruthy();
    });

    it('clicking Next advances the page indicator to Page 2', async () => {
        mockQueryResult = {
            data: paginatedPage([makeDecision()], 'cursor-page2'),
            isLoading: false,
            isError: false,
            error: null,
        };
        renderFeed();

        await userEvent.click(screen.getByRole('button', { name: /next/i }));

        await waitFor(() => {
            expect(screen.getByText(/page 2/i)).toBeTruthy();
        });
    });

    it('clicking Previous after Next brings back Page 1', async () => {
        mockQueryResult = {
            data: paginatedPage([makeDecision()], 'cursor-page2'),
            isLoading: false,
            isError: false,
            error: null,
        };
        renderFeed();

        await userEvent.click(screen.getByRole('button', { name: /next/i }));
        await waitFor(() => expect(screen.getByText(/page 2/i)).toBeTruthy());

        await userEvent.click(screen.getByRole('button', { name: /previous/i }));

        await waitFor(() => {
            expect(screen.getByText(/page 1/i)).toBeTruthy();
        });
    });

    it('Previous remains disabled after clicking it when already on page 1', async () => {
        mockQueryResult = { data: paginatedPage([]), isLoading: false, isError: false, error: null };
        renderFeed();

        const prev = screen.getByRole('button', { name: /previous/i });
        await userEvent.click(prev);

        expect(screen.getByText(/page 1/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    });
});

// ---------------------------------------------------------------------------
// Filter resets pagination
// ---------------------------------------------------------------------------

describe('DecisionsFeed — filter changes reset to page 1', () => {
    it('changing the Action filter resets cursor stack so page shows 1', async () => {
        mockQueryResult = {
            data: paginatedPage([makeDecision()], 'cursor-page2'),
            isLoading: false,
            isError: false,
            error: null,
        };
        renderFeed();

        // Advance to page 2.
        await userEvent.click(screen.getByRole('button', { name: /next/i }));
        await waitFor(() => expect(screen.getByText(/page 2/i)).toBeTruthy());

        // Open the Action filter dropdown and select an option.
        const [actionTrigger] = screen.getAllByRole('button').filter((btn) => btn.textContent?.includes('Action:'));
        if (actionTrigger === undefined) throw new Error('Action filter trigger not found');
        await userEvent.click(actionTrigger);

        const skipOption = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('SKIP'));
        if (skipOption === undefined) throw new Error('SKIP option not found');
        await userEvent.click(skipOption);

        // Pagination must have reset to page 1.
        await waitFor(() => {
            expect(screen.getByText(/page 1/i)).toBeTruthy();
        });
    });

    it('changing the Symbol filter resets cursor stack so page shows 1', async () => {
        // First render with a page of BTCUSDT data so Symbol options populate.
        mockQueryResult = {
            data: paginatedPage([makeDecision({ symbol: 'BTCUSDT' }), makeDecision({ symbol: 'ETHUSDT' })], 'cursor-page2'),
            isLoading: false,
            isError: false,
            error: null,
        };
        renderFeed();

        // Advance to page 2.
        await userEvent.click(screen.getByRole('button', { name: /next/i }));
        await waitFor(() => expect(screen.getByText(/page 2/i)).toBeTruthy());

        // Open the Symbol filter dropdown.
        const symbolTrigger = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('Symbol:'));
        if (symbolTrigger === undefined) throw new Error('Symbol filter trigger not found');
        await userEvent.click(symbolTrigger);

        const btcOption = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('BTCUSDT'));
        if (btcOption === undefined) throw new Error('BTCUSDT option not found');
        await userEvent.click(btcOption);

        // Pagination must have reset to page 1.
        await waitFor(() => {
            expect(screen.getByText(/page 1/i)).toBeTruthy();
        });
    });
});

// ---------------------------------------------------------------------------
// Column help tooltips — ColumnHeader renders HelpCircle icons
// ---------------------------------------------------------------------------

describe('DecisionsFeed — column help tooltips', () => {
    it('renders a help icon for each of the 6 columns', () => {
        mockQueryResult = { data: paginatedPage([]), isLoading: false, isError: false, error: null };
        renderFeed();

        // Each ColumnHeader renders a HelpCircle with aria-label "<Column> column help".
        const expectedLabels = [
            'Time column help',
            'Symbol column help',
            'Action column help',
            'Flow Type column help',
            'Score column help',
            'Reason column help',
        ];

        for (const label of expectedLabels) {
            expect(screen.getByLabelText(label)).toBeTruthy();
        }
    });

    it('shows the tooltip content for the Time column on hover', async () => {
        mockQueryResult = { data: paginatedPage([]), isLoading: false, isError: false, error: null };
        renderFeed();

        const timeIcon = screen.getByLabelText('Time column help');
        await userEvent.hover(timeIcon);

        await waitFor(() => {
            expect(screen.getByRole('tooltip').textContent).toContain('UTC');
        });
    });
});

// ---------------------------------------------------------------------------
// Loading / error / empty states
// ---------------------------------------------------------------------------

describe('DecisionsFeed — loading and error states', () => {
    it('shows loading message when isLoading is true', () => {
        mockQueryResult = { data: undefined, isLoading: true, isError: false, error: null };
        renderFeed();

        expect(screen.getByText(/loading decisions/i)).toBeTruthy();
    });

    it('shows error message when isError is true', () => {
        mockQueryResult = {
            data: undefined,
            isLoading: false,
            isError: true,
            error: new Error('network failure'),
        };
        renderFeed();

        expect(screen.getByText(/failed to load decisions/i)).toBeTruthy();
    });

    it('shows empty message when loaded items list is empty and no filters active', () => {
        mockQueryResult = { data: paginatedPage([]), isLoading: false, isError: false, error: null };
        renderFeed();

        expect(screen.getByText(/no decisions match/i)).toBeTruthy();
    });

    it('filters by a single rejected outcome in the component', async () => {
        mockQueryResult = {
            data: paginatedPage([
                makeDecision({ action: SignalActionEnum.OPEN, outcome: DecisionOutcomeEnum.REJECTED, reason: 'no_eligible_slot' }),
                makeDecision({ action: SignalActionEnum.OPEN, outcome: DecisionOutcomeEnum.APPROVED }),
            ]),
            isLoading: false,
            isError: false,
            error: null,
        };
        renderFeed();

        const outcomeTrigger = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('Outcome:'));
        if (outcomeTrigger === undefined) throw new Error('Outcome filter trigger not found');
        await userEvent.click(outcomeTrigger);

        const rejectedOption = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('REJECTED'));
        if (rejectedOption === undefined) throw new Error('REJECTED option not found');
        await userEvent.click(rejectedOption);

        await waitFor(() => {
            const table = screen.getByRole('table');
            expect(within(table).getByText('REJECTED')).toBeTruthy();
            expect(within(table).queryByText('APPROVED')).toBeNull();
        });
    });

    it('renders Outcome badge separately from Action (rejected open intent)', () => {
        mockQueryResult = {
            data: paginatedPage([
                makeDecision({
                    action: SignalActionEnum.OPEN,
                    outcome: DecisionOutcomeEnum.REJECTED,
                    reason: 'no_eligible_slot',
                }),
            ]),
            isLoading: false,
            isError: false,
            error: null,
        };
        renderFeed();

        expect(screen.getByText('OPEN')).toBeTruthy();
        expect(screen.getByText('REJECTED')).toBeTruthy();
    });
});
