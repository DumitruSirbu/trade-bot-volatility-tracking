import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

// Self-contained multi-select combobox. The Radix popover and cmdk packages
// are not installed in this workspace, so this composes the existing button,
// input and checkbox primitives into the standard "trigger + searchable
// checklist" pattern, including click-outside dismissal.

export interface IMultiSelectOption {
    value: string;
    label: string;
}

interface IMultiSelectProps {
    label: string;
    options: IMultiSelectOption[];
    selected: string[];
    onChange: (next: string[]) => void;
    searchable?: boolean;
    emptyText?: string;
}

const summarize = (label: string, selectedCount: number): string => {
    if (selectedCount === 0) {
        return `${label}: All`;
    }

    return `${label}: ${selectedCount} selected`;
};

export const MultiSelect = ({ label, options, selected, onChange, searchable = false, emptyText = 'No options' }: IMultiSelectProps): React.ReactElement => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        const handlePointerDown = (event: MouseEvent): void => {
            if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDown);

        return () => document.removeEventListener('mousedown', handlePointerDown);
    }, [isOpen]);

    const selectedSet = React.useMemo(() => new Set(selected), [selected]);

    const visibleOptions = React.useMemo(() => {
        const needle = search.trim().toLowerCase();

        if (needle.length === 0) {
            return options;
        }

        return options.filter((option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle));
    }, [options, search]);

    const toggle = (value: string): void => {
        if (selectedSet.has(value)) {
            onChange(selected.filter((entry) => entry !== value));

            return;
        }

        onChange([...selected, value]);
    };

    return (
        <div ref={containerRef} className="relative">
            <Button size="sm" variant="outline" type="button" onClick={() => setIsOpen((open) => !open)} className="justify-between gap-2">
                {summarize(label, selected.length)}
                <ChevronDown className="opacity-60" />
            </Button>
            {isOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                    {searchable && (
                        <div className="p-1">
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={`Search ${label.toLowerCase()}…`}
                                className="h-8 text-xs"
                                autoFocus
                            />
                        </div>
                    )}
                    <div className="max-h-60 overflow-y-auto">
                        {visibleOptions.length === 0 ? (
                            <div className="px-2 py-2 text-xs text-muted-foreground">{emptyText}</div>
                        ) : (
                            visibleOptions.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => toggle(option.value)}
                                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                >
                                    <Checkbox checked={selectedSet.has(option.value)} tabIndex={-1} className="pointer-events-none" />
                                    <span className="truncate">{option.label}</span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
