import { SignalActionEnum } from '@bot/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// S-M1. Strict request shape for GET /v1/decisions query params. The global
// ValidationPipe (main.ts) runs with `whitelist: true` + `transform: true`, so
// invalid `symbol` / `flowType` / `action` / `pageSize` values are rejected
// with a 400 BEFORE the handler runs. The repo-side `normalizeFilter` /
// `normalizeActionFilter` / `clampPageSize` helpers stay as defense-in-depth.
//
// Bounds are generous on purpose: `symbol` covers Binance + CCXT unified format
// (e.g. `BTCUSDT`, `BTC/USDT:USDT`), `flowType` covers the longest known flow
// label with headroom.
export class ListDecisionsQueryDto {
    @IsOptional()
    @IsString()
    cursor?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    pageSize?: number;

    @IsOptional()
    @IsString()
    @MaxLength(30)
    symbol?: string;

    @IsOptional()
    @IsString()
    @MaxLength(60)
    flowType?: string;

    @IsOptional()
    @IsIn(Object.values(SignalActionEnum))
    action?: string;
}
