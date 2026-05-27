// Return shape of TransitionTokenVerifier.verifyOrThrow. The binary hash is
// fed straight into the boot_mode_chain_rotations row's transition_token_hash
// column so the rotation chain witnesses exactly the bytes that authorised
// the mode change (ADR 0032 §D7).

export interface IVerifiedTransitionToken {
    tokenHashBinary: Buffer;
}
