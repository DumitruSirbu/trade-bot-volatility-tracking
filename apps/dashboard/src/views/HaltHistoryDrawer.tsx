import * as React from 'react';
import type { IHaltAuditEntry } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { useHaltHistoryQuery } from '@/api/mutations';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

// M10 W4 (ADR 0021 §2.3). Slide-out drawer rendering operator halt audit
// rows from GET /v1/control/halt/history. Cursor-paginated like the
// decisions feed; rows are append-only audit data, never mutated.

interface IPage {
    cursor: string | null;
}

const formatTimestamp = (iso: string): string => {
    const ms = Date.parse(iso);

    return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : iso;
};

const ActionBadge = ({ action }: { action: string }): React.ReactElement => {
    const tone =
        action.toLowerCase().startsWith('halt') || action.includes('failure') || action.includes('throttled')
            ? 'bg-destructive/15 text-destructive'
            : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';

    return <span className={`inline-flex rounded-sm px-1.5 py-0.5 text-xs font-semibold uppercase ${tone}`}>{action}</span>;
};

const HistoryRow = ({ entry }: { entry: IHaltAuditEntry }): React.ReactElement => (
    <tr className="border-b last:border-b-0 align-top">
        <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{formatTimestamp(entry.occurredAt)}</td>
        <td className="py-2 pr-3">
            <ActionBadge action={entry.action} />
        </td>
        <td className="py-2 pr-3 text-xs">{entry.actorSub}</td>
        <td className="py-2 pr-3 text-xs text-muted-foreground">{entry.sourceIp ?? '—'}</td>
        <td className="py-2 text-xs" title={entry.reason}>
            {entry.reason || '—'}
        </td>
    </tr>
);

interface IHistoryPageProps {
    cursor: string | null;
    isLast: boolean;
    onLoadMore: (next: string) => void;
    onResetToFirstPage: () => void;
}

const LoadMoreRow = ({ nextCursor, onLoadMore }: { nextCursor: string; onLoadMore: (next: string) => void }): React.ReactElement => (
    <tr>
        <td colSpan={5} className="py-3 text-center">
            <Button size="sm" variant="outline" onClick={() => onLoadMore(nextCursor)}>
                Load more
            </Button>
        </td>
    </tr>
);

const HistoryPage = ({ cursor, isLast, onLoadMore, onResetToFirstPage }: IHistoryPageProps): React.ReactElement => {
    const { data, isLoading, isError, error } = useHaltHistoryQuery(cursor);

    if (isLoading) {
        return (
            <tr>
                <td colSpan={5} className="py-4 text-center text-sm text-muted-foreground">
                    Loading history…
                </td>
            </tr>
        );
    }

    if (isError) {
        const message = error instanceof ApiError ? error.message : 'Failed to load history.';
        const isDeeperPage = cursor !== null;

        return (
            <tr>
                <td colSpan={5} className="py-4 text-center text-sm text-destructive">
                    <div>{message}</div>
                    {isDeeperPage && (
                        <Button size="sm" variant="link" className="mt-1 text-destructive" onClick={onResetToFirstPage}>
                            Reset to first page
                        </Button>
                    )}
                </td>
            </tr>
        );
    }

    if (data === undefined || data.items.length === 0) {
        return (
            <tr>
                <td colSpan={5} className="py-4 text-center text-sm text-muted-foreground">
                    No audit entries.
                </td>
            </tr>
        );
    }

    return (
        <>
            {data.items.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
            ))}
            {isLast && data.nextCursor !== null && <LoadMoreRow nextCursor={data.nextCursor} onLoadMore={onLoadMore} />}
        </>
    );
};

export const HaltHistoryDrawer = (): React.ReactElement => {
    const [pages, setPages] = React.useState<IPage[]>([{ cursor: null }]);
    const [open, setOpen] = React.useState(false);

    const handleOpenChange = (next: boolean): void => {
        setOpen(next);
        if (!next) {
            setPages([{ cursor: null }]);
        }
    };

    const handleResetToFirstPage = React.useCallback((): void => setPages([{ cursor: null }]), []);

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetTrigger asChild>
                <Button size="sm" variant="outline">
                    Halt history
                </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:max-w-xl">
                <SheetHeader>
                    <SheetTitle>Halt &amp; auth audit history</SheetTitle>
                </SheetHeader>
                <div className="mt-4 flex-1 overflow-y-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="sticky top-0 bg-background">
                            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                                <th className="py-2 pr-3">Time</th>
                                <th className="py-2 pr-3">Action</th>
                                <th className="py-2 pr-3">Actor</th>
                                <th className="py-2 pr-3">Source IP</th>
                                <th className="py-2">Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pages.map((page, idx) => (
                                <HistoryPage
                                    key={page.cursor ?? 'first'}
                                    cursor={page.cursor}
                                    isLast={idx === pages.length - 1}
                                    onLoadMore={(next) => setPages((p) => [...p, { cursor: next }])}
                                    onResetToFirstPage={handleResetToFirstPage}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            </SheetContent>
        </Sheet>
    );
};
