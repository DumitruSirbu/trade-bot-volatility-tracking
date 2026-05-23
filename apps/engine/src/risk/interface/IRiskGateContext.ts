import { IMarketSnapshot, IStrategyParams } from '@bot/shared';

import { IInstrumentPort } from './IInstrumentPort';
import { IOpenPositionsPort } from './IOpenPositionsPort';
import { IRiskLimits } from './IRiskLimits';
import { IRiskStatePort } from './IRiskStatePort';

// Everything time/state-dependent the gate needs, resolved by the orchestrator at the
// boundary and handed in (ADR 0004 §7). nowMs is the deterministic bar-close clock — the
// gate NEVER calls Date.now(). The ports back onto repositories live and onto the simulated
// book in backtest, so the decision path is identical.
export interface IRiskGateContext {
    readonly nowMs: number;
    readonly utcDateString: string; // toUtcDateString(nowMs)
    readonly snapshot: IMarketSnapshot;
    readonly params: IStrategyParams;
    readonly strategyVersionId: number;
    readonly belowUniverseFloor: boolean; // resolved by the orchestrator (universe membership)
    readonly limits: IRiskLimits;
    readonly riskState: IRiskStatePort;
    readonly openPositions: IOpenPositionsPort;
    readonly instruments: IInstrumentPort;
    readonly modelDivergenceDetected: boolean; // M9-fed kill-switch flag (§14)
}
