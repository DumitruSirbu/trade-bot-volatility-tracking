// Row kinds for boot_mode_history (ADR 0032 §D6). The DB CHECK constraint
// in the CreateBootModeHistory migration mirrors this enum set verbatim;
// adding a value here requires a paired migration that widens the CHECK.
export enum BootModeHistoryRowKindEnum {
    BOOT = 'BOOT',
    TRANSITION = 'TRANSITION',
    KEY_ROTATION_WITNESS = 'KEY_ROTATION_WITNESS',
    CHAIN_RESTORE = 'CHAIN_RESTORE',
    MACHINE_REPURPOSE_WIPE = 'MACHINE_REPURPOSE_WIPE',
}
