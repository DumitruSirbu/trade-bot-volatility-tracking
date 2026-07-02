/**
 * AppConfigService — M51 adversarial QA (ADR 0042 §9).
 *
 * Beyond the paired happy-path/two-condition-gate coverage in AppConfigService.m51.spec.ts,
 * this file targets two adversarial angles the implementer's tests do not cover:
 *
 *   QA1 — EXCHANGE_ENV missing/malformed at the ConfigService boundary (bypassing the normal
 *         class-validator @IsEnum boot guard, e.g. a unit-test stub or a future caller that
 *         constructs AppConfigService directly): the two-condition gate must still fail CLOSED
 *         (return false), never throw, never default open.
 *   QA2 — resolvedPaperRelaxPerCoinLiquidity is fixed at construction time: a mutation to the
 *         underlying config source (or EXCHANGE_ENV) AFTER the service is constructed must NOT
 *         flip the getter mid-run (the gate's determinism invariant — CLAUDE.md "strategies are
 *         pure and deterministic").
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';

import { AppConfigService } from '../AppConfigService';
import { EnvironmentVariables } from '../../EnvironmentVariables';

describe('AppConfigService M51 QA1 — paperRelaxPerCoinLiquidity fails closed on a malformed EXCHANGE_ENV', () => {
    it('EXCHANGE_ENV undefined + flag=true → returns false without throwing', () => {
        const config: Partial<EnvironmentVariables> = {
            NODE_ENV: 'test' as any,
            EXCHANGE_ENV: undefined as any,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
            MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
            PAPER_RELAX_MARKET_STRESS: false,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
            PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        };
        const configService = { get: (key: string) => (config as Record<string, unknown>)[key] } as never;

        let service: AppConfigService | undefined;

        expect(() => {
            service = new AppConfigService(configService);
        }).not.toThrow();

        expect(service!.paperRelaxPerCoinLiquidity).toBe(false);
    });

    it('EXCHANGE_ENV set to an out-of-enum garbage string + flag=true → returns false without throwing', () => {
        const config: Partial<EnvironmentVariables> = {
            NODE_ENV: 'test' as any,
            EXCHANGE_ENV: 'not-a-real-env' as any,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
            MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
            PAPER_RELAX_MARKET_STRESS: false,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
            PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        };
        const configService = { get: (key: string) => (config as Record<string, unknown>)[key] } as never;

        let service: AppConfigService | undefined;

        expect(() => {
            service = new AppConfigService(configService);
        }).not.toThrow();

        expect(service!.paperRelaxPerCoinLiquidity).toBe(false);
    });
});

describe('AppConfigService M51 QA2 — resolvedPaperRelaxPerCoinLiquidity is fixed at boot, not re-read per call', () => {
    it('flipping EXCHANGE_ENV on the backing config AFTER construction does not change the resolved getter', () => {
        const config: Record<string, unknown> = {
            NODE_ENV: 'test',
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
            MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
            PAPER_RELAX_MARKET_STRESS: false,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
            PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        };
        const configService = { get: (key: string) => config[key] } as never;

        const service = new AppConfigService(configService);

        expect(service.paperRelaxPerCoinLiquidity).toBe(true);

        // Mutate the backing source AFTER construction — simulates a mid-run env flip an
        // operator (or a bug) might attempt. The value was resolved once in the constructor.
        config['EXCHANGE_ENV'] = ExchangeEnvironmentEnum.LIVE;

        expect(service.paperRelaxPerCoinLiquidity).toBe(true);
        // `exchangeEnv` itself is a live pass-through getter (by design, for boot logging /
        // other consumers) — only the RESOLVED relax flag is pinned. Documents the asymmetry.
        expect(service.exchangeEnv).toBe(ExchangeEnvironmentEnum.LIVE);
    });

    it('flipping PAPER_RELAX_PER_COIN_LIQUIDITY on the backing config AFTER construction does not change the resolved getter', () => {
        const config: Record<string, unknown> = {
            NODE_ENV: 'test',
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
            MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
            PAPER_RELAX_MARKET_STRESS: false,
            PAPER_RELAX_PER_COIN_LIQUIDITY: false,
            PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        };
        const configService = { get: (key: string) => config[key] } as never;

        const service = new AppConfigService(configService);

        expect(service.paperRelaxPerCoinLiquidity).toBe(false);

        config['PAPER_RELAX_PER_COIN_LIQUIDITY'] = true;

        expect(service.paperRelaxPerCoinLiquidity).toBe(false);
    });
});
