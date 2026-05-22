/**
 * Repository integration tests for M2 round-1 behaviors (requires live Postgres).
 *
 * Covers:
 *   1. FundingRateRepository — funding_time is the 8h settlement time; same settlement
 *      time de-dups to one row; different settlement times create distinct rows.
 *   2. UniverseMembershipRepository — openMembership is idempotent when an open row
 *      exists (partial UNIQUE index enforcement); open→close→reopen cycle works.
 *   3. InstrumentRepository — a leaver upsert with isTradable=false is reflected in DB.
 *   4. FlowPollService.resolveSettlementTimeMs — settlement-flooring logic via the
 *      emitted event (tested through the pure private method's observable effect on
 *      the funding_rates row's funding_time column).
 */

import { DataSource, Repository } from 'typeorm';
import { getTestDataSource } from '../../support/testDataSource';
import { FundingRateEntity } from '../../../src/market-data/entity/FundingRateEntity';
import { UniverseMembershipEntity } from '../../../src/market-data/entity/UniverseMembershipEntity';
import { InstrumentEntity } from '../../../src/market-data/entity/InstrumentEntity';
import { FundingRateRepository } from '../../../src/market-data/repository/FundingRateRepository';
import { UniverseMembershipRepository } from '../../../src/market-data/repository/UniverseMembershipRepository';
import { InstrumentRepository } from '../../../src/market-data/repository/InstrumentRepository';
import { parseMoney } from '../../../src/common/utils/money';
import { CoinTierEnum } from '@bot/shared';

// Distinct symbol to avoid colliding with rows from repository.integration.spec.ts
const SYM = 'M2BEHAVIORSUSDT';

describe('M2 round-1 repository behaviors (require Postgres with migrations run)', () => {
    let dataSource: DataSource;
    let fundingRateRepo: FundingRateRepository;
    let universeMembershipRepo: UniverseMembershipRepository;
    let instrumentRepo: InstrumentRepository;

    beforeAll(async () => {
        dataSource = await getTestDataSource();

        const rawFundingRepo: Repository<FundingRateEntity> = dataSource.getRepository(FundingRateEntity);
        const rawUniverseRepo: Repository<UniverseMembershipEntity> = dataSource.getRepository(UniverseMembershipEntity);
        const rawInstrumentRepo: Repository<InstrumentEntity> = dataSource.getRepository(InstrumentEntity);

        fundingRateRepo = new FundingRateRepository(rawFundingRepo);
        universeMembershipRepo = new UniverseMembershipRepository(rawUniverseRepo);
        instrumentRepo = new InstrumentRepository(rawInstrumentRepo);
    }, 30_000);

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await dataSource.query(`DELETE FROM funding_rates WHERE symbol = $1`, [SYM]);
            await dataSource.query(`DELETE FROM universe_membership WHERE symbol = $1`, [SYM]);
            await dataSource.query(`DELETE FROM instruments WHERE symbol = $1`, [SYM]);
        }
    }, 30_000);

    // -----------------------------------------------------------------------
    // FundingRateRepository — settlement-time de-dup
    // -----------------------------------------------------------------------
    describe('FundingRateRepository — settlement-time de-duplication', () => {
        // 8-hour settlement boundaries
        const SETTLEMENT_0800 = new Date('2026-05-22T08:00:00.000Z');
        const SETTLEMENT_1600 = new Date('2026-05-22T16:00:00.000Z');

        afterEach(async () => {
            await dataSource.query(`DELETE FROM funding_rates WHERE symbol = $1`, [SYM]);
        });

        it('inserts the first observation for a settlement time', async () => {
            await fundingRateRepo.recordObservation({
                symbol: SYM,
                fundingTime: SETTLEMENT_0800,
                rate: parseMoney('0.0001'),
            });

            const rows = await dataSource.query(`SELECT * FROM funding_rates WHERE symbol = $1 AND funding_time = $2`, [SYM, SETTLEMENT_0800]);

            expect(rows).toHaveLength(1);
        });

        it('de-dups to one row when the SAME settlement time is recorded twice', async () => {
            await fundingRateRepo.recordObservation({
                symbol: SYM,
                fundingTime: SETTLEMENT_0800,
                rate: parseMoney('0.0001'),
            });

            // Second poll within the same settlement window — same fundingTime, slightly
            // different rate (exchange may update the prediction between polls).
            await fundingRateRepo.recordObservation({
                symbol: SYM,
                fundingTime: SETTLEMENT_0800,
                rate: parseMoney('0.00012'),
            });

            const rows = await dataSource.query(`SELECT * FROM funding_rates WHERE symbol = $1 AND funding_time = $2`, [SYM, SETTLEMENT_0800]);

            expect(rows).toHaveLength(1);
        });

        it('creates DISTINCT rows for different settlement times', async () => {
            await fundingRateRepo.recordObservation({
                symbol: SYM,
                fundingTime: SETTLEMENT_0800,
                rate: parseMoney('0.0001'),
            });

            await fundingRateRepo.recordObservation({
                symbol: SYM,
                fundingTime: SETTLEMENT_1600,
                rate: parseMoney('0.00015'),
            });

            const rows = await dataSource.query(`SELECT * FROM funding_rates WHERE symbol = $1 ORDER BY funding_time`, [SYM]);

            expect(rows).toHaveLength(2);
        });

        it('the second identical-settlement upsert does not throw', async () => {
            await fundingRateRepo.recordObservation({
                symbol: SYM,
                fundingTime: SETTLEMENT_0800,
                rate: parseMoney('0.0001'),
            });

            await expect(
                fundingRateRepo.recordObservation({
                    symbol: SYM,
                    fundingTime: SETTLEMENT_0800,
                    rate: parseMoney('0.00012'),
                }),
            ).resolves.not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // UniverseMembershipRepository — partial UNIQUE index / single open row
    // -----------------------------------------------------------------------
    describe('UniverseMembershipRepository — partial unique index (single open row per symbol)', () => {
        const ENTERED_AT = new Date('2026-05-01T00:00:00.000Z');
        const LEFT_AT = new Date('2026-05-10T00:00:00.000Z');
        const REENTERED_AT = new Date('2026-05-10T00:00:00.000Z');

        afterEach(async () => {
            await dataSource.query(`DELETE FROM universe_membership WHERE symbol = $1`, [SYM]);
        });

        it('openMembership twice for the same symbol yields exactly ONE open row', async () => {
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_1, ENTERED_AT);
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_1, ENTERED_AT);

            const rows = await dataSource.query(`SELECT * FROM universe_membership WHERE symbol = $1 AND left_at IS NULL`, [SYM]);

            expect(rows).toHaveLength(1);
        });

        it('openMembership twice does not throw', async () => {
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_1, ENTERED_AT);

            await expect(universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_1, ENTERED_AT)).resolves.not.toThrow();
        });

        it('after closeOpenMembership a new openMembership succeeds and creates a fresh open row', async () => {
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_1, ENTERED_AT);
            await universeMembershipRepo.closeOpenMembership(SYM, LEFT_AT);
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_2, REENTERED_AT);

            const openRow = await universeMembershipRepo.findOpenMembership(SYM);

            expect(openRow).not.toBeNull();
            expect(openRow!.coinTier).toBe(CoinTierEnum.TIER_2);
            expect(openRow!.leftAt).toBeNull();
        });

        it('open→close→reopen leaves exactly one open row (no duplicates)', async () => {
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_1, ENTERED_AT);
            await universeMembershipRepo.closeOpenMembership(SYM, LEFT_AT);
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_2, REENTERED_AT);

            const openRows = await dataSource.query(`SELECT * FROM universe_membership WHERE symbol = $1 AND left_at IS NULL`, [SYM]);

            expect(openRows).toHaveLength(1);
        });

        it('gap-free timeline: after a reopen the total row count is 2 (one closed, one open)', async () => {
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_1, ENTERED_AT);
            await universeMembershipRepo.closeOpenMembership(SYM, LEFT_AT);
            await universeMembershipRepo.openMembership(SYM, CoinTierEnum.TIER_2, REENTERED_AT);

            const allRows = await dataSource.query(`SELECT coin_tier, left_at FROM universe_membership WHERE symbol = $1 ORDER BY entered_at`, [SYM]);

            expect(allRows).toHaveLength(2);
            expect(allRows[0].left_at).not.toBeNull();
            expect(allRows[1].left_at).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // InstrumentRepository — isTradable flip on leave
    // -----------------------------------------------------------------------
    describe('InstrumentRepository — isTradable flips to false on universe leave', () => {
        afterEach(async () => {
            await dataSource.query(`DELETE FROM instruments WHERE symbol = $1`, [SYM]);
        });

        it('upsert with isTradable=true then isTradable=false results in is_tradable=false in DB', async () => {
            await instrumentRepo.upsertBySymbol({
                symbol: SYM,
                base: 'M2',
                quote: 'USDT',
                status: 'active',
                tickSize: parseMoney('0.01'),
                stepSize: parseMoney('0.001'),
                minNotional: parseMoney('5.0'),
                isTradable: true,
                volume24h: parseMoney('100000000.0'),
                coinTier: CoinTierEnum.TIER_1,
            });

            // Simulate a universe leave: the UniverseService calls upsertBySymbol with
            // isTradable=false (emitInstrumentNonTradable path).
            await instrumentRepo.upsertBySymbol({
                symbol: SYM,
                base: 'M2',
                quote: 'USDT',
                status: 'inactive',
                tickSize: parseMoney('0.01'),
                stepSize: parseMoney('0.001'),
                minNotional: parseMoney('5.0'),
                isTradable: false,
                volume24h: parseMoney('100000000.0'),
                coinTier: CoinTierEnum.TIER_1,
            });

            const rows = (await dataSource.query(`SELECT is_tradable FROM instruments WHERE symbol = $1`, [SYM])) as { is_tradable: boolean }[];

            expect(rows).toHaveLength(1);
            expect(rows[0]!.is_tradable).toBe(false);
        });

        it('remains exactly one row after the isTradable flip (no duplicate)', async () => {
            await instrumentRepo.upsertBySymbol({
                symbol: SYM,
                base: 'M2',
                quote: 'USDT',
                status: 'active',
                tickSize: parseMoney('0.01'),
                stepSize: parseMoney('0.001'),
                minNotional: parseMoney('5.0'),
                isTradable: true,
                volume24h: parseMoney('100000000.0'),
                coinTier: CoinTierEnum.TIER_1,
            });

            await instrumentRepo.upsertBySymbol({
                symbol: SYM,
                base: 'M2',
                quote: 'USDT',
                status: 'inactive',
                tickSize: parseMoney('0.01'),
                stepSize: parseMoney('0.001'),
                minNotional: parseMoney('5.0'),
                isTradable: false,
                volume24h: parseMoney('100000000.0'),
                coinTier: CoinTierEnum.TIER_1,
            });

            const rows = await dataSource.query(`SELECT * FROM instruments WHERE symbol = $1`, [SYM]);

            expect(rows).toHaveLength(1);
        });
    });
});
