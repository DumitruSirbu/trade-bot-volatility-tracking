import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';
import { DataSource } from 'typeorm';

import { IAlertSink } from '../../src/alert/AlertModule';
import { REQUIRED_SCHEMA_MANIFEST, SchemaValidationService } from '../../src/bootstrap/SchemaValidationService';
import { TICK_AGGREGATE_PARTITION_PREFIX } from '../../src/market-data/const';

// M9 W1 — adversarial unit tests for the PHASE 0 schema-validation gate
// (ADR 0025). The DataSource is a hand-rolled stub so each scenario can
// script its own information_schema response without standing up Postgres.
//
// `process.exit` is the only side effect that needs to be stubbed. The spy
// THROWS instead of exiting so the `failHard` path returns control to the
// test, and we can assert the alert sink was invoked with the exact payload
// shape before exit was called.

class StubAlertSink implements IAlertSink {
    readonly published: IAlertPayload[] = [];

    async publish(payload: IAlertPayload): Promise<void> {
        this.published.push(payload);
    }
}

interface IColumnRow {
    column_name: string;
}

interface IPartitionRow {
    exists: boolean;
}

type StubResponse = IColumnRow[] | IPartitionRow[];

function buildColumnRows(columns: ReadonlyArray<string>): IColumnRow[] {
    return columns.map((column_name) => ({ column_name }));
}

function buildAllPresentResponder(): (query: string, params?: unknown[]) => Promise<StubResponse> {
    return async (query: string, params?: unknown[]): Promise<StubResponse> => {
        if (query.includes('information_schema.columns')) {
            const table = (params?.[0] as string | undefined) ?? '';
            const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);

            if (!manifestEntry) {
                return [];
            }

            return buildColumnRows(manifestEntry.requiredColumns);
        }

        if (query.includes('to_regclass')) {
            return [{ exists: true }];
        }

        return [];
    };
}

function buildDataSourceStub(responder: (query: string, params?: unknown[]) => Promise<StubResponse>): DataSource {
    const query = jest.fn(responder);

    return { query } as unknown as DataSource;
}

function buildPinnedNow(): Date {
    // 2026-05-24 UTC — chosen so the partition stamp is stable across runs.
    return new Date(Date.UTC(2026, 4, 24, 12, 0, 0));
}

describe('SchemaValidationService', () => {
    let exitSpy: jest.SpyInstance;
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        // Track call ORDER so we can assert stderr.write happened BEFORE exit.
        // Without that ordering pino's async buffer can swallow the diagnostic
        // and the operator sees an empty container log on hard fail.
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${String(code ?? 0)}) called`);
        }) as never);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
        jest.restoreAllMocks();
    });

    describe('all-present schema', () => {
        it('passes without alerting and without exiting', async () => {
            const sink = new StubAlertSink();
            const dataSource = buildDataSourceStub(buildAllPresentResponder());
            const service = new SchemaValidationService(dataSource, sink);

            await service.validate(buildPinnedNow());

            expect(sink.published).toHaveLength(0);
            expect(exitSpy).not.toHaveBeenCalled();
        });

        it('is re-entrant-safe — a second validate() call short-circuits', async () => {
            const sink = new StubAlertSink();
            const queryFn = jest.fn(buildAllPresentResponder());
            const dataSource = { query: queryFn } as unknown as DataSource;
            const service = new SchemaValidationService(dataSource, sink);

            await service.validate(buildPinnedNow());
            const firstCallCount = queryFn.mock.calls.length;

            await service.validate(buildPinnedNow());

            expect(queryFn.mock.calls.length).toBe(firstCallCount);
        });
    });

    describe('missing required table', () => {
        it('emits BOOT_SCHEMA_GATE_FAILED and forces process.exit(1)', async () => {
            const sink = new StubAlertSink();
            const dataSource = buildDataSourceStub(async (query, params) => {
                if (query.includes('information_schema.columns')) {
                    const table = (params?.[0] as string | undefined) ?? '';

                    if (table === 'control_audit') {
                        return [];
                    }

                    const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);

                    return manifestEntry ? buildColumnRows(manifestEntry.requiredColumns) : [];
                }

                return [{ exists: true }];
            });
            const service = new SchemaValidationService(dataSource, sink);

            await expect(service.validate(buildPinnedNow())).rejects.toThrow(/process\.exit\(1\)/);

            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(sink.published).toHaveLength(1);

            const alert = sink.published[0];
            expect(alert.type).toBe(AlertTypeEnum.BOOT_SCHEMA_GATE_FAILED);
            expect(alert.severity).toBe(AlertSeverityEnum.CRITICAL);
            expect(alert.body).toContain('missing table: control_audit');
            expect(alert.data?.failureCount).toBe('1');

            // M9 UX guarantee: the failure body MUST land on stderr before
            // process.exit fires — pino is async-buffered and would otherwise
            // race the exit, hiding the diagnostic from the operator.
            expect(stderrSpy).toHaveBeenCalled();
            const stderrCall = stderrSpy.mock.invocationCallOrder[0];
            const exitCall = exitSpy.mock.invocationCallOrder[0];
            expect(stderrCall).toBeLessThan(exitCall);

            const stderrPayload = String(stderrSpy.mock.calls[0]?.[0] ?? '');
            expect(stderrPayload).toContain('boot.schema.invalid');
            expect(stderrPayload).toContain('missing table: control_audit');
        });
    });

    describe('schema drift — present table missing a required column', () => {
        it('emits BOOT_SCHEMA_GATE_FAILED listing each missing column and exits', async () => {
            const sink = new StubAlertSink();
            const dataSource = buildDataSourceStub(async (query, params) => {
                if (query.includes('information_schema.columns')) {
                    const table = (params?.[0] as string | undefined) ?? '';
                    const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);

                    if (!manifestEntry) {
                        return [];
                    }

                    if (table === 'positions') {
                        // Drop `entry_notional` to simulate a partial migration.
                        const trimmed = manifestEntry.requiredColumns.filter((c) => c !== 'entry_notional');

                        return buildColumnRows(trimmed);
                    }

                    return buildColumnRows(manifestEntry.requiredColumns);
                }

                return [{ exists: true }];
            });
            const service = new SchemaValidationService(dataSource, sink);

            await expect(service.validate(buildPinnedNow())).rejects.toThrow(/process\.exit\(1\)/);

            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(sink.published).toHaveLength(1);
            expect(sink.published[0].body).toContain('table positions: missing required column "entry_notional"');
        });
    });

    describe('missing today partition', () => {
        it('warns but does NOT fail or exit — partition rollover is a deferred mechanism', async () => {
            const sink = new StubAlertSink();
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const dataSource = buildDataSourceStub(async (query, params) => {
                if (query.includes('information_schema.columns')) {
                    const table = (params?.[0] as string | undefined) ?? '';
                    const manifestEntry = REQUIRED_SCHEMA_MANIFEST.find((m) => m.table === table);

                    return manifestEntry ? buildColumnRows(manifestEntry.requiredColumns) : [];
                }

                if (query.includes('to_regclass')) {
                    // Confirm the partition name being checked is the UTC-today stamp.
                    const partitionName = params?.[0] as string | undefined;
                    expect(partitionName).toBe(`${TICK_AGGREGATE_PARTITION_PREFIX}20260524`);

                    return [{ exists: false }];
                }

                return [];
            });
            const service = new SchemaValidationService(dataSource, sink);

            await service.validate(buildPinnedNow());

            expect(exitSpy).not.toHaveBeenCalled();
            expect(sink.published).toHaveLength(0);

            warnSpy.mockRestore();
        });
    });
});
