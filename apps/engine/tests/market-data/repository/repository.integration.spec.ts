/**
 * Repository integration tests (requires live Postgres with migrations already run).
 *
 * Covers:
 *   - CandleRepository.upsertClosed — idempotent on UNIQUE(symbol, interval, open_time)
 *   - OpenInterestRepository.recordSample — idempotent on UNIQUE(symbol, ts)
 *   - TickAggregateRepository.recordSample — idempotent on UNIQUE(symbol, ts)
 *   - FundingRateRepository.recordObservation — idempotent on UNIQUE(symbol, funding_time)
 *   - UniverseMembershipRepository — gap-free point-in-time timeline
 *   - InstrumentRepository.upsertBySymbol — idempotent on UNIQUE(symbol)
 *   - StrategyVersionRepository.findActive — returns seeded active version(s)
 *   - tick_aggregates round-trip — NUMERIC precision survives DB write+read, no float drift
 *   - Intra-candle spike reconstruction from tick_aggregate sequence
 */

import { DataSource, Repository } from 'typeorm';
import { getTestDataSource } from '../../support/testDataSource';
import { CandleEntity } from '../../../src/market-data/entity/CandleEntity';
import { OpenInterestEntity } from '../../../src/market-data/entity/OpenInterestEntity';
import { TickAggregateEntity } from '../../../src/market-data/entity/TickAggregateEntity';
import { FundingRateEntity } from '../../../src/market-data/entity/FundingRateEntity';
import { UniverseMembershipEntity } from '../../../src/market-data/entity/UniverseMembershipEntity';
import { InstrumentEntity } from '../../../src/market-data/entity/InstrumentEntity';
import { StrategyVersionEntity } from '../../../src/strategy/entity/StrategyVersionEntity';
import { CandleRepository } from '../../../src/market-data/repository/CandleRepository';
import { OpenInterestRepository } from '../../../src/market-data/repository/OpenInterestRepository';
import { TickAggregateRepository } from '../../../src/market-data/repository/TickAggregateRepository';
import { FundingRateRepository } from '../../../src/market-data/repository/FundingRateRepository';
import { UniverseMembershipRepository } from '../../../src/market-data/repository/UniverseMembershipRepository';
import { InstrumentRepository } from '../../../src/market-data/repository/InstrumentRepository';
import { StrategyVersionRepository } from '../../../src/strategy/repository/StrategyVersionRepository';
import { parseMoney } from '../../../src/common/utils/money';
import { CoinTierEnum, StrategyStatusEnum } from '@bot/shared';

const TEST_SYMBOL = 'TESTSTABLEUSDT';
const OPEN_TIME = new Date('2026-05-22T10:00:00.000Z');

// tick_aggregates is daily-RANGE-partitioned: the schema migration provisions a
// forward-only window [today, today+lookahead], and the runtime partition service
// extends it thereafter. A hardcoded past date lands outside any partition and
// fails with "no partition of relation". Anchor tick timestamps to the start of
// today (UTC) so the fixture always writes into a valid partition and never rots.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TODAY_START_MS = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;

describe('Repository integration tests (require Postgres with migrations run)', () => {
    let dataSource: DataSource;

    let candleRepo: CandleRepository;
    let openInterestRepo: OpenInterestRepository;
    let tickAggRepo: TickAggregateRepository;
    let fundingRateRepo: FundingRateRepository;
    let universeMembershipRepo: UniverseMembershipRepository;
    let instrumentRepo: InstrumentRepository;
    let strategyVersionRepo: StrategyVersionRepository;

    beforeAll(async () => {
        // Use the shared DataSource: migrations are run idempotently on first access
        // so this suite does not need to manage schema creation itself.
        dataSource = await getTestDataSource();

        const rawCandleRepo: Repository<CandleEntity> = dataSource.getRepository(CandleEntity);
        const rawOiRepo: Repository<OpenInterestEntity> = dataSource.getRepository(OpenInterestEntity);
        const rawTickRepo: Repository<TickAggregateEntity> = dataSource.getRepository(TickAggregateEntity);
        const rawFundingRepo: Repository<FundingRateEntity> = dataSource.getRepository(FundingRateEntity);
        const rawUniverseRepo: Repository<UniverseMembershipEntity> = dataSource.getRepository(UniverseMembershipEntity);
        const rawInstrumentRepo: Repository<InstrumentEntity> = dataSource.getRepository(InstrumentEntity);
        const rawStrategyVersionRepo: Repository<StrategyVersionEntity> = dataSource.getRepository(StrategyVersionEntity);

        candleRepo = new CandleRepository(rawCandleRepo);
        openInterestRepo = new OpenInterestRepository(rawOiRepo);
        tickAggRepo = new TickAggregateRepository(rawTickRepo);
        fundingRateRepo = new FundingRateRepository(rawFundingRepo);
        universeMembershipRepo = new UniverseMembershipRepository(rawUniverseRepo);
        instrumentRepo = new InstrumentRepository(rawInstrumentRepo);
        strategyVersionRepo = new StrategyVersionRepository(rawStrategyVersionRepo);
    }, 30_000);

    afterAll(async () => {
        // Clean test-specific rows so the DB stays consistent between runs.
        // We do NOT destroy the shared DataSource here — it is reused across suites
        // and torn down by the process exit or a global afterAll if needed.
        if (dataSource?.isInitialized) {
            await dataSource.query(`DELETE FROM candles WHERE symbol = $1`, [TEST_SYMBOL]);
            await dataSource.query(`DELETE FROM open_interest WHERE symbol = $1`, [TEST_SYMBOL]);
            await dataSource.query(`DELETE FROM tick_aggregates WHERE symbol = $1`, [TEST_SYMBOL]);
            await dataSource.query(`DELETE FROM funding_rates WHERE symbol = $1`, [TEST_SYMBOL]);
            await dataSource.query(`DELETE FROM universe_membership WHERE symbol = $1`, [TEST_SYMBOL]);
            await dataSource.query(`DELETE FROM instruments WHERE symbol = $1`, [TEST_SYMBOL]);
        }
    }, 30_000);

    // -------------------------------------------------------------------------
    // CandleRepository
    // -------------------------------------------------------------------------
    describe('CandleRepository.upsertClosed', () => {
        it('inserts a new candle row', async () => {
            await candleRepo.upsertClosed({
                symbol: TEST_SYMBOL,
                interval: '5m',
                openTime: OPEN_TIME,
                open: parseMoney('29000.0'),
                high: parseMoney('29500.0'),
                low: parseMoney('28900.0'),
                close: parseMoney('29300.0'),
                volume: parseMoney('1234.567890123456789'),
            });

            const rows = await dataSource.query(`SELECT * FROM candles WHERE symbol = $1 AND interval = $2 AND open_time = $3`, [TEST_SYMBOL, '5m', OPEN_TIME]);

            expect(rows).toHaveLength(1);
        });

        it('is idempotent: second upsert updates the row, does not duplicate or throw', async () => {
            const updatedClose = parseMoney('29400.0');

            await candleRepo.upsertClosed({
                symbol: TEST_SYMBOL,
                interval: '5m',
                openTime: OPEN_TIME,
                open: parseMoney('29000.0'),
                high: parseMoney('29600.0'),
                low: parseMoney('28900.0'),
                close: updatedClose,
                volume: parseMoney('1500.0'),
            });

            const rows = (await dataSource.query(`SELECT close FROM candles WHERE symbol = $1 AND interval = $2 AND open_time = $3`, [
                TEST_SYMBOL,
                '5m',
                OPEN_TIME,
            ])) as { close: string }[];

            // Still exactly one row — no duplicate.
            expect(rows).toHaveLength(1);
            // The close was updated — compare via decimal parse to handle DB trailing zeros.
            expect(parseMoney(rows[0]!.close).equals(parseMoney('29400'))).toBe(true);
        });

        it('stores NUMERIC with no float drift for an 18-decimal volume', async () => {
            const preciseVolume = '9876.543210987654321';
            const ts = new Date('2026-05-22T11:00:00.000Z');

            await candleRepo.upsertClosed({
                symbol: TEST_SYMBOL,
                interval: '1m',
                openTime: ts,
                open: parseMoney('100.0'),
                high: parseMoney('101.0'),
                low: parseMoney('99.0'),
                close: parseMoney('100.5'),
                volume: parseMoney(preciseVolume),
            });

            const rows = (await dataSource.query(`SELECT volume FROM candles WHERE symbol = $1 AND interval = '1m' AND open_time = $2`, [TEST_SYMBOL, ts])) as {
                volume: string;
            }[];

            expect(rows).toHaveLength(1);
            // The DB returns a numeric string — parse it and compare exactly.
            expect(parseMoney(rows[0]!.volume).equals(parseMoney(preciseVolume))).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // OpenInterestRepository
    // -------------------------------------------------------------------------
    describe('OpenInterestRepository.recordSample', () => {
        const oiTs = new Date('2026-05-22T10:05:00.000Z');

        it('inserts an OI sample', async () => {
            await openInterestRepo.recordSample({
                symbol: TEST_SYMBOL,
                ts: oiTs,
                value: parseMoney('5000000000.12345678'),
            });

            const rows = await dataSource.query(`SELECT * FROM open_interest WHERE symbol = $1 AND ts = $2`, [TEST_SYMBOL, oiTs]);

            expect(rows).toHaveLength(1);
        });

        it('is idempotent: replaying the same sample does not duplicate or throw', async () => {
            await openInterestRepo.recordSample({
                symbol: TEST_SYMBOL,
                ts: oiTs,
                value: parseMoney('5000000000.12345678'),
            });

            const rows = await dataSource.query(`SELECT * FROM open_interest WHERE symbol = $1 AND ts = $2`, [TEST_SYMBOL, oiTs]);

            expect(rows).toHaveLength(1);
        });
    });

    // -------------------------------------------------------------------------
    // TickAggregateRepository — idempotency + precision + spike reconstruction
    // -------------------------------------------------------------------------
    describe('TickAggregateRepository.recordSample', () => {
        const baseTs = new Date(TODAY_START_MS + 12 * 60 * 60 * 1000);

        it('inserts a tick sample', async () => {
            await tickAggRepo.recordSample({
                symbol: TEST_SYMBOL,
                ts: baseTs,
                open: parseMoney('29300.5'),
                high: parseMoney('29300.5'),
                low: parseMoney('29300.5'),
                close: parseMoney('29300.5'),
                volume: parseMoney('10.0'),
            });

            const rows = await dataSource.query(`SELECT * FROM tick_aggregates WHERE symbol = $1 AND ts = $2`, [TEST_SYMBOL, baseTs]);

            expect(rows).toHaveLength(1);
        });

        it('is idempotent: replaying the same tick does not duplicate or throw', async () => {
            await tickAggRepo.recordSample({
                symbol: TEST_SYMBOL,
                ts: baseTs,
                open: parseMoney('29300.5'),
                high: parseMoney('29300.5'),
                low: parseMoney('29300.5'),
                close: parseMoney('29300.5'),
                volume: parseMoney('10.0'),
            });

            const rows = await dataSource.query(`SELECT * FROM tick_aggregates WHERE symbol = $1 AND ts = $2`, [TEST_SYMBOL, baseTs]);

            expect(rows).toHaveLength(1);
        });

        it('NUMERIC close price survives DB round-trip with no float drift', async () => {
            const precisePrice = '29300.123456789012345678';
            const precisionTs = new Date(TODAY_START_MS + 12 * 60 * 60 * 1000 + 1000);

            await tickAggRepo.recordSample({
                symbol: TEST_SYMBOL,
                ts: precisionTs,
                open: parseMoney(precisePrice),
                high: parseMoney(precisePrice),
                low: parseMoney(precisePrice),
                close: parseMoney(precisePrice),
                volume: parseMoney('1.0'),
            });

            const rows = (await dataSource.query(`SELECT close FROM tick_aggregates WHERE symbol = $1 AND ts = $2`, [TEST_SYMBOL, precisionTs])) as {
                close: string;
            }[];

            expect(rows).toHaveLength(1);
            // Exact decimal equality — no float representation noise.
            expect(parseMoney(rows[0]!.close).equals(parseMoney(precisePrice))).toBe(true);
        });
    });

    describe('tick_aggregates — intra-candle spike reconstruction (M2 DoD)', () => {
        // A known 5-tick sequence representing a typical intra-candle spike:
        //   normal → spike up → spike down → recovery → normal
        const spikeSequence = [
            { offset: 0, price: '29300.0', volume: '5.0' },
            { offset: 1, price: '29800.0', volume: '50.0' }, // spike high
            { offset: 2, price: '28900.0', volume: '30.0' }, // spike low
            { offset: 3, price: '29350.0', volume: '8.0' },
            { offset: 4, price: '29320.0', volume: '6.0' },
        ];

        const spikeBase = new Date(TODAY_START_MS + 13 * 60 * 60 * 1000);
        const EXPECTED_HIGH = '29800.0';
        const EXPECTED_LOW = '28900.0';

        beforeAll(async () => {
            // One 1-second OHLCV bucket per tick — each bucket's O/H/L/C is the single price.
            for (const tick of spikeSequence) {
                await tickAggRepo.recordSample({
                    symbol: TEST_SYMBOL,
                    ts: new Date(spikeBase.getTime() + tick.offset * 1000),
                    open: parseMoney(tick.price),
                    high: parseMoney(tick.price),
                    low: parseMoney(tick.price),
                    close: parseMoney(tick.price),
                    volume: parseMoney(tick.volume),
                });
            }
        });

        it('reads tick rows back in ascending ts order', async () => {
            const fromTs = new Date(spikeBase.getTime() - 1);
            const toTs = new Date(spikeBase.getTime() + spikeSequence.length * 1000);
            const rows = await tickAggRepo.findRange(TEST_SYMBOL, fromTs, toTs);

            expect(rows).toHaveLength(spikeSequence.length);

            for (let i = 1; i < rows.length; i++) {
                expect(rows[i]!.ts.getTime()).toBeGreaterThan(rows[i - 1]!.ts.getTime());
            }
        });

        it('reconstructs the expected intra-candle high from the tick sequence', async () => {
            const fromTs = new Date(spikeBase.getTime() - 1);
            const toTs = new Date(spikeBase.getTime() + spikeSequence.length * 1000);
            const rows = await tickAggRepo.findRange(TEST_SYMBOL, fromTs, toTs);

            const high = rows.reduce((max, row) => (row.high.greaterThan(max) ? row.high : max), rows[0]!.high);

            expect(high.equals(parseMoney(EXPECTED_HIGH))).toBe(true);
        });

        it('reconstructs the expected intra-candle low from the tick sequence', async () => {
            const fromTs = new Date(spikeBase.getTime() - 1);
            const toTs = new Date(spikeBase.getTime() + spikeSequence.length * 1000);
            const rows = await tickAggRepo.findRange(TEST_SYMBOL, fromTs, toTs);

            const low = rows.reduce((min, row) => (row.low.lessThan(min) ? row.low : min), rows[0]!.low);

            expect(low.equals(parseMoney(EXPECTED_LOW))).toBe(true);
        });

        it('money values from tick rows are MoneyValue instances, not raw strings or floats', async () => {
            const fromTs = new Date(spikeBase.getTime() - 1);
            const toTs = new Date(spikeBase.getTime() + spikeSequence.length * 1000);
            const rows = await tickAggRepo.findRange(TEST_SYMBOL, fromTs, toTs);

            for (const row of rows) {
                // MoneyValue is a Decimal instance — it has the .toFixed() method.
                expect(typeof row.close.toFixed).toBe('function');
                expect(typeof (row.close as unknown as number)).not.toBe('number');
            }
        });
    });

    // -------------------------------------------------------------------------
    // FundingRateRepository
    // -------------------------------------------------------------------------
    describe('FundingRateRepository.recordObservation', () => {
        const fundingTime = new Date('2026-05-22T08:00:00.000Z');

        it('inserts a funding rate observation', async () => {
            await fundingRateRepo.recordObservation({
                symbol: TEST_SYMBOL,
                fundingTime,
                rate: parseMoney('0.0001000000'),
            });

            const rows = await dataSource.query(`SELECT * FROM funding_rates WHERE symbol = $1 AND funding_time = $2`, [TEST_SYMBOL, fundingTime]);

            expect(rows).toHaveLength(1);
        });

        it('is idempotent: replaying the same observation does not duplicate or throw', async () => {
            await fundingRateRepo.recordObservation({
                symbol: TEST_SYMBOL,
                fundingTime,
                rate: parseMoney('0.0001000000'),
            });

            const rows = await dataSource.query(`SELECT * FROM funding_rates WHERE symbol = $1 AND funding_time = $2`, [TEST_SYMBOL, fundingTime]);

            expect(rows).toHaveLength(1);
        });
    });

    // -------------------------------------------------------------------------
    // UniverseMembershipRepository — point-in-time timeline
    // -------------------------------------------------------------------------
    describe('UniverseMembershipRepository — point-in-time tier timeline', () => {
        const enterT1 = new Date('2026-05-01T00:00:00.000Z');
        const tierChangeTime = new Date('2026-05-10T00:00:00.000Z');
        const leaveTime = new Date('2026-05-20T00:00:00.000Z');

        afterEach(async () => {
            // Wipe between sub-tests so each runs independently.
            await dataSource.query(`DELETE FROM universe_membership WHERE symbol = $1`, [TEST_SYMBOL]);
        });

        it('openMembership creates an open row with left_at null', async () => {
            await universeMembershipRepo.openMembership(TEST_SYMBOL, CoinTierEnum.TIER_1, enterT1);

            const open = await universeMembershipRepo.findOpenMembership(TEST_SYMBOL);

            expect(open).not.toBeNull();
            expect(open!.symbol).toBe(TEST_SYMBOL);
            expect(open!.coinTier).toBe(CoinTierEnum.TIER_1);
            expect(open!.leftAt).toBeNull();
        });

        it('closeOpenMembership sets left_at on the open row', async () => {
            await universeMembershipRepo.openMembership(TEST_SYMBOL, CoinTierEnum.TIER_1, enterT1);
            await universeMembershipRepo.closeOpenMembership(TEST_SYMBOL, leaveTime);

            const open = await universeMembershipRepo.findOpenMembership(TEST_SYMBOL);

            expect(open).toBeNull();

            const rows = (await dataSource.query(`SELECT left_at FROM universe_membership WHERE symbol = $1`, [TEST_SYMBOL])) as { left_at: Date }[];

            expect(rows).toHaveLength(1);
            expect(rows[0]!.left_at).not.toBeNull();
        });

        it('tier change: close prior row and open a new row — gap-free timeline', async () => {
            // enter as TIER_1
            await universeMembershipRepo.openMembership(TEST_SYMBOL, CoinTierEnum.TIER_1, enterT1);

            // tier change → close the TIER_1 row, open a TIER_2 row
            await universeMembershipRepo.closeOpenMembership(TEST_SYMBOL, tierChangeTime);
            await universeMembershipRepo.openMembership(TEST_SYMBOL, CoinTierEnum.TIER_2, tierChangeTime);

            const rows = (await dataSource.query(`SELECT coin_tier, entered_at, left_at FROM universe_membership WHERE symbol = $1 ORDER BY entered_at`, [
                TEST_SYMBOL,
            ])) as { coin_tier: string; entered_at: Date; left_at: Date | null }[];

            // Two rows; no gap: TIER_1.left_at === TIER_2.entered_at
            expect(rows).toHaveLength(2);
            expect(rows[0]!.coin_tier).toBe(CoinTierEnum.TIER_1);
            expect(rows[0]!.left_at).not.toBeNull();
            expect(rows[1]!.coin_tier).toBe(CoinTierEnum.TIER_2);
            expect(rows[1]!.left_at).toBeNull();

            // Gap-free: prior row's left_at matches new row's entered_at.
            expect(new Date(rows[0]!.left_at!).getTime()).toBe(new Date(rows[1]!.entered_at).getTime());
        });

        it('findOpenMembership returns null when there is no open row', async () => {
            const open = await universeMembershipRepo.findOpenMembership(TEST_SYMBOL);

            expect(open).toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // InstrumentRepository
    // -------------------------------------------------------------------------
    describe('InstrumentRepository.upsertBySymbol', () => {
        it('inserts a new instrument row', async () => {
            await instrumentRepo.upsertBySymbol({
                symbol: TEST_SYMBOL,
                base: 'TEST',
                quote: 'USDT',
                status: 'TRADING',
                tickSize: parseMoney('0.01'),
                stepSize: parseMoney('0.001'),
                minNotional: parseMoney('5.0'),
                isTradable: true,
                volume24h: parseMoney('100000000.0'),
                coinTier: CoinTierEnum.TIER_1,
            });

            const found = await instrumentRepo.findBySymbol(TEST_SYMBOL);

            expect(found).not.toBeNull();
            expect(found!.symbol).toBe(TEST_SYMBOL);
            expect(found!.coinTier).toBe(CoinTierEnum.TIER_1);
        });

        it('is idempotent: upsert updates without duplicating on UNIQUE(symbol)', async () => {
            const updatedVolume = parseMoney('200000000.0');

            await instrumentRepo.upsertBySymbol({
                symbol: TEST_SYMBOL,
                base: 'TEST',
                quote: 'USDT',
                status: 'TRADING',
                tickSize: parseMoney('0.01'),
                stepSize: parseMoney('0.001'),
                minNotional: parseMoney('5.0'),
                isTradable: true,
                volume24h: updatedVolume,
                coinTier: CoinTierEnum.TIER_2,
            });

            const rows = await dataSource.query(`SELECT * FROM instruments WHERE symbol = $1`, [TEST_SYMBOL]);

            expect(rows).toHaveLength(1);

            const found = await instrumentRepo.findBySymbol(TEST_SYMBOL);

            expect(found!.coinTier).toBe(CoinTierEnum.TIER_2);
        });
    });

    // -------------------------------------------------------------------------
    // StrategyVersionRepository
    // -------------------------------------------------------------------------
    describe('StrategyVersionRepository.findActive', () => {
        it('returns at least one active strategy version after seeding', async () => {
            const active = await strategyVersionRepo.findActive();

            expect(active.length).toBeGreaterThanOrEqual(1);
        });

        it('returns only versions with status = active', async () => {
            const active = await strategyVersionRepo.findActive();

            for (const version of active) {
                expect(version.status).toBe(StrategyStatusEnum.ACTIVE);
            }
        });

        it('v0 is the only active seeded version (v1–v3 are draft)', async () => {
            const active = await strategyVersionRepo.findActive();
            const activeVersionNumbers = active.map((v) => v.version);

            expect(activeVersionNumbers).toContain(0);
            expect(activeVersionNumbers).not.toContain(1);
            expect(activeVersionNumbers).not.toContain(2);
            expect(activeVersionNumbers).not.toContain(3);
        });

        it('findByNameAndVersion returns the v0 row with correct direction', async () => {
            const v0 = await strategyVersionRepo.findByNameAndVersion('volatility-vwap', 0);

            expect(v0).not.toBeNull();
            expect(v0!.direction).toBe('mean_reversion');
            expect(v0!.status).toBe(StrategyStatusEnum.ACTIVE);
        });

        it('v0 params have trade_enabled set to false', async () => {
            const v0 = await strategyVersionRepo.findByNameAndVersion('volatility-vwap', 0);

            expect(v0!.params['trade_enabled']).toBe(false);
        });
    });
});
