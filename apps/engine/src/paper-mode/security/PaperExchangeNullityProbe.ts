import { AlertSeverityEnum, AlertTypeEnum, ExchangeEnvironmentEnum, HaltSourceEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { ALERT_SINK, IAlertSink } from '../../alert/sink/AlertSinkModule';
import { HaltFlagService } from '../../common/service/HaltFlagService';
import { AppConfigService } from '../../config/service';
import { HaltService } from '../../control/HaltService';
import { EXCHANGE_CLIENT, IExchangeClient } from '../../exchange/interface';
import { BACKOFF_INITIAL_MULTIPLIER, TRANSPORT_FAILURE_THRESHOLD } from '../const';
import { PaperNullityProbeBootException } from '../exception';
import { runWithLiveAccountStateCapability } from './LiveAccountStateCapabilityGuard';

// PaperExchangeNullityProbe — ADR 0032 §D8 Fallback Profile + §D13.
//
// Defence-in-depth probe INDEPENDENT of PaperExecutionClient. Asserts the
// dedicated Binance sub-account hosting the PAPER key NEVER holds any
// engine-attributed positions or orders. Catches the "an order accidentally
// leaked to live" invariant break that the PaperExecutionClient + module-
// graph sentinel cannot see by themselves.
//
// Two-call probe per D13: an accidental market-order / marketable-IOC fill
// closes immediately and leaves a position with no open-order trace — a
// single `fetchOpenOrders` call would miss that case. Both `fetchOpenOrders`
// AND `fetchPositions` must return empty every cycle.
//
// Fallback Profile (D8 LOCKED): runs under a dedicated zero-balance Binance
// USDT-M Futures sub-account with `enableFutures: true` (required for the
// `/fapi` reads to authorise). All other capability flags must be false and
// the sub-account zero-state invariants are checked at boot.
//
// Capability preflight at PAPER boot (D13 three-branch):
//   1. Both succeed and both empty → probe is operational; soak proceeds.
//   2. Both succeed and a non-empty engine-attributed entry exists → CRITICAL
//      halt BEFORE soak starts; runbook says drain the account.
//   3. Either call returns 401/403/permission/malformed credential → PAPER
//      startup aborts with a clear error. The probe cannot run with this
//      key; either fix the key (per D8) or disable PAPER.
//
// Runtime cadence: one `fetchOpenOrders` + one `fetchPositions` call per
// `PAPER_NULLITY_PROBE_INTERVAL_MS` (default 60_000 — D13 cadence pinned).
// Restricted profile = single-symbol fan-out, so cost is 2 calls/min.
//
// Runtime failure-class taxonomy (D13):
//   - Network / 5xx / timeout → log + continue for up to 5 consecutive
//     failures. On the 6th: WARNING + exponential backoff (cap
//     PAPER_NULLITY_PROBE_BACKOFF_MAX_MS). Binance outage cannot halt soak.
//   - 401/403/permission/malformed → CRITICAL halt + invalidate soak.
//   - Non-empty engine-attributed response → CRITICAL halt + log.
//
// WHITELISTED CCXT REACH (ADR 0032 §3 D14): this is one of the two D14
// exception services (the other is `KeyPermissionAssertionService`). Every
// call into `IExchangeClient`'s account-state methods is wrapped in
// `runWithLiveAccountStateCapability('PaperExchangeNullityProbe', ...)` so
// the AsyncLocalStorage runtime guard accepts the call.
//
// ESLint allowlist: `apps/engine/eslint.config.js` whitelists this exact
// path for the EXCHANGE_CLIENT `no-restricted-syntax` rule.
//
// Module-graph sentinel: the universal "no ccxt import in paper-mode" rule
// is preserved — this file imports the IExchangeClient PORT (an interface,
// erased at runtime), not ccxt itself.

const PERMISSION_ERROR_MARKERS = [
    '401',
    '403',
    'permission',
    'unauthorized',
    'unauthorised',
    'invalid api',
    'invalid_api',
    'apikey',
    'api key',
    'signature',
    'malformed',
    '-2014',
    '-2015',
];

// M11a R4 Item 5: TRANSPORT_FAILURE_THRESHOLD + BACKOFF_INITIAL_MULTIPLIER
// were relocated to `paper-mode/const/paperNullityProbeConsts.ts` and are
// imported above.

type PreflightOutcome = 'operational' | 'non_empty_account' | 'permission_error';

interface IPreflightResult {
    readonly outcome: PreflightOutcome;
    readonly reason: string | null;
}

@Injectable()
export class PaperExchangeNullityProbe implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(PaperExchangeNullityProbe.name);

    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private consecutiveTransportFailures = 0;
    // M11a R4 Item 4B: track the wall-clock instant when the next probe is
    // allowed to run, not "the most recent backoff width". Storing the
    // width let the prior `setInterval` tick skip ONCE and then reset to
    // null — backoff never escalated. With a wall-clock target every
    // subsequent tick re-evaluates `Date.now() < nextProbeAtMs` and skips
    // until the window elapses. `currentBackoffMs` is retained as a
    // monotone width for the test observer + the next-window compute.
    private nextProbeAtMs: number | null = null;
    private currentBackoffMs: number | null = null;
    private haltLatched = false;
    private preflightOutcome: PreflightOutcome | null = null;

    constructor(
        private readonly appConfig: AppConfigService,
        @Inject(EXCHANGE_CLIENT) private readonly exchange: IExchangeClient,
        private readonly haltFlag: HaltFlagService,
        private readonly haltService: HaltService,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            return;
        }

        const preflight = await this.runPreflight();
        this.preflightOutcome = preflight.outcome;

        if (preflight.outcome === 'permission_error') {
            // D13 branch 3: abort PAPER startup with a clear error. The probe
            // is non-optional; running PAPER without it leaves the "no leaked
            // orders" invariant unverified.
            throw new PaperNullityProbeBootException(
                `permission_error: ${preflight.reason ?? 'unknown'}. ` +
                    `Fix the key (per ADR 0032 §D8 Fallback Profile) or disable PAPER. ` +
                    `Soak does NOT start with a decorative probe.`,
            );
        }

        if (preflight.outcome === 'non_empty_account') {
            // D13 branch 2: CRITICAL halt before soak starts; do not start
            // the periodic poll — the operator must drain the account first.
            await this.executeCriticalAbort(
                'PAPER nullity probe preflight: non-empty engine-attributed entry on PAPER sub-account',
                preflight.reason ?? 'unknown',
                Date.now(),
            );
            this.logger.error('PaperExchangeNullityProbe preflight FAILED (non_empty_account); periodic poll suppressed — operator runbook required');

            return;
        }

        this.startPeriodicPoll();
        this.logger.log(`PaperExchangeNullityProbe active: cadence=${this.appConfig.paperNullityProbeIntervalMs}ms`);
    }

    onModuleDestroy(): void {
        this.stopPeriodicPoll();
    }

    // Public for tests + EngineBootstrapService preflight invocation.
    async runPreflight(): Promise<IPreflightResult> {
        return this.executeOneProbe();
    }

    // Public for tests: trigger one probe cycle.
    async runOnceForTest(): Promise<IPreflightResult> {
        return this.executeOneProbe();
    }

    resetForTest(): void {
        this.consecutiveTransportFailures = 0;
        this.currentBackoffMs = null;
        this.nextProbeAtMs = null;
        this.haltLatched = false;
        this.preflightOutcome = null;
        this.stopPeriodicPoll();
    }

    // Test observer — exposes the wall-clock target for the next allowed
    // probe so a regression spec can assert backoff escalation.
    getNextProbeAtMsForTest(): number | null {
        return this.nextProbeAtMs;
    }

    getPreflightOutcomeForTest(): PreflightOutcome | null {
        return this.preflightOutcome;
    }

    getConsecutiveTransportFailuresForTest(): number {
        return this.consecutiveTransportFailures;
    }

    getCurrentBackoffMsForTest(): number | null {
        return this.currentBackoffMs;
    }

    private startPeriodicPoll(): void {
        if (this.timer !== null) {
            return;
        }

        const intervalMs = this.appConfig.paperNullityProbeIntervalMs;
        this.timer = setInterval(() => {
            void this.scheduledTick();
        }, intervalMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    private stopPeriodicPoll(): void {
        if (this.timer === null) {
            return;
        }

        clearInterval(this.timer);
        this.timer = null;
    }

    private async scheduledTick(): Promise<void> {
        if (this.appConfig.exchangeEnv !== ExchangeEnvironmentEnum.PAPER) {
            return;
        }

        if (this.running) {
            this.logger.debug('PaperExchangeNullityProbe scheduled tick skipped: previous probe still running');

            return;
        }

        // M11a R4 Item 4B FIX: backoff is enforced against a wall-clock
        // target so EVERY interval tick that arrives before the window
        // elapses is skipped. The prior implementation cleared
        // `currentBackoffMs` on the first skipped tick, so a 1hr backoff
        // collapsed to a single skip. We now compare `Date.now()` against
        // `nextProbeAtMs` and skip without mutating state.
        if (this.nextProbeAtMs !== null && Date.now() < this.nextProbeAtMs) {
            this.logger.debug(`PaperExchangeNullityProbe in backoff window (next allowed at ${new Date(this.nextProbeAtMs).toISOString()}); tick deferred`);

            return;
        }

        this.running = true;

        try {
            await this.executeOneProbe();
        } catch (cause) {
            this.logger.error(`PaperExchangeNullityProbe scheduled tick failed: ${this.describe(cause)}`);
        } finally {
            this.running = false;
        }
    }

    private async executeOneProbe(): Promise<IPreflightResult> {
        let openOrdersCount = 0;
        let positionsCount = 0;

        try {
            openOrdersCount = await runWithLiveAccountStateCapability('PaperExchangeNullityProbe', async () => {
                const orders = await this.exchange.fetchOpenOrders();

                return orders.length;
            });

            positionsCount = await runWithLiveAccountStateCapability('PaperExchangeNullityProbe', async () => {
                const positions = await this.exchange.fetchPositions();

                return positions.length;
            });
        } catch (cause) {
            return this.classifyProbeFailure(cause);
        }

        // Both succeeded — clear backoff bookkeeping (R4 Item 4B: also
        // clear the wall-clock target so the next failure cycle starts
        // its escalation from the initial multiplier).
        this.consecutiveTransportFailures = 0;
        this.currentBackoffMs = null;
        this.nextProbeAtMs = null;

        if (openOrdersCount === 0 && positionsCount === 0) {
            return { outcome: 'operational', reason: null };
        }

        // Branch 2 — non-empty. CRITICAL halt + invalidate soak.
        const reason = `non-empty PAPER sub-account: openOrders=${openOrdersCount} positions=${positionsCount}`;

        if (!this.haltLatched) {
            await this.executeCriticalAbort('PAPER nullity probe detected engine-attributed entry', reason, Date.now());
            this.haltLatched = true;
        }

        return { outcome: 'non_empty_account', reason };
    }

    private classifyProbeFailure(cause: unknown): IPreflightResult {
        const message = this.describe(cause).toLowerCase();
        const isPermissionError = PERMISSION_ERROR_MARKERS.some((marker) => message.includes(marker));

        if (isPermissionError) {
            const reason = `permission/credential failure: ${this.describe(cause)}`;

            if (!this.haltLatched) {
                void this.executeCriticalAbort('PAPER nullity probe credential failure', reason, Date.now());
                this.haltLatched = true;
            }

            return { outcome: 'permission_error', reason };
        }

        // Transport/5xx/timeout — bounded-window log; on 6th, WARN + backoff.
        this.consecutiveTransportFailures += 1;
        const consecutive = this.consecutiveTransportFailures;

        if (consecutive <= TRANSPORT_FAILURE_THRESHOLD) {
            this.logger.log(`PaperExchangeNullityProbe transport failure ${consecutive}/${TRANSPORT_FAILURE_THRESHOLD}: ${this.describe(cause)} — continuing`);

            return { outcome: 'operational', reason: null };
        }

        // 6th+ failure: enter exponential backoff with cap. R4 Item 4B —
        // compute the next backoff width by doubling from the previous one
        // (or seeding from the configured interval on the first escalation),
        // then set the wall-clock target the scheduledTick uses to skip
        // EVERY tick until the window elapses.
        const previousBackoff = this.currentBackoffMs ?? this.appConfig.paperNullityProbeIntervalMs;
        const nextBackoff = Math.min(previousBackoff * BACKOFF_INITIAL_MULTIPLIER, this.appConfig.paperNullityProbeBackoffMaxMs);
        this.currentBackoffMs = nextBackoff;
        this.nextProbeAtMs = Date.now() + nextBackoff;
        this.logger.warn(
            `PaperExchangeNullityProbe transport failure ${consecutive} (>${TRANSPORT_FAILURE_THRESHOLD}): ${this.describe(cause)} — ` +
                `entering exponential backoff (next window=${nextBackoff}ms, cap=${this.appConfig.paperNullityProbeBackoffMaxMs}ms, ` +
                `next allowed at ${new Date(this.nextProbeAtMs).toISOString()}). ` +
                `Soak continues; Binance outage MUST NOT halt the soak (ADR 0032 §D13).`,
        );

        return { outcome: 'operational', reason: null };
    }

    private async executeCriticalAbort(title: string, reason: string, nowMs: number): Promise<void> {
        try {
            if (!this.haltFlag.isHalted()) {
                this.haltFlag.halt(`${HaltSourceEnum.MODEL_DIVERGENCE}:paper_nullity_probe`);
                this.haltService.notePragmaticTransition(HaltSourceEnum.MODEL_DIVERGENCE, 'paper_nullity_probe', nowMs);
            }
        } catch (cause) {
            this.logger.error(`PaperExchangeNullityProbe halt-flag flip failed: ${this.describe(cause)}`);
        }

        const payload: IAlertPayload = {
            type: AlertTypeEnum.MODEL_DIVERGENCE_ENGAGED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: new Date(nowMs).toISOString(),
            title,
            body: reason,
            data: {
                source: 'PaperExchangeNullityProbe',
            },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`PaperExchangeNullityProbe alert publish failed: ${this.describe(cause)}`);
        }

        this.logger.error(`PaperExchangeNullityProbe CRITICAL ${title} — ${reason}`);
    }

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return `${cause.name}: ${cause.message}`;
        }

        return String(cause);
    }
}
