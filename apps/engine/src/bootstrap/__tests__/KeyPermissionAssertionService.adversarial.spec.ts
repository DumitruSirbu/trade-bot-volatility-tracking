/**
 * Adversarial tests for KeyPermissionAssertionService (M11a R1.4 — ADR 0028
 * R0.2 + ADR 0032 §D8 Fallback Profile LOCKED).
 *
 * Covers: TESTNET skip path, PAPER failure path with process.exit mock,
 * Fallback Profile reconciliation (PAPER and LIVE both require
 * enableFutures: true), failing predicate clauses, snapshot redaction
 * invariants, audit row contents, Telegram alert clause-names-only
 * requirement, alert title carries env=paper|live so the operator can
 * distinguish profiles.
 */

import { ExchangeEnvironmentEnum, HaltAuditActionEnum, IKeyPermissionSnapshot } from '@bot/shared';

import { KeyPermissionAssertionService } from '../KeyPermissionAssertionService';
import { LiveGoAheadVerifier } from '../LiveGoAheadVerifier';

// ─── test fixtures ────────────────────────────────────────────────────────────

const FUTURE_EXPIRY_MS = Date.now() + 30 * 24 * 60 * 60 * 1000; // +30 days

function buildAcceptableSnapshot(overrides: Partial<IKeyPermissionSnapshot> = {}): IKeyPermissionSnapshot {
    return {
        enableReading: true,
        enableFutures: true,
        enableSpot: false,
        enableWithdrawals: false,
        enableInternalTransfer: false,
        permitsUniversalTransfer: false,
        enableMargin: false,
        enableVanillaOptions: false,
        enableSubAccountManagement: false,
        ipRestrict: true,
        ipAllowList: ['1.2.3.4'],
        tradingAuthorityExpirationTime: FUTURE_EXPIRY_MS,
        fetchedAtMs: Date.now(),
        sourceEndpoints: ['sapiGetAccountApiRestrictions', 'sapiGetAccountApiRestrictionsIpRestriction'],
        ...overrides,
    };
}

function buildMocks(exchangeEnv: ExchangeEnvironmentEnum, snapshot: IKeyPermissionSnapshot | Error | null = null) {
    const appConfig = {
        exchangeEnv,
        exchangeApiKey: 'ABCD1234567890WXYZ',
    } as never;

    const exchange = {
        fetchKeyPermissions: jest.fn<Promise<IKeyPermissionSnapshot>, []>(),
    };

    if (snapshot instanceof Error) {
        exchange.fetchKeyPermissions.mockRejectedValue(snapshot);
    } else if (snapshot !== null) {
        exchange.fetchKeyPermissions.mockResolvedValue(snapshot);
    }

    const auditRepo = {
        appendKeyPermissionAudit: jest.fn().mockResolvedValue(undefined),
    };

    const alerts = {
        publish: jest.fn().mockResolvedValue(undefined),
    };

    const liveGoAhead = {
        verifyOrThrow: jest.fn<Promise<void>, [ExchangeEnvironmentEnum]>().mockResolvedValue(undefined),
    };

    const service = new KeyPermissionAssertionService(
        appConfig,
        exchange as never,
        auditRepo as never,
        alerts as never,
        liveGoAhead as unknown as LiveGoAheadVerifier,
    );

    return { service, exchange, auditRepo, alerts, liveGoAhead };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('KeyPermissionAssertionService — adversarial', () => {
    let processExitSpy: jest.SpyInstance;

    beforeEach(() => {
        // Mock process.exit so the test process does not actually exit.
        processExitSpy = jest.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
            throw new Error(`process.exit called with code ${_code ?? 'undefined'}`);
        });
    });

    afterEach(() => {
        processExitSpy.mockRestore();
    });

    // ── W1.2: TESTNET exemption ──────────────────────────────────────────────

    describe('TESTNET env — assertion is skipped', () => {
        it('does not call fetchKeyPermissions on TESTNET', async () => {
            // BUILD
            const { service, exchange } = buildMocks(ExchangeEnvironmentEnum.TESTNET);

            // OPERATE
            await service.runAssertion(Date.now());

            // CHECK
            expect(exchange.fetchKeyPermissions).not.toHaveBeenCalled();
        });

        it('writes KEY_PERMISSION_ASSERTION_SKIPPED audit row on TESTNET', async () => {
            // BUILD
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.TESTNET);

            // OPERATE
            await service.runAssertion(Date.now());

            // CHECK
            expect(auditRepo.appendKeyPermissionAudit).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_SKIPPED,
                    reason: 'TESTNET_EXEMPT',
                }),
            );
        });

        it('does not fire any Telegram alert on TESTNET (no alert spam during regression)', async () => {
            // BUILD
            const { service, alerts } = buildMocks(ExchangeEnvironmentEnum.TESTNET);

            // OPERATE
            await service.runAssertion(Date.now());

            // CHECK — only the boot-alert fires (env fingerprint); NO failure alert
            const criticalCalls = (alerts.publish as jest.Mock).mock.calls.filter(([payload]: [{ title: string }]) =>
                payload.title?.includes('ASSERTION FAILED'),
            );
            expect(criticalCalls).toHaveLength(0);
        });
    });

    // ── R1.4: PAPER path with acceptable snapshot ────────────────────────────

    describe('PAPER env — acceptable snapshot passes without failure', () => {
        it('resolves without writing FAILED audit row when snapshot is acceptable', async () => {
            // BUILD
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.PAPER, buildAcceptableSnapshot());

            // OPERATE
            await service.runAssertion(Date.now());

            // CHECK
            const failedCalls = (auditRepo.appendKeyPermissionAudit as jest.Mock).mock.calls.filter(
                ([params]: [{ action: HaltAuditActionEnum }]) => params.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED,
            );
            expect(failedCalls).toHaveLength(0);
        });
    });

    // ── W1.2: enableWithdrawals=true causes failure ──────────────────────────

    describe('PAPER env — enableWithdrawals=true causes failure', () => {
        it('calls process.exit(1) and writes FAILED audit row', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableWithdrawals: true });
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit called with code 1');
            expect(processExitSpy).toHaveBeenCalledWith(1);
            expect(auditRepo.appendKeyPermissionAudit).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED,
                }),
            );
        });

        it('Telegram alert body contains only clause names, not IP or expiry values', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({
                enableWithdrawals: true,
                ipAllowList: ['192.168.1.1', '10.0.0.1'],
                tradingAuthorityExpirationTime: FUTURE_EXPIRY_MS,
            });
            const { service, alerts } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK — body must contain the failing clause name
            const alertPayloads = (alerts.publish as jest.Mock).mock.calls.map(([p]: [{ body: string }]) => p.body);
            const failureAlert = alertPayloads.find((b) => typeof b === 'string' && b.includes('enableWithdrawals'));
            expect(failureAlert).toBeDefined();

            // CHECK — must NOT contain IP addresses
            for (const body of alertPayloads) {
                if (typeof body === 'string') {
                    expect(body).not.toMatch(/192\.168\.1\.1/);
                    expect(body).not.toMatch(/10\.0\.0\.1/);
                    // FUTURE_EXPIRY_MS as a string should not appear either
                    expect(body).not.toContain(String(FUTURE_EXPIRY_MS));
                }
            }
        });
    });

    // ── W1.2: tradingAuthorityExpirationTime=-1 sentinel ────────────────────

    describe('tradingAuthorityExpirationTime edge cases', () => {
        it('null expiration time (ADR 0028 §2.2 -1 mapped to null) fails the predicate', async () => {
            // BUILD — the mapper converts -1 to null before handing to the service
            const badSnapshot = buildAcceptableSnapshot({ tradingAuthorityExpirationTime: null });
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');
        });

        it('past expiration time fails the predicate', async () => {
            // BUILD
            const pastMs = Date.now() - 1000;
            const badSnapshot = buildAcceptableSnapshot({ tradingAuthorityExpirationTime: pastMs });
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');
        });

        it('expiration time exactly equal to nowMs fails the predicate (boundary)', async () => {
            // BUILD — boundary: the predicate requires > not >=
            const nowMs = Date.now();
            const badSnapshot = buildAcceptableSnapshot({ tradingAuthorityExpirationTime: nowMs });
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(nowMs)).rejects.toThrow('process.exit');
        });
    });

    // ── W1.2: ipAllowList empty ──────────────────────────────────────────────

    describe('ipAllowList empty — fails predicate', () => {
        it('calls process.exit(1) when ipAllowList is empty', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ ipAllowList: [] });
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');
        });
    });

    // ── W1.2: ipRestrict=false ───────────────────────────────────────────────

    describe('ipRestrict=false — fails predicate', () => {
        it('calls process.exit(1) when ipRestrict is false', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ ipRestrict: false });
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');
        });
    });

    // ── W1.2: fetchKeyPermissions throws → treated as failure ───────────────

    describe('fetchKeyPermissions throwing → assertion failure (ADR 0028 §2.5)', () => {
        it('exits with code 1 when fetchKeyPermissions throws a network error', async () => {
            // BUILD
            const networkError = new Error('ECONNREFUSED');
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, networkError);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');
            expect(processExitSpy).toHaveBeenCalledWith(1);
        });

        it('still fires Telegram alert when fetchKeyPermissions throws', async () => {
            // BUILD
            const networkError = new Error('timeout');
            const { service, alerts } = buildMocks(ExchangeEnvironmentEnum.PAPER, networkError);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK — alert with failure title must fire
            const failureAlerts = (alerts.publish as jest.Mock).mock.calls.filter(
                ([p]: [{ title: string }]) => typeof p.title === 'string' && p.title.includes('ASSERTION FAILED'),
            );
            expect(failureAlerts.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ── W1.2: snapshot redaction invariant ──────────────────────────────────

    describe('snapshot redaction in audit row', () => {
        it('audit row reason does not contain raw IP addresses', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({
                enableWithdrawals: true,
                ipAllowList: ['203.0.113.42'],
                tradingAuthorityExpirationTime: FUTURE_EXPIRY_MS,
            });
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK — reason field should not contain the raw IP
            const calls = (auditRepo.appendKeyPermissionAudit as jest.Mock).mock.calls;
            const failureCalls = calls.filter(([p]: [{ action: HaltAuditActionEnum }]) => p.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED);
            expect(failureCalls.length).toBeGreaterThan(0);
            const reason: string = failureCalls[0][0].reason;
            expect(reason).not.toContain('203.0.113.42');
        });

        it('audit row reason does not contain the raw expiry timestamp', async () => {
            // BUILD
            const specificExpiry = 1_800_000_000_000;
            const badSnapshot = buildAcceptableSnapshot({
                enableWithdrawals: true,
                tradingAuthorityExpirationTime: specificExpiry,
            });
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK
            const calls = (auditRepo.appendKeyPermissionAudit as jest.Mock).mock.calls;
            const failureCalls = calls.filter(([p]: [{ action: HaltAuditActionEnum }]) => p.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED);
            const reason: string = failureCalls[0]?.[0]?.reason ?? '';
            expect(reason).not.toContain(String(specificExpiry));
        });

        it('audit row reason preserves boolean capability names', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableWithdrawals: true, ipRestrict: false });
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK
            const calls = (auditRepo.appendKeyPermissionAudit as jest.Mock).mock.calls;
            const failureCalls = calls.filter(([p]: [{ action: HaltAuditActionEnum }]) => p.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED);
            const reason: string = failureCalls[0]?.[0]?.reason ?? '';
            expect(reason).toContain('enableWithdrawals');
            expect(reason).toContain('ipRestrict');
        });
    });

    // ── W1.2: process.exit is called with code 1 ────────────────────────────

    describe('process.exit assertion', () => {
        it('process.exit(1) is called exactly once on failure', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableMargin: true });
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK
            expect(processExitSpy).toHaveBeenCalledTimes(1);
            expect(processExitSpy).toHaveBeenCalledWith(1);
        });
    });

    // ── R1.4: Fallback Profile reconciliation (ADR 0032 §D8 LOCKED) ────────

    describe('Fallback Profile — PAPER and LIVE both require enableFutures: true', () => {
        it('PAPER with enableFutures=false fails the predicate (Fallback Profile)', async () => {
            // BUILD — the sub-account-zero-balance Fallback Profile requires
            // enableFutures: true for /fapi access. A PAPER key with
            // enableFutures=false would have been correct under the original
            // D8 design but is now a hard error under the operative profile.
            const badSnapshot = buildAcceptableSnapshot({ enableFutures: false });
            const { service } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');
        });

        it('LIVE with enableFutures=false fails the predicate (unchanged from W1.2)', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableFutures: false });
            const { service } = buildMocks(ExchangeEnvironmentEnum.LIVE, badSnapshot);

            // OPERATE + CHECK
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');
        });

        it('PAPER with enableFutures=true + remaining Fallback Profile flags passes', async () => {
            // BUILD — confirms the Fallback Profile happy path
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.PAPER, buildAcceptableSnapshot({ enableFutures: true }));

            // OPERATE
            await service.runAssertion(Date.now());

            // CHECK — no FAILED audit row written
            const failedCalls = (auditRepo.appendKeyPermissionAudit as jest.Mock).mock.calls.filter(
                ([params]: [{ action: HaltAuditActionEnum }]) => params.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED,
            );
            expect(failedCalls).toHaveLength(0);
        });
    });

    // ── R1.4: alert title distinguishes PAPER from LIVE ─────────────────────

    describe('failure alert title carries env so operator can distinguish PAPER vs LIVE', () => {
        it('PAPER failure → alert title contains env=paper', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableWithdrawals: true });
            const { service, alerts } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK
            const failureTitles = (alerts.publish as jest.Mock).mock.calls
                .map(([p]: [{ title: string }]) => p.title)
                .filter((t: string) => typeof t === 'string' && t.includes('ASSERTION FAILED'));
            expect(failureTitles.length).toBeGreaterThan(0);
            expect(failureTitles.some((t: string) => t.includes('env=paper'))).toBe(true);
        });

        it('LIVE failure → alert title contains env=live', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableWithdrawals: true });
            const { service, alerts } = buildMocks(ExchangeEnvironmentEnum.LIVE, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK
            const failureTitles = (alerts.publish as jest.Mock).mock.calls
                .map(([p]: [{ title: string }]) => p.title)
                .filter((t: string) => typeof t === 'string' && t.includes('ASSERTION FAILED'));
            expect(failureTitles.length).toBeGreaterThan(0);
            expect(failureTitles.some((t: string) => t.includes('env=live'))).toBe(true);
        });
    });

    // ── R1: audit row `reason` field carries the env=<paper|live> prefix ─────

    describe('failure audit row reason carries env prefix', () => {
        it('PAPER failure → audit row reason starts with env=paper', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableWithdrawals: true });
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.PAPER, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK
            const calls = (auditRepo.appendKeyPermissionAudit as jest.Mock).mock.calls;
            const failureCalls = calls.filter(([p]: [{ action: HaltAuditActionEnum }]) => p.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED);
            expect(failureCalls.length).toBeGreaterThan(0);
            const reason: string = failureCalls[0][0].reason;
            expect(reason.startsWith('env=paper')).toBe(true);
        });

        it('LIVE failure → audit row reason starts with env=live', async () => {
            // BUILD
            const badSnapshot = buildAcceptableSnapshot({ enableWithdrawals: true });
            const { service, auditRepo } = buildMocks(ExchangeEnvironmentEnum.LIVE, badSnapshot);

            // OPERATE
            await expect(service.runAssertion(Date.now())).rejects.toThrow('process.exit');

            // CHECK
            const calls = (auditRepo.appendKeyPermissionAudit as jest.Mock).mock.calls;
            const failureCalls = calls.filter(([p]: [{ action: HaltAuditActionEnum }]) => p.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED);
            expect(failureCalls.length).toBeGreaterThan(0);
            const reason: string = failureCalls[0][0].reason;
            expect(reason.startsWith('env=live')).toBe(true);
        });
    });
});
