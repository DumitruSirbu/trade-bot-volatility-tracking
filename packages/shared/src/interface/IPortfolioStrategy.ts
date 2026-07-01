import { StrategyDirectionEnum } from '../enum/StrategyDirectionEnum.js';
import { IMomentumParams } from '../schema/momentumParamsSchema.js';
import { IPortfolioSelection } from './IPortfolioSelection.js';
import { UniverseEntry } from './UniverseEntry.js';

export interface IPortfolioStrategyInput {
    readonly universe: ReadonlyArray<UniverseEntry>;
    readonly params: IMomentumParams;
    readonly nowMs: number;
}

export interface IPortfolioStrategy {
    readonly name: string;
    readonly version: number;
    readonly direction: StrategyDirectionEnum;
    selectUniverse(input: IPortfolioStrategyInput): IPortfolioSelection;
}
