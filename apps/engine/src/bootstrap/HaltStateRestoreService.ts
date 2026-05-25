import { HaltSourceEnum, IHaltAuditEntry } from '@bot/shared';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { HaltFlagService } from '../common/service/HaltFlagService';
import { HaltService } from '../control/HaltService';
import { ControlAuditRepository } from '../control/repository/ControlAuditRepository';
import { PROGRAMMATIC_ACTOR_PREFIX } from '../control/repository/ControlAuditRepository';
import { RiskStateEntity } from '../risk/entity/RiskStateEntity';
import { RiskStateRepository } from '../risk/repository/RiskStateRepository';

// M9 W3 — PHASE 3 boot pipeline step (ADR 0021 §2.5 + M9 R1 adjudication A).
//
// Position in the lifecycle: AFTER `SchemaValidationService` (PHASE 0, W1) and
// AFTER `AuthModule` is wired (W2), BEFORE `MarketDataModule` starts WS
// subscriptions and BEFORE `EngineBootstrapService` opens the orchestrator
// (PHASE 9). This ordering matters: if the engine crashed mid-halt, we re-
// engage the M0 flag BEFORE any new trigger can reach the gate.
//
// **Newer-wins between two halt sources (Option β SoT split):**
//
//   - `control_audit` is the operator audit log + SoT for operator halts.
//   - `risk_state` (today's UTC-day row) is the SoT for programmatic halts.
//
// Conservative tie-break (M9 R2): risk_state has no `updated_at` column today,
// so we cannot do a true apples-to-apples timestamp comparison between an
// audit row and a programmatic halt landed at some unknown wall-clock instant
// within the UTC day. Using `startOfUtcDay(risk_state.date)` as the
// programmatic timestamp would let ANY audit row written today win over an
// otherwise-fresh programmatic halt (e.g. an audit RESUME at 00:00:01 would
// override a programmatic HALT persisted at 23:59:00 the same day).
//
// Until M11 adds `risk_state.updated_at`, we apply a "halt wins" tie-break for
// the survival-first bot: audit can override risk_state ONLY when audit
// itself says HALTED. If audit says RUNNING but risk_state today says HALTED,
// we keep the halt. The asymmetry is intentional — a stale-RUNNING audit
// being wrong is recoverable (operator clicks resume); a stale-RUNNING
// restore that wipes a programmatic halt is not.
//
// TODO M11: once `risk_state.updated_at` lands (ADR follow-up), replace this
// tie-break with a true timestamp comparison and treat audit-newer as winning
// regardless of newState — the same way it does today when audit is HALTED.
//
// Restore rules:
//
//   1. If audit row is HALTED and its `occurredAt >= startOfRiskStateDay` →
//      audit wins (operator action today is the freshest source).
//   2. If audit row is HALTED but older than today's UTC-day start AND
//      risk_state today is HALTED → risk_state wins (programmatic halt
//      persisted today is newer than the older operator action).
//   3. If audit row is RUNNING (any timestamp) AND risk_state today is HALTED
//      → risk_state wins (halt-wins tie-break — see note above).
//   4. If audit row is RUNNING and risk_state today is RUNNING (or absent) →
//      RUNNING.
//   5. No audit row at all → risk_state alone decides.
//
// Symmetric clear: if the newer-wins source says RUNNING and the in-memory
// flag is currently HALTED (e.g., a stale in-process flag from a previous
// boot phase), we clear the flag. Logged at warn so the resolution is
// auditable.
//
// `onApplicationBootstrap` is idempotent: a second call short-circuits via
// `restored` — tests booting the module twice get one restore.

@Injectable()
export class HaltStateRestoreService implements OnApplicationBootstrap {
    private readonly logger = new Logger(HaltStateRestoreService.name);

    private restored = false;

    constructor(
        private readonly auditRepo: ControlAuditRepository,
        private readonly haltService: HaltService,
        private readonly haltFlag: HaltFlagService,
        private readonly riskStateRepo: RiskStateRepository,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.restore();
    }

    // Public for tests + future replay paths.
    async restore(): Promise<void> {

        if (this.restored) {
            return;
        }

        const todayUtc = toUtcDateString(new Date());
        const [latestAudit, todayRiskState] = await Promise.all([
            this.auditRepo.findLatest(),
            this.riskStateRepo.findByDate(todayUtc),
        ]);

        const resolution = this.resolveNewerWins(latestAudit, todayRiskState);

        this.restored = true;
        this.applyResolution(resolution, latestAudit);
    }

    private resolveNewerWins(
        latestAudit: IHaltAuditEntry | null,
        todayRiskState: RiskStateEntity | null,
    ): IRestoreResolution {
        const riskHalted = todayRiskState !== null && todayRiskState.isHalted === true;
        const riskReason = todayRiskState?.haltReason ?? null;

        // No audit row at all → risk_state alone decides.
        if (latestAudit === null) {

            if (riskHalted) {
                return {
                    desiredHalted: true,
                    source: resolveProgrammaticSource(riskReason),
                    reason: riskReason ?? 'programmatic',
                    origin: 'risk_state',
                };
            }

            return { desiredHalted: false, source: HaltSourceEnum.OPERATOR, reason: null, origin: 'empty' };
        }

        // We have an audit row. Compare to the risk-state UTC-day boundary.
        const auditOccurredAt = new Date(latestAudit.occurredAt);
        const startOfRiskDayMs = todayRiskState === null ? 0 : startOfUtcDayMs(todayRiskState.date);
        const auditNewerThanRiskState = auditOccurredAt.getTime() >= startOfRiskDayMs;
        const auditSaysHalted = latestAudit.newState === 'halted';

        // Halt-wins tie-break (see header note): audit may override risk_state
        // ONLY when audit itself is HALTED. A RUNNING audit can never win over
        // a HALTED risk_state today — survival-first preference until M11's
        // `risk_state.updated_at` enables a true newer-wins comparison.
        if (riskHalted && !auditSaysHalted) {
            return {
                desiredHalted: true,
                source: resolveProgrammaticSource(riskReason),
                reason: riskReason ?? latestAudit.reason,
                origin: 'risk_state',
            };
        }

        if (auditNewerThanRiskState || !riskHalted) {
            // Audit wins (audit-HALTED fresher than the UTC-day start, or
            // risk_state is RUNNING so audit is the only halt evidence — the
            // RUNNING/RUNNING and stale-but-only-evidence cases also land here).
            const source = resolveSourceFromActor(latestAudit.actorSub);

            return {
                desiredHalted: auditSaysHalted,
                source,
                reason: latestAudit.reason,
                origin: 'control_audit',
            };
        }

        // risk_state HALTED today, and the latest audit row is older than
        // today's start → programmatic halt is the newer state.
        return {
            desiredHalted: true,
            source: resolveProgrammaticSource(riskReason),
            reason: riskReason ?? latestAudit.reason,
            origin: 'risk_state',
        };
    }

    private applyResolution(resolution: IRestoreResolution, latestAudit: IHaltAuditEntry | null): void {
        // Hand `lastTransition` to HaltService so `getState()` keeps reporting
        // the most-recent audit row even when risk_state is the SoT for halt.
        this.haltService.restoreFromAudit(latestAudit, resolution.source);

        const flagHalted = this.haltFlag.isHalted();

        if (resolution.desiredHalted && !flagHalted) {
            this.haltFlag.halt(`${resolution.source}:${resolution.reason ?? 'restored'}`);
            this.logger.warn(
                `halt.restored state=halted source=${resolution.source} origin=${resolution.origin} reason=${resolution.reason ?? ''}`,
            );

            return;
        }

        if (!resolution.desiredHalted && flagHalted) {
            // Symmetric clear: newer source says RUNNING but the in-process
            // flag is stale-halted. Resolve in favour of the SoT.
            this.haltFlag.resume();
            this.logger.warn(`halt.restored state=running origin=${resolution.origin} (cleared stale in-memory halt flag)`);

            return;
        }

        if (resolution.desiredHalted && flagHalted) {
            this.logger.warn(
                `halt.restored state=halted source=${resolution.source} origin=${resolution.origin} (flag already engaged)`,
            );

            return;
        }

        this.logger.log(`halt.restored state=running origin=${resolution.origin}`);
    }
}

interface IRestoreResolution {
    desiredHalted: boolean;
    source: HaltSourceEnum;
    reason: string | null;
    origin: 'control_audit' | 'risk_state' | 'empty';
}

// `actor_sub` is either a real subject (`'operator-1'`) or the programmatic
// sentinel (`'SYSTEM:<source>'`). Map the latter back to its `HaltSourceEnum`.
// Unknown / unparsable falls back to OPERATOR — the safer default for a row
// whose origin we can't classify.
function resolveSourceFromActor(actorSub: string): HaltSourceEnum {

    if (!actorSub.startsWith(PROGRAMMATIC_ACTOR_PREFIX)) {
        return HaltSourceEnum.OPERATOR;
    }

    const tail = actorSub.slice(PROGRAMMATIC_ACTOR_PREFIX.length);
    const known = (Object.values(HaltSourceEnum) as string[]).find((value) => value === tail);

    if (known === undefined) {
        return HaltSourceEnum.OTHER;
    }

    return known as HaltSourceEnum;
}

// risk_state's `halt_reason` is set by `RiskGateService.persistHalt` with a
// `<SOURCE>:<reason>` prefix (mirroring the in-memory flag). We extract the
// leading enum-shaped token; anything we can't classify maps to OTHER.
function resolveProgrammaticSource(haltReason: string | null): HaltSourceEnum {

    if (haltReason === null || haltReason.length === 0) {
        return HaltSourceEnum.OTHER;
    }

    const sepIndex = haltReason.indexOf(':');
    const prefix = sepIndex < 0 ? haltReason : haltReason.slice(0, sepIndex);
    const known = (Object.values(HaltSourceEnum) as string[]).find((value) => value === prefix);

    if (known === undefined) {
        return HaltSourceEnum.OTHER;
    }

    return known as HaltSourceEnum;
}

function toUtcDateString(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function startOfUtcDayMs(dateString: string): number {
    return new Date(`${dateString}T00:00:00.000Z`).getTime();
}
