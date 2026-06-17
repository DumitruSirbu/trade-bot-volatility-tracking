import { type ISimulatedFill } from '@bot/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryFailedError, Repository } from 'typeorm';

import { POSTGRES_UNIQUE_VIOLATION_SQLSTATE } from '../../common/const';
import { BaseRepository } from '../../common/repository/BaseRepository';
import { ShadowDecisionEntity } from '../entity';

// M11a W0.5 (ADR 0029 §2.3.2). Persists shadow decisions for non-executed
// versions (v0/v2/v3) over the same event tape v1 sees. The write path is
// idempotent on UNIQUE(shadow_version, event_id) — a replay that re-emits
// the same (version, event) catches the unique-violation, logs a warn, and
// returns the existing row (mirrors `TransactionRepository.recordTerminal`
// idempotency pattern). The W2 orchestrator does NOT depend on these rows
// for in-loop decision-making; they exist for (a) the M8 comparison metric
// inputs and (b) the cold-restart ledger rebuild in `findRowsForLedgerRebuild`.
@Injectable()
export class ShadowDecisionRepository extends BaseRepository<ShadowDecisionEntity> {
    private readonly logger = new Logger(ShadowDecisionRepository.name);

    constructor(@InjectRepository(ShadowDecisionEntity) repository: Repository<ShadowDecisionEntity>) {
        super(repository);
    }

    // Idempotent insert keyed on (shadowVersion, eventId). On unique-violation
    // the existing row is fetched and returned so the caller still has a
    // stable reference (W2 will use the returned id for downstream wiring).
    async insertShadowDecision(row: DeepPartial<ShadowDecisionEntity>): Promise<ShadowDecisionEntity> {
        const entity = this.create(row);

        try {
            return await this.repository.save(entity);
        } catch (cause) {
            if (!this.isUniqueViolation(cause)) {
                throw cause;
            }

            const shadowVersion = row.shadowVersion ?? '?';
            const eventId = row.eventId ?? '?';
            this.logger.warn(`duplicate shadow_decision shadowVersion=${shadowVersion} eventId=${eventId} — idempotent no-op`);

            const existing = await this.repository.findOne({ where: { shadowVersion, eventId } });

            if (existing !== null) {
                return existing;
            }

            // Race: the conflicting row was deleted between the failed insert
            // and the lookup. Re-raise so the caller sees a non-silent failure.
            throw cause;
        }
    }

    // M39 W2: used by the deferred exit walk to upgrade a force_close fill in
    // the DB. Keyed on the UNIQUE(shadow_version, event_id) constraint so the
    // upgrade is a single UPDATE — no SELECT-then-UPDATE cycle. The in-memory
    // ledger is NOT touched (W1 already recorded the force_close close); only
    // the `simulated_fill` JSONB is rewritten so the analysis layer reads the
    // upgraded exit and the D3 gate improvement flows through automatically.
    async updateSimulatedFill(shadowVersion: string, eventId: string, fill: ISimulatedFill): Promise<void> {
        await this.repository.update({ shadowVersion, eventId }, { simulatedFill: fill });
    }

    // Per-version event-window read used by the soak's exit-criterion
    // evaluator. Ordered by event_id ascending so the ledger replay path can
    // walk events in the same order they were recorded. TypeORM's QueryBuilder
    // resolves entity properties (camelCase) to columns at compile time — the
    // `.where` clauses MUST reference entity property names, not DB column
    // names, otherwise filtering silently breaks (reviewer W4 HIGH).
    async findByShadowVersionSince(shadowVersion: string, sinceMs: number): Promise<ShadowDecisionEntity[]> {
        const sinceDate = new Date(sinceMs);

        return this.repository
            .createQueryBuilder('sd')
            .where('sd.shadowVersion = :shadowVersion', { shadowVersion })
            .andWhere('sd.createdAt >= :sinceDate', { sinceDate })
            .orderBy('sd.eventId', 'ASC')
            .getMany();
    }

    // Cold-restart ledger rebuild path (ADR 0029 §2.1.2). The virtual ledger
    // is in-memory; on engine restart W2 replays these rows in event_id order
    // (ADR 0029 cursor) so replay is deterministic when two events share a
    // creation second.
    async findRowsForLedgerRebuild(shadowVersion: string): Promise<ShadowDecisionEntity[]> {
        return this.repository.find({
            where: { shadowVersion },
            order: { eventId: 'ASC' },
        });
    }

    // Postgres SQLSTATE 23505 (`unique_violation`). SQLSTATE is more stable
    // than substring-matching the message text across pg / TypeORM versions
    // (matches the TransactionRepository / ControlAuditRepository pattern).
    private isUniqueViolation(cause: unknown): boolean {
        if (!(cause instanceof QueryFailedError)) {
            return false;
        }

        const driverError = (cause as QueryFailedError & { driverError?: { code?: string } }).driverError;

        return driverError?.code === POSTGRES_UNIQUE_VIOLATION_SQLSTATE;
    }
}
