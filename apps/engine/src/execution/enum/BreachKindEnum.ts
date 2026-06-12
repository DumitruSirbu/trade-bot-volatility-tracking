// The local-monitor breach classification (ADR 0011 §3). Engine-internal — the pure breach
// evaluator returns one of these (or null for "no breach") and the handler maps it to the
// corresponding `ExitReasonEnum` on the synthesised CLOSE intent. The string values intentionally
// mirror `ExitReasonEnum.STOP_LOSS` / `ExitReasonEnum.TAKE_PROFIT` so the breach kind and the exit
// reason stay byte-equivalent across the close-intent eventId and the persisted transaction row.
export enum BreachKindEnum {
    STOP_LOSS = 'stop_loss',
    TAKE_PROFIT = 'take_profit',
}
