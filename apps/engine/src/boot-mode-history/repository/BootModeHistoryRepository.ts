import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { SUBKEY_BYTES } from '../const';
import { BootModeHistoryEntity } from '../entity/BootModeHistoryEntity';
import { BootModeHistoryRowKindEnum } from '../enum';

// Repository for the boot_mode_history append-only HMAC chain (ADR 0032 §D6).
// The chain integrity check walks `findOrderedAll()` from row 0; new rows are
// appended via `appendInTransaction()` which is called by `BootModeChainService`
// inside a TypeORM transaction so the BOOT row + any associated TRANSITION +
// rotation rows commit atomically (D6 step 6 i).
//
// `id: number` adapter (BaseRepository compatibility): the entity's PK is a
// uuid string, so we sidestep findById here — boot_mode_history is queried by
// seq order, never by surrogate id.
//
// Two-phase append (INSERT placeholder + UPDATE) is preferred over a single
// CTE/RETURNING statement here for TypeORM ergonomics: the codec needs the
// fully-hydrated entity (including the DB-assigned `seq` and `bootedAt`) to
// compute the canonical signed payload, and TypeORM's QueryBuilder does not
// surface RETURNING values cleanly without dropping to raw SQL per dialect.
// The two statements share the same transaction so an observer outside the
// transaction never sees the placeholder row. Functionally equivalent to a
// CTE/RETURNING form; chosen for the simpler call-site.

@Injectable()
export class BootModeHistoryRepository {
    constructor(@InjectRepository(BootModeHistoryEntity) private readonly repository: Repository<BootModeHistoryEntity>) {}

    // Returns every row sorted by seq ascending. The chain integrity walk
    // (D6 step 2) consumes this sequence and verifies each row's HMAC is
    // computed over its signed payload concatenated with the previous row's
    // HMAC. Loaded fully because the chain spans the soak's lifetime (one
    // row per boot + one per transition + one per rotation witness); even
    // multi-year operation produces <10k rows.
    async findOrderedAll(manager?: EntityManager): Promise<readonly BootModeHistoryEntity[]> {
        const repo = manager === undefined ? this.repository : manager.getRepository(BootModeHistoryEntity);

        return repo.createQueryBuilder('h').orderBy('h.seq', 'ASC').getMany();
    }

    async findTip(manager?: EntityManager): Promise<BootModeHistoryEntity | null> {
        const repo = manager === undefined ? this.repository : manager.getRepository(BootModeHistoryEntity);

        return repo.createQueryBuilder('h').orderBy('h.seq', 'DESC').limit(1).getOne();
    }

    async appendInTransaction(
        manager: EntityManager,
        params: {
            rowKind: BootModeHistoryRowKindEnum;
            exchangeEnv: string;
            fromEnv: string | null;
            toEnv: string | null;
            prevRowHash: Buffer | null;
            computeHmac: (signedPayload: {
                seq: string;
                bootedAt: Date;
                rowKind: string;
                exchangeEnv: string;
                fromEnv: string | null;
                toEnv: string | null;
                prevRowHash: Buffer | null;
            }) => Buffer;
        },
    ): Promise<BootModeHistoryEntity> {
        // Placeholder is full HMAC width (32 bytes for HMAC-SHA256) so the
        // initial INSERT exercises the same byte budget as the final UPDATE —
        // any column-width regression surfaces on the placeholder write
        // rather than on the (transient) overwrite.
        //
        // M11a R4 BLOCKER fix: the `ck_boot_mode_history_this_row_hmac_nonzero`
        // CHECK constraint added by migration 20260614000000 rejects the
        // all-zero buffer at INSERT time (PG CHECKs are NOT deferrable). Fill
        // with 0xFF so the CHECK accepts the placeholder; the UPDATE that
        // follows in the same transaction replaces it with the real HMAC
        // before commit. Same sentinel pattern PaperStateAuditRepository uses.
        // CRITICAL BUG FIX (M11a post-R4 smoke): the prior `manager.save()` →
        // `persisted.seq` / `persisted.bootedAt` pattern was BROKEN because
        // TypeORM's `save()` does NOT refresh BIGSERIAL or DB-default columns
        // from the INSERT...RETURNING result. write-time `persisted.seq` was
        // `undefined`, so the HMAC was computed over `["seq", null]` while
        // the read-time verifier loaded the actual seq='1' and computed over
        // `["seq", "1"]` — different bytes → every boot after the first failed
        // chain-integrity verification. Engine could not survive a restart.
        //
        // Fix: use raw INSERT...RETURNING (same pattern PaperStateAuditRepository
        // already uses for this reason) so the DB-assigned seq and bootedAt
        // are captured atomically and bound into the HMAC within the same
        // transaction. Placeholder HMAC (0xff×32) passes the non-deferrable
        // ck_*_this_row_hmac_nonzero CHECK; the immediate UPDATE replaces it
        // with the real HMAC before commit.
        const placeholderHmac = Buffer.alloc(SUBKEY_BYTES, 0xff);
        const bootedAtMs = new Date(Math.floor(Date.now()));

        const inserted = await manager
            .createQueryBuilder()
            .insert()
            .into(BootModeHistoryEntity)
            .values({
                rowKind: params.rowKind,
                bootedAt: bootedAtMs,
                exchangeEnv: params.exchangeEnv,
                fromEnv: params.fromEnv,
                toEnv: params.toEnv,
                prevRowHash: params.prevRowHash,
                thisRowHmac: placeholderHmac,
            })
            .returning(['boot_mode_history_id', 'seq', 'booted_at'])
            .execute();

        const raw = inserted.raw[0] as { boot_mode_history_id: string; seq: string; booted_at: Date };
        const seq = String(raw.seq);
        const bootedAt = raw.booted_at instanceof Date ? raw.booted_at : new Date(raw.booted_at);

        const hmac = params.computeHmac({
            seq,
            bootedAt,
            rowKind: params.rowKind,
            exchangeEnv: params.exchangeEnv,
            fromEnv: params.fromEnv,
            toEnv: params.toEnv,
            prevRowHash: params.prevRowHash,
        });

        await manager
            .createQueryBuilder()
            .update(BootModeHistoryEntity)
            .set({ thisRowHmac: hmac })
            .where('boot_mode_history_id = :id', { id: raw.boot_mode_history_id })
            .execute();

        const persisted = manager.create(BootModeHistoryEntity, {
            id: raw.boot_mode_history_id,
            seq,
            bootedAt,
            rowKind: params.rowKind,
            exchangeEnv: params.exchangeEnv,
            fromEnv: params.fromEnv,
            toEnv: params.toEnv,
            prevRowHash: params.prevRowHash,
            thisRowHmac: hmac,
        });

        return persisted;
    }
}
