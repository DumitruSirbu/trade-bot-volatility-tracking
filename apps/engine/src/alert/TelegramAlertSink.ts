import { AlertSeverityEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/service';
import { AlertRateLimiter } from './AlertRateLimiter';
import { IAlertSink } from './sink/AlertSinkModule';
import { redactPayload } from './AlertRedactor';
import { HTTP_OK_STATUS, HTTP_TIMEOUT_MS, HTTP_TOO_MANY, TELEGRAM_API_HOST } from './const/alertConsts';

// M9 W6 (ADR 0024). Outbound-only Telegram sink.
//
// CRITICAL invariants — enforced by code + checklist:
//   - NO polling, NO webhook, NO inbound command handling. The Telegram bot
//     token is treated as a write-only credential.
//   - Redaction runs on EVERY payload before the wire (`redactPayload`).
//   - The trade loop never blocks: network failures are logged + dropped;
//     429 honours `parameters.retry_after` by sleeping the next admit; both
//     are best-effort.
//   - In NON-production with the token missing the sink degrades to a noop
//     (log only). In production with the token missing the sink throws at
//     construction so boot fails — silently swallowing alerts is worse than
//     refusing to start (ADR 0024 §2.7).

@Injectable()
export class TelegramAlertSink implements IAlertSink {
    private readonly logger = new Logger(TelegramAlertSink.name);

    private readonly token: string | null;
    private readonly chatId: string | null;
    private readonly degradedToNoop: boolean;

    // Wall-clock deadline (ms) before which we won't issue another POST —
    // honours the most recent 429 `retry_after` we observed.
    private nextSendNotBeforeMs = 0;

    constructor(
        private readonly config: AppConfigService,
        @Inject(AlertRateLimiter) private readonly rateLimiter: AlertRateLimiter,
    ) {
        const token = config.telegramBotToken ?? null;
        const chatId = config.telegramChatId ?? null;
        const hasCredentials = token !== null && token.length > 0 && chatId !== null && chatId.length > 0;

        if (!hasCredentials) {
            if (config.isProduction) {
                throw new Error('TelegramAlertSink: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are required in production (ADR 0024 §2.7).');
            }

            this.logger.warn('TelegramAlertSink: missing token/chatId in non-production — degrading to log-only.');
        }

        this.token = token;
        this.chatId = chatId;
        this.degradedToNoop = !hasCredentials;
    }

    async publish(payload: IAlertPayload): Promise<void> {
        const admitted = this.rateLimiter.admit(payload);

        if (admitted === null) {
            return;
        }

        const safe = redactPayload(admitted, { telegramBotTokenLiteral: this.token });
        const suppressed = this.rateLimiter.consumeSuppressedCount();
        const text = renderAlertText(safe, suppressed);

        if (this.degradedToNoop) {
            this.logger.log(`alert.telegram.noop type=${safe.type} severity=${safe.severity} title=${safe.title}`);
            return;
        }

        await this.sendSafely(text);
    }

    // One-shot send. On 429: respect `retry_after` for the next call (do not
    // sleep here — never block the trade loop). On any other failure: log +
    // drop. Bounded by HTTP_TIMEOUT_MS via AbortController.
    private async sendSafely(text: string): Promise<void> {
        const now = Date.now();

        if (now < this.nextSendNotBeforeMs) {
            this.logger.debug(`alert.telegram.skip reason=rateLimitBackoff resumesInMs=${this.nextSendNotBeforeMs - now}`);
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        const url = `${TELEGRAM_API_HOST}/bot${this.token}/sendMessage`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
                signal: controller.signal,
            });

            if (response.status === HTTP_OK_STATUS) {
                return;
            }

            if (response.status === HTTP_TOO_MANY) {
                await this.honourRetryAfter(response);
                return;
            }

            this.logger.warn(`alert.telegram.nonOk status=${response.status}`);
        } catch (cause) {
            // Network / abort / DNS / etc — log + drop. The audit row, the
            // halt flag, the position rows are all already durable.
            this.logger.warn(`alert.telegram.networkFailure cause=${describe(cause)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    private async honourRetryAfter(response: Response): Promise<void> {
        let retryAfterSec = 1;

        try {
            const body = (await response.json()) as { parameters?: { retry_after?: number } };
            const reported = body?.parameters?.retry_after;

            if (typeof reported === 'number' && reported > 0) {
                retryAfterSec = Math.ceil(reported);
            }
        } catch {
            // Body parse failure — keep the conservative 1s floor.
        }

        this.nextSendNotBeforeMs = Date.now() + retryAfterSec * 1_000;
        this.logger.warn(`alert.telegram.rateLimited retryAfterSec=${retryAfterSec}`);
    }
}

function renderAlertText(payload: IAlertPayload, suppressedCount: number): string {
    const severityTag = severityPrefix(payload.severity);
    const lines: string[] = [`${severityTag} ${payload.title}`, payload.body];

    if (suppressedCount > 0) {
        lines.push(`[${suppressedCount} alerts suppressed in last 60s]`);
    }

    return lines.join('\n');
}

function severityPrefix(severity: AlertSeverityEnum): string {
    if (severity === AlertSeverityEnum.CRITICAL) {
        return '[CRITICAL]';
    }

    if (severity === AlertSeverityEnum.WARN) {
        return '[WARN]';
    }

    return '[INFO]';
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
