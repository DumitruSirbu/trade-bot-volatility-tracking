import { StrategyDirectionEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { ISignal, IStrategy, IStrategyInput } from '../interface';
import { evaluateMomentum } from './momentumCore';

// v2 — VWAP momentum (M3 brief). Follows the spike (long on positive deviation, short on
// negative). Suppresses opens in a ranging regime. Delegates to the shared momentum core.
@Injectable()
export class V2MomentumStrategy implements IStrategy {
    readonly name = 'volatility-vwap';
    readonly version = 2;
    readonly direction = StrategyDirectionEnum.MOMENTUM;

    evaluate(input: IStrategyInput): ISignal {
        return evaluateMomentum(input);
    }
}
