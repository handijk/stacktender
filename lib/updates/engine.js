/**
 * The update loop: scan, decide, apply one at a time, verify, roll back; proposals for what a
 * person decides; undo of what was applied, also days later. Every step of an apply is written
 * to a journal before it is taken, so the same code finishes an apply that a restart cut in two.
 *
 * Everything outside this process goes through ports handed to the constructor: the repository,
 * Docker, the backups, the store, the bus (events, state, the maintenance signal), the scanner
 * and the hooks. The tests hand in fakes.
 */

import fs from 'node:fs';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {applyPersisted, buildItems, resolvePins} from './findings.js';
import {errMsg, inWindow, readJson, removeFile, shortVersion} from './refs.js';
import {HandOver, verify} from './verify.js';

export class DeployFailedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DeployFailedError';
    }
}

/** The line or two of a failed deploy's output that say why, without the hook's own chatter. */
function deployErrorGist(output) {
    const lines = String(output)
        .split('\n')
        .map((l) => l.replace(/^(deploy failed:\s*)?(remote:\s*)?/, '').trim())
        .filter(Boolean);
    const telling = lines.filter(
        (l) =>
            /error|denied|not found|unknown|failed|invalid|no such/i.test(l) &&
            !/^\[deploy\] (plan|docker compose up failed)/.test(l),
    );
    const gist = (telling.length ? telling : lines.slice(-2)).slice(-2).join(' | ').slice(0, 240);
    return gist ? `: ${gist}` : '';
}

const restoredSummary = (r) =>
    r && Object.keys(r).length
        ? Object.entries(r)
              .map(([set, what]) => `${set}: ${what}`)
              .join('; ')
        : '';

export class Updates {
    constructor({cfg, dataDir, repo, docker, backups, store, bus, scanner, hooks = {}, log = () => {}}) {
        this.cfg = cfg;
        this.dataDir = dataDir;
        this.repo = repo;
        this.docker = docker;
        this.backups = backups;
        this.store = store;
        this.bus = bus;
        this.scanner = scanner;
        this.hooks = hooks;
        this.log = log;
        this.files = {
            journal: path.join(dataDir, 'apply.json'),
            outbox: path.join(dataDir, 'events-outbox.json'),
            deployRollback: path.join(dataDir, 'deploy-rollback.json'),
        };
        this.items = [];
        this.persisted = {};
        this.history = [];
        this.services = {};
        this.reportMtime = 0;
        this.reportReadAt = 0;
        this.lastScanRequest = 0;
        this.lastApplyAt = 0;
        this.lastAnnounceAt = 0;
        this.digestAppliedAt = {};
        this.lastHousekeeping = null;
        this.busy = false;
        this.stopped = false;
        this.timer = null;
        this.status = {level: 'starting', message: 'waiting for the first scan'};
    }

    // --- Bookkeeping that must not hold up an apply ---

    async soft(what, work) {
        let timer;
        try {
            await Promise.race([
                work,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('no answer in 10 s')), 10_000);
                }),
            ]);
            return true;
        } catch (err) {
            this.log(`${what} failed (${errMsg(err)}); carrying on`);
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Events wait in a file until the bus has taken them: the result of an update must reach its readers even when the bus was what restarted. */
    async emit(event) {
        const waiting = readJson(fs, this.files.outbox) ?? [];
        if (event) waiting.push(event);
        while (waiting.length > 0) {
            fs.writeFileSync(this.files.outbox, JSON.stringify(waiting));
            if (
                !(await this.soft(
                    `publishing the ${waiting[0].type} event`,
                    this.bus.event(waiting[0].type, waiting[0]),
                ))
            )
                return;
            waiting.shift();
        }
        removeFile(fs, this.files.outbox);
    }

    setStatus(level, message) {
        this.status = {level, message};
    }

    // --- The list ---

    brief(i) {
        return {
            id: i.id,
            kind: i.kind,
            name: i.name,
            current: shortVersion(i.current),
            target: shortVersion(i.target),
            type: i.updateType,
            why: i.reason,
            released: i.released?.slice(0, 10) ?? null,
            services: i.services,
            files: i.files,
            source: i.sourceUrl,
            policy: i.policy,
            state: i.state,
            can_try_with_rollback: i.edits.length > 0,
            ...(i.assessment
                ? {assessment: {verdict: i.assessment.verdict, on: i.assessment.at.slice(0, 10), why: i.assessment.why}}
                : {}),
        };
    }

    async publish() {
        const count = (pred) => this.items.filter(pred).length;
        const ask = count((i) => i.policy === 'ask' && i.state !== 'dismissed');
        const queued = count((i) => i.policy === 'silent' && (i.state === 'pending' || i.state === 'waiting'));
        const held = count((i) => i.policy === 'hold');
        const stuck = this.items.find((i) => i.state === 'failed' && /rollback failed/.test(i.note ?? ''));
        const undone = this.busy ? null : readJson(fs, this.files.deployRollback);
        const staleMs = Date.now() - (this.reportMtime || 0);
        if (undone) {
            this.setStatus(
                'error',
                `${undone.service ?? 'a service'} runs its previous image again: the push ${String(undone.sha ?? '?').slice(0, 8)} did not start (${undone.reason ?? 'no reason given'}). The repository is ahead of what runs.`,
            );
        } else if (stuck) {
            this.setStatus(
                'error',
                `${stuck.name} ${stuck.current} → ${stuck.target} did not come up healthy and the rollback failed (${stuck.note}). The repository may still pin the new version.`,
            );
        } else if (!this.reportMtime) {
            this.setStatus('starting', 'waiting for the first scan');
        } else if (staleMs > this.cfg.scanIntervalHours * 3 * 3_600_000) {
            this.setStatus(
                'error',
                `the scanner has produced no report for ${Math.round(staleMs / 3_600_000)} h (expected every ${this.cfg.scanIntervalHours} h)`,
            );
        } else {
            this.setStatus(
                'running',
                `${ask} waiting for a decision, ${queued} queued to apply silently${this.cfg.autopilot ? '' : ' (autopilot is off)'}, ${held} held; last scan ${new Date(this.reportMtime).toISOString()}`,
            );
        }
        await this.soft(
            'publishing the state',
            this.bus.state({
                updated: new Date().toISOString(),
                last_scan: this.reportMtime ? new Date(this.reportMtime).toISOString() : null,
                autopilot: this.cfg.autopilot,
                apply_window: this.cfg.applyWindow,
                infra_window: this.cfg.infraWindow,
                digests: this.cfg.digests,
                status: this.status,
                summary: {
                    total: this.items.length,
                    need_decision: ask,
                    queued_silent: queued,
                    held,
                    dismissed: count((i) => i.state === 'dismissed'),
                },
                items: this.items.map(({edits: _e, places: _p, ...rest}) => ({
                    ...rest,
                    current: shortVersion(rest.current),
                    target: shortVersion(rest.target),
                })),
                history: this.history.slice(-20),
            }),
        );
    }

    async announce() {
        const fresh = this.items.filter(
            (i) => i.policy === 'ask' && i.state !== 'dismissed' && !this.persisted[i.id]?.announced,
        );
        if (fresh.length === 0) return;
        if (Date.now() - this.lastAnnounceAt < this.cfg.announceIntervalHours * 3_600_000) return;
        await this.bus.event('needs_decision', {
            type: 'needs_decision',
            at: new Date().toISOString(),
            count: fresh.length,
            also_open: this.items.filter(
                (i) => i.policy === 'ask' && i.state !== 'dismissed' && this.persisted[i.id]?.announced,
            ).length,
            items: fresh.map((i) => this.brief(i)),
        });
        for (const i of fresh)
            this.persisted[i.id] = {
                ...this.persisted[i.id],
                announced: true,
                announcedAt: new Date().toISOString(),
                at: this.persisted[i.id]?.at ?? new Date().toISOString(),
            };
        this.lastAnnounceAt = Date.now();
        await this.store.set('persisted', this.persisted);
        await this.store.set('last_announce', this.lastAnnounceAt);
        this.log(`announced ${fresh.length} finding(s) needing a decision`);
    }

    // --- Scanning ---

    requestScan() {
        this.lastScanRequest = Date.now();
        this.scanner.request();
    }

    async loadReport() {
        const got = this.scanner.report();
        if (!got) return false;
        if (got.mtime === this.reportMtime && Date.now() - this.reportReadAt < 30 * 60_000) return false;
        const compose = await this.repo.read('docker-compose.yaml');
        this.services = {};
        if (compose) {
            const doc = parseYaml(compose);
            for (const [n, s] of Object.entries(doc?.services ?? {}))
                this.services[n] = {image: s.image ?? null, owner: s['x-automation'] ?? 'root'};
        }
        const {items: built} = buildItems(got.report, this.services, this.cfg);
        await resolvePins(built, this.cfg, this.docker);
        this.items = applyPersisted(built, this.persisted, this.cfg);
        const live = new Set(this.items.map((i) => i.id));
        const undoable = (p) => p.applied !== undefined && Date.now() - Date.parse(p.applied.at) < 15 * 86_400_000;
        for (const [id, p] of Object.entries(this.persisted))
            if (!live.has(id) && !undoable(p)) delete this.persisted[id];
        await this.store.set('persisted', this.persisted);
        this.reportMtime = got.mtime;
        this.reportReadAt = Date.now();
        return true;
    }

    // --- Choosing what to apply ---

    isInfra(item) {
        return item.services.some((s) => this.cfg.infraServices.includes(s));
    }

    windowFor(item) {
        return this.isInfra(item) ? this.cfg.infraWindow : this.cfg.applyWindow;
    }

    rebuiltRecently(i) {
        return (
            i.updateType === 'digest' &&
            Date.now() - (this.digestAppliedAt[i.name] ?? 0) < this.cfg.digestIntervalDays * 86_400_000
        );
    }

    dueNow(i) {
        return (
            i.policy === 'silent' &&
            i.state === 'pending' &&
            i.edits.length > 0 &&
            inWindow(this.windowFor(i), this.cfg.tz) &&
            !this.rebuiltRecently(i)
        );
    }

    nextToApply() {
        if (this.bus.otherWork().length > 0) return null;
        const forced = this.items.find(
            (i) =>
                this.persisted[i.id]?.forced &&
                i.edits.length > 0 &&
                (i.state === 'pending' || i.state === 'waiting' || i.state === 'failed'),
        );
        if (forced) return forced;
        if (!this.cfg.autopilot) return null;
        if (Date.now() - this.lastApplyAt < this.cfg.minGapMinutes * 60_000) return null;
        return this.items.find((i) => this.dueNow(i)) ?? null;
    }

    // --- Applying ---

    async setItemState(item, state, note) {
        for (const it of [item, this.items.find((i) => i.id === item.id)]) {
            if (it) {
                it.state = state;
                it.note = note;
            }
        }
        this.persisted[item.id] = {
            ...this.persisted[item.id],
            state,
            note,
            at: new Date().toISOString(),
            forced: false,
            queued: false,
        };
        await this.soft("saving the update's state", this.store.set('persisted', this.persisted));
        await this.soft('publishing the list', this.publish());
    }

    async recordResult(item, result, detail, sha, startedAt) {
        this.history.push({
            at: new Date().toISOString(),
            name: item.name,
            from: shortVersion(item.current) ?? '?',
            to: shortVersion(item.target) ?? '?',
            result,
            ...(detail ? {detail} : {}),
            ...(sha ? {sha} : {}),
            ...(startedAt ? {startedAt} : {}),
            services: item.services,
        });
        this.history = this.history.slice(-50);
        await this.soft('saving the history', this.store.set('history', this.history));
    }

    /** Whether a set of edits is in the repo: true when every place holds the new text, false when every place holds the old, null when it cannot be told. */
    async landed(edits) {
        const holds = (text, what) =>
            new RegExp(what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9._-])').test(text);
        let yes = 0;
        let no = 0;
        for (const e of edits) {
            const text = await this.repo.read(e.file).catch(() => null);
            if (text === null) return null;
            if (holds(text, e.replace)) yes++;
            else if (holds(text, e.find)) no++;
            else return null;
        }
        return yes === edits.length ? true : no === edits.length ? false : null;
    }

    async backupsJob(id, minutes = 20) {
        const deadline = Date.now() + minutes * 60_000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5_000));
            if (this.stopped) throw new HandOver();
            const job = await Promise.resolve(this.backups.job(id)).catch(() => null);
            if (job?.done) return {ok: job.ok === true, error: job.error, stopped: job.stopped};
        }
        return {ok: false, error: `the backups job ${id} did not finish in ${minutes} min`};
    }

    /**
     * Put the deploy's copies back under every set the update touched, and leave the sets stopped
     * for the deploy of the old pin. A set without a copy is named with the reason; a restore
     * that fails is reported, not fatal.
     */
    async restoreBefore(job) {
        const out = {};
        const item = job.item;
        if (item.services.length === 0) return out;
        const sets = await Promise.resolve(this.backups.sets()).catch(() => null);
        if (!sets?.by_service) {
            for (const s of item.services) out[s] = 'no backups answered';
            return out;
        }
        for (const set of new Set(item.services.map((s) => sets.by_service[s]).filter(Boolean))) {
            const list = await Promise.resolve(this.backups.snapshots({set, since: job.startedAt})).catch(() => []);
            const copies = (list ?? []).filter((s) => s.tags.some((t) => t.startsWith('deploy:')));
            const copy = (job.sha && copies.find((s) => s.tags.includes(`deploy:${job.sha}`))) || copies.pop();
            if (!copy) {
                out[set] = 'no copy from before the update was found';
                this.log(`${set}: ${out[set]}`);
                continue;
            }
            try {
                const started = await this.backups.restore({set, snapshot: copy.id, start: false});
                const result = await this.backupsJob(started.job);
                out[set] = result.ok
                    ? `restored ${copy.id.slice(0, 8)} (${copy.time})`
                    : `restore of ${copy.id.slice(0, 8)} failed: ${result.error}`;
            } catch (err) {
                if (err instanceof HandOver) throw err;
                out[set] = `restore of ${copy.id.slice(0, 8)} failed: ${errMsg(err)}`;
            }
            this.log(`${set}: ${out[set]}`);
        }
        return out;
    }

    async applyItem(item) {
        this.busy = true;
        const before = await this.docker.containers(item.services).catch(() => new Map());
        await this.runApply(
            {item: {...item}, phase: 'pushing', before: [...before], startedAt: new Date().toISOString()},
            false,
        );
    }

    /** One update from push to verdict. */
    async runApply(job, resumed) {
        this.busy = true;
        const item = job.item;
        const label = `${item.name} ${shortVersion(item.current)} → ${shortVersion(item.target)}`;
        const newImage = item.kind === 'image' ? `${item.name}:${item.target}` : '';
        const oldImage = item.kind === 'image' && !job.revertSha ? `${item.name}:${item.current}` : '';
        const before = new Map(job.before);
        const inverse = item.edits.map((e) => ({
            file: e.file,
            find: e.replace,
            replace: e.find,
            wholeToken: e.wholeToken,
        }));
        const verb = item.updateType === 'pinDigest' ? 'pin' : item.updateType === 'digest' ? 'refresh' : 'bump';
        const step = (phase, problem) => {
            job.phase = phase;
            if (problem) job.problem = problem;
            fs.writeFileSync(this.files.journal, JSON.stringify(job));
        };
        const setState = (state, note) => this.setItemState(item, state, note);
        const record = (result, detail) => this.recordResult(item, result, detail, job.sha, job.startedAt);
        const verifyNow = (image, services) =>
            verify({
                docker: this.docker,
                services,
                image,
                before,
                deployTimeoutMs: this.cfg.deployTimeoutMinutes * 60_000,
                soakMs: this.cfg.soakMinutes * 60_000,
                stopped: () => this.stopped,
            });

        await this.soft(
            'the maintenance signal',
            this.bus.maintenance(true, {
                what: `${verb} ${label}`,
                type: item.updateType,
                services: item.services,
                since: job.startedAt,
                resumed,
            }),
        );
        try {
            if (job.phase === 'pushing') {
                if (resumed) {
                    let did = await this.landed(item.edits);
                    for (
                        let i = 0;
                        did === false && i < 6 && Date.now() - Date.parse(job.startedAt) < 5 * 60_000;
                        i++
                    ) {
                        await new Promise((r) => setTimeout(r, 20_000));
                        if (this.stopped) throw new HandOver();
                        did = await this.landed(item.edits);
                    }
                    if (did === false) {
                        removeFile(fs, this.files.journal);
                        await setState('pending', 'restarted before the change was pushed');
                        return;
                    }
                    if (did === null) throw new Error('cannot tell from the repository whether the change landed');
                    this.log(`resuming ${label}: the change was pushed before the restart`);
                } else {
                    step('pushing');
                    await setState('applying');
                    this.log(`applying ${label} (${item.updateType}; ${item.files.join(', ')})`);
                    try {
                        job.sha = await this.repo.change(item.edits, `${verb} ${label} (${item.updateType})`);
                    } catch (err) {
                        if (this.stopped) throw new HandOver();
                        if (err?.name !== 'DeployFailedError') {
                            removeFile(fs, this.files.journal);
                            this.log(`could not apply ${label}: ${errMsg(err)}`);
                            await setState('pending', `last attempt did not land: ${errMsg(err).slice(0, 200)}`);
                            return;
                        }
                        job.problem = `the deploy failed${deployErrorGist(errMsg(err))}`;
                    }
                    if (this.stopped) throw new HandOver();
                }
                step('verifying');
            }

            if (job.phase === 'verifying') {
                await setState('verifying');
                const undone = readJson(fs, this.files.deployRollback);
                if (undone && item.services.includes(String(undone.service)))
                    job.problem ??= `${undone.service} did not start on the new image and the deploy put the previous one back (${undone.reason ?? 'no reason given'})`;
                let problem = job.problem ?? (await verifyNow(newImage, item.services));
                if (!problem && this.hooks.veto && item.services.length > 0) {
                    const answer = await Promise.resolve(
                        this.hooks.veto({
                            name: item.name,
                            from: item.current,
                            to: item.target,
                            services: item.services,
                            sha: job.sha,
                        }),
                    ).catch((err) => ({ok: true, why: `veto hook failed: ${errMsg(err)}`}));
                    if (answer && answer.ok === false) problem = `vetoed: ${answer.why ?? 'no reason given'}`;
                }
                if (!problem) {
                    removeFile(fs, this.files.journal);
                    await record(
                        'applied',
                        item.assessment
                            ? `the assessor read the release notes first (${item.assessment.verdict}): ${item.assessment.why ?? ''}`
                            : undefined,
                    );
                    await setState('applied');
                    if (item.services.length > 0 && item.updateType !== 'digest' && item.updateType !== 'pinDigest') {
                        this.persisted[item.id] = {
                            ...this.persisted[item.id],
                            applied: {
                                item: {...item, places: undefined},
                                startedAt: job.startedAt,
                                sha: job.sha,
                                at: new Date().toISOString(),
                            },
                        };
                        await this.soft('saving what undo needs', this.store.set('persisted', this.persisted));
                    }
                    if (item.updateType === 'digest' || item.updateType === 'pinDigest') {
                        this.digestAppliedAt[item.name] = Date.now();
                        await this.soft(
                            'saving the rebuild cadence',
                            this.store.set('digest_applied', this.digestAppliedAt),
                        );
                    }
                    await this.emit({
                        type: 'applied',
                        at: new Date().toISOString(),
                        item: this.brief(item),
                        undo:
                            item.services.length > 0
                                ? `undo ${item.id} puts the data copied before the update back and the old version with it`
                                : null,
                    });
                    this.log(`applied ${label}`);
                    return;
                }
                this.log(`${label} failed verification (${problem}); rolling back`);
                step('rolling_back', problem);
            }

            const problem = job.problem ?? 'did not come up healthy';
            try {
                if (!(resumed && inverse.length > 0 && (await this.landed(inverse)) === true)) {
                    if (!job.restored) {
                        job.restored = await this.restoreBefore(job);
                        step('rolling_back');
                    }
                    if (job.revertSha) await this.repo.revert(job.revertSha);
                    else
                        await this.repo.change(
                            inverse,
                            `roll back ${item.name} ${shortVersion(item.target)} → ${shortVersion(item.current)}: ${problem.slice(0, 120)}`,
                        );
                }
                if (this.stopped) throw new HandOver();
                removeFile(fs, this.files.deployRollback);
                const back = await verifyNow(oldImage, item.services);
                removeFile(fs, this.files.journal);
                const data = restoredSummary(job.restored);
                await record(
                    'rolled_back',
                    problem + (data ? ` | data: ${data}` : '') + (back ? ` | after rollback: ${back}` : ''),
                );
                if (this.persisted[item.id]?.applied)
                    this.persisted[item.id] = {...this.persisted[item.id], applied: undefined};
                await setState('failed', problem);
                await this.emit({
                    type: 'rolled_back',
                    at: new Date().toISOString(),
                    item: this.brief(item),
                    problem,
                    data: data || 'no data to put back',
                    after_rollback: back ?? 'back on the previous version and healthy',
                    undo: job.undo === true,
                });
            } catch (err) {
                if (err instanceof HandOver || this.stopped) throw new HandOver();
                const msg = errMsg(err);
                removeFile(fs, this.files.journal);
                await record('rollback_failed', `${problem}; ${msg}`);
                await setState('failed', `${problem}; rollback failed: ${msg}`);
                await this.emit({
                    type: 'rollback_failed',
                    at: new Date().toISOString(),
                    item: this.brief(item),
                    problem,
                    rollback_error: msg,
                });
                this.setStatus(
                    'error',
                    `${label} did not come up healthy (${problem}) and the rollback failed: ${msg}. The repository still pins the new version.`,
                );
            }
        } catch (err) {
            if (err instanceof HandOver) {
                this.log(`${label}: stopped mid-apply; the next instance carries on from the journal`);
                return;
            }
            const msg = errMsg(err);
            removeFile(fs, this.files.journal);
            this.log(`${label} was left unfinished: ${msg}`);
            await setState(
                'failed',
                `the apply was interrupted (${msg.slice(0, 200)}); check that ${item.services.join(', ') || 'the service'} is healthy and which version the repository pins`,
            );
            await this.emit({
                type: 'rollback_failed',
                at: new Date().toISOString(),
                item: this.brief(item),
                problem: `the apply was interrupted: ${msg}`,
                rollback_error: 'not attempted',
            });
        } finally {
            if (!this.stopped) {
                this.busy = false;
                this.lastApplyAt = Date.now();
                await this.soft(
                    'the maintenance signal',
                    this.bus.maintenance(false, {
                        what: `${verb} ${label}`,
                        result: item.state,
                        since: job.startedAt,
                        at: new Date().toISOString(),
                    }),
                );
                await this.soft('saving the apply time', this.store.set('last_apply', this.lastApplyAt));
                this.requestScan();
            }
        }
    }

    // --- Housekeeping ---

    housekeepingDue() {
        const h = this.cfg.housekeeping;
        return (
            h.on &&
            !this.busy &&
            inWindow(this.cfg.infraWindow, this.cfg.tz) &&
            this.bus.otherWork().length === 0 &&
            Date.now() - (this.lastHousekeeping ? Date.parse(this.lastHousekeeping.at) : 0) >
                h.intervalDays * 86_400_000
        );
    }

    async housekeep() {
        try {
            const r = await this.docker.pruneImages(this.cfg.housekeeping.keepDays);
            this.lastHousekeeping = {at: new Date().toISOString(), images: r.images, bytes: r.bytes};
            this.log(`housekeeping: removed ${r.images} unused image(s), ${Math.round(r.bytes / 1e8) / 10} GB`);
        } catch (err) {
            this.log(`housekeeping failed: ${errMsg(err)}`);
            this.lastHousekeeping = {at: new Date().toISOString(), images: 0, bytes: 0};
        }
        await this.soft('saving the housekeeping result', this.store.set('last_housekeeping', this.lastHousekeeping));
    }

    // --- The cycle ---

    async cycle() {
        if (this.busy) return;
        if (fs.existsSync(this.files.outbox)) await this.emit();
        if (Date.now() - Math.max(this.reportMtime, this.lastScanRequest) > this.cfg.scanIntervalHours * 3_600_000)
            this.requestScan();
        if (await this.loadReport()) {
            this.log(
                `report loaded: ${this.items.length} finding(s), ${this.items.filter((i) => i.policy === 'ask' && i.state !== 'dismissed').length} need a decision, ${this.items.filter((i) => i.policy === 'silent').length} silent`,
            );
        }
        await this.publish();
        await this.announce();
        if (this.busy) return;
        const next = this.nextToApply();
        if (next) {
            void this.applyItem(next).catch((err) => this.log(`apply of ${next.name} crashed: ${errMsg(err)}`));
            return;
        }
        if (this.housekeepingDue()) void this.housekeep();
    }

    // --- The API ---

    list({only = 'all'} = {}) {
        const items = this.items.filter(
            (i) =>
                only === 'all' ||
                (only === 'need_decision' && i.policy === 'ask' && i.state !== 'dismissed') ||
                (only === 'silent' && i.policy === 'silent') ||
                (only === 'held' && i.policy === 'hold'),
        );
        return {
            last_scan: this.reportMtime ? new Date(this.reportMtime).toISOString() : null,
            autopilot: this.cfg.autopilot,
            apply_window: this.cfg.applyWindow,
            status: this.status,
            items: items.map((i) => this.brief(i)),
            history: this.history.slice(-20),
        };
    }

    /** Try one finding now, whatever its policy; `inWindow` queues it for its own time instead. */
    async apply(id, {inWindow: later = false} = {}) {
        const item = this.items.find((i) => i.id === String(id));
        if (!item) return {error: 'no such finding (the list may have changed)'};
        if (item.state === 'applying' || item.state === 'verifying') return {error: 'already being applied'};
        if (item.edits.length === 0)
            return {error: 'this one cannot be applied by changing a pin; it needs a change by hand'};
        if (later) {
            this.persisted[item.id] = {
                ...this.persisted[item.id],
                state: undefined,
                note: undefined,
                queued: true,
                forced: false,
                dismissedUntil: undefined,
                at: new Date().toISOString(),
            };
            this.reportReadAt = 0;
            await this.store.set('persisted', this.persisted);
            const w = this.windowFor(item);
            return {
                ok: true,
                note: `queued: tried by itself in its window (${w.from}–${w.to}); only a failure is announced`,
            };
        }
        this.persisted[item.id] = {
            ...this.persisted[item.id],
            forced: true,
            dismissedUntil: undefined,
            at: new Date().toISOString(),
        };
        if (item.state === 'dismissed') item.state = 'pending';
        await this.store.set('persisted', this.persisted);
        return {
            ok: true,
            queued: this.brief(item),
            note: this.busy
                ? 'another update is being applied first'
                : 'starting within a minute; verification takes the soak time plus the deploy',
        };
    }

    /** Take an applied update back: the copy from before it under its services, then the previous version. Without an id: what can be undone. */
    async undo(id) {
        const done = Object.entries(this.persisted)
            .filter(([, p]) => p.applied)
            .map(([key, p]) => ({
                id: key,
                name: p.applied.item.name,
                from: shortVersion(p.applied.item.current),
                to: shortVersion(p.applied.item.target),
                services: p.applied.item.services,
                applied_at: p.applied.at,
            }));
        const commits = this.history
            .filter((h) => h.result === 'applied' && h.sha && h.services?.length)
            .map((h) => ({sha: h.sha, name: h.name, from: h.from, to: h.to, services: h.services, applied_at: h.at}));
        if (typeof id !== 'string' || !id)
            return {
                undoable: done,
                by_commit: commits.slice(-10),
                note: 'call again with the id, or the commit sha, to undo one',
            };
        if (this.busy) return {error: 'another update is being applied; try again when it is done'};
        const p = this.persisted[id];
        const entry = p?.applied
            ? null
            : this.history.find((h) => h.result === 'applied' && h.sha && h.sha.startsWith(id) && id.length >= 7);
        if (!p?.applied && !entry)
            return {
                error: 'no applied update with that id or commit that can be undone',
                undoable: done,
                by_commit: commits.slice(-10),
            };
        const item = p?.applied
            ? {...p.applied.item}
            : {
                  id: `undo-${entry.sha.slice(0, 8)}`,
                  kind: 'image',
                  name: entry.name,
                  files: [],
                  current: entry.from,
                  target: entry.to,
                  updateType: 'undo',
                  released: null,
                  ageDays: null,
                  behindDays: null,
                  sourceUrl: null,
                  services: entry.services ?? [],
                  owners: [],
                  policy: 'ask',
                  reason: 'undone by a person',
                  edits: [],
                  state: 'applied',
              };
        const sha = p?.applied ? p.applied.sha : entry.sha;
        const startedAt = p?.applied
            ? p.applied.startedAt
            : (entry.startedAt ?? new Date(Date.parse(entry.at) - 30 * 60_000).toISOString());
        if (p?.applied && item.edits.length === 0)
            return {error: 'this update changed no pin; it cannot be taken back from here'};
        const sets = await Promise.resolve(this.backups.sets()).catch(() => null);
        const touched = [...new Set(item.services.map((s) => sets?.by_service?.[s]).filter(Boolean))];
        for (const set of touched) {
            const list = await Promise.resolve(this.backups.snapshots({set, since: startedAt})).catch(() => []);
            const has = (list ?? []).some((s) =>
                sha ? s.tags.includes(`deploy:${sha}`) : s.tags.some((t) => t.startsWith('deploy:')),
            );
            if (!has)
                return {
                    error: `no copy of ${set} from before this update exists any more; undoing it now would start the old version on migrated data`,
                };
        }
        const before = await this.docker.containers(item.services).catch(() => new Map());
        void this.runApply(
            {
                item,
                phase: 'rolling_back',
                before: [...before],
                problem: 'undone by a person',
                startedAt,
                sha,
                undo: true,
                ...(p?.applied ? {} : {revertSha: sha}),
            },
            false,
        ).catch((err) => this.log(`undo crashed: ${errMsg(err)}`));
        return {
            ok: true,
            note: `taking ${item.name} back from ${shortVersion(item.target)} to ${shortVersion(item.current)}: the data of ${touched.join(', ') || 'its services'} is put back from the copy taken before the update, then the old version is deployed${p?.applied ? '' : ' by reverting the commit'}`,
        };
    }

    async dismiss(id, {days, reason = ''} = {}) {
        const item = this.items.find((i) => i.id === String(id));
        if (!item) return {error: 'no such finding'};
        const n = days === undefined ? 3650 : Math.max(1, Number(days));
        this.persisted[item.id] = {
            ...this.persisted[item.id],
            dismissedUntil: new Date(Date.now() + n * 86_400_000).toISOString(),
            note: String(reason),
            forced: false,
            at: new Date().toISOString(),
        };
        item.state = 'dismissed';
        item.note = String(reason);
        await this.store.set('persisted', this.persisted);
        await this.publish();
        return {
            ok: true,
            dismissed: item.name,
            until: days === undefined ? 'a newer version appears' : this.persisted[item.id].dismissedUntil,
        };
    }

    scanNow() {
        this.requestScan();
        return {ok: true};
    }

    // --- Lifecycle ---

    async start() {
        const saved = async (key, fallback) => (await this.store.get(key).catch(() => null)) ?? fallback;
        this.persisted = await saved('persisted', {});
        this.history = await saved('history', []);
        this.lastApplyAt = await saved('last_apply', 0);
        this.lastAnnounceAt = await saved('last_announce', 0);
        this.digestAppliedAt = await saved('digest_applied', {});
        this.lastHousekeeping = await saved('last_housekeeping', null);
        this.stopped = false;
        this.busy = false;
        this.items = [];
        this.reportMtime = 0;
        this.reportReadAt = 0;
        this.lastScanRequest = 0;
        fs.mkdirSync(this.dataDir, {recursive: true});

        const journal = readJson(fs, this.files.journal);
        for (const [id, p] of Object.entries(this.persisted)) {
            if ((p.state === 'applying' || p.state === 'verifying') && !(journal && journal.item?.id === id)) {
                this.persisted[id] = {
                    ...p,
                    state: 'failed',
                    note: 'restarted while this update was being applied or verified; check that the service is healthy',
                    announced: false,
                };
            }
        }
        await this.soft("saving the list's state", this.store.set('persisted', this.persisted));
        if (journal?.item?.edits?.length || journal?.revertSha) {
            this.log(`found an apply in flight (${journal.item.name}, ${journal.phase}); carrying on`);
            void this.runApply(journal, true).catch((err) => this.log(`resumed apply crashed: ${errMsg(err)}`));
        } else {
            await this.soft(
                'the maintenance signal',
                this.bus.maintenance(false, {at: new Date().toISOString(), note: 'started with no apply in flight'}),
            );
        }
        this.timer = setInterval(() => {
            this.cycle().catch((err) => this.log(`cycle failed: ${errMsg(err)}`));
        }, 60_000);
        this.timer.unref?.();
        await this.cycle();
        this.log(
            `started: scan every ${this.cfg.scanIntervalHours} h, autopilot ${this.cfg.autopilot ? `on (${this.cfg.applyWindow.from}–${this.cfg.applyWindow.to})` : 'off'}, digests ${this.cfg.digests ? 'on' : 'off'}`,
        );
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
