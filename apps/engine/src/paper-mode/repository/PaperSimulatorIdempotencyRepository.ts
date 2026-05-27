import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';

import { PaperSimulatorIdempotencyEntity } from '../entity/PaperSimulatorIdempotencyEntity';
import { PaperSimulatorIdempotencyDuplicateException } from '../exception/PaperSimulatorIdempotencyDuplicateException';

// Replay-determinism ledger repository (ADR 0032 §D3).
//
// `findByKey` is the simulator's pre-roll lookup: if a row exists for the
// composite `(event_id, order_intent_id, version_namespace)` key, the
// simulator returns the persisted fill verbatim instead of re-rolling
// (numerically equivalent on replay per D15).
//
// `insertNew` is insert-only — catches the Postgres UNIQUE-violation error
// (SQLSTATE 23505) raised by the composite UNIQUE constraint and rethrows
// as a typed domain exception so concurrent-writer races surface as a
// distinguishable failure class (D3 — the simulator must be able to detect
// "another caller raced me on the same key" without parsing raw PG errors).

const POSTGRES_UNIQUE_VIOLATION_SQLSTATE = '23505';

interface IIdempotencyKey {
    readonly eventId: string;
    readonly orderIntentId: string;
    readonly versionNamespace: string;
}

interface IInsertIdempotencyParams extends IIdempotencyKey {
    readonly simulatedFillId: string;
    readonly simulatedFillPayload: Record<string, unknown>;
}

@Injectable()
export class PaperSimulatorIdempotencyRepository {
    constructor(@InjectRepository(PaperSimulatorIdempotencyEntity) private readonly repository: Repository<PaperSimulatorIdempotencyEntity>) {}

    private scope(manager?: EntityManager): Repository<PaperSimulatorIdempotencyEntity> {
        return manager === undefined ? this.repository : manager.getRepository(PaperSimulatorIdempotencyEntity);
    }

    async findByKey(key: IIdempotencyKey, manager?: EntityManager): Promise<PaperSimulatorIdempotencyEntity | null> {
        return this.scope(manager)
            .createQueryBuilder('i')
            .where('i.eventId = :eventId', { eventId: key.eventId })
            .andWhere('i.orderIntentId = :orderIntentId', { orderIntentId: key.orderIntentId })
            .andWhere('i.versionNamespace = :versionNamespace', { versionNamespace: key.versionNamespace })
            .getOne();
    }

    async insertNew(params: IInsertIdempotencyParams, manager?: EntityManager): Promise<PaperSimulatorIdempotencyEntity> {
        const scope = this.scope(manager);
        const entity = scope.create({
            eventId: params.eventId,
            orderIntentId: params.orderIntentId,
            versionNamespace: params.versionNamespace,
            simulatedFillId: params.simulatedFillId,
            simulatedFillPayload: params.simulatedFillPayload,
        });

        try {
            return await scope.save(entity);
        } catch (cause) {
            if (this.isUniqueViolation(cause)) {
                throw new PaperSimulatorIdempotencyDuplicateException(
                    { eventId: params.eventId, orderIntentId: params.orderIntentId, versionNamespace: params.versionNamespace },
                    cause,
                );
            }

            throw cause;
        }
    }

    private isUniqueViolation(cause: unknown): boolean {
        if (!(cause instanceof QueryFailedError)) {
            return false;
        }

        // `code` lives on the driver-error wrapped by QueryFailedError; pg
        // exposes the SQLSTATE there. Reading via an indexed property keeps
        // the test compatible across pg driver versions without committing
        // to a private DriverError type.
        const driverError = (cause as QueryFailedError & { driverError?: { code?: string } }).driverError;

        return driverError?.code === POSTGRES_UNIQUE_VIOLATION_SQLSTATE;
    }
}
