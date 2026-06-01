import { Injectable } from '@nestjs/common';

import { IRiskHaltStatePort } from '../../control/interface';
import { RiskStateRepository } from '../repository/RiskStateRepository';

// ADR 0021 §5.3 (M11a soak fix). Fulfils IRiskHaltStatePort for the operator
// resume path. The class file lives under risk/service/ because it depends on
// RiskStateRepository, but it is REGISTERED by ControlModule, not RiskModule:
// ControlModule provides RiskStateRepository locally (via forFeature on
// RiskStateEntity), imports this adapter by file path, and binds the
// RISK_HALT_STATE_PORT token to it. RiskModule neither provides nor exports
// this adapter or the token. Importing RiskModule from ControlModule would
// close the Control → Risk → Position → Exchange → Control DI cycle; a
// file-path import plus a local provider creates no module-import edge.
@Injectable()
export class RiskHaltStatePortAdapter implements IRiskHaltStatePort {
    constructor(private readonly riskStates: RiskStateRepository) {}

    async clearHaltForDate(utcDateString: string): Promise<void> {
        await this.riskStates.clearHaltForDate(utcDateString);
    }
}
