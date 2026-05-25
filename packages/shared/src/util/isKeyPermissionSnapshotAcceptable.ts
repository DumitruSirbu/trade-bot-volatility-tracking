import { IKeyPermissionSnapshot } from '../interface/IKeyPermissionSnapshot.js';

// M11a W0.2 (ADR 0028 §2.4): Allowlist predicate for key-permission snapshot.
// Pure function; no side effects. Deterministic — takes nowMs as an argument
// instead of reading Date.now() inside.
//
// Returns true iff the snapshot is exactly:
// - enableReading: true, enableFutures: true
// - ALL other capability flags: false
// - ipRestrict: true, ipAllowList: non-empty
// - tradingAuthorityExpirationTime: non-null and future
export function isKeyPermissionSnapshotAcceptable(
	snapshot: IKeyPermissionSnapshot,
	nowMs: number,
): boolean {
	return (
		snapshot.enableReading === true &&
		snapshot.enableFutures === true &&
		snapshot.enableSpot === false &&
		snapshot.enableWithdrawals === false &&
		snapshot.enableInternalTransfer === false &&
		snapshot.permitsUniversalTransfer === false &&
		snapshot.enableMargin === false &&
		snapshot.enableVanillaOptions === false &&
		snapshot.enableSubAccountManagement === false &&
		snapshot.ipRestrict === true &&
		snapshot.ipAllowList.length > 0 &&
		snapshot.tradingAuthorityExpirationTime !== null &&
		snapshot.tradingAuthorityExpirationTime > nowMs
	);
}
