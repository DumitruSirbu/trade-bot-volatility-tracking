import { StrategyDirectionEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { ISignal, IStrategy, IStrategyInput } from '../interface';
import { evaluateMeanReversion } from './meanReversionCore';

// v1 — exhaustion-confirmed VWAP mean-reversion (M3 brief). Fades the spike (short on
// positive deviation, long on negative) ONLY after exhaustion confirmation, skips
// trend-suppressed and idiosyncratic-trap events. Delegates to the shared reversion core.
@Injectable()
export class V1MeanReversionStrategy implements IStrategy {
    readonly name = 'volatility-vwap';
    readonly version = 1;
    readonly direction = StrategyDirectionEnum.MEAN_REVERSION;

    evaluate(input: IStrategyInput): ISignal {
        return evaluateMeanReversion(input);
    }
}
