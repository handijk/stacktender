// A backup run against a small stack: each set stopped, copied, started, the right tags and paths
// handed to restic; a snapshot on request that leaves the set stopped for a deploy; a restore that
// keeps a copy first, empties the directory and starts the set again; a live set refusing to be
// restored; the journal starting again what a cut-short run stopped.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {fakeBus, fakeDocker, fakeStore, installClock, realSleep, tempDir, until} from './helpers.js';
import {mergeConfig} from '../lib/config.js';
import {Backups} from '../lib/backups/engine.js';

installClock();

const compose = `services:
  stacktender:
    container_name: stacktender
    build: ./stacktender
    volumes: ["./stacktender-data:/data"]
  caddy:
    container_name: caddy
    image: caddy:2
    volumes: ["./caddy-data:/data"]
  element:
    container_name: element
    image: vectorim/element-web:v1
    depends_on: [caddy]
  grafana:
    container_name: grafana
    image: grafana/grafana-oss:13
    volumes: ["./grafana-data:/var/lib/grafana", "./grafana/provisioning:/etc/grafana/provisioning:ro"]
  mosquitto:
    container_name: mosquitto
    image: eclipse-mosquitto:2
    volumes: ["./mosquitto/config:/mosquitto/config", "./mosquitto/data:/mosquitto/data", "./mosquitto/log:/mosquitto/log"]
`;
const committed = (rel) =>
    ['mosquitto/config', 'grafana/provisioning'].some((c) => rel === c || rel.startsWith(`${c}/`));

/** The runner, as restic would answer: one script at a time, output and exit code next to it. */
function fakeRunner(jobsDir) {
    const registry = [];
    const scripts = [];
    const restored = [];
    let on = true;
    (async () => {
        while (on) {
            await realSleep(10);
            if (!fs.existsSync(jobsDir)) continue;
            for (const f of fs
                .readdirSync(jobsDir)
                .filter((f) => f.endsWith('.sh'))
                .sort()) {
                const id = f.slice(0, -3);
                if (fs.existsSync(path.join(jobsDir, `${id}.exit`))) continue;
                const script = fs.readFileSync(path.join(jobsDir, f), 'utf-8');
                scripts.push(script);
                let log = '';
                let exit = 0;
                if (/r cat config/.test(script))
                    log =
                        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 50000000 50000000 50% /repo\n123456\n';
                else if (/r backup /.test(script)) {
                    const tags = [...script.matchAll(/--tag '([^']+)'/g)].map((m) => m[1]);
                    const paths = [...script.matchAll(/'(\/src\/[^']+)'/g)].map((m) => m[1]);
                    const sid = createHash('sha256')
                        .update(script + registry.length)
                        .digest('hex');
                    registry.push({
                        id: sid,
                        short_id: sid.slice(0, 8),
                        time: new Date().toISOString(),
                        paths,
                        tags,
                        hostname: 'stack',
                    });
                    log = `{"message_type":"status","percent_done":1}\n{"message_type":"summary","snapshot_id":"${sid}","total_bytes_processed":1000,"data_added":100,"total_duration":0.5}\n`;
                } else if (/r snapshots --json/.test(script)) log = `${JSON.stringify(registry)}\n`;
                else if (/r restore /.test(script)) {
                    const m = /r restore ([0-9a-f]+) --target \//.exec(script);
                    if (!m || !/find '\/src\/caddy-data' -mindepth 1 -delete/.test(script)) {
                        exit = 1;
                        log = 'restore script without the emptying step or an id\n';
                    } else {
                        restored.push(m[1]);
                        log = 'restoring to /\n';
                    }
                } else if (/r forget|r check/.test(script)) log = 'ok\n';
                else {
                    exit = 1;
                    log = `unknown job:\n${script}`;
                }
                fs.writeFileSync(path.join(jobsDir, `${id}.log`), log);
                fs.writeFileSync(path.join(jobsDir, `${id}.exit`), `${exit}\n`);
            }
        }
    })();
    return {registry, scripts, restored, stop: () => (on = false)};
}

test('a run, a snapshot for a deploy, a refused restore, a restore, the journal', async () => {
    const dir = tempDir('backups-run');
    const runner = fakeRunner(path.join(dir, 'jobs'));
    const docker = fakeDocker();
    for (const name of ['caddy', 'element', 'grafana', 'mosquitto'])
        docker.map.set(name, {
            service: name,
            image: `${name}:1`,
            running: true,
            health: null,
            exitCode: null,
            restartCount: 0,
        });
    const base = mergeConfig({
        backups: {
            on: false,
            repository: '../backups',
            exclude: [],
            data: ['.env'],
            noStop: ['mosquitto'],
            jobTimeoutMinutes: 1,
            stopTimeoutSeconds: 30,
        },
    });
    const cfg = {...base.backups, tz: 'UTC', selfService: 'stacktender'};
    const store = fakeStore();
    const bus = fakeBus();
    const make = () =>
        new Backups({cfg, dataDir: dir, composeText: async () => compose, committed, docker, store, bus});
    const backups = make();
    await backups.start();
    await until(() => backups.setsInfo().ready === true, 5_000, 'the runner to be ready');
    const info = backups.setsInfo();
    const names = info.sets.map((s) => s.name).sort();
    const caddySet = info.sets.find((s) => s.name === 'caddy');
    assert.deepEqual([...caddySet.stop].sort(), ['caddy', 'element'], 'element stops with caddy');
    assert.equal(info.by_service.stacktender, undefined);
    assert.equal(info.by_service.caddy, 'caddy');

    // 1. A run of every set.
    const run = backups.backupNow({});
    await until(() => backups.job(run.job)?.done === true, 10_000, 'the run to finish');
    const job = backups.job(run.job);
    assert.ok(job.ok, JSON.stringify(job));
    const order = docker.calls.filter((c) => /^(stop|start) /.test(c));
    const stopped = (n) => order.indexOf(`stop ${n}`);
    const started = (n) => order.indexOf(`start ${n}`);
    for (const n of ['caddy', 'element', 'grafana'])
        assert.ok(stopped(n) >= 0 && started(n) > stopped(n), `${n} was not stopped and started again: ${order}`);
    for (const n of ['mosquitto', 'stacktender']) assert.ok(stopped(n) < 0, `${n} must never be stopped`);
    assert.ok(
        [...docker.map.values()].every((c) => c.running),
        'something was left stopped',
    );
    const caddyBackup = runner.scripts.find((s) => /r backup .*--tag 'set:caddy'/.test(s));
    assert.ok(
        caddyBackup &&
            caddyBackup.includes("'/src/caddy-data'") &&
            caddyBackup.includes('--host stack') &&
            caddyBackup.includes('--insecure-no-password'),
        caddyBackup,
    );
    assert.ok(
        runner.scripts.some((s) => /r backup .*'\/src\/\.env'/.test(s)),
        '.env was not copied',
    );
    assert.equal(Object.keys(job.results).length, names.length);

    // 2. A snapshot for a deploy: the set stays stopped.
    const snap = backups.snapshot({services: ['caddy'], tag: 'deploy:abc123', start: false});
    await until(() => backups.job(snap.job)?.done === true, 10_000, 'the snapshot');
    const snapJob = backups.job(snap.job);
    assert.ok(snapJob.ok);
    assert.deepEqual([...snapJob.stopped].sort(), ['caddy', 'element'], 'the set is left stopped for the deploy');
    assert.equal(docker.map.get('caddy').running, false);
    assert.ok(runner.registry.some((s) => s.tags.includes('deploy:abc123') && s.tags.includes('set:caddy')));
    for (const n of ['caddy', 'element']) docker.map.get(n).running = true; // the deploy's `up`
    const listed = await backups.snapshots({set: 'caddy', tag: 'deploy:abc123', refresh: true});
    assert.equal(listed.length, 1);

    // 3. A live set cannot be restored under a running service.
    assert.throws(() => backups.restore({set: 'mosquitto', snapshot: 'latest'}), /copied live/);

    // 4. A restore: a copy first, the directory emptied, the snapshot put back, the set started.
    const before = runner.registry.length;
    const restore = backups.restore({set: 'caddy', snapshot: listed[0].id});
    await until(() => backups.job(restore.job)?.done === true, 10_000, 'the restore');
    const restoreJob = backups.job(restore.job);
    assert.ok(restoreJob.ok, JSON.stringify(restoreJob));
    assert.ok(
        runner.registry.slice(before).some((s) => s.tags.includes('pre-restore')),
        'no pre-restore copy was taken',
    );
    assert.equal(runner.restored.length, 1);
    assert.ok(listed[0].id.startsWith(runner.restored[0].slice(0, 8)));
    assert.ok(
        docker.map.get('caddy').running && docker.map.get('element').running,
        'the set was not started after the restore',
    );

    // 5. The journal: a run cut short starts what it stopped.
    backups.stop();
    const left = {
        id: 'nightly-x',
        kind: 'nightly',
        startedAt: new Date().toISOString(),
        sets: ['grafana'],
        keepStopped: false,
        stopped: ['grafana'],
        phase: 'copying grafana',
        results: {},
    };
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(left));
    docker.map.get('grafana').running = false;
    const second = make();
    await second.start();
    assert.equal(docker.map.get('grafana').running, true, 'a restart should start what the cut-short run stopped');
    assert.ok(!fs.existsSync(path.join(dir, 'run.json')), 'the journal should be gone');
    second.stop();
    runner.stop();
});
