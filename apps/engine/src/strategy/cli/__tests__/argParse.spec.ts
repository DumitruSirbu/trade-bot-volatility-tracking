/**
 * Pure argv-parser unit tests for the strategy CLI subcommands (M8 W7).
 *
 * No Nest, no DB. Exercises only the exported `parse*` helpers from each
 * command file. Covers happy paths plus the adversarial boundaries:
 *   - missing required flags reject
 *   - non-positional only (--key=value form enforced)
 *   - --versions: numeric ids, name:version pairs, mixed (rejected)
 *   - --split-policy: 'default' sentinel + custom JSON, malformed JSON rejected
 *   - bad ISO 8601 timestamps rejected
 *   - toMs <= fromMs rejected
 */

import { parseCompareArgs, parseSplitPolicy, parseVersionsArg } from '../CompareCommand';
import { parsePromoteArgs } from '../PromoteCommand';
import { parseReactivateArgs } from '../ReactivateCommand';
import { WalkForwardSplitModeEnum } from '../../../backtest/enum/WalkForwardSplitModeEnum';

describe('parseCompareArgs', () => {
    it('parses required flags with default split policy and a label', () => {
        const args = parseCompareArgs([
            '--from=2025-01-01T00:00:00Z',
            '--to=2025-04-01T00:00:00Z',
            '--versions=1,2,3',
            '--label=run-A',
        ]);

        expect(args.fromMs).toBe(Date.parse('2025-01-01T00:00:00Z'));
        expect(args.toMs).toBe(Date.parse('2025-04-01T00:00:00Z'));
        expect(args.runLabel).toBe('run-A');
        expect(args.versionSpecs).toEqual([
            { kind: 'id', id: 1 },
            { kind: 'id', id: 2 },
            { kind: 'id', id: 3 },
        ]);
        expect(args.splitPolicy.mode).toBe(WalkForwardSplitModeEnum.ROLLING);
        expect(args.splitPolicy.trainBars).toBe(60 * 288);
    });

    it('synthesises a runLabel when --label is omitted', () => {
        const args = parseCompareArgs([
            '--from=2025-01-01T00:00:00Z',
            '--to=2025-02-01T00:00:00Z',
            '--versions=1',
        ]);

        expect(args.runLabel).toMatch(/^compare-\d+$/);
    });

    it('rejects when --from is missing', () => {
        expect(() => parseCompareArgs(['--to=2025-01-01T00:00:00Z', '--versions=1'])).toThrow(/--from is required/);
    });

    it('rejects when --to <= --from', () => {
        expect(() =>
            parseCompareArgs(['--from=2025-04-01T00:00:00Z', '--to=2025-04-01T00:00:00Z', '--versions=1']),
        ).toThrow(/--to .* must be after --from/);
    });

    it('rejects malformed ISO 8601', () => {
        expect(() =>
            parseCompareArgs(['--from=not-a-date', '--to=2025-01-01T00:00:00Z', '--versions=1']),
        ).toThrow(/--from 'not-a-date' is not a valid ISO-8601 timestamp/);
    });

    it('rejects unexpected positional arguments', () => {
        expect(() =>
            parseCompareArgs(['positional-bad', '--from=2025-01-01T00:00:00Z', '--to=2025-02-01T00:00:00Z', '--versions=1']),
        ).toThrow(/unexpected positional argument/);
    });
});

describe('parseVersionsArg', () => {
    it('parses numeric ids', () => {
        expect(parseVersionsArg('1,2,3')).toEqual([
            { kind: 'id', id: 1 },
            { kind: 'id', id: 2 },
            { kind: 'id', id: 3 },
        ]);
    });

    it('parses name:version pairs', () => {
        expect(parseVersionsArg('v1:1,v2:2')).toEqual([
            { kind: 'name_version', name: 'v1', version: 1 },
            { kind: 'name_version', name: 'v2', version: 2 },
        ]);
    });

    it('rejects mixing the two forms', () => {
        expect(() => parseVersionsArg('1,v2:2')).toThrow(/either all numeric ids OR all name:version pairs/);
    });

    it('rejects an empty token list', () => {
        expect(() => parseVersionsArg('')).toThrow(/at least one version/);
    });

    it('rejects non-positive numeric ids', () => {
        expect(() => parseVersionsArg('0,1')).toThrow(/positive integer id/);
        expect(() => parseVersionsArg('-5')).toThrow(/positive integer id/);
    });

    it('rejects non-positive versions in name:version form', () => {
        expect(() => parseVersionsArg('v1:0')).toThrow(/non-positive integer version/);
    });
});

describe('parseSplitPolicy', () => {
    it('returns the default policy on the "default" sentinel', () => {
        const policy = parseSplitPolicy('default');

        expect(policy).toEqual({
            trainBars: 60 * 288,
            validationBars: 14 * 288,
            oosBars: 14 * 288,
            stepBars: 14 * 288,
            mode: WalkForwardSplitModeEnum.ROLLING,
        });
    });

    it('parses a custom JSON policy', () => {
        const policy = parseSplitPolicy('{"trainBars":100,"validationBars":50,"oosBars":50,"stepBars":50,"mode":"expanding"}');

        expect(policy.mode).toBe(WalkForwardSplitModeEnum.EXPANDING);
        expect(policy.trainBars).toBe(100);
        expect(policy.stepBars).toBe(50);
    });

    it('rejects malformed JSON', () => {
        expect(() => parseSplitPolicy('{not-json')).toThrow(/not valid JSON/);
    });

    it('rejects non-positive bars in custom JSON', () => {
        expect(() =>
            parseSplitPolicy('{"trainBars":0,"validationBars":50,"oosBars":50,"stepBars":50,"mode":"rolling"}'),
        ).toThrow(/trainBars must be a positive integer/);
    });
});

describe('parsePromoteArgs', () => {
    it('parses required flags', () => {
        const args = parsePromoteArgs(['--version-id=12', '--report-id=34', '--note=because reasons']);

        expect(args).toEqual({ versionId: 12, reportId: 34, note: 'because reasons' });
    });

    it('rejects when --version-id is missing', () => {
        expect(() => parsePromoteArgs(['--report-id=1', '--note=x'])).toThrow(/--version-id is required/);
    });

    it('rejects non-positive ids', () => {
        expect(() => parsePromoteArgs(['--version-id=0', '--report-id=1', '--note=x'])).toThrow(/must be a positive integer/);
    });

    it('rejects empty --note', () => {
        // empty value form '--note=' is interpreted as empty string at the flag-value boundary
        expect(() => parsePromoteArgs(['--version-id=1', '--report-id=1', '--note='])).toThrow(/--note must be non-empty/);
    });
});

describe('parseReactivateArgs', () => {
    it('parses --version-id', () => {
        expect(parseReactivateArgs(['--version-id=7'])).toEqual({ versionId: 7 });
    });

    it('rejects when --version-id is missing', () => {
        expect(() => parseReactivateArgs([])).toThrow(/--version-id is required/);
    });

    it('rejects non-positive id', () => {
        expect(() => parseReactivateArgs(['--version-id=-1'])).toThrow(/must be a positive integer/);
    });
});
