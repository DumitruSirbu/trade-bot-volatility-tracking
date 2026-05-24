import { MigrationInterface, QueryRunner } from 'typeorm';

// M6 W1 (ADR 0009 / 0012 / 0014 / 0010 §1a): land the schema columns the position
// state machine, funding/PnL split, and crash-recovery boot pipeline read from.
//
//   - positions.state          — PositionStateEnum string; NOT NULL DEFAULT 'open' so
//                                pre-M6 rows back-fill to OPEN (the only legal pre-M6
//                                non-CLOSED state). Coexists with positions.status for
//                                the M6 milestone window; status is deprecated alias and
//                                will be removed in M7. (ADR 0009 §1)
//   - positions.stop_loss_price    NUMERIC(38,18) NULL — needed for boot-time monitor
//                                re-arm (ADR 0011 §7 / ADR 0014 §4c).
//   - positions.take_profit_price  NUMERIC(38,18) NULL — same.
//   - transactions.cashflow    NUMERIC(38,8) NOT NULL DEFAULT 0 — funding/realized
//                                cashflow aggregate target (ADR 0012 §1). Existing
//                                rows back-fill to 0 (no funding rows existed pre-M6).
//   - account_snapshots.unrealized_pnl_funding NUMERIC(38,8) NOT NULL DEFAULT 0 — PnL
//                                split (ADR 0012 §6).
//   - account_snapshots.unrealized_pnl_price   NUMERIC(38,8) NOT NULL DEFAULT 0 — same.
//   - strategy_versions sentinel row (name='manual_adopted', version=0) — foreign
//                                adopted positions reference this row so the FK can stay
//                                NOT NULL without relaxing the column. (ADR 0010 §1a)
//
// Fully reversible. down() drops in reverse order of up() (sentinel row → snapshot
// columns → transactions.cashflow → positions.take_profit_price/stop_loss_price → state).

const SENTINEL_STRATEGY_NAME = 'manual_adopted';

export class AddPositionStateMachineColumns20260525010000 implements MigrationInterface {
    name = 'AddPositionStateMachineColumns20260525010000';

    async up(queryRunner: QueryRunner): Promise<void> {
        // positions.state — backfilled to 'open' for any pre-existing row.
        await queryRunner.query(`ALTER TABLE "positions" ADD COLUMN "state" varchar NOT NULL DEFAULT 'open'`);

        // positions.stop_loss_price / take_profit_price — nullable, no backfill.
        await queryRunner.query(`ALTER TABLE "positions" ADD COLUMN "stop_loss_price" numeric(38, 18)`);
        await queryRunner.query(`ALTER TABLE "positions" ADD COLUMN "take_profit_price" numeric(38, 18)`);

        // transactions.cashflow — NOT NULL DEFAULT 0; pre-M6 rows back-fill to 0.
        await queryRunner.query(`ALTER TABLE "transactions" ADD COLUMN "cashflow" numeric(38, 8) NOT NULL DEFAULT 0`);

        // account_snapshots PnL split columns — NOT NULL DEFAULT 0; pre-M6 rows back-fill
        // to 0 (no funding accrued before M6 introduced funding ingestion).
        await queryRunner.query(`ALTER TABLE "account_snapshots" ADD COLUMN "unrealized_pnl_funding" numeric(38, 8) NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "account_snapshots" ADD COLUMN "unrealized_pnl_price" numeric(38, 8) NOT NULL DEFAULT 0`);

        // Sentinel strategy_versions row so adopted-foreign positions have a non-null FK
        // target (ADR 0010 §1a). Idempotent on (name, version).
        await queryRunner.query(
            `INSERT INTO "strategy_versions" ("name", "version", "direction", "params", "status")
             VALUES ($1, 0, 'mean_reversion', '{}'::jsonb, 'draft')
             ON CONFLICT ("name", "version") DO NOTHING`,
            [SENTINEL_STRATEGY_NAME],
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "strategy_versions" WHERE "name" = $1 AND "version" = 0`, [SENTINEL_STRATEGY_NAME]);

        await queryRunner.query(`ALTER TABLE "account_snapshots" DROP COLUMN "unrealized_pnl_price"`);
        await queryRunner.query(`ALTER TABLE "account_snapshots" DROP COLUMN "unrealized_pnl_funding"`);

        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "cashflow"`);

        await queryRunner.query(`ALTER TABLE "positions" DROP COLUMN "take_profit_price"`);
        await queryRunner.query(`ALTER TABLE "positions" DROP COLUMN "stop_loss_price"`);
        await queryRunner.query(`ALTER TABLE "positions" DROP COLUMN "state"`);
    }
}
