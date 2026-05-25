// M10 QA — adversarial tests for HaltBanner.tsx (W4, ADR 0021 §2.6).
//
// Coverage: renders only when halted; shows reason, actor (source), haltedAt;
// hidden when running; flattenInProgress pill appears conditionally;
// falls back to risk state when halt-state query has no data.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HaltSourceEnum, type IKillSwitchState, type IRiskStateView } from '@bot/shared';

import { HaltBanner } from './HaltBanner';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockHaltStateData: IKillSwitchState | undefined;
let mockRiskStateData: IRiskStateView | undefined;

vi.mock('@/api/mutations', () => ({
    useHaltStateQuery: () => ({ data: mockHaltStateData }),
    useHaltMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }),
    useResumeMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }),
}));

vi.mock('@/api/queries', () => ({
    useRiskState: () => ({ data: mockRiskStateData }),
}));

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function haltedState(overrides?: Partial<IKillSwitchState>): IKillSwitchState {
    return {
        haltState: 'halted',
        haltSource: HaltSourceEnum.OPERATOR,
        haltReason: 'Spread widening on BTCUSDT',
        haltedAt: '2026-05-25T12:00:00.000Z',
        lastTransitionAuditId: 'audit-abc-123',
        flattenInProgress: false,
        ...overrides,
    };
}

function runningState(): IKillSwitchState {
    return {
        haltState: 'running',
        haltSource: HaltSourceEnum.OPERATOR,
        haltReason: null,
        haltedAt: null,
        lastTransitionAuditId: '',
        flattenInProgress: false,
    };
}

function riskHalted(reason: string): IRiskStateView {
    return {
        isHalted: true,
        haltReason: reason,
    } as IRiskStateView;
}

function riskRunning(): IRiskStateView {
    return {
        isHalted: false,
        haltReason: null,
    } as IRiskStateView;
}

function resetMocks(): void {
    mockHaltStateData = undefined;
    mockRiskStateData = undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HaltBanner — visibility', () => {
    it('renders the banner when haltState is "halted"', () => {
        mockHaltStateData = haltedState();
        mockRiskStateData = undefined;

        render(<HaltBanner />);

        expect(screen.getByRole('alert')).toBeTruthy();
    });

    it('does NOT render when haltState is "running"', () => {
        mockHaltStateData = runningState();
        mockRiskStateData = undefined;

        render(<HaltBanner />);

        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('does NOT render when both state queries return undefined', () => {
        resetMocks();

        render(<HaltBanner />);

        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('renders when risk state says isHalted=true and halt-state query is absent', () => {
        mockHaltStateData = undefined;
        mockRiskStateData = riskHalted('model divergence');

        render(<HaltBanner />);

        expect(screen.getByRole('alert')).toBeTruthy();
    });

    it('does NOT render when risk state says isHalted=false and halt-state query is absent', () => {
        mockHaltStateData = undefined;
        mockRiskStateData = riskRunning();

        render(<HaltBanner />);

        expect(screen.queryByRole('alert')).toBeNull();
    });
});

describe('HaltBanner — content', () => {
    it('shows the halt reason in the banner', () => {
        mockHaltStateData = haltedState({ haltReason: 'Unusual OI spike' });

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('Unusual OI spike');
    });

    it('shows "Operator" when source is OPERATOR', () => {
        mockHaltStateData = haltedState({ haltSource: HaltSourceEnum.OPERATOR });

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('Operator');
    });

    it('shows the market-stress source label', () => {
        mockHaltStateData = haltedState({ haltSource: HaltSourceEnum.MARKET_STRESS });

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('market stress');
    });

    it('shows the audit id in the banner', () => {
        mockHaltStateData = haltedState({ lastTransitionAuditId: 'audit-xyz-789' });

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('audit-xyz-789');
    });

    it('shows haltedAt timestamp in a human-readable form', () => {
        mockHaltStateData = haltedState({ haltedAt: '2026-05-25T12:00:00.000Z' });

        render(<HaltBanner />);

        // The formatted timestamp should include date components from the ISO.
        expect(screen.getByRole('alert').textContent).toMatch(/2026-05-25/);
    });

    it('shows "Flatten in progress" pill when flattenInProgress is true', () => {
        mockHaltStateData = haltedState({ flattenInProgress: true });

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('Flatten in progress');
    });

    it('does NOT show "Flatten in progress" pill when flattenInProgress is false', () => {
        mockHaltStateData = haltedState({ flattenInProgress: false });

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).not.toContain('Flatten in progress');
    });

    it('falls back to risk haltReason when halt-state data is absent', () => {
        mockHaltStateData = undefined;
        mockRiskStateData = riskHalted('daily loss cap triggered');

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('daily loss cap triggered');
    });

    it('shows "(reason unavailable)" when neither state provides a reason', () => {
        mockHaltStateData = haltedState({ haltReason: null });
        mockRiskStateData = riskRunning();

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('(reason unavailable)');
    });
});

describe('HaltBanner — null / edge-case haltedAt', () => {
    it('renders "—" when haltedAt is null', () => {
        mockHaltStateData = haltedState({ haltedAt: null });

        render(<HaltBanner />);

        expect(screen.getByRole('alert').textContent).toContain('—');
    });
});

// Round-1 logic fix (Item 3): when state.haltReason is null but defined and
// risk.haltReason carries the real reason, banner must surface the risk
// reason (not fall through to the placeholder).
describe('HaltBanner — haltReason fallback chain', () => {
    it('falls back to risk.haltReason when state.haltReason is null but state is otherwise present', () => {
        mockHaltStateData = haltedState({ haltReason: null });
        mockRiskStateData = riskHalted('market stress cap engaged');

        render(<HaltBanner />);

        const text = screen.getByRole('alert').textContent ?? '';
        expect(text).toContain('market stress cap engaged');
        expect(text).not.toContain('(reason unavailable)');
    });
});
