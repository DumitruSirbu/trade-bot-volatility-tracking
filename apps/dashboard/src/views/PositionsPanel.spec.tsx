// Tests for PositionsPanel.tsx — Open/Closed segmented toggle.
//
// Coverage:
//  - default view is Open: PositionsTable rendered, ClosedPositionsTable not.
//  - clicking "Closed" swaps to ClosedPositionsTable.
//  - clicking "Open" swaps back to PositionsTable.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PositionsPanel } from './PositionsPanel';

// Stub the two child tables so the panel toggle is tested in isolation — the
// children have their own specs and their own data dependencies.
vi.mock('./PositionsTable', () => ({
    PositionsTable: () => <div data-testid="open-table">OPEN TABLE</div>,
}));

vi.mock('./ClosedPositionsTable', () => ({
    ClosedPositionsTable: () => <div data-testid="closed-table">CLOSED TABLE</div>,
}));

describe('PositionsPanel', () => {
    it('defaults to the Open view', () => {
        render(<PositionsPanel />);

        expect(screen.getByTestId('open-table')).toBeInTheDocument();
        expect(screen.queryByTestId('closed-table')).not.toBeInTheDocument();
    });

    it('renders the Closed view after clicking Closed', async () => {
        const user = userEvent.setup();
        render(<PositionsPanel />);

        await user.click(screen.getByRole('button', { name: 'Closed' }));

        expect(screen.getByTestId('closed-table')).toBeInTheDocument();
        expect(screen.queryByTestId('open-table')).not.toBeInTheDocument();
    });

    it('returns to the Open view after clicking Open', async () => {
        const user = userEvent.setup();
        render(<PositionsPanel />);

        await user.click(screen.getByRole('button', { name: 'Closed' }));
        await user.click(screen.getByRole('button', { name: 'Open' }));

        expect(screen.getByTestId('open-table')).toBeInTheDocument();
        expect(screen.queryByTestId('closed-table')).not.toBeInTheDocument();
    });
});
