import { MigrationInterface, QueryRunner } from 'typeorm';

// Paper-soak exploration: raise per-symbol daily entry cap from 2 → 10 on all
// volatility-vwap strategy versions. Live gate reads this from strategy_versions.params
// (ADR 0004 §overtrading); engine restart required after apply.

const STRATEGY_NAME = 'volatility-vwap';
const PREVIOUS_VALUE = 2;
const NEW_VALUE = 10;

export class RaiseMaxTradesPerSymbolPerDay20260708000003 implements MigrationInterface {
    name = 'RaiseMaxTradesPerSymbolPerDay20260708000003';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "strategy_versions"
             SET "params" = jsonb_set("params", '{max_trades_per_symbol_per_day}', $1::jsonb)
             WHERE "name" = $2
               AND ("params" ? 'max_trades_per_symbol_per_day')`,
            [String(NEW_VALUE), STRATEGY_NAME],
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE "strategy_versions"
             SET "params" = jsonb_set("params", '{max_trades_per_symbol_per_day}', $1::jsonb)
             WHERE "name" = $2
               AND ("params"->>'max_trades_per_symbol_per_day') = $3`,
            [String(PREVIOUS_VALUE), STRATEGY_NAME, String(NEW_VALUE)],
        );
    }
}
