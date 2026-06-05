/**
 * HaltFlagService — M23 haltedLeg / getHaltedLeg
 *
 * Surfaces under test:
 *   HL1 — halt('market_stress:<leg>') → getHaltedLeg() returns bare leg token
 *   HL2 — halt with non-market_stress reason → getHaltedLeg() returns null
 *   HL3 — after resume() → getHaltedLeg() returns null
 *   HL4 — getHaltedLeg() never returns the full reason string
 *
 * Command-Query Separation is preserved: halt/resume are state-changers,
 * getHaltedLeg/getReason are pure reads with no side effects.
 */

import { HaltFlagService } from '../HaltFlagService';

function buildService(): HaltFlagService {
    return new HaltFlagService();
}

// ─── HL1: market_stress:<leg> reasons parse to bare leg token ────────────────

describe('HaltFlagService.getHaltedLeg — HL1: market_stress:<leg> halt writes bare leg token', () => {
    it('halt("market_stress:breadth") → getHaltedLeg() returns "breadth"', () => {
        const service = buildService();

        service.halt('market_stress:breadth');

        expect(service.getHaltedLeg()).toBe('breadth');
    });

    it('halt("market_stress:btc_shock") → getHaltedLeg() returns "btc_shock"', () => {
        const service = buildService();

        service.halt('market_stress:btc_shock');

        expect(service.getHaltedLeg()).toBe('btc_shock');
    });

    it('halt("market_stress:eth_shock") → getHaltedLeg() returns "eth_shock"', () => {
        const service = buildService();

        service.halt('market_stress:eth_shock');

        expect(service.getHaltedLeg()).toBe('eth_shock');
    });

    it('halt("market_stress:oi") → getHaltedLeg() returns "oi"', () => {
        const service = buildService();

        service.halt('market_stress:oi');

        expect(service.getHaltedLeg()).toBe('oi');
    });

    it('halt("market_stress:funding") → getHaltedLeg() returns "funding"', () => {
        const service = buildService();

        service.halt('market_stress:funding');

        expect(service.getHaltedLeg()).toBe('funding');
    });

    it('halt("market_stress:spread") → getHaltedLeg() returns "spread"', () => {
        const service = buildService();

        service.halt('market_stress:spread');

        expect(service.getHaltedLeg()).toBe('spread');
    });

    it('halt("market_stress:same_bar") → getHaltedLeg() returns "same_bar"', () => {
        const service = buildService();

        service.halt('market_stress:same_bar');

        expect(service.getHaltedLeg()).toBe('same_bar');
    });

    it('halt("market_stress:multi") → getHaltedLeg() returns "multi"', () => {
        const service = buildService();

        service.halt('market_stress:multi');

        expect(service.getHaltedLeg()).toBe('multi');
    });

    it('halt("market_stress:invalid") → getHaltedLeg() returns "invalid"', () => {
        const service = buildService();

        service.halt('market_stress:invalid');

        expect(service.getHaltedLeg()).toBe('invalid');
    });
});

// ─── HL2: non-market_stress reasons return null ───────────────────────────────

describe('HaltFlagService.getHaltedLeg — HL2: non-market_stress reason → getHaltedLeg() returns null', () => {
    it('halt("consecutive_loss_halt") → getHaltedLeg() returns null', () => {
        const service = buildService();

        service.halt('consecutive_loss_halt');

        expect(service.getHaltedLeg()).toBeNull();
    });

    it('halt("daily_loss_limit") → getHaltedLeg() returns null', () => {
        const service = buildService();

        service.halt('daily_loss_limit');

        expect(service.getHaltedLeg()).toBeNull();
    });

    it('halt("weekly_loss_limit") → getHaltedLeg() returns null', () => {
        const service = buildService();

        service.halt('weekly_loss_limit');

        expect(service.getHaltedLeg()).toBeNull();
    });

    it('halt("model_divergence_halt") → getHaltedLeg() returns null', () => {
        const service = buildService();

        service.halt('model_divergence_halt');

        expect(service.getHaltedLeg()).toBeNull();
    });

    it('halt("operator:resume") → getHaltedLeg() returns null (not a market_stress reason)', () => {
        const service = buildService();

        service.halt('operator:resume');

        expect(service.getHaltedLeg()).toBeNull();
    });

    it('halt("market_stress") (bare, no suffix) → getHaltedLeg() returns null (empty suffix)', () => {
        // A legacy bare reason written before M23 should not parse a leg token
        const service = buildService();

        service.halt('market_stress');

        expect(service.getHaltedLeg()).toBeNull();
    });
});

// ─── HL3: resume() clears the halted leg ─────────────────────────────────────

describe('HaltFlagService.getHaltedLeg — HL3: resume() clears the leg token', () => {
    it('after halt("market_stress:breadth") then resume() → getHaltedLeg() returns null', () => {
        const service = buildService();

        service.halt('market_stress:breadth');
        expect(service.getHaltedLeg()).toBe('breadth'); // pre-condition

        service.resume();

        expect(service.getHaltedLeg()).toBeNull();
    });

    it('after halt("market_stress:multi") then resume() → isHalted() false and getHaltedLeg() null', () => {
        const service = buildService();

        service.halt('market_stress:multi');
        service.resume();

        expect(service.isHalted()).toBe(false);
        expect(service.getHaltedLeg()).toBeNull();
    });

    it('resume() on a non-market_stress halt also nulls getHaltedLeg()', () => {
        const service = buildService();

        service.halt('consecutive_loss_halt');
        service.resume();

        expect(service.getHaltedLeg()).toBeNull();
    });
});

// ─── HL4: getHaltedLeg never returns the full reason string ──────────────────

describe('HaltFlagService.getHaltedLeg — HL4: never returns the full reason string, only bare token or null', () => {
    it('getHaltedLeg() is not "market_stress:breadth" — it is just "breadth"', () => {
        const service = buildService();

        service.halt('market_stress:breadth');

        const leg = service.getHaltedLeg();

        expect(leg).not.toBe('market_stress:breadth');
        expect(leg).toBe('breadth');
    });

    it('getHaltedLeg() is not "market_stress:multi" — it is just "multi"', () => {
        const service = buildService();

        service.halt('market_stress:multi');

        const leg = service.getHaltedLeg();

        expect(leg).not.toContain('market_stress:');
        expect(leg).toBe('multi');
    });

    it('getReason() returns the full reason string, getHaltedLeg() returns only the suffix', () => {
        const service = buildService();

        service.halt('market_stress:btc_shock');

        // Full reason accessible via existing getReason()
        expect(service.getReason()).toBe('market_stress:btc_shock');
        // Leg accessor returns only the bare token
        expect(service.getHaltedLeg()).toBe('btc_shock');
    });
});

// ─── Initial state ────────────────────────────────────────────────────────────

describe('HaltFlagService.getHaltedLeg — initial state', () => {
    it('newly constructed service has getHaltedLeg() = null', () => {
        const service = buildService();

        expect(service.getHaltedLeg()).toBeNull();
        expect(service.isHalted()).toBe(false);
    });
});
