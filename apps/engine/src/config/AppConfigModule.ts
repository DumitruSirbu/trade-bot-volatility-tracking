import { join } from 'node:path';

import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfigService } from './service';
import { validateEnv } from './validateEnv';

// The single .env lives at the monorepo root; the engine runs from apps/engine,
// so point ConfigModule there explicitly. Process env still takes precedence,
// which is how compose/CI inject real values.
const REPO_ROOT_ENV_PATH = join(__dirname, '..', '..', '..', '..', '.env');

// Global so every module injects AppConfigService without re-importing.
// validateEnv runs at load time — invalid env aborts startup (fail fast).
@Global()
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            cache: true,
            envFilePath: REPO_ROOT_ENV_PATH,
            validate: validateEnv,
        }),
    ],
    providers: [AppConfigService],
    exports: [AppConfigService],
})
export class AppConfigModule {}
