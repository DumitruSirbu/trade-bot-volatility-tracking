/**
 * Adversarial tests for BAD_SIGNATURE split (M11a W1.5).
 *
 * `AuthFailureReasonEnum.BAD_SIGNATURE` rides on the wire enum directly. Tests
 * verify: signature failure surfaces as BAD_SIGNATURE on the wire; EXPIRED /
 * MALFORMED (missing, two-segment, wrong-alg) keep their previous wire values.
 */

import { AuthFailureReasonEnum } from '@bot/shared';

import { AuthTokenService } from '../AuthModule';
import { DerivedKeyService } from '../DerivedKeyService';

// ─── helpers ──────────────────────────────────────────────────────────────────

const VALID_SECRET_HEX = 'a'.repeat(64); // 32 bytes

function buildTokenService(masterHex = VALID_SECRET_HEX): AuthTokenService {
    const master = Buffer.from(masterHex, 'hex');
    const secretProvider = { getSigningSecret: jest.fn().mockReturnValue(master) };
    const derivedKeys = new DerivedKeyService(secretProvider as never);
    derivedKeys.onModuleInit();
    return new AuthTokenService(derivedKeys);
}

function issueToken(service: AuthTokenService, ttlSec = 900): string {
    return service.issue({ sub: 'test-user', scopes: [], ttlSec, now: new Date() }).token;
}

// Tampers with a JWT's signature segment without changing the header/payload
function tamperSignature(token: string): string {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Not a JWT');
    const original = parts[2];
    // Flip one character in the signature
    const flipped = original[0] === 'A' ? original.replace(/^A/, 'B') : original.replace(/^./, 'A');
    return `${parts[0]}.${parts[1]}.${flipped}`;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('BAD_SIGNATURE split — adversarial (M11a W1.5)', () => {
    describe('tampered signature', () => {
        it('verify returns BAD_SIGNATURE reason on the wire (promoted from engine discriminator)', () => {
            // BUILD
            const service = buildTokenService();
            const token = issueToken(service);
            const tampered = tamperSignature(token);

            // OPERATE
            const result = service.verify(tampered, new Date());

            // CHECK — wire reason is BAD_SIGNATURE now that the shared enum member exists
            expect((result as { error: string; reason: string }).error).toBe('AUTH_FAILED');
            expect((result as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.BAD_SIGNATURE);
        });

        it('verify returns AUTH_FAILED error tag for a tampered token', () => {
            // BUILD
            const service = buildTokenService();
            const token = issueToken(service);
            const tampered = tamperSignature(token);

            // OPERATE
            const result = service.verify(tampered, new Date());

            // CHECK
            expect((result as { error: string }).error).toBe('AUTH_FAILED');
            expect((result as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.BAD_SIGNATURE);
        });
    });

    describe('expired token — wire reason is EXPIRED, not BAD_SIGNATURE', () => {
        it('returns EXPIRED reason', () => {
            // BUILD
            const service = buildTokenService();
            const pastNow = new Date();
            const token = service.issue({ sub: 'test', scopes: [], ttlSec: 1, now: pastNow }).token;
            // Verify well past the expiry
            const futureDate = new Date(pastNow.getTime() + 60_000);

            // OPERATE
            const result = service.verify(token, futureDate);

            // CHECK
            expect((result as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.EXPIRED);
            expect((result as { reason: AuthFailureReasonEnum }).reason).not.toBe(AuthFailureReasonEnum.BAD_SIGNATURE);
        });
    });

    describe('missing / malformed token', () => {
        it('empty string returns MALFORMED (not BAD_SIGNATURE)', () => {
            // BUILD
            const service = buildTokenService();

            // OPERATE
            const result = service.verify('', new Date());

            // CHECK
            expect((result as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });

        it('token missing signature segment returns MALFORMED (not BAD_SIGNATURE)', () => {
            // BUILD
            const service = buildTokenService();

            // OPERATE — only two parts
            const result = service.verify('header.payload', new Date());

            // CHECK
            expect((result as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });

        it('token with wrong alg header returns MALFORMED (not BAD_SIGNATURE)', () => {
            // BUILD
            const service = buildTokenService();
            // RS256 header instead of HS256
            const fakeToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwianRpIjoieSIsImlhdCI6MTYwMDAwMDAwMCwiZXhwIjo5OTk5OTk5OTk5fQ.fakesig';

            // OPERATE
            const result = service.verify(fakeToken, new Date());

            // CHECK
            expect((result as { reason: AuthFailureReasonEnum }).reason).toBe(AuthFailureReasonEnum.MALFORMED);
        });
    });

    describe('valid token', () => {
        it('valid token resolves to IAuthSubject with no error property', () => {
            // BUILD
            const service = buildTokenService();
            const token = issueToken(service);

            // OPERATE
            const result = service.verify(token, new Date());

            // CHECK
            expect((result as { error?: string }).error).toBeUndefined();
            expect((result as { sub: string }).sub).toBe('test-user');
        });
    });
});
