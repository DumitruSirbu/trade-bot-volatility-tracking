import { PositionSideEnum } from '../enum/PositionSideEnum.js';

export interface IPositionAdoptionVanishedEvent {
	readonly positionId: number;
	readonly symbol: string;
	readonly side: PositionSideEnum;
	readonly detectedAtMs: number;
}
