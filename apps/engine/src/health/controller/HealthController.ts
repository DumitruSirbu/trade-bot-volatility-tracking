import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

import { ILivenessResponse } from '../interface';

// Liveness only. Deliberately returns a fixed minimal body — no version, no DB
// status, no internals (security invariant). In prod this stays on the private
// network. Readiness/dependency checks, if ever needed, live behind auth.
@Controller('health')
export class HealthController {
    @Get()
    @HttpCode(HttpStatus.OK)
    checkLiveness(): ILivenessResponse {
        return { status: 'ok' };
    }
}
