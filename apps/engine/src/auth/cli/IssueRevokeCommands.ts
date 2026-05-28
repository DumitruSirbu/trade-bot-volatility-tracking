/* eslint-disable no-console */
import { AuthScopeEnum } from '@bot/shared';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { AUTH_TOKEN_DEFAULT_AUDIENCE, AuthTokenService, RevokedJtiRepository } from '../AuthModule';
import { AUTH_TOKEN_DEFAULT_TTL_SEC, AUTH_TOKEN_MAX_TTL_SEC } from '../const/authConsts';

// M9 W2 (ADR 0020 §2.1, §2.2). M13 fix wave 7 added `--aud`.
//
// `pnpm engine auth issue --sub <id> --scope read,halt[,admin] --ttl 15m [--aud mcp]`
// `pnpm engine auth revoke --jti <id> [--reason "<text>"]`
//
// `--aud` defaults to `'engine'` for backward compatibility with M9-minted
// tokens. Mint MCP-targeted tokens with `--aud mcp` so the MCP bearer verifier
// accepts them.
//
// Standalone Nest application context, mirroring `StrategyCli.ts` so the same
// DI graph the live engine uses provides AuthTokenService + RevokedJtiRepository.
// Exit-code map (consumers grep here):
//   0   success
//   1   runtime failure (unexpected exception)
//   2   bad arguments (missing/invalid flag)

const SUBCOMMAND_ISSUE = 'issue';
const SUBCOMMAND_REVOKE = 'revoke';

export const AUTH_CLI_EXIT_OK = 0;
export const AUTH_CLI_EXIT_RUNTIME = 1;
export const AUTH_CLI_EXIT_BAD_ARGS = 2;

interface IFlagBag {
    readonly [key: string]: string | undefined;
}

export interface IIssueArgs {
    sub: string;
    scopes: AuthScopeEnum[];
    ttlSec: number;
    aud: string;
}

export interface IRevokeArgs {
    jti: string;
    reason: string | null;
    revokedBy: string;
}

// ---------------------------------------------------------------------------
// Argv parsers — exported so tests can drive them without a Nest context.
// ---------------------------------------------------------------------------

export function parseIssueArgs(argv: ReadonlyArray<string>): IIssueArgs {
    const flags = parseFlags(argv);
    const sub = required(flags, 'sub');
    const scopeCsv = required(flags, 'scope');
    const ttl = flags.ttl ?? `${AUTH_TOKEN_DEFAULT_TTL_SEC}s`;

    const scopes = scopeCsv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const parsedScopes: AuthScopeEnum[] = [];
    const allowed = new Set<string>(Object.values(AuthScopeEnum));

    for (const scope of scopes) {
        if (!allowed.has(scope)) {
            throw new Error(`invalid --scope value '${scope}' (allowed: ${Object.values(AuthScopeEnum).join(',')})`);
        }

        parsedScopes.push(scope as AuthScopeEnum);
    }

    if (parsedScopes.length === 0) {
        throw new Error('--scope requires at least one scope');
    }

    const ttlSec = parseTtlSec(ttl);

    if (ttlSec <= 0 || ttlSec > AUTH_TOKEN_MAX_TTL_SEC) {
        throw new Error(`--ttl must be in (0, ${AUTH_TOKEN_MAX_TTL_SEC}] seconds`);
    }

    // M13 fix wave 7 — optional audience flag; defaults to AUTH_TOKEN_DEFAULT_AUDIENCE.
    const audRaw = flags.aud;

    if (audRaw !== undefined && audRaw.length === 0) {
        throw new Error('--aud requires a non-empty value');
    }

    const aud = audRaw ?? AUTH_TOKEN_DEFAULT_AUDIENCE;

    return { sub, scopes: parsedScopes, ttlSec, aud };
}

export function parseRevokeArgs(argv: ReadonlyArray<string>): IRevokeArgs {
    const flags = parseFlags(argv);
    const jti = required(flags, 'jti');

    return {
        jti,
        reason: flags.reason ?? null,
        revokedBy: flags['revoked-by'] ?? 'CLI',
    };
}

function parseFlags(argv: ReadonlyArray<string>): IFlagBag {
    const out: Record<string, string> = {};

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];

        if (!token.startsWith('--')) {
            continue;
        }

        const key = token.slice(2);
        const next = argv[i + 1];

        if (next === undefined || next.startsWith('--')) {
            throw new Error(`flag --${key} requires a value`);
        }

        out[key] = next;
        i += 1;
    }

    return out;
}

function required(flags: IFlagBag, key: string): string {
    const value = flags[key];

    if (value === undefined || value.length === 0) {
        throw new Error(`missing required flag --${key}`);
    }

    return value;
}

// Accepts `900`, `900s`, `15m`, `1h`. Tiny on purpose — no `ms` lib.
function parseTtlSec(raw: string): number {
    const match = /^([0-9]+)(s|m|h)?$/u.exec(raw);

    if (match === null) {
        throw new Error(`invalid --ttl '${raw}' (expected e.g. 900, 900s, 15m, 1h)`);
    }

    const n = Number.parseInt(match[1], 10);
    const unit = match[2] ?? 's';

    if (unit === 's') {
        return n;
    }

    if (unit === 'm') {
        return n * 60;
    }

    return n * 3600;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(argv: ReadonlyArray<string>): Promise<number> {
    const [subcommand, ...rest] = argv;

    if (subcommand === undefined) {
        console.error('auth: missing subcommand. Expected one of: issue | revoke');

        return AUTH_CLI_EXIT_BAD_ARGS;
    }

    let parsed: IIssueArgs | IRevokeArgs;

    try {
        if (subcommand === SUBCOMMAND_ISSUE) {
            parsed = parseIssueArgs(rest);
        } else if (subcommand === SUBCOMMAND_REVOKE) {
            parsed = parseRevokeArgs(rest);
        } else {
            console.error(`auth: unknown subcommand '${subcommand}'. Expected one of: issue | revoke`);

            return AUTH_CLI_EXIT_BAD_ARGS;
        }
    } catch (cause) {
        console.error(`auth ${subcommand}: ${(cause as Error).message}`);

        return AUTH_CLI_EXIT_BAD_ARGS;
    }

    const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
    const logger = new Logger('AuthCli');

    try {
        if (subcommand === SUBCOMMAND_ISSUE) {
            const tokens = app.get(AuthTokenService);
            const issueArgs = parsed as IIssueArgs;
            const issued = tokens.issue({
                sub: issueArgs.sub,
                scopes: issueArgs.scopes,
                ttlSec: issueArgs.ttlSec,
                aud: issueArgs.aud,
                now: new Date(),
            });

            // Stdout is the token — operator-facing. Logger goes to pino.
            console.log(issued.token);
            logger.log(`issued token jti=${issued.jti} sub=${issueArgs.sub} aud=${issueArgs.aud} exp=${issued.exp}`);

            return AUTH_CLI_EXIT_OK;
        }

        const args = parsed as IRevokeArgs;
        const repo = app.get(RevokedJtiRepository);

        await repo.revoke(args.jti, args.revokedBy, args.reason);
        console.log(`revoked jti=${args.jti}`);

        return AUTH_CLI_EXIT_OK;
    } catch (cause) {
        logger.error(`auth ${subcommand} failed: ${(cause as Error).message}`, (cause as Error).stack);
        console.error(`auth ${subcommand}: ${(cause as Error).message}`);

        return AUTH_CLI_EXIT_RUNTIME;
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    void main(process.argv.slice(2)).then((code) => {
        process.exit(code);
    });
}

export { main as runAuthCli };
