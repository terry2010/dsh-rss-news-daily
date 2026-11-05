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
    next: Date;
    /** Number of seconds from `now` until `next`. */
    secondsUntil: number;
}
/** Format a Date as YYYY-MM-DD in the given zone ('' = local time). */
export declare function zonedDayKey(date: Date, timezone?: string): string;
/** Parse a "HH:MM" clock string; returns undefined when malformed. */
export declare function parseClockTime(value: string): {
    hour: number;
    minute: number;
} | undefined;
/**
 * Compute the next occurrence of `time` ("HH:MM") in `timezone` ('' = local).
 * The result carries only the sub-second remainder of `now`, so repeated
 * re-arms never accumulate drift.
 * @throws {RangeError} when the clock string is malformed.
 */
export declare function nextZonedOccurrence(time: string, timezone: string | undefined, now: Date): ZonedScheduleResult;
/** 本地日历日 → UTC 时刻范围（含 DST 二次修正）。fetchedAt 存 UTC ISO，day 过滤要按此窗口比。 */
export declare function zonedDayBounds(day: string, timezone?: string): {
    after: string;
    before: string;
};
//# sourceMappingURL=time.d.ts.map