import { NestFactory } from '@nestjs/core';

import { AuthTokenService, RevokedJtiRepository } from '../../src/auth/AuthModule';
import { AppConfigService } from '../../src/config/service';
import { parseTriggerRebalanceArgs, runRebalanceTriggerCli } from '../../src/strategy/cli/TriggerRebalanceCli';
import { REBALANCE_TRIGGER_CLI_EXIT_OK, REBALANCE_TRIGGER_CLI_EXIT_RUNTIME } from '../../src/strategy/const/strategyDevConsts';

jest.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: jest.fn() },
}));

describe('TriggerRebalanceCli — parseTriggerRebalanceArgs', () => {
    const originalPort = process.env.ENGINE_PORT;

    afterEach(() => {
        if (originalPort === undefined) {
            delete process.env.ENGINE_PORT;
        } else {
            process.env.ENGINE_PORT = originalPort;
        }
    });

    it('defaults base URL to localhost and ENGINE_PORT', () => {
        process.env.ENGINE_PORT = '3007';

        expect(parseTriggerRebalanceArgs([])).toEqual({ baseUrl: 'http://127.0.0.1:3007' });
    });

    it('accepts --base-url override and strips trailing slash', () => {
        expect(parseTriggerRebalanceArgs(['--base-url', 'http://localhost:3007/'])).toEqual({ baseUrl: 'http://localhost:3007' });
    });

    it('throws when --base-url is missing its value', () => {
        expect(() => parseTriggerRebalanceArgs(['--base-url'])).toThrow('--base-url requires a value');
    });

    it('accepts the ::1 IPv6 loopback literal', () => {
        expect(parseTriggerRebalanceArgs(['--base-url', 'http://[::1]:3007'])).toEqual({ baseUrl: 'http://[::1]:3007' });
    });

    it('rejects a non-loopback host so the admin token is never sent remotely', () => {
        expect(() => parseTriggerRebalanceArgs(['--base-url', 'http://evil.example.com:3007'])).toThrow('non-loopback host');
    });

    it('rejects a public IP host', () => {
        expect(() => parseTriggerRebalanceArgs(['--base-url', 'http://10.0.0.5:3007'])).toThrow('non-loopback host');
    });

    it('rejects a malformed base URL', () => {
        expect(() => parseTriggerRebalanceArgs(['--base-url', 'not-a-url'])).toThrow('not a valid URL');
    });
});

// ─── assertLoopbackHost — adversarial bypass attempts ─────────────────────────
//
// The allow-list check is a strict-equality membership test against ['127.0.0.1', 'localhost',
// '::1'] on the URL-parsed (and bracket-stripped) hostname. Every case below tries a plausible
// bypass; each MUST still resolve to loopback or be rejected — a false ACCEPT here would hand a
// live admin JWT to an unintended host.
describe('TriggerRebalanceCli — assertLoopbackHost bypass attempts', () => {
    it('rejects an IPv4-mapped IPv6 loopback literal (::ffff:127.0.0.1) — not in the allow-list verbatim', () => {
        // Node's URL parser canonicalizes this to [::ffff:7f00:1], which does not match any allowed
        // host string. Fail-safe (rejects) rather than a false accept — documents current behavior.
        expect(() => parseTriggerRebalanceArgs(['--base-url', 'http://[::ffff:127.0.0.1]:3007'])).toThrow('non-loopback host');
    });

    it('accepts uppercase LOCALHOST — the URL parser lowercases the hostname before the allow-list check', () => {
        expect(parseTriggerRebalanceArgs(['--base-url', 'http://LOCALHOST:3007'])).toEqual({ baseUrl: 'http://LOCALHOST:3007' });
    });

    it('accepts a URL with embedded userinfo (credentials) whose host is still loopback', () => {
        // Userinfo does not change the destination host — new URL(...).hostname strips it — so this
        // is not a host-allow-list bypass. Confirms the parser is not confused by the '@' separator.
        expect(parseTriggerRebalanceArgs(['--base-url', 'http://admin:secret@localhost:3007'])).toEqual({
            baseUrl: 'http://admin:secret@localhost:3007',
        });
    });

    it('rejects a hostname that merely CONTAINS "localhost" as a substring (localhost.evil.com)', () => {
        expect(() => parseTriggerRebalanceArgs(['--base-url', 'http://localhost.evil.com:3007'])).toThrow('non-loopback host');
    });

    it('rejects a hostname with a trailing dot (localhost.) — fails safe, not a bypass', () => {
        // The URL parser preserves the trailing dot; the allow-list compares against the bare
        // 'localhost' string so this is REJECTED. This is over-strict rather than a vulnerability
        // (a legitimate FQDN-loopback variant is refused, never a foreign host accepted).
        expect(() => parseTriggerRebalanceArgs(['--base-url', 'http://localhost.:3007'])).toThrow('non-loopback host');
    });

    it('rejects a --base-url that omits the protocol scheme (parsed as an opaque URL, empty hostname)', () => {
        // 'localhost:3007' parses as scheme='localhost:' with an opaque path, NOT as a hostname —
        // new URL(...).hostname is '' for this input, which is not in the allow-list. Fails safe.
        expect(() => parseTriggerRebalanceArgs(['--base-url', 'localhost:3007'])).toThrow('non-loopback host');
    });

    it('rejects a bare IP-like string with no scheme at all', () => {
        expect(() => parseTriggerRebalanceArgs(['--base-url', '127.0.0.1:3007'])).toThrow();
    });
});

// ─── runRebalanceTriggerCli — one-shot admin token revoke behavior ───────────
//
// The minted admin token MUST always be revoked (finally-block, best-effort) regardless of how the
// HTTP call resolves, and a revoke failure must never mask the original outcome. NestFactory is
// mocked so these tests exercise real postTriggerRebalance / revokeTokenBestEffort control flow
// without booting the actual Nest DI graph.
describe('TriggerRebalanceCli — runRebalanceTriggerCli token revoke behavior', () => {
    const issue = jest.fn();
    const revoke = jest.fn();
    const close = jest.fn().mockResolvedValue(undefined);
    let fetchSpy: jest.SpiedFunction<typeof fetch>;

    beforeEach(() => {
        issue.mockReset().mockReturnValue({ token: 'fake.jwt.token', jti: 'test-jti-1', exp: 9_999_999_999 });
        revoke.mockReset().mockResolvedValue(undefined);
        close.mockClear();

        const mockApp = {
            get: jest.fn((token: unknown) => {
                if (token === AppConfigService) {
                    return { exchangeEnv: 'paper' };
                }

                if (token === AuthTokenService) {
                    return { issue };
                }

                if (token === RevokedJtiRepository) {
                    return { revoke };
                }

                throw new Error(`unexpected DI token requested in test double: ${String(token)}`);
            }),
            close,
        };

        (NestFactory.createApplicationContext as jest.Mock).mockResolvedValue(mockApp);
        fetchSpy = jest.spyOn(global, 'fetch');
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('revokes the minted token exactly once on a successful HTTP call', async () => {
        fetchSpy.mockResolvedValue(new Response('{"accepted":true,"nowMs":1}', { status: 200 }));

        const code = await runRebalanceTriggerCli(['--base-url', 'http://127.0.0.1:3007']);

        expect(code).toBe(REBALANCE_TRIGGER_CLI_EXIT_OK);
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledWith('test-jti-1', 'rebalance-trigger-cli', 'one-shot admin token consumed');
    });

    it('still revokes the token when the HTTP response is non-2xx', async () => {
        fetchSpy.mockResolvedValue(new Response('{"message":"rejected"}', { status: 400 }));

        const code = await runRebalanceTriggerCli(['--base-url', 'http://127.0.0.1:3007']);

        expect(code).toBe(REBALANCE_TRIGGER_CLI_EXIT_RUNTIME);
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('still revokes the token when fetch itself throws a network error', async () => {
        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

        const code = await runRebalanceTriggerCli(['--base-url', 'http://127.0.0.1:3007']);

        // The network error propagates out of postTriggerRebalance (only a `finally`, no `catch`
        // around fetch) and is caught by main()'s outer try/catch as a runtime failure.
        expect(code).toBe(REBALANCE_TRIGGER_CLI_EXIT_RUNTIME);
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('does not mask a successful HTTP result when the revoke call itself fails', async () => {
        fetchSpy.mockResolvedValue(new Response('{"accepted":true,"nowMs":1}', { status: 200 }));
        revoke.mockRejectedValue(new Error('DB unavailable'));

        const code = await runRebalanceTriggerCli(['--base-url', 'http://127.0.0.1:3007']);

        // Revoke is best-effort: its failure is swallowed (logged) and must not turn a successful
        // trigger into a reported runtime failure.
        expect(code).toBe(REBALANCE_TRIGGER_CLI_EXIT_OK);
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('does not mask a non-2xx HTTP failure when the revoke call itself also fails', async () => {
        fetchSpy.mockResolvedValue(new Response('{"message":"rejected"}', { status: 403 }));
        revoke.mockRejectedValue(new Error('DB unavailable'));

        const code = await runRebalanceTriggerCli(['--base-url', 'http://127.0.0.1:3007']);

        // Original failure reason (non-2xx) must still be the reported outcome, not swapped for a
        // revoke-failure message or a different exit code.
        expect(code).toBe(REBALANCE_TRIGGER_CLI_EXIT_RUNTIME);
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('always closes the Nest application context, even on a runtime failure', async () => {
        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

        await runRebalanceTriggerCli(['--base-url', 'http://127.0.0.1:3007']);

        expect(close).toHaveBeenCalledTimes(1);
    });
});
