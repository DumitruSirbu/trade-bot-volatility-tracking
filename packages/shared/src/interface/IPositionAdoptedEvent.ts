import { PositionSideEnum } from '../enum/PositionSideEnum.js';

export interface IPositionAdoptedEvent {
	readonly positionId: number;
	readonly symbol: string;
	readonly side: PositionSideEnum;
	readonly qty: string;
	readonly entryPrice: string;
	readonly detectedAtMs: number;
}
