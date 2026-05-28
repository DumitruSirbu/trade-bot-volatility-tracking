// M13 W2.A — Vercel AI Gateway client wrapper (execution plan §W2.4).
//
// Wraps the AI SDK's `generateObject` with:
//   - Env-driven gateway configuration (AI_GATEWAY_URL, AI_GATEWAY_API_KEY,
//     AI_GATEWAY_MAX_USD_PER_RUN — all REQUIRED).
//   - A primary/fallback model pair (opus -> sonnet) with a single retry.
//   - A per-instance cumulative cost cap. The cap is enforced against
//     `cumulative + estimated`; when an actual cost arrives via
//     `providerMetadata.gateway.cost` we replace the estimate with the truth.
//   - Structured output ONLY (no free-form generateText) — the Zod schema is
//     passed straight through to `generateObject`.
//
// Cost note: the AI Gateway returns a per-generation `cost` field on
// `providerMetadata.gateway` for served generations. If absent (provider
// quirk or stubbed response) we fall back to a fixed per-call estimate so the
// cap continues to bind. Operators tune the estimate via env if needed.

import { createGateway, generateObject, type LanguageModel } from 'ai';
import type { ZodType } from 'zod';

const DEFAULT_PRIMARY_MODEL: ModelHintKey = 'opus';
const ESTIMATED_USD_PER_CALL_FALLBACK = 0.02;

// Minimal structural alias for `process.env` — avoids importing the global
// `NodeJS` namespace from @types/node into this module's lint surface.
export type IEnvLike = Readonly<Record<string, string | undefined>>;

declare const process: { readonly env: IEnvLike };

const MODEL_IDS = {
    opus: 'anthropic/claude-opus-4-7',
    sonnet: 'anthropic/claude-sonnet-4-5',
} as const;

/**
 * Default model id stamped onto `agent_run_history.model_id` when the caller
 * does not override it. Mirrors `MODEL_IDS.opus` so the persisted value tracks
 * the primary AI-gateway model id exactly — never hand-edit one without the
 * other.
 */
export const DEFAULT_AGENT_MODEL_ID: string = MODEL_IDS.opus;

export type ModelHintKey = keyof typeof MODEL_IDS;

export class CostCapExceededError extends Error {
    public readonly cumulativeUsd: number;
    public readonly projectedUsd: number;
    public readonly capUsd: number;

    constructor(cumulativeUsd: number, projectedUsd: number, capUsd: number) {
        super(
            `AI gateway cost cap exceeded: cumulative=${cumulativeUsd.toFixed(4)} + ` + `projected=${projectedUsd.toFixed(4)} > cap=${capUsd.toFixed(4)} USD`,
        );
        this.name = 'CostCapExceededError';
        this.cumulativeUsd = cumulativeUsd;
        this.projectedUsd = projectedUsd;
        this.capUsd = capUsd;
    }
}

export class MissingGatewayConfigError extends Error {
    constructor(varName: string) {
        super(`AI gateway config missing required env var: ${varName}`);
        this.name = 'MissingGatewayConfigError';
    }
}

export interface IGenerateStructuredOptions<T> {
    readonly system: string;
    readonly user: string;
    readonly schema: ZodType<T>;
    readonly modelHint?: ModelHintKey;
}

export interface IGenerateStructuredResult<T> {
    readonly value: T;
    readonly usageUsd: number;
}

// Test-seam: the AI SDK's gateway provider creates language model instances
// from a model-id string. We hide that behind a factory so tests can inject a
// stubbed model without going through the network.
export type LanguageModelFactory = (modelId: string) => LanguageModel;

// Test-seam: the structured-generation primitive. Defaults to the AI SDK's
// `generateObject`; tests override to assert call shape and inject failures.
// The signature is intentionally loose (the AI SDK's generic explodes ts-jest's
// recursion budget). The wrapper enforces the contract at the call site.
export type GenerateObjectFn = (args: {
    readonly model: LanguageModel;
    readonly schema: ZodType<unknown>;
    readonly system: string;
    readonly prompt: string;
}) => Promise<{ object: unknown; providerMetadata?: unknown }>;

export interface IAiGatewayClientOptions {
    readonly env?: IEnvLike;
    readonly modelFactory?: LanguageModelFactory;
    readonly generate?: GenerateObjectFn;
    readonly estimatedUsdPerCall?: number;
}

interface IResolvedConfig {
    readonly gatewayUrl: string;
    readonly apiKey: string;
    readonly maxUsdPerRun: number;
}

export class AiGatewayClient {
    private readonly config: IResolvedConfig;
    private readonly modelFactory: LanguageModelFactory;
    private readonly generate: GenerateObjectFn;
    private readonly estimatedUsdPerCall: number;
    private cumulativeUsd = 0;
    // M13 W6 fix wave 4 (#4): a single high-cost call can blow the cap if the
    // pre-check only sees the (low) static estimate. Once we've observed one
    // actual cost, the pre-check uses `max(estimate, lastActualUsd * 1.2)` so
    // subsequent calls cannot silently overshoot when costs are growing.
    private lastActualUsd: number | null = null;
    private static readonly LAST_ACTUAL_SAFETY_MULTIPLIER = 1.2;

    constructor(options: IAiGatewayClientOptions = {}) {
        this.config = resolveConfig(options.env ?? process.env);
        this.modelFactory = options.modelFactory ?? buildDefaultModelFactory(this.config);
        this.generate = options.generate ?? (generateObject as unknown as GenerateObjectFn);
        this.estimatedUsdPerCall = options.estimatedUsdPerCall ?? ESTIMATED_USD_PER_CALL_FALLBACK;
    }

    public get totalUsageUsd(): number {
        return this.cumulativeUsd;
    }

    public async generateStructured<T>(opts: IGenerateStructuredOptions<T>): Promise<IGenerateStructuredResult<T>> {
        this.assertBudgetAllows();
        const primary = opts.modelHint ?? DEFAULT_PRIMARY_MODEL;
        const fallback = primary === 'opus' ? 'sonnet' : 'opus';
        try {
            return await this.callModel(primary, opts);
        } catch (err) {
            if (!isRetryable(err)) {
                throw err;
            }
            this.assertBudgetAllows();
            return await this.callModel(fallback, opts);
        }
    }

    private async callModel<T>(hint: ModelHintKey, opts: IGenerateStructuredOptions<T>): Promise<IGenerateStructuredResult<T>> {
        const model = this.modelFactory(MODEL_IDS[hint]);
        const result = await this.generate({
            model,
            schema: opts.schema as ZodType<unknown>,
            system: opts.system,
            prompt: opts.user,
        });
        const actualUsd = extractUsageUsd(result.providerMetadata) ?? this.estimatedUsdPerCall;
        this.lastActualUsd = actualUsd;
        this.recordSpend(actualUsd);
        return { value: result.object as T, usageUsd: actualUsd };
    }

    private assertBudgetAllows(): void {
        const projected = this.projectedNextCallUsd();
        if (this.cumulativeUsd + projected > this.config.maxUsdPerRun) {
            throw new CostCapExceededError(this.cumulativeUsd, projected, this.config.maxUsdPerRun);
        }
    }

    private projectedNextCallUsd(): number {
        // First call: only the static estimate is available. Subsequent calls
        // bias upward with the last observed actual (× safety multiplier) so a
        // growing-cost run cannot blow through the cap on the very next call.
        if (this.lastActualUsd === null) {
            return this.estimatedUsdPerCall;
        }
        return Math.max(this.estimatedUsdPerCall, this.lastActualUsd * AiGatewayClient.LAST_ACTUAL_SAFETY_MULTIPLIER);
    }

    private recordSpend(usd: number): void {
        this.cumulativeUsd += usd;
        if (this.cumulativeUsd > this.config.maxUsdPerRun) {
            throw new CostCapExceededError(this.cumulativeUsd, 0, this.config.maxUsdPerRun);
        }
    }
}

function resolveConfig(env: IEnvLike): IResolvedConfig {
    const gatewayUrl = readRequired(env, 'AI_GATEWAY_URL');
    const apiKey = readRequired(env, 'AI_GATEWAY_API_KEY');
    const capRaw = readRequired(env, 'AI_GATEWAY_MAX_USD_PER_RUN');
    const maxUsdPerRun = Number.parseFloat(capRaw);
    if (!Number.isFinite(maxUsdPerRun) || maxUsdPerRun <= 0) {
        throw new MissingGatewayConfigError('AI_GATEWAY_MAX_USD_PER_RUN');
    }
    return { gatewayUrl, apiKey, maxUsdPerRun };
}

function readRequired(env: IEnvLike, name: string): string {
    const value = env[name];
    if (value === undefined || value === '') {
        throw new MissingGatewayConfigError(name);
    }
    return value;
}

function buildDefaultModelFactory(config: IResolvedConfig): LanguageModelFactory {
    const provider = createGateway({ baseURL: config.gatewayUrl, apiKey: config.apiKey });
    return (modelId: string) => provider(modelId);
}

function extractUsageUsd(metadata: unknown): number | null {
    if (metadata === null || metadata === undefined || typeof metadata !== 'object') {
        return null;
    }
    const gw = (metadata as Record<string, unknown>)['gateway'];
    if (gw === null || gw === undefined || typeof gw !== 'object') {
        return null;
    }
    const cost = (gw as Record<string, unknown>)['cost'];
    return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}

function isRetryable(err: unknown): boolean {
    if (err instanceof CostCapExceededError) {
        return false;
    }
    if (err === null || err === undefined || typeof err !== 'object') {
        return false;
    }
    const tagged = err as { retryable?: boolean; name?: string };
    if (tagged.retryable === true) {
        return true;
    }
    const name = typeof tagged.name === 'string' ? tagged.name : '';
    return name === 'AI_RetryError' || name === 'GatewayInternalServerError' || name === 'GatewayRateLimitError';
}
