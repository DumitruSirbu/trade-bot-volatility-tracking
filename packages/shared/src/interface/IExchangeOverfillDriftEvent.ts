export interface IExchangeOverfillDriftEvent {
	readonly positionId: number;
	readonly symbol: string;
	readonly clientOrderId: string;
	readonly expectedQty: string;
	readonly actualFilledQty: string;
	readonly clampGapQty: string;
	readonly detectedAtMs: number;
}
