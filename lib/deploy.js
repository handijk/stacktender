/**
 * The deploy: what makes a commit what runs. Given the previous and the new commit it works out
 * what changed, builds the services whose context changed, runs the test gate, takes a copy of
 * every service that keeps data and is about to run another image, brings the stack up, checks
 * that stacktender's own service came back when it was rebuilt, prunes what Docker no longer
 * uses, and records the last commit that went through so a refused deploy is retried from there.
 *
 * `docker compose` runs in the stack directory as the host sees it: the stack directory is
 * bind-mounted at its own host path, so the relative bind mounts in the compose file resolve.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {dockerRun} from './scanner.js';
import {errMsg} from './updates/refs.js';

const COMPOSE_FILES = ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml'];
const ZERO = '0000000000000000000000000000000000000000';

/** Which services' build contexts the changed files fall into (longest prefix wins). */
export function classify(changed, contexts, {reloadPaths = []} = {}) {
    const build = new Set();
    let composeChanged = false;
    const reload = new Set();
    for (const file of changed) {
        if (COMPOSE_FILES.includes(file)) {
            composeChanged = true;
            continue;
        }
        const r = reloadPaths.find((p) => file.startsWith(p));
        if (r) {
            reload.add(r);
            continue;
        }
        let best = null;
        let bestLen = 0;
        for (const [svc, ctx] of Object.entries(contexts)) {
            const prefix = ctx === '.' ? '' : `${ctx}/`;
            if (prefix && file.startsWith(prefix) && prefix.length > bestLen) {
                best = svc;
                bestLen = prefix.length;
            }
        }
        if (best) build.add(best);
    }
    return {build: [...build].sort(), composeChanged, reload: [...reload]};
}

/** Services whose image reference differs between two compose documents. */
export function imageChanges(oldDoc, newDoc) {
    const out = [];
    const oldServices = oldDoc?.services ?? {};
    for (const [svc, d] of Object.entries(newDoc?.services ?? {})) {
        const o = oldServices[svc];
        if (o?.image && d.image && o.image !== d.image) out.push(svc);
    }
    return out.sort();
}

export class Deploy {
    /**
     * @param {object} a
     * @param {string} a.stackDir
     * @param {string} a.dataDir
     * @param {import('./ports/repo.js').GitRepo} a.repo
     * @param {import('./backups/engine.js').Backups} a.backups
     * @param {object} a.docker port (container(name))
     * @param {object} a.bus view for the source "deploy"
     * @param {object} a.cfg the deploy section plus {selfService, tz}
     * @param {(msg: string) => void} [a.log]
     * @param {(args: string[], opts?: object) => Promise<{code: number, output: string}>} [a.run] `docker <args>`
     * @param {(cmd: string) => Promise<{code: number, output: string}>} [a.shell] for the test gate and reload commands
     */
    constructor({stackDir, dataDir, repo, backups, docker, bus, cfg, log = () => {}, run, shell}) {
        this.stackDir = stackDir;
        this.dataDir = dataDir;
        this.repo = repo;
        this.backups = backups;
        this.docker = docker;
        this.bus = bus;
        this.cfg = cfg;
        this.log = log;
        this.run = run ?? ((args) => dockerRun(args, {cwd: stackDir}));
        this.shell = shell ?? ((cmd) => dockerRun(['compose', 'version']).then(() => shellRun(cmd, stackDir)));
        this.chain = Promise.resolve();
        this.runs = [];
        this.selfRecreateDelayMs = 3000;
        this.markerFile = path.join(dataDir, 'last-deployed-sha');
        this.rollbackFile = path.join(dataDir, 'deploy-rollback.json');
    }

    get lastDeployed() {
        try {
            return fs.readFileSync(this.markerFile, 'utf-8').trim() || null;
        } catch {
            return null;
        }
    }

    /** One deploy at a time. Returns {ok, output, id}. */
    deploy(oldSha, newSha, {reason = ''} = {}) {
        const p = this.chain.then(
            () => this.execute(oldSha, newSha, reason),
            () => this.execute(oldSha, newSha, reason),
        );
        this.chain = p.then(
            () => undefined,
            () => undefined,
        );
        return p;
    }

    async compose(args) {
        return this.run(['compose', ...args]);
    }

    async composeUp(args = []) {
        let r = await this.compose(['up', '-d', ...args]);
        if (r.code === 0) return r;
        this.log('docker compose up failed; retrying once in 10 s');
        await new Promise((res) => setTimeout(res, 10_000));
        r = await this.compose(['up', '-d', ...args]);
        return r;
    }

    async execute(oldSha, newSha, reason) {
        const lines = [];
        const say = (l) => {
            lines.push(l);
            this.log(`deploy: ${l}`);
        };
        const run = {
            id: `deploy-${Date.now().toString(36)}`,
            old: oldSha,
            new: newSha,
            reason,
            startedAt: new Date().toISOString(),
            lines,
            ok: null,
        };
        this.runs = [...this.runs, run].slice(-20);
        const since = run.startedAt;
        const subject = await this.repo.subject(newSha).catch(() => '');
        await this.bus.maintenance(true, {
            what: `deploy ${newSha.slice(0, 8)}${subject ? `: ${subject}` : ''}`,
            since,
            phase: 'preparing',
        });
        let stopped = [];
        let ok = false;
        try {
            say(
                `${String(oldSha ?? '').slice(0, 8) || '(none)'}..${newSha.slice(0, 8)}${subject ? `: ${subject}` : ''}`,
            );
            for (const d of dataDirs(await this.repo.read(composeFile(this.stackDir))))
                fs.mkdirSync(path.join(this.stackDir, d), {recursive: true});
            const valid = await this.compose(['config', '--quiet']);
            if (valid.code !== 0)
                throw new Error(
                    `the compose file at ${newSha.slice(0, 8)} is invalid: ${valid.output.trim().slice(0, 300)}`,
                );

            if (!oldSha || oldSha === ZERO) {
                say('first deploy: everything');
                const r = await this.composeUp(['--build']);
                if (r.code !== 0) throw new Error(`docker compose up failed: ${r.output.trim().slice(-300)}`);
                fs.writeFileSync(this.markerFile, newSha);
                ok = true;
                return {ok: true, output: lines.join('\n'), id: run.id};
            }
            // A refused deploy leaves the repository ahead of what runs: the diff starts at the last one that went through.
            const last = this.lastDeployed;
            if (
                last &&
                last !== oldSha &&
                (await this.repo.exists(last)) &&
                (await this.repo.isAncestor(last, oldSha))
            ) {
                say(`the last deploy that went through was ${last.slice(0, 8)}; taking the changes since then`);
                oldSha = last;
            }
            const changed = await this.repo.changedFiles(oldSha, newSha);
            if (changed.length === 0) {
                say('no file changes; nothing to do');
                fs.writeFileSync(this.markerFile, newSha);
                ok = true;
                return {ok: true, output: lines.join('\n'), id: run.id};
            }
            const config = await this.compose(['config', '--format', 'json']);
            if (config.code !== 0) throw new Error(`docker compose config failed: ${config.output.trim().slice(-300)}`);
            const newDoc = JSON.parse(config.output);
            const contexts = {};
            for (const [svc, d] of Object.entries(newDoc.services ?? {})) {
                const b = d.build;
                if (!b) continue;
                const ctx = typeof b === 'string' ? b : b.context;
                if (ctx) contexts[svc] = relContext(ctx, this.stackDir);
            }
            const reloadPaths = (this.cfg.reload ?? []).flatMap((r) => r.paths ?? []);
            const plan = classify(changed, contexts, {reloadPaths});
            const self = this.cfg.selfService;
            // The compose file as it was: what changed image, and whether stacktender's own definition moved.
            let oldDoc = null;
            if (plan.composeChanged) {
                const oldText = await this.repo.show(oldSha, composeFile(this.stackDir));
                if (oldText) {
                    const tmp = path.join(os.tmpdir(), `stacktender-old-compose-${Date.now()}.yaml`);
                    fs.writeFileSync(tmp, oldText);
                    const oldConfig = await this.compose([
                        '--project-directory',
                        this.stackDir,
                        '-f',
                        tmp,
                        'config',
                        '--format',
                        'json',
                    ]);
                    fs.unlinkSync(tmp);
                    oldDoc = oldConfig.code === 0 ? JSON.parse(oldConfig.output) : parseYaml(oldText);
                }
            }
            const selfChanged =
                plan.build.includes(self) ||
                (oldDoc !== null &&
                    JSON.stringify(oldDoc.services?.[self] ?? null) !==
                        JSON.stringify(newDoc.services?.[self] ?? null));
            const allServices = Object.keys(newDoc.services ?? {});
            say(
                `plan: build=[${plan.build.join(' ')}] compose=${plan.composeChanged} reload=[${plan.reload.join(' ')}]`,
            );
            await this.bus.maintenance(true, {
                what: `deploy ${newSha.slice(0, 8)}`,
                since,
                phase: 'applying',
                build: plan.build,
                compose: plan.composeChanged,
            });

            // 1. Build before anything touches what runs; a build that fails changes nothing.
            if (plan.build.length > 0) {
                say(`docker compose build ${plan.build.join(' ')}`);
                const b = await this.compose(['build', ...plan.build]);
                if (b.code !== 0) throw new Error(`build failed: ${b.output.trim().slice(-400)}`);
            }

            // 1b. The test gate: a failing suite fails the deploy here, before anything runs the change.
            const gate = this.cfg.test;
            const gateDue =
                gate?.command &&
                (gate.paths?.length
                    ? changed.some((f) => gate.paths.some((p) => f.startsWith(p)))
                    : plan.build.length > 0 || plan.reload.length > 0);
            if (gateDue) {
                say(`test gate: ${gate.command}`);
                const t = await this.shell(gate.command);
                if (t.code !== 0) {
                    for (const l of t.output.trim().split('\n').slice(-30)) say(`  test: ${l}`);
                    throw new Error(`the tests fail at ${newSha.slice(0, 8)}; nothing is reloaded or recreated`);
                }
                for (const l of t.output.trim().split('\n').slice(-5)) say(`  test: ${l}`);
            }

            // 2. Files applied by a command instead of a rebuild (bind-mounted code with a reload endpoint).
            for (const r of this.cfg.reload ?? []) {
                if (!plan.reload.some((p) => (r.paths ?? []).includes(p))) continue;
                say(`reload: ${r.command}`);
                const out = await this.shell(r.command);
                if (out.code !== 0) say(`  reload failed (not fatal): ${out.output.trim().slice(-200)}`);
            }

            // 2b. A copy of every service that keeps data and is about to run another image.
            if (plan.composeChanged || plan.build.length > 0) {
                let candidates = new Set(plan.build);
                if (oldDoc) for (const s of imageChanges(oldDoc, newDoc)) candidates.add(s);
                candidates = [...candidates].sort();
                if (candidates.length > 0) {
                    const info = this.backups.setsInfo();
                    const toCopy = candidates.filter((s) => info.by_service[s]);
                    if (toCopy.length > 0) {
                        for (let tries = 0; !this.backups.setsInfo().ready && tries < 12; tries++)
                            await new Promise((res) => setTimeout(res, 5000));
                        if (!this.backups.setsInfo().ready)
                            throw new Error(
                                `${toCopy.join(', ')} keep data and get a new image, but the restic runner is not ready: no copy, no deploy`,
                            );
                        say(`backup of ${toCopy.join(', ')} before their image changes`);
                        await this.bus.maintenance(true, {
                            what: `deploy ${newSha.slice(0, 8)}`,
                            since,
                            phase: 'backup',
                            services: toCopy,
                        });
                        const job = this.backups.snapshot({services: toCopy, tag: `deploy:${newSha}`, start: false});
                        const result = await this.waitJob(job.job, 20 * 60_000);
                        if (!result.ok) throw new Error(`the backup failed: ${result.error}`);
                        stopped = result.stopped ?? [];
                        say(`backup done (job ${job.job}); stopped for the switch: ${stopped.join(', ') || 'nothing'}`);
                    }
                }
            }

            // 3. Apply. When the compose file changed, everything: compose only re-evaluates what it is told about.
            // Never stacktender itself in the middle of its own deploy: it is recreated after the answer went out.
            const others = (list) => list.filter((svc) => svc !== self);
            if (plan.composeChanged) {
                say('docker compose up -d (the compose file changed: all services)');
                const r = await this.composeUp(others(allServices));
                if (r.code !== 0) throw new Error(`docker compose up failed: ${r.output.trim().slice(-300)}`);
            } else if (others(plan.build).length > 0) {
                say(`docker compose up -d ${others(plan.build).join(' ')}`);
                const r = await this.composeUp(others(plan.build));
                if (r.code !== 0) throw new Error(`docker compose up failed: ${r.output.trim().slice(-300)}`);
            }
            if (selfChanged) {
                say(`${self}'s own definition changed: it is recreated once this deploy has answered`);
                this.recreateSelfLater(self);
            }
            for (const name of stopped) await this.docker.start(name).catch(() => undefined);
            stopped = [];

            if (plan.build.length === 0 && !plan.composeChanged && plan.reload.length === 0)
                say('no compose action needed (a change outside the stack)');

            // 5. Housekeeping: untagged images and the build cache.
            await this.run(['image', 'prune', '-f']).catch(() => undefined);
            await this.run(['builder', 'prune', '-f', '--max-used-space', '8GB']).catch(() => undefined);
            fs.writeFileSync(this.markerFile, newSha);
            ok = true;
            say(`done: ${new Date().toISOString()}`);
            return {ok: true, output: lines.join('\n'), id: run.id};
        } catch (err) {
            say(`ERROR: ${errMsg(err)}`);
            for (const name of stopped) await this.docker.start(name).catch(() => undefined);
            await this.bus.event('deploy_failed', {sha: newSha, reason: errMsg(err)});
            return {ok: false, output: lines.join('\n'), id: run.id};
        } finally {
            run.ok = ok;
            run.endedAt = new Date().toISOString();
            await this.bus.maintenance(false, {
                what: `deploy ${newSha.slice(0, 8)}`,
                since,
                result: ok ? 'done' : 'failed',
            });
        }
    }

    /** `docker compose up -d <self>` a moment after the deploy answered: the recreate kills this process, which then starts fresh. */
    recreateSelfLater(self) {
        const t = setTimeout(() => {
            this.log(`recreating ${self} (its own definition changed)`);
            this.compose(['up', '-d', '--no-deps', self]).catch((err) =>
                this.log(`recreating ${self}: ${errMsg(err)}`),
            );
        }, this.selfRecreateDelayMs);
        t.unref?.();
    }

    async waitJob(id, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const job = this.backups.job(id);
            if (job?.done) return {ok: job.ok === true, error: job.error, stopped: job.stopped};
            await new Promise((res) => setTimeout(res, 5000));
        }
        return {ok: false, error: `the backup (job ${id}) did not finish in ${Math.round(timeoutMs / 60_000)} min`};
    }

    /** Running, not restarting, twice a few seconds apart. */
    async comesUp(name, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let seen = 0;
        while (Date.now() < deadline) {
            const c = await this.docker.container(name).catch(() => null);
            if (c && c.restartCount >= 3) return false;
            if (c?.running) {
                seen++;
                if (seen >= 2) return true;
            } else seen = 0;
            await new Promise((res) => setTimeout(res, 4000));
        }
        return false;
    }
}

/** The compose project name of a stack directory, as compose resolves it (the config's `name`), or null. */
export async function composeProjectName(stackDir, run = (args) => dockerRun(args, {cwd: stackDir})) {
    const r = await run(['compose', 'config', '--format', 'json']);
    if (r.code !== 0) return null;
    try {
        return JSON.parse(r.output).name ?? null;
    } catch {
        return null;
    }
}

export function composeFile(stackDir) {
    return COMPOSE_FILES.find((f) => fs.existsSync(path.join(stackDir, f))) ?? 'docker-compose.yaml';
}

/** `./<name>-data` bind sources of the compose file: created as this process's user before Docker makes them root-owned. */
export function dataDirs(composeText) {
    const out = new Set();
    // `- ./x-data:/d`, `"./x-data:/d"` and `source: ./x-data` alike
    for (const m of String(composeText ?? '').matchAll(/(?:^|["'\s-])\.\/([A-Za-z0-9_-]+-data)(?=[/:"'\s])/gm))
        out.add(m[1]);
    return [...out];
}

function relContext(ctx, stackDir) {
    const rel = path.isAbsolute(ctx) ? path.relative(stackDir, ctx) : ctx.replace(/^\.\//, '');
    return rel === '' ? '.' : rel.replace(/\/+$/, '');
}

function shellRun(cmd, cwd) {
    return new Promise((resolve) => {
        import('node:child_process').then(({exec}) => {
            exec(cmd, {cwd, maxBuffer: 64 * 1024 * 1024, env: process.env}, (err, stdout, stderr) => {
                resolve({code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}`});
            });
        });
    });
}
