// M13 W5.A — Disk-write component for weekly agent reports.
//
// Writes the markdown + json artefacts produced by `buildReport` to
// `<baseDir>/<weekIso>/<draftVersionId>.{md,json}`. The directory tree is
// created lazily on every call (idempotent — `recursive: true`); we do not
// pre-flight check existence to keep this loss-tolerant under concurrent
// dry-runs in tests.
//
// `--dry-run` callers do NOT use this writer; the entry-point wires a stub
// instead so disk is never touched.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IReportPaths, IReportWriterPort } from '../loop/runWeeklyLoop.js';

export class ReportWriter implements IReportWriterPort {
    constructor(private readonly baseDir: string) {}

    async write(weekIso: string, draftVersionId: number, markdown: string, json: unknown): Promise<IReportPaths> {
        const dir = join(this.baseDir, weekIso);
        await mkdir(dir, { recursive: true });
        const mdPath = join(dir, `${draftVersionId}.md`);
        const jsonPath = join(dir, `${draftVersionId}.json`);
        await writeFile(mdPath, markdown, 'utf8');
        await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
        return { mdPath, jsonPath };
    }
}
