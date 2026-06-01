import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W5a (ADR 0029 §2.1.2 follow-up). The W4 logic reviewer flagged that
// `shadow_decisions` did not persist the per-open `qty`, `stop_loss`, or
// `take_profit` values — so the cold-restart ledger rebuild had no choice but
// to re-derive qty from the persisted entry price, producing a zero stop
// distance and a 0-qty replayed open.
//
// All three columns are stored as `text` (decimal-as-string) consistent with
// the rest of the shadow-decision money fields and with the `IVirtualOpenInput`
// contract on the shared interface. Nullable because skip / rejected rows have
// no qty/stop/TP, and rows persisted before this migration have no values.
// Reversible.

export class AddQtyStopTpToShadowDecisions20260621000001 implements MigrationInterface {
    name = 'AddQtyStopTpToShadowDecisions20260621000001';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "shadow_decisions" ADD COLUMN "qty" text`);
        await queryRunner.query(`ALTER TABLE "shadow_decisions" ADD COLUMN "stop_loss" text`);
        await queryRunner.query(`ALTER TABLE "shadow_decisions" ADD COLUMN "take_profit" text`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "shadow_decisions" DROP COLUMN IF EXISTS "take_profit"`);
        await queryRunner.query(`ALTER TABLE "shadow_decisions" DROP COLUMN IF EXISTS "stop_loss"`);
        await queryRunner.query(`ALTER TABLE "shadow_decisions" DROP COLUMN IF EXISTS "qty"`);
    }
}
