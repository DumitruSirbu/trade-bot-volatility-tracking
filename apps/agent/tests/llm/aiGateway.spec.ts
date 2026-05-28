// M13 W2.A — aiGateway tests (execution plan §W2.4 + ADR 0037 §2.5).
//
// All paths are exercised with stubbed AI SDK primitives. NO network call is
// made; the `generate` and `modelFactory` seams in the constructor inject
// behavior.

import { z } from 'zod';

import { AiGatewayClient, CostCapExceededError, MissingGatewayConfigError } from '../../src/llm/aiGateway.js';

const TEST_SCHEMA = z.object({ value: z.number() });

const BASE_ENV = {
    AI_GATEWAY_URL: 'https://gateway.example.test/v1/ai',
    AI_GATEWAY_API_KEY: 'sk-test-key',
    AI_GATEWAY_MAX_USD_PER_RUN: '1.00',
} as const;

interface IStubResult {
    object: unknown;
    providerMetadata?: unknown;
}

function stubGenerate(results: IStubResult[]): {
    fn: (...args: unknown[]) => Promise<unknown>;
    calls: unknown[];
} {
    const calls: unknown[] = [];
    let i = 0;
    const fn = async (...args: unknown[]): Promise<unknown> => {
        calls.push(args[0]);
        const r = results[i];
        i = i + 1;
        if (r === undefined) {
            throw new Error('stub exhausted');
        }
        if (r instanceof Error) {
            throw r;
        }
        return r;
    };
    return { fn, calls };
}

describe('AiGatewayClient — config', () => {
    it('throws MissingGatewayConfigError when AI_GATEWAY_URL is absent', () => {
        const env = { ...BASE_ENV } as Record<string, string>;
        delete env.AI_GATEWAY_URL;
        expect(() => new AiGatewayClient({ env })).toThrow(MissingGatewayConfigError);
    });

    it('throws MissingGatewayConfigError when AI_GATEWAY_API_KEY is absent', () => {
        const env = { ...BASE_ENV } as Record<string, string>;
        delete env.AI_GATEWAY_API_KEY;
        expect(() => new AiGatewayClient({ env })).toThrow(MissingGatewayConfigError);
    });

    it('throws MissingGatewayConfigError when AI_GATEWAY_MAX_USD_PER_RUN is unparseable', () => {
        const env = { ...BASE_ENV, AI_GATEWAY_MAX_USD_PER_RUN: 'not-a-number' };
        expect(() => new AiGatewayClient({ env })).toThrow(MissingGatewayConfigError);
    });
});

describe('AiGatewayClient — happy path', () => {
    it('returns a Zod-valid object and reports usageUsd from providerMetadata', async () => {
        const stub = stubGenerate([{ object: { value: 42 }, providerMetadata: { gateway: { cost: 0.0123 } } }]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
        });

        const result = await client.generateStructured({
            system: 'sys',
            user: 'usr',
            schema: TEST_SCHEMA,
        });

        expect(result.value).toEqual({ value: 42 });
        expect(result.usageUsd).toBeCloseTo(0.0123);
        expect(client.totalUsageUsd).toBeCloseTo(0.0123);
        expect(stub.calls).toHaveLength(1);
    });

    it('falls back to a fixed estimate when providerMetadata.gateway.cost is missing', async () => {
        const stub = stubGenerate([{ object: { value: 1 } }]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
            estimatedUsdPerCall: 0.05,
        });
        const result = await client.generateStructured({
            system: 's',
            user: 'u',
            schema: TEST_SCHEMA,
        });
        expect(result.usageUsd).toBeCloseTo(0.05);
    });
});

describe('AiGatewayClient — cost cap', () => {
    it('throws CostCapExceededError when projected + cumulative crosses the cap', async () => {
        const stub = stubGenerate([
            { object: { value: 1 }, providerMetadata: { gateway: { cost: 0.6 } } },
            { object: { value: 2 }, providerMetadata: { gateway: { cost: 0.6 } } },
        ]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
            estimatedUsdPerCall: 0.5,
        });
        // First call: cumulative=0, projected=0.5 -> allowed. Actual=0.6.
        await client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA });
        expect(client.totalUsageUsd).toBeCloseTo(0.6);
        // Second call: cumulative=0.6 + projected=0.5 = 1.1 > 1.0 cap -> throw.
        await expect(client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA })).rejects.toBeInstanceOf(CostCapExceededError);
        expect(stub.calls).toHaveLength(1);
    });

    it('pre-check uses max(estimate, lastActual * 1.2) on the second call', async () => {
        // M13 W6 fix wave 4 (#4): first call estimate=0.20, actual=0.50;
        // second call's projected must be max(0.20, 0.50 * 1.2) = 0.60.
        // Cap is 1.00 so cumulative(0.50) + projected(0.60) = 1.10 > 1.0
        // -> throws BEFORE the second `generate` call is dispatched.
        const stub = stubGenerate([
            { object: { value: 1 }, providerMetadata: { gateway: { cost: 0.5 } } },
            { object: { value: 2 }, providerMetadata: { gateway: { cost: 0.5 } } },
        ]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
            estimatedUsdPerCall: 0.2,
        });
        await client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA });
        expect(client.totalUsageUsd).toBeCloseTo(0.5);
        await expect(client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA })).rejects.toBeInstanceOf(CostCapExceededError);
        expect(stub.calls).toHaveLength(1);
    });

    it('does not throw when growing actuals stay below cap', async () => {
        // cap=1.00, estimate=0.10. First call actual=0.20 (cumulative=0.20),
        // second call pre-check projected = max(0.10, 0.20 * 1.2) = 0.24;
        // 0.20 + 0.24 = 0.44 <= 1.00 -> allowed. Second actual=0.30
        // (cumulative=0.50). Both calls succeed.
        const stub = stubGenerate([
            { object: { value: 1 }, providerMetadata: { gateway: { cost: 0.2 } } },
            { object: { value: 2 }, providerMetadata: { gateway: { cost: 0.3 } } },
        ]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
            estimatedUsdPerCall: 0.1,
        });
        await client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA });
        await client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA });
        expect(client.totalUsageUsd).toBeCloseTo(0.5);
        expect(stub.calls).toHaveLength(2);
    });

    it('throws CostCapExceededError when actual cost overshoots after a single call', async () => {
        const stub = stubGenerate([{ object: { value: 1 }, providerMetadata: { gateway: { cost: 2.5 } } }]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
            estimatedUsdPerCall: 0.5,
        });
        await expect(client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA })).rejects.toBeInstanceOf(CostCapExceededError);
    });
});

describe('AiGatewayClient — fallback', () => {
    it('falls back from opus to sonnet on a retryable error and succeeds', async () => {
        const retryable = Object.assign(new Error('rate limited'), {
            name: 'GatewayRateLimitError',
        });
        const stub = stubGenerate([retryable as unknown as IStubResult, { object: { value: 99 }, providerMetadata: { gateway: { cost: 0.01 } } }]);
        const seenModels: string[] = [];
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: (modelId: string) => {
                seenModels.push(modelId);
                return {} as never;
            },
            generate: stub.fn as never,
        });

        const result = await client.generateStructured({
            system: 's',
            user: 'u',
            schema: TEST_SCHEMA,
            modelHint: 'opus',
        });

        expect(result.value).toEqual({ value: 99 });
        expect(seenModels).toEqual(['anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-5']);
    });

    it('bubbles up when both primary and fallback fail', async () => {
        const err1 = Object.assign(new Error('first'), { name: 'GatewayRateLimitError' });
        const err2 = Object.assign(new Error('second'), { name: 'GatewayInternalServerError' });
        const stub = stubGenerate([err1 as unknown as IStubResult, err2 as unknown as IStubResult]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
        });
        await expect(client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA })).rejects.toThrow('second');
    });

    it('does NOT retry on a non-retryable error (e.g. CostCapExceededError surface)', async () => {
        const nonRetryable = Object.assign(new Error('schema mismatch'), {
            name: 'AI_NoObjectGeneratedError',
        });
        const stub = stubGenerate([nonRetryable as unknown as IStubResult]);
        const client = new AiGatewayClient({
            env: BASE_ENV,
            modelFactory: () => ({}) as never,
            generate: stub.fn as never,
        });
        await expect(client.generateStructured({ system: 's', user: 'u', schema: TEST_SCHEMA })).rejects.toThrow('schema mismatch');
        expect(stub.calls).toHaveLength(1);
    });
});
