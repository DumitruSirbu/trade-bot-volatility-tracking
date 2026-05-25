import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AppConfigService } from './config/service';

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

    // Replace Nest's default logger with the structured pino logger so every
    // framework and application log line is JSON with redaction applied.
    app.useLogger(app.get(Logger));

    const appConfig = app.get(AppConfigService);

    // M9 R1 H1 — strict input validation everywhere. `whitelist` strips
    // unknown fields; `forbidNonWhitelisted` 400s if extras are sent;
    // `transform` runs class-transformer so DTOs arrive typed. Applied
    // globally so no controller can accidentally accept un-validated bodies.
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }),
    );

    // M9 R1 H6 — honour `X-Forwarded-For` only from configured hops so
    // `req.ip` reflects the real client behind the docker-compose / ingress
    // proxy. Default 'loopback' is safe for the current single-host deploy;
    // operators set TRUST_PROXY_HOPS=<n> behind a real load balancer.
    app.set('trust proxy', appConfig.trustProxy);

    // NOTE: ad-hoc `enableCors()` is intentionally NOT used here. CORS is
    // handled by `AuthCorsInterceptor` (NestMiddleware) registered in
    // AppModule, which reads its allow-list from `AppConfigService.corsAllowlist`
    // — the single source of truth per ADR 0020 §2.3.

    app.enableShutdownHooks();

    await app.listen(appConfig.enginePort);

    const logger = app.get(Logger);
    logger.log(`Engine listening on port ${appConfig.enginePort}`, 'Bootstrap');
}

void bootstrap();
