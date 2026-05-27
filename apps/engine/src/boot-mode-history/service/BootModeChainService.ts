import { ExchangeEnvironmentEnum } from '@bot/shared';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { bufferEquals } from '../../common/utils';
import { AppConfigService } from '../../config/service';
import {
    BOOT_MODE_HISTORY_ADVISORY_LOCK_KEY,
    BOOT_MODE_HISTORY_SECURITY_EXIT_CODE,
    CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS,
    CHAIN_NAME_BOOT_MODE_HISTORY,
    HKDF_INFO_BOOT_MODE_CHAIN_ROTATIONS,
    HKDF_INFO_BOOT_MODE_HISTORY,
    TRANSITION_ENV_VARS,
    TransitionTokenFileEnvName,
    TransitionTokenHashEnvName,
} from '../const';
import { BootModeHistoryRowKindEnum } from '../enum';
import { BootModeChainAbortException } from '../exception';
import { BootModeChainRotationRepository } from '../repository/BootModeChainRotationRepository';
import { BootModeHistoryRepository } from '../repository/BootModeHistoryRepository';
import { BootModeHmacCodec } from './BootModeHmacCodec';
import { BootstrapSubkeyDeriver } from './BootstrapSubkeyDeriver';
import { TransitionTokenVerifier } from './TransitionTokenVerifier';

// Implements ADR 0032 §D6 / §D7 verbatim:
//
//   1. Load config (EXCHANGE_ENV).
//   2. Open a single boot transaction, take a Postgres advisory lock so two
//      engines cold-starting concurrently cannot race on the chain tip.
//   3. Inside the locked transaction: verify boot_mode_history chain
//      integrity (HMAC walk from row 0) AND boot_mode_chain_rotations chain
//      integrity (HMAC walk from row 0).
//   4. Chain broken on either chain → ABORT with the security exit code.
//   5. Read chain tip's exchange_env (inside the same transaction).
//   6. tip.exchange_env === EXCHANGE_ENV → append BOOT row, commit.
//   7. Else (mode mismatch) → check D7 transition matrix, verify token, then
//      append TRANSITION row + BOOT row + rotation row, commit.
//
// CRITICAL: every verification + tip read + append runs inside the SAME
// transaction the advisory lock guards. An earlier split (lock per append)
// allowed two concurrent boots to read the same tip before either appended,
// producing a chain fork that bricked subsequent boots. The single-transaction
// shape is the only one that satisfies §D6's "no concurrent fork" guarantee.
//
// The service runs as OnApplicationBootstrap with a higher provider priority
// than HaltStateRestoreService / EngineBootstrapService so the chain check
// completes BEFORE the M6 phase-1 pipeline opens any subscription. See
// BootstrapModule's provider ordering for the wiring.
//
// All exit paths flow through `abortSecurityCritical` so the runbook-grep
// for the exit code remains comprehensive. `abortSecurityCritical` returns
// `Promise<never>` and its body throws a BootModeChainAbortException after
// `process.exit` so a test harness that stubs `process.exit` still gets a
// typed exception rather than silently continuing.

@Injectable()
export class BootModeChainService implements OnApplicationBootstrap {
    private readonly logger = new Logger(BootModeChainService.name);

    private hasRun = false;

    constructor(
        private readonly appConfig: AppConfigService,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly historyRepo: BootModeHistoryRepository,
        private readonly rotationRepo: BootModeChainRotationRepository,
        private readonly subkeys: BootstrapSubkeyDeriver,
        private readonly codec: BootModeHmacCodec,
        private readonly tokenVerifier: TransitionTokenVerifier,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (this.hasRun) {
            return;
        }

        this.hasRun = true;

        await this.runBootSequence();
    }

    // Public for tests; the bootstrap hook calls it with no arguments. Holds
    // the full D6 sequence top-to-bottom so a reviewer reads each step in
    // executable order.
    async runBootSequence(): Promise<void> {
        const currentEnv = this.appConfig.exchangeEnv;
        const historySubkey = this.subkeys.deriveSubkey(HKDF_INFO_BOOT_MODE_HISTORY);
        const rotationSubkey = this.subkeys.deriveSubkey(HKDF_INFO_BOOT_MODE_CHAIN_ROTATIONS);

        // D6 step 6 c: a mode-mismatch boot needs the transition-token
        // verification to happen BEFORE any chain mutation. We can only tell
        // whether this is a mismatch boot AFTER the tip read, and the tip
        // read must happen inside the locked transaction (otherwise a racing
        // boot could append between our read and our append). So the token
        // verification is performed INSIDE the locked transaction too — and
        // that is intentional: the file I/O is a local stat + small-file read
        // (microseconds-bounded under normal disk conditions), and keeping
        // the verification inside the lock-held window ties it atomically to
        // the chain mutation so a stale token cannot race the append.
        // Verification failure throws and rolls the transaction back before
        // any append occurs, leaving both chains untouched.

        await this.dataSource.transaction(async (manager) => {
            await this.acquireBootAdvisoryLock(manager);

            await this.verifyChainIntegrity(historySubkey, manager);
            await this.verifyRotationChainIntegrity(rotationSubkey, manager);

            const tip = await this.historyRepo.findTip(manager);

            if (tip === null) {
                await this.appendGenesisBoot(manager, currentEnv, historySubkey);

                return;
            }

            const tipEnv = await this.requireKnownExchangeEnv(tip.exchangeEnv);

            if (tipEnv === currentEnv) {
                await this.appendSameModeBoot(manager, currentEnv, tip.thisRowHmac, historySubkey);

                return;
            }

            await this.handleModeMismatch(manager, tipEnv, currentEnv, tip.thisRowHmac, historySubkey, rotationSubkey);
        });
    }

    // D6 step 2 — walk every row from seq 1 upward, recompute the HMAC, and
    // compare. Chain break (any mismatch, or a row referencing a prev_row_hash
    // that does not match the prior row's HMAC) is security-critical → ABORT.
    // Runs through the open `manager` so the read sees the same transaction
    // snapshot as the subsequent tip-read + append.
    private async verifyChainIntegrity(subkey: Buffer, manager: EntityManager): Promise<void> {
        const rows = await this.historyRepo.findOrderedAll(manager);
        let expectedPrev: Buffer | null = null;

        for (const row of rows) {
            if (row.prevRowHash === null && expectedPrev !== null) {
                await this.abortSecurityCritical(`chain integrity break: row seq=${row.seq} has null prev_row_hash but expected prior tip`);
            }

            if (row.prevRowHash !== null && expectedPrev === null) {
                await this.abortSecurityCritical(`chain integrity break: row seq=${row.seq} carries prev_row_hash but is preceded by no prior row`);
            }

            if (row.prevRowHash !== null && expectedPrev !== null && !bufferEquals(row.prevRowHash, expectedPrev)) {
                await this.abortSecurityCritical(`chain integrity break: row seq=${row.seq} prev_row_hash does not match prior tip`);
            }

            const recomputed = this.codec.computeHmac(
                subkey,
                this.codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, {
                    seq: row.seq,
                    bootedAt: row.bootedAt,
                    rowKind: row.rowKind,
                    exchangeEnv: row.exchangeEnv,
                    fromEnv: row.fromEnv,
                    toEnv: row.toEnv,
                    prevRowHash: row.prevRowHash,
                }),
            );

            if (!bufferEquals(recomputed, row.thisRowHmac)) {
                await this.abortSecurityCritical(`chain integrity break: row seq=${row.seq} HMAC mismatch (tampered or wrong sub-key)`);
            }

            expectedPrev = row.thisRowHmac;
        }
    }

    // D7 — mirror of verifyChainIntegrity for the boot_mode_chain_rotations
    // chain. Without this walk, a tampered rotation row goes undetected
    // because every rotation insert happens inside a transition transaction;
    // a re-boot under the same env never re-touches the rotation chain. The
    // walk closes that gap.
    private async verifyRotationChainIntegrity(subkey: Buffer, manager: EntityManager): Promise<void> {
        const rows = await this.rotationRepo.findOrderedAll(manager);
        let expectedPrev: Buffer | null = null;

        for (const row of rows) {
            if (row.prevRowHash === null && expectedPrev !== null) {
                await this.abortSecurityCritical(`rotation chain integrity break: row seq=${row.seq} has null prev_row_hash but expected prior tip`);
            }

            if (row.prevRowHash !== null && expectedPrev === null) {
                await this.abortSecurityCritical(`rotation chain integrity break: row seq=${row.seq} carries prev_row_hash but is preceded by no prior row`);
            }

            if (row.prevRowHash !== null && expectedPrev !== null && !bufferEquals(row.prevRowHash, expectedPrev)) {
                await this.abortSecurityCritical(`rotation chain integrity break: row seq=${row.seq} prev_row_hash does not match prior tip`);
            }

            const recomputed = this.codec.computeHmac(
                subkey,
                this.codec.encodeBootModeChainRotationPayload(CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS, {
                    seq: row.seq,
                    rotatedAt: row.rotatedAt,
                    fromEnv: row.fromEnv,
                    toEnv: row.toEnv,
                    preTipHash: row.preTipHash,
                    transitionTokenHash: row.transitionTokenHash,
                    prevRowHash: row.prevRowHash,
                }),
            );

            if (!bufferEquals(recomputed, row.thisRowHmac)) {
                await this.abortSecurityCritical(`rotation chain integrity break: row seq=${row.seq} HMAC mismatch (tampered or wrong sub-key)`);
            }

            expectedPrev = row.thisRowHmac;
        }
    }

    private async appendGenesisBoot(manager: EntityManager, env: ExchangeEnvironmentEnum, subkey: Buffer): Promise<void> {
        await this.historyRepo.appendInTransaction(manager, {
            rowKind: BootModeHistoryRowKindEnum.BOOT,
            exchangeEnv: env,
            fromEnv: null,
            toEnv: null,
            prevRowHash: null,
            computeHmac: (payload) => this.codec.computeHmac(subkey, this.codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, payload)),
        });

        this.logger.warn(`boot_mode_history genesis BOOT row appended (env=${env})`);
    }

    private async appendSameModeBoot(manager: EntityManager, env: ExchangeEnvironmentEnum, prevTipHmac: Buffer, subkey: Buffer): Promise<void> {
        await this.historyRepo.appendInTransaction(manager, {
            rowKind: BootModeHistoryRowKindEnum.BOOT,
            exchangeEnv: env,
            fromEnv: null,
            toEnv: null,
            prevRowHash: prevTipHmac,
            computeHmac: (payload) => this.codec.computeHmac(subkey, this.codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, payload)),
        });

        this.logger.log(`boot_mode_history BOOT row appended (env=${env}, same-mode boot)`);
    }

    // D6 step 6. Mode mismatch routing through D7's matrix. R1 wires only
    // TESTNET→PAPER and PAPER→LIVE (one-way each); the reverse arrows and
    // every other matrix row are operator-runbook gated per ADR 0032 §D7 +
    // the M11b plan. Unwired transitions abort with a clear message pointing
    // at the runbook.
    private async handleModeMismatch(
        manager: EntityManager,
        fromEnv: ExchangeEnvironmentEnum,
        toEnv: ExchangeEnvironmentEnum,
        prevTipHmac: Buffer,
        historySubkey: Buffer,
        rotationSubkey: Buffer,
    ): Promise<void> {
        const transitionLookup = this.lookupAuthorizedTransition(fromEnv, toEnv);

        if (transitionLookup === null) {
            // abortSecurityCritical returns Promise<never>; the explicit return
            // is unreachable at runtime but makes the narrowing explicit for
            // readers (and avoids TS's flow-analysis edge cases on async never).
            await this.abortSecurityCritical(
                `unauthorized mode transition: ${fromEnv} -> ${toEnv} is not wired in R1 (see ADR 0032 §D7 transition matrix + soak runbook)`,
            );

            return;
        }

        const { tokenFileEnv, tokenHashEnv } = transitionLookup;
        const tokenFile = this.appConfig.readTransitionTokenFile(tokenFileEnv) ?? '';
        const tokenHash = this.appConfig.readTransitionTokenHash(tokenHashEnv) ?? '';

        let verified: { tokenHashBinary: Buffer };
        try {
            verified = await this.tokenVerifier.verifyOrThrow({
                filePath: tokenFile,
                expectedHashHex: tokenHash,
                transitionLabel: `${fromEnv}->${toEnv}`,
            });
        } catch (cause) {
            // D6 step 6 d — invalid token: ABORT WITH ZERO CHAIN MUTATION.
            // We are inside the outer transaction; throwing rolls it back
            // before any append has been made (verify-only reads above do not
            // mutate state). Both boot_mode_history and
            // boot_mode_chain_rotations remain untouched.
            await this.abortSecurityCritical(`transition ${fromEnv}->${toEnv} token verification failed: ${describe(cause)}`);

            return;
        }

        const transitionRow = await this.historyRepo.appendInTransaction(manager, {
            rowKind: BootModeHistoryRowKindEnum.TRANSITION,
            exchangeEnv: toEnv,
            fromEnv,
            toEnv,
            prevRowHash: prevTipHmac,
            computeHmac: (payload) => this.codec.computeHmac(historySubkey, this.codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, payload)),
        });

        const bootRow = await this.historyRepo.appendInTransaction(manager, {
            rowKind: BootModeHistoryRowKindEnum.BOOT,
            exchangeEnv: toEnv,
            fromEnv: null,
            toEnv: null,
            prevRowHash: transitionRow.thisRowHmac,
            computeHmac: (payload) => this.codec.computeHmac(historySubkey, this.codec.encodeBootModeHistoryPayload(CHAIN_NAME_BOOT_MODE_HISTORY, payload)),
        });

        await this.appendRotationRow({
            manager,
            fromEnv,
            toEnv,
            preTipHash: prevTipHmac,
            transitionTokenHash: verified.tokenHashBinary,
            rotationSubkey,
        });

        this.logger.warn(`boot_mode_history TRANSITION ${fromEnv}->${toEnv} + BOOT (seq=${bootRow.seq}) + rotation appended atomically`);
    }

    private async appendRotationRow(params: {
        manager: EntityManager;
        fromEnv: ExchangeEnvironmentEnum;
        toEnv: ExchangeEnvironmentEnum;
        preTipHash: Buffer;
        transitionTokenHash: Buffer;
        rotationSubkey: Buffer;
    }): Promise<void> {
        // Read the rotation tip THROUGH the open transaction so a concurrent
        // appender cannot insert between this read and the corresponding
        // insert. Belt-and-braces with the advisory lock taken at the start
        // of the surrounding transaction.
        const rotationTip = await this.rotationRepo.findTip(params.manager);

        await this.rotationRepo.appendInTransaction(params.manager, {
            fromEnv: params.fromEnv,
            toEnv: params.toEnv,
            preTipHash: params.preTipHash,
            transitionTokenHash: params.transitionTokenHash,
            prevRowHash: rotationTip === null ? null : rotationTip.thisRowHmac,
            computeHmac: (payload) =>
                this.codec.computeHmac(params.rotationSubkey, this.codec.encodeBootModeChainRotationPayload(CHAIN_NAME_BOOT_MODE_CHAIN_ROTATIONS, payload)),
        });
    }

    // pg_advisory_xact_lock blocks until the lock is granted (lock is released
    // at transaction commit/rollback). The same fixed BIGINT key is used for
    // every boot so two concurrent cold-starts serialise on the lock rather
    // than racing on `findTip()`. Explicit `::bigint` cast on the parameter
    // so the driver round-trip is unambiguous (the key value exceeds INT4).
    private async acquireBootAdvisoryLock(manager: EntityManager): Promise<void> {
        await manager.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [BOOT_MODE_HISTORY_ADVISORY_LOCK_KEY.toString()]);
    }

    private lookupAuthorizedTransition(
        fromEnv: ExchangeEnvironmentEnum,
        toEnv: ExchangeEnvironmentEnum,
    ): { tokenFileEnv: TransitionTokenFileEnvName; tokenHashEnv: TransitionTokenHashEnvName } | null {
        if (fromEnv === ExchangeEnvironmentEnum.TESTNET && toEnv === ExchangeEnvironmentEnum.PAPER) {
            return TRANSITION_ENV_VARS.TESTNET_PAPER;
        }

        if (fromEnv === ExchangeEnvironmentEnum.PAPER && toEnv === ExchangeEnvironmentEnum.LIVE) {
            return TRANSITION_ENV_VARS.PAPER_LIVE;
        }

        // Reverse + other matrix rows are operator-runbook gated per ADR 0032
        // §D7 + M11b plan. R1 wires only TESTNET→PAPER and PAPER→LIVE
        // (one-way each).
        return null;
    }

    // Narrow a chain-row's persisted `exchange_env` (loaded as plain text by
    // TypeORM) into the typed enum. A value outside the enum's literal set
    // means the row was written by a binary that disagrees with our enum
    // contract (corruption, manual SQL, or downgrade after an enum
    // expansion) — treat as chain corruption.
    private async requireKnownExchangeEnv(value: string): Promise<ExchangeEnvironmentEnum> {
        const allowed = Object.values(ExchangeEnvironmentEnum) as string[];

        if (!allowed.includes(value)) {
            // abortSecurityCritical returns Promise<never> and ends with
            // process.exit + typed throw; awaiting it matches the rest of the
            // file's abort pattern and keeps the value visible in the operator
            // message (sanitised: trimmed + length-capped to avoid log abuse
            // from a corrupted row carrying a giant blob).
            const sanitised = value.trim().slice(0, 64);
            await this.abortSecurityCritical(`chain integrity break: tip carries unknown exchange_env value=${JSON.stringify(sanitised)}`);
        }

        return value as ExchangeEnvironmentEnum;
    }

    // Returns `never` so callers can be statically prevented from continuing
    // after an abort. `process.exit` is sync but TypeScript types it as
    // `never`; the trailing `throw` is here so a test harness that stubs
    // `process.exit` (returning undefined) still propagates a typed
    // exception rather than silently advancing past the abort.
    private async abortSecurityCritical(reason: string): Promise<never> {
        this.logger.error(`BOOT MODE CHAIN ABORT — ${reason}`);
        process.stderr.write(`boot.mode.chain.abort — ${reason}\n`);

        process.exit(BOOT_MODE_HISTORY_SECURITY_EXIT_CODE);

        throw new BootModeChainAbortException(reason);
    }
}

function describe(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}
