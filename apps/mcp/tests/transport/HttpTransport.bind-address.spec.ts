// M13 W1.B (ADR 0038 §2.1) — defense-in-depth bind-address assertion.
//
// Required-green: the HTTP listener MUST bind to `127.0.0.1`. A future config
// regression that flipped the bind host to `0.0.0.0` would surface here
// before it could reach an integration env.

import { z } from 'zod';

import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { MCP_HTTP_LOOPBACK_ADDRESS, startHttpTransport } from '../../src/transport/HttpTransport';
import { IRevokedJtiChecker } from '../../src/transport/bearerVerifier';

const noopRevoked: IRevokedJtiChecker = {
    isRevoked: async () => false,
};

const dummySecret = Buffer.alloc(32, 7);

function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerReadOnlyTool({
        name: 'ping',
        description: 'returns ok',
        paramsSchema: z.object({}).strict(),
        inputJsonSchema: { type: 'object', properties: {} },
        handler: async () => ({ ok: true }),
    });

    return registry;
}

describe('HttpTransport bind address', () => {
    it('binds to 127.0.0.1 on port 0 and reports the loopback address', async () => {
        const handle = await startHttpTransport({
            registry: makeRegistry(),
            authSecret: dummySecret,
            revoked: noopRevoked,
            port: 0,
        });

        try {
            const addr = handle.server.address();
            expect(addr).not.toBeNull();
            expect(typeof addr).toBe('object');
            const obj = addr as { address: string; port: number };
            expect(obj.address).toBe(MCP_HTTP_LOOPBACK_ADDRESS);
            expect(obj.address).not.toBe('0.0.0.0');
            expect(obj.address).not.toBe('::');
            expect(obj.address).not.toBe('::ffff:0.0.0.0');
            expect(obj.port).toBeGreaterThan(0);
        } finally {
            await handle.close();
        }
    });

    it('rejects a non-loopback bindHost without the explicit allowNetworkBind opt-in', async () => {
        await expect(
            startHttpTransport({
                registry: makeRegistry(),
                authSecret: dummySecret,
                revoked: noopRevoked,
                port: 0,
                bindHost: '0.0.0.0',
            }),
        ).rejects.toThrow(/allowNetworkBind/);
    });

    it('binds to 0.0.0.0 when explicitly opted-in via allowNetworkBind (compose-network use)', async () => {
        const handle = await startHttpTransport({
            registry: makeRegistry(),
            authSecret: dummySecret,
            revoked: noopRevoked,
            port: 0,
            bindHost: '0.0.0.0',
            allowNetworkBind: true,
        });

        try {
            const addr = handle.server.address();
            expect(addr).not.toBeNull();
            const obj = addr as { address: string; port: number };
            expect(obj.address).toBe('0.0.0.0');
            expect(obj.port).toBeGreaterThan(0);
        } finally {
            await handle.close();
        }
    });
});
