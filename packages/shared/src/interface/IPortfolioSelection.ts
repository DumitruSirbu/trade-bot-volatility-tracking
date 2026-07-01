import { PortfolioSelectionReasonEnum } from '../enum/PortfolioSelectionReasonEnum.js';
import { ISelectedSymbol } from './ISelectedSymbol.js';

export interface IPortfolioSelection {
    /** Full eligible universe ranked best-first (dense rank 1..M). Not sliced to top_n — ADR 0050. */
    readonly ranked: ReadonlyArray<ISelectedSymbol>;
    readonly reason: PortfolioSelectionReasonEnum;
}
