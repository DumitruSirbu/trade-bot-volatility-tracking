// Deterministic PRNG + stable hash primitives for the M8 paired block bootstrap
// (ADR 0018 §2.4). The bootstrap MUST reproduce byte-for-byte under the same
// seed — that is what makes a comparison run re-derivable from its `run_label`.
// Both functions are pure, side-effect-free, and free of Node-version-dependent
// behaviour: integer arithmetic only, masked to 32 bits.

const TWO_POW_32 = 0x1_0000_0000;
const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

// Mulberry32 — a public-domain 32-bit PRNG by Tommy Ettinger. Tiny state, fast,
// passes BigCrush at the resolution this bootstrap needs. The implementation
// follows the canonical form: increment the state by 0x6D2B79F5, do two
// multiplicative xor-shift mixes, then divide by 2^32 to land in [0, 1).
//
// Math.imul is used so the multiplies wrap at 32 bits identically across V8
// versions; `>>> 0` keeps the state unsigned. We capture `state` in the
// closure rather than exposing it, so callers cannot accidentally rewind it.
export const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;

    return (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
    };
};

// FNV-1a (32-bit) — the published algorithm by Fowler/Noll/Vo. We hash UTF-16
// code units of the input string, which is stable across Node versions for any
// ASCII or BMP input (the inputs we actually feed it — `run_label`, `pair_id`
// strings — are ASCII by construction). Each step XORs the next code unit into
// the hash, then multiplies by FNV_PRIME_32 with the wrap-at-32-bits semantics
// of Math.imul.
export const fnv1a32 = (input: string): number => {
    let hash = FNV_OFFSET_BASIS_32;

    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME_32);
    }

    return hash >>> 0;
};
