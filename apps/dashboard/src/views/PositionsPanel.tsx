import * as React from 'react';

import { cn } from '@/lib/utils';
import { ClosedPositionsTable } from '@/views/ClosedPositionsTable';
import { PositionsTable } from '@/views/PositionsTable';

type PositionsView = 'open' | 'closed';

interface ISegment {
    id: PositionsView;
    label: string;
}

const SEGMENTS: readonly ISegment[] = [
    { id: 'open', label: 'Open' },
    { id: 'closed', label: 'Closed' },
];

const SegmentedControl = ({ active, onSelect }: { active: PositionsView; onSelect: (view: PositionsView) => void }): React.ReactElement => (
    <div className="inline-flex rounded-md border p-0.5">
        {SEGMENTS.map((segment) => (
            <button
                key={segment.id}
                type="button"
                onClick={() => onSelect(segment.id)}
                className={cn(
                    'rounded px-3 py-1 text-sm font-medium transition-colors',
                    segment.id === active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
            >
                {segment.label}
            </button>
        ))}
    </div>
);

export const PositionsPanel = (): React.ReactElement => {
    const [view, setView] = React.useState<PositionsView>('open');

    return (
        <div className="flex flex-col gap-3">
            <SegmentedControl active={view} onSelect={setView} />
            {view === 'open' ? <PositionsTable /> : <ClosedPositionsTable />}
        </div>
    );
};
