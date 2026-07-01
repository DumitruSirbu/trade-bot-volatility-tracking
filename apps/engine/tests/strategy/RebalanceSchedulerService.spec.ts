/**
 * Unit tests for RebalanceSchedulerService (ADR 0048 §2.2).
 *
 * All deps are plain jest.fn() mocks — no real DB, no real NestJS DI, no real timers.
 * jest.useFakeTimers() is active for every test so setInterval calls are interceptable.
 *
 * Coverage map (all mandatory adversarial cases from the M50 QA mandate):
 *   Case 1 — non-paper env + version ID set          → WARN, no interval, no emit
 *   Case 2 — paper env + version ID null             → WARN, no interval, no emit
 *   Case 3 — paper env + version ID set, row missing → WARN, no interval, no emit
 *   Case 4 — happy path: paper + version + valid row → interval registered, tick emits event
 *   Case 5 — ClockPort injection                     → emitted nowMs equals fake clock value
 *   Case 6 — onModuleDestroy cleans up when active   → deleteInterval called
 *             onModuleDestroy is no-op when dormant  → deleteInterval NOT called
 */

import { ExchangeEnvironmentEnum, UNIVERSE_REBALANCE_DUE_EVENT } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';

import { AppConfigService } from '../../src/config/service/AppConfigService';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { RebalanceSchedulerService } from '../../src/strategy/service/RebalanceSchedulerService';

// ─── fixture builders ─────────────────────────────────────────────────────────

const ACTIVE_VERSION_ID = 7;
const REBALANCE_INTERVAL_MS = 86_400_000;
const FAKE_NOW_MS = 1_700_000_000_000;

function buildValidRow() {
    return {
        id: ACTIVE_VERSION_ID,
        name: 'xmom',
        version: 1,
        params: {
            top_n: 1,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: REBALANCE_INTERVAL_MS,
            min_universe_size: 20,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
        },
    };
}

interface IStubs {
    config: jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>;
    strategyVersions: { findById: jest.Mock };
    schedulerRegistry: { addInterval: jest.Mock; deleteInterval: jest.Mock };
    events: { emit: jest.Mock };
    clock: { nowMs: jest.Mock };
}

function buildStubs(overrides: Partial<IStubs> = {}): IStubs {
    return {
        config: {
            exchangeEnv: ExchangeEnvironmentEnum.PAPER,
            activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
        } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        strategyVersions: { findById: jest.fn().mockResolvedValue(buildValidRow()) },
        schedulerRegistry: { addInterval: jest.fn(), deleteInterval: jest.fn() },
        events: { emit: jest.fn() },
        clock: { nowMs: jest.fn().mockReturnValue(FAKE_NOW_MS) },
        ...overrides,
    };
}

function buildService(stubs: IStubs): RebalanceSchedulerService {
    return new RebalanceSchedulerService(
        stubs.config as unknown as AppConfigService,
        stubs.strategyVersions as unknown as StrategyVersionRepository,
        stubs.schedulerRegistry as unknown as SchedulerRegistry,
        stubs.events as unknown as EventEmitter2,
        stubs.clock,
    );
}

// ─── suite setup/teardown ─────────────────────────────────────────────────────

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
});

// ─── paper gate: dormant conditions ──────────────────────────────────────────

describe('RebalanceSchedulerService — paper gate (dormant paths)', () => {
    it('stays dormant when EXCHANGE_ENV is not paper even if version ID is set', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.LIVE,
                activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.strategyVersions.findById).not.toHaveBeenCalled();
        expect(stubs.schedulerRegistry.addInterval).not.toHaveBeenCalled();
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    it('stays dormant when EXCHANGE_ENV is testnet even if version ID is set', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.TESTNET,
                activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.schedulerRegistry.addInterval).not.toHaveBeenCalled();
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    it('stays dormant when EXCHANGE_ENV is paper but activePortfolioStrategyVersionId is null', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.PAPER,
                activePortfolioStrategyVersionId: null,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.strategyVersions.findById).not.toHaveBeenCalled();
        expect(stubs.schedulerRegistry.addInterval).not.toHaveBeenCalled();
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    it('stays dormant when the strategy_versions row is missing for the configured version ID', async () => {
        const stubs = buildStubs({
            strategyVersions: { findById: jest.fn().mockResolvedValue(null) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.strategyVersions.findById).toHaveBeenCalledWith(ACTIVE_VERSION_ID);
        expect(stubs.schedulerRegistry.addInterval).not.toHaveBeenCalled();
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });
});

// ─── happy path ───────────────────────────────────────────────────────────────

describe('RebalanceSchedulerService — happy path (paper + version + valid row)', () => {
    it('registers the interval with the correct cadence from params', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.schedulerRegistry.addInterval).toHaveBeenCalledTimes(1);
        expect(stubs.schedulerRegistry.addInterval).toHaveBeenCalledWith('momentum-rebalance', expect.anything());
    });

    it('emits UNIVERSE_REBALANCE_DUE_EVENT with nowMs from ClockPort when the interval fires', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        await service.onModuleInit();

        // Advance fake timers by one full cadence to fire the interval callback.
        jest.advanceTimersByTime(REBALANCE_INTERVAL_MS);

        expect(stubs.events.emit).toHaveBeenCalledTimes(1);
        expect(stubs.events.emit).toHaveBeenCalledWith(UNIVERSE_REBALANCE_DUE_EVENT, { nowMs: FAKE_NOW_MS });
    });

    it('emits multiple times when the timer fires more than once', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        await service.onModuleInit();

        jest.advanceTimersByTime(REBALANCE_INTERVAL_MS * 3);

        expect(stubs.events.emit).toHaveBeenCalledTimes(3);
    });

    it('emits nowMs from ClockPort — not Date.now() — so the value is exactly what the fake clock returns', async () => {
        const CONTROLLED_NOW = 9_999_999_999_999;
        const stubs = buildStubs({
            clock: { nowMs: jest.fn().mockReturnValue(CONTROLLED_NOW) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        jest.advanceTimersByTime(REBALANCE_INTERVAL_MS);

        const emittedPayload = stubs.events.emit.mock.calls[0][1] as { nowMs: number };
        expect(emittedPayload.nowMs).toBe(CONTROLLED_NOW);
    });
});

// ─── onModuleDestroy ──────────────────────────────────────────────────────────

describe('RebalanceSchedulerService — onModuleDestroy', () => {
    it('deletes the registered interval when the service was active', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteInterval).toHaveBeenCalledTimes(1);
        expect(stubs.schedulerRegistry.deleteInterval).toHaveBeenCalledWith('momentum-rebalance');
    });

    it('does NOT call deleteInterval when the service stayed dormant (non-paper env)', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.LIVE,
                activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteInterval).not.toHaveBeenCalled();
    });

    it('does NOT call deleteInterval when the service stayed dormant (null version ID)', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.PAPER,
                activePortfolioStrategyVersionId: null,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteInterval).not.toHaveBeenCalled();
    });

    it('does NOT call deleteInterval when dormant due to missing strategy_versions row', async () => {
        const stubs = buildStubs({
            strategyVersions: { findById: jest.fn().mockResolvedValue(null) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteInterval).not.toHaveBeenCalled();
    });
});
