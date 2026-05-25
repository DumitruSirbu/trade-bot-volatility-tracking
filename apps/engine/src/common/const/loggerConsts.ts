import { LogLevelEnum } from '../../config/enum';

// Pino uses error|warn|info|debug|trace; Nest LOG_LEVEL uses error|warn|log|debug|verbose.
// Map the configured Nest level onto the pino level the structured logger emits at.
export const NEST_TO_PINO_LEVEL: Record<LogLevelEnum, string> = {
    [LogLevelEnum.ERROR]: 'error',
    [LogLevelEnum.WARN]: 'warn',
    [LogLevelEnum.LOG]: 'info',
    [LogLevelEnum.DEBUG]: 'debug',
    [LogLevelEnum.VERBOSE]: 'trace',
};

// Object keys (case-insensitive) whose values are secrets and must never reach
// disk or stdout. pino's built-in `redact` only matches fixed-depth paths
// (`*.x` is ONE level), so a secret nested at any depth — err.config.headers.
// authorization, { ccxt: { apiKey } }, res.headers — would leak. We instead scrub
// recursively by key name (see deepRedactLog), which covers arbitrary nesting,
// arrays, request AND response headers, and nested error objects.
export const LOG_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-mbx-apikey',
    'signature',
    'sign',
    'apikey',
    'apisecret',
    'api_key',
    'api_secret',
    'password',
    'token',
    'secret',
    'exchange_api_key',
    'exchange_api_secret',
    'api_auth_token',
    'telegram_bot_token',
]);

export const LOG_REDACT_CENSOR = '[REDACTED]';

// Placeholder substituted for objects already seen during recursive redaction,
// so circular references (common in Express req/res and error objects) don't loop.
export const LOG_CIRCULAR_REF = '[Circular]';

// M11a W1.11 — Telegram bot tokens travel in the URL path (`/bot<token>/...`)
// on every outbound request. Any axios/undici retry log line that echoes the
// failing URL would leak the token through the structured logger. This regex
// runs on every string value (recursively) emitted through `deepRedactLog`
// and rewrites the `/bot<token>/` segment with the censor, regardless of host
// case or trailing path. The host portion (`api.telegram.org`) is preserved
// so the operator still sees WHICH service failed.
export const TELEGRAM_TOKEN_URL_REGEX = /(api\.telegram\.org\/bot)[^/\s"']+/gi;
