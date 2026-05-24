// Shared argv helpers for the `strategy` CLI subcommands (M8 W7). Extracted
// here so CompareCommand / PromoteCommand / ReactivateCommand share a single
// canonical implementation — R3-M2 fix for the parser-helpers DRY violation.
//
// Conventions:
//   - Every flag uses the `--key=value` form. Bare `--key value` and positional
//     arguments are rejected so the parser stays unambiguous.
//   - Empty *keys* are rejected here. Empty *values* are NOT rejected at this
//     boundary — some commands (e.g. PromoteCommand `--note=`) want to surface
//     their own value-specific error ("--note must be non-empty") downstream
//     after `requireFlag`. Commands that want strict non-empty values just call
//     a downstream validator on the returned string.

export function parseFlagMap(argv: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();

    for (const token of argv) {
        if (!token.startsWith('--')) {
            throw new Error(`unexpected positional argument '${token}'`);
        }

        const eq = token.indexOf('=');

        if (eq < 0) {
            throw new Error(`flag '${token}' must use --key=value form`);
        }

        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);

        if (key.length === 0) {
            throw new Error(`flag '${token}' has empty key`);
        }

        result.set(key, value);
    }

    return result;
}

export function requireFlag(flags: ReadonlyMap<string, string>, key: string): string {
    const value = flags.get(key);

    if (value === undefined) {
        throw new Error(`--${key} is required`);
    }

    return value;
}
