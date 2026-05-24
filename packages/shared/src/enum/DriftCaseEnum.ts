export enum DriftCaseEnum {
	EXCHANGE_NOT_IN_DB = 'exchange_not_in_db',
	DB_OPEN_NOT_ON_EXCHANGE = 'db_open_not_on_exchange',
	QTY_MISMATCH = 'qty_mismatch',
	SIDE_MISMATCH = 'side_mismatch',
	PROTECTIVE_ORDER_DRIFT = 'protective_order_drift',
	UNKNOWN_INTENT_OUTCOME = 'unknown_intent_outcome',
}
