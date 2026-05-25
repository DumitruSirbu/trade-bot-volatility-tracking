import { IAlertPayload } from '@bot/shared';

// M9 W6 (ADR 0024 §2.3). Pure redaction at the rendering boundary.
//
// Invariant: EVERY outbound alert payload passes through `redactPayload`
// before it leaves the process. A regression here is blocker-severity.
//
// The redactor is deliberately conservative: it strips anything that LOOKS
// like a secret even at the cost of mangling a legitimate long opaque
// identifier in a `reason` field — losing a few characters of an audit id
// is acceptable; leaking a key once is not.
//
// What is stripped:
//   - The configured `TELEGRAM_BOT_TOKEN` literal value (if present in env),
//     anywhere it appears.
//   - JWT-shaped strings: `eyJ<base64url>.<base64url>.<base64url>`.
//   - Long base64/hex runs (>= MIN_OPAQUE_RUN_LEN). Catches HMAC secrets,
//     API keys, and accidental env dumps. Tuned long enough that ordinary
//     UUIDs (32 hex without dashes, dashes break the run) pass through.
//   - `process.env`-style dumps: `KEY=value` lines where `KEY` matches the
//     `SECRET|KEY|TOKEN|PASSWORD` suffix pattern.
//
// The output preserves payload structure (type, severity, occurredAt) and
// only mutates the human-readable fields (`title`, `body`, `data`).

const REDACTED = '[REDACTED]';

// JWT shape: three base64url segments separated by dots, header begins `eyJ`.
const JWT_REGEX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

// Opaque runs: contiguous base64/hex chars >= MIN_OPAQUE_RUN_LEN. Underscore
// + hyphen included for base64url variants. Tuned at 32 to clear UUID-with-
// dashes but catch HMAC/API-key shapes (Binance secret = 64 chars).
const MIN_OPAQUE_RUN_LEN = 32;
const OPAQUE_RUN_REGEX = new RegExp(`[A-Za-z0-9_+/=-]{${MIN_OPAQUE_RUN_LEN},}`, 'g');

// `process.env`-style dump: KEY=value where KEY looks secret-bearing.
// The whole `KEY=value` substring (up to the first whitespace) is redacted.
const ENV_DUMP_REGEX = /\b([A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASS))=\S+/g;

export interface IRedactorOptions {
    // The runtime TELEGRAM_BOT_TOKEN value, redacted verbatim wherever it
    // appears. Optional because dev runs without a token.
    readonly telegramBotTokenLiteral?: string | null;
}

export function redactPayload(payload: IAlertPayload, opts: IRedactorOptions = {}): IAlertPayload {
    const tokenLiteral = (opts.telegramBotTokenLiteral ?? '').trim();
    const redactedData: Record<string, string> | undefined =
        payload.data === undefined
            ? undefined
            : Object.fromEntries(Object.entries(payload.data).map(([key, value]) => [key, redactString(value, tokenLiteral)]));

    return {
        type: payload.type,
        severity: payload.severity,
        occurredAt: payload.occurredAt,
        title: redactString(payload.title, tokenLiteral),
        body: redactString(payload.body, tokenLiteral),
        data: redactedData,
    };
}

// Pure string-level redactor — exported for unit-level fuzzing.
export function redactString(input: string, tokenLiteral: string): string {
    if (typeof input !== 'string' || input.length === 0) {
        return input;
    }

    let out = input;

    // Order matters: literal token wins first so a token that happens to
    // contain a JWT-like substring still gets the contextual replacement.
    if (tokenLiteral.length > 0) {
        out = replaceAllLiteral(out, tokenLiteral, REDACTED);
    }

    out = out.replace(ENV_DUMP_REGEX, (_match, key: string) => `${key}=${REDACTED}`);
    out = out.replace(JWT_REGEX, REDACTED);
    out = out.replace(OPAQUE_RUN_REGEX, REDACTED);

    return out;
}

// Pure literal replace — avoids the regex-special-character footgun of
// `new RegExp(tokenLiteral, 'g')` (a `+` or `.` inside a token would change
// the match semantics).
function replaceAllLiteral(input: string, needle: string, replacement: string): string {
    if (needle.length === 0) {
        return input;
    }

    let out = '';
    let cursor = 0;

    for (;;) {
        const found = input.indexOf(needle, cursor);

        if (found === -1) {
            out += input.slice(cursor);
            return out;
        }

        out += input.slice(cursor, found);
        out += replacement;
        cursor = found + needle.length;
    }
}
