import * as React from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import { getStrategyDisplayMetadata } from '@/lib/strategyMetadata';

// Renders a strategy's short name (e.g. "xmom") with a hover tooltip showing
// its full display name and description. Shared between ClosedPositionsTable
// and PositionDetail so the two views stay in sync.
export const StrategyNameLabel = ({ strategyVersionName }: { strategyVersionName: string }): React.ReactElement => {
    const { fullName, description } = getStrategyDisplayMetadata(strategyVersionName);

    return (
        <Tooltip
            content={
                <div>
                    <p className="font-semibold text-popover-foreground">{fullName}</p>
                    <p className="mt-1 text-muted-foreground">{description}</p>
                </div>
            }
        >
            <span className="font-mono text-xs">{strategyVersionName}</span>
        </Tooltip>
    );
};
