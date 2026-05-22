// Cross-cutting time conversions. Single source of truth so modules and migrations
// never re-declare the same magic millisecond constants inline.
export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
