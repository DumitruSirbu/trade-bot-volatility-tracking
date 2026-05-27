import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Persistence projection of `paper_simulator_idempotency` (ADR 0032 §D3) —
// the replay-determinism ledger. A single market event can produce multiple
// order intents across active (v1 PAPER) and shadow (v2/v3) versions;
// event-level cursoring is too coarse and would collide. The composite
// UNIQUE `(event_id, order_intent_id, version_namespace)` is the load-bearing
// constraint — collision-free by construction.
//
// On restart, the simulator looks up by this key before re-rolling; if a row
// already exists, the persisted `simulated_fill_payload` is returned verbatim
// (numerically equivalent per D15's whitelisted-tolerance rule).
//
// Retention floor per D3 + D16 retention table: soak duration + 30 days. The
// retention scheduler is a follow-up; R2b only persists.
@Entity({ name: 'paper_simulator_idempotency', synchronize: false })
@Index('idx_paper_simulator_idempotency_event_id', ['eventId'])
@Index('uq_paper_simulator_idempotency_key', ['eventId', 'orderIntentId', 'versionNamespace'], { unique: true })
export class PaperSimulatorIdempotencyEntity {
    @PrimaryGeneratedColumn('uuid', { name: 'paper_simulator_idempotency_id' })
    id!: string;

    @Column({ name: 'event_id', type: 'text' })
    eventId!: string;

    // The simulator's per-intent id; matches the M5/M7 idempotency-key
    // discipline.
    @Column({ name: 'order_intent_id', type: 'text' })
    orderIntentId!: string;

    // e.g. 'v1.PAPER.active' or 'v2.shadow' per D17. The combination with
    // `(event_id, order_intent_id)` defeats the cross-version collision the
    // event-cursor approach would have suffered.
    @Column({ name: 'version_namespace', type: 'text' })
    versionNamespace!: string;

    // The produced fill's id (separate from the JSON payload so a future
    // dedicated fill table can be joined cheaply if one materialises).
    @Column({ name: 'simulated_fill_id', type: 'text' })
    simulatedFillId!: string;

    // The full fill payload. The shape is the M7 `ISimulatedFill`-equivalent
    // record (R2b wave B services-layer ADR-pinned); on replay this payload
    // is returned verbatim. JSON key/sub-field ordering is permitted to vary
    // per D15's "numerical, not byte-for-byte" equivalence rule — the
    // equivalence test in M7 owns the tolerance whitelist.
    @Column({ name: 'simulated_fill_payload', type: 'jsonb' })
    simulatedFillPayload!: Record<string, unknown>;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
