import { DomainException } from '../../common/exception';

// M11a W1.2 (ADR 0028 §2.5). Thrown by the startup key-permission assertion
// when either:
//   - `IExchangeClient.fetchKeyPermissions()` rejects (network/auth/parse),
//   - `isKeyPermissionSnapshotAcceptable()` returns false.
//
// Carries the comma-separated list of FAILING CLAUSE NAMES only (e.g.
// `enableWithdrawals,ipAllowList.empty`). Never echoes a snapshot value —
// the redacted snapshot is written to the `control_audit` row separately;
// the exception body is the Telegram + log surface.
export class KeyPermissionAssertionFailedException extends DomainException {
    constructor(failingClauses: ReadonlyArray<string>) {
        super('KEY_PERMISSION_ASSERTION_FAILED', `Exchange API key failed allowlist assertion: ${failingClauses.join(',')}`);
    }
}
