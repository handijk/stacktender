#!/usr/bin/env node
/**
 * stacktender — keeps a Docker Compose stack current without breaking it.
 *
 *   stacktender [--stack <dir>] [--data <dir>] [--port <n>] [--host <addr>]
 *
 * The stack directory is the repository (made one on the first run when it is none); the data
 * directory holds the journal, the reports, the history and the restic jobs. The configuration
 * is `stacktender.yaml` in the stack directory. Environment: STACKTENDER_STACK, STACKTENDER_DATA,
 * STACKTENDER_PORT, STACKTENDER_WEBHOOK (one webhook URL, added to the configured ones).
 */

import fs from 'node:fs';
import path from 'node:path';
import {parse as parseYaml, stringify as toYaml} from 'yaml';
import pkg from './package.json' with {type: 'json'};
import {mergeConfig} from './lib/config.js';
import {Backups} from './lib/backups/engine.js';
import {ensureRunner} from './lib/backups/runner.js';
import {Updates} from './lib/updates/engine.js';
import {Bus} from './lib/bus.js';
import {Deploy, composeFile, composeProjectName, dataDirs} from './lib/deploy.js';
import {createApi} from './lib/api.js';
import {RenovateScanner} from './lib/scanner.js';
import {DockerPort, DockerSocket, diskOf} from './lib/ports/docker.js';
import {GitRepo} from './lib/ports/repo.js';
import {FileStore} from './lib/ports/store.js';
import {hostItems, readHost} from './lib/updates/host.js';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    return process.env[`STACKTENDER_${name.toUpperCase()}`] ?? fallback;
}

const stackDir = path.resolve(arg('stack', process.cwd()));
const dataDir = path.resolve(arg('data', path.join(stackDir, 'stacktender-data')));
const port = Number(arg('port', 8800));
const host = arg('host', '127.0.0.1');
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

fs.mkdirSync(dataDir, {recursive: true});

// The configuration, written with the defaults when there is none.
const configFile = path.join(stackDir, 'stacktender.yaml');
if (!fs.existsSync(configFile)) {
    fs.writeFileSync(
        configFile,
        `# stacktender: see https://github.com/handijk/stacktender#configuration\n${toYaml(mergeConfig({}))}`,
    );
    log(`wrote ${configFile} with the defaults (autopilot off)`);
}
const cfg = mergeConfig(parseYaml(fs.readFileSync(configFile, 'utf-8')) ?? {});
if (process.env.STACKTENDER_WEBHOOK)
    cfg.notify.webhooks = [...(cfg.notify.webhooks ?? []), process.env.STACKTENDER_WEBHOOK];

const bus = new Bus({webhooks: cfg.notify.webhooks, log});
// The compose project of the stack, from compose itself: the containers of another project with the
// same service names on the machine are never ours.
const dockerSocket = new DockerSocket();
const docker = new DockerPort({socket: dockerSocket, selfService: cfg.selfService});
const store = new FileStore(path.join(dataDir, 'state'));

let deploy = null;
const repo = new GitRepo({
    dir: stackDir,
    log,
    deploy: (oldSha, newSha) => deploy.deploy(oldSha, newSha, {reason: 'stacktender'}),
});

const backups = new Backups({
    cfg: {...cfg.backups, tz: cfg.tz, selfService: cfg.selfService},
    dataDir: path.join(dataDir, 'backups'),
    composeText: () => repo.read(composeFile(stackDir)),
    committed: (rel) => isTracked(rel),
    exists: (rel) => fs.existsSync(path.join(stackDir, rel)),
    docker: {container: (n) => docker.container(n), stop: (n, t) => docker.stop(n, t), start: (n) => docker.start(n)},
    store,
    bus: bus.forSource('backups'),
    log,
});

deploy = new Deploy({
    stackDir,
    dataDir,
    repo,
    backups,
    docker,
    bus: bus.forSource('deploy'),
    cfg: {...cfg.deploy, selfService: cfg.selfService, tz: cfg.tz},
    log,
});

const scanner = new RenovateScanner({
    stackDir,
    dataDir: path.join(dataDir, 'scan'),
    image: cfg.scanner?.image,
    tz: cfg.tz,
    log,
});

// The host's own account of itself, read at every report.
const hostDir = cfg.host.dir ?? '/host';
const scannerWithHost = {
    request: () => scanner.request(),
    report: () => {
        const got = scanner.report();
        if (!got || !cfg.host.report) return got;
        return {...got, host: readHost(hostDir)};
    },
};

const updates = new Updates({
    cfg,
    dataDir: path.join(dataDir, 'updates'),
    repo,
    docker,
    // The backups as the updates engine asks them: the sets by service, the snapshots, a restore and its job.
    backups: {
        sets: () => backups.setsInfo(),
        snapshots: (q) => backups.snapshots(q),
        restore: (b) => backups.restore(b),
        job: (id) => backups.job(id),
    },
    store,
    bus: bus.forSource('updates'),
    scanner: scannerWithHost,
    hooks: {
        veto: cfg.hooks.veto ? (payload) => post(cfg.hooks.veto, payload, cfg.hooks.timeoutSeconds) : null,
        assess: cfg.hooks.assessor ? (payload) => post(cfg.hooks.assessor, payload, cfg.hooks.timeoutSeconds) : null,
    },
    log,
});
// Host findings join the list after every report.
const originalLoad = updates.loadReport.bind(updates);
updates.loadReport = async () => {
    const loaded = await originalLoad();
    if (loaded && cfg.host.report) {
        const got = scannerWithHost.report();
        updates.items = [
            ...updates.items.filter((i) => i.kind !== 'host'),
            ...hostItems(got?.host ?? null, cfg, updates.persisted, diskOf(dataDir)),
        ];
    }
    return loaded;
};

async function post(url, payload, timeoutSeconds) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

const tracked = new Set();
async function refreshTracked() {
    try {
        const out = await repo.git(['ls-files']);
        tracked.clear();
        for (const f of out.split('\n').filter(Boolean)) {
            const parts = f.split('/');
            for (let i = 1; i <= parts.length; i++) tracked.add(parts.slice(0, i).join('/'));
        }
    } catch (err) {
        log(`git ls-files: ${err.message}`);
    }
}
function isTracked(rel) {
    return tracked.has(rel);
}

const api = createApi({updates, backups, deploy, bus, repo, scanner, pkg});

async function main() {
    log(`${pkg.name} ${pkg.version}: stack ${stackDir}, data ${dataDir}, docker ${dockerSocket.socketPath}`);
    const project = await composeProjectName(stackDir);
    if (project) {
        docker.project = project;
        docker.looked = true;
        log(`compose project: ${project}`);
    } else log('compose project unknown: containers are matched by service name only');
    const compose = await repo.read(composeFile(stackDir));
    const ignore = [...dataDirs(compose), path.relative(stackDir, dataDir)].filter((d) => d && !d.startsWith('..'));
    if (await repo.init(ignore))
        log(
            `the stack directory is a git repository now; everything but ${ignore.join(', ') || 'the data'} is committed`,
        );
    await refreshTracked();
    setInterval(refreshTracked, 10 * 60_000).unref();
    const address = await api.listen(port, host);
    log(`API on http://${address.address}:${address.port}`);
    const repository =
        cfg.backups.repository.startsWith('/') || /^[a-z0-9]+:/.test(cfg.backups.repository)
            ? cfg.backups.repository
            : path.resolve(stackDir, cfg.backups.repository);
    // A local repository directory is made as this user before Docker would make it root-owned.
    if (repository.startsWith('/')) fs.mkdirSync(repository, {recursive: true});
    await ensureRunner({
        stackDir,
        jobsHostDir: path.join(dataDir, 'backups'),
        repository,
        image: cfg.backups.image,
        user:
            cfg.backups.user ??
            (typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined),
        tz: cfg.tz,
        log,
    }).catch((err) => log(`restic runner: ${err.message}`));
    await backups.start();
    await updates.start();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log(`${sig}: stopping`);
        updates.stop();
        backups.stop();
        api.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
