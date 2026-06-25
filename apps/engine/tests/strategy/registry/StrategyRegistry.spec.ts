import { StrategyDirectionEnum } from '@bot/shared';

import { StrategyConfigException } from '../../../src/strategy/exception/StrategyConfigException';
import { StrategyRegistry } from '../../../src/strategy/registry/StrategyRegistry';
import { V0BaselineStrategy } from '../../../src/strategy/strategies/V0BaselineStrategy';
import { V1MeanReversionStrategy } from '../../../src/strategy/strategies/V1MeanReversionStrategy';
import { V2MomentumStrategy } from '../../../src/strategy/strategies/V2MomentumStrategy';
import { V3HybridRouterStrategy } from '../../../src/strategy/strategies/V3HybridRouterStrategy';
import { buildParams } from '../support/fixtures';

function buildRegistry(): StrategyRegistry {
    return new StrategyRegistry(new V0BaselineStrategy(), new V1MeanReversionStrategy(), new V2MomentumStrategy(), new V3HybridRouterStrategy());
}

const VALID_PARAMS = buildParams() as unknown as Record<string, unknown>;

describe('StrategyRegistry', () => {
    describe('resolve — known name/version pairs', () => {
        it('resolves v0 (volatility-vwap:0)', () => {
            const registry = buildRegistry();

            const { strategy } = registry.resolve('volatility-vwap', 0, VALID_PARAMS);

            expect(strategy.name).toBe('volatility-vwap');
            expect(strategy.version).toBe(0);
        });

        it('resolves v1 (volatility-vwap:1)', () => {
            const registry = buildRegistry();

            const { strategy } = registry.resolve('volatility-vwap', 1, VALID_PARAMS);

            expect(strategy.version).toBe(1);
            expect(strategy.direction).toBe(StrategyDirectionEnum.MEAN_REVERSION);
        });

        it('resolves v2 (volatility-vwap:2)', () => {
            const registry = buildRegistry();

            const { strategy } = registry.resolve('volatility-vwap', 2, VALID_PARAMS);

            expect(strategy.version).toBe(2);
            expect(strategy.direction).toBe(StrategyDirectionEnum.MOMENTUM);
        });

        it('resolves v3 (volatility-vwap:3)', () => {
            const registry = buildRegistry();

            const { strategy } = registry.resolve('volatility-vwap', 3, VALID_PARAMS);

            expect(strategy.version).toBe(3);
            expect(strategy.direction).toBe(StrategyDirectionEnum.HYBRID);
        });

        it('returns the validated typed params alongside the strategy', () => {
            const registry = buildRegistry();

            const { params } = registry.resolve('volatility-vwap', 0, VALID_PARAMS);

            // The typed params should include the schema-inferred keys
            expect(params.vwap_sigma_trigger).toBeDefined();
            expect(params.atr_stop_multiplier).toBeDefined();
        });
    });

    describe('resolve — M47 geometry-coupled version aliases (11/21/31)', () => {
        it('resolves version 11 (v1.1) to the V1 mean-reversion implementation', () => {
            const registry = buildRegistry();

            const { strategy } = registry.resolve('volatility-vwap', 11, VALID_PARAMS);

            // The alias points at the same V1 class — the version bump is a data partition key only.
            expect(strategy.version).toBe(1);
            expect(strategy.direction).toBe(StrategyDirectionEnum.MEAN_REVERSION);
        });

        it('resolves version 21 (v2.1) to the V2 momentum implementation', () => {
            const registry = buildRegistry();

            const { strategy } = registry.resolve('volatility-vwap', 21, VALID_PARAMS);

            expect(strategy.version).toBe(2);
            expect(strategy.direction).toBe(StrategyDirectionEnum.MOMENTUM);
        });

        it('resolves version 31 (v3.1) to the V3 hybrid-router implementation', () => {
            const registry = buildRegistry();

            const { strategy } = registry.resolve('volatility-vwap', 31, VALID_PARAMS);

            expect(strategy.version).toBe(3);
            expect(strategy.direction).toBe(StrategyDirectionEnum.HYBRID);
        });

        it('returns the same V1 instance for both version 1 and its alias 11', () => {
            const registry = buildRegistry();

            const { strategy: v1 } = registry.resolve('volatility-vwap', 1, VALID_PARAMS);
            const { strategy: alias } = registry.resolve('volatility-vwap', 11, VALID_PARAMS);

            expect(alias).toBe(v1);
        });
    });

    describe('resolve — unknown name/version', () => {
        it('throws StrategyConfigException for an unknown strategy name', () => {
            const registry = buildRegistry();

            expect(() => registry.resolve('unknown-strategy', 0, VALID_PARAMS)).toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException for a known name but unknown version', () => {
            const registry = buildRegistry();

            expect(() => registry.resolve('volatility-vwap', 99, VALID_PARAMS)).toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException for empty name', () => {
            const registry = buildRegistry();

            expect(() => registry.resolve('', 0, VALID_PARAMS)).toThrow(StrategyConfigException);
        });
    });

    describe('resolve — invalid params', () => {
        it('throws StrategyConfigException when params is empty', () => {
            const registry = buildRegistry();

            expect(() => registry.resolve('volatility-vwap', 0, {})).toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException when a required param key is missing', () => {
            const registry = buildRegistry();
            const { vwap_sigma_trigger: _omitted, ...missingKey } = VALID_PARAMS as any;

            expect(() => registry.resolve('volatility-vwap', 0, missingKey)).toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException when a required param has wrong type', () => {
            const registry = buildRegistry();
            const badParams = { ...VALID_PARAMS, vwap_sigma_trigger: 'not-a-number' };

            expect(() => registry.resolve('volatility-vwap', 0, badParams)).toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException when a required param is negative where positive is required', () => {
            const registry = buildRegistry();
            const badParams = { ...VALID_PARAMS, volume_ratio_min: -1 };

            expect(() => registry.resolve('volatility-vwap', 0, badParams)).toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException when params is null', () => {
            const registry = buildRegistry();

            expect(() => registry.resolve('volatility-vwap', 0, null)).toThrow(StrategyConfigException);
        });

        it('throws StrategyConfigException when candle_interval is not the literal 5m', () => {
            const registry = buildRegistry();
            const badParams = { ...VALID_PARAMS, candle_interval: '1m' };

            expect(() => registry.resolve('volatility-vwap', 0, badParams)).toThrow(StrategyConfigException);
        });
    });

    describe('resolve — optional params accepted', () => {
        it('accepts params with optional trade_enabled key', () => {
            const registry = buildRegistry();
            const paramsWithOptional = { ...VALID_PARAMS, trade_enabled: false };

            expect(() => registry.resolve('volatility-vwap', 0, paramsWithOptional)).not.toThrow();
        });

        it('accepts params with optional direction key (redundant but schema allows it)', () => {
            const registry = buildRegistry();
            const paramsWithDirection = { ...VALID_PARAMS, direction: 'mean_reversion' };

            expect(() => registry.resolve('volatility-vwap', 1, paramsWithDirection)).not.toThrow();
        });
    });

    describe('resolve — same instance returned (no duplication)', () => {
        it('resolves the same IStrategy instance on two calls with the same key', () => {
            const registry = buildRegistry();

            const { strategy: a } = registry.resolve('volatility-vwap', 0, VALID_PARAMS);
            const { strategy: b } = registry.resolve('volatility-vwap', 0, VALID_PARAMS);

            expect(a).toBe(b);
        });
    });
});
