/**
 * Adversarial tests for the paper_state_audit HMAC chain primitives.
 *
 * Covers:
 *   - Chain-domain prefix verification: encoding the same payload under the
 *     boot_mode_history chain name produces a different HMAC than under
 *     paper_state_audit. Defeats cross-chain payload replay even if downstream
 *     fields coincide (D6 chain-domain-prefix clause).
 *   - HMAC tamper detection: a row whose this_row_hmac is flipped fails the
 *     recompute step. Mirrors the shape of the boot-mode chain integrity
 *     walk so the same property holds for paper_state_audit.
 *   - prev_row_hash linkage detection: editing a row's prev_row_hash without
 *     re-signing fails the recompute (the prev_row_hash is part of the
 *     signed payload).
 *
 * The R2c integrity-walker service will consume this codec; the tests here
 * lock the codec's properties so a future "v2 canonical form" change cannot
 * silently regress the chain.
 */

import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { AppConfigService } from '../../config/service';
import { CHAIN_NAME_PAPER_STATE_AUDIT, HKDF_INFO_PAPER_STATE_AUDIT } from '../const';
import { PaperStateAuditHmacCodec } from '../service/PaperStateAuditHmacCodec';

const BOOTSTRAP_SECRET = 'a'.repeat(64);

function buildSubkey(): Buffer {
    const appConfig = { authBootstrapSecret: BOOTSTRAP_SECRET } as AppConfigService;
    const deriver = new BootstrapSubkeyDeriver(appConfig);
    return deriver.deriveSubkey(HKDF_INFO_PAPER_STATE_AUDIT);
}

describe('PaperStateAuditHmacCodec — chain integrity properties', () => {
    let codec: PaperStateAuditHmacCodec;
    let subkey: Buffer;

    beforeEach(() => {
        codec = new PaperStateAuditHmacCodec();
        subkey = buildSubkey();
    });

    describe('chain-domain prefix', () => {
        it('encoding the same payload under a foreign chain name produces a different bytes payload', () => {
            const payload = {
                seq: '1',
                recordedAt: new Date('2026-06-01T00:00:00.000Z'),
                mutationKind: 'OPEN_POSITION',
                subjectKind: 'paper_account_state',
                subjectId: '00000000-0000-0000-0000-000000000001',
                payloadHash: Buffer.alloc(32, 0xab),
                prevRowHash: null,
            };

            const canonical = codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload);
            // Manually encode under a foreign chain name by string-replacing
            // — we cannot pass anything but PaperStateAuditChainName to the
            // typed encoder, which is itself the defence. Construct the
            // foreign-canonical form by hand to assert the bytes differ.
            const foreignCanonical = Buffer.from(canonical.toString('utf8').replace(CHAIN_NAME_PAPER_STATE_AUDIT, 'boot_mode_history'), 'utf8');

            expect(canonical.equals(foreignCanonical)).toBe(false);

            const ourHmac = codec.computeHmac(subkey, canonical);
            const foreignHmac = codec.computeHmac(subkey, foreignCanonical);
            expect(ourHmac.equals(foreignHmac)).toBe(false);
        });

        it('PaperStateAuditHmacCodec.chainName exposes the canonical name', () => {
            expect(codec.chainName).toBe('paper_state_audit');
        });
    });

    describe('HMAC tamper detection', () => {
        it('recomputed HMAC matches the original when payload is unchanged', () => {
            const payload = {
                seq: '7',
                recordedAt: new Date('2026-06-02T12:34:56.789Z'),
                mutationKind: 'CLOSE_POSITION',
                subjectKind: 'paper_account_state_history',
                subjectId: '11111111-1111-1111-1111-111111111111',
                payloadHash: Buffer.alloc(32, 0x55),
                prevRowHash: Buffer.alloc(32, 0x33),
            };

            const original = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload));
            const recomputed = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload));
            expect(original.equals(recomputed)).toBe(true);
        });

        it('flipping a single byte of payload_hash invalidates the HMAC', () => {
            const payload = {
                seq: '7',
                recordedAt: new Date('2026-06-02T12:34:56.789Z'),
                mutationKind: 'CLOSE_POSITION',
                subjectKind: 'paper_account_state_history',
                subjectId: '11111111-1111-1111-1111-111111111111',
                payloadHash: Buffer.alloc(32, 0x55),
                prevRowHash: Buffer.alloc(32, 0x33),
            };

            const original = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload));

            const tampered = { ...payload, payloadHash: Buffer.alloc(32, 0x56) };
            const tamperedHmac = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, tampered));

            expect(original.equals(tamperedHmac)).toBe(false);
        });

        it('changing prev_row_hash invalidates the HMAC (linkage break)', () => {
            const base = {
                seq: '7',
                recordedAt: new Date('2026-06-02T12:34:56.789Z'),
                mutationKind: 'CLOSE_POSITION',
                subjectKind: 'paper_account_state_history',
                subjectId: '11111111-1111-1111-1111-111111111111',
                payloadHash: Buffer.alloc(32, 0x55),
                prevRowHash: Buffer.alloc(32, 0x33),
            };

            const original = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, base));
            const reLinked = { ...base, prevRowHash: Buffer.alloc(32, 0x77) };
            const reLinkedHmac = codec.computeHmac(subkey, codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, reLinked));

            expect(original.equals(reLinkedHmac)).toBe(false);
        });
    });

    describe('per-purpose sub-key isolation', () => {
        it('signing the same payload under a different HKDF info string produces a different HMAC', () => {
            const appConfig = { authBootstrapSecret: BOOTSTRAP_SECRET } as AppConfigService;
            const deriver = new BootstrapSubkeyDeriver(appConfig);
            const paperKey = deriver.deriveSubkey(HKDF_INFO_PAPER_STATE_AUDIT);
            const bootKey = deriver.deriveSubkey('boot_mode_history v1');

            const payload = {
                seq: '1',
                recordedAt: new Date('2026-06-01T00:00:00.000Z'),
                mutationKind: 'OPEN_POSITION',
                subjectKind: 'paper_account_state',
                subjectId: '00000000-0000-0000-0000-000000000001',
                payloadHash: Buffer.alloc(32, 0xab),
                prevRowHash: null,
            };

            const canonical = codec.encodePayload(CHAIN_NAME_PAPER_STATE_AUDIT, payload);
            const underPaperKey = codec.computeHmac(paperKey, canonical);
            const underBootKey = codec.computeHmac(bootKey, canonical);

            expect(underPaperKey.equals(underBootKey)).toBe(false);
        });
    });

    describe('hashOrderedPayload', () => {
        it('produces a 32-byte SHA-256 digest', () => {
            const digest = codec.hashOrderedPayload([['op', 'open'], ['client_order_id', 'tbvt-1']]);
            expect(digest.length).toBe(32);
        });

        it('is order-sensitive — reordered pairs produce a different digest', () => {
            const a = codec.hashOrderedPayload([['op', 'open'], ['client_order_id', 'tbvt-1']]);
            const b = codec.hashOrderedPayload([['client_order_id', 'tbvt-1'], ['op', 'open']]);
            expect(a.equals(b)).toBe(false);
        });
    });
});
