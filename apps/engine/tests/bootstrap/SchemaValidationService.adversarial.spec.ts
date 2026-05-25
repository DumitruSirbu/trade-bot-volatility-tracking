import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';
import { DataSource } from 'typeorm';

import { IAlertSink } from '../../src/alert/AlertModule';
import { REQUIRED_SCHEMA_MANIFEST, SchemaValidationService } from '../../src/bootstrap/SchemaValidationService';

// M9 QA — adversarial extension to SchemaValidationService.spec.ts.
// Covers:
//   - One missing column on `control_audit` specifically (ADR 0025 §2.2)
//   - DB-ahead-of-code drift (extra unknown table) → still pass
//   - Code-ahead-of-DB drift (manifest references unknown table) → fail

class StubAlertSink implements IAlertSink {
    readonly published: IAlertPayload[] = [];

    async publish(payload: IAlertPayload): Promise<void> {
        this.published.push(payload);
    }
}

function buildColumnRows(columns: ReadonlyArray<string>): Array<{ column_name: string }> {
    return columns.map((column_name) => ({ column_name }));
}

function buildPinnedNow(): Date {
    return new Date(Date.UTC(2026, 4, 24, 12, 0, 0));
}

// ---------------------------------------------------------------------------
// Missing column on control_audit
// ---------------------------------------------------------------------------

describe('SchemaValidationService adversarial — missing column on control_audit', () => {
    let exitSpy: jest.SpyInstance;

    beforeEach(() => {
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${String(code ?? 0)}) called`);
        }) as never);
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('fails when control_audit is missing the new_state column', async () => {
        const sink = new StubAlertSink();
        const dataSource = {
            query: jest.fn(async (query: string, params?: unknown[]) => {
                if (query.includes('information_schema.columns')) {
                    const table = (params?.[0] as string | undefined) ?? '';
                    const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);

                    if (!manifestEntry) {
                        return [];
                    }

                    if (table === 'control_audit') {
                        // Strip `new_state` to simulate a partial migration.
                        const trimmed = manifestEntry.requiredColumns.filter((c) => c !== 'new_state');
                        return buildColumnRows(trimmed);
                    }

                    return buildColumnRows(manifestEntry.requiredColumns);
                }

                return [{ exists: true }];
            }),
        } as unknown as DataSource;

        const service = new SchemaValidationService(dataSource, sink);

        await expect(service.validate(buildPinnedNow())).rejects.toThrow(/process\.exit\(1\)/u);

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(sink.published).toHaveLength(1);
        expect(sink.published[0]!.type).toBe(AlertTypeEnum.BOOT_SCHEMA_GATE_FAILED);
        expect(sink.published[0]!.severity).toBe(AlertSeverityEnum.CRITICAL);
        expect(sink.published[0]!.body).toContain('control_audit');
        expect(sink.published[0]!.body).toContain('new_state');
    });
});

// ---------------------------------------------------------------------------
// DB-ahead-of-code drift: extra unknown table present → still pass
// ---------------------------------------------------------------------------

describe('SchemaValidationService adversarial — DB-ahead-of-code drift (extra table)', () => {
    let exitSpy: jest.SpyInstance;

    beforeEach(() => {
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${String(code ?? 0)}) called`);
        }) as never);
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('passes even when the DB has a table not in the manifest (forward-compat)', async () => {
        // The gate only checks tables in REQUIRED_SCHEMA_MANIFEST. An extra
        // table (`ml_embeddings`) in the DB should not cause a failure — it
        // would indicate DB is ahead of the current codebase, which is fine.
        const sink = new StubAlertSink();
        const dataSource = {
            query: jest.fn(async (query: string, params?: unknown[]) => {
                if (query.includes('information_schema.columns')) {
                    const table = (params?.[0] as string | undefined) ?? '';
                    const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);

                    if (!manifestEntry) {
                        // Gate only queries tables it knows about — extra DB tables
                        // are never queried by the manifest loop.
                        return [];
                    }

                    return buildColumnRows(manifestEntry.requiredColumns);
                }

                return [{ exists: true }];
            }),
        } as unknown as DataSource;

        const service = new SchemaValidationService(dataSource, sink);

        await service.validate(buildPinnedNow());

        expect(exitSpy).not.toHaveBeenCalled();
        expect(sink.published).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Code-ahead-of-DB drift: manifest references unknown table → fail
// ---------------------------------------------------------------------------

describe('SchemaValidationService adversarial — code-ahead-of-DB drift (manifest table absent)', () => {
    let exitSpy: jest.SpyInstance;

    beforeEach(() => {
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${String(code ?? 0)}) called`);
        }) as never);
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('fails when a manifest table returns no columns (table does not exist in DB)', async () => {
        // Simulate `revoked_jti` missing from the DB — returns 0 columns
        // which the gate interprets as "table absent".
        const sink = new StubAlertSink();
        const dataSource = {
            query: jest.fn(async (query: string, params?: unknown[]) => {
                if (query.includes('information_schema.columns')) {
                    const table = (params?.[0] as string | undefined) ?? '';

                    if (table === 'revoked_jti') {
                        // Simulates the table not existing — 0 rows returned.
                        return [];
                    }

                    const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);
                    return manifestEntry ? buildColumnRows(manifestEntry.requiredColumns) : [];
                }

                return [{ exists: true }];
            }),
        } as unknown as DataSource;

        const service = new SchemaValidationService(dataSource, sink);

        await expect(service.validate(buildPinnedNow())).rejects.toThrow(/process\.exit\(1\)/u);

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(sink.published[0]!.body).toContain('revoked_jti');
    });

    it('reports EVERY missing table in a single alert, not just the first', async () => {
        const sink = new StubAlertSink();
        const ABSENT_TABLES = ['control_audit', 'revoked_jti'];

        const dataSource = {
            query: jest.fn(async (query: string, params?: unknown[]) => {
                if (query.includes('information_schema.columns')) {
                    const table = (params?.[0] as string | undefined) ?? '';

                    if (ABSENT_TABLES.includes(table)) {
                        return [];
                    }

                    const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);
                    return manifestEntry ? buildColumnRows(manifestEntry.requiredColumns) : [];
                }

                return [{ exists: true }];
            }),
        } as unknown as DataSource;

        const service = new SchemaValidationService(dataSource, sink);

        await expect(service.validate(buildPinnedNow())).rejects.toThrow(/process\.exit\(1\)/u);

        expect(sink.published).toHaveLength(1);
        const { body, data } = sink.published[0]!;
        expect(body).toContain('control_audit');
        expect(body).toContain('revoked_jti');
        expect(Number(data?.failureCount)).toBeGreaterThanOrEqual(2);
    });
});
