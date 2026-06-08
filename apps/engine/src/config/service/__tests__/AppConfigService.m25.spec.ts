/**
 * AppConfigService — M25 new getters: paperRelaxMarketStress + paperMaxIdiosyncraticSlots
 *
 * Tests the two-condition gate (ADR 0042 §1):
 *   paperRelaxMarketStress is true ONLY when EXCHANGE_ENV=paper AND PAPER_RELAX_MARKET_STRESS=true.
 *   Live, testnet, and absent flag all return false.
 *
 * Tests paperMaxIdiosyncraticSlots returns the validated value or undefined when absent.
 *
 * Raw-string @Transform coercion (e.g. PAPER_RELAX_MARKET_STRESS: 'false' → false,
 * absent → false) is covered by validateEnv.spec.ts. This spec tests post-coercion
 * behavior only — the ConfigService stub always receives already-coerced booleans.
 *
 * The AppConfigService constructor reads process.env for auth secrets but generates safe
 * per-process random secrets in non-production, so the constructor succeeds here without
 * setting auth env vars.
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Logger } from '@nestjs/common';

import { AppConfigService } from '../AppConfigService';
import { EnvironmentVariables } from '../../EnvironmentVariables';

// ─── factory helpers ──────────────────────────────────────────────────────────

/**
 * Builds a minimal ConfigService stub backed by a plain object. The stub returns
 * the value at `config[key]` — identical to what NestJS ConfigService does when
 * the env was validated through validateEnv. Only the keys consumed by
 * resolvePaperRelaxMarketStress / paperMaxIdiosyncraticSlots and exchangeEnv need
 * to be present; the constructor's other calls to process.env use safe dev fallbacks.
 *
 * Cast to `never` avoids the `as unknown as X` double-cast (forbidden by team
 * conventions). The plain-object stub satisfies the single `get` call-shape that
 * AppConfigService uses; no other ConfigService methods are exercised here.
 */
function buildConfigService(overrides: Partial<EnvironmentVariables> = {}) {
    const config: Partial<EnvironmentVariables> = {
        NODE_ENV: 'test' as any,
        EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
        PAPER_RELAX_MARKET_STRESS: false,
        PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
        ...overrides,
    };

    return {
        get: (key: string) => (config as Record<string, unknown>)[key],
    } as never;
}

function buildService(overrides: Partial<EnvironmentVariables> = {}): AppConfigService {
    return new AppConfigService(buildConfigService(overrides));
}

// ─── paperRelaxMarketStress ───────────────────────────────────────────────────

describe('AppConfigService M25 — paperRelaxMarketStress', () => {
    describe('returns true only when EXCHANGE_ENV=paper AND flag=true', () => {
        it('returns true when EXCHANGE_ENV=paper and PAPER_RELAX_MARKET_STRESS=true', () => {
            const service = buildService({
                EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
                PAPER_RELAX_MARKET_STRESS: true,
            });

            expect(service.paperRelaxMarketStress).toBe(true);
        });
    });

    describe('returns false when EXCHANGE_ENV is not paper', () => {
        it('returns false when EXCHANGE_ENV=live even if the flag is true', () => {
            const service = buildService({
                EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
                PAPER_RELAX_MARKET_STRESS: true,
            });

            expect(service.paperRelaxMarketStress).toBe(false);
        });

        it('returns false when EXCHANGE_ENV=testnet even if the flag is true', () => {
            const service = buildService({
                EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
                PAPER_RELAX_MARKET_STRESS: true,
            });

            expect(service.paperRelaxMarketStress).toBe(false);
        });
    });

    describe('returns false when flag is off regardless of env', () => {
        it('returns false when flag is false and EXCHANGE_ENV=paper', () => {
            const service = buildService({
                EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
                PAPER_RELAX_MARKET_STRESS: false,
            });

            expect(service.paperRelaxMarketStress).toBe(false);
        });

        it('returns false when flag is absent (default-off) and EXCHANGE_ENV=paper', () => {
            // The schema field defaults to false when absent; after the @Transform
            // the value is boolean false, not undefined.
            // Raw-string coercion (PAPER_RELAX_MARKET_STRESS: 'false' → false, absent → false)
            // is tested in validateEnv.spec.ts. This spec only exercises post-coercion values.
            const service = buildService({
                EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
                PAPER_RELAX_MARKET_STRESS: false, // schema default when absent
            });

            expect(service.paperRelaxMarketStress).toBe(false);
        });
    });
});

// ─── paperRelaxMarketStress — boot-time misconfig warning ────────────────────

describe('AppConfigService M25 — paperRelaxMarketStress boot-time misconfig warning', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('logs a warn when EXCHANGE_ENV=live and PAPER_RELAX_MARKET_STRESS=true (flag is set but cannot activate)', () => {
        // resolvePaperRelaxMarketStress() returns false for live, but should warn
        // the operator that the flag was set in a non-paper environment so the
        // misconfiguration is surfaced at boot rather than silently ignored.
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_MARKET_STRESS: true,
        });

        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/PAPER_RELAX_MARKET_STRESS.*live/i));
    });

    it('does NOT warn when EXCHANGE_ENV=live and PAPER_RELAX_MARKET_STRESS=false (flag is correctly off)', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_MARKET_STRESS: false,
        });

        // The unset-secret warnings are expected; only assert no misconfig warn fires.
        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_MARKET_STRESS/i.test(String(msg)));
        expect(misconfigWarns).toHaveLength(0);
    });

    it('does NOT warn when EXCHANGE_ENV=paper and PAPER_RELAX_MARKET_STRESS=true (intended use)', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_MARKET_STRESS: true,
        });

        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_MARKET_STRESS/i.test(String(msg)));
        expect(misconfigWarns).toHaveLength(0);
    });
});

// ─── paperMaxIdiosyncraticSlots ───────────────────────────────────────────────

describe('AppConfigService M25 — paperMaxIdiosyncraticSlots', () => {
    it('returns 1 when set to 1', () => {
        const service = buildService({
            PAPER_MAX_IDIOSYNCRATIC_SLOTS: 1,
        });

        expect(service.paperMaxIdiosyncraticSlots).toBe(1);
    });

    it('returns 2 when set to 2 (the maximum allowed value)', () => {
        const service = buildService({
            PAPER_MAX_IDIOSYNCRATIC_SLOTS: 2,
        });

        expect(service.paperMaxIdiosyncraticSlots).toBe(2);
    });

    it('returns undefined when unset (no slot override)', () => {
        const service = buildService({
            PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        });

        expect(service.paperMaxIdiosyncraticSlots).toBeUndefined();
    });
});
