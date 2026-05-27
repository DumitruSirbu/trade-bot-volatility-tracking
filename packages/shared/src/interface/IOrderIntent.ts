import {
	OrderIntentActionEnum,
	PositionSideEnum,
	CoinTierEnum,
	CorrelationModeEnum,
	FlowTypeEnum,
	ExitReasonEnum,
} from '../enum/index.js';

/**
 * Order intent: the gate's approval signal to the execution layer.
 * Carries the action, sizing, and metadata needed for order placement
 * and decision tracking.
 *
 * This is the shared interface visible on the IExecutionClient port.
 * The engine has a richer internal version (IOrderIntent in risk/interface/)
 * that includes MoneyValue decimals and position-state context; this version
 * is the contract for port implementations.
 *
 * @cite M11a R2a.1b — shared DTO for IExecutionClient port
 */
export interface IOrderIntent {
	/** Action: open|add|reduce|close|flatten. */
	intentAction: OrderIntentActionEnum;

	/** Trading pair (e.g., 'BTCUSDT'). */
	symbol: string;

	/** Event ID tying back to the trigger/decision. */
	eventId: string;

	/** Position side: long|short. */
	tradeSide: PositionSideEnum;

	/** Signal conviction [0, 100]. */
	signalScore: number;

	/** Correlation mode: idiosyncratic|correlated. */
	correlationMode: CorrelationModeEnum;

	/** Coin tier for risk classification. */
	coinTier: CoinTierEnum;

	/** Idiosyncrasy score [0, 1]. */
	idiosyncrasyScore: number;

	/** Quantity to open/add/reduce/close (decimal-as-string). */
	quantity: string;

	/** Flow type: drives order-policy routing. */
	flowType: FlowTypeEnum;

	/** Optional explicit exit reason (reduce-family intents stamped by protective monitor). */
	exitReason?: ExitReasonEnum;
}
