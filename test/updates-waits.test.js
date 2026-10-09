// Nothing is started while another source's planned work is under way (the nightly backup, a
// deploy by hand); it goes once the signal is gone. And nothing goes outside the window, or with
// the autopilot off.
import {test} from 'node:test';
import assert from 'node:assert/strict';

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

function setup(name, cfg = {}) {
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
    scanner.scan();
    const engine = new Updates({
        cfg: mergeConfig({...UPDATES_CONFIG, ...cfg}),
        dataDir: dir,
        repo,
        docker,
        backups: fakeBackups(),
        store: fakeStore(),
        bus,
        scanner,
    });
    return {engine, repo, bus};
}

test("waits for another source's planned work", async () => {
    const {engine, repo, bus} = setup('waits');
    bus.others.add('backups');
    await engine.start();
    await realSleep(1500); // fifteen minutes of the stack's time
    assert.equal(repo.pushes.length, 0, 'a pin was changed while planned work was in progress');
    bus.others.delete('backups');
    await until(() => repo.pushes.length === 1, 5_000, 'the apply once the signal is gone');
    await until(() => bus.ofType('applied').length > 0, 10_000, 'the applied event');
    engine.stop();
});

test('nothing goes with the autopilot off: the finding is a proposal', async () => {
    const {engine, repo, bus} = setup('autopilot-off', {autopilot: false});
    await engine.start();
    await realSleep(1000);
    assert.equal(repo.pushes.length, 0);
    assert.equal(bus.ofType('needs_decision').length, 0, 'a silent finding is queued, not proposed');
    assert.match(bus.lastState().status.message, /autopilot is off/);
    const answer = await engine.apply(bus.lastState().items[0].id);
    assert.ok(answer.ok);
    await until(() => bus.ofType('applied').length > 0, 10_000, 'the applied event after a person asked');
    engine.stop();
});

test('nothing goes outside the window; a proposal is announced once', async () => {
    const {engine, repo, bus} = setup('window', {
        applyWindow: {from: '23:58', to: '23:59'},
        infraWindow: {from: '23:58', to: '23:59'},
        rules: [{match: 'caddy', policy: 'ask', why: 'a person decides'}],
    });
    await engine.start();
    await realSleep(1000);
    assert.equal(repo.pushes.length, 0);
    assert.equal(bus.ofType('needs_decision').length, 1);
    assert.equal(bus.ofType('needs_decision')[0].items[0].why, 'a person decides');
    const dismissed = await engine.dismiss(bus.lastState().items[0].id, {days: 3, reason: 'not now'});
    assert.ok(dismissed.ok);
    assert.equal(bus.lastState().items[0].state, 'dismissed');
    engine.stop();
});
