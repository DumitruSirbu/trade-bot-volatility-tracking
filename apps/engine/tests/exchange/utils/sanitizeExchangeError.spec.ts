import { sanitizeExchangeError } from '../../../src/exchange/utils/sanitizeExchangeError';
import { EXCHANGE_ERROR_CENSOR } from '../../../src/exchange/const';

// The Binance API key is base62 (not hex) and ~64 chars; a representative sample.
const HEADER_API_KEY = 'aB3xK9pQ7rT2vW4yZ1cD6fG8hJ0kL5mN2pR4sT6uV8wX0yA3bC5dE7fG9hJ1kL3';

// An HMAC signature is 64 hex chars.
const HMAC_SIGNATURE = 'a'.repeat(64);

describe('sanitizeExchangeError', () => {
    describe('query-param (key=value) form', () => {
        it('redacts the signature value', () => {
            const message = sanitizeExchangeError(new Error(`signature=${HMAC_SIGNATURE}&symbol=BTCUSDT`));

            expect(message).not.toContain(HMAC_SIGNATURE);
            expect(message).toContain('symbol=BTCUSDT');
        });

        it('redacts the apiKey value', () => {
            const message = sanitizeExchangeError(new Error(`apiKey=${HEADER_API_KEY}&recvWindow=5000`));

            expect(message).not.toContain(HEADER_API_KEY);
        });
    });

    describe('header-form API key (base62, colon-separated)', () => {
        it('redacts an X-MBX-APIKEY header in colon form', () => {
            const message = sanitizeExchangeError(new Error(`request headers X-MBX-APIKEY: ${HEADER_API_KEY} sent`));

            expect(message).not.toContain(HEADER_API_KEY);
            expect(message).toContain(EXCHANGE_ERROR_CENSOR);
        });

        it('redacts an X-MBX-APIKEY header in JSON-echoed form', () => {
            const message = sanitizeExchangeError(new Error(`headers={"X-MBX-APIKEY":"${HEADER_API_KEY}"}`));

            expect(message).not.toContain(HEADER_API_KEY);
        });

        it('redacts the header-form key case-insensitively', () => {
            const message = sanitizeExchangeError(new Error(`x-mbx-apikey=${HEADER_API_KEY}`));

            expect(message).not.toContain(HEADER_API_KEY);
        });
    });

    describe('standalone secret tokens', () => {
        it('redacts a bare 64-hex HMAC signature', () => {
            const message = sanitizeExchangeError(new Error(`bad signature ${HMAC_SIGNATURE} rejected`));

            expect(message).not.toContain(HMAC_SIGNATURE);
        });

        it('redacts a bare base62 token of length >= 40', () => {
            const message = sanitizeExchangeError(new Error(`token ${HEADER_API_KEY} invalid`));

            expect(message).not.toContain(HEADER_API_KEY);
        });
    });

    describe('multiple occurrences (global flag)', () => {
        it('strips every occurrence, not just the first', () => {
            const message = sanitizeExchangeError(new Error(`signature=${HMAC_SIGNATURE} retried signature=${HMAC_SIGNATURE}`));

            expect(message).not.toContain(HMAC_SIGNATURE);
        });

        it('strips a header key that appears twice', () => {
            const message = sanitizeExchangeError(new Error(`X-MBX-APIKEY: ${HEADER_API_KEY} ... X-MBX-APIKEY: ${HEADER_API_KEY}`));

            expect(message).not.toContain(HEADER_API_KEY);
        });
    });

    it('leaves a credential-free message untouched', () => {
        const message = sanitizeExchangeError(new Error('Order would immediately trigger'));

        expect(message).toContain('Order would immediately trigger');
    });
});
