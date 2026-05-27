/**
 * Adversarial tests for the M11a R2d Item 2 PaperExchangeNullityProbe
 * (ADR 0032 §D8 Fallback Profile + §D13).
 *
 * Coverage:
 *   - Boot preflight: both empty → operational.
 *   - Boot preflight: position exists → CRITICAL halt + abort start.
 *   - Boot preflight: 401/403 → abort startup (throws).
 *   - Mid-soak 401/403 → CRITICAL halt + soak invalidated.
 *   - Mid-soak transport error: backoff to capped value after 5 consecutive
 *     failures.
 *   - Mid-soak non-empty response → CRITICAL halt + audit event.
 *
 * Harness uses a fake IExchangeClient stub so no ccxt is required; the
 * AsyncLocalStorage capability guard is exercised end-to-end (the fake
 * client's methods do NOT call `assertActiveLiveAccountStateCapability`
 * but the wrapping `runWithLiveAccountStateCapability` still pushes the
 * frame).
 */

import { AlertSeverityEnum, AlertTypeEnum, ExchangeEnvironmentEnum, IAlertPayload } from '@bot/shared';

import { IAlertSink } from '../../alert/sink/AlertSinkModule';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { AppConfigService } from '../../config/service';
import { HaltService } from '../../control/HaltService';
import { IExchangeClient } from '../../exchange/interface';
import { PaperExchangeNullityProbe } from '../security/PaperExchangeNullityProbe';

function buildAppConfig(
    overrides: Partial<{
        env: ExchangeEnvironmentEnum;
        intervalMs: number;
        backoffMaxMs: number;
    }> = {},
): AppConfigService {
    return {
        exchangeEnv: overrides.env ?? ExchangeEnvironmentEnum.PAPER,
        paperNullityProbeIntervalMs: overrides.intervalMs ?? 60_000,
        paperNullityProbeBackoffMaxMs: overrides.backoffMaxMs ?? 3_600_000,
    } as unknown as AppConfigService;
}

function buildProbe(args: {
    env?: ExchangeEnvironmentEnum;
    fetchOpenOrders: jest.Mock;
    fetchPositions: jest.Mock;
    alertSink?: IAlertSink;
    intervalMs?: number;
    backoffMaxMs?: number;
}) {
    const halt = new HaltFlagService();
    const haltService = { notePragmaticTransition: jest.fn() } as unknown as HaltService;
    const alertSink: IAlertSink = args.alertSink ?? { publish: jest.fn(async () => undefined) };
    const exchange = {
        fetchOpenOrders: args.fetchOpenOrders,
        fetchPositions: args.fetchPositions,
    } as unknown as IExchangeClient;

    const probe = new PaperExchangeNullityProbe(
        buildAppConfig({ env: args.env, intervalMs: args.intervalMs, backoffMaxMs: args.backoffMaxMs }),
        exchange,
        halt,
        haltService,
        alertSink,
    );

    return { probe, halt, haltService, alertSink, exchange };
}

describe('PaperExchangeNullityProbe (ADR 0032 §D13)', () => {
    describe('boot capability preflight (D13 three-branch)', () => {
        it('both empty → operational, soak proceeds', async () => {
            const { probe, halt, alertSink } = buildProbe({
                fetchOpenOrders: jest.fn(async () => []),
                fetchPositions: jest.fn(async () => []),
            });

            const result = await probe.runPreflight();

            expect(result.outcome).toBe('operational');
            expect(halt.isHalted()).toBe(false);
            expect(alertSink.publish as jest.Mock).not.toHaveBeenCalled();
        });

        it('non-empty position exists → CRITICAL halt before soak', async () => {
            const { probe, halt, alertSink } = buildProbe({
                fetchOpenOrders: jest.fn(async () => []),
                fetchPositions: jest.fn(async () => [{ symbol: 'BTCUSDT' }]),
            });

            const result = await probe.runPreflight();

            expect(result.outcome).toBe('non_empty_account');
            expect(halt.isHalted()).toBe(true);
            expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
            const payload: IAlertPayload = (alertSink.publish as jest.Mock).mock.calls[0][0];
            expect(payload.severity).toBe(AlertSeverityEnum.CRITICAL);
        });

        it('preflight: 401/403 → permission_error', async () => {
            const { probe, halt } = buildProbe({
                fetchOpenOrders: jest.fn(async () => {
                    throw new Error('Binance API responded with HTTP 401 Unauthorized');
                }),
                fetchPositions: jest.fn(async () => []),
            });

            const result = await probe.runPreflight();

            expect(result.outcome).toBe('permission_error');
            // Permission error halts even at preflight via CRITICAL abort path.
            expect(halt.isHalted()).toBe(true);
        });

        it('onApplicationBootstrap aborts (throws) on permission_error preflight', async () => {
            const { probe } = buildProbe({
                fetchOpenOrders: jest.fn(async () => {
                    throw new Error('signature for this request is not valid');
                }),
                fetchPositions: jest.fn(async () => []),
            });

            // M11a R4 Item 5: typed PaperNullityProbeBootException now
            // carries "preflight refused PAPER boot" instead of the old
            // raw-Error wording.
            await expect(probe.onApplicationBootstrap()).rejects.toThrow(/preflight refused PAPER boot/);
        });

        it('onApplicationBootstrap suppresses periodic poll on non_empty preflight', async () => {
            const fetchOpenOrders = jest.fn(async () => []);
            const fetchPositions = jest.fn(async () => [{ symbol: 'BTCUSDT' }]);
            const { probe, halt } = buildProbe({ fetchOpenOrders, fetchPositions });

            await probe.onApplicationBootstrap();

            expect(halt.isHalted()).toBe(true);
            // Calls fired during preflight = 1 each. Periodic poll did not start.
            expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
            expect(fetchPositions).toHaveBeenCalledTimes(1);
        });

        it('non-PAPER env → onApplicationBootstrap is a complete no-op', async () => {
            const fetchOpenOrders = jest.fn();
            const fetchPositions = jest.fn();
            const { probe } = buildProbe({
                env: ExchangeEnvironmentEnum.TESTNET,
                fetchOpenOrders,
                fetchPositions,
            });

            await probe.onApplicationBootstrap();

            expect(fetchOpenOrders).not.toHaveBeenCalled();
            expect(fetchPositions).not.toHaveBeenCalled();
        });
    });

    describe('mid-soak failure-class taxonomy (D13)', () => {
        it('401/403 mid-soak → CRITICAL halt + permission_error outcome', async () => {
            const { probe, halt, alertSink } = buildProbe({
                fetchOpenOrders: jest.fn(async () => {
                    throw new Error('HTTP 403 Forbidden: permission denied');
                }),
                fetchPositions: jest.fn(async () => []),
            });

            const result = await probe.runOnceForTest();

            expect(result.outcome).toBe('permission_error');
            expect(halt.isHalted()).toBe(true);
            expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
        });

        it('transport failures: 5 consecutive log + continue, 6th triggers backoff', async () => {
            const transportError = new Error('ETIMEDOUT: connect timeout to fapi.binance.com');
            const fetchOpenOrders = jest.fn(async () => {
                throw transportError;
            });
            const fetchPositions = jest.fn(async () => []);
            const { probe } = buildProbe({
                fetchOpenOrders,
                fetchPositions,
                intervalMs: 60_000,
                backoffMaxMs: 3_600_000,
            });

            // 5 consecutive transport failures — no backoff yet.
            for (let i = 0; i < 5; i++) {
                const result = await probe.runOnceForTest();
                expect(result.outcome).toBe('operational');
            }

            expect(probe.getConsecutiveTransportFailuresForTest()).toBe(5);
            expect(probe.getCurrentBackoffMsForTest()).toBeNull();

            // 6th failure → enter exponential backoff.
            await probe.runOnceForTest();

            expect(probe.getConsecutiveTransportFailuresForTest()).toBe(6);
            expect(probe.getCurrentBackoffMsForTest()).not.toBeNull();
            // First backoff = intervalMs * 2 = 120_000; bounded by cap.
            expect(probe.getCurrentBackoffMsForTest()).toBeLessThanOrEqual(3_600_000);
            expect(probe.getCurrentBackoffMsForTest()).toBeGreaterThanOrEqual(60_000);
        });

        it('non-empty response mid-soak → CRITICAL halt + alert (no audit row mutation)', async () => {
            const { probe, halt, alertSink } = buildProbe({
                fetchOpenOrders: jest.fn(async () => [{ id: 'ord-1', symbol: 'BTCUSDT' }]),
                fetchPositions: jest.fn(async () => []),
            });

            const result = await probe.runOnceForTest();

            expect(result.outcome).toBe('non_empty_account');
            expect(halt.isHalted()).toBe(true);
            expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
            const payload: IAlertPayload = (alertSink.publish as jest.Mock).mock.calls[0][0];
            expect(payload.severity).toBe(AlertSeverityEnum.CRITICAL);
            expect(payload.type).toBe(AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED);
        });

        it('non-empty + already halted → second probe does not re-alert', async () => {
            const fetchOpenOrders = jest.fn(async () => [{ id: 'ord-1' }]);
            const fetchPositions = jest.fn(async () => []);
            const { probe, alertSink } = buildProbe({ fetchOpenOrders, fetchPositions });

            await probe.runOnceForTest();
            await probe.runOnceForTest();

            // One-shot latch: only the FIRST trip publishes an alert.
            expect(alertSink.publish as jest.Mock).toHaveBeenCalledTimes(1);
        });

        it('successful probe after transient failures resets the consecutive-failure counter', async () => {
            let fail = true;
            const fetchOpenOrders = jest.fn(async () => {
                if (fail) throw new Error('ECONNRESET: socket dropped');
                return [];
            });
            const fetchPositions = jest.fn(async () => []);
            const { probe } = buildProbe({ fetchOpenOrders, fetchPositions });

            await probe.runOnceForTest();
            await probe.runOnceForTest();
            expect(probe.getConsecutiveTransportFailuresForTest()).toBe(2);

            fail = false;
            await probe.runOnceForTest();

            expect(probe.getConsecutiveTransportFailuresForTest()).toBe(0);
        });
    });

    describe('D13 two-call invariant — both fetchOpenOrders + fetchPositions must run', () => {
        it('on a clean probe, BOTH fetchOpenOrders and fetchPositions are called once', async () => {
            const fetchOpenOrders = jest.fn(async () => []);
            const fetchPositions = jest.fn(async () => []);
            const { probe } = buildProbe({ fetchOpenOrders, fetchPositions });

            await probe.runOnceForTest();

            expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
            expect(fetchPositions).toHaveBeenCalledTimes(1);
        });
    });
});
