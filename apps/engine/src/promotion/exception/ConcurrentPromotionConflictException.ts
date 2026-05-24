import { DomainException } from '../../common/exception';

// Raised by PromotionService when two concurrent promote / reactivate transactions
// race for the same `name` and the partial unique index
// `uq_strategy_versions_active_per_name` (M8 W2) rejects the loser at COMMIT time
// with PG SQLSTATE 23505. The DB index is the ultimate one-active-per-name fence
// (ADR 0016 §2.2); the application-layer SERIALIZABLE TX + SELECT FOR UPDATE
// already serialises the common path, but a unique-violation can still surface if
// two transactions slipped past the row lock window (different rows / different
// candidate IDs) and both tried to flip to ACTIVE.
//
// Catching the raw QueryFailedError here lets callers (CLI, tests) match on a
// stable domain code (`PROMOTION_CONCURRENT_CONFLICT`) instead of grepping
// driver error text — which would leak TypeORM/pg implementation details across
// the module boundary (code-conventions.md §"Error Handling": wrap third-party
// errors as domain exceptions).
export class ConcurrentPromotionConflictException extends DomainException {
    constructor(name: string, versionId: number, cause?: unknown) {
        super(
            'PROMOTION_CONCURRENT_CONFLICT',
            `Concurrent promotion conflict for name='${name}' versionId=${versionId}: another active row exists (uq_strategy_versions_active_per_name).`,
            cause,
        );
    }
}
