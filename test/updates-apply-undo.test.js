// A silent patch is applied: pin edited, "deployed" (the fake container runs the new image),
// verified, announced with an undo hint, and recorded. Then a person undoes it: the deploy's copy
// is put back first, the old version after, and the rolled-back event says so.
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

test('apply, then undo by a person', async () => {
    const dir = tempDir('apply-undo');
    const docker = fakeDocker();
    docker.map.set('caddy', {
        service: 'caddy',
        image: CADDY_OLD,
        running: true,
        health: null,
        exitCode: null,
        restartCount: 0,
    });
    const snapshots = [];
    const backups = fakeBackups({snapshots});
    const repo = fakeRepo(
        {'docker-compose.yaml': COMPOSE_CADDY},
        {
            onPush: (_edits, message, sha) => {
                const c = docker.map.get('caddy');
                c.image = repo.files['docker-compose.yaml'].includes(CADDY_NEW) ? CADDY_NEW : CADDY_OLD;
                if (message.startsWith('bump'))
                    snapshots.push({
                        id: 'deadbeefcafe0123',
                        time: new Date().toISOString(),
                        tags: [`deploy:${sha}`, 'set:caddy'],
                    });
            },
        },
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
    });
    await engine.start();

    await until(() => bus.ofType('applied').length > 0, 10_000, 'the applied event');
    const [applied] = bus.ofType('applied');
    assert.ok(repo.files['docker-compose.yaml'].includes(CADDY_NEW), 'the pin was changed');
    assert.match(repo.pushes[0].message, /^bump caddy/);
    assert.match(String(applied.undo), /undo/);
    const persisted = await store.get('persisted');
    assert.ok(
        Object.values(persisted).some((p) => p.applied),
        'an applied record is kept for undo',
    );

    await until(() => bus.signals.at(-1)?.active === false, 5_000, "the apply's maintenance signal to clear");
    const list = await engine.undo();
    assert.ok(
        list.undoable.some((u) => u.id === applied.item.id),
        'undo lists it',
    );
    const answer = await engine.undo(applied.item.id);
    assert.ok(answer.ok, JSON.stringify(answer));
    await until(() => bus.ofType('rolled_back').length > 0, 10_000, 'the rolled-back event');
    const [rolled] = bus.ofType('rolled_back');
    assert.equal(rolled.undo, true);
    assert.match(String(rolled.data), /restored deadbeef/);
    assert.equal(backups.restores[0].set, 'caddy');
    assert.equal(backups.restores[0].start, false);
    assert.ok(repo.files['docker-compose.yaml'].includes(CADDY_OLD), 'the pin is back');
    assert.match(repo.pushes[1].message, /^roll back caddy/);
    assert.equal(repo.pushes.length, 2);
    const after = await store.get('persisted');
    assert.ok(!Object.values(after).some((p) => p.applied), 'the applied record is gone after the undo');
    await until(
        () => bus.lastState()?.items.find((i) => i.name === 'caddy')?.policy === 'ask',
        5_000,
        'the list to show the undone update as asking',
    );
    assert.equal(bus.lastState().items.find((i) => i.name === 'caddy').state, 'failed');
    engine.stop();
});
