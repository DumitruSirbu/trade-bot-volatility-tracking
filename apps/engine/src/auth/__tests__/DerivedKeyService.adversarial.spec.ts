/**
 * Adversarial tests for DerivedKeyService (M11a W1.7).
 *
 * Covers: cursor key != auth key, determinism across boots, cursor/auth key
 * cross-use fails a MAC verification, v2-info-derived key differs from v1.
 */

import { createHmac, hkdfSync } from 'node:crypto';

import { DerivedKeyService } from '../DerivedKeyService';

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildService(masterSecretHex: string): DerivedKeyService {
    const master = Buffer.from(masterSecretHex, 'hex');
    const secretProvider = { getSigningSecret: jest.fn().mockReturnValue(master) };
    const service = new DerivedKeyService(secretProvider as never);
    service.onModuleInit();
    return service;
}

const MASTER_32 = 'a'.repeat(64); // 32 bytes in hex
const MASTER_32_ALT = 'b'.repeat(64);

// Simple HMAC-SHA256 sign/verify helper
function hmacSign(key: Buffer, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hmacVerify(key: Buffer, data: string, mac: Buffer): boolean {
    const expected = hmacSign(key, data);
    if (expected.length !== mac.length) return false;
    // Constant-time compare
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected[i] ^ mac[i];
    }
    return diff === 0;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('DerivedKeyService — adversarial', () => {
    describe('cursor key and auth key are distinct', () => {
        it('getCursorKey() !== getAuthKey() for the same master', () => {
            // BUILD
            const service = buildService(MASTER_32);

            // OPERATE
            const cursorKey = service.getCursorKey();
            const authKey = service.getAuthKey();

            // CHECK
            expect(cursorKey.equals(authKey)).toBe(false);
        });

        it('both keys are 32 bytes', () => {
            // BUILD
            const service = buildService(MASTER_32);

            // CHECK
            expect(service.getCursorKey()).toHaveLength(32);
            expect(service.getAuthKey()).toHaveLength(32);
        });
    });

    describe('determinism — same master produces same keys across boots', () => {
        it('two services with the same master produce identical cursor keys', () => {
            // BUILD
            const s1 = buildService(MASTER_32);
            const s2 = buildService(MASTER_32);

            // CHECK
            expect(s1.getCursorKey().equals(s2.getCursorKey())).toBe(true);
        });

        it('two services with the same master produce identical auth keys', () => {
            // BUILD
            const s1 = buildService(MASTER_32);
            const s2 = buildService(MASTER_32);

            // CHECK
            expect(s1.getAuthKey().equals(s2.getAuthKey())).toBe(true);
        });

        it('different master produces different cursor key', () => {
            // BUILD
            const s1 = buildService(MASTER_32);
            const s2 = buildService(MASTER_32_ALT);

            // CHECK
            expect(s1.getCursorKey().equals(s2.getCursorKey())).toBe(false);
        });
    });

    describe('cursor key cannot be used to verify an auth-key MAC', () => {
        it('a MAC signed with the auth key fails verification under the cursor key', () => {
            // BUILD
            const service = buildService(MASTER_32);
            const cursorKey = service.getCursorKey();
            const authKey = service.getAuthKey();

            const message = 'some-sensitive-payload';

            // OPERATE — sign with authKey
            const macFromAuth = hmacSign(authKey, message);

            // CHECK — verify with cursorKey must fail (keys are different)
            expect(hmacVerify(cursorKey, message, macFromAuth)).toBe(false);
        });

        it('a MAC signed with the cursor key fails verification under the auth key', () => {
            // BUILD
            const service = buildService(MASTER_32);
            const cursorKey = service.getCursorKey();
            const authKey = service.getAuthKey();

            const payload = 'cursor-opaque-data-abc123';
            const macFromCursor = hmacSign(cursorKey, payload);

            // CHECK — attempting to verify with the auth key must fail
            expect(hmacVerify(authKey, payload, macFromCursor)).toBe(false);
        });
    });

    describe('v2 info string produces a different key (forward-compatibility)', () => {
        it('a key derived with info="cursor v2" differs from "cursor v1"', () => {
            // BUILD — derive a v2 key directly using the same HKDF mechanism
            const master = Buffer.from(MASTER_32, 'hex');

            const v1Key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('cursor v1', 'utf8'), 32));
            const v2Key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('cursor v2', 'utf8'), 32));

            // CHECK — v1 and v2 must be distinct
            expect(v1Key.equals(v2Key)).toBe(false);
        });

        it('getCursorKey() returns the v1 key (not v2)', () => {
            // BUILD
            const master = Buffer.from(MASTER_32, 'hex');
            const expectedV1 = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('cursor v1', 'utf8'), 32));

            const service = buildService(MASTER_32);

            // CHECK
            expect(service.getCursorKey().equals(expectedV1)).toBe(true);
        });
    });

    describe('not initialised — throws before onModuleInit', () => {
        it('getCursorKey throws if onModuleInit was not called', () => {
            // BUILD — construct but do not call onModuleInit
            const master = Buffer.from(MASTER_32, 'hex');
            const secretProvider = { getSigningSecret: jest.fn().mockReturnValue(master) };
            const service = new DerivedKeyService(secretProvider as never);

            // OPERATE + CHECK
            expect(() => service.getCursorKey()).toThrow('not initialised');
        });

        it('getAuthKey throws if onModuleInit was not called', () => {
            // BUILD
            const master = Buffer.from(MASTER_32, 'hex');
            const secretProvider = { getSigningSecret: jest.fn().mockReturnValue(master) };
            const service = new DerivedKeyService(secretProvider as never);

            // OPERATE + CHECK
            expect(() => service.getAuthKey()).toThrow('not initialised');
        });
    });
});
