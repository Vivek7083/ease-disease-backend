/** India has a fixed offset of UTC+05:30 and no daylight saving, so a calendar day is always exactly 24 hours. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant the India calendar day containing `now` began (00:00 IST), as a UTC instant. */
export function istDayStart(now: Date): Date {
  const shifted = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** The instant the next India calendar day begins; the current day is `[istDayStart, istNextDayStart)`. */
export function istNextDayStart(now: Date): Date {
  return new Date(istDayStart(now).getTime() + DAY_MS);
}
