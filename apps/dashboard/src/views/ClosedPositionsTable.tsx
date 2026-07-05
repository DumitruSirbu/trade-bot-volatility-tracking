import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import type { IClosedPositionView } from '@bot/shared';
import { ExitReasonEnum, PositionSideEnum } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { usePositionsClosed } from '@/api/queries';
import { StrategyNameLabel } from '@/components/StrategyNameLabel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDurationMs, formatMoneyString, formatPriceString } from '@/lib/utils';

const HEADERS: readonly string[] = ['Symbol', 'Side', 'Leverage', 'Entry', 'Exit', 'Realized PnL', 'Exit reason', 'Closed at', 'Hold', 'Strategy'];

const sideVariant = (side: PositionSideEnum): 'success' | 'destructive' => (side === PositionSideEnum.LONG ? 'success' : 'destructive');

const formatClosedAt = (iso: string): string => {
    const ms = Date.parse(iso);

    return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : iso;
};

type ExitReasonVariant = 'destructive' | 'success' | 'secondary' | 'outline';

const exitReasonVariant = (exitReason: ExitReasonEnum | null): ExitReasonVariant => {
    switch (exitReason) {
        case ExitReasonEnum.STOP_LOSS:
            return 'destructive';
        case ExitReasonEnum.TAKE_PROFIT:
            return 'success';
        case ExitReasonEnum.SIGNAL:
        case ExitReasonEnum.TIME_STOP:
        case ExitReasonEnum.MANUAL:
        case ExitReasonEnum.KILL_SWITCH:
            return 'secondary';
        default:
            return 'outline';
    }
};

// PnL sign tint reads the leading '-' of the decimal string (per CLAUDE.md
// "money is decimal, never float") — we never parseFloat a money string.
const pnlTintClass = (realizedPnlUsd: string | null): string => {
    if (realizedPnlUsd === null || realizedPnlUsd === '') {
        return '';
    }

    return realizedPnlUsd.startsWith('-') ? 'text-destructive' : 'text-emerald-600';
};

const ClosedPositionRowView = ({ position, onOpen }: { position: IClosedPositionView; onOpen: (id: string) => void }): React.ReactElement => (
    <TableRow className="cursor-pointer hover:bg-muted/40" onClick={() => onOpen(position.id)}>
        <TableCell className="font-medium">{position.symbol}</TableCell>
        <TableCell>
            <Badge variant={sideVariant(position.side)}>{position.side.toUpperCase()}</Badge>
        </TableCell>
        <TableCell>{position.leverage}x</TableCell>
        <TableCell className="tabular-nums">{formatPriceString(position.entryPrice)}</TableCell>
        <TableCell className="tabular-nums">{formatPriceString(position.exitPrice)}</TableCell>
        <TableCell className={`tabular-nums ${pnlTintClass(position.realizedPnlUsd)}`}>{formatMoneyString(position.realizedPnlUsd)}</TableCell>
        <TableCell>
            <Badge variant={exitReasonVariant(position.exitReason)}>{position.exitReason ?? 'unknown'}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{formatClosedAt(position.closedAt)}</TableCell>
        <TableCell className="text-muted-foreground">{formatDurationMs(position.openedAt, position.closedAt)}</TableCell>
        <TableCell>
            <StrategyNameLabel strategyVersionName={position.strategyVersionName} />
        </TableCell>
    </TableRow>
);

const StatusRow = ({ message }: { message: string }): React.ReactElement => (
    <TableRow>
        <TableCell colSpan={HEADERS.length} className="py-8 text-center text-sm text-muted-foreground">
            {message}
        </TableCell>
    </TableRow>
);

export const ClosedPositionsTable = (): React.ReactElement => {
    const navigate = useNavigate();
    // Cursor stack: index 0 is page 1 (null cursor). The last entry is the
    // cursor used to fetch the page currently on screen. Mirrors DecisionsFeed.
    const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([null]);

    const currentCursor = cursorStack[cursorStack.length - 1];
    const pageNumber = cursorStack.length;

    const { data, isLoading, isError, error } = usePositionsClosed(currentCursor);

    const handleOpen = React.useCallback((id: string) => navigate(`/positions/${id}`), [navigate]);

    const hasNextPage = data?.nextCursor != null;

    const goNext = React.useCallback((): void => {
        if (data?.nextCursor != null) {
            setCursorStack((stack) => [...stack, data.nextCursor]);
        }
    }, [data?.nextCursor]);

    const goPrevious = React.useCallback((): void => {
        setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
    }, []);

    const items = data?.items ?? [];
    const isEmpty = !isLoading && !isError && items.length === 0;

    return (
        <div className="flex flex-col gap-3">
            <Table>
                <TableHeader>
                    <TableRow>
                        {HEADERS.map((header) => (
                            <TableHead key={header}>{header}</TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {isLoading && <StatusRow message="Loading closed positions…" />}
                    {isError && <StatusRow message={error instanceof ApiError ? error.message : 'Failed to load closed positions.'} />}
                    {isEmpty && <StatusRow message="No closed positions." />}
                    {!isLoading && !isError && items.map((position) => <ClosedPositionRowView key={position.id} position={position} onOpen={handleOpen} />)}
                </TableBody>
            </Table>
            <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                    Page {pageNumber}
                    {hasNextPage ? ` of ~${pageNumber + 1}+` : ` of ${pageNumber}`}
                </span>
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={goPrevious} disabled={pageNumber === 1 || isLoading}>
                        Previous
                    </Button>
                    <Button size="sm" variant="outline" onClick={goNext} disabled={!hasNextPage || isLoading}>
                        Next
                    </Button>
                </div>
            </div>
        </div>
    );
};
