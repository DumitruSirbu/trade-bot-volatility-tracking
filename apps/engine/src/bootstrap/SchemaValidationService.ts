import { AlertSeverityEnum, AlertTypeEnum, IAlertPayload } from '@bot/shared';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ALERT_SINK, IAlertSink } from '../alert/sink/AlertSinkModule';
import { TICK_AGGREGATE_PARTITION_PREFIX, TICK_AGGREGATE_TABLE } from '../market-data/const';

// M9 W1 — PHASE 0 startup schema-validation gate (ADR 0025).
//
// Runs before any persistence-using module starts producing or consuming work.
// On a hard fail (missing table OR missing required column): emits a
// `BOOT_SCHEMA_GATE_FAILED` critical alert through the always-wired
// `IAlertSink`, logs the manifest delta, and forces `process.exit(1)`. There is
// no "degraded" mode — refusing to boot is the conservative choice.
//
// The "today's partition exists on tick_aggregates" check (ADR 0025 §2.2 step
// 4) is a WARN, not a hard fail: partition rollover is its own deferred
// mechanism and a missing partition is a recoverable operational concern.
//
// Re-entrant-safe: the cached result short-circuits a second
// `onModuleInit` call (e.g. in tests that boot the module twice).
//
// Lifecycle choice — `OnModuleInit` (not `OnApplicationBootstrap`): NestJS
// dispatches every `OnModuleInit` callback strictly before any
// `OnApplicationBootstrap` callback, regardless of which module declared the
// provider. That global ordering is what lets the schema gate run before
// `BootModeChainService.onApplicationBootstrap` (declared in
// `BootModeHistoryModule`, which `BootstrapModule` imports — so its hooks
// would otherwise fire first inside the AppBootstrap phase).

export interface IRequiredTable {
    readonly table: string;
    readonly requiredColumns: ReadonlyArray<string>;
}

// Manifest enumerated against the migrations actually present in the engine
// (the CREATE-TABLE catalogue + the new `control_audit`). Column lists are the
// minimal contract the gate enforces — NOT the full schema. ADR 0025 §2.2
// keeps the gate cheap: presence-only, no type checks (migration drift catches
// that already).
//
// NOTE on tables NOT listed: M5 fills/orders and M6 position_events do not
// exist as tables in this codebase — fills live in `transactions`; orders are
// in-memory (client-order-id keyed); position state transitions are in-memory
// in the state-machine layer with the durable representation in `positions`.
// The manifest reflects the actual M2–M8 schema, not the conceptual M9 brief.
export const REQUIRED_SCHEMA_MANIFEST: ReadonlyArray<IRequiredTable> = [
    { table: 'instruments', requiredColumns: ['instruments_id', 'symbol', 'coin_tier', 'is_tradable'] },
    { table: 'candles', requiredColumns: ['candles_id', 'symbol', 'interval', 'open_time', 'close'] },
    { table: 'tick_aggregates', requiredColumns: ['tick_aggregates_id', 'symbol', 'ts', 'open', 'high', 'low', 'close'] },
    { table: 'open_interest', requiredColumns: ['symbol', 'ts'] },
    // M9 boot-blocker fix: actual M2 column is `rate` (numeric(18,10)),
    // not `funding_rate`. The manifest must reflect migration truth.
    { table: 'funding_rates', requiredColumns: ['symbol', 'funding_time', 'rate'] },
    { table: 'book_snapshots', requiredColumns: ['symbol', 'ts'] },
    { table: 'universe_membership', requiredColumns: ['symbol', 'entered_at'] },
    { table: 'strategy_versions', requiredColumns: ['strategy_versions_id', 'name', 'status'] },
    { table: 'positions', requiredColumns: ['positions_id', 'symbol', 'side', 'state', 'entry_price', 'entry_notional'] },
    // M9 boot-blocker fix: `transactions` does not carry `symbol` — the
    // symbol is resolved via the `position_id` FK to `positions`. Use the
    // FK column as the canary instead.
    { table: 'transactions', requiredColumns: ['transactions_id', 'position_id', 'type'] },
    { table: 'decisions', requiredColumns: ['decisions_id', 'event_id', 'strategy_version_id', 'ts'] },
    // M9 boot-blocker fix: `updated_at` does not exist on `risk_state`
    // today (M11 follow-up will add it for newer-wins resolution per R2).
    // Use `is_halted` as the canary — it is the daily-loss-window flag
    // that must always be present.
    { table: 'risk_state', requiredColumns: ['risk_state_id', 'date', 'is_halted'] },
    { table: 'account_snapshots', requiredColumns: ['account_snapshots_id', 'ts', 'balance', 'equity'] },
    { table: 'control_audit', requiredColumns: ['control_audit_id', 'occurred_at', 'actor_sub', 'action', 'new_state'] },
    { table: 'revoked_jti', requiredColumns: ['jti', 'revoked_at', 'revoked_by'] },
    // Persisted LoginRateLimiter state. Boot fails if the table is missing so
    // a restart cannot silently re-open the brute-force window.
    { table: 'login_rate_limit_state', requiredColumns: ['source_ip', 'scope', 'timestamps_ms', 'updated_at'] },
    // Boot-mode HMAC chain (ADR 0032 §D6 / §D7). Boot fails if
    // either table is missing because BootModeChainService cannot verify
    // chain integrity (security-critical predicate per ADR 0032).
    {
        table: 'boot_mode_history',
        requiredColumns: ['boot_mode_history_id', 'seq', 'booted_at', 'row_kind', 'exchange_env', 'this_row_hmac'],
    },
    {
        table: 'boot_mode_chain_rotations',
        requiredColumns: ['boot_mode_chain_rotation_id', 'seq', 'rotated_at', 'from_env', 'to_env', 'pre_tip_hash', 'transition_token_hash', 'this_row_hmac'],
    },
    // M11a R2b wave A — PAPER persistence tables (ADR 0032 §5). A missing
    // table here means PAPER mode cannot persist position / equity state;
    // boot must fail rather than start a soak that silently loses data.
    {
        table: 'paper_account_state',
        requiredColumns: ['paper_account_state_id', 'client_order_id', 'symbol', 'side', 'entry_price', 'size', 'leverage', 'opened_at', 'mode'],
    },
    {
        table: 'paper_account_state_history',
        requiredColumns: [
            'paper_account_state_history_id',
            'client_order_id',
            'symbol',
            'side',
            'entry_price',
            'exit_price',
            'size',
            'realised_pnl',
            'fees',
            'funding_accrued',
            'slippage',
            'close_reason',
            'opened_at',
            'closed_at',
            'mode',
        ],
    },
    {
        table: 'paper_account_state_meta',
        requiredColumns: [
            'paper_account_state_meta_id',
            'soak_start_id',
            'soak_start_ts',
            'seed_version_label',
            'hkdf_info_version',
            'simulator_config_hash',
            'bootstrap_at_start_fingerprint',
        ],
    },
    {
        table: 'paper_account_snapshots',
        requiredColumns: [
            'paper_account_snapshot_id',
            'taken_at',
            'balance',
            'equity',
            'realised_pnl_cumulative',
            'funding_accrued_cumulative',
            'unrealised_pnl_total',
            'peak_equity',
            'open_positions_count',
            'mode',
        ],
    },
    {
        table: 'paper_simulator_idempotency',
        requiredColumns: ['paper_simulator_idempotency_id', 'event_id', 'order_intent_id', 'version_namespace', 'simulated_fill_id', 'simulated_fill_payload'],
    },
];

export const SCHEMA_GATE_TITLE = 'Engine refused to boot: schema gate failed';

const PARTITION_DATE_FORMAT_LENGTH = 8;

@Injectable()
export class SchemaValidationService implements OnModuleInit {
    private readonly logger = new Logger(SchemaValidationService.name);

    private cachedOutcome: 'pending' | 'passed' | 'failed' = 'pending';

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @Inject(ALERT_SINK) private readonly alerts: IAlertSink,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.validate(new Date());
    }

    // M9 W4 — expose the cached outcome for `GET /v1/health` so the read-API's
    // HealthController can surface `schemaValid` without re-running the gate.
    // Mapping: 'passed' → true; 'failed'/'pending' → false. (A 'pending' value
    // means the gate has not run yet — the safer answer is `false` because we
    // cannot prove the schema is valid.)
    lastValidationResult(): boolean {
        return this.cachedOutcome === 'passed';
    }

    // Public for tests + future replay paths. `now` is the boundary clock read
    // so adversarial tests can pin the "today's partition" check
    // deterministically.
    async validate(now: Date): Promise<void> {
        if (this.cachedOutcome === 'passed') {
            return;
        }

        if (this.cachedOutcome === 'failed') {
            // R1 fix wave #6 (L7): a prior validate() call already failed the
            // gate. In production `process.exit(1)` terminated the process;
            // in test harnesses that catch / stub `process.exit`, the second
            // call must still surface the failure rather than silently
            // returning void (which would let a re-entrant boot pretend the
            // schema was valid).
            throw new Error('schema gate previously failed — engine refused to boot');
        }

        const failures = await this.collectHardFailures();

        if (failures.length > 0) {
            await this.failHard(failures);

            return;
        }

        await this.checkTodayPartitionWarn(now);

        this.cachedOutcome = 'passed';
        this.logger.log(`schema gate PASSED — ${REQUIRED_SCHEMA_MANIFEST.length} tables verified`);
    }

    private async collectHardFailures(): Promise<ReadonlyArray<string>> {
        const failures: string[] = [];

        for (const required of REQUIRED_SCHEMA_MANIFEST) {
            const existingColumns = await this.fetchColumnSet(required.table);

            if (existingColumns === null) {
                failures.push(`missing table: ${required.table}`);
                continue;
            }

            for (const column of required.requiredColumns) {
                if (!existingColumns.has(column)) {
                    failures.push(`table ${required.table}: missing required column "${column}"`);
                }
            }
        }

        return failures;
    }

    private async fetchColumnSet(table: string): Promise<Set<string> | null> {
        const rows: Array<{ column_name: string }> = await this.dataSource.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
            [table],
        );

        if (rows.length === 0) {
            return null;
        }

        return new Set(rows.map((row) => row.column_name));
    }

    private async checkTodayPartitionWarn(now: Date): Promise<void> {
        const partitionName = this.buildPartitionName(now);
        const rows: Array<{ exists: boolean }> = await this.dataSource.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [partitionName]);

        const present = rows[0]?.exists === true;

        if (present) {
            return;
        }

        this.logger.warn(
            `schema gate WARN — ${TICK_AGGREGATE_TABLE} partition for today (${partitionName}) is missing; ` +
                `partition rollover is a deferred mechanism, boot continues`,
        );
    }

    private buildPartitionName(now: Date): string {
        const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
        const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
        const dd = now.getUTCDate().toString().padStart(2, '0');
        const stamp = `${yyyy}${mm}${dd}`;

        if (stamp.length !== PARTITION_DATE_FORMAT_LENGTH) {
            throw new Error(`schema gate: bad UTC date stamp "${stamp}"`);
        }

        return `${TICK_AGGREGATE_PARTITION_PREFIX}${stamp}`;
    }

    private async failHard(failures: ReadonlyArray<string>): Promise<void> {
        this.cachedOutcome = 'failed';

        const body = failures.map((line) => `  - ${line}`).join('\n');
        this.logger.error(`boot.schema.invalid — ${failures.length} issue(s):\n${body}`);

        const payload: IAlertPayload = {
            type: AlertTypeEnum.BOOT_SCHEMA_GATE_FAILED,
            severity: AlertSeverityEnum.CRITICAL,
            occurredAt: new Date().toISOString(),
            title: SCHEMA_GATE_TITLE,
            body,
            data: { failureCount: failures.length.toString() },
        };

        try {
            await this.alerts.publish(payload);
        } catch (cause) {
            this.logger.error(`alert sink publish failed during schema-gate halt: ${this.describe(cause)}`);
        }

        // M9 UX fix: pino is async-buffered, so a logger.error followed by
        // process.exit(1) can race and the operator sees an empty container
        // log. Flush the formatted failure body to stderr synchronously
        // BEFORE exit so the diagnostic is always observable.
        process.stderr.write(`boot.schema.invalid — ${failures.length} issue(s):\n${body}\n`);

        // ADR 0025 §2.3: hard exit. No partial-boot mode. Container restart
        // policy decides recovery. The only `process.exit` call in the
        // engine — every other failure path throws so NestJS can surface a
        // stack trace and exit naturally.
        process.exit(1);
    }

    private describe(cause: unknown): string {
        if (cause instanceof Error) {
            return `${cause.name}: ${cause.message}`;
        }

        return String(cause);
    }
}
