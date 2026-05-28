// Tests for Tooltip component (DecisionsFeed column-help feature).
//
// Coverage:
//  - renders children in all states
//  - tooltip content appears on mouse-enter; disappears on mouse-leave
//  - tooltip content appears on focus; disappears on blur
//  - tooltip content is accessible via role="tooltip"
//  - tooltip is absent from the DOM when not triggered (not just hidden)

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Tooltip } from './tooltip';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTooltip(content = 'Tip text', childLabel = 'Hover me'): ReturnType<typeof render> {
    return render(<Tooltip content={content}><span>{childLabel}</span></Tooltip>);
}

// ---------------------------------------------------------------------------
// Children rendering
// ---------------------------------------------------------------------------

describe('Tooltip — children', () => {
    it('renders children regardless of hover state', () => {
        renderTooltip('Some tip', 'The child');

        expect(screen.getByText('The child')).toBeTruthy();
    });

    it('does not render tooltip content before interaction', () => {
        renderTooltip('Hidden tip');

        expect(screen.queryByRole('tooltip')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Mouse interactions
// ---------------------------------------------------------------------------

describe('Tooltip — mouse interactions', () => {
    it('shows tooltip content on mouse-enter', async () => {
        renderTooltip('Hover tip');

        await userEvent.hover(screen.getByText('Hover me'));

        expect(screen.getByRole('tooltip').textContent).toBe('Hover tip');
    });

    it('hides tooltip content on mouse-leave after hover', async () => {
        renderTooltip('Hover tip');

        await userEvent.hover(screen.getByText('Hover me'));
        await userEvent.unhover(screen.getByText('Hover me'));

        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('shows tooltip again after a second hover following leave', async () => {
        renderTooltip('Re-hover tip');

        await userEvent.hover(screen.getByText('Hover me'));
        await userEvent.unhover(screen.getByText('Hover me'));
        await userEvent.hover(screen.getByText('Hover me'));

        expect(screen.getByRole('tooltip')).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Focus interactions (keyboard accessibility)
// ---------------------------------------------------------------------------

describe('Tooltip — focus interactions', () => {
    it('shows tooltip on keyboard focus', async () => {
        renderTooltip('Focus tip');

        // Tab into the focusable inner span — userEvent.tab triggers React onFocus.
        await userEvent.tab();

        expect(screen.getByRole('tooltip').textContent).toBe('Focus tip');
    });

    it('hides tooltip on blur after focus', async () => {
        renderTooltip('Focus tip');

        await userEvent.tab();
        // Tab away to trigger onBlur on the tooltip wrapper.
        await userEvent.tab();

        expect(screen.queryByRole('tooltip')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Content fidelity
// ---------------------------------------------------------------------------

describe('Tooltip — content', () => {
    it('renders the exact content string passed via prop when tooltip is visible', async () => {
        renderTooltip('When the volatility trigger fired for this symbol (UTC)');

        await userEvent.hover(screen.getByText('Hover me'));

        expect(screen.getByRole('tooltip').textContent).toBe(
            'When the volatility trigger fired for this symbol (UTC)',
        );
    });

    it('renders React node children (not just strings) as tooltip content', async () => {
        render(
            <Tooltip content={<strong>Bold tip</strong>}>
                <span>child</span>
            </Tooltip>,
        );

        await userEvent.hover(screen.getByText('child'));

        expect(screen.getByRole('tooltip').querySelector('strong')).toBeTruthy();
    });
});
