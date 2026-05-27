// Input shape for TransitionTokenVerifier.verifyOrThrow (ADR 0032 §D6 step 6 c-d).
// Extracted to the conventional interface/ folder per code-conventions.md so the
// service file holds behaviour and the contract sits next to its sibling shapes.

export interface IVerifyTransitionTokenInput {
    filePath: string;
    expectedHashHex: string;
    transitionLabel: string;
}
