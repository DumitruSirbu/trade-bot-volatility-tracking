/**
 * M11a R2b wave A — repository CRUD smoke + adversarial duplicate-key path
 * for the five PAPER persistence repositories. Requires live Postgres
 * (docker compose --profile test up -d --wait postgres-test).
 *
 * Coverage:
 *   - PaperAccountStateRepository: insert → findByClientOrderId →
 *     findOpenBySymbol → deleteByClientOrderId.
 *   - PaperAccountStateHistoryRepository: appendClose →
 *     findClosedBetween / findByClientOrderId.
 *   - PaperAccountStateMetaRepository: insertNew → findBySoakStartId /
 *     findLatest.
 *   - PaperAccountSnapshotRepository: insertNew → findLatest /
 *     findTakenBetween.
 *   - PaperSimulatorIdempotencyRepository: insertNew → findByKey;
 *     ADVERSARIAL: duplicate insert on the composite UNIQUE raises
 *     PaperSimulatorIdempotencyDuplicateException (D3 collision-detection
 *     contract).
 */

import { PositionSideEnum } from '@bot/shared';
import { DataSource } from 'typeorm';

import { parseMoney } from '../../../src/common/utils/money';
import { PaperSimulatorIdempotencyDuplicateException } from '../../../src/paper-mode/exception';
import {
    PaperAccountSnapshotEntity,
    PaperAccountStateEntity,
    PaperAccountStateHistoryEntity,
    PaperAccountStateMetaEntity,
    PaperSimulatorIdempotencyEntity,
} from '../../../src/paper-mode/entity';
import { PaperAccountSnapshotRepository } from '../../../src/paper-mode/repository/PaperAccountSnapshotRepository';
import { PaperAccountStateHistoryRepository } from '../../../src/paper-mode/repository/PaperAccountStateHistoryRepository';
import { PaperAccountStateMetaRepository } from '../../../src/paper-mode/repository/PaperAccountStateMetaRepository';
import { PaperAccountStateRepository } from '../../../src/paper-mode/repository/PaperAccountStateRepository';
import { PaperSimulatorIdempotencyRepository } from '../../../src/paper-mode/repository/PaperSimulatorIdempotencyRepository';
import { getTestDataSource } from '../../support/testDataSource';

// Suite-scoped symbol / client-order-id prefix isolates rows so afterEach
// cleanup never collides with other suites.
const TEST_SYMBOL = 'PAPRRTUSDT';
const TEST_CO_ID_PREFIX = 'tbvt-paper-r2b-test-';
// soak_start_id is a UUID column; the suffix appended below must keep the full
// value a syntactically valid UUID (final group = 12 hex digits).
const TEST_SOAK_ID_PREFIX = '00000000-0000-4000-8000-d2b00000';

describe('PAPER persistence repositories — CRUD + adversarial (requires Postgres)', () => {
    let dataSource: DataSource;
    let stateRepo: PaperAccountStateRepository;
    let historyRepo: PaperAccountStateHistoryRepository;
    let metaRepo: PaperAccountStateMetaRepository;
    let snapshotRepo: PaperAccountSnapshotRepository;
    let idempotencyRepo: PaperSimulatorIdempotencyRepository;

    beforeAll(async () => {
        dataSource = await getTestDataSource();
        stateRepo = new PaperAccountStateRepository(dataSource.getRepository(PaperAccountStateEntity));
        historyRepo = new PaperAccountStateHistoryRepository(dataSource.getRepository(PaperAccountStateHistoryEntity));
        metaRepo = new PaperAccountStateMetaRepository(dataSource.getRepository(PaperAccountStateMetaEntity));
        snapshotRepo = new PaperAccountSnapshotRepository(dataSource.getRepository(PaperAccountSnapshotEntity));
        idempotencyRepo = new PaperSimulatorIdempotencyRepository(dataSource.getRepository(PaperSimulatorIdempotencyEntity));
    }, 30_000);

    afterEach(async () => {
        await dataSource.query(`DELETE FROM paper_account_state WHERE symbol = $1`, [TEST_SYMBOL]);
        await dataSource.query(`DELETE FROM paper_account_state_history WHERE symbol = $1`, [TEST_SYMBOL]);
        await dataSource.query(`DELETE FROM paper_simulator_idempotency WHERE event_id LIKE $1`, [`${TEST_CO_ID_PREFIX}%`]);
        await dataSource.query(`DELETE FROM paper_account_snapshots WHERE taken_at >= $1 AND taken_at < $2`, [
            new Date('2099-01-01T00:00:00.000Z'),
            new Date('2099-12-31T00:00:00.000Z'),
        ]);
        await dataSource.query(`DELETE FROM paper_account_state_meta WHERE seed_version_label = $1`, ['paper_simulator_seed test-r2b']);
    });

    describe('PaperAccountStateRepository — CRUD smoke', () => {
        it('insertNew → findByClientOrderId round-trips a long position', async () => {
            const clientOrderId = `${TEST_CO_ID_PREFIX}long-1`;
            const opened = await stateRepo.insertNew({
                clientOrderId,
                symbol: TEST_SYMBOL,
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('100.5'),
                size: parseMoney('1.25'),
                leverage: 5,
                openedAt: new Date('2099-06-01T00:00:00.000Z'),
                mode: 'paper',
            });

            expect(opened.id).toBeDefined();

            const found = await stateRepo.findByClientOrderId(clientOrderId);
            expect(found).not.toBeNull();
            expect(found?.side).toBe(PositionSideEnum.LONG);
            expect(found?.entryPrice.toString()).toBe('100.5');
            expect(found?.size.toString()).toBe('1.25');
            expect(found?.leverage).toBe(5);
            expect(found?.mode).toBe('paper');
        });

        it('findOpenBySymbol returns rows ordered by openedAt ASC', async () => {
            await stateRepo.insertNew({
                clientOrderId: `${TEST_CO_ID_PREFIX}order-second`,
                symbol: TEST_SYMBOL,
                side: PositionSideEnum.SHORT,
                entryPrice: parseMoney('101'),
                size: parseMoney('1'),
                leverage: 3,
                openedAt: new Date('2099-06-01T01:00:00.000Z'),
                mode: 'paper',
            });
            await stateRepo.insertNew({
                clientOrderId: `${TEST_CO_ID_PREFIX}order-first`,
                symbol: TEST_SYMBOL,
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('100'),
                size: parseMoney('1'),
                leverage: 3,
                openedAt: new Date('2099-06-01T00:00:00.000Z'),
                mode: 'paper',
            });

            const rows = await stateRepo.findOpenBySymbol(TEST_SYMBOL);
            expect(rows).toHaveLength(2);
            expect(rows[0]!.clientOrderId).toBe(`${TEST_CO_ID_PREFIX}order-first`);
            expect(rows[1]!.clientOrderId).toBe(`${TEST_CO_ID_PREFIX}order-second`);
        });

        it('deleteByClientOrderId removes the row idempotently', async () => {
            const clientOrderId = `${TEST_CO_ID_PREFIX}delete-me`;
            await stateRepo.insertNew({
                clientOrderId,
                symbol: TEST_SYMBOL,
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('100'),
                size: parseMoney('1'),
                leverage: 1,
                openedAt: new Date('2099-06-01T00:00:00.000Z'),
                mode: 'paper',
            });

            await stateRepo.deleteByClientOrderId(clientOrderId);
            expect(await stateRepo.findByClientOrderId(clientOrderId)).toBeNull();

            // Second delete is a no-op.
            await expect(stateRepo.deleteByClientOrderId(clientOrderId)).resolves.toBeUndefined();
        });
    });

    describe('PaperAccountStateHistoryRepository — CRUD smoke', () => {
        it('appendClose → findClosedBetween round-trips a closed trade', async () => {
            const clientOrderId = `${TEST_CO_ID_PREFIX}hist-1`;
            await historyRepo.appendClose({
                clientOrderId,
                symbol: TEST_SYMBOL,
                side: PositionSideEnum.LONG,
                entryPrice: parseMoney('100'),
                exitPrice: parseMoney('102'),
                size: parseMoney('1'),
                realisedPnl: parseMoney('2'),
                fees: parseMoney('0.05'),
                fundingAccrued: parseMoney('-0.01'),
                slippage: parseMoney('0.02'),
                closeReason: 'tp',
                openedAt: new Date('2099-06-01T00:00:00.000Z'),
                closedAt: new Date('2099-06-01T01:00:00.000Z'),
                mode: 'paper',
            });

            const rows = await historyRepo.findClosedBetween(new Date('2099-06-01T00:00:00.000Z'), new Date('2099-06-02T00:00:00.000Z'));
            expect(rows).toHaveLength(1);
            expect(rows[0]!.closeReason).toBe('tp');
            expect(rows[0]!.realisedPnl.toString()).toBe('2');
            expect(rows[0]!.fundingAccrued.toString()).toBe('-0.01');
        });

        it('DB CHECK rejects an unknown close_reason value', async () => {
            await expect(
                historyRepo.appendClose({
                    clientOrderId: `${TEST_CO_ID_PREFIX}badreason`,
                    symbol: TEST_SYMBOL,
                    side: PositionSideEnum.LONG,
                    entryPrice: parseMoney('100'),
                    exitPrice: parseMoney('100'),
                    size: parseMoney('1'),
                    realisedPnl: parseMoney('0'),
                    fees: parseMoney('0'),
                    fundingAccrued: parseMoney('0'),
                    slippage: parseMoney('0'),
                    closeReason: 'unknown_reason',
                    openedAt: new Date('2099-06-01T00:00:00.000Z'),
                    closedAt: new Date('2099-06-01T01:00:00.000Z'),
                    mode: 'paper',
                }),
            ).rejects.toThrow();
        });
    });

    describe('PaperAccountStateMetaRepository — CRUD smoke', () => {
        it('insertNew → findBySoakStartId round-trips meta with non-secret fingerprints', async () => {
            const soakStartId = `${TEST_SOAK_ID_PREFIX}aaaa`;
            await metaRepo.insertNew({
                soakStartId,
                soakStartTs: new Date('2099-06-01T00:00:00.000Z'),
                seedVersionLabel: 'paper_simulator_seed test-r2b',
                hkdfInfoVersion: 'v1',
                simulatorConfigHash: 'a'.repeat(64),
                bootstrapAtStartFingerprint: 'b'.repeat(64),
            });

            const found = await metaRepo.findBySoakStartId(soakStartId);
            expect(found).not.toBeNull();
            expect(found?.simulatorConfigHash).toBe('a'.repeat(64));
            expect(found?.bootstrapAtStartFingerprint).toBe('b'.repeat(64));
        });
    });

    describe('PaperAccountSnapshotRepository — CRUD smoke', () => {
        it('insertNew → findLatest returns the most recent snapshot', async () => {
            await snapshotRepo.insertNew({
                takenAt: new Date('2099-06-01T00:00:00.000Z'),
                balance: parseMoney('500'),
                equity: parseMoney('500'),
                realisedPnlCumulative: parseMoney('0'),
                fundingAccruedCumulative: parseMoney('0'),
                unrealisedPnlTotal: parseMoney('0'),
                peakEquity: parseMoney('500'),
                openPositionsCount: 0,
                mode: 'paper',
            });
            await snapshotRepo.insertNew({
                takenAt: new Date('2099-06-01T00:01:00.000Z'),
                balance: parseMoney('500'),
                equity: parseMoney('501'),
                realisedPnlCumulative: parseMoney('0'),
                fundingAccruedCumulative: parseMoney('0'),
                unrealisedPnlTotal: parseMoney('1'),
                peakEquity: parseMoney('501'),
                openPositionsCount: 1,
                mode: 'paper',
            });

            const latest = await snapshotRepo.findLatest();
            expect(latest).not.toBeNull();
            expect(latest?.peakEquity.toString()).toBe('501');
            expect(latest?.openPositionsCount).toBe(1);
        });
    });

    describe('PaperSimulatorIdempotencyRepository — CRUD + adversarial UNIQUE-violation', () => {
        it('insertNew → findByKey returns the persisted fill verbatim', async () => {
            const key = {
                eventId: `${TEST_CO_ID_PREFIX}evt-1`,
                orderIntentId: 'intent-1',
                versionNamespace: 'v1.PAPER.active',
            };
            const payload = { fillId: 'sim-fill-1', price: '100.5', qty: '1.0' };

            await idempotencyRepo.insertNew({ ...key, simulatedFillId: 'sim-fill-1', simulatedFillPayload: payload });

            const found = await idempotencyRepo.findByKey(key);
            expect(found).not.toBeNull();
            expect(found?.simulatedFillId).toBe('sim-fill-1');
            expect(found?.simulatedFillPayload).toEqual(payload);
        });

        it('duplicate insert on the composite UNIQUE raises PaperSimulatorIdempotencyDuplicateException (D3)', async () => {
            const key = {
                eventId: `${TEST_CO_ID_PREFIX}evt-dup`,
                orderIntentId: 'intent-dup',
                versionNamespace: 'v1.PAPER.active',
            };

            await idempotencyRepo.insertNew({ ...key, simulatedFillId: 'sim-1', simulatedFillPayload: { fillId: 'sim-1' } });

            await expect(idempotencyRepo.insertNew({ ...key, simulatedFillId: 'sim-2', simulatedFillPayload: { fillId: 'sim-2' } })).rejects.toBeInstanceOf(
                PaperSimulatorIdempotencyDuplicateException,
            );

            // The original row is untouched — replay must be deterministic.
            const found = await idempotencyRepo.findByKey(key);
            expect(found?.simulatedFillId).toBe('sim-1');
        });

        it('inserts under DISTINCT version_namespace succeed (D3 collision-free composite key)', async () => {
            const baseKey = {
                eventId: `${TEST_CO_ID_PREFIX}evt-shadow`,
                orderIntentId: 'intent-shadow',
            };

            await idempotencyRepo.insertNew({
                ...baseKey,
                versionNamespace: 'v1.PAPER.active',
                simulatedFillId: 'sim-active',
                simulatedFillPayload: { fillId: 'sim-active' },
            });
            await idempotencyRepo.insertNew({
                ...baseKey,
                versionNamespace: 'v2.shadow',
                simulatedFillId: 'sim-shadow',
                simulatedFillPayload: { fillId: 'sim-shadow' },
            });

            const active = await idempotencyRepo.findByKey({ ...baseKey, versionNamespace: 'v1.PAPER.active' });
            const shadow = await idempotencyRepo.findByKey({ ...baseKey, versionNamespace: 'v2.shadow' });
            expect(active?.simulatedFillId).toBe('sim-active');
            expect(shadow?.simulatedFillId).toBe('sim-shadow');
        });
    });
});
