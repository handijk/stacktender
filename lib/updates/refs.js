/** Small helpers shared by the update modules: image references, ids, dates, windows. */

import {createHash} from 'node:crypto';

export const idOf = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8);

export const daysBetween = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) : null);

/** "repo[:tag][@sha256:…]"; a colon before the last slash is a registry port, not a tag. */
export function parseRef(ref) {
    const [rest, digest] = String(ref).split('@');
    const colon = rest.lastIndexOf(':');
    const tagged = colon > rest.lastIndexOf('/');
    return {
        name: tagged ? rest.slice(0, colon) : rest,
        tag: tagged ? rest.slice(colon + 1) : '',
        digest: digest ?? null,
    };
}

/** A version as findings carry it: the tag, with "@digest" when the pin has one. */
export const versionOf = (tag, digest) => [tag, digest].filter(Boolean).join('@');

/** For people: a digest cut to its first twelve characters. */
export const shortVersion = (v) =>
    v == null ? null : String(v).replace(/@sha256:([0-9a-f]{12})[0-9a-f]*/, '@sha256:$1…');

/** Minutes since local midnight in the zone. */
export function localMinutes(tz, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return get('hour') * 60 + get('minute');
}

/** The local date as YYYY-MM-DD and the weekday (0 = Sunday) in the zone. */
export function localParts(tz, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return {date: `${get('year')}-${get('month')}-${get('day')}`, minutes: localMinutes(tz, now), weekday};
}

export const toMinutes = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
};

/** Whether the local time is inside {from, to}; a window past midnight ("22:00"–"05:00") wraps. */
export function inWindow(w, tz, now = new Date()) {
    const cur = localMinutes(tz, now);
    const from = toMinutes(w.from);
    const to = toMinutes(w.to);
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

export const readJson = (fs, file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
};

export const removeFile = (fs, file) => {
    try {
        fs.unlinkSync(file);
    } catch {
        // not there
    }
};

export const errMsg = (err) => (err instanceof Error ? err.message : String(err));
