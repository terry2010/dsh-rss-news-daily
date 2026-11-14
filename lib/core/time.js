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
const DAY_MS = 86_400_000;
/** Format a Date as YYYY-MM-DD in the given zone ('' = local time). */
export function zonedDayKey(date, timezone) {
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    };
    const fmt = timezone === undefined || timezone === ''
        ? new Intl.DateTimeFormat('en-US', options)
        : new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone });
    const parts = readParts(fmt.formatToParts(date));
    return [
        String(parts.year).padStart(4, '0'),
        String(parts.month).padStart(2, '0'),
        String(parts.day).padStart(2, '0'),
    ].join('-');
}
/** Read the clock parts of `date` as seen in `timezone` ('' = host local). */
function partsOf(date, timezone) {
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    };
    const fmt = timezone === undefined || timezone === ''
        ? new Intl.DateTimeFormat('en-US', options)
        : new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone });
    return readParts(fmt.formatToParts(date));
}
function readParts(parts) {
    const map = new Map();
    for (const part of parts) {
        if (part.type !== 'literal')
            map.set(part.type, part.value);
    }
    const hour = Number(map.get('hour') ?? 0);
    return {
        year: Number(map.get('year') ?? 0),
        month: Number(map.get('month') ?? 0),
        day: Number(map.get('day') ?? 0),
        hour: Number.isFinite(hour) ? hour % 24 : 0,
        minute: Number(map.get('minute') ?? 0),
        second: Number(map.get('second') ?? 0),
    };
}
/** Parse a "HH:MM" clock string; returns undefined when malformed. */
export function parseClockTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match === null)
        return undefined;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59)
        return undefined;
    return { hour, minute };
}
/**
 * Compute the next occurrence of `time` ("HH:MM") in `timezone` ('' = local).
 * The result carries only the sub-second remainder of `now`, so repeated
 * re-arms never accumulate drift.
 * @throws {RangeError} when the clock string is malformed.
 */
export function nextZonedOccurrence(time, timezone, now) {
    const clock = parseClockTime(time);
    if (clock === undefined)
        throw new RangeError(`invalid digest time ${JSON.stringify(time)} (expected HH:MM)`);
    // Convergence pass: wall-clock "today HH:MM:00" in the target zone,
    // expressed as a UTC instant, corrected once for DST offset changes. The
    // seconds component participates on BOTH sides so the result lands on the
    // target second (plus the sub-second remainder of `now`).
    let guess = new Date(now.getTime());
    for (let pass = 0; pass < 2; pass += 1) {
        const parts = partsOf(guess, timezone);
        const currentWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        const targetWall = Date.UTC(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute, 0);
        guess = new Date(guess.getTime() + (targetWall - currentWall));
    }
    if (guess.getTime() <= now.getTime()) {
        // Already past today's occurrence: target tomorrow in wall-clock terms.
        guess = new Date(guess.getTime() + DAY_MS);
        const parts = partsOf(guess, timezone);
        const currentWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        const targetWall = Date.UTC(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute, 0);
        guess = new Date(guess.getTime() + (targetWall - currentWall));
    }
    const secondsUntil = Math.max(0, Math.floor((guess.getTime() - now.getTime()) / 1000));
    return { next: guess, secondsUntil };
}
/**
 * `now` 所在 zoned 日历日的 "HH:MM" 对应的 UTC 时刻——可落在过去或未来，
 * 不做过夜翻转（nextZonedOccurrence 的"今日定点"版本，DST 二次修正相同）。
 * 快报 daily 槽位用它求"今日槽起点"与"昨日槽起点"。
 * @throws {RangeError} malformed clock string.
 */
export function zonedDayOccurrence(time, timezone, now) {
    const clock = parseClockTime(time);
    if (clock === undefined)
        throw new RangeError(`invalid time ${JSON.stringify(time)} (expected HH:MM)`);
    let guess = new Date(now.getTime());
    for (let pass = 0; pass < 2; pass += 1) {
        const parts = partsOf(guess, timezone);
        const currentWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        const targetWall = Date.UTC(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute, 0);
        guess = new Date(guess.getTime() + (targetWall - currentWall));
    }
    return guess;
}
/** 本地日历日 → UTC 时刻范围（含 DST 二次修正）。fetchedAt 存 UTC ISO，day 过滤要按此窗口比。 */
export function zonedDayBounds(day, timezone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone || undefined, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const offAt = (t) => {
        const p = fmt.formatToParts(new Date(t));
        const get = (k) => Number(p.find((x) => x.type === k)?.value);
        return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - t;
    };
    const localMidnightUtc = (utcMid) => {
        let result = utcMid - offAt(utcMid); // 第一次近似
        result = utcMid - offAt(result); // 第二次修正（DST 边界）
        return result;
    };
    const utcMid = Date.parse(`${day}T00:00:00Z`);
    const nextUtcMid = utcMid + DAY_MS;
    const start = localMidnightUtc(utcMid);
    const end = localMidnightUtc(nextUtcMid) - 1;
    return { after: new Date(start).toISOString(), before: new Date(end).toISOString() };
}
//# sourceMappingURL=time.js.map