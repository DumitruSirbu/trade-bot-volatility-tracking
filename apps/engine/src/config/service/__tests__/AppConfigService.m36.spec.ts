/**
 * AppConfigService — M36 paperRelaxConsecutiveLossHalt getter
 *
 * Tests the two-condition gate (mirrors M25 paperRelaxMarketStress pattern):
 *   paperRelaxConsecutiveLossHalt is true ONLY when EXCHANGE_ENV=paper AND
 *   PAPER_RELAX_CONSECUTIVE_LOSS_HALT=true. Live, testnet, and absent/false
 *   flag all return false.
 *
 * Raw-string @Transform coercion (PAPER_RELAX_CONSECUTIVE_LOSS_HALT: 'false' → false,
 * absent → false, 'TRUE' → true) is validated by the EnvironmentVariables schema via
 * class-transformer. This spec tests post-coercion behavior only — the ConfigService
 * stub always receives already-coerced booleans matching what validateEnv produces.
 *
 * The AppConfigService constructor reads process.env for auth secrets but generates
 * safe per-process random secrets in non-production, so the constructor succeeds here
 * without setting auth env vars.
 *
 * Tests:
 *   CFG1 — EXCHANGE_ENV=paper  + flag=true  → returns true
 *   CFG2 — EXCHANGE_ENV=live   + flag=true  → returns false (neutralized)
 *   CFG3 — EXCHANGE_ENV=testnet + flag=true → returns false (neutralized)
 *   CFG4 — EXCHANGE_ENV=paper  + flag=false → returns false
 *   CFG5 — EXCHANGE_ENV=paper  + flag absent (schema default=false) → returns false
 *   CFG6 — EXCHANGE_ENV=live   + flag=true → logs a warn containing the flag name and env
 *   CFG7 — EXCHANGE_ENV=live   + flag=false → does NOT log a misconfig warn
 *   CFG8 — EXCHANGE_ENV=paper  + flag=true → does NOT log a misconfig warn
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Logger } from '@nestjs/common';

import { AppConfigService } from '../AppConfigService';
import { EnvironmentVariables } from '../../EnvironmentVariables';

// ─── factory helpers ──────────────────────────────────────────────────────────

/**
 * Builds a minimal ConfigService stub matching the shape AppConfigService.get()
 * requires. Only the keys consumed by resolvePaperRelaxConsecutiveLossHalt and
 * exchangeEnv need to be populated; the constructor's other process.env calls
 * use safe dev fallbacks.
 */
function buildConfigService(overrides: Partial<EnvironmentVariables> = {}) {
    const config: Partial<EnvironmentVariables> = {
        NODE_ENV: 'test' as any,
        EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
        PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        MARKET_STRESS_AUTO_RESUME_ENABLED: undefined,
        PAPER_RELAX_MARKET_STRESS: false,
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

describe('AppConfigService M36 — paperRelaxConsecutiveLossHalt two-condition gate', () => {
    it('CFG1: EXCHANGE_ENV=paper and flag=true → returns true', () => {
        // BUILD
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: true,
        });

        // CHECK
        expect(service.paperRelaxConsecutiveLossHalt).toBe(true);
    });

    it('CFG2: EXCHANGE_ENV=live and flag=true → returns false (flag neutralized on non-paper env)', () => {
        // BUILD
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: true,
        });

        // CHECK
        expect(service.paperRelaxConsecutiveLossHalt).toBe(false);
    });

    it('CFG3: EXCHANGE_ENV=testnet and flag=true → returns false (flag neutralized on non-paper env)', () => {
        // BUILD
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.TESTNET,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: true,
        });

        // CHECK
        expect(service.paperRelaxConsecutiveLossHalt).toBe(false);
    });

    it('CFG4: EXCHANGE_ENV=paper and flag=false → returns false', () => {
        // BUILD
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        });

        // CHECK
        expect(service.paperRelaxConsecutiveLossHalt).toBe(false);
    });

    it('CFG5: EXCHANGE_ENV=paper and flag absent (schema default=false) → returns false', () => {
        // BUILD — the schema field has a default of false; after @Transform the value is
        // boolean false, not undefined. Passing false here simulates an absent key.
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        });

        // CHECK
        expect(service.paperRelaxConsecutiveLossHalt).toBe(false);
    });
});

// ─── CFG6–CFG8: boot-time misconfig warning ──────────────────────────────────

describe('AppConfigService M36 — paperRelaxConsecutiveLossHalt boot-time misconfig warning', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('CFG6: EXCHANGE_ENV=live + flag=true → logs a warn containing the flag name and env', () => {
        // BUILD
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        // OPERATE
        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: true,
        });

        // CHECK — the misconfig warn must mention the flag name and signal neutralization
        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_CONSECUTIVE_LOSS_HALT/i.test(String(msg)));
        expect(misconfigWarns.length).toBeGreaterThanOrEqual(1);
        expect(String(misconfigWarns[0][0])).toMatch(/live/i);
    });

    it('CFG7: EXCHANGE_ENV=live + flag=false → does NOT log a misconfig warn for this flag', () => {
        // BUILD
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        // OPERATE
        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        });

        // CHECK — unset-secret warns may fire; only assert the misconfig warn does NOT fire
        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_CONSECUTIVE_LOSS_HALT/i.test(String(msg)));
        expect(misconfigWarns).toHaveLength(0);
    });

    it('CFG8: EXCHANGE_ENV=paper + flag=true → logs the active-confirmation warn, NOT a misconfig (NEUTRALIZED) warn', () => {
        // BUILD
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        // OPERATE
        buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: true,
        });

        // CHECK — intended use must not raise the NEUTRALIZED misconfig warn, but
        // MUST raise the active-confirmation warn so the operator sees relax is on.
        const misconfigWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_CONSECUTIVE_LOSS_HALT/i.test(String(msg)) && /NEUTRALIZED/i.test(String(msg)));
        expect(misconfigWarns).toHaveLength(0);

        const activeWarns = warnSpy.mock.calls.filter(([msg]) => /PAPER_RELAX_CONSECUTIVE_LOSS_HALT is active/i.test(String(msg)));
        expect(activeWarns).toHaveLength(1);
    });
});

// ─── Bias-marker stamping contract ───────────────────────────────────────────

describe('AppConfigService M36 — paperRelaxConsecutiveLossHalt drives haltRelaxActive stamping', () => {
    it('getter returns true when the two-condition gate passes, which maps to haltRelaxActive=true on decision rows', () => {
        // BUILD — this asserts the contract that StrategyService/ShadowOrchestrator read:
        // `this.config.paperRelaxConsecutiveLossHalt` is the value stamped on haltRelaxActive.
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.PAPER,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: true,
        });

        // CHECK
        expect(service.paperRelaxConsecutiveLossHalt).toBe(true);
    });

    it('getter returns false for live env, which maps to haltRelaxActive=false on decision rows', () => {
        // BUILD
        const service = buildService({
            EXCHANGE_ENV: ExchangeEnvironmentEnum.LIVE,
            PAPER_RELAX_CONSECUTIVE_LOSS_HALT: false,
        });

        // CHECK
        expect(service.paperRelaxConsecutiveLossHalt).toBe(false);
    });
});
