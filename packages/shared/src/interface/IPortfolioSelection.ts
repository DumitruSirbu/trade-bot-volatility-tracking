import { PortfolioSelectionReasonEnum } from '../enum/PortfolioSelectionReasonEnum.js';
import { ISelectedSymbol } from './ISelectedSymbol.js';

export interface IPortfolioSelection {
    readonly selected: ReadonlyArray<ISelectedSymbol>;
    readonly reason: PortfolioSelectionReasonEnum;
}
