import { AuthScopeEnum } from '@bot/shared';
import { BadRequestException, Controller, ForbiddenException, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { AuthGuard, RequiredScopes } from '../../auth/AuthGuard';
import { REBALANCE_CONTROL_BASE_PATH, REBALANCE_TRIGGER_RATE_LIMIT, REBALANCE_TRIGGER_RATE_TTL_MS, TRIGGER_REBALANCE_PATH } from '../const';
import { RebalanceTriggerForbiddenException, RebalanceTriggerRejectedException } from '../exception';
import { ITriggerRebalanceDueResult, RebalanceSchedulerService } from '../service/RebalanceSchedulerService';

// Paper-only admin probe for the momentum rebalance seam (ADR 0048 §10). Emits
// `UNIVERSE_REBALANCE_DUE_EVENT` on demand so operators can exercise the cascade
// without waiting for the 01:07 UTC cron. Auth mirrors `POST /v1/control/test-alert`:
// `AuthGuard` + `admin` scope (CLI-issued tokens only).
//
// Route:
//   POST /v1/control/trigger-rebalance   scope=admin   → { accepted, nowMs }
//
// The service throws typed domain exceptions; this controller is the HTTP boundary that
// translates them to the correct status (403 forbidden / paper-only, 400 config/validation).

@Controller(REBALANCE_CONTROL_BASE_PATH)
export class RebalanceDevController {
    private readonly logger = new Logger(RebalanceDevController.name);

    constructor(private readonly rebalanceScheduler: RebalanceSchedulerService) {}

    @Post(TRIGGER_REBALANCE_PATH)
    @HttpCode(200)
    // ThrottlerGuard runs BEFORE AuthGuard so unauthenticated / invalid-token spam is rate-limited
    // (429) without reaching auth. Defense-in-depth — the admin scope check remains the primary guard.
    @UseGuards(ThrottlerGuard, AuthGuard)
    @Throttle({ default: { limit: REBALANCE_TRIGGER_RATE_LIMIT, ttl: REBALANCE_TRIGGER_RATE_TTL_MS } })
    @RequiredScopes(AuthScopeEnum.ADMIN)
    async triggerRebalance(): Promise<ITriggerRebalanceDueResult> {
        try {
            const result = await this.rebalanceScheduler.triggerRebalanceDue();

            this.logger.log(`rebalance.devTrigger accepted nowMs=${result.nowMs}`);

            return result;
        } catch (cause) {
            throw this.toHttpException(cause);
        }
    }

    private toHttpException(cause: unknown): Error {
        if (cause instanceof RebalanceTriggerForbiddenException) {
            return new ForbiddenException(cause.message);
        }

        if (cause instanceof RebalanceTriggerRejectedException) {
            return new BadRequestException(cause.message);
        }

        return cause instanceof Error ? cause : new Error(String(cause));
    }
}
