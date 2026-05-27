import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfigModule } from '../config/AppConfigModule';
import { BootModeChainRotationEntity } from './entity/BootModeChainRotationEntity';
import { BootModeHistoryEntity } from './entity/BootModeHistoryEntity';
import { BootModeChainRotationRepository } from './repository/BootModeChainRotationRepository';
import { BootModeHistoryRepository } from './repository/BootModeHistoryRepository';
import { BootModeChainService, BootModeHmacCodec, BootstrapSubkeyDeriver, TransitionTokenVerifier } from './service';

// Self-contained module owning the boot_mode_history +
// boot_mode_chain_rotations entities, repositories, and the chain-verify /
// append service (ADR 0032 §D6 / §D7). `BootModeChainService` runs as
// OnApplicationBootstrap and is consumed by BootstrapModule's provider
// ordering so its hook fires BEFORE the M6 10-phase pipeline.

@Module({
    imports: [AppConfigModule, TypeOrmModule.forFeature([BootModeHistoryEntity, BootModeChainRotationEntity])],
    providers: [
        BootstrapSubkeyDeriver,
        BootModeHmacCodec,
        TransitionTokenVerifier,
        BootModeHistoryRepository,
        BootModeChainRotationRepository,
        BootModeChainService,
    ],
    exports: [BootModeChainService, BootModeHistoryRepository, BootModeChainRotationRepository, BootstrapSubkeyDeriver, BootModeHmacCodec],
})
export class BootModeHistoryModule {}
