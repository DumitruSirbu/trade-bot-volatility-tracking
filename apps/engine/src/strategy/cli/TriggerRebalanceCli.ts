import { AuthScopeEnum, READ_API_PATHS } from '@bot/shared';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { AuthTokenService, RevokedJtiRepository } from '../../auth/AuthModule';
import { AppConfigService } from '../../config/service';
import {
    REBALANCE_TRIGGER_ADMIN_TOKEN_TTL_SEC,
    REBALANCE_TRIGGER_ALLOWED_HOSTS,
    REBALANCE_TRIGGER_CLI_EXIT_BAD_ARGS,
    REBALANCE_TRIGGER_CLI_EXIT_OK,
    REBALANCE_TRIGGER_CLI_EXIT_RUNTIME,
    REBALANCE_TRIGGER_DEFAULT_ENGINE_PORT,
} from '../const';

// `pnpm rebalance:trigger` entrypoint (ADR 0048 §10). Mints a short-lived admin JWT via the
// same DI graph the live engine uses, then POSTs to `POST /v1/control/trigger-rebalance` on the
// running HTTP listener. The Nest context is NOT the server process — it only issues the token
// and performs the HTTP call; the event is emitted inside the already-running engine. The minted
// token targets loopback ONLY (see assertLoopbackHost) and is revoked after the call.

export { REBALANCE_TRIGGER_CLI_EXIT_OK, REBALANCE_TRIGGER_CLI_EXIT_RUNTIME, REBALANCE_TRIGGER_CLI_EXIT_BAD_ARGS };

export interface ITriggerRebalanceCliArgs {
    readonly baseUrl: string;
}

export function parseTriggerRebalanceArgs(argv: ReadonlyArray<string>): ITriggerRebalanceCliArgs {
    const flags: Record<string, string> = {};

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

        flags[key] = next;
        i += 1;
    }

    const baseUrl = flags['base-url'] ?? `http://127.0.0.1:${process.env.ENGINE_PORT ?? REBALANCE_TRIGGER_DEFAULT_ENGINE_PORT}`;

    if (baseUrl.length === 0) {
        throw new Error('--base-url requires a non-empty value');
    }

    const normalized = baseUrl.replace(/\/$/u, '');

    assertLoopbackHost(normalized);

    return { baseUrl: normalized };
}

// This CLI hands a live admin JWT to the target host, so it must only ever target loopback —
// a hostile or typo'd remote host would otherwise receive a working admin token.
function assertLoopbackHost(baseUrl: string): void {
    let hostname: string;

    try {
        hostname = new URL(baseUrl).hostname;
    } catch {
        throw new Error(`--base-url is not a valid URL: ${baseUrl}`);
    }

    // URL wraps IPv6 literals in brackets ("[::1]"); strip them for the allow-list comparison.
    const bare = hostname.replace(/^\[|\]$/gu, '');

    if (!REBALANCE_TRIGGER_ALLOWED_HOSTS.includes(bare)) {
        throw new Error(`refusing to send admin token to non-loopback host '${bare}' ` + `(allowed: ${REBALANCE_TRIGGER_ALLOWED_HOSTS.join(', ')})`);
    }
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
    let args: ITriggerRebalanceCliArgs;

    try {
        args = parseTriggerRebalanceArgs(argv);
    } catch (cause) {
        console.error(`rebalance:trigger: ${(cause as Error).message}`);

        return REBALANCE_TRIGGER_CLI_EXIT_BAD_ARGS;
    }

    const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
    const logger = new Logger('RebalanceTriggerCli');

    try {
        const config = app.get(AppConfigService);
        const tokens = app.get(AuthTokenService);
        const revokedJti = app.get(RevokedJtiRepository);
        const url = `${args.baseUrl}${READ_API_PATHS.controlTriggerRebalance}`;

        const code = await postTriggerRebalance({ tokens, revokedJti, logger, url });

        if (code === REBALANCE_TRIGGER_CLI_EXIT_OK) {
            logger.log(`trigger-rebalance ok exchangeEnv=${config.exchangeEnv} url=${url}`);
        }

        return code;
    } catch (cause) {
        logger.error(`rebalance:trigger failed: ${(cause as Error).message}`, (cause as Error).stack);
        console.error(`rebalance:trigger: ${(cause as Error).message}`);

        return REBALANCE_TRIGGER_CLI_EXIT_RUNTIME;
    } finally {
        await app.close();
    }
}

interface IPostTriggerRebalanceDeps {
    readonly tokens: AuthTokenService;
    readonly revokedJti: RevokedJtiRepository;
    readonly logger: Logger;
    readonly url: string;
}

// Mint the one-shot admin token, POST the trigger, interpret the response, then revoke the token.
// The token is always revoked (finally) so a leaked stdout/log line cannot be replayed.
async function postTriggerRebalance(deps: IPostTriggerRebalanceDeps): Promise<number> {
    const issued = deps.tokens.issue({
        sub: 'rebalance-trigger-cli',
        scopes: [AuthScopeEnum.ADMIN],
        ttlSec: REBALANCE_TRIGGER_ADMIN_TOKEN_TTL_SEC,
        aud: 'engine',
        now: new Date(),
    });

    try {
        const response = await fetch(deps.url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${issued.token}`,
                Accept: 'application/json',
            },
        });

        const bodyText = await response.text();

        return interpretTriggerResponse(response, bodyText, deps.logger);
    } finally {
        await revokeTokenBestEffort(deps.revokedJti, issued.jti, deps.logger);
    }
}

// Map the HTTP response to a CLI exit code. A non-2xx is a runtime failure (surfaced on stderr +
// log); a success prints the response body to stdout — the tool's actual output channel.
function interpretTriggerResponse(response: Response, bodyText: string, logger: Logger): number {
    if (!response.ok) {
        console.error(`rebalance:trigger: HTTP ${response.status} ${bodyText}`);
        logger.error(`trigger-rebalance failed status=${response.status} body=${bodyText}`);

        return REBALANCE_TRIGGER_CLI_EXIT_RUNTIME;
    }

    // eslint-disable-next-line no-console -- CLI stdout is the tool's actual output channel, not a log line
    console.log(bodyText);

    return REBALANCE_TRIGGER_CLI_EXIT_OK;
}

async function revokeTokenBestEffort(revokedJti: RevokedJtiRepository, jti: string, logger: Logger): Promise<void> {
    try {
        await revokedJti.revoke(jti, 'rebalance-trigger-cli', 'one-shot admin token consumed');
    } catch (cause) {
        logger.warn(`failed to revoke CLI admin token jti=${jti}: ${(cause as Error).message}`);
    }
}

if (require.main === module) {
    void main(process.argv.slice(2)).then((code) => {
        process.exit(code);
    });
}

export { main as runRebalanceTriggerCli };
