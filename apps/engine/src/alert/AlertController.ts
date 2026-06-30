import { AuthScopeEnum } from '@bot/shared';
import { Controller, HttpCode, Inject, Logger, Post, UseGuards } from '@nestjs/common';

import { AuthGuard, RequiredScopes } from '../auth/AuthGuard';
import { CLOCK, IClock } from '../common/clock/Clock';
import { ALERT_BASE_PATH, TEST_ALERT_PATH } from './const/alertConsts';
import { DailyPnlSummaryScheduler } from './DailyPnlSummaryScheduler';

// Admin alert-probe surface (M11). Gives the operator a way to verify the full
// alert pipeline (sink construction → rate limiter → Telegram POST) end-to-end
// on demand, without waiting for a position event or the UTC-midnight cron.
//
// Route:
//   POST /v1/control/test-alert   scope=admin   → { triggered, date }
//
// Auth mirrors the kill-switch surface: `AuthGuard` + `@RequiredScopes`. The
// probe re-runs `DailyPnlSummaryScheduler.runOnce` so the operator exercises
// the exact path a real daily summary would take. The clock is read at the
// controller boundary so the scheduler stays pure on its injected clock.
//
// This controller lives in `AlertModule` (alongside the scheduler it drives)
// rather than `ControlModule`: `AlertModule` already imports `ControlModule`,
// so wiring the scheduler into `HaltController` would close a
// `ControlModule → AlertModule → ControlModule` import cycle.

export interface ITestAlertResponseBody {
    triggered: boolean;
    date: string;
}

@Controller(ALERT_BASE_PATH)
export class AlertController {
    private readonly logger = new Logger(AlertController.name);

    constructor(
        private readonly dailyPnlSummary: DailyPnlSummaryScheduler,
        @Inject(CLOCK) private readonly clock: IClock,
    ) {}

    @Post(TEST_ALERT_PATH)
    @HttpCode(200)
    @UseGuards(AuthGuard)
    @RequiredScopes(AuthScopeEnum.ADMIN)
    async triggerTestAlert(): Promise<ITestAlertResponseBody> {
        const date = await this.dailyPnlSummary.runOnce(this.clock.now());

        this.logger.log(`alert.testAlert.triggered date=${date}`);

        return { triggered: true, date };
    }
}
