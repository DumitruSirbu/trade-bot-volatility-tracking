// M13 W5.A — parseCliArgs unit spec.

import { parseCliArgs, isValidIsoWeek, CliArgError } from '../../src/cli/parseCliArgs.js';

function argv(...flags: string[]): string[] {
    return ['/usr/bin/node', '/app/dist/main.js', ...flags];
}

describe('parseCliArgs', () => {
    it('returns all-null defaults when no flags supplied', () => {
        const parsed = parseCliArgs(argv());
        expect(parsed).toEqual({ weekIso: null, dryRun: false, parentVersionId: null });
    });

    it('parses --week-iso with a well-formed ISO week', () => {
        const parsed = parseCliArgs(argv('--week-iso', '2026-W22'));
        expect(parsed.weekIso).toBe('2026-W22');
    });

    it('rejects --week-iso with an ill-formed value', () => {
        expect(() => parseCliArgs(argv('--week-iso', '2026-22'))).toThrow(CliArgError);
    });

    it('rejects --week-iso without a value (next token is another flag)', () => {
        expect(() => parseCliArgs(argv('--week-iso', '--dry-run'))).toThrow(CliArgError);
    });

    it('parses --dry-run as a standalone boolean', () => {
        const parsed = parseCliArgs(argv('--dry-run'));
        expect(parsed.dryRun).toBe(true);
    });

    it('parses --parent-version-id as a positive integer', () => {
        const parsed = parseCliArgs(argv('--parent-version-id', '7'));
        expect(parsed.parentVersionId).toBe(7);
    });

    it('rejects --parent-version-id when not a positive integer', () => {
        expect(() => parseCliArgs(argv('--parent-version-id', '0'))).toThrow(CliArgError);
        expect(() => parseCliArgs(argv('--parent-version-id', '-1'))).toThrow(CliArgError);
        expect(() => parseCliArgs(argv('--parent-version-id', 'abc'))).toThrow(CliArgError);
    });

    it('parses all three flags together in any order', () => {
        const parsed = parseCliArgs(argv('--dry-run', '--parent-version-id', '4', '--week-iso', '2026-W22'));
        expect(parsed).toEqual({ weekIso: '2026-W22', dryRun: true, parentVersionId: 4 });
    });

    it('throws CliArgError on unknown flag', () => {
        expect(() => parseCliArgs(argv('--cosmic-rays'))).toThrow(CliArgError);
    });
});

describe('isValidIsoWeek', () => {
    it.each(['2026-W01', '1999-W52', '2026-W22'])('accepts %s', (week) => {
        expect(isValidIsoWeek(week)).toBe(true);
    });

    it.each(['2026-W1', '2026W22', '2026-22', 'abcd-Wxx', ''])('rejects %s', (week) => {
        expect(isValidIsoWeek(week)).toBe(false);
    });
});
