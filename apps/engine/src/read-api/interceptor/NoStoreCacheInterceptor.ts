import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { Observable, tap } from 'rxjs';

// M9 R2 wave B (Cache-Control medium). Read-API GETs surface forensic audit
// data + live position state — intermediate proxies must NOT cache them. The
// halt POST routes already set `Cache-Control: no-store` manually; this
// interceptor applies the same header uniformly to PositionsController +
// MetricsController. `/v1/health` is deliberately uninstrumented so a load
// balancer may cache the liveness probe shape; that response body carries no
// position / audit data.
@Injectable()
export class NoStoreCacheInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        return next.handle().pipe(
            tap(() => {
                const response = context.switchToHttp().getResponse<Response>();

                response.setHeader('Cache-Control', 'no-store');
            }),
        );
    }
}
