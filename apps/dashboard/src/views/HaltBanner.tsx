import * as React from 'react';
import { HaltSourceEnum, HaltStateEnum, type IKillSwitchState, type IRiskStateView } from '@bot/shared';

import { useHaltStateQuery } from '@/api/mutations';
import { useRiskState } from '@/api/queries';

// M10 W4 (ADR 0021 §2.6). Sticky banner shown when the engine reports
// haltState === 'halted'. Pinned across all routes via Shell mount. Hidden
// when running. Surfaces source, reason, audit id, and flatten-in-progress.

const SOURCE_LABEL: Record<HaltSourceEnum, string> = {
    [HaltSourceEnum.OPERATOR]: 'Operator',
    [HaltSourceEnum.MARKET_STRESS]: 'Risk: market stress',
    [HaltSourceEnum.MODEL_DIVERGENCE]: 'Risk: model divergence',
    [HaltSourceEnum.DAILY_LOSS]: 'Risk: daily loss cap',
    [HaltSourceEnum.WEEKLY_LOSS]: 'Risk: weekly loss cap',
    [HaltSourceEnum.RECOVERY]: 'Recovery',
    [HaltSourceEnum.OTHER]: 'Other',
};

const formatTimestamp = (iso: string | null): string => {
    if (iso === null) {
        return '—';
    }

    const ms = Date.parse(iso);

    return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : iso;
};

const isHalted = (state: IKillSwitchState | undefined, riskHalted: boolean | undefined): boolean => {
    if (state !== undefined) {
        return state.haltState === HaltStateEnum.HALTED;
    }

    return riskHalted === true;
};

// Round-1 logic fix: chain state → risk → static fallback. Pulled out as a
// named helper so the null-coalescing fallthrough cannot be silently dropped
// by a refactor (e.g. a stray `?? ''` that swallows the second step).
const resolveHaltReason = (state: IKillSwitchState | undefined, risk: IRiskStateView | undefined): string => {
    const fromState = state?.haltReason ?? null;
    const fromRisk = risk?.haltReason ?? null;

    return fromState ?? fromRisk ?? '(reason unavailable)';
};

export const HaltBanner = (): React.ReactElement | null => {
    const { data: state } = useHaltStateQuery();
    const { data: risk } = useRiskState();

    if (!isHalted(state, risk?.isHalted)) {
        return null;
    }

    const sourceLabel = state !== undefined ? SOURCE_LABEL[state.haltSource] : 'Unknown';
    const reason = resolveHaltReason(state, risk);
    const haltedAt = formatTimestamp(state?.haltedAt ?? null);
    const auditId = state?.lastTransitionAuditId ?? '—';
    const flattenInProgress = state?.flattenInProgress === true;

    return (
        <div role="alert" className="border-y border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-semibold uppercase tracking-wide">Trading halted</span>
                <span className="text-foreground">
                    Source: <span className="font-medium">{sourceLabel}</span>
                </span>
                <span className="text-foreground">
                    Since: <span className="font-mono text-xs">{haltedAt}</span>
                </span>
                <span className="truncate text-foreground" title={reason}>
                    Reason: <span className="font-medium">{reason}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                    audit: <span className="font-mono">{auditId}</span>
                </span>
                {flattenInProgress && <span className="rounded-sm bg-destructive/20 px-2 py-0.5 text-xs font-semibold">Flatten in progress</span>}
            </div>
        </div>
    );
};
