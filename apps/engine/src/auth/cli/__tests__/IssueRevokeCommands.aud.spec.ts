/**
 * M13 fix wave 7 — `--aud` flag on `auth issue`.
 *
 * Verifies the CLI argv parser threads `--aud` into IIssueArgs and defaults to
 * 'engine' when the flag is absent. Argv parsing is pure — no Nest context.
 */

import { AuthScopeEnum } from '@bot/shared';

import { parseIssueArgs } from '../IssueRevokeCommands';

describe('parseIssueArgs — --aud flag (M13 fix wave 7)', () => {
    it('parses --aud mcp into IIssueArgs.aud', () => {
        // BUILD
        const argv = ['--sub', 'agent', '--scope', AuthScopeEnum.READ, '--ttl', '900s', '--aud', 'mcp'];

        // OPERATE
        const parsed = parseIssueArgs(argv);

        // CHECK
        expect(parsed.aud).toBe('mcp');
        expect(parsed.sub).toBe('agent');
        expect(parsed.ttlSec).toBe(900);
    });

    it('defaults aud to "engine" when --aud is omitted', () => {
        // BUILD
        const argv = ['--sub', 'agent', '--scope', AuthScopeEnum.READ, '--ttl', '900s'];

        // OPERATE
        const parsed = parseIssueArgs(argv);

        // CHECK
        expect(parsed.aud).toBe('engine');
    });

    it('accepts an arbitrary aud value (audience-policy lives in each verifier)', () => {
        // BUILD
        const argv = ['--sub', 'agent', '--scope', AuthScopeEnum.READ, '--ttl', '900s', '--aud', 'dashboard'];

        // OPERATE
        const parsed = parseIssueArgs(argv);

        // CHECK
        expect(parsed.aud).toBe('dashboard');
    });
});
