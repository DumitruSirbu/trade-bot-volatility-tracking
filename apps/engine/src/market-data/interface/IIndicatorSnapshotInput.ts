import { MoneyValue } from '../../common/utils/money';
import { ICandle } from './ICandle';

// Bundled inputs for computeIndicatorSnapshot. The closed-bar windows and anchors a
// single closed-bar recompute reads (ADR §4) — grouped so the function takes one
// named object rather than four positional args.
export interface IIndicatorSnapshotInput {
    symbol: string;
    closedBars: ICandle[];
    sessionBars: ICandle[];
    eventAnchoredVwap: MoneyValue;
}
