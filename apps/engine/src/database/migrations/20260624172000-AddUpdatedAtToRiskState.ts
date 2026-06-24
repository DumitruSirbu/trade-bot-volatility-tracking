import { MigrationInterface, QueryRunner } from 'typeorm';

// M45 D2 — newer-wins upsert guard on `risk_state`. The table's upsert paths
// (full-row `upsertDay`, column-scoped `upsertAccountingForDay`, and the D3a
// halt-only upsert) were last-write-wins: a halt write copying a stale accounting
// snapshot could clobber a fresher accounting write (and vice-versa). A monotonic
// `updated_at` lets each upsert apply only when it is at least as fresh as the
// stored row (`ON CONFLICT ... WHERE risk_state.updated_at <= EXCLUDED.updated_at`).
//
// NOT NULL DEFAULT now() backfills existing rows to their migration-run instant —
// safe because the guard compares against EXCLUDED.updated_at (a fresh NOW() on every
// future upsert), so the first post-migration write always wins over the seeded value.
// Reversible (drop in down()).

export class AddUpdatedAtToRiskState20260624172000 implements MigrationInterface {
    name = 'AddUpdatedAtToRiskState20260624172000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "risk_state" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now()`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "risk_state" DROP COLUMN IF EXISTS "updated_at"`);
    }
}
