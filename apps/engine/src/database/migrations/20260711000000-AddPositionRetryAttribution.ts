import { MigrationInterface, QueryRunner } from 'typeorm';

// M52 D3 (ADR 0051 §6) — retry slot-recovery attribution on the position row. Adds two nullable
// columns to `positions`:
//   - `is_retry_entry` boolean — TRUE only for a D2 same-coin retry entry; NULL for every attempt-1
//     open, VWAP/legacy open, and pre-existing row.
//   - `force_close_atr_units_drift` numeric(18,8) — the ADR 0045 guard's measured anchor drift in ATR
//     units, recorded at force_close time; NULL on rows the guard never force-closed.
//
// Nullable, no backfill: NULL is the correct and permanent value for every pre-existing row (mirrors
// the M50c AddPositionTriggerSource precedent). A NOT NULL DEFAULT would falsely assert those rows
// were attempt-1 retries / drift-measured. The paper-soak analysis reads is_retry_entry to separate
// retry vs attempt-1 entries and force_close_atr_units_drift to calibrate the drift threshold.
// Reversible.

export class AddPositionRetryAttribution20260711000000 implements MigrationInterface {
    name = 'AddPositionRetryAttribution20260711000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "positions" ADD COLUMN "is_retry_entry" boolean`);
        await queryRunner.query(`ALTER TABLE "positions" ADD COLUMN "force_close_atr_units_drift" numeric(18,8)`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "positions" DROP COLUMN IF EXISTS "force_close_atr_units_drift"`);
        await queryRunner.query(`ALTER TABLE "positions" DROP COLUMN IF EXISTS "is_retry_entry"`);
    }
}
