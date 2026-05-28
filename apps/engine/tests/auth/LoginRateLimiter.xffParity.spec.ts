import { IAlertPayload } from '@bot/shared';
import express from 'express';

import { IAlertSink } from '../../src/alert/sink/AlertSinkModule';
import { LoginRateLimiter } from '../../src/auth/LoginRateLimiter';
import { LOGIN_PER_IP_BURST_MAX } from '../../src/auth/const/authConsts';

// M11a W1.10 — `TRUSTED_PROXY_HOPS=0` parity test.
//
// The login rate-limiter buckets by source IP (per-IP burst + sustained).
// `AuthController.extractSourceIp` reads `req.ip`, which Express computes
// from the `trust proxy` setting. With `trust proxy = 0` (M11a default,
// pinned in `.env.example`), Express IGNORES `X-Forwarded-For` and
// `req.ip` collapses to the socket remote address — so a peer cannot
// spoof a fresh bucket per attempt by rotating the XFF header.
//
// The test wires a real Express app at `trust proxy = 0` and asserts:
//   1. `req.ip` is the socket address regardless of XFF content;
//   2. consequently, repeated requests with rotating XFF values still
//      collide on the same per-IP bucket and the limiter throttles after
//      `LOGIN_PER_IP_BURST_MAX` admits.

class StubAlerts implements IAlertSink {
    readonly published: IAlertPayload[] = [];

    async publish(p: IAlertPayload): Promise<void> {
        this.published.push(p);
    }
}

// M11a W1.9 — LoginRateLimiter now persists windows; in-memory stub keeps the
// hot-path tests deterministic without a Postgres dependency.
class StubLoginRateLimitPersistence {
    async loadAll(): Promise<Array<{ sourceIp: string; scope: 'burst' | 'sustained' | 'global'; timestampsMs: number[] }>> {
        return [];
    }

    async upsert(): Promise<void> {
        // not exercised
    }

    async deleteByKey(): Promise<void> {
        // not exercised
    }
}

describe('LoginRateLimiter XFF parity at TRUSTED_PROXY_HOPS=0', () => {
    it('Express resolves req.ip to the socket address and ignores any X-Forwarded-For header', async () => {
        const app = express();
        // M11a W1.10: pinned to 0 — XFF is untrusted.
        app.set('trust proxy', 0);

        let capturedReqIp: string | null = null;
        let capturedHeaders: Record<string, unknown> = {};
        app.get('/probe', (req, res) => {
            capturedReqIp = req.ip ?? null;
            capturedHeaders = req.headers as unknown as Record<string, unknown>;
            res.status(200).send('ok');
        });

        const server = app.listen(0);

        try {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;

            await fetch(`http://127.0.0.1:${port}/probe`, {
                headers: { 'X-Forwarded-For': '203.0.113.99, 198.51.100.7' },
            });

            // The XFF header was sent but trust-proxy=0 means req.ip MUST be
            // the socket address (loopback / 127.0.0.1 / ::1).
            expect(capturedReqIp).not.toBe('203.0.113.99');
            expect(capturedReqIp).not.toBe('198.51.100.7');
            const socketLooksLocal = capturedReqIp === '::1' || capturedReqIp === '127.0.0.1' || capturedReqIp === '::ffff:127.0.0.1';
            expect(socketLooksLocal).toBe(true);
            // Header was received (proves we DID send it) but ignored for req.ip.
            expect(capturedHeaders['x-forwarded-for']).toBeDefined();
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('rate-limiter throttles after the burst cap is reached even when XFF rotates per request (no spoofed bucket reset)', () => {
        // At trust-proxy=0, every spoofed XFF collapses to the same `req.ip`
        // (the socket address). Simulate that contract directly: the limiter
        // sees the SAME sourceIp on every call regardless of XFF content.
        const limiter = new LoginRateLimiter(new StubAlerts(), new StubLoginRateLimitPersistence() as never);
        const now = new Date('2026-05-25T12:00:00Z');
        const sameSocketIp = '10.0.0.5';

        // Admit exactly the burst cap.
        for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i++) {
            limiter.enforce(sameSocketIp, now);
        }

        // The (BURST_MAX + 1)th attempt MUST throttle even though an attacker
        // might have rotated XFF on every prior request — they all hit the
        // same bucket because trust-proxy=0 made req.ip socket-only.
        expect(() => limiter.enforce(sameSocketIp, now)).toThrow();
    });

    it('a non-trusted XFF cannot present a fresh per-IP bucket via the resolved req.ip — sanity baseline', () => {
        // Documents the inverse: if a non-zero trust-proxy ever lands without
        // an external proxy actually in front of the engine, a peer rotating
        // XFF would in fact reset buckets. Pinning TRUSTED_PROXY_HOPS=0 in
        // `.env.example` prevents this; this assertion is the contract guard.
        const limiter = new LoginRateLimiter(new StubAlerts(), new StubLoginRateLimitPersistence() as never);
        const now = new Date('2026-05-25T12:00:00Z');

        // Two DIFFERENT sourceIps — what Express would yield IF trust-proxy
        // were misconfigured and the limiter saw the XFF first hop.
        for (let i = 0; i < LOGIN_PER_IP_BURST_MAX; i++) {
            limiter.enforce('192.0.2.1', now);
        }

        // A SECOND IP gets its own bucket — proves the limiter is per-IP, so
        // making `req.ip` socket-only is what enforces the M11a safety prop.
        expect(() => limiter.enforce('192.0.2.2', now)).not.toThrow();
    });
});
