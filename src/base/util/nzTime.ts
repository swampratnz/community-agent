const NZ_EVENT_TIME_FORMAT = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Minute-granularity `Pacific/Auckland` rendering for event start/end times
 * shown to members and admins (issue #577). `Intl` handles the NZST/NZDT
 * transition, so this never hand-rolls a UTC offset. Sibling to
 * systemPrompt.ts's day-granularity NZ_DATE_FORMAT, which only grounds the
 * model's own relative-time reasoning and is never applied to event
 * timestamps themselves.
 */
export function formatNzEventTime(instant: string | Date): string {
  return NZ_EVENT_TIME_FORMAT.format(typeof instant === 'string' ? new Date(instant) : instant);
}
