import { FlowTypeEnum, SkipReasonEnum, StrategyDirectionEnum } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { ISignal, IStrategy, IStrategyInput } from '../interface';
import { buildSkipSignal, resolveSignalType } from '../utils';
import { evaluateMeanReversion } from './meanReversionCore';
import { evaluateMomentum } from './momentumCore';

// v3 — hybrid flow router (M3 brief; ADR 0003 §4). Reads the ALREADY-STAMPED flow_type
// from its input (it does NOT re-classify) and routes:
//   forced_exhaustion → mean-reversion core (the valid fade case)
//   trend_initiation  → momentum core
//   market_beta       → skip (1-slot relaxation is a later milestone)
//   catalyst_risk     → skip
//   low_quality_noise → skip
// Reuses v1/v2 logic via the shared cores (no copy-paste).
@Injectable()
export class V3HybridRouterStrategy implements IStrategy {
    readonly name = 'volatility-vwap';
    readonly version = 3;
    readonly direction = StrategyDirectionEnum.HYBRID;

    evaluate(input: IStrategyInput): ISignal {
        const flowType = input.event.flowType;

        if (flowType === FlowTypeEnum.FORCED_EXHAUSTION) {
            return evaluateMeanReversion(input);
        }

        if (flowType === FlowTypeEnum.TREND_INITIATION) {
            return evaluateMomentum(input);
        }

        return buildSkipSignal({
            signalType: resolveSignalType(input.event),
            skipReason: SkipReasonEnum.FLOW_ROUTED_SKIP,
            signalScore: input.snapshot.signal_score,
            flowType,
        });
    }
}
