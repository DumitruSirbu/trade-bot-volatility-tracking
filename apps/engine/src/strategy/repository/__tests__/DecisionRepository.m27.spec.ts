/**
 * DecisionRepository — M27 Zod policy tests (A3)
 *
 * Tests:
 *   M27-DR-1  — NODE_ENV=test + malformed snapshot → throws Zod error
 *   M27-DR-2  — NODE_ENV=production + malformed snapshot → warns, does NOT throw, record() completes
 *   M27-DR-3  — NODE_ENV=test + well-formed snapshot → no warning, no throw
 *   M27-DR-4  — NODE_ENV=production + well-formed snapshot → no warning, no throw, save called
 *   M27-DR-5  — NODE_ENV=test + null marketSnapshot → warns but does NOT throw (null guard applies first)
 *   M27-DR-6  — NODE_ENV=production + null marketSnapshot → warns but does NOT throw
 *   M27-DR-7  — Malformed snapshot in non-test env → repository.save is still called (record completes)
 *   M27-DR-8  — Development env behaves identically to production (warn, not throw) for malformed input
 */

import { Repository } from 'typeorm';

import { NodeEnvEnum } from '../../../config/enum/NodeEnvEnum';
import { AppConfigService } from '../../../config/service';
import { DecisionEntity } from '../../entity';
import { DecisionRepository } from '../DecisionRepository';

// ─── snapshot factories ───────────────────────────────────────────────────────

function buildWellFormedSnapshot(): Record<string, unknown> {
    return {
        vwap_session: '50000',
        vwap_20bar: '50000',
        vwap_deviation_pct: 3.0,
        vwap_deviation_sigma: 2.5,
        volume_ratio: 2.0,
        volume_20bar_avg: '1000000',
        atr_14: '500',
        adx_14: 30,
        adx_di_plus: 25,
        adx_di_minus: 10,
        rsi_14: 65,
        bollinger_upper: '51500',
        bollinger_lower: '48500',
        bollinger_pct_b: 0.8,
        btc_5m_move_pct: 0.1,
        btc_1m_move_pct: 0.05,
        eth_5m_move_pct: 0.2,
        idiosyncrasy_score: 0.7,
        funding_rate: 0.0001,
        funding_rate_annualized: 0.08,
        bid_ask_spread_pct: 0.01,
        estimated_slippage_pct: 0.05,
        book_depth_10bps_usdt: '50000000',
        book_depth_50bps_usdt: '999999999',
        coin_tier: 'tier1',
        coin_volume_rank: 1,
        correlation_mode: 'idiosyncratic',
        signal_score: 80,
        position_slot: 'A',
        active_positions_count: 0,
        regime_label: 'trending_up',
        entry_candle_open_time: 1748779200000,
        open_interest: '500000000',
        open_interest_change_5m_pct: 0.1,
        open_interest_change_15m_pct: 0.3,
        agg_trade_buy_volume_ratio: 0.6,
        market_breadth_5m_up_pct: 55,
        same_bar_trigger_count: 1,
        vwap_anchor_type: 'session',
        symbol_universe_age_hours: 200,
        flow_type: 'trend_initiation',
    };
}

function buildMalformedSnapshot(): Record<string, unknown> {
    // Remove required numeric fields and inject wrong-type values to fail Zod
    return {
        vwap_session: '50000',
        // vwap_deviation_pct is required as a number but omitted
        // symbol_universe_age_hours is required but omitted
        not_a_real_field: 'injected_garbage',
    };
}

// ─── repository factory ───────────────────────────────────────────────────────

function buildRepository(nodeEnv: NodeEnvEnum): {
    repo: DecisionRepository;
    saveMock: jest.Mock;
    loggerWarnSpy: jest.SpyInstance;
} {
    const savedEntity = { id: 1, symbol: 'BTCUSDT' } as DecisionEntity;
    const saveMock = jest.fn().mockResolvedValue(savedEntity);

    const typeOrmRepoMock = {
        save: saveMock,
        create: jest.fn().mockImplementation((data: Partial<DecisionEntity>) => ({ ...data })),
        metadata: {
            columns: [],
            relations: [],
        },
    } as unknown as Repository<DecisionEntity>;

    const appConfigMock = {
        nodeEnv,
    } as unknown as AppConfigService;

    const repo = new DecisionRepository(typeOrmRepoMock, appConfigMock);

    // Override the create() method inherited from BaseRepository to simply return the input
    jest.spyOn(repo as any, 'create').mockImplementation((...args: unknown[]) => args[0]);

    const loggerWarnSpy = jest.spyOn((repo as any).logger, 'warn').mockImplementation(() => undefined);

    return { repo, saveMock, loggerWarnSpy };
}

function buildDecisionInput(marketSnapshot: Record<string, unknown> | null | undefined): Partial<DecisionEntity> {
    return {
        symbol: 'BTCUSDT',
        strategyVersionId: 1,
        ts: new Date(),
        eventId: 'BTCUSDT:1748779200000',
        signalType: 'vwap_deviation_long_bias',
        marketSnapshot: marketSnapshot as any,
        action: 'open',
        reason: 'momentum_follow',
        gateAllowed: true,
        tradeSide: 'long',
    };
}

// ─── M27-DR-1: test env + malformed snapshot → throws Zod error ──────────────

describe('DecisionRepository M27 — M27-DR-1: test env + malformed snapshot throws Zod error', () => {
    it('throws a ZodError when NODE_ENV=test and marketSnapshot fails schema validation', async () => {
        const { repo } = buildRepository(NodeEnvEnum.TEST);
        const malformed = buildMalformedSnapshot();

        await expect(repo.record(buildDecisionInput(malformed))).rejects.toThrow();
    });

    it('save is NOT called when Zod throws in test env', async () => {
        const { repo, saveMock } = buildRepository(NodeEnvEnum.TEST);

        try {
            await repo.record(buildDecisionInput(buildMalformedSnapshot()));
        } catch {
            // expected
        }

        expect(saveMock).not.toHaveBeenCalled();
    });
});

// ─── M27-DR-2: production env + malformed snapshot → warns, does not throw ───

describe('DecisionRepository M27 — M27-DR-2: production env + malformed snapshot warns but does not throw', () => {
    it('does NOT throw when NODE_ENV=production and snapshot fails validation', async () => {
        const { repo } = buildRepository(NodeEnvEnum.PRODUCTION);

        await expect(repo.record(buildDecisionInput(buildMalformedSnapshot()))).resolves.toBeDefined();
    });

    it('logs a warn with the offending paths when validation fails in production', async () => {
        const { repo, loggerWarnSpy } = buildRepository(NodeEnvEnum.PRODUCTION);

        await repo.record(buildDecisionInput(buildMalformedSnapshot()));

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
        const warnMessage = loggerWarnSpy.mock.calls[0][0] as string;
        expect(warnMessage).toContain('BTCUSDT');
        expect(warnMessage).toContain('failed validation');
    });
});

// ─── M27-DR-3: test env + well-formed snapshot → no warning, no throw ─────────

describe('DecisionRepository M27 — M27-DR-3: test env + well-formed snapshot is clean', () => {
    it('does not throw when snapshot is valid in test env', async () => {
        const { repo } = buildRepository(NodeEnvEnum.TEST);

        await expect(repo.record(buildDecisionInput(buildWellFormedSnapshot()))).resolves.toBeDefined();
    });

    it('does not log a warn when snapshot is valid in test env', async () => {
        const { repo, loggerWarnSpy } = buildRepository(NodeEnvEnum.TEST);

        await repo.record(buildDecisionInput(buildWellFormedSnapshot()));

        expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
});

// ─── M27-DR-4: production env + well-formed snapshot → save is called ─────────

describe('DecisionRepository M27 — M27-DR-4: production env + well-formed snapshot calls save', () => {
    it('save() is called with a valid snapshot in production env', async () => {
        const { repo, saveMock } = buildRepository(NodeEnvEnum.PRODUCTION);

        await repo.record(buildDecisionInput(buildWellFormedSnapshot()));

        expect(saveMock).toHaveBeenCalledTimes(1);
    });

    it('no warn is logged with a valid snapshot in production env', async () => {
        const { repo, loggerWarnSpy } = buildRepository(NodeEnvEnum.PRODUCTION);

        await repo.record(buildDecisionInput(buildWellFormedSnapshot()));

        expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
});

// ─── M27-DR-5: test env + null marketSnapshot → warns, does not throw ─────────

describe('DecisionRepository M27 — M27-DR-5: null marketSnapshot triggers warn (null guard) but does not throw', () => {
    it('null marketSnapshot logs a warn but does not throw in test env', async () => {
        const { repo, loggerWarnSpy } = buildRepository(NodeEnvEnum.TEST);

        await expect(repo.record(buildDecisionInput(null))).resolves.toBeDefined();

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
        const warnMessage = loggerWarnSpy.mock.calls[0][0] as string;
        expect(warnMessage).toContain('without a market_snapshot');
    });
});

// ─── M27-DR-6: production env + null marketSnapshot → warns, does not throw ──

describe('DecisionRepository M27 — M27-DR-6: production env + null marketSnapshot logs warn and completes', () => {
    it('null marketSnapshot in production warns and completes record()', async () => {
        const { repo, saveMock, loggerWarnSpy } = buildRepository(NodeEnvEnum.PRODUCTION);

        await expect(repo.record(buildDecisionInput(null))).resolves.toBeDefined();

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
        expect(saveMock).toHaveBeenCalledTimes(1);
    });
});

// ─── M27-DR-7: malformed snapshot in non-test env → save is still called ──────

describe('DecisionRepository M27 — M27-DR-7: malformed snapshot in production does not block save', () => {
    it('save() is called despite a malformed snapshot in production', async () => {
        const { repo, saveMock } = buildRepository(NodeEnvEnum.PRODUCTION);

        await repo.record(buildDecisionInput(buildMalformedSnapshot()));

        expect(saveMock).toHaveBeenCalledTimes(1);
    });
});

// ─── M27-DR-8: development env behaves like production (warn, not throw) ──────

describe('DecisionRepository M27 — M27-DR-8: development env warns on malformed snapshot but does not throw', () => {
    it('does not throw on a malformed snapshot in development env', async () => {
        const { repo } = buildRepository(NodeEnvEnum.DEVELOPMENT);

        await expect(repo.record(buildDecisionInput(buildMalformedSnapshot()))).resolves.toBeDefined();
    });

    it('logs a warn on a malformed snapshot in development env', async () => {
        const { repo, loggerWarnSpy } = buildRepository(NodeEnvEnum.DEVELOPMENT);

        await repo.record(buildDecisionInput(buildMalformedSnapshot()));

        expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    });
});
