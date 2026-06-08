import { MigrationInterface, QueryRunner } from 'typeorm';

// M27 Dispatch A — observability-only (ADR M27 trade-geometry capture). The live
// `decisions` table recorded the action/reason but not the trade geometry behind
// each decision (side, stop, take-profit, qty, notional, leverage) nor the
// specific halt leg that produced a halted skip. These eight additive, nullable
// columns let live decisions be audited and compared against shadow geometry
// without re-deriving from market_snapshot. No gate behaviour change.
//
// Money fields are stored as `text` (decimal-as-string), consistent with the
// shadow_decisions money columns and the rest of the engine's decimal-as-text
// convention. `gate_allowed` is nullable boolean (legacy / skip / halted rows
// have no gate evaluation). `halt_reason_detail` carries the specific halt leg
// string (e.g. "market_stress:breadth"). All columns are nullable with no
// DEFAULT and no backfill — rows persisted before this migration keep NULL.
// Reversible.

export class AddTradeGeometryToDecisions20260708000000 implements MigrationInterface {
    name = 'AddTradeGeometryToDecisions20260708000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "gate_allowed" boolean`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "trade_side" varchar`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "stop_loss" text`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "take_profit" text`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "qty" text`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "notional" text`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "leverage" text`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD COLUMN "halt_reason_detail" varchar`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "halt_reason_detail"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "leverage"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "notional"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "qty"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "take_profit"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "stop_loss"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "trade_side"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "gate_allowed"`);
    }
}
