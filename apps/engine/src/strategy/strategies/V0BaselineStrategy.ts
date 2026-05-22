import { SignalActionEnum, SkipReasonEnum, StrategyDirectionEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { ISignal, IStrategy, IStrategyInput } from '../interface';
import { resolveSignalType } from '../utils';

// v0 — no-trade baseline (M3 brief). Records every trigger with the full snapshot +
// classified flow_type and opens NOTHING. Pure calibration: it ALWAYS skips with
// BASELINE_NO_TRADE, reading (never computing) the orchestrator-stamped flow_type and
// signal_score so the population of events is measured before any direction is trusted.
@Injectable()
export class V0BaselineStrategy implements IStrategy {
    readonly name = 'volatility-vwap';
    readonly version = 0;
    readonly direction = StrategyDirectionEnum.MEAN_REVERSION;

    evaluate(input: IStrategyInput): ISignal {
        return {
            action: SignalActionEnum.SKIP,
            signalType: resolveSignalType(input.event),
            skipReason: SkipReasonEnum.BASELINE_NO_TRADE,
            tradeSide: null,
            signalScore: input.snapshot.signal_score,
            flowType: input.event.flowType,
            reason: SkipReasonEnum.BASELINE_NO_TRADE,
            proposedExit: null,
        };
    }
}
