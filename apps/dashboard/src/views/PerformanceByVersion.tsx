import * as React from 'react';
import type { IDailyPerformanceRow, IPerformanceByVersionView, IShadowPerformanceSummary } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { usePerformanceByVersion, usePerformanceDailySeries, useShadowPerformanceSummary } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn, formatMoneyString } from '@/lib/utils';

const WINDOW_OPTIONS: ReadonlyArray<number> = [7, 14, 30];
const DEFAULT_WINDOW_DAYS = 30;

const formatPct = (value: string | null): string => (value === null ? '—' : `${(Number(value) * 100).toFixed(1)}%`);

const pnlColorClass = (value: string): string => {
    const numeric = Number(value);

    if (!Number.isFinite(numeric) || numeric === 0) {
        return '';
    }

    return numeric > 0 ? 'text-green-600' : 'text-red-600';
};

const errorMessage = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);

const PanelHeading = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{children}</h3>
);

const StatusRow = ({ message, colSpan }: { message: string; colSpan: number }): React.ReactElement => (
    <TableRow>
        <TableCell colSpan={colSpan} className="py-8 text-center text-sm text-muted-foreground">
            {message}
        </TableCell>
    </TableRow>
);

const WindowSelector = ({ value, onChange }: { value: number; onChange: (days: number) => void }): React.ReactElement => (
    <div className="flex gap-2">
        {WINDOW_OPTIONS.map((days) => (
            <Button key={days} size="sm" variant={days === value ? 'default' : 'outline'} onClick={() => onChange(days)}>
                {days}d
            </Button>
        ))}
    </div>
);

type SortKey = 'label' | 'tradeCount' | 'winRate' | 'netPnlUsd' | 'maxDrawdownUsd' | 'sharpe';

const SUMMARY_COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric: boolean }> = [
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

const SummaryPanel = ({ windowDays }: { windowDays: number }): React.ReactElement => {
    const { data, isLoading, isError, error } = usePerformanceByVersion(windowDays);
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
        <section>
            <PanelHeading>Summary by version</PanelHeading>
            <Table>
                <TableHeader>
                    <TableRow>
                        {SUMMARY_COLUMNS.map((col) => (
                            <TableHead
                                key={col.key}
                                className={cn('cursor-pointer select-none', col.numeric && 'text-right')}
                                onClick={() => handleHeaderClick(col.key)}
                            >
                                {col.label}
                                {sortKey === col.key ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {isLoading && <StatusRow message="Loading performance…" colSpan={SUMMARY_COLUMNS.length} />}
                    {isError && <StatusRow message={errorMessage(error, 'Failed to load performance.')} colSpan={SUMMARY_COLUMNS.length} />}
                    {!isLoading && !isError && sorted.length === 0 && <StatusRow message="No performance data yet." colSpan={SUMMARY_COLUMNS.length} />}
                    {!isLoading &&
                        !isError &&
                        sorted.map((row) => (
                            <TableRow key={row.strategyVersionId}>
                                <TableCell className="font-medium">{row.label}</TableCell>
                                <TableCell className="text-right tabular-nums">{row.tradeCount}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatPct(row.winRate)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatMoneyString(row.netPnlUsd)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatMoneyString(row.maxDrawdownUsd)}</TableCell>
                                <TableCell className="text-right tabular-nums">{row.sharpe ?? '—'}</TableCell>
                            </TableRow>
                        ))}
                </TableBody>
            </Table>
        </section>
    );
};

const DAILY_COLUMNS_COUNT = 5;

const DailyBreakdownPanel = ({ windowDays }: { windowDays: number }): React.ReactElement => {
    const { data, isLoading, isError, error } = usePerformanceDailySeries(windowDays);
    const [selectedVersion, setSelectedVersion] = React.useState<string | null>(null);

    const versionLabels = React.useMemo<string[]>(() => {
        if (data === undefined) {
            return [];
        }

        return [...new Set(data.map((row) => row.label))];
    }, [data]);

    const activeVersion = selectedVersion ?? versionLabels[0] ?? null;

    const rows = React.useMemo<IDailyPerformanceRow[]>(() => {
        if (data === undefined || activeVersion === null) {
            return [];
        }

        return data.filter((row) => row.label === activeVersion);
    }, [data, activeVersion]);

    return (
        <section>
            <div className="mb-2 flex items-center justify-between">
                <PanelHeading>Daily breakdown</PanelHeading>
                {versionLabels.length > 0 && (
                    <select
                        className="h-8 rounded-md border border-input bg-background px-3 text-xs"
                        value={activeVersion ?? ''}
                        onChange={(event) => setSelectedVersion(event.target.value)}
                    >
                        {versionLabels.map((label) => (
                            <option key={label} value={label}>
                                {label}
                            </option>
                        ))}
                    </select>
                )}
            </div>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Trades</TableHead>
                        <TableHead className="text-right">Win rate</TableHead>
                        <TableHead className="text-right">Day PnL</TableHead>
                        <TableHead className="text-right">Cumulative PnL</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {isLoading && <StatusRow message="Loading daily breakdown…" colSpan={DAILY_COLUMNS_COUNT} />}
                    {isError && <StatusRow message={errorMessage(error, 'Failed to load daily breakdown.')} colSpan={DAILY_COLUMNS_COUNT} />}
                    {!isLoading && !isError && rows.length === 0 && <StatusRow message="No daily data yet." colSpan={DAILY_COLUMNS_COUNT} />}
                    {!isLoading &&
                        !isError &&
                        rows.map((row) => (
                            <TableRow key={`${row.strategyVersionId}-${row.date}`}>
                                <TableCell className="font-medium tabular-nums">{row.date}</TableCell>
                                <TableCell className="text-right tabular-nums">{row.trades}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatPct(row.winRate)}</TableCell>
                                <TableCell className={cn('text-right tabular-nums', pnlColorClass(row.dayPnlUsd))}>
                                    {formatMoneyString(row.dayPnlUsd)}
                                </TableCell>
                                <TableCell className={cn('text-right tabular-nums', pnlColorClass(row.cumulativePnlUsd))}>
                                    {formatMoneyString(row.cumulativePnlUsd)}
                                </TableCell>
                            </TableRow>
                        ))}
                </TableBody>
            </Table>
        </section>
    );
};

const SHADOW_COLUMNS_COUNT = 5;

const ShadowComparisonPanel = ({ windowDays }: { windowDays: number }): React.ReactElement => {
    const { data, isLoading, isError, error } = useShadowPerformanceSummary(windowDays);
    const rows = data ?? [];

    return (
        <section>
            <PanelHeading>Shadow versions (simulated fills)</PanelHeading>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Shadow</TableHead>
                        <TableHead className="text-right">Trades</TableHead>
                        <TableHead className="text-right">Win rate</TableHead>
                        <TableHead className="text-right">Net PnL</TableHead>
                        <TableHead className="text-right">Force-close %</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {isLoading && <StatusRow message="Loading shadow comparison…" colSpan={SHADOW_COLUMNS_COUNT} />}
                    {isError && <StatusRow message={errorMessage(error, 'Failed to load shadow comparison.')} colSpan={SHADOW_COLUMNS_COUNT} />}
                    {!isLoading && !isError && rows.length === 0 && <StatusRow message="No shadow data yet." colSpan={SHADOW_COLUMNS_COUNT} />}
                    {!isLoading &&
                        !isError &&
                        rows.map((row: IShadowPerformanceSummary) => (
                            <TableRow key={row.shadowVersion}>
                                <TableCell className="font-medium">{row.shadowVersion}</TableCell>
                                <TableCell className="text-right tabular-nums">{row.tradeCount}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatPct(row.winRate)}</TableCell>
                                <TableCell className={cn('text-right tabular-nums', pnlColorClass(row.netPnlUsd))}>
                                    {formatMoneyString(row.netPnlUsd)}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{formatPct(row.forceCloseFraction)}</TableCell>
                            </TableRow>
                        ))}
                </TableBody>
            </Table>
        </section>
    );
};

export const PerformanceByVersion = (): React.ReactElement => {
    const [windowDays, setWindowDays] = React.useState<number>(DEFAULT_WINDOW_DAYS);

    return (
        <div className="space-y-6">
            <WindowSelector value={windowDays} onChange={setWindowDays} />
            <SummaryPanel windowDays={windowDays} />
            <DailyBreakdownPanel windowDays={windowDays} />
            <ShadowComparisonPanel windowDays={windowDays} />
        </div>
    );
};
