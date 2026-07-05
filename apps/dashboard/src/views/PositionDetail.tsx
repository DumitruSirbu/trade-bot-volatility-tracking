import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import type { IDecisionView, IPositionDetailView } from '@bot/shared';
import { PositionStateEnum } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { usePositionByIdQuery } from '@/api/mutations';
import { useDecisionsRecent } from '@/api/queries';
import { StrategyNameLabel } from '@/components/StrategyNameLabel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { addMoneyStrings, formatAgeMs, formatMoneyString, formatPriceString } from '@/lib/utils';

// M10 W4 — single-position detail page. Route: /positions/:id.
// Pulls /v1/positions/:id directly (cache key controlKeys.positionById).
// Surfaces the full PnL split (price vs funding — preserve nullable funding),
// protective-order info, and per-symbol recent decisions for context.

const DECISIONS_PREVIEW_COUNT = 25;

// Terminal/closing states for which the open-shaped "mark / unrealized PnL"
// fields are meaningless — surfaced as a prominent header badge so the operator
// is not misled by a live-looking mark on a position that is no longer open.
const TERMINAL_STATES: ReadonlySet<PositionStateEnum> = new Set([PositionStateEnum.CLOSING, PositionStateEnum.CLOSED]);

const isTerminalState = (state: PositionStateEnum): boolean => TERMINAL_STATES.has(state);

const StateHeaderBadge = ({ state }: { state: PositionStateEnum }): React.ReactElement => (
    <div className="flex items-center gap-2">
        <Badge variant={isTerminalState(state) ? 'secondary' : 'success'}>{state.toUpperCase()}</Badge>
        {isTerminalState(state) && (
            <span className="text-xs text-muted-foreground">Position is no longer open — mark and unrealized-PnL fields below are not live.</span>
        )}
    </div>
);

const sumPnl = (position: IPositionDetailView): string | null => addMoneyStrings(position.unrealizedPnlPriceUsd, position.unrealizedPnlFundingUsd);

interface IRowProps {
    label: string;
    value: React.ReactNode;
}

const DetailRow = ({ label, value }: IRowProps): React.ReactElement => (
    <div className="flex items-baseline justify-between gap-3 border-b py-2 last:border-b-0">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="tabular-nums">{value}</span>
    </div>
);

const PnlCard = ({ position }: { position: IPositionDetailView }): React.ReactElement => (
    <Card>
        <CardHeader>
            <CardTitle>PnL breakdown</CardTitle>
        </CardHeader>
        <CardContent>
            <DetailRow label="Price PnL" value={formatMoneyString(position.unrealizedPnlPriceUsd)} />
            <DetailRow label="Funding PnL" value={formatMoneyString(position.unrealizedPnlFundingUsd)} />
            <DetailRow label="Total unrealized" value={formatMoneyString(sumPnl(position))} />
        </CardContent>
    </Card>
);

const PricingCard = ({ position, nowMs }: { position: IPositionDetailView; nowMs: number }): React.ReactElement => (
    <Card>
        <CardHeader>
            <CardTitle>Pricing &amp; sizing</CardTitle>
        </CardHeader>
        <CardContent>
            <DetailRow label="Symbol" value={<span className="font-medium">{position.symbol}</span>} />
            <DetailRow label="Side" value={<Badge variant={position.side === 'long' ? 'success' : 'destructive'}>{position.side.toUpperCase()}</Badge>} />
            <DetailRow label="Quantity" value={position.qty} />
            <DetailRow label="Leverage" value={`${position.leverage}x`} />
            <DetailRow label="Entry price" value={formatPriceString(position.entryPrice)} />
            <DetailRow label="Mark / current" value={formatPriceString(position.currentPrice)} />
            <DetailRow label="Time in trade" value={formatAgeMs(position.openedAt, nowMs)} />
            <DetailRow label="Slot" value={position.slot} />
        </CardContent>
    </Card>
);

const ProtectionCard = ({ position }: { position: IPositionDetailView }): React.ReactElement => (
    <Card>
        <CardHeader>
            <CardTitle>Protection &amp; metadata</CardTitle>
        </CardHeader>
        <CardContent>
            <DetailRow label="Protective order" value={position.protectiveOrderType} />
            <DetailRow label="Stop-loss" value={formatPriceString(position.slPrice)} />
            <DetailRow label="Take-profit" value={formatPriceString(position.tpPrice)} />
            <DetailRow label="State" value={position.state} />
            <DetailRow label="Strategy version" value={<StrategyNameLabel strategyVersionName={position.strategyVersionName} />} />
            <DetailRow label="Event id" value={<span className="font-mono text-xs">{position.eventId}</span>} />
            <DetailRow label="Client order id" value={<span className="font-mono text-xs">{position.clientOrderId}</span>} />
        </CardContent>
    </Card>
);

const RecentDecisionsForSymbol = ({ symbol }: { symbol: string }): React.ReactElement => {
    const { data, isLoading, isError } = useDecisionsRecent(null);

    const items = React.useMemo<IDecisionView[]>(() => {
        if (data === undefined) {
            return [];
        }

        return data.items.filter((decision) => decision.symbol === symbol).slice(0, DECISIONS_PREVIEW_COUNT);
    }, [data, symbol]);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Recent decisions for {symbol}</CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading && <p className="text-sm text-muted-foreground">Loading decisions…</p>}
                {isError && <p className="text-sm text-destructive">Failed to load decisions.</p>}
                {!isLoading && !isError && items.length === 0 && <p className="text-sm text-muted-foreground">No recent decisions for this symbol.</p>}
                <ul className="flex flex-col">
                    {items.map((decision) => (
                        <li key={decision.id} className="flex items-baseline gap-3 border-b py-1.5 text-sm last:border-b-0">
                            <span className="w-44 shrink-0 font-mono text-xs text-muted-foreground">{decision.occurredAt.replace('T', ' ').slice(0, 19)}</span>
                            <Badge variant="secondary">{decision.action.toUpperCase()}</Badge>
                            <span className="text-xs text-muted-foreground">{decision.flowType}</span>
                            <span className="flex-1 truncate text-xs" title={decision.reason ?? undefined}>
                                {decision.reason ?? '—'}
                            </span>
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
};

export const PositionDetail = (): React.ReactElement => {
    const { id } = useParams<{ id: string }>();
    const { data, isLoading, isError, error } = usePositionByIdQuery(id);
    const [nowMs, setNowMs] = React.useState<number>(() => Date.now());

    React.useEffect(() => {
        const handle = window.setInterval(() => setNowMs(Date.now()), 1000);

        return () => window.clearInterval(handle);
    }, []);

    return (
        <div className="flex flex-col gap-4 px-6 py-4">
            <div className="flex items-center gap-2">
                <Button asChild variant="ghost" size="sm">
                    <Link to="/">← Back to positions</Link>
                </Button>
            </div>
            {isLoading && <p className="text-sm text-muted-foreground">Loading position…</p>}
            {isError && (
                <p className="text-sm text-destructive">{error instanceof ApiError ? `${error.code}: ${error.message}` : 'Failed to load position.'}</p>
            )}
            {data !== undefined && <StateHeaderBadge state={data.state} />}
            {data !== undefined && (
                <div className="grid gap-4 lg:grid-cols-2">
                    <PricingCard position={data} nowMs={nowMs} />
                    <PnlCard position={data} />
                    <ProtectionCard position={data} />
                    <RecentDecisionsForSymbol symbol={data.symbol} />
                </div>
            )}
        </div>
    );
};
