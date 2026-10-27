/**
 * Time handling for scheduled digests.
 *
 * Daily digests fire at a wall-clock time ("HH:MM") in an optional IANA
 * timezone. Computing the next occurrence from a remote timezone text is done
 * via Intl round-tripping (a known stable technique): take the current
 * wall-clock read for that zone, target the requested time, convert back to a
 * UTC instant, then let a second pass converge on DST-adjacent shifts.
 *
 * Pure module, fully deterministic given `now`.
 */

export interface ZonedScheduleResult {
  /** The UTC instant of the next occurrence strictly after `now`. */
  next: Date
  /** Number of seconds from `now` until `next`. */
  secondsUntil: number
}

interface TzParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const DAY_MS = 86_400_000

/** Format a Date as YYYY-MM-DD in the given zone ('' = local time). */
export function zonedDayKey(date: Date, timezone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }
  const fmt = timezone === undefined || timezone === ''
    ? new Intl.DateTimeFormat('en-US', options)
    : new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone })
  const parts = readParts(fmt.formatToParts(date))
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-')
}

/** Read the clock parts of `date` as seen in `timezone` ('' = host local). */
function partsOf(date: Date, timezone: string | undefined): TzParts {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }
  const fmt = timezone === undefined || timezone === ''
    ? new Intl.DateTimeFormat('en-US', options)
    : new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone })
  return readParts(fmt.formatToParts(date))
}

function readParts(parts: Intl.DateTimeFormatPart[]): TzParts {
  const map = new Map<string, string>()
  for (const part of parts) {
    if (part.type !== 'literal') map.set(part.type, part.value)
  }
  const hour = Number(map.get('hour') ?? 0)
  return {
    year: Number(map.get('year') ?? 0),
    month: Number(map.get('month') ?? 0),
    day: Number(map.get('day') ?? 0),
    hour: Number.isFinite(hour) ? hour % 24 : 0,
    minute: Number(map.get('minute') ?? 0),
    second: Number(map.get('second') ?? 0),
  }
}

/** Parse a "HH:MM" clock string; returns undefined when malformed. */
export function parseClockTime(value: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

/**
 * Compute the next occurrence of `time` ("HH:MM") in `timezone` ('' = local).
 * The result carries only the sub-second remainder of `now`, so repeated
 * re-arms never accumulate drift.
 * @throws {RangeError} when the clock string is malformed.
 */
export function nextZonedOccurrence(time: string, timezone: string | undefined, now: Date): ZonedScheduleResult {
  const clock = parseClockTime(time)
  if (clock === undefined) throw new RangeError(`invalid digest time ${JSON.stringify(time)} (expected HH:MM)`)
  // Convergence pass: wall-clock "today HH:MM:00" in the target zone,
  // expressed as a UTC instant, corrected once for DST offset changes. The
  // seconds component participates on BOTH sides so the result lands on the
  // target second (plus the sub-second remainder of `now`).
  let guess = new Date(now.getTime())
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = partsOf(guess, timezone)
    const currentWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const targetWall = Date.UTC(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute, 0)
    guess = new Date(guess.getTime() + (targetWall - currentWall))
  }
  if (guess.getTime() <= now.getTime()) {
    // Already past today's occurrence: target tomorrow in wall-clock terms.
    guess = new Date(guess.getTime() + DAY_MS)
    const parts = partsOf(guess, timezone)
    const currentWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const targetWall = Date.UTC(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute, 0)
    guess = new Date(guess.getTime() + (targetWall - currentWall))
  }
  const secondsUntil = Math.max(0, Math.floor((guess.getTime() - now.getTime()) / 1000))
  return { next: guess, secondsUntil }
}