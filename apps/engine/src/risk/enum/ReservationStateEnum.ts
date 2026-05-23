// Lifecycle states of an in-flight exposure reservation (ADR 0004 §3). Engine-internal:
// the ledger is transient in-memory state, never persisted nor sent across the wire, so it
// does NOT belong in packages/shared (that holds only persisted vocabulary). PENDING and
// CONFIRMED count toward caps; RELEASED and EXPIRED do not.
export enum ReservationStateEnum {
    PENDING = 'pending',
    CONFIRMED = 'confirmed',
    RELEASED = 'released',
    EXPIRED = 'expired',
}
