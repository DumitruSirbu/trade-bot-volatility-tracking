import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload, IRateLimitFailure } from '@bot/shared';
import { HttpException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ALERT_SINK, IAlertSink } from '../alert/sink/AlertSinkModule';
import {
    GLOBAL_ROW_SOURCE_IP,
    LOGIN_GLOBAL_ALERT_COALESCE_MS,
    LOGIN_GLOBAL_MAX_ATTEMPTS,
    LOGIN_GLOBAL_WINDOW_MS,
    LOGIN_PER_IP_BURST_MAX,
    LOGIN_PER_IP_BURST_WINDOW_MS,
    LOGIN_PER_IP_SUSTAINED_MAX,
    LOGIN_PER_IP_SUSTAINED_WINDOW_MS,
} from './const/authConsts';

// Memory-bound on hydrated timestamps per row — twice the sustained-window
// max so a re-hydrated row that was at the throttle ceiling has slack but a
// poisoned Postgres row can never balloon engine RSS.
const MAX_HYDRATED_TIMESTAMPS = LOGIN_PER_IP_SUSTAINED_MAX * 2;
import { LoginRateLimitStateRepository, LoginRateLimitScope } from './repository/LoginRateLimitStateRepository';

// M10 W0.5 (ADR 0027 §2.4). In-memory sliding-window rate limiter for the
// /v1/auth/login endpoint. Two layered per-IP windows + a global ceiling.
//
//   per-IP burst:      5 attempts / 10s
//   per-IP sustained:  20 attempts / 600s
//   global ceiling:    200 attempts / 60s across all IPs
//
// Successful logins COUNT toward all windows (ADR 0027 §2.4); an operator
// re-logging every 15 min lands at ~1/hour, well under the cap. The 429 also
// counts so an attacker cannot probe-and-poll the limiter cheaply.
//
// Global-ceiling breach fires ONE coalesced CRITICAL Telegram alert per
// LOGIN_GLOBAL_ALERT_COALESCE_MS (one minute) — under sustained attack the
// operator sees the first burst, not a 10-message-per-second flood. Local
// coalescing here is intentional even though TelegramAlertSink has its own
// rate-limiter: a single login flood will fire the AlertRateLimiter's
// suppressed-count instead of carrying the distinct "login-ceiling-breached"
// signal we want at the top of the alert.
//
// Single-process — multi-instance scaling moves to a Redis-backed limiter in
// M11 (ADR 0027 §2.4 explicitly defers this).

interface IIpWindow {
    burst: number[]; // ms timestamps, oldest first
    sustained: number[];
}

@Injectable()
export class LoginRateLimiter implements OnModuleInit {
    private readonly logger = new Logger(LoginRateLimiter.name);

    private readonly perIp = new Map<string, IIpWindow>();

    private readonly globalWindow: number[] = [];

    private lastGlobalAlertAtMs = 0;

    private lastGcAtMs = 0;

    constructor(
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
        // M11a W1.9 — write-through persistence so a restart does NOT re-open
        // the brute-force window. Hot-path stays O(1) on the in-memory state;
        // Postgres is consulted only at boot (loadAll) and written
        // fire-and-forget on every enforce() pass.
        private readonly persistence: LoginRateLimitStateRepository,
    ) {}

    // M11a W1.9 — boot hydration. Rebuilds in-memory windows from the
    // last-persisted rows so a process restart preserves attempt counters.
    // Failure is logged and the limiter starts with empty windows — i.e.
    // operationally identical to the pre-W1.9 behaviour — so a DB issue at
    // boot does not block the engine.
    async onModuleInit(): Promise<void> {
        try {
            const rows = await this.persistence.loadAll();

            for (const row of rows) {
                this.hydrateRow(row.sourceIp, row.scope, row.timestampsMs);
            }

            this.logger.log(`loginRateLimiter.restored rows=${rows.length}`);
        } catch (cause) {
            this.logger.warn(`loginRateLimiter.restore.failed cause=${(cause as Error).message}`);
        }
    }

    private hydrateRow(sourceIp: string, scope: LoginRateLimitScope, timestamps: number[]): void {
        // Memory-bound — a poisoned `timestamps_ms` row cannot inflate RSS
        // past the constant cap. The first enforce() pass prunes further by
        // the per-scope window threshold; the clamp is a defence-in-depth.
        const clamped = timestamps.slice(0, MAX_HYDRATED_TIMESTAMPS);

        if (scope === 'global') {
            for (const ts of clamped) {
                this.globalWindow.push(ts);
            }

            return;
        }

        const existing = this.perIp.get(sourceIp) ?? { burst: [], sustained: [] };

        if (scope === 'burst') {
            existing.burst = clamped;
        } else {
            existing.sustained = clamped;
        }

        this.perIp.set(sourceIp, existing);
    }

    // Enforce rate-limits for `sourceIp` at `now`. The attempt is recorded
    // regardless of outcome (count-success-too per ADR 0027 §2.4 — the 429
    // itself counts so an attacker cannot probe-and-poll cheaply). Throws an
    // HttpException(429) carrying `IRateLimitFailure` when any window is
    // exceeded; the controller copies `retryAfterSec` into the `Retry-After`
    // header before re-throwing.
    //
    // M10 R1 #2 (Security HIGH / Logic MED) — record then check with `>` so
    // exactly LOGIN_PER_IP_BURST_MAX attempts admit and the (MAX+1)-th
    // throttles, holding the ADR 0027 §2.4 "5/10s" semantic (first 5 admit,
    // 6th throttles). The previous code had the same arithmetic but split the
    // window-pruning across `recordAttempt` + `enforce`, making the off-by-
    // one easy to misread on review. Pruning is now inline and the
    // record-then-check ordering is explicit. The throttled attempt remains
    // recorded (anti-poll property).
    enforce(sourceIp: string, now: Date): void {
        const nowMs = now.getTime();

        this.maybeGc(nowMs);

        const window = this.perIp.get(sourceIp) ?? { burst: [], sustained: [] };
        const burst = pruneOlderThan(window.burst, nowMs - LOGIN_PER_IP_BURST_WINDOW_MS);
        const sustained = pruneOlderThan(window.sustained, nowMs - LOGIN_PER_IP_SUSTAINED_WINDOW_MS);
        const globalPruned = pruneOlderThan(this.globalWindow, nowMs - LOGIN_GLOBAL_WINDOW_MS);

        // Record this attempt up-front so a 429 still counts toward the window
        // (ADR 0027 §2.4 anti-poll property). Throws below see the recorded
        // timestamp via the in-memory map.
        burst.push(nowMs);
        sustained.push(nowMs);
        globalPruned.push(nowMs);
        this.perIp.set(sourceIp, { burst, sustained });
        this.globalWindow.length = 0;
        this.globalWindow.push(...globalPruned);

        // M11a W1.9 — fire-and-forget write-through. The hot path remains
        // synchronous from the controller's perspective; a slow / wedged DB
        // pool cannot stretch login latency (the previous M10 R1 #3 audit
        // timeout invariant applies separately). Persistence failures are
        // logged and dropped — losing one persistence round is preferable to
        // request amplification, and the next enforce() pass rewrites.
        this.persistAsync(sourceIp, 'burst', burst, now);
        this.persistAsync(sourceIp, 'sustained', sustained, now);
        this.persistAsync(GLOBAL_ROW_SOURCE_IP, 'global', globalPruned, now);

        // Check pruned counts INCLUDING the just-recorded attempt — `>` so
        // exactly LOGIN_PER_IP_BURST_MAX attempts admit and the (MAX+1)-th
        // throttles. Equivalent to checking `prunedCount >= MAX` BEFORE
        // recording — both phrasings preserve the "5 admit, 6th throttles"
        // ADR 0027 §2.4 semantic.
        if (burst.length > LOGIN_PER_IP_BURST_MAX) {
            this.throwThrottled(burst[0], LOGIN_PER_IP_BURST_WINDOW_MS, nowMs, sourceIp, 'burst');
        }

        if (sustained.length > LOGIN_PER_IP_SUSTAINED_MAX) {
            this.throwThrottled(sustained[0], LOGIN_PER_IP_SUSTAINED_WINDOW_MS, nowMs, sourceIp, 'sustained');
        }

        if (this.globalWindow.length > LOGIN_GLOBAL_MAX_ATTEMPTS) {
            this.fireGlobalAlertIfDue(nowMs);
            this.throwThrottled(this.globalWindow[0], LOGIN_GLOBAL_WINDOW_MS, nowMs, sourceIp, 'global');
        }
    }

    // Test seam — production never calls this; tests pin clock state.
    reset(): void {
        this.perIp.clear();
        this.globalWindow.length = 0;
        this.lastGlobalAlertAtMs = 0;
        this.lastGcAtMs = 0;
    }

    private persistAsync(sourceIp: string, scope: LoginRateLimitScope, timestamps: number[], now: Date): void {
        void this.persistence.upsert({ sourceIp, scope, timestampsMs: timestamps.slice() }, now).catch((cause) => {
            this.logger.warn(`loginRateLimiter.persist.failed scope=${scope} cause=${(cause as Error).message}`);
        });
    }

    private fireGlobalAlertIfDue(nowMs: number): void {
        if (nowMs - this.lastGlobalAlertAtMs < LOGIN_GLOBAL_ALERT_COALESCE_MS) {
            return;
        }

        this.lastGlobalAlertAtMs = nowMs;

        const payload: IAlertPayload = {
            type: AlertTypeEnum.UNHANDLED_EXCEPTION,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: new Date(nowMs).toISOString(),
            title: 'Login rate-limit ceiling breached',
            body: `Global login attempts exceeded ${LOGIN_GLOBAL_MAX_ATTEMPTS}/${LOGIN_GLOBAL_WINDOW_MS / 1000}s window — possible distributed brute-force.`,
            data: {
                limit: String(LOGIN_GLOBAL_MAX_ATTEMPTS),
                windowMs: String(LOGIN_GLOBAL_WINDOW_MS),
            },
        };

        // Fire-and-forget — the request path must never block on alert I/O.
        void this.alerts.publish(payload).catch((cause) => {
            this.logger.warn(`alert.publish.failed type=${payload.type} cause=${(cause as Error).message}`);
        });
    }

    private throwThrottled(oldestMs: number, windowMs: number, nowMs: number, sourceIp: string, scope: 'burst' | 'sustained' | 'global'): never {
        const retryAfterMs = windowMs - (nowMs - oldestMs);
        const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1_000));

        // Log without echoing the secret; sourceIp is operational not secret.
        this.logger.warn(`login.rate_limited scope=${scope} sourceIp=${sourceIp} retryAfterSec=${retryAfterSec}`);

        const body: IRateLimitFailure = {
            error: 'RATE_LIMITED',
            reason: 'TOO_MANY_LOGIN_ATTEMPTS',
            retryAfterSec,
        };

        throw new HttpException(body, 429);
    }

    private maybeGc(nowMs: number): void {
        if (nowMs - this.lastGcAtMs < LOGIN_PER_IP_SUSTAINED_WINDOW_MS) {
            return;
        }

        this.lastGcAtMs = nowMs;
        const sustainedThreshold = nowMs - LOGIN_PER_IP_SUSTAINED_WINDOW_MS;
        const burstThreshold = nowMs - LOGIN_PER_IP_BURST_WINDOW_MS;

        for (const [ip, window] of this.perIp.entries()) {
            window.burst = pruneOlderThan(window.burst, burstThreshold);
            window.sustained = pruneOlderThan(window.sustained, sustainedThreshold);

            if (window.burst.length === 0 && window.sustained.length === 0) {
                this.perIp.delete(ip);
                continue;
            }

            this.perIp.set(ip, window);
        }

        const prunedGlobal = pruneOlderThan(this.globalWindow, nowMs - LOGIN_GLOBAL_WINDOW_MS);

        this.globalWindow.length = 0;
        this.globalWindow.push(...prunedGlobal);
    }
}

function pruneOlderThan(values: number[], thresholdMs: number): number[] {
    return values.filter((ts) => ts > thresholdMs);
}
