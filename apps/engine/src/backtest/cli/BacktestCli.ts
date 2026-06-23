// M12 W4 — engine-side CLI shim invoked by the MCP `run_backtest` tool via
// out-of-process spawn (ADR 0033 §2.5 Option II). The MCP boundary forbids
// importing engine code into the MCP process, so the agreed contract is:
//
//   pnpm --filter @bot/engine backtest run \
//       --version <strategy_version_id> \
//       --from <YYYY-MM-DD> \
//       --to   <YYYY-MM-DD> \
//       --output <abs-path-to-write-json>
//
// On success the shim writes an `IBacktestReport` JSON document to `--output`
// and exits 0. On failure it writes a one-line cause to stderr and exits
// non-zero. The wire shape is the shared `IBacktestReport` DTO, which the M12
// reviewer wave pins as the cross-process contract.
//
// Intentionally minimal: this file does NOT host argv parsing for any other
// flow. It is the single seam between MCP and the engine backtest runner.

import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { IBacktestConfig, IBacktestReport } from '@bot/shared';

import { AppModule } from '../../app.module';
import { RunBacktestCommand } from './RunBacktestCommand';
import { emitRedactedRunFailure } from './emitRedactedRunFailure';

export const BACKTEST_CLI_EXIT_OK = 0;
export const BACKTEST_CLI_EXIT_RUNTIME = 1;
export const BACKTEST_CLI_EXIT_BAD_ARGS = 2;

const SUBCOMMAND_RUN = 'run';

/**
 * Argv-parse error at the CLI boundary. A local class (rather than a global
 * domain exception) because the CLI shim is a process entrypoint, not a Nest
 * service — `DomainException` would drag DI/logger context that is not
 * available during argv parsing. The conventions ban raw `throw new Error`;
 * this is the boundary-justified narrow alternative. Exported so paired tests
 * can assert the type via `instanceof` without spinning up the Nest context.
 */
export class BacktestCliArgError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BacktestCliArgError';
    }
}

// Backtest-runner defaults for the MCP-driven slice. Matches IBacktestConfig
// invariants (`runLabel` echoed onto the report; depth-aware + intrabar SL on
// for fidelity). Capital + latency are conservative starter values; the MCP
// surface today exposes `{versionId, from, to}` only — operator-controlled
// knobs come in M13.
const DEFAULT_CAPITAL_USDT = '1000';
const DEFAULT_LATENCY_MS = 250;

interface IRunArgs {
    readonly versionId: number;
    readonly fromUtcDate: string;
    readonly toUtcDate: string;
    readonly outputPath: string;
    readonly timeStopMinutesOverride?: number;
    readonly targetTpSlRatioOverride?: number;
}

export function parseRunArgs(argv: readonly string[]): IRunArgs {
    const flags = readFlags(argv);

    const versionRaw = flags.get('version');
    if (versionRaw === undefined) {
        throw new BacktestCliArgError("missing required flag '--version <strategy_version_id>'");
    }
    const versionId = Number(versionRaw);
    if (!Number.isInteger(versionId) || versionId <= 0) {
        throw new BacktestCliArgError(`--version must be a positive integer, got '${versionRaw}'`);
    }

    const fromUtcDate = flags.get('from');
    if (fromUtcDate === undefined || !isIsoDate(fromUtcDate)) {
        throw new BacktestCliArgError("missing or invalid '--from <YYYY-MM-DD>'");
    }

    const toUtcDate = flags.get('to');
    if (toUtcDate === undefined || !isIsoDate(toUtcDate)) {
        throw new BacktestCliArgError("missing or invalid '--to <YYYY-MM-DD>'");
    }

    const outputPath = flags.get('output');
    if (outputPath === undefined || outputPath.length === 0) {
        throw new BacktestCliArgError("missing required flag '--output <path>'");
    }

    const timeStopMinutesOverride = parseTimeStopMinutesOverride(flags.get('time-stop-minutes'));
    const targetTpSlRatioOverride = parseTargetTpSlRatioOverride(flags.get('target-rr'));

    return { versionId, fromUtcDate, toUtcDate, outputPath: resolvePath(outputPath), timeStopMinutesOverride, targetTpSlRatioOverride };
}

function parseTimeStopMinutesOverride(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new BacktestCliArgError(`--time-stop-minutes must be a positive integer, got '${raw}'`);
    }
    return value;
}

// Like the time-stop helper but permits non-integers: the TP:SL ratio is a
// real-valued knob (e.g. 0.5, 1.5, 2). Only requires a finite, strictly
// positive number so a zero/negative ratio can never reach the divide.
function parseTargetTpSlRatioOverride(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new BacktestCliArgError(`--target-rr must be a positive number, got '${raw}'`);
    }
    return value;
}

function readFlags(argv: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (typeof token === 'string' && token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (typeof next === 'string' && !next.startsWith('--')) {
                out.set(key, next);
                i += 1;
            } else {
                out.set(key, 'true');
            }
        }
    }
    return out;
}

function isIsoDate(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value));
}

function buildConfig(args: IRunArgs): IBacktestConfig {
    const baseRunLabel = `mcp-${args.versionId}-${args.fromUtcDate}-${args.toUtcDate}`;
    const runLabel = appendRunLabelSuffixes(baseRunLabel, args);

    return {
        strategyVersionId: args.versionId,
        fromUtcDate: args.fromUtcDate,
        toUtcDate: args.toUtcDate,
        allocatedCapitalUsdt: DEFAULT_CAPITAL_USDT,
        latencyMs: DEFAULT_LATENCY_MS,
        enableDepthAwareSlippage: true,
        enableIntrabarStopSimulation: true,
        runLabel,
        timeStopMinutesOverride: args.timeStopMinutesOverride,
        targetTpSlRatioOverride: args.targetTpSlRatioOverride,
    };
}

// Stable suffix order: `-ts<n>` first (if present), then `-rr<value>`. With
// neither override set the label is byte-identical to the historic base label.
function appendRunLabelSuffixes(baseRunLabel: string, args: IRunArgs): string {
    let label = baseRunLabel;

    if (args.timeStopMinutesOverride !== undefined) {
        label = `${label}-ts${args.timeStopMinutesOverride}`;
    }

    if (args.targetTpSlRatioOverride !== undefined) {
        label = `${label}-rr${args.targetTpSlRatioOverride}`;
    }

    return label;
}

async function executeRun(args: IRunArgs): Promise<number> {
    const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });

    try {
        const command = app.get(RunBacktestCommand);
        const report: IBacktestReport = await command.run(buildConfig(args));
        writeFileSync(args.outputPath, JSON.stringify(report), { encoding: 'utf-8' });
        // why: NestJS Logger writes to stdout, but the MCP spawner tails ONLY
        // stderr for redaction (the JSON report is the stdout side-channel
        // via `--output` file). Emit operator-facing breadcrumbs on stderr so
        // they cannot accidentally appear in the report stream.
        process.stderr.write(`wrote backtest report to ${args.outputPath}\n`);
        return BACKTEST_CLI_EXIT_OK;
    } catch (cause) {
        emitRedactedRunFailure(cause);
        return BACKTEST_CLI_EXIT_RUNTIME;
    } finally {
        await app.close();
    }
}

async function main(argv: readonly string[]): Promise<number> {
    const [subcommand, ...rest] = argv;

    if (subcommand !== SUBCOMMAND_RUN) {
        // why: keep all CLI diagnostics on stderr (stdout is reserved for the
        // structured side-channel artefacts the MCP spawner inspects).
        process.stderr.write(`backtest: missing or unknown subcommand '${subcommand ?? ''}'. Expected: run\n`);
        return BACKTEST_CLI_EXIT_BAD_ARGS;
    }

    let parsed: IRunArgs;
    try {
        parsed = parseRunArgs(rest);
    } catch (cause) {
        // Argv-parse errors are operator-facing strings (no stack); emit only
        // the message. Defense-in-depth: still go through process.stderr,
        // mirroring the redacted single-line shape `executeRun` uses.
        process.stderr.write(`backtest run: ${(cause as Error).message}\n`);
        return BACKTEST_CLI_EXIT_BAD_ARGS;
    }

    return executeRun(parsed);
}

if (require.main === module) {
    // why: defence-in-depth against any stray throw escaping `main()` —
    // Node's default unhandled-rejection / uncaught-exception printer dumps
    // the full multi-line stack to stderr (including `/Users/...` paths,
    // provider state, node_modules edges). Funnel every escape route through
    // `emitRedactedRunFailure` so the MCP spawner sees the same one-line
    // redacted shape regardless of which layer threw.
    process.on('unhandledRejection', (reason) => {
        emitRedactedRunFailure(reason);
        process.exit(BACKTEST_CLI_EXIT_RUNTIME);
    });
    process.on('uncaughtException', (err) => {
        emitRedactedRunFailure(err);
        process.exit(BACKTEST_CLI_EXIT_RUNTIME);
    });

    void main(process.argv.slice(2))
        .then((code) => {
            process.exit(code);
        })
        .catch((cause) => {
            emitRedactedRunFailure(cause);
            process.exit(BACKTEST_CLI_EXIT_RUNTIME);
        });
}

export { main as runBacktestCli };
