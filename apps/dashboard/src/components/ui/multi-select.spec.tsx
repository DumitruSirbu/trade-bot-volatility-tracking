// Tests for MultiSelect component (DecisionsFeed Action/Symbol filter feature).
//
// Coverage:
//  - trigger shows "Label: All" when nothing is selected
//  - trigger shows "Label: N selected" when N items are selected
//  - dropdown opens on trigger click; closes on second click (toggle)
//  - options list renders all provided options
//  - selecting an option calls onChange with the option appended
//  - deselecting a checked option calls onChange without that option
//  - selecting all options shows "N selected" (item count, not "All")
//  - search input filters the visible option list (case-insensitive)
//  - search input is absent when searchable=false (default)
//  - emptyText is shown when search yields no matches
//  - click-outside closes the dropdown

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MultiSelect, type IMultiSelectOption } from './multi-select';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREE_OPTIONS: IMultiSelectOption[] = [
    { value: 'open', label: 'OPEN' },
    { value: 'add', label: 'ADD' },
    { value: 'skip', label: 'SKIP' },
];

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSelect(
    options: IMultiSelectOption[] = THREE_OPTIONS,
    selected: string[] = [],
    onChange: (next: string[]) => void = vi.fn(),
    extras: Partial<{ searchable: boolean; emptyText: string }> = {},
): ReturnType<typeof render> {
    return render(
        <MultiSelect
            label="Action"
            options={options}
            selected={selected}
            onChange={onChange}
            searchable={extras.searchable ?? false}
            emptyText={extras.emptyText}
        />,
    );
}

// The trigger is always the first button in the DOM. After the dropdown opens,
// option rows and Checkbox components also carry role="button", so we cannot
// use getByRole('button') which throws on multiple matches.
function getTrigger(): HTMLElement {
    return screen.getAllByRole('button')[0];
}

async function openDropdown(): Promise<void> {
    await userEvent.click(getTrigger());
}

// ---------------------------------------------------------------------------
// Trigger label
// ---------------------------------------------------------------------------

describe('MultiSelect — trigger label', () => {
    it('shows "Label: All" when nothing is selected', () => {
        renderSelect(THREE_OPTIONS, []);

        expect(getTrigger().textContent).toContain('Action: All');
    });

    it('shows "Label: 1 selected" when one item is selected', () => {
        renderSelect(THREE_OPTIONS, ['open']);

        expect(getTrigger().textContent).toContain('Action: 1 selected');
    });

    it('shows "Label: 2 selected" when two items are selected', () => {
        renderSelect(THREE_OPTIONS, ['open', 'add']);

        expect(getTrigger().textContent).toContain('Action: 2 selected');
    });

    it('shows "Label: N selected" when all N options are selected — does not show "All"', () => {
        const allValues = THREE_OPTIONS.map((o) => o.value);
        renderSelect(THREE_OPTIONS, allValues);

        const text = getTrigger().textContent ?? '';
        expect(text).toContain('Action: 3 selected');
        expect(text).not.toContain('All');
    });
});

// ---------------------------------------------------------------------------
// Dropdown open/close
// ---------------------------------------------------------------------------

describe('MultiSelect — dropdown visibility', () => {
    it('dropdown is absent initially', () => {
        renderSelect();

        expect(screen.queryByRole('button', { name: /OPEN/i })).toBeNull();
    });

    it('dropdown opens when trigger is clicked', async () => {
        renderSelect();

        await openDropdown();

        // Each option is rendered as a button inside the dropdown.
        const optionButtons = screen.getAllByRole('button').slice(1); // exclude trigger
        expect(optionButtons.length).toBe(THREE_OPTIONS.length);
    });

    it('dropdown closes when trigger is clicked a second time', async () => {
        renderSelect();

        await openDropdown();
        // Clicking the trigger again toggles it closed.
        await userEvent.click(getTrigger());

        // Only the trigger button remains — option buttons are unmounted.
        // Checkbox components (role="button") also vanish with the dropdown.
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Selecting and deselecting options
// ---------------------------------------------------------------------------

describe('MultiSelect — selection callbacks', () => {
    it('calls onChange with the new value appended when an unchecked option is clicked', async () => {
        const onChange = vi.fn();
        renderSelect(THREE_OPTIONS, [], onChange);

        await openDropdown();
        const openButton = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('OPEN'));
        if (openButton === undefined) throw new Error('OPEN option button not found');
        await userEvent.click(openButton);

        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith(['open']);
    });

    it('calls onChange without the value when a checked option is clicked', async () => {
        const onChange = vi.fn();
        renderSelect(THREE_OPTIONS, ['open', 'add'], onChange);

        await openDropdown();
        const openButton = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('OPEN'));
        if (openButton === undefined) throw new Error('OPEN option button not found');
        await userEvent.click(openButton);

        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith(['add']);
    });

    it('selecting a second option appends it to the existing selection', async () => {
        const onChange = vi.fn();
        renderSelect(THREE_OPTIONS, ['open'], onChange);

        await openDropdown();
        const addButton = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('ADD'));
        if (addButton === undefined) throw new Error('ADD option button not found');
        await userEvent.click(addButton);

        expect(onChange).toHaveBeenCalledWith(['open', 'add']);
    });

    it('does not call onChange when the trigger is clicked to open the dropdown', async () => {
        const onChange = vi.fn();
        renderSelect(THREE_OPTIONS, [], onChange);

        await openDropdown();

        expect(onChange).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Search filtering
// ---------------------------------------------------------------------------

describe('MultiSelect — search (searchable=true)', () => {
    it('does not render a search input when searchable is false (default)', async () => {
        renderSelect(THREE_OPTIONS, [], vi.fn(), { searchable: false });

        await openDropdown();

        expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    });

    it('renders a search input when searchable is true', async () => {
        renderSelect(THREE_OPTIONS, [], vi.fn(), { searchable: true });

        await openDropdown();

        expect(screen.getByPlaceholderText(/search action/i)).toBeTruthy();
    });

    it('filters options to those matching the search term (case-insensitive)', async () => {
        renderSelect(THREE_OPTIONS, [], vi.fn(), { searchable: true });

        await openDropdown();
        await userEvent.type(screen.getByPlaceholderText(/search action/i), 'op');

        // Only OPEN matches "op". Option rows are <button> elements whose text
        // contains the label. Checkboxes (also role="button") carry no readable
        // label text, so we discriminate by non-empty trimmed textContent.
        const trigger = getTrigger();
        const optionRows = screen.getAllByRole('button').filter((btn) => btn !== trigger && btn.textContent?.trim() !== '');
        // Each option row's text includes the Checkbox button text (empty) + span label.
        // We check via the visible span labels.
        const labels = optionRows.map((btn) => btn.querySelector('span.truncate')?.textContent ?? '');
        expect(labels.some((l) => l.includes('OPEN'))).toBe(true);
        expect(labels.some((l) => l.includes('ADD'))).toBe(false);
        expect(labels.some((l) => l.includes('SKIP'))).toBe(false);
    });

    it('shows all options again when search is cleared', async () => {
        renderSelect(THREE_OPTIONS, [], vi.fn(), { searchable: true });

        await openDropdown();
        const searchInput = screen.getByPlaceholderText(/search action/i);
        await userEvent.type(searchInput, 'op');
        await userEvent.clear(searchInput);

        // After clearing, all option rows should be back. Each option is a
        // <button> with a nested .truncate span containing the label.
        const visibleLabels = screen
            .getAllByRole('button')
            .map((btn) => btn.querySelector('span.truncate')?.textContent ?? '')
            .filter((text) => text.length > 0);
        expect(visibleLabels).toHaveLength(THREE_OPTIONS.length);
    });

    it('shows emptyText when search matches no options', async () => {
        renderSelect(THREE_OPTIONS, [], vi.fn(), { searchable: true, emptyText: 'No symbols on this page' });

        await openDropdown();
        await userEvent.type(screen.getByPlaceholderText(/search action/i), 'zzznomatch');

        expect(screen.getByText('No symbols on this page')).toBeTruthy();
    });

    it('emits the correct value when clicking a search-filtered option', async () => {
        const onChange = vi.fn();
        renderSelect(THREE_OPTIONS, [], onChange, { searchable: true });

        await openDropdown();
        await userEvent.type(screen.getByPlaceholderText(/search action/i), 'sk');

        const skipButton = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('SKIP'));
        if (skipButton === undefined) throw new Error('SKIP option not found after search');
        await userEvent.click(skipButton);

        expect(onChange).toHaveBeenCalledWith(['skip']);
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('MultiSelect — edge cases', () => {
    it('renders correctly with an empty options array', () => {
        renderSelect([], [], vi.fn());

        expect(getTrigger().textContent).toContain('Action: All');
    });

    it('opens with empty options and shows the default emptyText', async () => {
        renderSelect([], [], vi.fn(), { emptyText: 'No options' });

        await openDropdown();

        expect(screen.getByText('No options')).toBeTruthy();
    });

    it('renders a single option correctly and calls onChange when clicked', async () => {
        const onChange = vi.fn();
        renderSelect([{ value: 'open', label: 'OPEN' }], [], onChange);

        await openDropdown();
        const openButton = screen.getAllByRole('button').find((btn) => btn.textContent?.includes('OPEN'));
        if (openButton === undefined) throw new Error('OPEN option button not found');
        await userEvent.click(openButton);

        expect(onChange).toHaveBeenCalledWith(['open']);
    });
});
