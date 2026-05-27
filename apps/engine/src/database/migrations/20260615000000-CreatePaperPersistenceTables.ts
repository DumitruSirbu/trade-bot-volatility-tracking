import { MigrationInterface, QueryRunner } from 'typeorm';

// M11a R2b wave A — creates the five PAPER persistence tables (ADR 0032 §5 +
// §3 D1 / D3 / D5 / D10 / D16 / D17).
//
// Tables:
//   - paper_account_state          — current open paper-position state
//                                     (entry price/size/side/leverage/opened_at,
//                                     keyed by client_order_id; D1, D16).
//                                     NO unrealised_pnl column (D16: derived).
//   - paper_account_state_history  — closed-trade ledger; sibling of the live
//                                     trade history. Source for the soak's
//                                     trade-count floor (D10).
//   - paper_account_state_meta     — non-secret derived metadata (seed labels,
//                                     simulator config hash, soak_start_id,
//                                     bootstrap_at_start_fingerprint). NEVER
//                                     stores secret material (D3 / D17).
//   - paper_account_snapshots      — audited equity snapshots feeding the
//                                     peak-equity / drawdown-abort path (D5,
//                                     D16). Sibling of `account_snapshots`.
//   - paper_simulator_idempotency  — replay-determinism ledger keyed by
//                                     (event_id, order_intent_id,
//                                     version_namespace) → simulated fill (D3).
//
// All five tables carry a `mode` column with a CHECK constraint pinning it to
// 'paper'. That sanity column is the structural defence against an accidental
// write of LIVE/TESTNET data through the PAPER schema; the M11a R2b wave-B
// services additionally never derive `mode` from runtime input.
//
// Close-reason value set on `paper_account_state_history.close_reason`:
//   'sl' | 'tp' | 'intra_bar_stop' | 'force_close' | 'operator_drain' | 'reconciliation_forced'
// Pinned via CHECK constraint because the existing `ExitReasonEnum` in
// `@bot/shared` does NOT carry `intra_bar_stop`, `operator_drain`, or
// `reconciliation_forced` value labels (M11a R2b wave-A architect-adjudication
// item — services wave introduces a `PaperCloseReasonEnum` or extends the
// shared enum via the orchestrator's shared-maintainer route). DB CHECK is
// today's safety teeth.
//
// `paper_simulator_idempotency` carries a composite UNIQUE constraint on
// (event_id, order_intent_id, version_namespace) — the collision-free key
// that defeats event-cursor reuse across active + shadow versions (D3).
//
// Reversible: down() drops indexes (reverse creation order) then tables.
// pgcrypto IS NOT dropped — it is provisioned by an earlier migration and
// shared with the boot-mode chain tables.

export class CreatePaperPersistenceTables20260615000000 implements MigrationInterface {
    name = 'CreatePaperPersistenceTables20260615000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

        // ---------- paper_account_state ----------
        await queryRunner.query(`
            CREATE TABLE "paper_account_state" (
                "paper_account_state_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "client_order_id" text NOT NULL,
                "symbol" text NOT NULL,
                "side" text NOT NULL,
                "entry_price" numeric(38, 18) NOT NULL,
                "size" numeric(38, 18) NOT NULL,
                "leverage" integer NOT NULL,
                "opened_at" timestamptz NOT NULL,
                "mode" text NOT NULL DEFAULT 'paper',
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_paper_account_state" PRIMARY KEY ("paper_account_state_id"),
                CONSTRAINT "uq_paper_account_state_client_order_id" UNIQUE ("client_order_id"),
                CONSTRAINT "ck_paper_account_state_side" CHECK ("side" IN ('long', 'short')),
                CONSTRAINT "ck_paper_account_state_mode" CHECK ("mode" = 'paper'),
                CONSTRAINT "ck_paper_account_state_size_positive" CHECK ("size" > 0),
                CONSTRAINT "ck_paper_account_state_leverage_positive" CHECK ("leverage" > 0)
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_paper_account_state_symbol" ON "paper_account_state" ("symbol")`);
        await queryRunner.query(`CREATE INDEX "idx_paper_account_state_opened_at" ON "paper_account_state" ("opened_at")`);

        // ---------- paper_account_state_history ----------
        await queryRunner.query(`
            CREATE TABLE "paper_account_state_history" (
                "paper_account_state_history_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "client_order_id" text NOT NULL,
                "symbol" text NOT NULL,
                "side" text NOT NULL,
                "entry_price" numeric(38, 18) NOT NULL,
                "exit_price" numeric(38, 18) NOT NULL,
                "size" numeric(38, 18) NOT NULL,
                "realised_pnl" numeric(38, 8) NOT NULL,
                "fees" numeric(38, 8) NOT NULL DEFAULT '0',
                "funding_accrued" numeric(38, 8) NOT NULL DEFAULT '0',
                "slippage" numeric(38, 8) NOT NULL DEFAULT '0',
                "close_reason" text NOT NULL,
                "opened_at" timestamptz NOT NULL,
                "closed_at" timestamptz NOT NULL,
                "mode" text NOT NULL DEFAULT 'paper',
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_paper_account_state_history" PRIMARY KEY ("paper_account_state_history_id"),
                CONSTRAINT "ck_paper_account_state_history_side" CHECK ("side" IN ('long', 'short')),
                CONSTRAINT "ck_paper_account_state_history_mode" CHECK ("mode" = 'paper'),
                CONSTRAINT "ck_paper_account_state_history_close_reason" CHECK (
                    "close_reason" IN ('sl', 'tp', 'intra_bar_stop', 'force_close', 'operator_drain', 'reconciliation_forced')
                ),
                CONSTRAINT "ck_paper_account_state_history_size_positive" CHECK ("size" > 0)
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_paper_account_state_history_closed_at" ON "paper_account_state_history" ("closed_at")`);
        await queryRunner.query(`CREATE INDEX "idx_paper_account_state_history_symbol_closed_at" ON "paper_account_state_history" ("symbol", "closed_at")`);
        await queryRunner.query(`CREATE INDEX "idx_paper_account_state_history_client_order_id" ON "paper_account_state_history" ("client_order_id")`);

        // ---------- paper_account_state_meta ----------
        // Single-row-per-soak: UNIQUE on soak_start_id is the natural key. The
        // surrogate uuid PK exists for repository ergonomics only.
        await queryRunner.query(`
            CREATE TABLE "paper_account_state_meta" (
                "paper_account_state_meta_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "soak_start_id" uuid NOT NULL,
                "soak_start_ts" timestamptz NOT NULL,
                "seed_version_label" text NOT NULL,
                "hkdf_info_version" text NOT NULL,
                "simulator_config_hash" text NOT NULL,
                "bootstrap_at_start_fingerprint" text NOT NULL,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_paper_account_state_meta" PRIMARY KEY ("paper_account_state_meta_id"),
                CONSTRAINT "uq_paper_account_state_meta_soak_start_id" UNIQUE ("soak_start_id")
            )
        `);

        // ---------- paper_account_snapshots ----------
        await queryRunner.query(`
            CREATE TABLE "paper_account_snapshots" (
                "paper_account_snapshot_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "taken_at" timestamptz NOT NULL,
                "balance" numeric(38, 8) NOT NULL,
                "equity" numeric(38, 8) NOT NULL,
                "realised_pnl_cumulative" numeric(38, 8) NOT NULL,
                "funding_accrued_cumulative" numeric(38, 8) NOT NULL,
                "unrealised_pnl_total" numeric(38, 8) NOT NULL,
                "peak_equity" numeric(38, 8) NOT NULL,
                "open_positions_count" integer NOT NULL,
                "mode" text NOT NULL DEFAULT 'paper',
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_paper_account_snapshots" PRIMARY KEY ("paper_account_snapshot_id"),
                CONSTRAINT "ck_paper_account_snapshots_mode" CHECK ("mode" = 'paper'),
                CONSTRAINT "ck_paper_account_snapshots_open_positions_count_nonneg" CHECK ("open_positions_count" >= 0)
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_paper_account_snapshots_taken_at" ON "paper_account_snapshots" ("taken_at")`);

        // ---------- paper_simulator_idempotency ----------
        // The composite UNIQUE is the load-bearing constraint (D3). The
        // surrogate uuid PK keeps repository ergonomics consistent with the
        // other paper tables.
        await queryRunner.query(`
            CREATE TABLE "paper_simulator_idempotency" (
                "paper_simulator_idempotency_id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "event_id" text NOT NULL,
                "order_intent_id" text NOT NULL,
                "version_namespace" text NOT NULL,
                "simulated_fill_id" text NOT NULL,
                "simulated_fill_payload" jsonb NOT NULL,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "pk_paper_simulator_idempotency" PRIMARY KEY ("paper_simulator_idempotency_id"),
                CONSTRAINT "uq_paper_simulator_idempotency_key" UNIQUE ("event_id", "order_intent_id", "version_namespace")
            )
        `);

        await queryRunner.query(`CREATE INDEX "idx_paper_simulator_idempotency_event_id" ON "paper_simulator_idempotency" ("event_id")`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_simulator_idempotency_event_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "paper_simulator_idempotency"`);

        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_account_snapshots_taken_at"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "paper_account_snapshots"`);

        await queryRunner.query(`DROP TABLE IF EXISTS "paper_account_state_meta"`);

        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_account_state_history_client_order_id"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_account_state_history_symbol_closed_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_account_state_history_closed_at"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "paper_account_state_history"`);

        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_account_state_opened_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_paper_account_state_symbol"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "paper_account_state"`);
    }
}
