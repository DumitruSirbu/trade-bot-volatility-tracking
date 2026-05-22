import { IStrategyParams, strategyParamsSchema } from '@bot/shared';
import { Injectable } from '@nestjs/common';

import { StrategyConfigException } from '../exception';
import { IStrategy } from '../interface';
import { V0BaselineStrategy, V1MeanReversionStrategy, V2MomentumStrategy, V3HybridRouterStrategy } from '../strategies';

interface IResolvedStrategy {
    strategy: IStrategy;
    params: IStrategyParams;
}

// Maps a strategy_versions row to its IStrategy implementation, indexed by
// `${name}:${version}` (the row's stable natural key — name+version is UNIQUE, and v0/v1
// share a direction so direction alone is insufficient). Resolution validates the row's
// params JSONB against the shared Zod schema and throws StrategyConfigException on a
// miss/invalid params — fail fast, never run with an unresolved impl or bad params.
@Injectable()
export class StrategyRegistry {
    private readonly strategiesByKey: ReadonlyMap<string, IStrategy>;

    constructor(v0: V0BaselineStrategy, v1: V1MeanReversionStrategy, v2: V2MomentumStrategy, v3: V3HybridRouterStrategy) {
        const strategies: IStrategy[] = [v0, v1, v2, v3];
        this.strategiesByKey = new Map(strategies.map((strategy) => [this.buildKey(strategy.name, strategy.version), strategy]));
    }

    resolve(name: string, version: number, params: unknown): IResolvedStrategy {
        const strategy = this.strategiesByKey.get(this.buildKey(name, version));

        if (strategy === undefined) {
            throw new StrategyConfigException(`No IStrategy implementation registered for ${this.buildKey(name, version)}`);
        }

        const parsed = strategyParamsSchema.safeParse(params);

        if (!parsed.success) {
            const paths = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

            throw new StrategyConfigException(`Invalid params for ${this.buildKey(name, version)}: ${paths}`);
        }

        return { strategy, params: parsed.data };
    }

    private buildKey(name: string, version: number): string {
        return `${name}:${version}`;
    }
}
