import { HaltSourceEnum, IHaltAuditEntry } from '@bot/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CursorCodec } from '../../read-api/pagination/CursorCodec';
import { HALT_HISTORY_PAGE_SIZE_DEFAULT, HALT_HISTORY_PAGE_SIZE_MAX, HALT_REASON_MAX_LEN } from '../const/controlConsts';
import { ControlAuditEntity } from '../entity/ControlAuditEntity';

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
    async findHistoryPage(rawCursor: string | null, rawPageSize: number | null): Promise<{ items: IHaltAuditEntry[]; nextCursor: string | null; pageSize: number }> {
        const pageSize = clampPageSize(rawPageSize);
        const cursor = this.cursors.decode(rawCursor);

        const qb = this.repository.createQueryBuilder('a').orderBy('a.occurred_at', 'DESC').addOrderBy('a.control_audit_id', 'DESC').limit(pageSize + 1);

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
        action: row.action === 'HALT' ? 'halt' : 'resume',
        reason: row.reason,
        flattenRequested: row.flattenRequested,
        previousState: row.previousState === 'HALTED' ? 'halted' : 'running',
        newState: row.newState === 'HALTED' ? 'halted' : 'running',
        correlationEventId: row.correlationEventId,
    };
}
