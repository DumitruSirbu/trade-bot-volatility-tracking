/**
 * Unit tests for RebalanceSchedulerService (ADR 0048 §2.2, amended ADR 0050 §4).
 *
 * All deps are plain jest.fn() mocks — no real DB, no real NestJS DI.
 * CronJob instances are stopped in afterEach so the live timer does not leak.
 *
 * Coverage map:
 *   Case 1 — non-paper env + version ID set          → WARN, no cron, no emit
 *   Case 2 — paper env + version ID null             → WARN, no cron, no emit
 *   Case 3 — paper env + version ID set, row missing → WARN, no cron, no emit
 *   Case 4 — happy path: paper + version + valid row → cron registered, tick emits event
 *   Case 5 — ClockPort injection                     → emitted nowMs equals fake clock value
 *   Case 6 — onModuleDestroy cleans up when active   → deleteCronJob called
 *   Case 7 — rebalance_interval_ms mismatch          → WARN, cron still registered
 */

import { ExchangeEnvironmentEnum, momentumParamsSchema, RebalanceTriggerSourceEnum, UNIVERSE_REBALANCE_DUE_EVENT } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { AppConfigService } from '../../src/config/service/AppConfigService';
import { MOMENTUM_REBALANCE_CRON_NAME, REBALANCE_TRIGGER_COOLDOWN_MS } from '../../src/strategy/const';
import { RebalanceTriggerRejectedException } from '../../src/strategy/exception';
import { StrategyVersionRepository } from '../../src/strategy/repository/StrategyVersionRepository';
import { RebalanceSchedulerService } from '../../src/strategy/service/RebalanceSchedulerService';

// ─── fixture builders ─────────────────────────────────────────────────────────

const ACTIVE_VERSION_ID = 7;
const FAKE_NOW_MS = 1_700_000_000_000;

function buildValidRow(overrides: { rebalance_interval_ms?: number } = {}) {
    return {
        id: ACTIVE_VERSION_ID,
        name: 'xmom',
        version: 1,
        params: {
            top_n: 3,
            lookback_ms: 86_400_000,
            rebalance_interval_ms: overrides.rebalance_interval_ms ?? 86_400_000,
            min_universe_size: 20,
            xmom_atr_stop_multiplier: 2.0,
            xmom_min_rr: 1.5,
        },
    };
}

interface IStubs {
    config: jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>;
    strategyVersions: { findById: jest.Mock };
    schedulerRegistry: { addCronJob: jest.Mock; deleteCronJob: jest.Mock };
    events: { emit: jest.Mock };
    clock: { nowMs: jest.Mock };
}

const startedCronJobs: Array<{ fireOnTick: () => void; stop: () => void }> = [];

function buildStubs(overrides: Partial<IStubs> = {}): IStubs {
    return {
        config: {
            exchangeEnv: ExchangeEnvironmentEnum.PAPER,
            activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
        } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        strategyVersions: { findById: jest.fn().mockResolvedValue(buildValidRow()) },
        schedulerRegistry: {
            addCronJob: jest.fn((_name: string, job: { fireOnTick: () => void; stop: () => void }) => {
                startedCronJobs.push(job);
            }),
            deleteCronJob: jest.fn(),
        },
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

afterEach(() => {
    const jobs = startedCronJobs.splice(0);
    for (const job of jobs) {
        job.stop();
    }

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
        expect(stubs.schedulerRegistry.addCronJob).not.toHaveBeenCalled();
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

        expect(stubs.schedulerRegistry.addCronJob).not.toHaveBeenCalled();
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
        expect(stubs.schedulerRegistry.addCronJob).not.toHaveBeenCalled();
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    it('stays dormant when the strategy_versions row is missing for the configured version ID', async () => {
        const stubs = buildStubs({
            strategyVersions: { findById: jest.fn().mockResolvedValue(null) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.strategyVersions.findById).toHaveBeenCalledWith(ACTIVE_VERSION_ID);
        expect(stubs.schedulerRegistry.addCronJob).not.toHaveBeenCalled();
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });
});

// ─── happy path ───────────────────────────────────────────────────────────────

describe('RebalanceSchedulerService — happy path (paper + version + valid row)', () => {
    it('registers the fixed UTC cron job', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
        expect(stubs.schedulerRegistry.addCronJob).toHaveBeenCalledWith(MOMENTUM_REBALANCE_CRON_NAME, expect.anything());
    });

    it('emits UNIVERSE_REBALANCE_DUE_EVENT with nowMs from ClockPort when the cron fires', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(startedCronJobs).toHaveLength(1);
        startedCronJobs[0].fireOnTick();

        expect(stubs.events.emit).toHaveBeenCalledTimes(1);
        expect(stubs.events.emit).toHaveBeenCalledWith(UNIVERSE_REBALANCE_DUE_EVENT, {
            nowMs: FAKE_NOW_MS,
            triggerSource: RebalanceTriggerSourceEnum.SCHEDULED,
        });
    });

    it('emits nowMs from ClockPort — not Date.now() — so the value is exactly what the fake clock returns', async () => {
        const CONTROLLED_NOW = 9_999_999_999_999;
        const stubs = buildStubs({
            clock: { nowMs: jest.fn().mockReturnValue(CONTROLLED_NOW) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        startedCronJobs[0].fireOnTick();

        const emittedPayload = stubs.events.emit.mock.calls[0][1] as { nowMs: number };
        expect(emittedPayload.nowMs).toBe(CONTROLLED_NOW);
    });

    it('warns but still registers when rebalance_interval_ms does not match the fixed 24h period', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const stubs = buildStubs({
            strategyVersions: { findById: jest.fn().mockResolvedValue(buildValidRow({ rebalance_interval_ms: 300_000 })) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rebalance_interval_ms=300000'));
        warnSpy.mockRestore();
    });
});

// ─── onModuleDestroy ──────────────────────────────────────────────────────────

describe('RebalanceSchedulerService — onModuleDestroy', () => {
    it('deletes the registered cron job when the service was active', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteCronJob).toHaveBeenCalledTimes(1);
        expect(stubs.schedulerRegistry.deleteCronJob).toHaveBeenCalledWith(MOMENTUM_REBALANCE_CRON_NAME);
    });

    it('does NOT call deleteCronJob when the service stayed dormant (non-paper env)', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.LIVE,
                activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
    });

    it('does NOT call deleteCronJob when the service stayed dormant (null version ID)', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.PAPER,
                activePortfolioStrategyVersionId: null,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
    });

    it('does NOT call deleteCronJob when dormant due to missing strategy_versions row', async () => {
        const stubs = buildStubs({
            strategyVersions: { findById: jest.fn().mockResolvedValue(null) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        service.onModuleDestroy();

        expect(stubs.schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
    });
});

describe('RebalanceSchedulerService — invalid params', () => {
    it('stays dormant when strategy_versions.params fail Zod parse', async () => {
        const stubs = buildStubs({
            strategyVersions: {
                findById: jest.fn().mockResolvedValue({
                    ...buildValidRow(),
                    params: { top_n: 0 },
                }),
            },
        });
        const service = buildService(stubs);

        await service.onModuleInit();

        expect(stubs.schedulerRegistry.addCronJob).not.toHaveBeenCalled();
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    it('momentumParamsSchema default top_n is 3 (ADR 0050)', () => {
        expect(momentumParamsSchema.parse({}).top_n).toBe(3);
    });
});

// ─── triggerRebalanceDue (manual / CLI seam) ──────────────────────────────────

describe('RebalanceSchedulerService — triggerRebalanceDue', () => {
    it('emits a MANUAL-tagged event and returns accepted:true when paper env and portfolio version are set', async () => {
        const stubs = buildStubs();
        const service = buildService(stubs);

        const result = await service.triggerRebalanceDue();

        expect(result).toEqual({ accepted: true, nowMs: FAKE_NOW_MS });
        expect(stubs.events.emit).toHaveBeenCalledWith(UNIVERSE_REBALANCE_DUE_EVENT, {
            nowMs: FAKE_NOW_MS,
            triggerSource: RebalanceTriggerSourceEnum.MANUAL,
        });
    });

    it('throws RebalanceTriggerForbiddenException when exchangeEnv is not paper', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.LIVE,
                activePortfolioStrategyVersionId: ACTIVE_VERSION_ID,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await expect(service.triggerRebalanceDue()).rejects.toThrow('trigger-rebalance is paper-only');
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    it('throws RebalanceTriggerRejectedException when ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID is unset', async () => {
        const stubs = buildStubs({
            config: {
                exchangeEnv: ExchangeEnvironmentEnum.PAPER,
                activePortfolioStrategyVersionId: null,
            } as jest.Mocked<Pick<AppConfigService, 'exchangeEnv' | 'activePortfolioStrategyVersionId'>>,
        });
        const service = buildService(stubs);

        await expect(service.triggerRebalanceDue()).rejects.toThrow('ACTIVE_PORTFOLIO_STRATEGY_VERSION_ID unset');
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    // Validation asymmetry fix — the manual path now runs the SAME row-lookup + params-parse the
    // cron path runs at registration, and rejects (rather than silently emitting a doomed event).
    it('throws (no emit) when the strategy_versions row is missing', async () => {
        const stubs = buildStubs({
            strategyVersions: { findById: jest.fn().mockResolvedValue(null) },
        });
        const service = buildService(stubs);

        await expect(service.triggerRebalanceDue()).rejects.toThrow('matches no strategy_versions row');
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    it('throws (no emit) when strategy_versions.params fail Zod parse', async () => {
        const stubs = buildStubs({
            strategyVersions: {
                findById: jest.fn().mockResolvedValue({ ...buildValidRow(), params: { top_n: 0 } }),
            },
        });
        const service = buildService(stubs);

        await expect(service.triggerRebalanceDue()).rejects.toThrow('invalid momentum params');
        expect(stubs.events.emit).not.toHaveBeenCalled();
    });

    // Cooldown guard — a second manual trigger inside REBALANCE_TRIGGER_COOLDOWN_MS is rejected.
    it('rejects a manual trigger that lands within the cooldown window of the last emission', async () => {
        const nowValues = [FAKE_NOW_MS, FAKE_NOW_MS + 60_000];
        const stubs = buildStubs({
            clock: { nowMs: jest.fn(() => nowValues.shift() ?? FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await service.triggerRebalanceDue();
        await expect(service.triggerRebalanceDue()).rejects.toThrow('within cooldown');
        expect(stubs.events.emit).toHaveBeenCalledTimes(1);
    });

    // Ordering guard (the DB read must run AFTER the cheap in-memory cooldown check): a
    // cooldown-rejected retrigger must perform ZERO strategy_versions.findById calls — the
    // async DB round-trip is never reached once the cooldown throws.
    it('a cooldown-rejected retrigger performs zero strategy_versions.findById calls (DB read skipped)', async () => {
        const nowValues = [FAKE_NOW_MS, FAKE_NOW_MS + 60_000];
        const stubs = buildStubs({
            clock: { nowMs: jest.fn(() => nowValues.shift() ?? FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await service.triggerRebalanceDue();
        stubs.strategyVersions.findById.mockClear();

        await expect(service.triggerRebalanceDue()).rejects.toThrow('within cooldown');
        expect(stubs.strategyVersions.findById).not.toHaveBeenCalled();
    });

    it('allows a manual trigger once the cooldown window has elapsed', async () => {
        const nowValues = [FAKE_NOW_MS, FAKE_NOW_MS + 6 * 60_000];
        const stubs = buildStubs({
            clock: { nowMs: jest.fn(() => nowValues.shift() ?? FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await service.triggerRebalanceDue();
        await service.triggerRebalanceDue();

        expect(stubs.events.emit).toHaveBeenCalledTimes(2);
    });

    // A brand-new service instance has never emitted — the cooldown guard must not treat that
    // absence as "cooldown not yet elapsed". lastEmittedAtMs stays null until the first emission.
    it('does not apply the cooldown guard to the very first trigger on a fresh instance', async () => {
        const stubs = buildStubs({
            clock: { nowMs: jest.fn().mockReturnValue(FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await expect(service.triggerRebalanceDue()).resolves.toEqual({ accepted: true, nowMs: FAKE_NOW_MS });
        expect(stubs.events.emit).toHaveBeenCalledTimes(1);
    });
});

// ─── cooldown guard: exact boundary + cross-source clock sharing ──────────────

describe('RebalanceSchedulerService — cooldown guard boundary conditions', () => {
    it('rejects a manual trigger at elapsedMs === COOLDOWN_MS - 1 (one ms short of the window)', async () => {
        const nowValues = [FAKE_NOW_MS, FAKE_NOW_MS + REBALANCE_TRIGGER_COOLDOWN_MS - 1];
        const stubs = buildStubs({
            clock: { nowMs: jest.fn(() => nowValues.shift() ?? FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await service.triggerRebalanceDue();

        await expect(service.triggerRebalanceDue()).rejects.toThrow('within cooldown');
        expect(stubs.events.emit).toHaveBeenCalledTimes(1);
    });

    it('allows a manual trigger at exactly elapsedMs === COOLDOWN_MS (the boundary itself is not "within" the window)', async () => {
        const nowValues = [FAKE_NOW_MS, FAKE_NOW_MS + REBALANCE_TRIGGER_COOLDOWN_MS];
        const stubs = buildStubs({
            clock: { nowMs: jest.fn(() => nowValues.shift() ?? FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await service.triggerRebalanceDue();

        await expect(service.triggerRebalanceDue()).resolves.toEqual({
            accepted: true,
            nowMs: FAKE_NOW_MS + REBALANCE_TRIGGER_COOLDOWN_MS,
        });
        expect(stubs.events.emit).toHaveBeenCalledTimes(2);
    });

    // A scheduled cron emission and a manual trigger share the SAME lastEmittedAtMs clock — a
    // manual attempt landing shortly after a cron tick must be rejected, not just after another
    // manual trigger. This is the double-rebalance-near-the-cron scenario the cooldown exists for.
    it('a scheduled cron emission arms the cooldown clock so a subsequent manual trigger within the window is rejected', async () => {
        const nowValues = [FAKE_NOW_MS, FAKE_NOW_MS + 60_000];
        const stubs = buildStubs({
            clock: { nowMs: jest.fn(() => nowValues.shift() ?? FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        expect(startedCronJobs).toHaveLength(1);
        startedCronJobs[0].fireOnTick(); // SCHEDULED emission at FAKE_NOW_MS — arms lastEmittedAtMs

        await expect(service.triggerRebalanceDue()).rejects.toThrow('within cooldown');
        // Only the cron's SCHEDULED emission happened — the manual attempt was rejected before emit.
        expect(stubs.events.emit).toHaveBeenCalledTimes(1);
        expect(stubs.events.emit).toHaveBeenCalledWith(UNIVERSE_REBALANCE_DUE_EVENT, {
            nowMs: FAKE_NOW_MS,
            triggerSource: RebalanceTriggerSourceEnum.SCHEDULED,
        });
    });

    it('a manual trigger succeeds once past the cooldown window measured from the prior scheduled emission', async () => {
        const nowValues = [FAKE_NOW_MS, FAKE_NOW_MS + REBALANCE_TRIGGER_COOLDOWN_MS + 1];
        const stubs = buildStubs({
            clock: { nowMs: jest.fn(() => nowValues.shift() ?? FAKE_NOW_MS) },
        });
        const service = buildService(stubs);

        await service.onModuleInit();
        startedCronJobs[0].fireOnTick(); // SCHEDULED emission arms the clock at FAKE_NOW_MS

        await expect(service.triggerRebalanceDue()).resolves.toEqual({
            accepted: true,
            nowMs: FAKE_NOW_MS + REBALANCE_TRIGGER_COOLDOWN_MS + 1,
        });
        expect(stubs.events.emit).toHaveBeenCalledTimes(2);
        expect(stubs.events.emit).toHaveBeenLastCalledWith(UNIVERSE_REBALANCE_DUE_EVENT, {
            nowMs: FAKE_NOW_MS + REBALANCE_TRIGGER_COOLDOWN_MS + 1,
            triggerSource: RebalanceTriggerSourceEnum.MANUAL,
        });
    });
});

// ─── resolveValidatedParams: cause chaining on the manual-trigger path ────────

describe('RebalanceSchedulerService — resolveValidatedParams cause chaining', () => {
    it('chains the underlying Zod parse failure as .cause on RebalanceTriggerRejectedException, not swallowed', async () => {
        const stubs = buildStubs({
            strategyVersions: {
                findById: jest.fn().mockResolvedValue({ ...buildValidRow(), params: { top_n: 0 } }),
            },
        });
        const service = buildService(stubs);

        let caught: unknown;
        try {
            await service.triggerRebalanceDue();
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(RebalanceTriggerRejectedException);
        const rejected = caught as RebalanceTriggerRejectedException;
        expect(rejected.cause).toBeDefined();
        expect(rejected.cause).not.toBeNull();
        // The cause is the raw ZodError (or equivalent), not re-stringified away — its own message
        // content must still be reachable from the chained cause, not just folded into the outer text.
        expect((rejected.cause as Error).message).toBeDefined();
    });

    it('does NOT chain a cause when the row itself is missing (no Zod parse ever ran)', async () => {
        const stubs = buildStubs({
            strategyVersions: { findById: jest.fn().mockResolvedValue(null) },
        });
        const service = buildService(stubs);

        let caught: unknown;
        try {
            await service.triggerRebalanceDue();
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(RebalanceTriggerRejectedException);
        expect((caught as RebalanceTriggerRejectedException).cause).toBeUndefined();
    });
});
