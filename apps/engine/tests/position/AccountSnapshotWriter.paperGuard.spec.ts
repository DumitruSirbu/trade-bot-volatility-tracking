/**
 * M11a R2a Item 2 (BLOCKER B2 + HIGH H3 — ADR 0032 §3).
 *
 * Asserts the env-gate on `AccountSnapshotWriter`:
 *   - `EXCHANGE_ENV=paper` → `scheduledTick()` / `writeNow()` are no-ops; no
 *     `accountState.fetchBalance` call, no `account_snapshots` row insert.
 *   - `EXCHANGE_ENV=testnet` → the writer runs as before (covered by W7.spec;
 *     this file's positive case is a thin smoke).
 *
 * R2b lands `PaperAccountStateService` + `paper_account_snapshots` and the
 * sibling writer that goes through the three-table atomic-write path (D16).
 */

import { IAccountStateSource } from '@bot/shared';

import { AccountSnapshotRepository } from '../../src/position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { AccountSnapshotWriter } from '../../src/position/service/AccountSnapshotWriter';

function buildGuardHarness(env: 'paper' | 'testnet') {
    const fetchBalance = jest.fn().mockResolvedValue([{ asset: 'USDT', total: '0', free: '0', used: '0' }]);
    const accountState = { fetchBalance } as unknown as IAccountStateSource;
    const findOpen = jest.fn().mockResolvedValue([]);
    const positions = { findOpen } as unknown as PositionRepository;
    const transactions = { findByPosition: jest.fn().mockResolvedValue([]) } as unknown as TransactionRepository;
    const save = jest.fn();
    const buildSnapshot = jest.fn();
    const snapshots = { save, buildSnapshot } as unknown as AccountSnapshotRepository;
    const riskGate = { isRecoveryReady: jest.fn().mockReturnValue(true) } as never;
    const appConfig = { exchangeEnv: env } as never;

    const writer = new AccountSnapshotWriter(accountState, positions, transactions, snapshots, riskGate, appConfig);

    return { writer, fetchBalance, save, findOpen };
}

describe('AccountSnapshotWriter — PAPER env-gate', () => {
    it('EXCHANGE_ENV=paper: writeNow is a no-op (no port calls, no row insert)', async () => {
        const harness = buildGuardHarness('paper');

        const row = await harness.writer.writeNow(1_700_000_000_000, 'boot');

        expect(row).toBeNull();
        expect(harness.fetchBalance).not.toHaveBeenCalled();
        expect(harness.findOpen).not.toHaveBeenCalled();
        expect(harness.save).not.toHaveBeenCalled();
    });

    it('EXCHANGE_ENV=paper: scheduledTick is a no-op', async () => {
        const harness = buildGuardHarness('paper');

        await harness.writer.scheduledTick();

        expect(harness.fetchBalance).not.toHaveBeenCalled();
        expect(harness.save).not.toHaveBeenCalled();
    });

    it('EXCHANGE_ENV=testnet: writeNow reaches fetchBalance and persists (positive control)', async () => {
        const harness = buildGuardHarness('testnet');

        await harness.writer.writeNow(1_700_000_000_000, 'boot');

        expect(harness.fetchBalance).toHaveBeenCalledTimes(1);
        expect(harness.save).toHaveBeenCalledTimes(1);
    });
});
