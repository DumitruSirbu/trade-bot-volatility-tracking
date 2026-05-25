import { AlertSeverityEnum, IAlertPayload } from '@bot/shared';
import { Injectable, Logger, Module } from '@nestjs/common';

import { AppConfigService } from '../../config/service';
import { AlertRateLimiter } from '../AlertRateLimiter';
import { TelegramAlertSink } from '../TelegramAlertSink';

// M9 boot-fix (post-M8). Extracted from `AlertModule` to break a true module
// cycle between `ControlModule` (HaltService needs ALERT_SINK) and
// `AlertModule` (RiskListeners needs HaltService). Under NestJS 11, a Symbol
// DI token exported across a `forwardRef` cycle resolved to `undefined` at
// the consuming side, surfacing as:
//
//   UndefinedDependencyException: Nest can't resolve dependencies of the
//   HaltService (..., ?, ...). Argument at index [2] is not available.
//
// The fix mirrors `common/clock/` (extracted in M9 R1 #5 for the same reason):
// move the leaf primitives + their factory binding into their own module,
// both downstream modules import this leaf, no cycle remains.
//
// Ownership after extraction:
//   - This leaf module:  ALERT_SINK token, IAlertSink interface, NoopAlertSink
//                        class, AlertRateLimiter singleton, TelegramAlertSink
//                        provider, AND the W6 production-vs-noop factory.
//   - AlertModule:       listeners (RiskListeners) + scheduler
//                        (DailyPnlSummaryScheduler) — still depends on
//                        ControlModule (HaltService) one-way (no cycle).
//   - ControlModule:     imports this leaf to resolve ALERT_SINK for
//                        HaltService; no longer imports AlertModule.
//
// The TelegramAlertSink + AlertRateLimiter source files stay where they are
// (file location does not have to match module ownership) so tests that
// import them by path keep compiling without churn.

export const ALERT_SINK = Symbol('ALERT_SINK');

// Outbound-only contract. The sink is fire-and-forget; the trade loop must
// never block on an alert. Implementations are responsible for their own
// queueing, redaction, and rate-limiting (ADR 0024 §2.4, §2.6). Returning
// `Promise<void>` lets future sinks await an in-process enqueue without
// forcing consumers to know whether the delivery is sync or async.
export interface IAlertSink {
    publish(payload: IAlertPayload): Promise<void>;
}

// W1 default. Logs the structured payload at the matching severity so a
// pre-W6 boot still surfaces `BOOT_SCHEMA_GATE_FAILED` in the engine's pino
// stream. Never throws — the schema-gate's `process.exit(1)` path runs even
// if no Telegram credential exists.
@Injectable()
export class NoopAlertSink implements IAlertSink {
    private readonly logger = new Logger(NoopAlertSink.name);

    async publish(payload: IAlertPayload): Promise<void> {
        const line = `alert.noop type=${payload.type} severity=${payload.severity} title=${payload.title}`;

        if (payload.severity === AlertSeverityEnum.CRITICAL) {
            this.logger.error(line);

            return;
        }

        if (payload.severity === AlertSeverityEnum.WARN) {
            this.logger.warn(line);

            return;
        }

        this.logger.log(line);
    }
}

@Module({
    providers: [
        NoopAlertSink,
        TelegramAlertSink,
        {
            // Singleton rate-limiter shared by every sink instance + every
            // listener path. Clock injected so tests can pin time.
            provide: AlertRateLimiter,
            useFactory: () => new AlertRateLimiter(() => Date.now()),
        },
        {
            // Production substitution point (ADR 0024 §2.7). When the env
            // supplies a token AND a chat id, the Telegram sink replaces the
            // noop sink behind the same DI token — no consumer change.
            provide: ALERT_SINK,
            inject: [AppConfigService, TelegramAlertSink, NoopAlertSink],
            useFactory: (config: AppConfigService, telegram: TelegramAlertSink, noop: NoopAlertSink): IAlertSink => {
                const hasToken = (config.telegramBotToken ?? '').length > 0;
                const hasChat = (config.telegramChatId ?? '').length > 0;

                if (hasToken && hasChat) {
                    return telegram;
                }

                return noop;
            },
        },
    ],
    exports: [ALERT_SINK, NoopAlertSink, AlertRateLimiter, TelegramAlertSink],
})
export class AlertSinkModule {}
