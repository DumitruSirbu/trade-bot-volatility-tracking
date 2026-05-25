import * as React from 'react';
import type { IDecisionView } from '@bot/shared';
import { SignalActionEnum } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { useDecisionsRecent } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const actionVariant = (action: SignalActionEnum): 'success' | 'warning' | 'secondary' | 'destructive' => {
    switch (action) {
        case SignalActionEnum.OPEN:
        case SignalActionEnum.ADD:
            return 'success';
        case SignalActionEnum.REDUCE:
            return 'warning';
        case SignalActionEnum.CLOSE:
            return 'destructive';
        case SignalActionEnum.SKIP:
        default:
            return 'secondary';
    }
};

const formatTimestamp = (iso: string): string => {
    const parsed = Date.parse(iso);

    if (!Number.isFinite(parsed)) {
        return iso;
    }

    return new Date(parsed).toISOString().replace('T', ' ').slice(0, 19);
};

const DecisionRow = ({ decision }: { decision: IDecisionView }): React.ReactElement => (
    <li className="flex items-start gap-3 border-b py-2 last:border-b-0">
        <span className="w-44 shrink-0 font-mono text-xs text-muted-foreground">{formatTimestamp(decision.occurredAt)}</span>
        <span className="w-24 shrink-0 font-medium">{decision.symbol}</span>
        <Badge variant={actionVariant(decision.action)}>{decision.action.toUpperCase()}</Badge>
        <span className="w-40 shrink-0 text-xs text-muted-foreground">{decision.flowType}</span>
        <span className="w-20 shrink-0 text-right font-mono text-xs">{decision.signalScore ?? '—'}</span>
        <span className="flex-1 truncate text-sm text-muted-foreground" title={decision.reason ?? undefined}>
            {decision.reason ?? '—'}
        </span>
    </li>
);

interface IPage {
    cursor: string | null;
}

export const DecisionsFeed = (): React.ReactElement => {
    const [pages, setPages] = React.useState<IPage[]>([{ cursor: null }]);

    const handleReset = React.useCallback(() => setPages([{ cursor: null }]), []);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={handleReset} disabled={pages.length === 1}>
                    Reset
                </Button>
            </div>
            <ul className="flex flex-col">
                {pages.map((page, idx) => (
                    <DecisionsPage
                        key={page.cursor ?? 'first'}
                        cursor={page.cursor}
                        isLast={idx === pages.length - 1}
                        onLoadMore={(next) => setPages((p) => [...p, { cursor: next }])}
                    />
                ))}
            </ul>
        </div>
    );
};

interface IPageProps {
    cursor: string | null;
    isLast: boolean;
    onLoadMore: (nextCursor: string) => void;
}

const LoadMoreCell = ({ nextCursor, onLoadMore }: { nextCursor: string; onLoadMore: (next: string) => void }): React.ReactElement => (
    <li className="flex justify-center py-3">
        <Button size="sm" variant="outline" onClick={() => onLoadMore(nextCursor)}>
            Load more
        </Button>
    </li>
);

const DecisionsPage = ({ cursor, isLast, onLoadMore }: IPageProps): React.ReactElement => {
    const { data, isLoading, isError, error } = useDecisionsRecent(cursor);

    if (isLoading) {
        return <li className="py-4 text-center text-sm text-muted-foreground">Loading decisions…</li>;
    }

    if (isError) {
        return <li className="py-4 text-center text-sm text-destructive">{error instanceof ApiError ? error.message : 'Failed to load decisions.'}</li>;
    }

    if (data === undefined || data.items.length === 0) {
        return <li className="py-4 text-center text-sm text-muted-foreground">No decisions recorded.</li>;
    }

    return (
        <>
            {data.items.map((decision) => (
                <DecisionRow key={decision.id} decision={decision} />
            ))}
            {isLast && data.nextCursor !== null && <LoadMoreCell nextCursor={data.nextCursor} onLoadMore={onLoadMore} />}
        </>
    );
};
