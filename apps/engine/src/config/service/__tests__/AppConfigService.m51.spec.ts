/**
 * AppConfigService — M51 paperRelaxPerCoinLiquidity getter (ADR 0042 §9)
 *
 * Tests the two-condition gate (mirrors the M25 paperRelaxMarketStress pattern):
 *   paperRelaxPerCoinLiquidity is true ONLY when EXCHANGE_ENV=paper AND
 *   PAPER_RELAX_PER_COIN_LIQUIDITY=true. Live, testnet, and absent/false flag
 *   all return false — this is the security-critical two-condition contract that
 *   makes the per-coin liquidity relax unreachable off paper.
 *
 * Raw-string @Transform coercion (PAPER_RELAX_PER_COIN_LIQUIDITY: 'false' → false,
 * absent → false, 'TRUE' → true) is validated by the EnvironmentVariables schema via
 * class-transformer (see validateEnv.spec). This spec tests post-coercion behavior
 * only — the ConfigService stub always receives already-coerced booleans.
 *
 * Tests:
 *   CFG1 — EXCHANGE_ENV=paper   + flag=true  → returns true
 *   CFG2 — EXCHANGE_ENV=live    + flag=true  → returns false (neutralized)
 *   CFG3 — EXCHANGE_ENV=testnet + flag=true  → returns false (neutralized)
 *   CFG4 — EXCHANGE_ENV=paper   + flag=false → returns false
 *   CFG5 — EXCHANGE_ENV=paper   + flag absent (schema default=false) → returns false
 *   CFG6 — EXCHANGE_ENV=live    + flag=true  → logs a warn containing the flag name and env
 *   CFG7 — EXCHANGE_ENV=live    + flag=false → does NOT log a misconfig warn
 *   CFG8 — EXCHANGE_ENV=paper   + flag=true  → active-confirmation warn, NOT a NEUTRALIZED warn
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Logger } from '@nestjs/common';

import { AppConfigService } from '../AppConfigService';
import { EnvironmentVariables } from '../../EnvironmentVariables';

function buildConfigService(overrides: Partial<EnvironmentVariables> = {}) {
    const config: Partial<EnvironmentVariables> = {
        NODE_ENV: 'test' as any,
        EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
        PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
        PAPER_RELAX_MARKET_STRESS: false,
        PAPER_RELAX_PER_COIN_LIQUIDITY: false,
        PAPER_MAX_IDIOSYNCRATIC_SLOTS: undefined,
        ...overrides,
    };

    return {
        get: (key: string) => (config as Record<string, unknown>)[key],
    } as never;
}

function buildService(overrides: Partial<EnvironmentVariables> = {}): AppConfigService {
    return new AppConfigService(buildConfigService(overrides));
}

// ─── CFG1–CFG5: two-condition gate ───────────────────────────────────────────

describe('AppConfigService M51 — paperRelaxPerCoinLiquidity two-condition gate', () => {
    it('CFG1: EXCHANGE_ENV=paper and flag=true → returns true', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
        });

        expect(service.paperRelaxPerCoinLiquidity).toBe(true);
    });

    it('CFG2: EXCHANGE_ENV=live and flag=true → returns false (neutralized on non-paper env)', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
        });

        expect(service.paperRelaxPerCoinLiquidity).toBe(false);
    });

    it('CFG3: EXCHANGE_ENV=testnet and flag=true → returns false (neutralized on non-paper env)', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
        });

        expect(service.paperRelaxPerCoinLiquidity).toBe(false);
    });

    it('CFG4: EXCHANGE_ENV=paper and flag=false → returns false', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_PER_COIN_LIQUIDITY: false,
        });

        expect(service.paperRelaxPerCoinLiquidity).toBe(false);
    });

    it('CFG5: EXCHANGE_ENV=paper and flag absent (schema default=false) → returns false', () => {
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_PER_COIN_LIQUIDITY: false,
        });

        expect(service.paperRelaxPerCoinLiquidity).toBe(false);
    });
});

// ─── CFG6–CFG8: boot-time misconfig warning ──────────────────────────────────

describe('AppConfigService M51 — paperRelaxPerCoinLiquidity boot-time misconfig warning', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('CFG6: EXCHANGE_ENV=live + flag=true → logs a warn containing the flag name and env', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
        });

        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_PER_COIN_LIQUIDITY/i.test(String(msg)) && /NEUTRALIZED/i.test(String(msg)));
        expect(misconfigWarns.length).toBeGreaterThanOrEqual(1);
        expect(String(misconfigWarns[0][0])).toMatch(/live/i);
    });

    it('CFG7: EXCHANGE_ENV=live + flag=false → does NOT log a misconfig warn for this flag', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_PER_COIN_LIQUIDITY: false,
        });

        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_PER_COIN_LIQUIDITY/i.test(String(msg)));
        expect(misconfigWarns).toHaveLength(0);
    });

    it('CFG8: EXCHANGE_ENV=paper + flag=true → active-confirmation warn, NOT a NEUTRALIZED misconfig warn', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
        });

        const neutralizedWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_PER_COIN_LIQUIDITY/i.test(String(msg)) && /NEUTRALIZED/i.test(String(msg)));
        expect(neutralizedWarns).toHaveLength(0);

        const activeWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_PER_COIN_LIQUIDITY is active/i.test(String(msg)));
        expect(activeWarns).toHaveLength(1);
    });
});

// ─── CFG9–CFG11: relaxed-floor safety-math coupling advisory (ADR 0042 §9) ────
//
// The relaxed $2,500 depth floor's safety rationale assumes a max per-coin order of <=$500. When
// the relax is active AND the operator raised MAX_EXPOSURE_PER_COIN_USDT past $500, a single
// advisory warn fires (never a throw) so the book-impact assumption drift is visible at boot.

function extractSafetyMathWarns(warnSpy: jest.SpyInstance): unknown[] {
    return warnSpy.mock.calls.filter(([msg]) => /max-order assumption/i.test(String(msg)));
}

describe('AppConfigService M51 — relaxed-floor safety-math coupling advisory', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('CFG9: relax active + MAX_EXPOSURE_PER_COIN_USDT above $500 → fires the safety-math advisory warn', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
            MAX_EXPOSURE_PER_COIN_USDT: 1_000,
        });

        const safetyWarns = extractSafetyMathWarns(warnSpy);
        expect(safetyWarns).toHaveLength(1);
        expect(String(safetyWarns[0])).toMatch(/1000/);
    });

    it('CFG10: relax active + MAX_EXPOSURE_PER_COIN_USDT exactly $500 (boundary) → does NOT fire the advisory warn', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
            MAX_EXPOSURE_PER_COIN_USDT: 500,
        });

        expect(extractSafetyMathWarns(warnSpy)).toHaveLength(0);
    });

    it('CFG11: relax NEUTRALIZED on live + MAX_EXPOSURE_PER_COIN_USDT above $500 → does NOT fire the advisory warn', () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_PER_COIN_LIQUIDITY: true,
            MAX_EXPOSURE_PER_COIN_USDT: 1_000,
        });

        expect(extractSafetyMathWarns(warnSpy)).toHaveLength(0);
    });
});
