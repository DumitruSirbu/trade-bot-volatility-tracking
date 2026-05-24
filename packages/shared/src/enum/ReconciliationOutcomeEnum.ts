export enum ReconciliationOutcomeEnum {
	CONFIRMED_PRESENT = 'confirmed_present',
	RECONCILED_MISSING = 'reconciled_missing',
	ADOPTED_FOREIGN = 'adopted_foreign',
	QTY_ADJUSTED = 'qty_adjusted',
	PROTECTIVE_REPAIRED = 'protective_repaired',
	PROTECTIVE_FALLBACK = 'protective_fallback',
	INTENT_TERMINAL = 'intent_terminal',
	UNRESOLVED_TTL = 'unresolved_ttl',
	FLATTENED = 'flattened',
}
