import * as React from 'react';
import { HelpCircle } from 'lucide-react';
import type { IDecisionView } from '@bot/shared';
import { DecisionOutcomeEnum, SignalActionEnum } from '@bot/shared';

import { ApiError } from '@/api/apiClient';
import { useDecisionsRecent, type IDecisionFilters, DECISIONS_PAGE_SIZE } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MultiSelect, type IMultiSelectOption } from '@/components/ui/multi-select';
import { Tooltip } from '@/components/ui/tooltip';

const COLUMN_COUNT = 7;

const ACTION_OPTIONS: IMultiSelectOption[] = [
    { value: SignalActionEnum.OPEN, label: 'OPEN' },
    { value: SignalActionEnum.ADD, label: 'ADD' },
    { value: SignalActionEnum.REDUCE, label: 'REDUCE' },
    { value: SignalActionEnum.CLOSE, label: 'CLOSE' },
    { value: SignalActionEnum.SKIP, label: 'SKIP' },
];

const OUTCOME_OPTIONS: IMultiSelectOption[] = [
    { value: DecisionOutcomeEnum.FILLED, label: 'FILLED' },
    { value: DecisionOutcomeEnum.APPROVED, label: 'APPROVED' },
    { value: DecisionOutcomeEnum.REJECTED, label: 'REJECTED' },
    { value: DecisionOutcomeEnum.SKIPPED, label: 'SKIPPED' },
];

const TooltipEntry = ({ term, def }: { term: string; def: string }): React.ReactElement => (
    <div className="mt-1 leading-snug">
        <span className="font-semibold text-popover-foreground">{term}</span>
        <span className="text-muted-foreground"> — {def}</span>
    </div>
);

const TooltipSection = ({ title }: { title: string }): React.ReactElement => (
    <div className="mt-2 mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{title}</div>
);

const COLUMN_HELP: Record<string, React.ReactNode> = {
    time: (
        <div>
            <p>When the VWAP-deviation trigger fired for this symbol, in UTC.</p>
            <p className="mt-1 text-muted-foreground">Format: YYYY-MM-DD HH:MM:SS</p>
        </div>
    ),
    symbol: (
        <div>
            <p>The Binance USDT-M perpetual futures pair that triggered the strategy evaluation.</p>
            <p className="mt-1 text-muted-foreground">Format: BASE/USDT:USDT (e.g. BTC/USDT:USDT)</p>
        </div>
    ),
    action: (
        <div>
            <p>Strategy intent for this trigger (not the same as execution outcome):</p>
            <TooltipEntry term="OPEN" def="Intent to open a new position" />
            <TooltipEntry term="ADD" def="Intent to scale into an existing position" />
            <TooltipEntry term="REDUCE" def="Intent to partially exit" />
            <TooltipEntry term="CLOSE" def="Intent to close entirely" />
            <TooltipEntry term="SKIP" def="No trade intent; see Outcome and Reason" />
        </div>
    ),
    outcome: (
        <div>
            <p>Gate and execution result derived from persisted fields:</p>
            <TooltipEntry term="FILLED" def="Linked to a position (`position_id` set)" />
            <TooltipEntry term="APPROVED" def="Risk gate passed; order may still be unfilled (see Reason)" />
            <TooltipEntry term="REJECTED" def="Risk gate blocked the open intent — no position created" />
            <TooltipEntry term="SKIPPED" def="Strategy chose not to trade" />
        </div>
    ),
    flowType: (
        <div>
            <p>Market flow classification that drove the signal:</p>
            <TooltipEntry term="vwap_deviation_long_bias" def="Price dumped below VWAP — long mean-reversion candidate" />
            <TooltipEntry term="vwap_deviation_short_bias" def="Price pumped above VWAP — short mean-reversion candidate" />
        </div>
    ),
    score: (
        <div>
            <p>Signal confidence score (0–100). Higher = stronger conviction.</p>
            <p className="mt-1 text-muted-foreground">
                Combines VWAP deviation sigma, open-interest trend, and funding pressure. Shown as&nbsp;
                <span className="font-semibold text-popover-foreground">—</span> when any required input is missing.
            </p>
        </div>
    ),
    reason: (
        <div>
            <p>Why the action was taken or skipped:</p>
            <TooltipSection title="Skip reasons" />
            <TooltipEntry term="baseline_no_trade" def="Strategy v0 baseline always skips; expected outcome" />
            <TooltipEntry term="regime_suppressed" def="Market regime not favorable for this flow type" />
            <TooltipEntry term="market_stress" def="Elevated volatility or spread beyond threshold" />
            <TooltipEntry term="no_exhaustion_confirmation" def="Momentum not confirmed as exhausted" />
            <TooltipEntry term="out_of_scope" def="Symbol outside the configured trade universe" />
            <TooltipEntry term="idiosyncratic_trap" def="Move is symbol-specific, not market-wide; fade risk high" />
            <TooltipEntry term="flow_routed_skip" def="Flow-type router decided to skip this signal" />
            <TooltipEntry term="low_signal_score" def="Score below the minimum threshold" />
            <TooltipEntry term="funding_cost_too_high" def="Funding rate makes the position uneconomical" />
            <TooltipEntry term="move_out_of_band" def="Price move too large to be a mean-reversion candidate" />
            <TooltipEntry term="oi_unavailable" def="Open-interest data unavailable for this symbol" />
            <TooltipSection title="Risk gate reject reasons" />
            <TooltipEntry term="global_halt" def="Engine-wide halt active (operator, loss limit, or rate-limit)" />
            <TooltipEntry term="max_positions_reached" def="3-slot position cap reached" />
            <TooltipEntry term="spread_too_wide" def="Bid/ask spread exceeds the allowed threshold" />
            <TooltipEntry
                term="coin_book_too_thin"
                def="Order-book depth at 10bps is at/below the per-tier floor — this individual coin is too thin to trade (per-coin skip, not a market halt)"
            />
            <TooltipEntry term="funding_suppressed" def="Funding rate too high to open" />
            <TooltipEntry term="cooldown_active" def="Symbol closed recently; cooldown period active" />
            <TooltipEntry term="daily_loss_limit" def="Daily loss cap reached; no new opens until tomorrow" />
            <TooltipEntry term="weekly_loss_limit" def="7-day rolling loss cap reached" />
            <TooltipEntry term="consecutive_loss_halt" def="Multiple consecutive losses triggered safety halt" />
            <TooltipEntry term="max_trades_per_symbol_per_day" def="Per-symbol daily trade cap reached" />
            <TooltipEntry term="same_direction_exposure_cap" def="Too much total exposure in the same direction" />
            <TooltipEntry term="sl_outside_liquidation" def="Stop-loss would be beyond liquidation price" />
            <TooltipEntry term="reconciling_hold" def="Position reconciliation in progress; no new trades" />
            <TooltipEntry term="no_eligible_slot" def="No open slot available for this symbol/direction" />
            <TooltipEntry term="tp_below_cost" def="Take-profit would not cover fees — geometry rejected" />
        </div>
    ),
};

const actionVariant = (action: SignalActionEnum): 'success' | 'warning' | 'secondary' | 'destructive' => {
    switch (action) {
        case SignalActionEnum.ADD:
            return 'success';
        case SignalActionEnum.REDUCE:
            return 'warning';
        case SignalActionEnum.CLOSE:
            return 'destructive';
        case SignalActionEnum.OPEN:
        case SignalActionEnum.SKIP:
        default:
            return 'secondary';
    }
};

const outcomeVariant = (outcome: DecisionOutcomeEnum): 'success' | 'warning' | 'secondary' | 'destructive' => {
    switch (outcome) {
        case DecisionOutcomeEnum.FILLED:
            return 'success';
        case DecisionOutcomeEnum.APPROVED:
            return 'warning';
        case DecisionOutcomeEnum.REJECTED:
            return 'destructive';
        case DecisionOutcomeEnum.SKIPPED:
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

// When exactly one filter value is selected the engine does the filtering;
// when several are selected we fetch unfiltered and narrow client-side on the
// loaded page (the engine accepts a single value per filter — MVP scope).
const toServerFilter = (selected: string[]): string | undefined => (selected.length === 1 ? selected[0] : undefined);

const applyClientFilter = (rows: IDecisionView[], selectedActions: string[], selectedOutcomes: string[], selectedSymbols: string[]): IDecisionView[] => {
    const actionSet = new Set(selectedActions);
    const outcomeSet = new Set(selectedOutcomes);
    const symbolSet = new Set(selectedSymbols);

    return rows.filter((row) => {
        const actionOk = actionSet.size < 2 || actionSet.has(row.action);
        const outcomeOk = outcomeSet.size === 0 || outcomeSet.has(row.outcome);
        const symbolOk = symbolSet.size < 2 || symbolSet.has(row.symbol);

        return actionOk && outcomeOk && symbolOk;
    });
};

interface IColumnHeaderProps {
    label: string;
    help: React.ReactNode;
    tooltipClassName?: string;
    align?: 'left' | 'right';
    firstColumn?: boolean;
}

const ColumnHeader = ({ label, help, tooltipClassName, align = 'left', firstColumn = false }: IColumnHeaderProps): React.ReactElement => {
    const leftPadding = firstColumn ? 'pl-4' : '';
    const textAlign = align === 'right' ? 'text-right' : 'text-left';

    return (
        <th className={`py-3 pr-6 ${leftPadding} ${textAlign} text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap`}>
            <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
                {label}
                <Tooltip content={help} className={tooltipClassName}>
                    <HelpCircle className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" aria-label={`${label} column help`} />
                </Tooltip>
            </span>
        </th>
    );
};

const DecisionRow = ({ decision }: { decision: IDecisionView }): React.ReactElement => (
    <tr className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
        <td className="py-3 pr-6 pl-4 font-mono text-xs text-muted-foreground whitespace-nowrap">{formatTimestamp(decision.occurredAt)}</td>
        <td className="py-3 pr-6 font-medium text-sm whitespace-nowrap">{decision.symbol}</td>
        <td className="py-3 pr-6">
            <Badge variant={actionVariant(decision.action)}>{decision.action.toUpperCase()}</Badge>
        </td>
        <td className="py-3 pr-6">
            <Badge variant={outcomeVariant(decision.outcome)}>{decision.outcome.toUpperCase()}</Badge>
        </td>
        <td className="py-3 pr-6 text-xs text-muted-foreground whitespace-nowrap">{decision.flowType}</td>
        <td className="py-3 pr-6 text-right font-mono text-xs tabular-nums">{decision.signalScore ?? '—'}</td>
        <td className="py-3 text-sm text-muted-foreground max-w-xs truncate" title={decision.reason ?? undefined}>
            {decision.reason ?? '—'}
        </td>
    </tr>
);

const MessageRow = ({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'destructive' }): React.ReactElement => (
    <tr>
        <td colSpan={COLUMN_COUNT} className={`py-6 text-center text-sm ${tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'}`}>
            {children}
        </td>
    </tr>
);

export const DecisionsFeed = (): React.ReactElement => {
    const [selectedActions, setSelectedActions] = React.useState<string[]>([]);
    const [selectedOutcomes, setSelectedOutcomes] = React.useState<string[]>([]);
    const [selectedSymbols, setSelectedSymbols] = React.useState<string[]>([]);
    // Cursor stack: index 0 is page 1 (null cursor). The last entry is the
    // cursor used to fetch the page currently on screen.
    const [cursorStack, setCursorStack] = React.useState<(string | null)[]>([null]);

    const resetToFirstPage = React.useCallback(() => setCursorStack([null]), []);

    const handleActionChange = React.useCallback(
        (next: string[]) => {
            setSelectedActions(next);
            resetToFirstPage();
        },
        [resetToFirstPage],
    );

    const handleOutcomeChange = React.useCallback(
        (next: string[]) => {
            setSelectedOutcomes(next);
            resetToFirstPage();
        },
        [resetToFirstPage],
    );

    const handleSymbolChange = React.useCallback(
        (next: string[]) => {
            setSelectedSymbols(next);
            resetToFirstPage();
        },
        [resetToFirstPage],
    );

    const currentCursor = cursorStack[cursorStack.length - 1];
    const pageNumber = cursorStack.length;

    const filters: IDecisionFilters = React.useMemo(
        () => ({ action: toServerFilter(selectedActions), symbol: toServerFilter(selectedSymbols) }),
        [selectedActions, selectedSymbols],
    );

    const { data, isLoading, isError, error } = useDecisionsRecent(currentCursor, filters);

    const loadedItems = data?.items ?? [];
    const visibleItems = applyClientFilter(loadedItems, selectedActions, selectedOutcomes, selectedSymbols);
    const isClientFilterActive = selectedActions.length > 1 || selectedOutcomes.length >= 1 || selectedSymbols.length > 1;

    const symbolOptions = React.useMemo<IMultiSelectOption[]>(() => {
        const fromPage = loadedItems.map((item) => item.symbol);
        const unique = Array.from(new Set([...selectedSymbols, ...fromPage])).sort();

        return unique.map((symbol) => ({ value: symbol, label: symbol }));
    }, [loadedItems, selectedSymbols]);

    const hasNextPage = data?.nextCursor != null;

    const goNext = React.useCallback((): void => {
        if (data?.nextCursor != null) {
            setCursorStack((stack) => [...stack, data.nextCursor]);
        }
    }, [data?.nextCursor]);

    const goPrevious = React.useCallback((): void => {
        setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
    }, []);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <MultiSelect label="Action" options={ACTION_OPTIONS} selected={selectedActions} onChange={handleActionChange} />
                <MultiSelect label="Outcome" options={OUTCOME_OPTIONS} selected={selectedOutcomes} onChange={handleOutcomeChange} />
                <MultiSelect
                    label="Symbol"
                    options={symbolOptions}
                    selected={selectedSymbols}
                    onChange={handleSymbolChange}
                    searchable
                    emptyText="No symbols on this page"
                />
                <span className="ml-auto text-xs text-muted-foreground">Page size: {data?.pageSize ?? DECISIONS_PAGE_SIZE}</span>
            </div>
            {isClientFilterActive && !isLoading && (
                <div className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-1.5 border">
                    Multiple values selected — filtering the current page only. Results on other pages are not included.
                </div>
            )}
            <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b bg-muted/50">
                            <ColumnHeader label="Time" help={COLUMN_HELP.time} firstColumn />
                            <ColumnHeader label="Symbol" help={COLUMN_HELP.symbol} />
                            <ColumnHeader label="Action" help={COLUMN_HELP.action} />
                            <ColumnHeader label="Outcome" help={COLUMN_HELP.outcome} />
                            <ColumnHeader label="Flow Type" help={COLUMN_HELP.flowType} />
                            <ColumnHeader label="Score" help={COLUMN_HELP.score} align="right" />
                            <ColumnHeader label="Reason" help={COLUMN_HELP.reason} tooltipClassName="w-80" />
                        </tr>
                    </thead>
                    <tbody>
                        {isLoading && <MessageRow>Loading decisions…</MessageRow>}
                        {isError && !isLoading && (
                            <MessageRow tone="destructive">{error instanceof ApiError ? error.message : 'Failed to load decisions.'}</MessageRow>
                        )}
                        {!isLoading && !isError && visibleItems.length === 0 && (
                            <MessageRow>
                                {isClientFilterActive
                                    ? 'No matches on this page — results are filtered client-side from the current page only. Try advancing pages or reducing your filter selection.'
                                    : 'No decisions match the current filters.'}
                            </MessageRow>
                        )}
                        {!isLoading && !isError && visibleItems.map((decision) => <DecisionRow key={decision.id} decision={decision} />)}
                    </tbody>
                </table>
            </div>
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
