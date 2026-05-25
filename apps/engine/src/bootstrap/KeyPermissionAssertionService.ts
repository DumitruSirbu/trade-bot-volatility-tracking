import {
    AlertSeverityEnum,
    AlertTypeEnum,
    ExchangeEnvironmentEnum,
    HaltAuditActionEnum,
    IAlertPayload,
    IKeyPermissionSnapshot,
    isKeyPermissionSnapshotAcceptable,
} from '@bot/shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { ALERT_SINK, IAlertSink } from '../alert/sink/AlertSinkModule';
import { AppConfigService } from '../config/service';
import { ControlAuditRepository } from '../control/repository/ControlAuditRepository';
import { API_KEY_FINGERPRINT_PREFIX_LEN, API_KEY_FINGERPRINT_SUFFIX_LEN } from '../exchange/const';
import { KeyPermissionAssertionFailedException } from '../exchange/exception';
import { EXCHANGE_CLIENT, IExchangeClient } from '../exchange/interface';
import { LiveGoAheadVerifier } from './LiveGoAheadVerifier';

// M11a W1.1 / W1.2 (ADR 0028). PHASE 0.5 — runs after the schema gate has
// validated `control_audit` exists and BEFORE EngineBootstrapService kicks
// off the M6 10-phase pipeline.
//
// Responsibilities:
//   1. Verify the LIVE two-token gate (LiveGoAheadVerifier).
//   2. Emit a CRITICAL boot Telegram alert announcing resolved env + API-key
//      fingerprint (first 4 + last 4 chars). Never the secret.
//   3. For DEMO / LIVE: call `IExchangeClient.fetchKeyPermissions()`, evaluate
//      the allowlist predicate, on failure write the audit row + Telegram
//      alert + process.exit(1). For TESTNET: write a SKIPPED audit row and
//      log loudly.
//
// One reason to change per the SRP test: it is the boot-time chokepoint
// for "is this engine allowed to talk to the exchange." Everything else
// (fetch, decision, audit) lives behind a port.

@Injectable()
export class KeyPermissionAssertionService implements OnApplicationBootstrap {
    private readonly logger = new Logger(KeyPermissionAssertionService.name);

    private hasRun = false;

    constructor(
        private readonly appConfig: AppConfigService,
        @Inject(EXCHANGE_CLIENT) private readonly exchange: IExchangeClient,
        private readonly auditRepo: ControlAuditRepository,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        private readonly liveGoAhead: LiveGoAheadVerifier,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (this.hasRun) {
            return;
        }

        this.hasRun = true;

        try {
            await this.runAssertion(Date.now());
        } catch (cause) {
            // Any path that reaches here without process.exit is a programming
            // error — `failHard` exits non-zero. Surface the cause to stderr
            // before letting NestJS surface it again so the operator sees it.
            this.logger.error(`key-permission assertion unexpectedly threw: ${describe(cause)}`);

            throw cause;
        }
    }

    // Public for tests; deterministic via the injected `nowMs`. The boot
    // path calls with `Date.now()` once at the boundary.
    async runAssertion(nowMs: number): Promise<void> {
        const env = this.appConfig.exchangeEnv;

        await this.liveGoAhead.verifyOrThrow(env);
        await this.publishBootAlert(env);

        if (env === ExchangeEnvironmentEnum.TESTNET) {
            await this.recordTestnetExemption();

            return;
        }

        await this.assertAgainstExchange(nowMs);
    }

    // CRITICAL boot alert announces resolved env + key fingerprint. Field
    // whitelist enforced by the static payload shape — no key/secret value
    // ever enters this payload.
    private async publishBootAlert(env: ExchangeEnvironmentEnum): Promise<void> {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: new Date().toISOString(),
            title: 'Engine boot — exchange environment resolved',
            body: `env=${env} keyFingerprint=${this.apiKeyFingerprint()}`,
            data: { env, keyFingerprint: this.apiKeyFingerprint() },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.warn(`boot alert publish failed: ${describe(cause)}`);
        }
    }

    // first 4 + last 4 of the public API key. Never the secret. Returns a
    // sentinel when the key is missing so the alert body never carries an
    // empty string that an operator might misread as "no key found in alert."
    private apiKeyFingerprint(): string {
        const key = this.appConfig.exchangeApiKey ?? '';

        if (key.length < API_KEY_FINGERPRINT_PREFIX_LEN + API_KEY_FINGERPRINT_SUFFIX_LEN) {
            return '<unset>';
        }

        const prefix = key.slice(0, API_KEY_FINGERPRINT_PREFIX_LEN);
        const suffix = key.slice(-API_KEY_FINGERPRINT_SUFFIX_LEN);

        return `${prefix}...${suffix}`;
    }

    private async recordTestnetExemption(): Promise<void> {
        this.logger.warn('key-permission assertion: TESTNET exemption — endpoint not surfaced on testnet host');

        try {
            await this.auditRepo.appendKeyPermissionAudit({
                occurredAt: new Date(),
                action: HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_SKIPPED,
                reason: 'TESTNET_EXEMPT',
                previousState: 'HALTED',
            });
        } catch (cause) {
            this.logger.warn(`testnet exemption audit failed: ${describe(cause)}`);
        }
    }

    // DEMO / LIVE path. Reads the snapshot once, evaluates the predicate, and
    // either returns clean or routes through failHard (which never returns).
    private async assertAgainstExchange(nowMs: number): Promise<void> {
        let snapshot: IKeyPermissionSnapshot;

        try {
            snapshot = await this.exchange.fetchKeyPermissions();
        } catch (cause) {
            // ADR 0028 §2.5: a throw IS an assertion failure.
            await this.failHard(['fetch_error'], null);
            // failHard exits; the throw below is for type-narrowing only.
            throw cause;
        }

        if (isKeyPermissionSnapshotAcceptable(snapshot, nowMs)) {
            this.logger.log('key-permission assertion PASSED');

            return;
        }

        const failingClauses = this.computeFailingClauses(snapshot, nowMs);
        await this.failHard(failingClauses, snapshot);
    }

    // Per-clause evaluation produces the field-name list named on the Telegram
    // alert + audit row. Mirrors `isKeyPermissionSnapshotAcceptable` so a
    // future shared-package change automatically extends this method (via a
    // failing test that diffs the clause list against the predicate body).
    private computeFailingClauses(snapshot: IKeyPermissionSnapshot, nowMs: number): ReadonlyArray<string> {
        const failures: string[] = [];

        if (snapshot.enableReading !== true) {
            failures.push('enableReading');
        }

        if (snapshot.enableFutures !== true) {
            failures.push('enableFutures');
        }

        if (snapshot.enableSpot !== false) {
            failures.push('enableSpot');
        }

        if (snapshot.enableWithdrawals !== false) {
            failures.push('enableWithdrawals');
        }

        if (snapshot.enableInternalTransfer !== false) {
            failures.push('enableInternalTransfer');
        }

        if (snapshot.permitsUniversalTransfer !== false) {
            failures.push('permitsUniversalTransfer');
        }

        if (snapshot.enableMargin !== false) {
            failures.push('enableMargin');
        }

        if (snapshot.enableVanillaOptions !== false) {
            failures.push('enableVanillaOptions');
        }

        if (snapshot.enableSubAccountManagement !== false) {
            failures.push('enableSubAccountManagement');
        }

        if (snapshot.ipRestrict !== true) {
            failures.push('ipRestrict');
        }

        if (snapshot.ipAllowList.length === 0) {
            failures.push('ipAllowList.empty');
        }

        if (snapshot.tradingAuthorityExpirationTime === null || snapshot.tradingAuthorityExpirationTime <= nowMs) {
            failures.push('tradingAuthorityExpirationTime');
        }

        return failures;
    }

    // ADR 0028 §2.5. Writes the audit row + Telegram alert (field-name list
    // only), then exits non-zero. Audit + alert writes are best-effort under
    // boot-time outages; the exit always happens. Static-typed snapshot
    // redaction: list `enable*` booleans + counts only, never IP literals or
    // expiry value.
    private async failHard(failingClauses: ReadonlyArray<string>, snapshot: IKeyPermissionSnapshot | null): Promise<never> {
        const reasonList = failingClauses.join(',');
        const redactedSnapshotLine = snapshot === null ? '' : ` snapshot=${this.formatRedactedSnapshot(snapshot)}`;
        const fullReason = `clauses=${reasonList}${redactedSnapshotLine}`;

        this.logger.error(`KEY PERMISSION ASSERTION FAILED — clauses=${reasonList}`);

        await this.bestEffortAudit(fullReason);
        await this.bestEffortAlert(reasonList);

        // pino is async-buffered; mirror SchemaValidationService's stderr
        // flush so the diagnostic is visible after exit.
        process.stderr.write(`key.permission.assertion.failed — clauses=${reasonList}\n`);

        process.exit(1);
        // Unreachable, but TypeScript needs the never-return contract.
        throw new KeyPermissionAssertionFailedException(failingClauses);
    }

    private formatRedactedSnapshot(snapshot: IKeyPermissionSnapshot): string {
        // Booleans are not secrets; the count and "has expiry" presence reveal
        // operational shape without leaking IPs or timestamps.
        const ipCount = snapshot.ipAllowList.length;
        const hasExpiry = snapshot.tradingAuthorityExpirationTime !== null;

        return (
            `enableReading=${snapshot.enableReading},enableFutures=${snapshot.enableFutures},` +
            `enableSpot=${snapshot.enableSpot},enableWithdrawals=${snapshot.enableWithdrawals},` +
            `enableInternalTransfer=${snapshot.enableInternalTransfer},permitsUniversalTransfer=${snapshot.permitsUniversalTransfer},` +
            `enableMargin=${snapshot.enableMargin},enableVanillaOptions=${snapshot.enableVanillaOptions},` +
            `enableSubAccountManagement=${snapshot.enableSubAccountManagement},` +
            `ipRestrict=${snapshot.ipRestrict},ipAllowList.length=${ipCount},hasExpiry=${hasExpiry}`
        );
    }

    private async bestEffortAudit(reason: string): Promise<void> {
        try {
            await this.auditRepo.appendKeyPermissionAudit({
                occurredAt: new Date(),
                action: HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED,
                reason,
                previousState: 'HALTED',
            });
        } catch (cause) {
            this.logger.error(`assertion-failed audit write failed: ${describe(cause)}`);
        }
    }

    private async bestEffortAlert(reasonList: string): Promise<void> {
        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: new Date().toISOString(),
            title: 'KEY PERMISSION ASSERTION FAILED — engine refuses to start',
            body: `env=${this.appConfig.exchangeEnv} keyFingerprint=${this.apiKeyFingerprint()} clauses=${reasonList}`,
            data: { env: this.appConfig.exchangeEnv, keyFingerprint: this.apiKeyFingerprint(), clauses: reasonList },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`assertion-failed alert publish failed: ${describe(cause)}`);
        }
    }
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
