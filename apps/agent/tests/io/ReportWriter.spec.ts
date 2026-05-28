// M13 W5.A — ReportWriter disk-write spec.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportWriter } from '../../src/io/ReportWriter.js';

describe('ReportWriter', () => {
    let baseDir: string;

    beforeEach(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'agent-report-writer-'));
    });

    afterEach(async () => {
        await rm(baseDir, { recursive: true, force: true });
    });

    it('writes markdown and json to <baseDir>/<weekIso>/<draftId>.{md,json}', async () => {
        const writer = new ReportWriter(baseDir);
        const json = { gate: { passes: false }, modelId: 'anthropic/claude-opus-4-7' };

        const paths = await writer.write('2026-W22', 42, '# Report\n\nbody.', json);

        expect(paths.mdPath).toBe(join(baseDir, '2026-W22', '42.md'));
        expect(paths.jsonPath).toBe(join(baseDir, '2026-W22', '42.json'));
        await expect(readFile(paths.mdPath, 'utf8')).resolves.toBe('# Report\n\nbody.');
        const written = JSON.parse(await readFile(paths.jsonPath, 'utf8')) as unknown;
        expect(written).toEqual(json);
    });

    it('creates nested directories recursively on first write', async () => {
        const writer = new ReportWriter(join(baseDir, 'deeply', 'nested'));
        const paths = await writer.write('2026-W01', 1, 'x', {});
        await expect(readFile(paths.mdPath, 'utf8')).resolves.toBe('x');
    });

    it('overwrites prior content for the same draftVersionId (rerun safety)', async () => {
        const writer = new ReportWriter(baseDir);
        await writer.write('2026-W22', 7, 'first', { v: 1 });
        const paths = await writer.write('2026-W22', 7, 'second', { v: 2 });
        await expect(readFile(paths.mdPath, 'utf8')).resolves.toBe('second');
        const written = JSON.parse(await readFile(paths.jsonPath, 'utf8')) as { v: number };
        expect(written.v).toBe(2);
    });
});
