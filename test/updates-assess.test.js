// The assessor reads the release notes of a minor step before anyone is asked: a slow reader answers
// "pending" first and the verdict later; a clean minor on a service that keeps no data then goes by
// itself, and a step that needs a person is proposed with the verdict attached.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    CADDY_NEW,
    CADDY_OLD,
    COMPOSE_CADDY,
    UPDATES_CONFIG,
    fakeBackups,
    fakeBus,
    fakeDocker,
    fakeRepo,
    fakeScanner,
    fakeStore,
    installClock,
    realSleep,
    tempDir,
    until,
} from './helpers.js';
import {mergeConfig} from '../lib/config.js';
import {Updates} from '../lib/updates/engine.js';

installClock();

/** The caddy step of the fixture as a minor: what the assessor is for. */
function minorReport(dir) {
    const file = path.join(dir, 'report.json');
    const report = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const files of Object.values(report.repositories.local.packageFiles))
        for (const f of files)
            for (const dep of f.deps ?? []) for (const u of dep.updates ?? []) u.updateType = 'minor';
    fs.writeFileSync(file, JSON.stringify(report));
}

function setup(name, assess, cfg = {}) {
    const dir = tempDir(name);
    const docker = fakeDocker();
    docker.map.set('caddy', {
        service: 'caddy',
        image: CADDY_OLD,
        running: true,
        health: null,
        exitCode: null,
        restartCount: 0,
    });
    const repo = fakeRepo(
        {'docker-compose.yaml': COMPOSE_CADDY},
        {onPush: () => (docker.map.get('caddy').image = CADDY_NEW)},
    );
    const bus = fakeBus();
    const scanner = fakeScanner(dir, () => repo.files['docker-compose.yaml']);
    // Every scan (the engine asks for one at its start) writes the fixture afresh: the step stays a minor.
    const scan = scanner.scan;
    scanner.scan = () => {
        scan();
        minorReport(dir);
    };
    scanner.request = () => {
        scanner.requests.push(Date.now());
        scanner.scan();
    };
    scanner.scan();
    const engine = new Updates({
        cfg: mergeConfig({...UPDATES_CONFIG, hooks: {assessor: 'http://assessor', assessorAskAnyway: []}, ...cfg}),
        dataDir: dir,
        repo,
        docker,
        backups: fakeBackups({bySet: {}}),
        store: fakeStore(),
        bus,
        scanner,
        hooks: {assess},
    });
    return {engine, repo, bus};
}

test('a slow reader: pending first, clean later, then the minor goes by itself', async () => {
    const calls = [];
    const {engine, repo, bus} = setup('assess-clean', async (payload) => {
        calls.push(payload);
        return calls.length === 1
            ? {verdict: 'pending'}
            : {verdict: 'clean', why: 'nothing in the notes touches how it runs here'};
    });
    await engine.start();
    await until(() => calls.length === 1, 5_000, 'the first call to the assessor');
    assert.equal(calls[0].name, 'caddy');
    assert.equal(calls[0].updateType, 'minor');
    assert.ok(calls[0].from.startsWith('2.11.6'), calls[0].from);
    assert.ok(calls[0].to.startsWith('2.11.7'), calls[0].to);
    await realSleep(300); // three minutes of the stack's time: not asked again yet, and not proposed meanwhile
    assert.equal(calls.length, 1, 'asked again before five minutes passed');
    assert.equal(bus.ofType('needs_decision').length, 0, 'proposed while the reading was pending');
    await until(() => calls.length === 2, 5_000, 'the second call, after five minutes');
    await until(() => repo.pushes.length === 1, 10_000, 'the apply once the minor was found clean');
    await until(() => bus.ofType('applied').length > 0, 10_000, 'the applied event');
    assert.equal(bus.ofType('needs_decision').length, 0, "a clean minor is nobody's question");
    assert.match(bus.ofType('applied')[0].item?.why ?? '', /assessor read the release notes/);
    engine.stop();
});

test('a step that needs a person is proposed with the verdict attached', async () => {
    const {engine, repo, bus} = setup('assess-person', async () => ({
        verdict: 'needs a person',
        why: 'the config format changed',
    }));
    await engine.start();
    await until(() => bus.ofType('needs_decision').length === 1, 10_000, 'the proposal');
    const item = bus.ofType('needs_decision')[0].items.find((i) => i.name === 'caddy');
    assert.ok(item, 'caddy is proposed');
    assert.deepEqual(item.assessment?.verdict, 'needs a person');
    assert.match(item.assessment?.why ?? '', /config format/);
    await realSleep(500);
    assert.equal(repo.pushes.length, 0, 'nothing applied');
    engine.stop();
});

test('an assessor that cannot be reached: no proposal without a verdict until the attempt is given up', async () => {
    const calls = [];
    const {engine, bus} = setup('assess-down', async () => {
        calls.push(Date.now());
        throw new Error('HTTP 503');
    });
    await engine.start();
    await until(() => calls.length === 1, 5_000, 'the attempt');
    await realSleep(600); // six minutes: the hour's pause holds
    assert.equal(calls.length, 1, 'asked again within the hour');
    assert.equal(bus.ofType('needs_decision').length, 0, 'proposed without a verdict and without a failed attempt');
    engine.stop();
});
