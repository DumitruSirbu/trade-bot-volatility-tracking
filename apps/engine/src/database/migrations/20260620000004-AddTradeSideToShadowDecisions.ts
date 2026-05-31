import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a W2.1 (ADR 0029 §2.1.3). Forward-only addition of the `trade_side`
// column to `shadow_decisions` so the cold-restart ledger rebuild can replay
// historical opens with side fidelity (W3 intra-bar stop simulation needs
// side to evaluate SL/TP correctly).
//
// Nullable because skip / rejected rows have no side. The W2 orchestrator
// already passed `tradeSide` into `insertShadowDecision` but the column did
// not exist, so TypeORM silently dropped the field on persist; this migration
// + the matching `ShadowDecisionEntity.tradeSide` column closes the loop.
//
// No backfill needed: the W1 migration was applied to a fresh database in
// the M11a soak setup with no production shadow_decisions rows yet (verified
// at orchestrator dispatch). Reversible: down() drops the column.

export class AddTradeSideToShadowDecisions20260620000004 implements MigrationInterface {
    name = 'AddTradeSideToShadowDecisions20260620000004';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "shadow_decisions" ADD COLUMN "trade_side" text`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "shadow_decisions" DROP COLUMN IF EXISTS "trade_side"`);
    }
}
