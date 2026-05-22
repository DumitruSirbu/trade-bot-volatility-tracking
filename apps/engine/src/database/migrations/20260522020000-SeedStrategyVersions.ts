import { StrategyDirectionEnum, StrategyStatusEnum } from '@bot/shared';
import { MigrationInterface, QueryRunner } from 'typeorm';

// Seeds the canonical v0–v3 strategy_versions (M2 brief). Idempotent on the stable key
// (name, version): up() upserts, down() deletes exactly those four rows. v0 is the
// no-trade baseline (trade_enabled:false). Direction/status are the shared enum string
// values (StrategyDirectionEnum / StrategyStatusEnum).

const STRATEGY_NAME = 'volatility-vwap';

// Shared base params (M2 brief). Per-version overlays are merged on top so a single
// source of truth defines the common knobs and each version only states its delta.
const BASE_PARAMS = {
    vwap_window_bars: 20,
    vwap_sigma_trigger: 2.0,
    volume_ratio_min: 1.5,
    atr_period: 14,
    atr_stop_multiplier: 1.5,
    time_stop_minutes: 15,
    idiosyncrasy_min_score: 0.5,
    btc_correlated_move_threshold_pct: 1.5,
    max_open_positions: 3,
    max_btc_correlated_positions: 1,
    tier1_min_abs_move_pct: 0.8,
    tier2_min_abs_move_pct: 1.2,
    tier3_min_abs_move_pct: 1.5,
    tier1_max_abs_move_pct: 4.0,
    tier2_max_abs_move_pct: 6.0,
    tier3_max_abs_move_pct: 8.0,
    funding_rate_suppress_threshold: 0.001,
    candle_interval: '5m',
    slippage_tier1_pct: 0.15,
    slippage_tier2_pct: 0.5,
    slippage_tier3_pct: 1.0,
    require_oi_available: true,
    oi_rising_skip: true,
    consecutive_loss_halt: 2,
    max_trades_per_symbol_per_day: 2,
    max_trades_per_bar_universe: 1,
    stress_btc_1m_shock_pct: 1.0,
    stress_eth_1m_shock_pct: 1.2,
    stress_breadth_pct: 70,
    stress_same_bar_trigger_count: 5,
    structural_stop_wick_buffer_pct: 0.1,
    structural_stop_hard_cap_pct: 2.0,
};

interface ISeedVersion {
    version: number;
    direction: StrategyDirectionEnum;
    status: StrategyStatusEnum;
    params: Record<string, unknown>;
}

const SEED_VERSIONS: ISeedVersion[] = [
    {
        version: 0,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        status: StrategyStatusEnum.ACTIVE,
        params: { ...BASE_PARAMS, trade_enabled: false },
    },
    // `direction` is intentionally NOT duplicated into params — the `direction` COLUMN is
    // the single canonical source of truth (finding #12); params holds only per-version knobs.
    {
        version: 1,
        direction: StrategyDirectionEnum.MEAN_REVERSION,
        status: StrategyStatusEnum.DRAFT,
        params: { ...BASE_PARAMS, require_exhaustion_confirmation: true },
    },
    {
        version: 2,
        direction: StrategyDirectionEnum.MOMENTUM,
        status: StrategyStatusEnum.DRAFT,
        params: { ...BASE_PARAMS },
    },
    {
        version: 3,
        direction: StrategyDirectionEnum.HYBRID,
        status: StrategyStatusEnum.DRAFT,
        params: { ...BASE_PARAMS },
    },
];

export class SeedStrategyVersions20260522020000 implements MigrationInterface {
    name = 'SeedStrategyVersions20260522020000';

    async up(queryRunner: QueryRunner): Promise<void> {
        for (const seed of SEED_VERSIONS) {
            await queryRunner.query(
                `INSERT INTO "strategy_versions" ("name", "version", "direction", "params", "status")
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT ("name", "version")
                 DO UPDATE SET "direction" = EXCLUDED."direction", "params" = EXCLUDED."params", "status" = EXCLUDED."status"`,
                [STRATEGY_NAME, seed.version, seed.direction, JSON.stringify(seed.params), seed.status],
            );
        }
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        // Delete by stable key (name, version) so the seed is fully reversible.
        for (const seed of SEED_VERSIONS) {
            await queryRunner.query('DELETE FROM "strategy_versions" WHERE "name" = $1 AND "version" = $2', [STRATEGY_NAME, seed.version]);
        }
    }
}
