import { IPortfolioSelection, IPortfolioStrategy, IPortfolioStrategyInput, StrategyDirectionEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { crossSectionalMomentumCore } from './crossSectionalMomentumCore';

// The M50 cross-sectional momentum portfolio strategy (ADR 0047 §2.1). A thin, deterministic
// adapter over the pure ranking core: it holds only its lineage identity (name/version/direction)
// and delegates every decision to crossSectionalMomentumCore. @Injectable so the portfolio module
// can provide it; it carries no DI dependencies of its own (purity is preserved in the core).
@Injectable()
export class XMomPortfolioStrategy implements IPortfolioStrategy {
    readonly name = 'xmom';

    readonly version = 1;

    readonly direction = StrategyDirectionEnum.MOMENTUM;

    selectUniverse(input: IPortfolioStrategyInput): IPortfolioSelection {
        return crossSectionalMomentumCore(input.universe, input.params, input.nowMs);
    }
}
