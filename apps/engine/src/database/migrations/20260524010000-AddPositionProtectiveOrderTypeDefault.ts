import { MigrationInterface, QueryRunner } from 'typeorm';

// M5 (ADR 0008 §5): make positions.protective_order_type NOT NULL with default 'local_fallback'
// so the "always-protected" invariant is structural — no open position can ever carry NULL.
// Local fallback is the safe default: the in-memory monitor is armed at row creation and is
// only superseded by 'exchange_side' after BOTH protective orders ack at the exchange (§1).
//
// Also adds a UNIQUE constraint on transactions.client_order_id (ADR 0006 §5): every retry,
// timeout-recovery, or replay of the same (eventId, slot, action, attemptN) must yield at
// most one transactions row. Combined with the existing exchange_order_id unique constraint,
// this gives idempotency on both the bot-controlled key and the exchange-assigned key.
//
// Backfill: existing rows are nulled to 'local_fallback' before NOT NULL is enforced. No
// open positions exist yet on testnet/live (M5 is the first writer), so the backfill is a
// no-op in practice — but the migration is correct against any test-fixture residue.
//
// Reversible: down() drops the default + NOT NULL and drops the unique constraint.

export class AddPositionProtectiveOrderTypeDefault20260524010000 implements MigrationInterface {
    name = 'AddPositionProtectiveOrderTypeDefault20260524010000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "positions" SET "protective_order_type" = 'local_fallback' WHERE "protective_order_type" IS NULL`);
        await queryRunner.query(`ALTER TABLE "positions" ALTER COLUMN "protective_order_type" SET DEFAULT 'local_fallback'`);
        await queryRunner.query(`ALTER TABLE "positions" ALTER COLUMN "protective_order_type" SET NOT NULL`);

        await queryRunner.query(`ALTER TABLE "transactions" ADD CONSTRAINT "uq_transactions_client_order_id" UNIQUE ("client_order_id")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "transactions" DROP CONSTRAINT "uq_transactions_client_order_id"`);

        await queryRunner.query(`ALTER TABLE "positions" ALTER COLUMN "protective_order_type" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "positions" ALTER COLUMN "protective_order_type" DROP DEFAULT`);
    }
}
