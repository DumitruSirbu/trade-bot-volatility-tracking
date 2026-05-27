// Raised by `PaperSimulatorIdempotencyRepository.insertNew` when the composite
// UNIQUE constraint `(event_id, order_intent_id, version_namespace)` fires
// (ADR 0032 §D3). Lets callers (R2b wave-B simulator service) distinguish
// "another concurrent writer raced me on the same key" from a generic DB
// error without parsing raw Postgres SQLSTATE values at the service layer.

interface IPaperIdempotencyKey {
    readonly eventId: string;
    readonly orderIntentId: string;
    readonly versionNamespace: string;
}

export class PaperSimulatorIdempotencyDuplicateException extends Error {
    readonly eventId: string;

    readonly orderIntentId: string;

    readonly versionNamespace: string;

    constructor(key: IPaperIdempotencyKey, cause?: unknown) {
        super(
            `paper_simulator_idempotency duplicate key: event_id=${key.eventId}, order_intent_id=${key.orderIntentId}, version_namespace=${key.versionNamespace}`,
        );
        this.name = 'PaperSimulatorIdempotencyDuplicateException';
        this.eventId = key.eventId;
        this.orderIntentId = key.orderIntentId;
        this.versionNamespace = key.versionNamespace;

        if (cause !== undefined) {
            // Preserve the driver error for forensic logging without forcing
            // callers to type-narrow it.
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}
