import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { PAPER_STATE_AUDIT_SUBKEY_BYTES } from '../const';
import { PaperStateAuditEntity } from '../entity/PaperStateAuditEntity';
import { MutationKindEnum, SubjectKindEnum } from '../enum';

// Repository for the paper_state_audit append-only HMAC chain (ADR 0032 §D6
// / §D16). Append-only — services call `appendInTransaction` inside the same
// TypeORM transaction as the audited mutation so the three-table atomic write
// (audited table + paper_state_audit) commits or rolls back as one unit.
//
// `id: string` (uuid) keyed; does NOT extend BaseRepository<T>. Mirrors the
// pattern used by BootModeHistoryRepository (also uuid-keyed) — BaseRepository's
// numeric-id generic constraint does not apply here.
//
// Two-phase append (INSERT placeholder HMAC → UPDATE with HMAC computed over
// RETURNING `seq`) is the same shape BootModeHistoryRepository uses. The
// placeholder HMAC is the all-zero buffer; the DB's
// `ck_paper_state_audit_this_row_hmac_nonzero` CHECK would reject it
// permanently, so the UPDATE phase MUST fire before the transaction commits.
// A regression that skips the UPDATE turns the silent corruption into a hard
// reject rather than a tampered chain row.

interface IPaperStateAuditSignedPayload {
    seq: string;
    recordedAt: Date;
    mutationKind: string;
    subjectKind: string;
    subjectId: string;
    payloadHash: Buffer;
    prevRowHash: Buffer | null;
}

@Injectable()
export class PaperStateAuditRepository {
    constructor(@InjectRepository(PaperStateAuditEntity) private readonly repository: Repository<PaperStateAuditEntity>) {}

    private scope(manager?: EntityManager): Repository<PaperStateAuditEntity> {
        return manager === undefined ? this.repository : manager.getRepository(PaperStateAuditEntity);
    }

    // Returns every row sorted by seq ascending. The chain integrity walk
    // recomputes each row's HMAC under the per-purpose sub-key and asserts
    // `prev_row_hash` matches the prior row's HMAC.
    async findOrderedAll(manager?: EntityManager): Promise<readonly PaperStateAuditEntity[]> {
        return this.scope(manager).createQueryBuilder('a').orderBy('a.seq', 'ASC').getMany();
    }

    async findTip(manager?: EntityManager): Promise<PaperStateAuditEntity | null> {
        return this.scope(manager).createQueryBuilder('a').orderBy('a.seq', 'DESC').limit(1).getOne();
    }

    async findBySubject(subjectKind: SubjectKindEnum, subjectId: string, manager?: EntityManager): Promise<readonly PaperStateAuditEntity[]> {
        return this.scope(manager)
            .createQueryBuilder('a')
            .where('a.subjectKind = :subjectKind', { subjectKind })
            .andWhere('a.subjectId = :subjectId', { subjectId })
            .orderBy('a.seq', 'ASC')
            .getMany();
    }

    async appendInTransaction(
        manager: EntityManager,
        params: {
            mutationKind: MutationKindEnum;
            subjectKind: SubjectKindEnum;
            subjectId: string;
            payloadHash: Buffer;
            prevRowHash: Buffer | null;
            computeHmac: (signedPayload: IPaperStateAuditSignedPayload) => Buffer;
        },
    ): Promise<PaperStateAuditEntity> {
        // Placeholder is full HMAC width (32 bytes for HMAC-SHA256) so the
        // initial INSERT exercises the same byte budget as the final UPDATE
        // (any column-width regression surfaces on the placeholder write
        // rather than on the transient overwrite).
        const placeholderHmac = Buffer.alloc(PAPER_STATE_AUDIT_SUBKEY_BYTES);

        const draft = manager.create(PaperStateAuditEntity, {
            mutationKind: params.mutationKind,
            subjectKind: params.subjectKind,
            subjectId: params.subjectId,
            payloadHash: params.payloadHash,
            prevRowHash: params.prevRowHash,
            thisRowHmac: placeholderHmac,
        });

        // We cannot persist the placeholder HMAC directly because the DB CHECK
        // `ck_paper_state_audit_this_row_hmac_nonzero` rejects all-zero. The
        // BootModeHistoryRepository handles this by saving the placeholder
        // BEFORE Postgres validates the constraint (deferred), but our CHECK is
        // IMMEDIATE. Compute the HMAC first using a probe row that has the
        // DB-assigned `seq` + `recorded_at` — we get those by inserting via raw
        // SQL with RETURNING. This binds the seq into the HMAC atomically.
        const inserted = await manager
            .createQueryBuilder()
            .insert()
            .into(PaperStateAuditEntity)
            .values({
                mutationKind: draft.mutationKind,
                subjectKind: draft.subjectKind,
                subjectId: draft.subjectId,
                payloadHash: draft.payloadHash,
                prevRowHash: draft.prevRowHash,
                // Insert a non-zero sentinel (single 0xff byte repeated) so
                // the immediate-CHECK accepts the row; the UPDATE replaces
                // it with the real HMAC below. The sentinel bytes never
                // leave the transaction (the UPDATE runs before commit).
                thisRowHmac: Buffer.alloc(PAPER_STATE_AUDIT_SUBKEY_BYTES, 0xff),
            })
            .returning(['paper_state_audit_id', 'seq', 'recorded_at'])
            .execute();

        const raw = inserted.raw[0] as { paper_state_audit_id: string; seq: string; recorded_at: Date };

        const hmac = params.computeHmac({
            seq: String(raw.seq),
            recordedAt: raw.recorded_at instanceof Date ? raw.recorded_at : new Date(raw.recorded_at),
            mutationKind: draft.mutationKind,
            subjectKind: draft.subjectKind,
            subjectId: draft.subjectId,
            payloadHash: draft.payloadHash,
            prevRowHash: draft.prevRowHash,
        });

        await manager
            .createQueryBuilder()
            .update(PaperStateAuditEntity)
            .set({ thisRowHmac: hmac })
            .where('paper_state_audit_id = :id', { id: raw.paper_state_audit_id })
            .execute();

        // Re-hydrate the row so callers see the final persisted form. The
        // findOne occurs through the same `manager` so it reads the just-
        // written row even before commit.
        const persisted = await this.scope(manager).createQueryBuilder('a').where('a.id = :id', { id: raw.paper_state_audit_id }).getOne();

        if (persisted === null) {
            throw new Error(`paper_state_audit row vanished mid-transaction (id=${raw.paper_state_audit_id})`);
        }

        return persisted;
    }
}
