/**
 * The copies: restic in a runner container that executes one shell script per job from a shared
 * directory and leaves the exit code and output next to it; sets derived from the compose file;
 * a nightly run that stops a set for the seconds its copy takes; a snapshot on request that may
 * leave the set stopped for a deploy; a restore that keeps a copy of what is there first. A run
 * is journalled while it holds containers stopped, so a restart starts them again.
 */

import fs from 'node:fs';
import path from 'node:path';
import {errMsg, localParts, readJson, removeFile, toMinutes} from '../updates/refs.js';
import {byService, deriveSets} from './sets.js';

export const RUNNER_SCRIPT = [
    'mkdir -p /out/jobs /out/cache',
    "echo '[stacktender-restic] waiting for jobs'",
    'while true; do',
    '  for f in /out/jobs/*.sh; do',
    '    [ -e "$f" ] || continue',
    '    id="${f%.sh}"',
    '    [ -e "$id.exit" ] && continue',
    '    sh "$f" > "$id.log" 2>&1',
    '    echo $? > "$id.exit"',
    '  done',
    '  sleep 2',
    'done',
].join('\n');

const PRELUDE =
    'export RESTIC_REPOSITORY=/repo RESTIC_CACHE_DIR=/out/cache\nr() { restic --insecure-no-password "$@"; }\n';
const RESTIC_HOST = 'stack';
const SAFE_TAG = /^[A-Za-z0-9._:+-]+$/;
const SAFE_ID = /^[0-9a-f]{8,64}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const gist = (log) =>
    log
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('{'))
        .slice(-3)
        .join(' | ')
        .slice(0, 300);
const gb = (kb) => Math.round((kb / 1024 / 1024) * 10) / 10;
const mb = (bytes) => Math.round(bytes / 1024 / 1024);

export class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'RequestError';
        this.status = status;
    }
}

export class Backups {
    /**
     * @param {object} a
     * @param {object} a.cfg the `backups` section plus {tz, selfService}
     * @param {string} a.dataDir where jobs and the journal live (the runner's /out)
     * @param {() => Promise<string|null>} a.composeText the committed compose file
     * @param {(rel: string) => boolean} a.committed whether git tracks a path
     * @param {object} a.docker port: container(name), stop(name, seconds), start(name)
     * @param {object} a.store
     * @param {object} a.bus maintenance(active, info), state(doc), otherWork()
     * @param {(msg: string) => void} [a.log]
     */
    constructor({cfg, dataDir, composeText, committed, exists = () => true, docker, store, bus, log = () => {}}) {
        this.cfg = cfg;
        this.dataDir = dataDir;
        this.jobsDir = path.join(dataDir, 'jobs');
        this.journalFile = path.join(dataDir, 'run.json');
        this.composeText = composeText;
        this.committed = committed;
        this.exists = exists;
        this.docker = docker;
        this.store = store;
        this.bus = bus;
        this.log = log;
        this.sets = [];
        this.snapshotList = [];
        this.runs = [];
        this.current = null;
        this.jobChain = Promise.resolve();
        this.jobSeq = 0;
        this.lastNightly = null;
        this.lastNightlyDate = '';
        this.lastCheckAt = 0;
        this.repoInfo = null;
        this.runnerReady = false;
        this.probing = false;
        this.lastPublished = '';
        this.stopped = false;
        this.timer = null;
        this.status = {level: 'starting', message: 'starting'};
    }

    async soft(what, work) {
        let timer;
        try {
            await Promise.race([
                work,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('no answer in 10 s')), 10_000);
                }),
            ]);
        } catch (err) {
            this.log(`${what} failed (${errMsg(err)}); carrying on`);
        } finally {
            clearTimeout(timer);
        }
    }

    // --- Sets ---

    async refreshSets() {
        const text = await this.composeText();
        if (!text) throw new Error('docker-compose.yaml cannot be read');
        this.sets = deriveSets(text, {
            committed: this.committed,
            exclude: this.cfg.exclude,
            data: this.cfg.data,
            noStop: this.cfg.noStop,
            selfService: this.cfg.selfService,
            exists: this.exists,
        });
    }

    setByName(name) {
        return this.sets.find((s) => s.name === name) ?? null;
    }

    setOfService(service) {
        return this.sets.find((s) => s.services.includes(service)) ?? null;
    }

    // --- Jobs ---

    tidyJobs() {
        try {
            const ids = [
                ...new Set(fs.readdirSync(this.jobsDir).map((f) => f.replace(/\.(sh|log|exit|tmp)$/, ''))),
            ].sort();
            for (const id of ids.slice(0, Math.max(0, ids.length - 40)))
                for (const ext of ['sh', 'log', 'exit']) removeFile(fs, path.join(this.jobsDir, `${id}.${ext}`));
        } catch {
            // no jobs yet
        }
    }

    /** Hand the runner one script and wait for its exit code and output. Scripts run one after the other. */
    runScript(body, timeoutMs = this.cfg.jobTimeoutMinutes * 60_000) {
        const work = async () => {
            fs.mkdirSync(this.jobsDir, {recursive: true});
            const id = `${Date.now().toString().padStart(14, '0')}-${(this.jobSeq++ % 1000).toString().padStart(3, '0')}`;
            const file = path.join(this.jobsDir, id);
            fs.writeFileSync(`${file}.tmp`, `${PRELUDE}${body}\n`);
            fs.renameSync(`${file}.tmp`, `${file}.sh`);
            const deadline = Date.now() + timeoutMs;
            while (!fs.existsSync(`${file}.exit`)) {
                if (Date.now() > deadline)
                    throw new Error(
                        `the runner did not finish job ${id} within ${Math.round(timeoutMs / 60_000)} min (is the restic runner up?)`,
                    );
                if (this.stopped) throw new Error('stopped while the job ran');
                await sleep(2000);
            }
            const exit = Number(fs.readFileSync(`${file}.exit`, 'utf-8').trim());
            const log = fs.existsSync(`${file}.log`) ? fs.readFileSync(`${file}.log`, 'utf-8') : '';
            this.tidyJobs();
            return {exit, log};
        };
        const p = this.jobChain.then(work, work);
        this.jobChain = p.then(
            () => undefined,
            () => undefined,
        );
        return p;
    }

    async ensureRepo() {
        const r = await this.runScript(
            'r cat config >/dev/null 2>&1 || r init\ndf -Pk /repo | tail -1\ndu -sk /repo | cut -f1',
            10 * 60_000,
        );
        if (r.exit !== 0) throw new Error(`the repository is not usable: ${gist(r.log)}`);
        const lines = r.log.trim().split('\n');
        const df = lines[lines.length - 2]?.trim().split(/\s+/) ?? [];
        const du = Number(lines[lines.length - 1]);
        if (df.length >= 4)
            this.repoInfo = {
                freeGb: gb(Number(df[3])),
                usedGb: gb(Number.isFinite(du) ? du : 0),
                at: new Date().toISOString(),
            };
        this.runnerReady = true;
    }

    async refreshSnapshots() {
        const r = await this.runScript(`r snapshots --json --host ${RESTIC_HOST}`, 5 * 60_000);
        if (r.exit !== 0) throw new Error(`listing snapshots: ${gist(r.log)}`);
        const line = r.log.split('\n').find((l) => l.trim().startsWith('['));
        const list = JSON.parse(line ?? '[]');
        this.snapshotList = list
            .map((s) => ({
                id: String(s.id),
                short_id: String(s.short_id),
                time: String(s.time),
                paths: (s.paths ?? []).map(String),
                tags: (s.tags ?? []).map(String),
            }))
            .sort((a, b) => a.time.localeCompare(b.time));
    }

    setTagOf(s) {
        return s.tags.find((t) => t.startsWith('set:'))?.slice(4) ?? null;
    }

    newestOf(setName, tag) {
        return (
            [...this.snapshotList]
                .reverse()
                .find((s) => this.setTagOf(s) === setName && (!tag || s.tags.includes(tag))) ?? null
        );
    }

    // --- Runs ---

    newRun(kind, setNames, extra = {}) {
        const run = {
            id: `${kind}-${Date.now().toString(36)}`,
            kind,
            startedAt: new Date().toISOString(),
            sets: setNames,
            keepStopped: false,
            stopped: [],
            phase: 'starting',
            results: {},
            ...extra,
        };
        this.current = run;
        fs.writeFileSync(this.journalFile, JSON.stringify(run));
        return run;
    }

    journal(run) {
        fs.writeFileSync(this.journalFile, JSON.stringify(run));
    }

    async endRun(run, ok, error) {
        run.ok = ok;
        run.error = error;
        run.endedAt = new Date().toISOString();
        run.phase = 'done';
        removeFile(fs, this.journalFile);
        this.runs = [...this.runs.filter((r) => r.id !== run.id), run].slice(-20);
        this.current = null;
        await this.soft('saving the runs', this.store.set('runs', this.runs));
    }

    maintenance(active, what, since) {
        return this.soft(
            'the maintenance signal',
            this.bus.maintenance(active, {what, since, at: new Date().toISOString()}),
        );
    }

    async startStopped(run, set) {
        for (const name of run.stopped.filter((n) => !set || set.stop.includes(n))) {
            try {
                await this.docker.start(name);
                run.stopped = run.stopped.filter((n) => n !== name);
                this.journal(run);
            } catch (err) {
                this.log(`could not start ${name} again: ${errMsg(err)}`);
            }
        }
    }

    async stopSet(run, set) {
        run.phase = `stopping ${set.name}`;
        this.journal(run);
        for (const name of set.stop) {
            const c = await this.docker.container(name);
            if (!c?.running) continue;
            run.stopped.push(name);
            this.journal(run);
            await this.docker.stop(name, this.cfg.stopTimeoutSeconds);
        }
    }

    parseSummary(log) {
        for (const line of log.split('\n').reverse()) {
            if (!line.includes('"message_type":"summary"')) continue;
            try {
                return JSON.parse(line);
            } catch {
                // not that line
            }
        }
        return null;
    }

    async backupSet(run, set, tags) {
        run.phase = `copying ${set.name}`;
        this.journal(run);
        const t0 = Date.now();
        const args = [
            `--host ${RESTIC_HOST}`,
            '--json',
            ...tags.map((t) => `--tag ${q(t)}`),
            `--tag ${q(`set:${set.name}`)}`,
            ...set.paths.map((p) => q(`/src/${p}`)),
        ];
        const r = await this.runScript(`r backup ${args.join(' ')}`);
        const summary = this.parseSummary(r.log);
        const seconds = Math.round((Date.now() - t0) / 1000);
        let result;
        if ((r.exit === 0 || r.exit === 3) && summary?.snapshot_id) {
            result = {
                ok: true,
                snapshot: String(summary.snapshot_id),
                bytes: Number(summary.total_bytes_processed ?? 0),
                added: Number(summary.data_added ?? 0),
                seconds,
            };
            if (r.exit === 3) result.note = `some files could not be read: ${gist(r.log)}`;
        } else {
            result = {ok: false, seconds, error: `restic exit ${r.exit}: ${gist(r.log) || 'no output'}`};
        }
        this.log(
            `${set.name}: ${result.ok ? `snapshot ${result.snapshot.slice(0, 8)}, ${mb(result.bytes)} MB, ${mb(result.added)} MB new` : result.error} in ${seconds} s`,
        );
        return result;
    }

    async copySet(run, set, tags) {
        await this.stopSet(run, set);
        const result = await this.backupSet(run, set, tags);
        if (!run.keepStopped) await this.startStopped(run, set);
        return result;
    }

    async nightly() {
        const run = this.newRun(
            'nightly',
            this.sets.map((s) => s.name),
            {tag: 'nightly'},
        );
        await this.maintenance(
            true,
            'nightly backup: each set is stopped for the seconds its copy takes',
            run.startedAt,
        );
        const t0 = Date.now();
        try {
            await this.ensureRepo();
            for (const set of this.sets) {
                if (this.stopped) throw new Error('stopped');
                run.results[set.name] = await this.copySet(run, set, ['nightly']);
            }
            run.phase = 'forgetting old snapshots';
            this.journal(run);
            const f = await this.runScript(
                `r forget --host ${RESTIC_HOST} --keep-within ${q(this.cfg.keepWithin)} --keep-weekly ${this.cfg.keepWeekly} --prune`,
                60 * 60_000,
            );
            if (f.exit !== 0) this.log(`forget/prune failed: ${gist(f.log)}`);
            if (
                Date.now() - this.lastCheckAt > 6 * 86_400_000 &&
                localParts(this.cfg.tz).weekday === this.cfg.checkWeekday
            ) {
                run.phase = 'checking the repository';
                this.journal(run);
                const c = await this.runScript('r check --read-data-subset=10%', 60 * 60_000);
                if (c.exit === 0) {
                    this.lastCheckAt = Date.now();
                    await this.soft('saving the check time', this.store.set('last_check', this.lastCheckAt));
                } else this.log(`repository check failed: ${gist(c.log)}`);
                run.results['(check)'] =
                    c.exit === 0
                        ? {ok: true, note: 'repository check passed'}
                        : {ok: false, error: `repository check: ${gist(c.log)}`};
            }
            await this.refreshSnapshots().catch((err) => this.log(`listing snapshots: ${errMsg(err)}`));
            await this.ensureRepo().catch(() => undefined);
            const failed = Object.entries(run.results)
                .filter(([, r]) => !r.ok)
                .map(([n]) => n);
            const added = Object.values(run.results).reduce((a, r) => a + (r.added ?? 0), 0);
            this.lastNightly = {
                at: run.startedAt,
                ok: failed.length === 0,
                sets: this.sets.length,
                added,
                seconds: Math.round((Date.now() - t0) / 1000),
                failed,
            };
            await this.soft('saving the nightly result', this.store.set('last_nightly', this.lastNightly));
            await this.endRun(run, failed.length === 0, failed.length ? `failed: ${failed.join(', ')}` : undefined);
        } catch (err) {
            await this.startStopped(run);
            this.lastNightly = {
                at: run.startedAt,
                ok: false,
                sets: this.sets.length,
                added: 0,
                seconds: Math.round((Date.now() - t0) / 1000),
                failed: ['(run)'],
            };
            await this.endRun(run, false, errMsg(err));
            this.log(`nightly backup failed: ${errMsg(err)}`);
        } finally {
            await this.maintenance(false, 'nightly backup', run.startedAt);
            await this.publish(true);
        }
    }

    async snapshotRun(run) {
        await this.maintenance(true, `backup of ${run.sets.join(', ')} (${run.tag})`, run.startedAt);
        try {
            await this.ensureRepo();
            for (const name of run.sets) {
                if (this.stopped) throw new Error('stopped');
                const set = this.setByName(name);
                if (!set) throw new Error(`no set ${name}`);
                run.results[name] = await this.copySet(run, set, [run.tag ?? 'manual']);
                if (!run.results[name].ok) throw new Error(`${name}: ${run.results[name].error}`);
            }
            await this.refreshSnapshots().catch((err) => this.log(`listing snapshots: ${errMsg(err)}`));
            await this.endRun(run, true);
        } catch (err) {
            await this.startStopped(run);
            await this.endRun(run, false, errMsg(err));
            this.log(`snapshot (${run.tag}) failed: ${errMsg(err)}`);
        } finally {
            await this.maintenance(false, `backup of ${run.sets.join(', ')}`, run.startedAt);
            await this.publish(true);
        }
    }

    async restoreRun(run) {
        const set = this.setByName(run.sets[0]);
        await this.maintenance(
            true,
            `restore of ${run.sets[0]} from snapshot ${run.snapshot?.slice(0, 8)}`,
            run.startedAt,
        );
        try {
            if (!set) throw new Error(`no set ${run.sets[0]}`);
            await this.ensureRepo();
            await this.stopSet(run, set);
            const before = await this.backupSet(run, set, ['pre-restore']);
            run.results['(before)'] = before;
            if (!before.ok) throw new Error(`could not keep a copy of the current data first: ${before.error}`);
            run.phase = `restoring ${set.name}`;
            this.journal(run);
            const empty = set.paths
                .map(
                    (p) =>
                        `if [ -d ${q(`/src/${p}`)} ]; then find ${q(`/src/${p}`)} -mindepth 1 -delete; else rm -f ${q(`/src/${p}`)}; fi`,
                )
                .join('\n');
            const r = await this.runScript(`${empty}\nr restore ${run.snapshot} --target /`);
            if (r.exit !== 0) throw new Error(`restic restore exit ${r.exit}: ${gist(r.log)}`);
            run.results[set.name] = {ok: true, snapshot: run.snapshot, note: 'restored'};
            if (!run.keepStopped) await this.startStopped(run, set);
            await this.refreshSnapshots().catch((err) => this.log(`listing snapshots: ${errMsg(err)}`));
            await this.endRun(run, true);
            this.log(`${set.name}: restored snapshot ${run.snapshot?.slice(0, 8)}`);
        } catch (err) {
            await this.startStopped(run);
            await this.endRun(run, false, errMsg(err));
            this.log(`restore of ${run.sets[0]} failed: ${errMsg(err)}`);
        } finally {
            await this.maintenance(false, `restore of ${run.sets[0]}`, run.startedAt);
            await this.publish(true);
        }
    }

    // --- Status ---

    statusNow() {
        if (this.current) return ['running', `${this.current.kind}: ${this.current.phase}`];
        const repo = this.repoInfo ? `; repository ${this.repoInfo.usedGb} GB, ${this.repoInfo.freeGb} GB free` : '';
        if (this.repoInfo && this.repoInfo.freeGb < this.cfg.minFreeGb)
            return [
                'error',
                `the disk under the repository has ${this.repoInfo.freeGb} GB left (less than ${this.cfg.minFreeGb})`,
            ];
        if (!this.runnerReady) return ['degraded', 'the restic runner has not answered yet'];
        if (!this.cfg.on) return ['idle', `nightly runs are off; snapshots and restores on request work${repo}`];
        if (!this.lastNightly) return ['idle', `waiting for the first night (${this.cfg.at})${repo}`];
        const ageH = (Date.now() - Date.parse(this.lastNightly.at)) / 3_600_000;
        if (!this.lastNightly.ok)
            return [
                'error',
                `the last nightly run (${this.lastNightly.at}) failed for ${this.lastNightly.failed.join(', ')}${repo}`,
            ];
        if (ageH > this.cfg.staleHours)
            return [
                'error',
                `no successful nightly backup since ${this.lastNightly.at} (${Math.round(ageH)} h)${repo}`,
            ];
        return [
            'idle',
            `last night (${this.lastNightly.at}): ${this.lastNightly.sets} sets, ${mb(this.lastNightly.added)} MB new, ${this.lastNightly.seconds} s${repo}`,
        ];
    }

    briefRun(r) {
        return {
            id: r.id,
            kind: r.kind,
            tag: r.tag,
            sets: r.sets,
            started_at: r.startedAt,
            ended_at: r.endedAt,
            ok: r.ok,
            error: r.error,
            phase: r.phase,
            stopped: r.stopped,
            results: r.results,
            done: r.phase === 'done',
        };
    }

    briefSnapshot(s) {
        return {
            id: s.id,
            short_id: s.short_id,
            time: s.time,
            set: this.setTagOf(s),
            tags: s.tags.filter((t) => !t.startsWith('set:')),
        };
    }

    async publish(force = false) {
        const [level, message] = this.statusNow();
        this.status = {level, message};
        const state = {
            on: this.cfg.on,
            at: this.cfg.at,
            repository: this.cfg.repository,
            sets: this.sets.map((s) => ({
                ...s,
                last: (() => {
                    const n = this.newestOf(s.name);
                    return n ? this.briefSnapshot(n) : null;
                })(),
            })),
            last_nightly: this.lastNightly,
            repository_info: this.repoInfo,
            status: this.status,
            current: this.current ? this.briefRun(this.current) : null,
            runs: this.runs.slice(-10).map((r) => this.briefRun(r)),
        };
        const text = JSON.stringify(state);
        if (!force && text === this.lastPublished) return;
        this.lastPublished = text;
        await this.soft('publishing the state', this.bus.state({...state, updated: new Date().toISOString()}));
    }

    // --- Cycle ---

    async cycle() {
        if (this.stopped || this.current) return;
        const now = localParts(this.cfg.tz);
        const at = toMinutes(this.cfg.at);
        if (
            this.cfg.on &&
            this.runnerReady &&
            now.date !== this.lastNightlyDate &&
            now.minutes >= at &&
            now.minutes < at + 120
        ) {
            const busy = this.bus.otherWork();
            if (busy.length > 0) {
                this.log(`the nightly run waits: planned work by ${busy.join(', ')} is in progress`);
            } else {
                this.lastNightlyDate = now.date;
                await this.soft('saving the run date', this.store.set('last_nightly_date', this.lastNightlyDate));
                await this.refreshSets().catch((err) => this.log(`reading the sets: ${errMsg(err)}`));
                await this.nightly();
                return;
            }
        }
        if (!this.runnerReady) this.probeRunner();
        await this.publish();
    }

    probeRunner() {
        if (this.probing) return;
        this.probing = true;
        this.ensureRepo()
            .then(() => this.refreshSnapshots())
            .then(() => this.publish(true))
            .catch((err) => this.log(`the runner is not ready: ${errMsg(err)}`))
            .finally(() => {
                this.probing = false;
            });
    }

    // --- The API (the port the updates engine and the deploy use) ---

    setsInfo() {
        return {sets: this.sets, by_service: byService(this.sets, this.cfg.selfService), ready: this.runnerReady};
    }

    /** Which sets a request names, by set or by service. */
    setsFor({services, sets}) {
        const names = new Set();
        for (const s of Array.isArray(sets) ? sets.map(String) : []) {
            if (!this.setByName(s)) throw new RequestError(400, `no set named ${s}`);
            names.add(s);
        }
        for (const svc of Array.isArray(services) ? services.map(String) : []) {
            const set = this.setOfService(svc);
            if (!set) throw new RequestError(400, `${svc} keeps no data (no set)`);
            names.add(set.name);
        }
        return this.sets.filter((s) => names.has(s.name)).map((s) => s.name);
    }

    startRun(run) {
        const work = run.kind === 'restore' ? this.restoreRun(run) : this.snapshotRun(run);
        work.catch((err) => this.log(`${run.kind} ${run.id} crashed: ${errMsg(err)}`));
    }

    /** A copy of some sets on request, tagged; `start: false` leaves the containers stopped for a deploy about to recreate them. */
    snapshot({services, sets, tag, start} = {}) {
        if (this.current)
            throw new RequestError(409, `busy with ${this.current.kind} ${this.current.id} (${this.current.phase})`);
        if (!this.runnerReady) throw new RequestError(503, 'the restic runner is not ready');
        const t = typeof tag === 'string' && tag ? tag : 'manual';
        if (!SAFE_TAG.test(t)) throw new RequestError(400, 'tag: letters, digits, . _ : + - only');
        const picked = this.setsFor({services, sets});
        if (picked.length === 0) throw new RequestError(400, 'name services or sets');
        const run = this.newRun('snapshot', picked, {tag: t, keepStopped: start === false});
        this.startRun(run);
        return {job: run.id, sets: run.sets, stop: run.sets.flatMap((n) => this.setByName(n)?.stop ?? [])};
    }

    restore({set, snapshot, start} = {}) {
        if (this.current)
            throw new RequestError(409, `busy with ${this.current.kind} ${this.current.id} (${this.current.phase})`);
        if (!this.runnerReady) throw new RequestError(503, 'the restic runner is not ready');
        const s = this.setByName(String(set ?? ''));
        if (!s) throw new RequestError(400, `no set named ${String(set)}`);
        const wanted = String(snapshot ?? '');
        const snap =
            wanted === 'latest'
                ? this.newestOf(s.name)
                : (this.snapshotList.find((x) => x.id === wanted || x.short_id === wanted) ?? null);
        if (!snap || !SAFE_ID.test(snap.id)) throw new RequestError(400, `no snapshot ${wanted}`);
        if (this.setTagOf(snap) !== s.name)
            throw new RequestError(
                400,
                `snapshot ${snap.short_id} belongs to set ${this.setTagOf(snap)}, not ${s.name}`,
            );
        if (s.stop.length === 0 && s.services.length > 0)
            throw new RequestError(
                409,
                `${s.name} is copied live and cannot be restored under a running service; stop ${s.services.join(', ')} first`,
            );
        const run = this.newRun('restore', [s.name], {snapshot: snap.id, keepStopped: start === false});
        this.startRun(run);
        return {job: run.id, set: run.sets[0], snapshot: run.snapshot};
    }

    job(id) {
        const run = (this.current?.id === id ? this.current : null) ?? this.runs.find((r) => r.id === id) ?? null;
        return run ? this.briefRun(run) : null;
    }

    async snapshots({set, tag, since, refresh} = {}) {
        if (refresh && !this.current) await this.refreshSnapshots().catch(() => undefined);
        return this.snapshotList
            .filter(
                (s) =>
                    (!tag || s.tags.includes(tag)) && (!set || this.setTagOf(s) === set) && (!since || s.time >= since),
            )
            .map((s) => this.briefSnapshot(s));
    }

    backupNow({set, tag} = {}) {
        return this.snapshot({
            sets: typeof set === 'string' ? [set] : this.sets.map((s) => s.name),
            tag: typeof tag === 'string' ? tag : 'manual',
        });
    }

    // --- Lifecycle ---

    async start() {
        const saved = async (key, fallback) => (await this.store.get(key).catch(() => null)) ?? fallback;
        this.stopped = false;
        this.current = null;
        this.runnerReady = false;
        this.probing = false;
        this.lastPublished = '';
        this.runs = await saved('runs', []);
        this.lastNightly = await saved('last_nightly', null);
        this.lastNightlyDate = await saved('last_nightly_date', '');
        this.lastCheckAt = await saved('last_check', 0);
        fs.mkdirSync(this.jobsDir, {recursive: true});

        const left = readJson(fs, this.journalFile);
        if (left) {
            this.log(
                `a ${left.kind} run (${left.id}, ${left.phase}) was cut short by a restart; starting ${left.stopped.join(', ') || 'nothing'} again`,
            );
            await this.startStopped(left);
            await this.endRun(left, false, `restarted during "${left.phase}"`);
        }
        try {
            await this.refreshSets();
            this.log(
                `${this.sets.length} sets: ${this.sets.map((s) => `${s.name} [${s.paths.join(', ')}]${s.stop.length ? '' : ' (live)'}`).join('; ')}`,
            );
        } catch (err) {
            this.status = {level: 'error', message: `cannot derive the sets: ${errMsg(err)}`};
        }
        this.probeRunner();
        await this.publish(true);
        this.timer = setInterval(() => {
            this.cycle().catch((err) => this.log(`cycle failed: ${errMsg(err)}`));
        }, 60_000);
        this.timer.unref?.();
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
