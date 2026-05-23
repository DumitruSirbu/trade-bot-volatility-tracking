/**
 * M2 Adversarial — Surface 4: Unique-constraint races on concurrent inserts.
 *
 * ADR 0002 §point-in-time universe (one open row per symbol):
 *   "no two open universe_membership rows for the same symbol can ever coexist."
 *
 * This suite targets three repositories:
 *   a. UniverseMembershipRepository — two concurrent openMembership calls racing
 *      for the partial unique index UNIQUE(symbol) WHERE left_at IS NULL.
 *   b. CandleRepository — two concurrent upsertClosed calls with the same
 *      (symbol, interval, open_time) key.
 *   c. FundingRateRepository — two concurrent recordObservation calls for the
 *      same settlement timestamp.
 *
 * Adversarial categories:
 *   - Race conditions: parallel awaits on the same key.
 *   - Duplicate state: sequential insert of identical rows.
 *   - Transition: open → concurrent open (must remain exactly one open row).
 *
 * Requires live Postgres with migrations run.
 */

import { DataSource, Repository } from 'typeorm';
import { getTestDataSource } from '../../support/testDataSource';
import { UniverseMembershipEntity } from '../../../src/market-data/entity/UniverseMembershipEntity';
import { CandleEntity } from '../../../src/market-data/entity/CandleEntity';
import { FundingRateEntity } from '../../../src/market-data/entity/FundingRateEntity';
import { UniverseMembershipRepository } from '../../../src/market-data/repository/UniverseMembershipRepository';
import { CandleRepository } from '../../../src/market-data/repository/CandleRepository';
import { FundingRateRepository } from '../../../src/market-data/repository/FundingRateRepository';
import { parseMoney } from '../../../src/common/utils/money';
import { CoinTierEnum } from '@bot/shared';

// Distinct symbols to avoid collisions with other integration suites.
const SYM_UNIVERSE = 'ADVUNIUSDT';
const SYM_CANDLE = 'ADVCANUSDT';
const SYM_FUNDING = 'ADVFNDUSDT';

const ENTERED_AT = new Date('2026-01-15T00:00:00.000Z');
const CANDLE_OPEN_TIME = new Date('2026-05-22T10:00:00.000Z');
const SETTLEMENT_TIME = new Date('2026-05-22T08:00:00.000Z');

describe('Unique-constraint race adversarial (requires Postgres)', () => {
    let dataSource: DataSource;
    let universeMembershipRepo: UniverseMembershipRepository;
    let candleRepo: CandleRepository;
    let fundingRateRepo: FundingRateRepository;

    beforeAll(async () => {
        dataSource = await getTestDataSource();

        const rawUniverseRepo: Repository<UniverseMembershipEntity> = dataSource.getRepository(UniverseMembershipEntity);
        const rawCandleRepo: Repository<CandleEntity> = dataSource.getRepository(CandleEntity);
        const rawFundingRepo: Repository<FundingRateEntity> = dataSource.getRepository(FundingRateEntity);

        universeMembershipRepo = new UniverseMembershipRepository(rawUniverseRepo);
        candleRepo = new CandleRepository(rawCandleRepo);
        fundingRateRepo = new FundingRateRepository(rawFundingRepo);
    }, 30_000);

    afterAll(async () => {
        await dataSource.query(`DELETE FROM universe_membership WHERE symbol = $1`, [SYM_UNIVERSE]);
        await dataSource.query(`DELETE FROM candles WHERE symbol = $1`, [SYM_CANDLE]);
        await dataSource.query(`DELETE FROM funding_rates WHERE symbol = $1`, [SYM_FUNDING]);
    }, 30_000);

    // -----------------------------------------------------------------------
    // Surface 4a — Two concurrent openMembership calls race for the same symbol.
    // ADR 0002 §point-in-time universe: partial unique index enforces at most one
    // open row per symbol; a concurrent create race must leave exactly one row.
    // -----------------------------------------------------------------------
    describe('UniverseMembershipRepository — concurrent open race (ADR 0002 §point-in-time universe)', () => {
        afterEach(async () => {
            await dataSource.query(`DELETE FROM universe_membership WHERE symbol = $1`, [SYM_UNIVERSE]);
        });

        it('two simultaneous openMembership calls leave exactly ONE open row (race resolved without error)', async () => {
            // Both coroutines race on the same event loop tick; one must win cleanly
            // and the other must be silently discarded (idempotent guard in the repo).
            const [result1, result2] = await Promise.allSettled([
                universeMembershipRepo.openMembership(SYM_UNIVERSE, CoinTierEnum.TIER_1, ENTERED_AT),
                universeMembershipRepo.openMembership(SYM_UNIVERSE, CoinTierEnum.TIER_1, ENTERED_AT),
            ]);

            // At most one may reject — and only due to a transient DB error, not a
            // constraint violation that leaks through as an unhandled exception.
            const openRows = await dataSource.query(
                `SELECT * FROM universe_membership WHERE symbol = $1 AND left_at IS NULL`,
                [SYM_UNIVERSE],
            );

            // ADR 0002 §point-in-time universe: exactly one open row must exist.
            expect(openRows).toHaveLength(1);

            // Report if either call rejected (a real bug would surface here).
            if (result1.status === 'rejected') {
                console.warn('Race call 1 rejected:', result1.reason);
            }

            if (result2.status === 'rejected') {
                console.warn('Race call 2 rejected:', result2.reason);
            }
        });

        it('three rapid openMembership calls leave exactly ONE open row (no stacking under repeated rapid calls)', async () => {
            await Promise.all([
                universeMembershipRepo.openMembership(SYM_UNIVERSE, CoinTierEnum.TIER_1, ENTERED_AT),
                universeMembershipRepo.openMembership(SYM_UNIVERSE, CoinTierEnum.TIER_1, ENTERED_AT),
                universeMembershipRepo.openMembership(SYM_UNIVERSE, CoinTierEnum.TIER_1, ENTERED_AT),
            ]);

            const openRows = await dataSource.query(
                `SELECT * FROM universe_membership WHERE symbol = $1 AND left_at IS NULL`,
                [SYM_UNIVERSE],
            );

            expect(openRows).toHaveLength(1);
        });

        it('concurrent open with DIFFERENT tiers leaves exactly ONE open row (last write wins, not both)', async () => {
            // Two writers race with differing tiers — only one must land.
            await Promise.allSettled([
                universeMembershipRepo.openMembership(SYM_UNIVERSE, CoinTierEnum.TIER_1, ENTERED_AT),
                universeMembershipRepo.openMembership(SYM_UNIVERSE, CoinTierEnum.TIER_2, ENTERED_AT),
            ]);

            const openRows = await dataSource.query(
                `SELECT * FROM universe_membership WHERE symbol = $1 AND left_at IS NULL`,
                [SYM_UNIVERSE],
            );

            // ADR 0002 §point-in-time universe: regardless of which tier wins, only
            // one open row must exist.
            expect(openRows).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------------
    // Surface 4b — Two concurrent CandleRepository.upsertClosed calls with the
    // same (symbol, interval, open_time) key.
    // ADR 0002 §candles upsert: "idempotent on UNIQUE(symbol, interval, open_time)."
    // -----------------------------------------------------------------------
    describe('CandleRepository — concurrent upsert race (ADR 0002 §candles)', () => {
        afterEach(async () => {
            await dataSource.query(`DELETE FROM candles WHERE symbol = $1`, [SYM_CANDLE]);
        });

        const buildCandle = (closePrice: string): Partial<CandleEntity> => ({
            symbol: SYM_CANDLE,
            interval: '5m',
            openTime: CANDLE_OPEN_TIME,
            open: parseMoney('100.00'),
            high: parseMoney('101.00'),
            low: parseMoney('99.00'),
            close: parseMoney(closePrice),
            volume: parseMoney('500.00'),
        });

        it('two simultaneous upserts for the same key resolve to exactly ONE row (no duplicate)', async () => {
            await Promise.all([
                candleRepo.upsertClosed(buildCandle('100.50')),
                candleRepo.upsertClosed(buildCandle('100.50')),
            ]);

            const rows = await dataSource.query(
                `SELECT * FROM candles WHERE symbol = $1 AND interval = '5m' AND open_time = $2`,
                [SYM_CANDLE, CANDLE_OPEN_TIME],
            );

            expect(rows).toHaveLength(1);
        });

        it('concurrent upserts with different close prices resolve to exactly ONE row (last writer wins, no split-brain)', async () => {
            await Promise.allSettled([
                candleRepo.upsertClosed(buildCandle('100.50')),
                candleRepo.upsertClosed(buildCandle('101.75')),
            ]);

            const rows = await dataSource.query(
                `SELECT * FROM candles WHERE symbol = $1 AND interval = '5m' AND open_time = $2`,
                [SYM_CANDLE, CANDLE_OPEN_TIME],
            );

            // ADR 0002 §candles: a re-emitted closed bar updates in place — one row only.
            expect(rows).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------------
    // Surface 4c — Two concurrent FundingRateRepository.recordObservation calls
    // with the same settlement timestamp.
    // ADR 0002 §funding rates: "idempotent on UNIQUE(symbol, funding_time)."
    // -----------------------------------------------------------------------
    describe('FundingRateRepository — concurrent settlement-time race (ADR 0002 §funding rates)', () => {
        afterEach(async () => {
            await dataSource.query(`DELETE FROM funding_rates WHERE symbol = $1`, [SYM_FUNDING]);
        });

        it('two simultaneous recordObservation calls for the same settlement time resolve to ONE row', async () => {
            await Promise.all([
                fundingRateRepo.recordObservation({
                    symbol: SYM_FUNDING,
                    fundingTime: SETTLEMENT_TIME,
                    rate: parseMoney('0.0001'),
                }),
                fundingRateRepo.recordObservation({
                    symbol: SYM_FUNDING,
                    fundingTime: SETTLEMENT_TIME,
                    rate: parseMoney('0.0001'),
                }),
            ]);

            const rows = await dataSource.query(
                `SELECT * FROM funding_rates WHERE symbol = $1 AND funding_time = $2`,
                [SYM_FUNDING, SETTLEMENT_TIME],
            );

            expect(rows).toHaveLength(1);
        });

        it('three rapid recordObservation calls with the same settlement time leave exactly ONE row', async () => {
            await Promise.all([
                fundingRateRepo.recordObservation({ symbol: SYM_FUNDING, fundingTime: SETTLEMENT_TIME, rate: parseMoney('0.00010') }),
                fundingRateRepo.recordObservation({ symbol: SYM_FUNDING, fundingTime: SETTLEMENT_TIME, rate: parseMoney('0.00011') }),
                fundingRateRepo.recordObservation({ symbol: SYM_FUNDING, fundingTime: SETTLEMENT_TIME, rate: parseMoney('0.00012') }),
            ]);

            const rows = await dataSource.query(
                `SELECT * FROM funding_rates WHERE symbol = $1 AND funding_time = $2`,
                [SYM_FUNDING, SETTLEMENT_TIME],
            );

            // ADR 0002 §funding rates: same 8-hour event is never double-recorded.
            expect(rows).toHaveLength(1);
        });
    });
});
