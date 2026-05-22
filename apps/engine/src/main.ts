import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AppConfigService } from './config/service';

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });

    // Replace Nest's default logger with the structured pino logger so every
    // framework and application log line is JSON with redaction applied.
    app.useLogger(app.get(Logger));

    const appConfig = app.get(AppConfigService);

    app.enableShutdownHooks();

    await app.listen(appConfig.enginePort);

    const logger = app.get(Logger);
    logger.log(`Engine listening on port ${appConfig.enginePort}`, 'Bootstrap');
}

void bootstrap();
