import { MigrationInterface, QueryRunner } from 'typeorm';

import { MS_PER_DAY } from '../../common/const';
import { TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS, TICK_AGGREGATE_PARTITION_PREFIX } from '../../market-data/const';

// M2 full schema (ADR 0002). Creates all 13 tables with their indexes, UNIQUE
// constraints and FKs. tick_aggregates is a native daily RANGE partition parent with an
// initial today..today+lookahead window so first-boot inserts never hit a missing
// partition; the TickAggregatePartitionService extends/retires the window thereafter.
//
// down() reverses in EXACT opposite order: child partitions → indexes → FKs → tables.

export class CreateSchema20260522010000 implements MigrationInterface {
    name = 'CreateSchema20260522010000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await this.createInstruments(queryRunner);
        await this.createCandles(queryRunner);
        await this.createTickAggregates(queryRunner);
        await this.createOpenInterest(queryRunner);
        await this.createFundingRates(queryRunner);
        await this.createBookSnapshots(queryRunner);
        await this.createUniverseMembership(queryRunner);
        await this.createStrategyVersions(queryRunner);
        await this.createPositions(queryRunner);
        await this.createTransactions(queryRunner);
        await this.createDecisions(queryRunner);
        await this.createRiskState(queryRunner);
        await this.createAccountSnapshots(queryRunner);
    }

    // Faithful inverse of up(): drop every index in EXACT reverse creation order, then the
    // tables (which removes their inline FK / PK / UNIQUE constraints), tick_aggregates
    // children before its parent. FKs live inline in CREATE TABLE so they are torn down with
    // the owning table — no separate ALTER ... DROP CONSTRAINT step is needed.
    async down(queryRunner: QueryRunner): Promise<void> {
        await this.dropIndexesInReverse(queryRunner);

        await queryRunner.query('DROP TABLE IF EXISTS "account_snapshots"');
        await queryRunner.query('DROP TABLE IF EXISTS "risk_state"');
        await queryRunner.query('DROP TABLE IF EXISTS "decisions"');
        await queryRunner.query('DROP TABLE IF EXISTS "transactions"');
        await queryRunner.query('DROP TABLE IF EXISTS "positions"');
        await queryRunner.query('DROP TABLE IF EXISTS "strategy_versions"');
        await queryRunner.query('DROP TABLE IF EXISTS "universe_membership"');
        await queryRunner.query('DROP TABLE IF EXISTS "book_snapshots"');
        await queryRunner.query('DROP TABLE IF EXISTS "funding_rates"');
        await queryRunner.query('DROP TABLE IF EXISTS "open_interest"');
        await this.dropTickAggregates(queryRunner);
        await queryRunner.query('DROP TABLE IF EXISTS "candles"');
        await queryRunner.query('DROP TABLE IF EXISTS "instruments"');
    }

    private async dropIndexesInReverse(queryRunner: QueryRunner): Promise<void> {
        const indexesInCreationOrder = [
            'idx_candles_symbol_interval_open_time',
            'idx_tick_aggregates_symbol_ts',
            'idx_open_interest_symbol_ts',
            'idx_funding_rates_symbol_funding_time',
            'idx_book_snapshots_symbol_ts',
            'idx_universe_membership_symbol_entered_at',
            'uq_universe_membership_open_symbol',
            'idx_positions_strategy_version_id_status',
            'idx_positions_symbol_status',
            'idx_decisions_strategy_version_id_ts',
            'idx_decisions_event_id',
            'idx_account_snapshots_ts',
        ];

        for (const indexName of [...indexesInCreationOrder].reverse()) {
            await queryRunner.query(`DROP INDEX IF EXISTS "${indexName}"`);
        }
    }

    private async createInstruments(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "instruments" (
                "instruments_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "base" varchar NOT NULL,
                "quote" varchar NOT NULL,
                "status" varchar NOT NULL,
                "tick_size" numeric(38, 18) NOT NULL,
                "step_size" numeric(38, 18) NOT NULL,
                "min_notional" numeric(38, 8) NOT NULL,
                "is_tradable" boolean NOT NULL,
                "volume_24h" numeric(38, 18) NOT NULL,
                "coin_tier" varchar NOT NULL,
                "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "pk_instruments" PRIMARY KEY ("instruments_id"),
                CONSTRAINT "uq_instruments_symbol" UNIQUE ("symbol")
            )
        `);
    }

    private async createCandles(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "candles" (
                "candles_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "interval" varchar NOT NULL,
                "open_time" timestamptz NOT NULL,
                "open" numeric(38, 18) NOT NULL,
                "high" numeric(38, 18) NOT NULL,
                "low" numeric(38, 18) NOT NULL,
                "close" numeric(38, 18) NOT NULL,
                "volume" numeric(38, 18) NOT NULL,
                CONSTRAINT "pk_candles" PRIMARY KEY ("candles_id"),
                CONSTRAINT "uq_candles_symbol_interval_open_time" UNIQUE ("symbol", "interval", "open_time")
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_candles_symbol_interval_open_time" ON "candles" ("symbol", "interval", "open_time")');
    }

    private async createTickAggregates(queryRunner: QueryRunner): Promise<void> {
        // Partition key `ts` must be part of the PK and every UNIQUE (Postgres rule, §3).
        await queryRunner.query(`
            CREATE TABLE "tick_aggregates" (
                "tick_aggregates_id" BIGSERIAL NOT NULL,
                "ts" timestamptz NOT NULL,
                "symbol" varchar NOT NULL,
                "open" numeric(38, 18) NOT NULL,
                "high" numeric(38, 18) NOT NULL,
                "low" numeric(38, 18) NOT NULL,
                "close" numeric(38, 18) NOT NULL,
                "volume" numeric(38, 18) NOT NULL,
                CONSTRAINT "pk_tick_aggregates" PRIMARY KEY ("tick_aggregates_id", "ts"),
                CONSTRAINT "uq_tick_aggregates_symbol_ts" UNIQUE ("symbol", "ts")
            ) PARTITION BY RANGE ("ts")
        `);
        await queryRunner.query('CREATE INDEX "idx_tick_aggregates_symbol_ts" ON "tick_aggregates" ("symbol", "ts")');

        const todayStartMs = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;

        for (let dayOffset = 0; dayOffset <= TICK_AGGREGATE_PARTITION_LOOKAHEAD_DAYS; dayOffset += 1) {
            await this.createTickAggregatePartition(queryRunner, todayStartMs + dayOffset * MS_PER_DAY);
        }
    }

    private async createTickAggregatePartition(queryRunner: QueryRunner, dayStartMs: number): Promise<void> {
        const name = `${TICK_AGGREGATE_PARTITION_PREFIX}${this.compactDay(dayStartMs)}`;
        const from = this.isoDay(dayStartMs);
        const to = this.isoDay(dayStartMs + MS_PER_DAY);

        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "tick_aggregates" FOR VALUES FROM ('${from}') TO ('${to}')`);
    }

    // Drops every daily partition (child tables) BEFORE the parent — exact reverse of
    // create (parent + partitions). DROP TABLE on the parent would cascade, but we drop
    // children explicitly so down() is a faithful inverse and self-documents the order.
    private async dropTickAggregates(queryRunner: QueryRunner): Promise<void> {
        const partitions = (await queryRunner.query(`SELECT c.relname FROM pg_class c WHERE c.relkind = 'r' AND c.relname LIKE $1 ORDER BY c.relname ASC`, [
            `${TICK_AGGREGATE_PARTITION_PREFIX}%`,
        ])) as { relname: string }[];

        for (const partition of partitions) {
            await queryRunner.query(`DROP TABLE IF EXISTS "${partition.relname}"`);
        }

        await queryRunner.query('DROP TABLE IF EXISTS "tick_aggregates"');
    }

    private async createOpenInterest(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "open_interest" (
                "open_interest_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "ts" timestamptz NOT NULL,
                "value" numeric(38, 8) NOT NULL,
                CONSTRAINT "pk_open_interest" PRIMARY KEY ("open_interest_id"),
                CONSTRAINT "uq_open_interest_symbol_ts" UNIQUE ("symbol", "ts")
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_open_interest_symbol_ts" ON "open_interest" ("symbol", "ts")');
    }

    private async createFundingRates(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "funding_rates" (
                "funding_rates_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "funding_time" timestamptz NOT NULL,
                "rate" numeric(18, 10) NOT NULL,
                CONSTRAINT "pk_funding_rates" PRIMARY KEY ("funding_rates_id"),
                CONSTRAINT "uq_funding_rates_symbol_funding_time" UNIQUE ("symbol", "funding_time")
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_funding_rates_symbol_funding_time" ON "funding_rates" ("symbol", "funding_time")');
    }

    private async createBookSnapshots(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "book_snapshots" (
                "book_snapshots_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "ts" timestamptz NOT NULL,
                "spread" numeric(18, 8),
                "depth_10bps" numeric(38, 8),
                "depth_50bps" numeric(38, 8),
                CONSTRAINT "pk_book_snapshots" PRIMARY KEY ("book_snapshots_id")
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_book_snapshots_symbol_ts" ON "book_snapshots" ("symbol", "ts")');
    }

    private async createUniverseMembership(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "universe_membership" (
                "universe_membership_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "coin_tier" varchar NOT NULL,
                "entered_at" timestamptz NOT NULL,
                "left_at" timestamptz,
                CONSTRAINT "pk_universe_membership" PRIMARY KEY ("universe_membership_id")
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_universe_membership_symbol_entered_at" ON "universe_membership" ("symbol", "entered_at")');
        // At most ONE open row per symbol (the row with left_at IS NULL). This DB-level
        // guarantee makes a duplicate 'entered' / restart re-seed race unable to stack a
        // second open row even if the application-level check loses the race (finding #5).
        await queryRunner.query('CREATE UNIQUE INDEX "uq_universe_membership_open_symbol" ON "universe_membership" ("symbol") WHERE "left_at" IS NULL');
    }

    private async createStrategyVersions(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "strategy_versions" (
                "strategy_versions_id" SERIAL NOT NULL,
                "name" varchar NOT NULL,
                "version" integer NOT NULL,
                "direction" varchar NOT NULL,
                "params" jsonb NOT NULL,
                "status" varchar NOT NULL,
                "parent_version_id" integer,
                "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "pk_strategy_versions" PRIMARY KEY ("strategy_versions_id"),
                CONSTRAINT "uq_strategy_versions_name_version" UNIQUE ("name", "version"),
                CONSTRAINT "fk_strategy_versions_parent" FOREIGN KEY ("parent_version_id")
                    REFERENCES "strategy_versions" ("strategy_versions_id") ON DELETE SET NULL ON UPDATE CASCADE
            )
        `);
    }

    private async createPositions(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "positions" (
                "positions_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "strategy_version_id" integer NOT NULL,
                "side" varchar NOT NULL,
                "status" varchar NOT NULL,
                "leverage" numeric(10, 4) NOT NULL,
                "entry_price" numeric(38, 18) NOT NULL,
                "qty" numeric(38, 18) NOT NULL,
                "entry_notional" numeric(38, 8) NOT NULL,
                "exit_price" numeric(38, 18),
                "realized_pnl" numeric(38, 8),
                "exit_reason" varchar,
                "opened_at" timestamptz NOT NULL,
                "closed_at" timestamptz,
                "vwap_at_entry" numeric(38, 18),
                "atr_at_entry" numeric(38, 18),
                "vwap_deviation_at_entry" numeric(18, 8),
                "idiosyncrasy_at_entry" numeric(10, 6),
                "coin_tier" varchar,
                "signal_score_at_entry" numeric(10, 6),
                "position_slot" varchar,
                "time_stop_at" timestamptz,
                "slippage_model_pct" numeric(18, 8),
                "open_interest_at_entry" numeric(38, 8),
                "oi_change_5m_at_entry" numeric(18, 8),
                "flow_type_at_entry" varchar,
                "funding_annualized_at_entry" numeric(18, 10),
                "book_depth_10bps_at_entry" numeric(38, 8),
                "spread_at_entry_pct" numeric(18, 8),
                "vwap_anchor_type" varchar,
                "symbol_universe_age_hours" numeric(18, 8),
                "mae_pct" numeric(18, 8),
                "mfe_pct" numeric(18, 8),
                "time_to_reversion_secs" integer,
                "stop_gap_pct" numeric(18, 8),
                "min_liquidation_distance_pct" numeric(18, 8),
                "protective_order_type" varchar,
                "mark_vs_last_max_divergence_pct" numeric(18, 8),
                CONSTRAINT "pk_positions" PRIMARY KEY ("positions_id"),
                CONSTRAINT "fk_positions_strategy_version" FOREIGN KEY ("strategy_version_id")
                    REFERENCES "strategy_versions" ("strategy_versions_id") ON DELETE RESTRICT ON UPDATE CASCADE
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_positions_strategy_version_id_status" ON "positions" ("strategy_version_id", "status")');
        await queryRunner.query('CREATE INDEX "idx_positions_symbol_status" ON "positions" ("symbol", "status")');
    }

    private async createTransactions(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "transactions" (
                "transactions_id" SERIAL NOT NULL,
                "position_id" integer NOT NULL,
                "type" varchar NOT NULL,
                "side" varchar NOT NULL,
                "price" numeric(38, 18) NOT NULL,
                "qty" numeric(38, 18) NOT NULL,
                "fee" numeric(38, 8) NOT NULL,
                "client_order_id" varchar NOT NULL,
                "exchange_order_id" varchar,
                "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "pk_transactions" PRIMARY KEY ("transactions_id"),
                CONSTRAINT "uq_transactions_exchange_order_id" UNIQUE ("exchange_order_id"),
                CONSTRAINT "fk_transactions_position" FOREIGN KEY ("position_id")
                    REFERENCES "positions" ("positions_id") ON DELETE CASCADE ON UPDATE CASCADE
            )
        `);
    }

    private async createDecisions(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "decisions" (
                "decisions_id" SERIAL NOT NULL,
                "symbol" varchar NOT NULL,
                "strategy_version_id" integer NOT NULL,
                "ts" timestamptz NOT NULL,
                "event_id" varchar NOT NULL,
                "signal_type" varchar NOT NULL,
                "market_snapshot" jsonb NOT NULL,
                "action" varchar NOT NULL,
                "reason" varchar,
                "position_id" integer,
                CONSTRAINT "pk_decisions" PRIMARY KEY ("decisions_id"),
                CONSTRAINT "fk_decisions_strategy_version" FOREIGN KEY ("strategy_version_id")
                    REFERENCES "strategy_versions" ("strategy_versions_id") ON DELETE RESTRICT ON UPDATE CASCADE,
                CONSTRAINT "fk_decisions_position" FOREIGN KEY ("position_id")
                    REFERENCES "positions" ("positions_id") ON DELETE SET NULL ON UPDATE CASCADE
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_decisions_strategy_version_id_ts" ON "decisions" ("strategy_version_id", "ts")');
        await queryRunner.query('CREATE INDEX "idx_decisions_event_id" ON "decisions" ("event_id")');
    }

    private async createRiskState(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "risk_state" (
                "risk_state_id" SERIAL NOT NULL,
                "date" date NOT NULL,
                "realized_pnl_day" numeric(38, 8) NOT NULL,
                "open_exposure" numeric(38, 8) NOT NULL,
                "trades_count" integer NOT NULL,
                "is_halted" boolean NOT NULL,
                "halt_reason" varchar,
                CONSTRAINT "pk_risk_state" PRIMARY KEY ("risk_state_id"),
                CONSTRAINT "uq_risk_state_date" UNIQUE ("date")
            )
        `);
    }

    private async createAccountSnapshots(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "account_snapshots" (
                "account_snapshots_id" SERIAL NOT NULL,
                "ts" timestamptz NOT NULL,
                "balance" numeric(38, 8) NOT NULL,
                "equity" numeric(38, 8) NOT NULL,
                "unrealized_pnl" numeric(38, 8) NOT NULL,
                CONSTRAINT "pk_account_snapshots" PRIMARY KEY ("account_snapshots_id")
            )
        `);
        await queryRunner.query('CREATE INDEX "idx_account_snapshots_ts" ON "account_snapshots" ("ts")');
    }

    private isoDay(ms: number): string {
        return new Date(ms).toISOString().slice(0, 10);
    }

    private compactDay(ms: number): string {
        return this.isoDay(ms).replace(/-/g, '');
    }
}
