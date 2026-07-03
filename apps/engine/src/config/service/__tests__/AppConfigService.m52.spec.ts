/**
 * AppConfigService — M52 xmomForceCloseRetry getter (ADR 0051 §4)
 *
 * Tests the two-condition gate (mirrors the M25/M36/M51 paper-relax pattern):
 *   xmomForceCloseRetry is true ONLY when EXCHANGE_ENV=paper AND XMOM_FORCE_CLOSE_RETRY=true.
 *   Live, testnet, and absent/false flag all return false — this is the SECURITY-CRITICAL
 *   two-condition contract that makes the force_close retry path unreachable off paper.
 *
 * Raw-string @Transform coercion is validated by the EnvironmentVariables schema; this spec tests
 * post-coercion behavior only (the ConfigService stub receives already-coerced booleans).
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Logger } from '@nestjs/common';

import { AppConfigService } from '../AppConfigService';
import { EnvironmentVariables } from '../../EnvironmentVariables';

function buildConfigService(overrides: Partial<EnvironmentVariables> = {}) {
    const config: Partial<EnvironmentVariables> = {
        NODE_ENV: 'test' as never,
        EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
        PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
        PAPER_RELAX_MARKET_STRESS: false,
        PAPER_RELAX_PER_COIN_LIQUIDITY: false,
        PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        XMOM_FORCE_CLOSE_RETRY: false,
        ...overrides,
    };

    return {
        get: (key: string) => (config as Record<string, unknown>)[key],
    } as never;
}

function buildService(overrides: Partial<EnvironmentVariables> = {}): AppConfigService {
    return new AppConfigService(buildConfigService(overrides));
}

describe('AppConfigService M52 — xmomForceCloseRetry two-condition gate', () => {
    it('CFG1: EXCHANGE_ENV=paper and flag=true → returns true', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            XMOM_FORCE_CLOSE_RETRY: true,
        });

        expect(service.xmomForceCloseRetry).toBe(true);
    });

    it('CFG2: EXCHANGE_ENV=live and flag=true → returns false (unreachable off paper)', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            XMOM_FORCE_CLOSE_RETRY: true,
        });

        expect(service.xmomForceCloseRetry).toBe(false);
    });

    it('CFG3: EXCHANGE_ENV=testnet and flag=true → returns false (unreachable off paper)', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
            XMOM_FORCE_CLOSE_RETRY: true,
        });

        expect(service.xmomForceCloseRetry).toBe(false);
    });

    it('CFG4: EXCHANGE_ENV=paper and flag=false → returns false', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            XMOM_FORCE_CLOSE_RETRY: false,
        });

        expect(service.xmomForceCloseRetry).toBe(false);
    });

    it('CFG5: EXCHANGE_ENV=paper and flag absent (schema default=false) → returns false', () => {
        const service = buildService({ EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER });

        expect(service.xmomForceCloseRetry).toBe(false);
    });
});

describe('AppConfigService M52 — xmomForceCloseRetry boot-time warnings', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('CFG6: EXCHANGE_ENV=live + flag=true → logs a NEUTRALIZED warn naming the flag and env', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            XMOM_FORCE_CLOSE_RETRY: true,
        });

        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /XMOM_FORCE_CLOSE_RETRY/i.test(String(msg)) && /NEUTRALIZED/i.test(String(msg)));
        expect(misconfigWarns.length).toBeGreaterThanOrEqual(1);
        expect(String(misconfigWarns[0][0])).toMatch(/live/i);
    });

    it('CFG7: EXCHANGE_ENV=live + flag=false → does NOT log a warn for this flag', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            XMOM_FORCE_CLOSE_RETRY: false,
        });

        const warns = warnSpy.mock.calls.filter(([msg]) => /XMOM_FORCE_CLOSE_RETRY/i.test(String(msg)));
        expect(warns).toHaveLength(0);
    });

    it('CFG8: EXCHANGE_ENV=paper + flag=true → active-confirmation warn, NOT a NEUTRALIZED warn', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            XMOM_FORCE_CLOSE_RETRY: true,
        });

        const neutralizedWarns = warnSpy.mock.calls.filter(([msg]) => /XMOM_FORCE_CLOSE_RETRY/i.test(String(msg)) && /NEUTRALIZED/i.test(String(msg)));
        expect(neutralizedWarns).toHaveLength(0);

        const activeWarns = warnSpy.mock.calls.filter(([msg]) => /XMOM_FORCE_CLOSE_RETRY is active/i.test(String(msg)));
        expect(activeWarns).toHaveLength(1);
    });
});
