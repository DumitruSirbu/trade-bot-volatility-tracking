import * as React from 'react';
import type { IPerformanceByVersionView } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { usePerformanceByVersion } from '@/api/queries';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoneyString } from '@/lib/utils';

type SortKey = 'label' | 'tradeCount' | 'winRate' | 'netPnlUsd' | 'maxDrawdownUsd' | 'sharpe';

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric: boolean }> = [
    { key: 'label', label: 'Version', numeric: false },
    { key: 'tradeCount', label: 'Trades', numeric: true },
    { key: 'winRate', label: 'Win rate', numeric: true },
    { key: 'netPnlUsd', label: 'Net PnL', numeric: true },
    { key: 'maxDrawdownUsd', label: 'Max DD', numeric: true },
    { key: 'sharpe', label: 'Sharpe', numeric: true },
];

const compareValues = (left: IPerformanceByVersionView, right: IPerformanceByVersionView, key: SortKey): number => {
    const leftRaw = left[key];
    const rightRaw = right[key];

    if (leftRaw === null && rightRaw === null) {
        return 0;
    }
    if (leftRaw === null) {
        return 1;
    }
    if (rightRaw === null) {
        return -1;
    }

    if (typeof leftRaw === 'number' && typeof rightRaw === 'number') {
        return leftRaw - rightRaw;
    }

    const leftNum = Number(leftRaw);
    const rightNum = Number(rightRaw);

    if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
        return leftNum - rightNum;
    }

    return String(leftRaw).localeCompare(String(rightRaw));
};

const formatWinRate = (value: string | null): string => (value === null ? '—' : `${(Number(value) * 100).toFixed(1)}%`);

const StatusRow = ({ message }: { message: string }): React.ReactElement => (
    <TableRow>
        <TableCell colSpan={COLUMNS.length} className="py-8 text-center text-sm text-muted-foreground">
            {message}
        </TableCell>
    </TableRow>
);

export const PerformanceByVersion = (): React.ReactElement => {
    const { data, isLoading, isError, error } = usePerformanceByVersion();
    const [sortKey, setSortKey] = React.useState<SortKey>('netPnlUsd');
    const [direction, setDirection] = React.useState<'asc' | 'desc'>('desc');

    const handleHeaderClick = (key: SortKey): void => {
        if (key === sortKey) {
            setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));

            return;
        }
        setSortKey(key);
        setDirection('desc');
    };

    const sorted = React.useMemo<IPerformanceByVersionView[]>(() => {
        if (data === undefined) {
            return [];
        }
        const copy = [...data];
        copy.sort((left, right) => (direction === 'asc' ? compareValues(left, right, sortKey) : compareValues(right, left, sortKey)));

        return copy;
    }, [data, sortKey, direction]);

    return (
        <Table>
            <TableHeader>
                <TableRow>
                    {COLUMNS.map((col) => (
                        <TableHead
                            key={col.key}
                            className={`cursor-pointer select-none ${col.numeric ? 'text-right' : ''}`}
                            onClick={() => handleHeaderClick(col.key)}
                        >
                            {col.label}
                            {sortKey === col.key ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
                        </TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {isLoading && <StatusRow message="Loading performance…" />}
                {isError && <StatusRow message={error instanceof ApiError ? error.message : 'Failed to load performance.'} />}
                {!isLoading && !isError && sorted.length === 0 && <StatusRow message="No performance data yet." />}
                {!isLoading &&
                    !isError &&
                    sorted.map((row) => (
                        <TableRow key={row.strategyVersionId}>
                            <TableCell className="font-medium">{row.label}</TableCell>
                            <TableCell className="text-right tabular-nums">{row.tradeCount}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatWinRate(row.winRate)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatMoneyString(row.netPnlUsd)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatMoneyString(row.maxDrawdownUsd)}</TableCell>
                            <TableCell className="text-right tabular-nums">{row.sharpe ?? '—'}</TableCell>
                        </TableRow>
                    ))}
            </TableBody>
        </Table>
    );
};
