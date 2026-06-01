import { Module } from '@nestjs/common';

import { AlertSinkModule } from '../alert/sink/AlertSinkModule';
import { CLOCK, SystemClock } from '../common/clock/Clock';
import { AppConfigModule } from '../config/AppConfigModule';
import { DbBackupScheduler } from './DbBackupScheduler';

// M17 — thin module wiring the automated daily DB backup scheduler. The cron
// is registered dynamically inside DbBackupScheduler.onModuleInit via the
// global SchedulerRegistry (provided by ScheduleModule.forRoot() in
// CommonModule), so no @Cron() decorator and no per-module ScheduleModule
// import is needed here.
//
// A local CLOCK provider keeps the scheduler decoupled from ControlModule's
// CLOCK (CLOCK is a port; duplicate providers are safe by ADR 0024 §IClock) —
// mirrors AuthModule's RevokedJtiPruneScheduler wiring.
@Module({
    imports: [AppConfigModule, AlertSinkModule],
    providers: [{ provide: CLOCK, useClass: SystemClock }, DbBackupScheduler],
    exports: [DbBackupScheduler],
})
export class BackupModule {}
