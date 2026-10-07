import {
    applyCheckin,
    attendanceDayKey,
    isValidTimezone,
    previousStreamDay,
    streamDayKey,
} from '../dist/plugins/streak/streak.js';
import { dataToString } from './helpers.js';

export function fuzz(data) {
    const input = dataToString(data);
    const date = new Date();
    try {
        isValidTimezone(input);
        streamDayKey(date, input);
        attendanceDayKey(date, input, 12);
    } catch {
        // Invalid timezone is expected; only crashes are findings.
    }
    try {
        previousStreamDay(['2024-01-01', '2024-01-02'], input);
    } catch {
        // Input with null bytes etc. should not throw; it is treated as a day key.
    }
    try {
        applyCheckin(
            {
                chatterName: 'viewer',
                displayName: 'Viewer',
                currentStreak: 0,
                longestStreak: 0,
                lastCheckinDay: null,
                totalCheckins: 0,
            },
            input,
            null,
        );
    } catch {
        // applyCheckin is pure and should not throw on string input; treat any
        // throw as a finding, not expected behavior.
        throw new Error('applyCheckin threw unexpectedly');
    }
}
