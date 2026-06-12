/**
 * M11a R2a Item 2 (BLOCKER B2 + HIGH H3 — ADR 0032 §3).
 *
 * Asserts the env-gate on `ReconciliationService.runTickNow`:
 *   - `EXCHANGE_ENV=paper` → `tick()` / `forceTick()` are no-ops; no port
 *     calls reach `IAccountStateSource` or `CcxtExecutionClient`.
 *   - `EXCHANGE_ENV=testnet`/`live` → the existing reconciliation pass runs
 *     (covered by the broader `ReconciliationService.spec.ts`; this file's
 *     positive case is a thin smoke).
 *
 * R2d wires `PaperReconciliationAdapter` against the simulated state; until
 * then PAPER reconciliation is a structural no-op, not a "try and log."
 */

import { EventEmitter2 } from '@nestjs/event-emitter';

import { HaltFlagService } from '../../src/common/service/HaltFlagService';
import { LocalProtectiveMonitor } from '../../src/execution/service/LocalProtectiveMonitor';
import { SharedCloseCoordinator } from '../../src/execution/service/SharedCloseCoordinator';
import { PositionRepository } from '../../src/position/repository/PositionRepository';
import { TransactionRepository } from '../../src/position/repository/TransactionRepository';
import { PositionService } from '../../src/position/service/PositionService';
import { ReconciliationService } from '../../src/position/service/ReconciliationService';
import { RiskGateService } from '../../src/risk/service/RiskGateService';
import { SubscriptionRetainer } from '../../src/market-data/service/SubscriptionRetainer';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';

const NOW_MS = 1_700_000_000_000;

function buildGuardHarness(env: 'paper' | 'testnet' | 'live') {
    const accountState = {
        fetchPositions: jest.fn().mockResolvedValue([]),
        fetchOpenOrders: jest.fn().mockResolvedValue([]),
        fetchFundingHistory: jest.fn().mockResolvedValue([]),
    };
    const ccxtExecutionClient = { fetchOrderByClientId: jest.fn() };
    const positions = { findOpen: jest.fn().mockResolvedValue([]), findNonTerminal: jest.fn().mockResolvedValue([]) };
    const transactions = { findLatestByPositionId: jest.fn().mockResolvedValue(null) };
    const positionService = { transition: jest.fn(), finalizeRealizedPnl: jest.fn(), recordFunding: jest.fn() };
    const riskGate = { expireStaleReservations: jest.fn() };
    const monitor = { arm: jest.fn(), disarm: jest.fn() };
    const retainer = new SubscriptionRetainer();
    const strategyVersions = { findByNameAndVersion: jest.fn().mockResolvedValue({ id: 1 }) };
    const haltFlag = new HaltFlagService();
    const instrumentor = { setLiquidationPrice: jest.fn() } as never;
    const snapshotWriterMock = { writeNow: jest.fn().mockResolvedValue(null) };
    const snapshotWriter = snapshotWriterMock as never;
    const events = new EventEmitter2();
    const appConfig = { exchangeEnv: env } as never;

    const service = new ReconciliationService(
        accountState as never,
        ccxtExecutionClient as never,
        appConfig,
        positions as unknown as PositionRepository,
        transactions as unknown as TransactionRepository,
        positionService as unknown as PositionService,
        riskGate as unknown as RiskGateService,
        monitor as unknown as LocalProtectiveMonitor,
        retainer,
        strategyVersions as unknown as StrategyVersionRepository,
        haltFlag,
        instrumentor,
        snapshotWriter,
        events,
        new SharedCloseCoordinator(),
    );

    return { service, accountState, ccxtExecutionClient, positions, riskGate, snapshotWriter: snapshotWriterMock };
}

describe('ReconciliationService — PAPER env-gate', () => {
    it('EXCHANGE_ENV=paper: scheduled tick is a no-op (no port calls)', async () => {
        const harness = buildGuardHarness('paper');

        const pass = await harness.service.tick(NOW_MS);

        expect(pass.errors).toBe(0);
        expect(pass.driftsByCase.exchange_not_in_db).toBe(0);
        expect(harness.accountState.fetchPositions).not.toHaveBeenCalled();
        expect(harness.accountState.fetchOpenOrders).not.toHaveBeenCalled();
        expect(harness.accountState.fetchFundingHistory).not.toHaveBeenCalled();
        expect(harness.ccxtExecutionClient.fetchOrderByClientId).not.toHaveBeenCalled();
        expect(harness.positions.findOpen).not.toHaveBeenCalled();
        expect(harness.positions.findNonTerminal).not.toHaveBeenCalled();
        expect(harness.riskGate.expireStaleReservations).not.toHaveBeenCalled();
        expect(harness.snapshotWriter.writeNow).not.toHaveBeenCalled();
    });

    it('EXCHANGE_ENV=paper: forceTick is also a no-op', async () => {
        const harness = buildGuardHarness('paper');

        await harness.service.forceTick(NOW_MS);

        expect(harness.accountState.fetchPositions).not.toHaveBeenCalled();
        expect(harness.positions.findOpen).not.toHaveBeenCalled();
        expect(harness.positions.findNonTerminal).not.toHaveBeenCalled();
    });

    it('EXCHANGE_ENV=testnet: tick reaches the port (positive control)', async () => {
        const harness = buildGuardHarness('testnet');

        await harness.service.tick(NOW_MS);

        expect(harness.accountState.fetchPositions).toHaveBeenCalledTimes(1);
        expect(harness.accountState.fetchOpenOrders).toHaveBeenCalledTimes(1);
    });
});
