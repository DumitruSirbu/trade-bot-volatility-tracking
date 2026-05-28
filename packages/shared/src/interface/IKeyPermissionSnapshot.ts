// M11a W0.2 (ADR 0028): API key capability snapshot for startup allowlist gate.
// Merged from sapiGetAccountApiRestrictions + sapiGetAccountApiRestrictionsIpRestriction.
// Every field is concrete; no optional fields. Missing fields default to conservative
// (fail-safe) values per ADR 0028 §2.2.
export interface IKeyPermissionSnapshot {
    // --- capability bits, sapiGetAccountApiRestrictions ---
    readonly enableReading: boolean;
    readonly enableFutures: boolean;
    readonly enableSpot: boolean;
    readonly enableWithdrawals: boolean;
    readonly enableInternalTransfer: boolean;
    readonly permitsUniversalTransfer: boolean;
    readonly enableMargin: boolean;
    readonly enableVanillaOptions: boolean;
    readonly enableSubAccountManagement: boolean;

    // --- IP allow-list, MERGED from both endpoints ---
    readonly ipRestrict: boolean;
    readonly ipAllowList: readonly string[];

    // --- trading-authority expiry ---
    // epoch ms; null means "no expiry configured" -> treated as expired under allowlist
    readonly tradingAuthorityExpirationTime: number | null;

    // --- provenance ---
    readonly fetchedAtMs: number;
    readonly sourceEndpoints: readonly string[];
}
