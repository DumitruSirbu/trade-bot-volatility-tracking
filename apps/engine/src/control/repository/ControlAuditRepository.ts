import { HaltAuditActionEnum, HaltSourceEnum, IHaltAuditEntry } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CursorCodec } from '../../read-api/pagination/CursorCodec';
import { HALT_HISTORY_PAGE_SIZE_DEFAULT, HALT_HISTORY_PAGE_SIZE_MAX, HALT_REASON_MAX_LEN, LOGIN_AUDIT_TIMEOUT_MS } from '../const/controlConsts';
import { ControlAuditEntity, ControlAuditActionDb } from '../entity/ControlAuditEntity';

// M9 W3 (ADR 0021 §2.3). Repository for the append-only `control_audit` table.
//
// Two write paths share this surface:
//   1. operator-driven `POST /v1/control/halt` / `/resume` (HaltController →
//      HaltService),
//   2. programmatic halts from M4 (market-stress, model-divergence, loss windows)
//      — wired in W6, but the entry-point `appendProgrammatic` is exposed here
//      so the contract is stable.
//
// Read path: `findLatest` for HaltStateRestoreService (PHASE 3 boot pipeline),
// `findHistoryPage` for `GET /v1/control/halt/history` (cursor-paginated).
//
// Per code-conventions §4: methods are intention-revealing, no leaking
// `Repository<T>` to callers, mappers translate persistence enums (UPPERCASE)
// to shared lowercase literals.

// Sentinel actor prefix used when a programmatic halt source writes a row
// (ADR 0021 §2.3). The `sub` is rendered as `SYSTEM:<source>` so the audit
// log shows whether the halt was operator-driven or auto-engaged.
export const PROGRAMMATIC_ACTOR_PREFIX = 'SYSTEM:';
export const PROGRAMMATIC_JTI = 'SYSTEM';

export interface IAppendOperatorParams {
    occurredAt: Date;
    actorSub: string;
    actorJti: string;
    sourceIp: string | null;
    action: 'HALT' | 'RESUME';
    reason: string;
    flattenRequested: boolean;
    previousState: 'RUNNING' | 'HALTED';
    newState: 'RUNNING' | 'HALTED';
}

export interface IAppendProgrammaticParams {
    occurredAt: Date;
    source: HaltSourceEnum;
    correlationEventId: string | null;
    reason: string;
    flattenRequested: boolean;
    previousState: 'RUNNING' | 'HALTED';
    newState: 'RUNNING' | 'HALTED';
}

// M10 W0.5 (ADR 0027 §2.5). Login attempts share the `control_audit` table.
// `action` widens to LOGIN_SUCCESS | LOGIN_FAILURE | LOGIN_THROTTLED;
// previous/new state are unchanged by login (audit captures the operating
// mode at attempt time, not a transition).
export interface IAppendLoginAuditParams {
    occurredAt: Date;
    action: HaltAuditActionEnum.LOGIN_SUCCESS | HaltAuditActionEnum.LOGIN_FAILURE | HaltAuditActionEnum.LOGIN_THROTTLED;
    sourceIp: string | null;
    actorSub: string | null; // null on failure/throttle → sentinel 'unknown'
    actorJti: string | null; // null on failure/throttle → empty string
    reason: string; // 'login' | 'BAD_SECRET' | 'MALFORMED' | 'TOO_MANY_LOGIN_ATTEMPTS'
    previousState: 'RUNNING' | 'HALTED';
}

// M11a W1.2 (ADR 0028 §2.5). Key-permission assertion outcomes share the
// `control_audit` table. `reason` carries a comma-separated list of failing
// clause NAMES (never values); the redacted snapshot rides through the
// optional `snapshotRedacted` field (serialised into the `reason` text per
// ADR §2.5 — the existing schema has no JSONB column on control_audit, so
// the snapshot is appended to the reason string within HALT_REASON_MAX_LEN).
export interface IAppendKeyPermissionAuditParams {
    occurredAt: Date;
    action: HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED | HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_SKIPPED;
    reason: string;
    previousState: 'RUNNING' | 'HALTED';
}

// M11a W1.4 (ADR 0030 §2.6.2). The rate-limit policy writes one of these when
// the freeze window expires without a further 429/418; the row's `new_state`
// is RUNNING and the previous state is HALTED (the engage row was already
// written through `appendProgrammatic` with source=RATE_LIMIT). Actor is the
// SYSTEM:RATE_LIMIT sentinel, source IP is null (no request boundary).
export interface IAppendRateLimitAutoClearedParams {
    occurredAt: Date;
    reason: string;
    correlationEventId: string | null;
}

@Injectable()
export class ControlAuditRepository {
    // Repository is exposed read-only to the methods below; the @InjectRepository
    // wiring (vs the previous DataSource.getRepository call) follows the
    // project-wide repository pattern used by every other module-owned repo.
    //
    // CursorCodec is injected (R1 wave #6, architect D): the audit-history
    // page cursor MUST ride the single MAC-bound codec used by the rest of the
    // read API. The prior plaintext base64 path let a client forge a cursor
    // pointing at arbitrary (occurredAt, id) pairs.
    constructor(
        @InjectRepository(ControlAuditEntity) private readonly repository: Repository<ControlAuditEntity>,
        private readonly cursors: CursorCodec,
    ) {}

    async appendOperator(params: IAppendOperatorParams): Promise<IHaltAuditEntry> {
        const row = this.repository.create({
            occurredAt: params.occurredAt,
            actorSub: params.actorSub,
            actorJti: params.actorJti,
            sourceIp: params.sourceIp,
            action: params.action,
            reason: truncateReason(params.reason),
            flattenRequested: params.flattenRequested,
            previousState: params.previousState,
            newState: params.newState,
            correlationEventId: null,
        });

        const saved = await this.repository.save(row);

        return toAuditEntry(saved);
    }

    async appendProgrammatic(params: IAppendProgrammaticParams): Promise<IHaltAuditEntry> {
        const row = this.repository.create({
            occurredAt: params.occurredAt,
            actorSub: `${PROGRAMMATIC_ACTOR_PREFIX}${params.source}`,
            actorJti: PROGRAMMATIC_JTI,
            sourceIp: null,
            action: params.newState === 'HALTED' ? 'HALT' : 'RESUME',
            reason: truncateReason(params.reason),
            flattenRequested: params.flattenRequested,
            previousState: params.previousState,
            newState: params.newState,
            correlationEventId: params.correlationEventId,
        });

        const saved = await this.repository.save(row);

        return toAuditEntry(saved);
    }

    async appendLoginAudit(params: IAppendLoginAuditParams): Promise<IHaltAuditEntry> {
        // Login is not a halt-state transition — previous_state === new_state.
        // Sentinels for failed/throttled attempts per ADR 0027 §2.5.
        const dbAction: ControlAuditActionDb = mapLoginActionToDb(params.action);
        const row = this.repository.create({
            occurredAt: params.occurredAt,
            actorSub: params.actorSub ?? 'unknown',
            actorJti: params.actorJti ?? '',
            sourceIp: params.sourceIp,
            action: dbAction,
            reason: truncateReason(params.reason),
            flattenRequested: false,
            previousState: params.previousState,
            newState: params.previousState,
            correlationEventId: null,
        });

        // M10 R1 #3 (Security HIGH) — bounded by LOGIN_AUDIT_TIMEOUT_MS. A
        // slow / wedged DB pool would otherwise stretch login latency
        // arbitrarily while the rate-limit window advanced, letting an
        // attacker amplify their effective probe rate. On timeout we throw a
        // typed error; the AuthController already wraps appendLoginAudit in
        // try/catch and continues per ADR 0027 §2.5 best-effort semantics, so
        // the controller boundary is unchanged — only the worst-case latency.
        const saved = await raceWithTimeout(this.repository.save(row), LOGIN_AUDIT_TIMEOUT_MS, 'control_audit.appendLoginAudit');

        return toAuditEntry(saved);
    }

    // M11a W1.2 (ADR 0028 §2.5). Boot-time row written before `process.exit(1)`
    // (FAILED) or right after the TESTNET exemption logs (SKIPPED). Actor is
    // fixed to 'system' per ADR; source IP is null (boot has no request).
    // Best-effort under boot-time DB unreachability — the caller still exits
    // even if this write fails (the Telegram alert is the ultimate fallback).
    async appendKeyPermissionAudit(params: IAppendKeyPermissionAuditParams): Promise<IHaltAuditEntry> {
        const dbAction: ControlAuditActionDb =
            params.action === HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED ? 'KEY_PERMISSION_ASSERTION_FAILED' : 'KEY_PERMISSION_ASSERTION_SKIPPED';
        const row = this.repository.create({
            occurredAt: params.occurredAt,
            actorSub: 'system',
            actorJti: 'SYSTEM',
            sourceIp: null,
            action: dbAction,
            reason: truncateReason(params.reason),
            flattenRequested: false,
            previousState: params.previousState,
            newState: params.previousState,
            correlationEventId: null,
        });

        const saved = await this.repository.save(row);

        return toAuditEntry(saved);
    }

    async appendRateLimitAutoCleared(params: IAppendRateLimitAutoClearedParams): Promise<IHaltAuditEntry> {
        const row = this.repository.create({
            occurredAt: params.occurredAt,
            actorSub: `${PROGRAMMATIC_ACTOR_PREFIX}${HaltSourceEnum.RATE_LIMIT}`,
            actorJti: PROGRAMMATIC_JTI,
            sourceIp: null,
            action: 'RATE_LIMIT_HALT_AUTO_CLEARED',
            reason: truncateReason(params.reason),
            flattenRequested: false,
            previousState: 'HALTED',
            newState: 'RUNNING',
            correlationEventId: params.correlationEventId,
        });

        const saved = await this.repository.save(row);

        return toAuditEntry(saved);
    }

    async findLatest(): Promise<IHaltAuditEntry | null> {
        const row = await this.repository.findOne({
            where: {},
            order: { occurredAt: 'DESC' },
        });

        if (row === null) {
            return null;
        }

        return toAuditEntry(row);
    }

    // Cursor encodes `(occurredAt, controlAuditId)` via the shared CursorCodec
    // (HMAC-bound). Page is ordered by `(occurredAt DESC, id DESC)` to match
    // the index. A tampered / malformed cursor decodes to null — the caller
    // gets page 1 instead of a 4xx (matches the read-API's forgiving cursor
    // semantics in ADR 0022 §2.5).
    async findHistoryPage(
        rawCursor: string | null,
        rawPageSize: number | null,
    ): Promise<{ items: IHaltAuditEntry[]; nextCursor: string | null; pageSize: number }> {
        const pageSize = clampPageSize(rawPageSize);
        const cursor = this.cursors.decode(rawCursor);

        const qb = this.repository
            .createQueryBuilder('a')
            .orderBy('a.occurred_at', 'DESC')
            .addOrderBy('a.control_audit_id', 'DESC')
            .limit(pageSize + 1);

        if (cursor !== null && typeof cursor.id === 'string') {
            qb.where('(a.occurred_at, a.control_audit_id) < (:ts, :id)', {
                ts: cursor.ts,
                id: cursor.id,
            });
        }

        const rows = await qb.getMany();
        const items = rows.slice(0, pageSize).map(toAuditEntry);

        let nextCursor: string | null = null;

        if (rows.length > pageSize) {
            const last = rows[pageSize - 1];
            nextCursor = this.cursors.encode({ id: last.controlAuditId, ts: last.occurredAt });
        }

        return { items, nextCursor, pageSize };
    }
}

function truncateReason(raw: string): string {
    if (raw.length <= HALT_REASON_MAX_LEN) {
        return raw;
    }

    return raw.slice(0, HALT_REASON_MAX_LEN);
}

function clampPageSize(raw: number | null): number {
    if (raw === null || !Number.isFinite(raw) || raw <= 0) {
        return HALT_HISTORY_PAGE_SIZE_DEFAULT;
    }

    return Math.min(Math.floor(raw), HALT_HISTORY_PAGE_SIZE_MAX);
}

function toAuditEntry(row: ControlAuditEntity): IHaltAuditEntry {
    return {
        id: row.controlAuditId,
        occurredAt: row.occurredAt.toISOString(),
        actorSub: row.actorSub,
        actorJti: row.actorJti,
        sourceIp: row.sourceIp,
        action: mapDbActionToEnum(row.action),
        reason: row.reason,
        flattenRequested: row.flattenRequested,
        previousState: row.previousState === 'HALTED' ? 'halted' : 'running',
        newState: row.newState === 'HALTED' ? 'halted' : 'running',
        correlationEventId: row.correlationEventId,
    };
}

function mapDbActionToEnum(action: ControlAuditActionDb): HaltAuditActionEnum {
    switch (action) {
        case 'HALT':
            return HaltAuditActionEnum.HALT;
        case 'RESUME':
            return HaltAuditActionEnum.RESUME;
        case 'LOGIN_SUCCESS':
            return HaltAuditActionEnum.LOGIN_SUCCESS;
        case 'LOGIN_FAILURE':
            return HaltAuditActionEnum.LOGIN_FAILURE;
        case 'LOGIN_THROTTLED':
            return HaltAuditActionEnum.LOGIN_THROTTLED;
        case 'KEY_PERMISSION_ASSERTION_FAILED':
            return HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_FAILED;
        case 'KEY_PERMISSION_ASSERTION_SKIPPED':
            return HaltAuditActionEnum.KEY_PERMISSION_ASSERTION_SKIPPED;
        case 'RATE_LIMIT_HALT_AUTO_CLEARED':
            return HaltAuditActionEnum.RATE_LIMIT_HALT_AUTO_CLEARED;
    }
}

function mapLoginActionToDb(
    action: HaltAuditActionEnum.LOGIN_SUCCESS | HaltAuditActionEnum.LOGIN_FAILURE | HaltAuditActionEnum.LOGIN_THROTTLED,
): ControlAuditActionDb {
    if (action === HaltAuditActionEnum.LOGIN_SUCCESS) {
        return 'LOGIN_SUCCESS';
    }

    if (action === HaltAuditActionEnum.LOGIN_FAILURE) {
        return 'LOGIN_FAILURE';
    }

    return 'LOGIN_THROTTLED';
}

// M10 R1 #3 — bound a promise by ms; reject with a typed Error on expiry. The
// underlying op continues (we don't AbortController the TypeORM save) but the
// caller is unblocked. `.unref()` keeps the timer from holding the event loop.
async function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    });

    try {
        return await Promise.race([p, timeout]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
