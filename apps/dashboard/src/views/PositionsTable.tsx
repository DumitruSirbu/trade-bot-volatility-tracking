import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import type { IOpenPositionView } from '@bot/shared';
import { PositionSideEnum } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { usePositionsOpen } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { addMoneyStrings, formatAgeMs, formatMoneyString } from '@/lib/utils';

const HEADERS: readonly string[] = ['Symbol', 'Side', 'Leverage', 'Entry', 'Mark', 'SL', 'TP', 'Unrealized PnL', 'Age'];

const sideVariant = (side: PositionSideEnum): 'success' | 'destructive' => (side === PositionSideEnum.LONG ? 'success' : 'destructive');

const sumUnrealized = (position: IOpenPositionView): string | null => addMoneyStrings(position.unrealizedPnlPriceUsd, position.unrealizedPnlFundingUsd);

const PositionRowView = ({ position, nowMs, onOpen }: { position: IOpenPositionView; nowMs: number; onOpen: (id: string) => void }): React.ReactElement => (
    <TableRow className="cursor-pointer hover:bg-muted/40" onClick={() => onOpen(position.id)}>
        <TableCell className="font-medium">{position.symbol}</TableCell>
        <TableCell>
            <Badge variant={sideVariant(position.side)}>{position.side.toUpperCase()}</Badge>
        </TableCell>
        <TableCell>{position.leverage}x</TableCell>
        <TableCell className="tabular-nums">{formatMoneyString(position.entryPrice, 4)}</TableCell>
        <TableCell className="tabular-nums">{formatMoneyString(position.currentPrice, 4)}</TableCell>
        <TableCell className="tabular-nums text-destructive">{position.slPrice ? formatMoneyString(position.slPrice, 4) : '—'}</TableCell>
        <TableCell className="tabular-nums text-green-600">{position.tpPrice ? formatMoneyString(position.tpPrice, 4) : '—'}</TableCell>
        <TableCell className="tabular-nums">{formatMoneyString(sumUnrealized(position))}</TableCell>
        <TableCell className="text-muted-foreground">{formatAgeMs(position.openedAt, nowMs)}</TableCell>
    </TableRow>
);

const StatusRow = ({ message }: { message: string }): React.ReactElement => (
    <TableRow>
        <TableCell colSpan={HEADERS.length} className="py-8 text-center text-sm text-muted-foreground">
            {message}
        </TableCell>
    </TableRow>
);

export const PositionsTable = (): React.ReactElement => {
    const { data, isLoading, isError, error } = usePositionsOpen();
    const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
    const navigate = useNavigate();

    React.useEffect(() => {
        const handle = window.setInterval(() => setNowMs(Date.now()), 1000);

        return () => window.clearInterval(handle);
    }, []);

    const handleOpen = React.useCallback((id: string) => navigate(`/positions/${id}`), [navigate]);

    return (
        <Table>
            <TableHeader>
                <TableRow>
                    {HEADERS.map((header) => (
                        <TableHead key={header}>{header}</TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {isLoading && <StatusRow message="Loading open positions…" />}
                {isError && <StatusRow message={error instanceof ApiError ? error.message : 'Failed to load positions.'} />}
                {!isLoading && !isError && data !== undefined && data.length === 0 && <StatusRow message="No open positions." />}
                {!isLoading && !isError && data?.map((position) => <PositionRowView key={position.id} position={position} nowMs={nowMs} onOpen={handleOpen} />)}
            </TableBody>
        </Table>
    );
};
