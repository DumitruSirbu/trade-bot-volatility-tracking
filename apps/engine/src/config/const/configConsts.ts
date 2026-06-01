// Config-layer constants (conventions §Constants Placement).

// Number of whitespace-separated fields in a standard cron expression. Used by
// IsFiveFieldCron to reject 6-field (seconds) and `@`-alias forms the M17
// DB_BACKUP_CRON contract forbids.
export const CRON_FIELD_COUNT = 5;
