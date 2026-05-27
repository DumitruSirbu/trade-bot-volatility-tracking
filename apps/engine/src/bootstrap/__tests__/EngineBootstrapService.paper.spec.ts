/**
 * M11a R2d Item 3 — crash-recovery integration smoke (ADR 0032 §D12 +
 * amended ADR 0014 phase 1).
 *
 * Asserts that under EXCHANGE_ENV=PAPER, EngineBootstrapService.phase2And3DriftSweep
 *   - delegates phase 1 to the live ReconciliationService.forceTick (which
 *     env-gates to a no-op under PAPER, so the underlying IAccountStateSource
 *     is never invoked through the live path);
 *   - additionally invokes PaperReconciliationAdapter.forceTick so a
 *     post-crash divergence between in-memory state and persisted
 *     paper_account_state is caught BEFORE phase 9 opens the orchestrator.
 *
 * Under LIVE/TESTNET, PaperReconciliationAdapter.forceTick is NOT invoked.
 */

import { ExchangeEnvironmentEnum } from '@bot/shared';

import { AppConfigService } from '../../config/service';
import { LocalProtectiveMonitor } from '../../execution/service/LocalProtectiveMonitor';
import { SubscriptionRetainer } from '../../market-data/service/SubscriptionRetainer';
import { PaperReconciliationAdapter } from '../../paper-mode/service/PaperReconciliationAdapter';
import { AccountSnapshotRepository } from '../../position/repository/AccountSnapshotRepository';
import { PositionRepository } from '../../position/repository/PositionRepository';
import { AccountSnapshotWriter } from '../../position/service/AccountSnapshotWriter';
import { PositionInstrumentor } from '../../position/service/PositionInstrumentor';
import { ReconciliationService } from '../../position/service/ReconciliationService';
import { RiskGateService } from '../../risk/service/RiskGateService';
import { EngineBootstrapService } from '../service/EngineBootstrapService';

function buildService(env: ExchangeEnvironmentEnum) {
    const reconciliation = { forceTick: jest.fn(async () => undefined) } as unknown as ReconciliationService;
    const paperReconciliation = {
        forceTick: jest.fn(async () => ({
            tickAtMs: 0,
            driftCount: 0,
            inMemoryCount: 0,
            persistedCount: 0,
        })),
    } as unknown as PaperReconciliationAdapter;
    const appConfig = { exchangeEnv: env } as unknown as AppConfigService;
    const service = new EngineBootstrapService(
        {} as PositionRepository,
        reconciliation,
        {} as LocalProtectiveMonitor,
        {} as PositionInstrumentor,
        {} as SubscriptionRetainer,
        {} as RiskGateService,
        {} as AccountSnapshotWriter,
        {} as AccountSnapshotRepository,
        appConfig,
        paperReconciliation,
    );

    return { service, reconciliation, paperReconciliation };
}

describe('EngineBootstrapService phase 2-3 — PAPER branch (ADR 0032 §D12)', () => {
    it('under EXCHANGE_ENV=PAPER, invokes PaperReconciliationAdapter.forceTick AND the live ReconciliationService.forceTick (latter is env-gated to no-op)', async () => {
        const { service, reconciliation, paperReconciliation } = buildService(ExchangeEnvironmentEnum.PAPER);

        await service.phase2And3DriftSweep(1_234_567_890);

        expect(reconciliation.forceTick).toHaveBeenCalledTimes(1);
        expect(paperReconciliation.forceTick).toHaveBeenCalledTimes(1);
        expect(paperReconciliation.forceTick).toHaveBeenCalledWith(1_234_567_890);
    });

    it('under EXCHANGE_ENV=TESTNET, only the live ReconciliationService.forceTick is invoked', async () => {
        const { service, reconciliation, paperReconciliation } = buildService(ExchangeEnvironmentEnum.TESTNET);

        await service.phase2And3DriftSweep(1_234_567_890);

        expect(reconciliation.forceTick).toHaveBeenCalledTimes(1);
        expect(paperReconciliation.forceTick).not.toHaveBeenCalled();
    });

    it('under EXCHANGE_ENV=LIVE, only the live ReconciliationService.forceTick is invoked', async () => {
        const { service, reconciliation, paperReconciliation } = buildService(ExchangeEnvironmentEnum.LIVE);

        await service.phase2And3DriftSweep(1_234_567_890);

        expect(reconciliation.forceTick).toHaveBeenCalledTimes(1);
        expect(paperReconciliation.forceTick).not.toHaveBeenCalled();
    });
});
