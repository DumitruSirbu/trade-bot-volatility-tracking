// Liveness response shape. Intentionally minimal — a single status field, no
// version/DB/internal detail (security invariant). Establishes the response-
// interface pattern other modules follow.
export interface ILivenessResponse {
    status: string;
}
