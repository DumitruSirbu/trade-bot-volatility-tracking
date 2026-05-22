import { describeError } from '../../common/utils/describeError';
import { EXCHANGE_ERROR_CENSOR, EXCHANGE_ERROR_SENSITIVE_PATTERNS } from '../const';

// Strips credential-bearing tokens (signature/apiKey/timestamp query params and any
// 64-hex secret) from a ccxt error message before it is logged. ccxt's
// AuthenticationError/RequestError frequently echo the offending signed request
// verbatim, and deepRedactLog only scrubs object KEYS — so a raw error STRING would
// leak the key/signature. Route all ccxt-origin error logging through this.
export function sanitizeExchangeError(cause: unknown): string {
    let message = describeError(cause);

    for (const pattern of EXCHANGE_ERROR_SENSITIVE_PATTERNS) {
        message = message.replace(pattern, (match) => maskMatch(match));
    }

    return message;
}

// Redacts the credential VALUE while keeping the label/separator readable. Handles
// both `key=value` (query params) and `Header: value` / `"Header":"value"` (header
// form): redact everything after the LAST `=` or `:` separator. A bare token with no
// separator (a standalone hex/base62 secret) is censored whole.
function maskMatch(match: string): string {
    const separatorIndex = Math.max(match.lastIndexOf('='), match.lastIndexOf(':'));

    if (separatorIndex === -1) {
        return EXCHANGE_ERROR_CENSOR;
    }

    return `${match.slice(0, separatorIndex + 1)}${EXCHANGE_ERROR_CENSOR}`;
}
