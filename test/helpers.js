/**
 * What the scenarios hand the engines: an in-memory Docker, repository, store, bus, scanner and
 * backups, and a clock that runs faster than the wall so a five-minute soak takes half a second.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DeployFailedError} from '../lib/updates/engine.js';

export const SCALE = 600;

// The wall clock, kept before a scenario installs the fast one: waiting for a condition is done in real time.
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now.bind(Date);

/** `new Date()`, `Date.now()`, `setTimeout` and `setInterval` follow a clock `scale` times faster than the wall. Install before importing the engines. */
export function installClock(scale = SCALE, start = Date.now()) {
    const RealDate = Date;
    const realNow = RealDate.now.bind(RealDate);
    const base = realNow();
    const now = () => start + (realNow() - base) * scale;
    class FakeDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(now());
            else super(...args);
        }
        static now() {
            return now();
        }
    }
    globalThis.Date = FakeDate;
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.max(0, (ms ?? 0) / scale), ...a);
    globalThis.setInterval = (fn, ms, ...a) => realInterval(fn, Math.max(1, (ms ?? 0) / scale), ...a);
    return {now, realSleep: (ms) => new Promise((r) => realTimeout(r, ms))};
}

/** Sleep real milliseconds, whatever clock is installed. */
export const realSleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

/** Wait until `test()` is true, polling every 20 real ms, for `ms` real milliseconds. */
export async function until(test, ms = 5000, what = 'condition') {
    const deadline = realNow() + ms;
    while (realNow() < deadline) {
        if (await test()) return;
        await realSleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
}

export function tempDir(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

/** Docker as the engines see it: a map of containers the scenario reads and writes. */
export function fakeDocker() {
    const containers = new Map(); // name → {service, image, running, health, exitCode, restartCount, repoDigest?}
    const calls = [];
    return {
        map: containers,
        calls,
        async containers(wanted) {
            calls.push(`containers ${wanted.join(',')}`);
            const out = new Map();
            for (const [name, c] of containers) {
                if (!wanted.includes(c.service)) continue;
                out.set(c.service, {
                    service: c.service,
                    name,
                    image: c.image,
                    running: c.running,
                    exitCode: c.exitCode ?? null,
                    health: c.health ?? null,
                    restartCount: c.restartCount ?? 0,
                });
            }
            return out;
        },
        async container(name) {
            const c = containers.get(name);
            return c ? {running: c.running, image: c.image} : null;
        },
        async stop(name) {
            calls.push(`stop ${name}`);
            const c = containers.get(name);
            if (!c) throw new Error(`no container ${name}`);
            c.running = false;
        },
        async start(name) {
            calls.push(`start ${name}`);
            const c = containers.get(name);
            if (!c) throw new Error(`no container ${name}`);
            c.running = true;
        },
        async runningDigest(item) {
            for (const c of containers.values())
                if (item.services.includes(c.service) && c.repoDigest) return c.repoDigest;
            return null;
        },
        async pruneImages() {
            calls.push('prune');
            return {images: 2, bytes: 1234567890};
        },
    };
}

/** The repository: files by path; `change` edits them and calls `onPush` (which may throw a DeployFailedError). */
export function fakeRepo(files, {onPush} = {}) {
    const pushes = [];
    const reverts = [];
    let seq = 0;
    return {
        files,
        pushes,
        reverts,
        async read(file) {
            return files[file] ?? null;
        },
        async change(edits, message) {
            for (const e of edits) {
                const text = files[e.file];
                if (text === undefined || !text.includes(e.find))
                    throw new Error(`${e.file}: expected text not found: ${e.find.slice(0, 60)}`);
                files[e.file] = text.split(e.find).join(e.replace);
            }
            const sha = `sha${(++seq).toString().padStart(6, '0')}`;
            pushes.push({edits, message, sha});
            await onPush?.(edits, message, sha);
            return sha;
        },
        async revert(sha) {
            reverts.push(sha);
            return `revert-${sha}`;
        },
    };
}

export {DeployFailedError};

export function fakeStore() {
    const map = new Map();
    return {
        map,
        async get(key) {
            return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
        },
        async set(key, value) {
            map.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

/** The bus: events, retained state documents, the maintenance signal, and other sources' planned work. */
export function fakeBus() {
    const events = [];
    const states = [];
    const maintenance = [];
    const others = new Set();
    return {
        events,
        states,
        signals: maintenance,
        others,
        async event(type, payload) {
            events.push({type, ...payload});
        },
        async state(doc) {
            states.push(doc);
        },
        async maintenance(active, info) {
            maintenance.push({active, ...info});
        },
        otherWork() {
            return [...others];
        },
        lastState() {
            return states[states.length - 1];
        },
        ofType(type) {
            return events.filter((e) => e.type === type);
        },
    };
}

export const CADDY_OLD = 'caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9';
export const CADDY_NEW = 'caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f';
export const COMPOSE_CADDY = `services:
  stacktender:
    container_name: stacktender
    build: ./stacktender
  caddy:
    container_name: caddy
    image: ${CADDY_OLD}
`;

/** The updater's config for a scenario: everything in its window, nothing waiting on a calendar. */
export const UPDATES_CONFIG = {
    autopilot: true,
    tz: 'UTC',
    scanIntervalHours: 1000,
    applyWindow: {from: '00:00', to: '23:59'},
    infraWindow: {from: '00:00', to: '23:59'},
    infraServices: [],
    minGapMinutes: 0,
    soakMinutes: 1,
    deployTimeoutMinutes: 2,
    minimumReleaseAgeDays: 0,
    maxCatchUpDays: 60,
    announceIntervalHours: 1000,
    digests: true,
    digestIntervalDays: 7,
    exactTags: {},
    rules: [],
    hooks: {assessor: null, assessorAskAnyway: [], veto: null},
    housekeeping: {on: false, intervalDays: 7, keepDays: 14},
};

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

/**
 * The scanner, as far as a scenario needs it: the report fixture, rewritten with the pin moved to
 * the target when the compose file already holds it (then there is no update).
 */
export function fakeScanner(dir, composeText, fixture = 'report-caddy.json') {
    const reportFile = path.join(dir, 'report.json');
    const requests = [];
    const scan = () => {
        let text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf-8');
        if (composeText().includes(CADDY_NEW)) {
            const report = JSON.parse(text);
            for (const files of Object.values(report.repositories.local.packageFiles)) {
                for (const f of files) {
                    for (const dep of f.deps ?? []) {
                        if (dep.depName !== 'caddy') continue;
                        const u = dep.updates?.[0];
                        if (u) {
                            dep.currentValue = u.newValue;
                            dep.currentDigest = u.newDigest;
                            dep.replaceString = CADDY_NEW;
                            dep.currentVersion = u.newVersion;
                            dep.fixedVersion = u.newValue;
                            dep.updates = [];
                        }
                    }
                }
            }
            text = JSON.stringify(report);
        }
        fs.writeFileSync(reportFile, text);
    };
    return {
        requests,
        scan,
        request() {
            requests.push(Date.now());
            scan();
        },
        report() {
            if (!fs.existsSync(reportFile)) return null;
            return {mtime: fs.statSync(reportFile).mtimeMs, report: JSON.parse(fs.readFileSync(reportFile, 'utf-8'))};
        },
    };
}

/** The backups as the updates engine asks them: sets by service, snapshots, restores recorded. */
export function fakeBackups({bySet = {caddy: 'caddy'}, snapshots = []} = {}) {
    const restores = [];
    return {
        snapshotsList: snapshots,
        restores,
        sets() {
            return {sets: [], by_service: bySet, ready: true};
        },
        snapshots({set, since}) {
            return snapshots.filter((s) => (!set || s.tags.includes(`set:${set}`)) && (!since || s.time >= since));
        },
        restore(body) {
            restores.push(body);
            return {job: 'restore-1'};
        },
        job() {
            return {done: true, ok: true, stopped: ['caddy']};
        },
    };
}
