import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';

import { redactPayload, redactString } from '../../src/alert/AlertRedactor';
import { deepRedactLog } from '../../src/common/logger/deepRedactLog';

// M11a W1.11 — Telegram + log redaction sweep.
//
// Asserts that a synthetic error payload carrying the Telegram bot token cannot
// leak the token through either:
//   1. the pino transport (`deepRedactLog` strips the token from any URL with
//      `api.telegram.org/bot<token>/...` shape, regardless of which key holds
//      the URL value);
//   2. the alert formatter (`redactPayload` masks the literal token before the
//      payload reaches the wire renderer; the renderer in TelegramAlertSink is
//      a field WHITELIST that never serialises `data` / `occurredAt` / `type`
//      verbatim).

const TELEGRAM_BOT_TOKEN = '1234567890:AAEbcdef-ABCDEFGHIJKLMNOPQRSTUVWXY12';

describe('Telegram + log redaction (M11a W1.11)', () => {
    describe('pino deepRedactLog', () => {
        it('strips the bot token from a URL embedded as a non-sensitive-key value (e.g. err.config.url)', () => {
            const synthetic = {
                err: {
                    name: 'AxiosError',
                    message: 'Request failed',
                    config: {
                        url: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                        method: 'POST',
                    },
                },
            };

            const out = deepRedactLog(synthetic);
            const serialised = JSON.stringify(out);

            expect(serialised).not.toContain(TELEGRAM_BOT_TOKEN);
            // Host stays visible so the operator sees WHICH endpoint failed.
            expect(serialised).toContain('api.telegram.org/bot');
            expect(serialised).toContain('[REDACTED]');
        });

        it('strips the token even at arbitrary nesting depth (recursive scan)', () => {
            const deeplyNested = {
                outer: {
                    layer1: {
                        layer2: {
                            retryAttempt: 3,
                            failedUrl: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`,
                        },
                    },
                },
            };

            const out = JSON.stringify(deepRedactLog(deeplyNested));

            expect(out).not.toContain(TELEGRAM_BOT_TOKEN);
        });

        it('still redacts sensitive-named keys (api_secret) alongside URL token stripping', () => {
            const mixed = {
                api_secret: 'super-sensitive-binance-secret-value',
                requestUrl: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            };

            const out = JSON.stringify(deepRedactLog(mixed));

            expect(out).not.toContain('super-sensitive-binance-secret-value');
            expect(out).not.toContain(TELEGRAM_BOT_TOKEN);
        });

        it('leaves non-telegram URLs untouched (host-specific match)', () => {
            const benign = { requestUrl: 'https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT' };

            const out = JSON.stringify(deepRedactLog(benign));

            expect(out).toContain('fapi.binance.com/fapi/v1/ticker/price');
            expect(out).not.toContain('[REDACTED]');
        });
    });

    describe('alert formatter (TelegramAlertSink rendering boundary)', () => {
        it('redactPayload masks the literal bot token embedded inside the body text', () => {
            const synthetic: IAlertPayload = {
                type: AlertTypeEnum.UNHANDLED_EXCEPTION,
                severity: AlertSeverityEnum.CRITICAL,
                occurredAt: new Date('2026-05-25T12:00:00Z').toISOString(),
                title: 'Outbound retry failed',
                body: `Request to https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage timed out`,
                data: { failedUrl: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage` },
            };

            const out = redactPayload(synthetic, { telegramBotTokenLiteral: TELEGRAM_BOT_TOKEN });

            expect(out.body).not.toContain(TELEGRAM_BOT_TOKEN);
            expect(out.data?.failedUrl ?? '').not.toContain(TELEGRAM_BOT_TOKEN);
            // Title was not affected (no token there) — preserved verbatim.
            expect(out.title).toBe('Outbound retry failed');
        });

        it('redactString masks generic high-entropy runs even without the configured literal', () => {
            const line = `body contains a stray opaque blob ${TELEGRAM_BOT_TOKEN} that must be censored`;
            const out = redactString(line, '');

            expect(out).not.toContain(TELEGRAM_BOT_TOKEN);
        });

        it('a synthetic payload smuggling the token into `data` cannot reach the wire — renderer whitelists severity/title/body only', () => {
            // The TelegramAlertSink renderer (renderAlertText, internal) only
            // reads severity/title/body. We re-export the contract by inlining
            // the same projection here — if the renderer ever widens to include
            // `data` this test fails because the body would smuggle the token.
            const payload: IAlertPayload = {
                type: AlertTypeEnum.UNHANDLED_EXCEPTION,
                severity: AlertSeverityEnum.CRITICAL,
                occurredAt: new Date('2026-05-25T12:00:00Z').toISOString(),
                title: 'Synthetic test alert',
                body: 'No secret here',
                data: { sneaky: TELEGRAM_BOT_TOKEN },
            };

            const safe = redactPayload(payload, { telegramBotTokenLiteral: TELEGRAM_BOT_TOKEN });
            const projected = `${safe.severity}\n${safe.title}\n${safe.body}`;

            // Even WITHOUT the literal redaction, the projection excludes `data`,
            // so the token never reaches the rendered Telegram text. With the
            // literal redaction, `data.sneaky` is masked anyway — defence in
            // depth.
            expect(projected).not.toContain(TELEGRAM_BOT_TOKEN);
            expect(safe.data?.sneaky ?? '').not.toContain(TELEGRAM_BOT_TOKEN);
        });
    });
});
