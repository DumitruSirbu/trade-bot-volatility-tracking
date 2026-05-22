import { StrategyDirectionEnum } from '@bot/shared';

import { ISignal } from './ISignal';
import { IStrategyInput } from './IStrategyInput';

// A pure, deterministic, synchronous strategy (ADR 0003 §1). evaluate computes one
// ISignal and does nothing else: no I/O, no logging, no DB, no exchange calls, no
// Date.now()/Math.random(), no mutation of its inputs. skip is a signal, so evaluate
// ALWAYS returns an ISignal. Persistence/logging is the orchestrator's job.
export interface IStrategy {
    readonly name: string; // matches strategy_versions.name
    readonly version: number; // matches strategy_versions.version
    readonly direction: StrategyDirectionEnum;
    evaluate(input: IStrategyInput): ISignal;
}
