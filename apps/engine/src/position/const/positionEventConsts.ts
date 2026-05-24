// Domain event name for PositionService.transition emissions (ADR 0009 §4 / §6).
// Listed in const/ per the conventions: no inline string literals for event names.
export const POSITION_STATE_TRANSITIONED_EVENT = 'position.state.transitioned';

// M6 W4b telemetry event for qty mutations. Engine-internal — analogous to
// POSITION_STATE_TRANSITIONED_EVENT but for the qty axis. W5+ may extend with
// realized-pnl deltas. R1.3.3 mechanical move from PositionService.ts.
export const POSITION_QTY_ADJUSTED_EVENT = 'position.qty.adjusted';
