import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { SUBKEY_BYTES } from '../const';
import { BootModeChainRotationEntity } from '../entity/BootModeChainRotationEntity';

// Repository for boot_mode_chain_rotations (ADR 0032 §D7). Same two-phase
// append-in-transaction pattern as BootModeHistoryRepository so the row's
// HMAC binds the assigned `seq`. See the sibling repository for the
// CTE-vs-two-phase trade-off note.

@Injectable()
export class BootModeChainRotationRepository {
    constructor(@InjectRepository(BootModeChainRotationEntity) private readonly repository: Repository<BootModeChainRotationEntity>) {}

    async findOrderedAll(manager?: EntityManager): Promise<readonly BootModeChainRotationEntity[]> {
        const repo = manager === undefined ? this.repository : manager.getRepository(BootModeChainRotationEntity);

        return repo.createQueryBuilder('r').orderBy('r.seq', 'ASC').getMany();
    }

    async findTip(manager?: EntityManager): Promise<BootModeChainRotationEntity | null> {
        const repo = manager === undefined ? this.repository : manager.getRepository(BootModeChainRotationEntity);

        return repo.createQueryBuilder('r').orderBy('r.seq', 'DESC').limit(1).getOne();
    }

    async appendInTransaction(
        manager: EntityManager,
        params: {
            fromEnv: string;
            toEnv: string;
            preTipHash: Buffer;
            transitionTokenHash: Buffer;
            prevRowHash: Buffer | null;
            computeHmac: (signedPayload: {
                seq: string;
                rotatedAt: Date;
                fromEnv: string;
                toEnv: string;
                preTipHash: Buffer;
                transitionTokenHash: Buffer;
                prevRowHash: Buffer | null;
            }) => Buffer;
        },
    ): Promise<BootModeChainRotationEntity> {
        // Full HMAC-SHA256 width (32 bytes) for placeholder parity with the
        // final UPDATE — same rationale as BootModeHistoryRepository.
        //
        // M11a R4 BLOCKER fix: fill with 0xFF so the
        // `ck_boot_mode_chain_rotations_this_row_hmac_nonzero` CHECK
        // (migration 20260614000000, non-deferrable) accepts the placeholder.
        // The UPDATE that follows in the same transaction overwrites it with
        // the real HMAC before commit.
        // Same critical bug fix as BootModeHistoryRepository: use raw
        // INSERT...RETURNING so the DB-assigned `seq` (BIGSERIAL) is captured
        // before HMAC computation. `manager.save()` does NOT refresh these
        // columns; using it would write the HMAC over `seq=undefined` while
        // the verifier reads back `seq='1'` — verification fails on every
        // subsequent boot.
        const placeholderHmac = Buffer.alloc(SUBKEY_BYTES, 0xff);
        const rotatedAtMs = new Date(Math.floor(Date.now()));

        const inserted = await manager
            .createQueryBuilder()
            .insert()
            .into(BootModeChainRotationEntity)
            .values({
                rotatedAt: rotatedAtMs,
                fromEnv: params.fromEnv,
                toEnv: params.toEnv,
                preTipHash: params.preTipHash,
                transitionTokenHash: params.transitionTokenHash,
                prevRowHash: params.prevRowHash,
                thisRowHmac: placeholderHmac,
            })
            .returning(['boot_mode_chain_rotation_id', 'seq', 'rotated_at'])
            .execute();

        const raw = inserted.raw[0] as { boot_mode_chain_rotation_id: string; seq: string; rotated_at: Date };
        const seq = String(raw.seq);
        const rotatedAt = raw.rotated_at instanceof Date ? raw.rotated_at : new Date(raw.rotated_at);

        const hmac = params.computeHmac({
            seq,
            rotatedAt,
            fromEnv: params.fromEnv,
            toEnv: params.toEnv,
            preTipHash: params.preTipHash,
            transitionTokenHash: params.transitionTokenHash,
            prevRowHash: params.prevRowHash,
        });

        await manager
            .createQueryBuilder()
            .update(BootModeChainRotationEntity)
            .set({ thisRowHmac: hmac })
            .where('boot_mode_chain_rotation_id = :id', { id: raw.boot_mode_chain_rotation_id })
            .execute();

        const persisted = manager.create(BootModeChainRotationEntity, {
            id: raw.boot_mode_chain_rotation_id,
            seq,
            rotatedAt,
            fromEnv: params.fromEnv,
            toEnv: params.toEnv,
            preTipHash: params.preTipHash,
            transitionTokenHash: params.transitionTokenHash,
            prevRowHash: params.prevRowHash,
            thisRowHmac: hmac,
        });

        return persisted;
    }
}
