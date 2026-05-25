import * as React from 'react';
import { HaltStateEnum, type IAccountEquityView, type IRiskStateView } from '@bot/shared';

import { useAccountEquity, useRiskState } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { formatMoneyString } from '@/lib/utils';

interface IMetricProps {
    label: string;
    value: string;
    tone?: 'default' | 'positive' | 'negative';
}

const toneClass = (tone: IMetricProps['tone']): string => {
    if (tone === 'positive') {
        return 'text-emerald-600';
    }
    if (tone === 'negative') {
        return 'text-destructive';
    }

    return '';
};

const Metric = ({ label, value, tone }: IMetricProps): React.ReactElement => (
    <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={`text-lg font-semibold tabular-nums ${toneClass(tone)}`}>{value}</span>
    </div>
);

const toneForPnl = (raw: string | null | undefined): IMetricProps['tone'] => {
    if (raw === null || raw === undefined || raw === '') {
        return 'default';
    }
    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || parsed === 0) {
        return 'default';
    }

    return parsed > 0 ? 'positive' : 'negative';
};

const haltBadge = (risk: IRiskStateView | undefined): React.ReactElement => {
    if (risk === undefined) {
        return <Badge variant="secondary">UNKNOWN</Badge>;
    }
    if (risk.isHalted || risk.haltReason !== null) {
        return <Badge variant="destructive">{HaltStateEnum.HALTED.toUpperCase()}</Badge>;
    }

    return <Badge variant="success">{HaltStateEnum.RUNNING.toUpperCase()}</Badge>;
};

const equityValue = (equity: IAccountEquityView | undefined): string => (equity === undefined ? '—' : formatMoneyString(equity.equityUsd));

const exposureValue = (equity: IAccountEquityView | undefined, risk: IRiskStateView | undefined): string => {
    const fromEquity = equity?.openExposureUsd;

    if (fromEquity !== null && fromEquity !== undefined && fromEquity !== '') {
        return formatMoneyString(fromEquity);
    }

    return risk === undefined ? '—' : formatMoneyString(risk.openExposure);
};

export const AccountStrip = (): React.ReactElement => {
    const equity = useAccountEquity();
    const risk = useRiskState();

    const dayPnl = risk.data?.realizedPnlDay ?? null;

    return (
        <div className="flex flex-wrap items-center gap-6 border-b bg-muted/30 px-6 py-3">
            <Metric label="Equity" value={equityValue(equity.data)} />
            <Metric label="Open exposure" value={exposureValue(equity.data, risk.data)} />
            <Metric label="Day PnL" value={formatMoneyString(dayPnl)} tone={toneForPnl(dayPnl)} />
            <Metric label="Trades today" value={risk.data === undefined ? '—' : String(risk.data.tradesCount)} />
            <div className="ml-auto flex items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Engine</span>
                {haltBadge(risk.data)}
            </div>
        </div>
    );
};
