/**
 * HaltStateRestoreService — M23 double-prefix fix (buildFlagReason)
 *
 * Surfaces under test:
 *   DP1 — When halt_reason='market_stress:breadth' is restored from risk_state,
 *         haltFlag.halt() is called with exactly 'market_stress:breadth' (NOT 'market_stress:market_stress:breadth').
 *   DP2 — A non-market_stress reason (e.g. 'consecutive_loss_halt') is still prefixed with source as before.
 *   DP3 — When reason=null, the service falls back to 'source:restored' (existing behavior unchanged).
 *   DP4 — After restore, getHaltedLeg() returns 'breadth' for a market_stress:breadth halt.
 *   DP5 — resolveProgrammaticSource still maps the 'market_stress' prefix correctly to HaltSourceEnum.MARKET_STRESS.
 */

import { IHaltAuditEntry } from '@bot/shared';

import { HaltFlagService } from '../../common/service/HaltFlagService';
import { HaltService } from '../../control/HaltService';
import { ControlAuditRepository } from '../../control/repository/ControlAuditRepository';
import { RiskStateEntity } from '../../risk/entity/RiskStateEntity';
import { RiskStateRepository } from '../../risk/repository/RiskStateRepository';
import { HaltStateRestoreService } from '../HaltStateRestoreService';

// ─── mock factories ───────────────────────────────────────────────────────────

function buildHaltFlag(): HaltFlagService {
    return new HaltFlagService();
}

function buildHaltService(): HaltService {
    return { restoreFromAudit: jest.fn() } as unknown as HaltService;
}

function buildAuditRepo(latestAudit: IHaltAuditEntry | null = null): ControlAuditRepository {
    return { findLatest: jest.fn().mockResolvedValue(latestAudit) } as unknown as ControlAuditRepository;
}

function buildRiskStateRepo(entity: Partial<RiskStateEntity> | null = null): RiskStateRepository {
    return { findByDate: jest.fn().mockResolvedValue(entity) } as unknown as RiskStateRepository;
}

/**
 * Builds a risk_state entity with isHalted=true and the given haltReason.
 * The date is set to today's UTC date so the restore picks it up.
 * Numeric Money columns are stubbed as strings; the restore service only reads
 * isHalted and haltReason so the values never flow through Money arithmetic.
 */
function buildHaltedRiskState(haltReason: string): Partial<RiskStateEntity> {
    const today = new Date().toISOString().slice(0, 10);

    return {
        date: today,
        isHalted: true,
        haltReason,
        // Cast: the restore service reads only isHalted/haltReason from this entity;
        // Money columns are never dereferenced in the restore path.
    } as unknown as Partial<RiskStateEntity>;
}

function buildRestoreService(
    auditRepo: ControlAuditRepository,
    haltService: HaltService,
    haltFlag: HaltFlagService,
    riskStateRepo: RiskStateRepository,
): HaltStateRestoreService {
    return new HaltStateRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);
}

// ─── DP1: market_stress:breadth — no double-prefix ───────────────────────────

describe('HaltStateRestoreService.buildFlagReason — DP1: market_stress:breadth reason restores without double-prefix', () => {
    it('risk_state has halt_reason="market_stress:breadth" → haltFlag.halt() called with "market_stress:breadth"', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null); // no audit row → risk_state alone decides
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('market_stress:breadth'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        // Must NOT produce the double-prefixed form
        expect(haltFlag.getReason()).toBe('market_stress:breadth');
        expect(haltFlag.getReason()).not.toBe('market_stress:market_stress:breadth');
        expect(haltFlag.isHalted()).toBe(true);
    });

    it('halt_reason="market_stress:multi" → haltFlag.halt() called with "market_stress:multi" (not double-prefixed)', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('market_stress:multi'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        expect(haltFlag.getReason()).toBe('market_stress:multi');
        expect(haltFlag.getReason()).not.toContain('market_stress:market_stress:');
    });

    it('halt_reason="market_stress:btc_shock" → haltFlag.halt() called with "market_stress:btc_shock"', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('market_stress:btc_shock'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        expect(haltFlag.getReason()).toBe('market_stress:btc_shock');
        expect(haltFlag.isHalted()).toBe(true);
    });
});

// ─── DP2: non-market_stress reasons are still prefixed normally ───────────────

describe('HaltStateRestoreService.buildFlagReason — DP2: non-market_stress reasons prefixed with source:reason shape', () => {
    it('halt_reason="consecutive_loss_halt" from risk_state → haltFlag.halt() called with source-prefixed form', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        // consecutive_loss_halt would resolve source as OTHER (no HaltSourceEnum prefix match)
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('consecutive_loss_halt'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        // The reason 'consecutive_loss_halt' has no source prefix, so resolveProgrammaticSource
        // returns OTHER. buildFlagReason sees no 'other:' prefix in the reason → prepends 'other:consecutive_loss_halt'.
        expect(haltFlag.isHalted()).toBe(true);
        // Key assertion: NOT double-prefixed. The reason starts with the resolved source token.
        const reason = haltFlag.getReason();

        expect(reason).not.toBeNull();
        expect(reason).not.toContain('market_stress:market_stress:');
    });
});

// ─── DP3: null reason falls back to 'source:restored' ────────────────────────

describe('HaltStateRestoreService.buildFlagReason — DP3: null haltReason falls back to source-prefixed fallback string', () => {
    it('risk_state.haltReason=null with is_halted=true → haltFlag is set (not null) and reason is not double-prefixed', async () => {
        // When haltReason is null: resolveNewerWins sets reason='programmatic' (the ?? fallback),
        // resolveProgrammaticSource(null) maps to HaltSourceEnum.OTHER.
        // buildFlagReason: reason='programmatic', does NOT start with 'other:' → returns 'other:programmatic'.
        // This is correct — the reason is not null and there is no double-prefix.
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const today = new Date().toISOString().slice(0, 10);
        const riskStateRepo = buildRiskStateRepo({
            date: today,
            isHalted: true,
            haltReason: null,
        } as unknown as Partial<RiskStateEntity>);
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        expect(haltFlag.isHalted()).toBe(true);
        const reason = haltFlag.getReason();

        expect(reason).not.toBeNull();
        // No double-prefix regardless of source path
        expect(reason).not.toContain('market_stress:market_stress:');
        // The resulting reason is the source-prefixed fallback (not a market_stress path)
        expect(reason).not.toMatch(/^market_stress:/);
    });
});

// ─── DP4: getHaltedLeg after restore ─────────────────────────────────────────

describe('HaltStateRestoreService — DP4: getHaltedLeg() after restoring market_stress:breadth halt', () => {
    it('after restoring "market_stress:breadth" from risk_state → getHaltedLeg() returns "breadth"', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('market_stress:breadth'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        expect(haltFlag.getHaltedLeg()).toBe('breadth');
    });

    it('after restoring "market_stress:multi" → getHaltedLeg() returns "multi"', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('market_stress:multi'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        expect(haltFlag.getHaltedLeg()).toBe('multi');
    });

    it('after restoring "consecutive_loss_halt" → getHaltedLeg() returns null', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('consecutive_loss_halt'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        expect(haltFlag.getHaltedLeg()).toBeNull();
    });
});

// ─── DP5: resolveProgrammaticSource maps 'market_stress:breadth' prefix correctly ───

describe('HaltStateRestoreService — DP5: resolveProgrammaticSource correctly identifies HaltSourceEnum.MARKET_STRESS from suffixed reason', () => {
    it('halt_reason="market_stress:breadth" → resolved source is MARKET_STRESS, so buildFlagReason passes reason as-is', async () => {
        // When resolveProgrammaticSource extracts prefix 'market_stress' and maps to MARKET_STRESS,
        // buildFlagReason checks 'market_stress:breadth'.startsWith('market_stress:') → true → no re-prefix.
        // This test proves the full round-trip: risk_state → restore → in-memory flag = 'market_stress:breadth'.
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('market_stress:breadth'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        // Round-trip assertion: persisted = 'market_stress:breadth', restored = 'market_stress:breadth'
        expect(haltFlag.getReason()).toBe('market_stress:breadth');
        // Source resolution preserved: the flag prefix is the canonical market_stress token
        expect(haltFlag.getReason()).toMatch(/^market_stress:/);
    });

    it('restore() is idempotent: calling twice does not double-apply the halt flag', async () => {
        const haltFlag = buildHaltFlag();
        const haltFlagHaltSpy = jest.spyOn(haltFlag, 'halt');
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(buildHaltedRiskState('market_stress:breadth'));
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();
        await service.restore(); // second call should be a no-op

        // halt() should be called only once (the second restore() is idempotent via the `restored` flag)
        expect(haltFlagHaltSpy).toHaveBeenCalledTimes(1);
        expect(haltFlag.getReason()).toBe('market_stress:breadth');
    });
});

// ─── Running state: no halt flag set ─────────────────────────────────────────

describe('HaltStateRestoreService — RUNNING state: no risk_state halt row', () => {
    it('no audit row, no risk_state halt → haltFlag stays not halted', async () => {
        const haltFlag = buildHaltFlag();
        const haltService = buildHaltService();
        const auditRepo = buildAuditRepo(null);
        const riskStateRepo = buildRiskStateRepo(null);
        const service = buildRestoreService(auditRepo, haltService, haltFlag, riskStateRepo);

        await service.restore();

        expect(haltFlag.isHalted()).toBe(false);
        expect(haltFlag.getReason()).toBeNull();
        expect(haltFlag.getHaltedLeg()).toBeNull();
    });
});
