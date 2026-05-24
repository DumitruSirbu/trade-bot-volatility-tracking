/**
 * Canonical CLI argv-parser unit tests (R3-M2).
 *
 * The three strategy CLI commands previously each had their own copy of
 * `parseFlagMap` + `requireFlag`. R3-M2 extracted those into
 * `apps/engine/src/strategy/cli/cliArgs.ts`. These tests pin the canonical
 * behaviour so divergence cannot reappear silently.
 */

import { parseFlagMap, requireFlag } from '../cliArgs';

describe('parseFlagMap', () => {
    it('parses --key=value pairs into a Map', () => {
        const flags = parseFlagMap(['--from=a', '--to=b']);

        expect(flags.get('from')).toBe('a');
        expect(flags.get('to')).toBe('b');
    });

    it('preserves the right-hand side verbatim, including embedded "=" characters', () => {
        const flags = parseFlagMap(['--json={"k":"a=b"}']);

        expect(flags.get('json')).toBe('{"k":"a=b"}');
    });

    it('allows empty values (caller decides whether to reject downstream)', () => {
        // `--note=` is the canonical PromoteCommand case: parser passes through,
        // command-level validator rejects.
        const flags = parseFlagMap(['--note=']);

        expect(flags.get('note')).toBe('');
    });

    it('rejects positional arguments', () => {
        expect(() => parseFlagMap(['positional-arg'])).toThrow(/unexpected positional argument/);
    });

    it('rejects flags without "=" form', () => {
        expect(() => parseFlagMap(['--from'])).toThrow(/must use --key=value form/);
    });

    it('rejects flags with an empty key', () => {
        expect(() => parseFlagMap(['--=value'])).toThrow(/has empty key/);
    });

    it('later occurrences of the same key overwrite earlier ones (last-wins)', () => {
        const flags = parseFlagMap(['--label=first', '--label=second']);

        expect(flags.get('label')).toBe('second');
    });
});

describe('requireFlag', () => {
    it('returns the value when present', () => {
        const flags = new Map<string, string>([['note', 'hello']]);

        expect(requireFlag(flags, 'note')).toBe('hello');
    });

    it('throws a clear error when the flag is absent', () => {
        const flags = new Map<string, string>();

        expect(() => requireFlag(flags, 'from')).toThrow(/--from is required/);
    });

    it('returns an empty string when present-but-empty (boundary)', () => {
        // requireFlag does NOT enforce non-empty — that is the caller's job.
        const flags = new Map<string, string>([['note', '']]);

        expect(requireFlag(flags, 'note')).toBe('');
    });
});
