import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';

import { AppConfigModule } from '../config/AppConfigModule';
import { AppConfigService } from '../config/service';
import { createLoggerOptions } from './logger/loggerModuleFactory';
import { EventBusProbeService, HaltFlagService } from './service';

// Global module holding the cross-cutting primitives every later module relies
// on: structured logging, the in-process event bus, the scheduler, the
// kill-switch backing flag, and the event-bus probe.
@Global()
@Module({
    imports: [
        LoggerModule.forRootAsync({
            imports: [AppConfigModule],
            inject: [AppConfigService],
            useFactory: (appConfig: AppConfigService) => createLoggerOptions(appConfig),
        }),
        EventEmitterModule.forRoot(),
        ScheduleModule.forRoot(),
    ],
    providers: [HaltFlagService, EventBusProbeService],
    exports: [HaltFlagService, EventBusProbeService, LoggerModule],
})
export class CommonModule {}
