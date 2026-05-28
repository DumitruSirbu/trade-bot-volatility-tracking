// M13 W5.A — CLI argument parser for `apps/agent/src/main.ts`.
//
// Pure-function parser using only the Node built-in `process.argv` shape
// (no external dep). Recognised flags:
//   --week-iso <YYYY-Www>    (string; format-validated)
//   --dry-run                (boolean; skips SDF + history, prints to stdout)
//   --parent-version-id <N>  (positive integer; overrides active-version lookup)
//
// Unknown flags throw `CliArgError` so the entry-point can exit non-zero with a
// clear diagnostic instead of silently ignoring a typo.

const ISO_WEEK_PATTERN = /^\d{4}-W\d{2}$/;

export class CliArgError extends Error {
    public readonly argName: string;

    constructor(argName: string, detail: string) {
        super(`Invalid CLI arg ${argName}: ${detail}`);
        this.name = 'CliArgError';
        this.argName = argName;
    }
}

export interface IAgentCliArgs {
    readonly weekIso: string | null;
    readonly dryRun: boolean;
    readonly parentVersionId: number | null;
}

export function parseCliArgs(argv: ReadonlyArray<string>): IAgentCliArgs {
    // Conventional `process.argv` shape: [nodeBin, scriptPath, ...flags].
    const flags = argv.slice(2);
    let weekIso: string | null = null;
    let dryRun = false;
    let parentVersionId: number | null = null;

    for (let i = 0; i < flags.length; i += 1) {
        const flag = flags[i];
        if (flag === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (flag === '--week-iso') {
            weekIso = readWeekIsoValue(flags, i);
            i += 1;
            continue;
        }
        if (flag === '--parent-version-id') {
            parentVersionId = readParentVersionIdValue(flags, i);
            i += 1;
            continue;
        }
        throw new CliArgError(flag, 'unknown flag');
    }

    return { weekIso, dryRun, parentVersionId };
}

export function isValidIsoWeek(value: string): boolean {
    return ISO_WEEK_PATTERN.test(value);
}

function readWeekIsoValue(flags: ReadonlyArray<string>, atIndex: number): string {
    const raw = flags[atIndex + 1];
    if (raw === undefined || raw.startsWith('--')) {
        throw new CliArgError('--week-iso', 'missing value (expected YYYY-Www)');
    }
    if (!isValidIsoWeek(raw)) {
        throw new CliArgError('--week-iso', `not an ISO-week string: "${raw}"`);
    }
    return raw;
}

function readParentVersionIdValue(flags: ReadonlyArray<string>, atIndex: number): number {
    const raw = flags[atIndex + 1];
    if (raw === undefined || raw.startsWith('--')) {
        throw new CliArgError('--parent-version-id', 'missing value (expected positive integer)');
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliArgError('--parent-version-id', `not a positive integer: "${raw}"`);
    }
    return parsed;
}
