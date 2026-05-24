import { PositionStateEnum } from '../enum/PositionStateEnum.js';
import { ExitReasonEnum } from '../enum/ExitReasonEnum.js';

export interface IPositionStateTransitionedEvent {
	readonly positionId: number;
	readonly fromState: PositionStateEnum;
	readonly toState: PositionStateEnum;
	readonly transitionedAtMs: number;
	readonly eventClass: string;
	readonly symbol: string;
	readonly exitReason: ExitReasonEnum | null;
	readonly realizedPnl: string | null;
}
