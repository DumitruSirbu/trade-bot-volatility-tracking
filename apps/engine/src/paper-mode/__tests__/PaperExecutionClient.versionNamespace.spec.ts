/**
 * Version-namespace derivation for PaperExecutionClient (D17 + ADR 0047/0049).
 *
 * The idempotency-ledger composite key includes a `versionNamespace` whose
 * purpose is to encode which strategy version actually executed an order (and
 * to keep active-run rows from colliding with the separate `paper.shadow.v<id>`
 * namespace). ADR 0049 made the legacy single-symbol version id nullable, and
 * M50 (ADR 0047) added the portfolio version id.
 *
 * These tests pin the derivation observed through the context passed to the
 * simulator by `placeOrder`:
 *   1. legacy set + portfolio unset  → `paper.active.v<legacy>` (unchanged).
 *   2. legacy unset + portfolio set  → `paper.active.v<portfolio>` (the M50
 *      dormant-legacy state; MUST NOT be `paper.active.vnull`).
 *   3. both unset                    → `paper.active.vnone` (explicit sentinel,
 *      never `vnull`, and no crash).
 */

import { CoinTierEnum, IOrderIntent, ISimulatedFillCore, OrderIntentActionEnum, CorrelationModeEnum, FlowTypeEnum, PositionSideEnum } from '@bot/shared';

import { AppConfigService } from '../../config/service';
import { PaperSimulatorIdempotencyRepository } from '../repository/PaperSimulatorIdempotencyRepository';
import { PaperExecutionClient } from '../service/PaperExecutionClient';
import { PaperFillSimulator, IPaperSimulatorContext } from '../service/PaperFillSimulator';

function buildIntent(): IOrderIntent {
    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol: 'BTCUSDT',
        eventId: 'evt-namespace-1',
        tradeSide: PositionSideEnum.LONG,
        signalScore: 70,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier: CoinTierEnum.TIER_1,
        idiosyncrasyScore: 0.8,
        quantity: '0.01',
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

function buildFill(): ISimulatedFillCore {
    return {
        filled: true,
        fillPrice: '30000',
        qty: '0.01',
        feeUsdt: '0.12',
        tsMs: 1_700_000_000_000,
    } as unknown as ISimulatedFillCore;
}

function buildAppConfig(legacyId: number | null, portfolioId: number | null): AppConfigService {
    return {
        activeStrategyVersionId: legacyId,
        activePortfolioStrategyVersionId: portfolioId,
    } as unknown as AppConfigService;
}

// Returns the client plus the jest mock so a test can read the context the
// client handed the simulator (where `versionNamespace` is observable).
function buildClient(appConfig: AppConfigService): { client: PaperExecutionClient; simulateFill: jest.Mock } {
    const simulateFill = jest.fn(async () => ({ fill: buildFill(), simulatedFillId: 'fill-1' }));
    const simulator = { simulateFill } as unknown as PaperFillSimulator;
    const idempotencyRepo = {} as unknown as PaperSimulatorIdempotencyRepository;

    return { client: new PaperExecutionClient(simulator, idempotencyRepo, appConfig), simulateFill };
}

async function resolveNamespace(appConfig: AppConfigService): Promise<string> {
    const { client, simulateFill } = buildClient(appConfig);

    await client.placeOrder(buildIntent());

    const context = simulateFill.mock.calls[0][1] as IPaperSimulatorContext;

    return context.versionNamespace;
}

describe('PaperExecutionClient — version-namespace derivation (D17 / ADR 0047+0049)', () => {
    it('uses the legacy version id when set and the portfolio id is unset (existing behavior)', async () => {
        const namespace = await resolveNamespace(buildAppConfig(7, null));

        expect(namespace).toBe('paper.active.v7');
    });

    it('falls back to the portfolio id in the M50 dormant-legacy state — never paper.active.vnull', async () => {
        const namespace = await resolveNamespace(buildAppConfig(null, 20));

        expect(namespace).toBe('paper.active.v20');
        expect(namespace).not.toContain('null');
    });

    it('prefers the legacy id over the portfolio id when both are set', async () => {
        const namespace = await resolveNamespace(buildAppConfig(3, 20));

        expect(namespace).toBe('paper.active.v3');
    });

    it('uses the explicit vnone sentinel when neither id is set — never vnull, no crash', async () => {
        const namespace = await resolveNamespace(buildAppConfig(null, null));

        expect(namespace).toBe('paper.active.vnone');
        expect(namespace).not.toContain('null');
    });
});
