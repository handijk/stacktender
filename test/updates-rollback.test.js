// The new image never comes up: the engine rolls back by itself, putting the deploy's copy back
// before the old pin, and the list shows the finding as failed afterwards. Also: a veto hook
// says no, with the same outcome.
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
    tempDir,
    until,
} from './helpers.js';
import {mergeConfig} from '../lib/config.js';
import {Updates} from '../lib/updates/engine.js';

installClock();

function setup(name, {onPush, hooks} = {}) {
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
    const backups = fakeBackups({
        // The deploy's copy is taken during the apply, so it is younger than the apply's start.
        snapshots: [
            {
                id: 'feedface00000001',
                time: new Date(Date.now() + 60_000).toISOString(),
                tags: ['deploy:sha000001', 'set:caddy'],
            },
        ],
    });
    const repo = fakeRepo(
        {'docker-compose.yaml': COMPOSE_CADDY},
        {onPush: onPush ? (e, m, s) => onPush(docker, repo, e, m, s) : undefined},
    );
    const bus = fakeBus();
    const store = fakeStore();
    const scanner = fakeScanner(dir, () => repo.files['docker-compose.yaml']);
    scanner.scan();
    const engine = new Updates({
        cfg: mergeConfig(UPDATES_CONFIG),
        dataDir: dir,
        repo,
        docker,
        backups,
        store,
        bus,
        scanner,
        hooks,
    });
    return {engine, docker, backups, repo, bus, store};
}

test('a container that stays on the old image is rolled back with its data', async () => {
    const {engine, backups, repo, bus, store} = setup('rollback'); // no onPush: the container never changes
    await engine.start();
    await until(() => bus.ofType('rolled_back').length > 0, 15_000, 'the rolled-back event');
    const [rolled] = bus.ofType('rolled_back');
    assert.match(rolled.problem, /not healthy after 2 min/);
    assert.match(rolled.problem, /still on caddy:2\.11\.6/);
    assert.match(String(rolled.data), /restored feedface/);
    assert.equal(backups.restores[0].set, 'caddy');
    assert.equal(repo.pushes.length, 2);
    assert.match(repo.pushes[1].message, /^roll back caddy/);
    assert.ok(
        repo.files['docker-compose.yaml'].includes(CADDY_OLD) && !repo.files['docker-compose.yaml'].includes(CADDY_NEW),
        'the pin is back',
    );
    await until(
        () => bus.lastState()?.items.find((i) => i.name === 'caddy')?.policy === 'ask',
        5_000,
        'the list to show the finding as asking',
    );
    const item = bus.lastState().items.find((i) => i.name === 'caddy');
    assert.equal(item.state, 'failed');
    assert.match(item.reason, /was tried and rolled back/);
    const persisted = await store.get('persisted');
    assert.ok(!Object.values(persisted).some((p) => p.applied), 'nothing applied, so nothing to undo');
    engine.stop();
});

test('a veto from the hook rolls back a healthy update', async () => {
    const vetoes = [];
    const {engine, repo, bus} = setup('veto', {
        onPush: (docker, repo) => {
            docker.map.get('caddy').image = repo.files['docker-compose.yaml'].includes(CADDY_NEW)
                ? CADDY_NEW
                : CADDY_OLD;
        },
        hooks: {
            veto: async (payload) => {
                vetoes.push(payload);
                return payload.to?.startsWith('2.11.7') ? {ok: false, why: 'the website answers 500'} : {ok: true};
            },
        },
    });
    await engine.start();
    await until(() => bus.ofType('rolled_back').length > 0, 15_000, 'the rolled-back event');
    const [rolled] = bus.ofType('rolled_back');
    assert.match(rolled.problem, /vetoed: the website answers 500/);
    assert.equal(vetoes[0].name, 'caddy');
    assert.deepEqual(vetoes[0].services, ['caddy']);
    assert.ok(repo.files['docker-compose.yaml'].includes(CADDY_OLD), 'the pin is back');
    engine.stop();
});
