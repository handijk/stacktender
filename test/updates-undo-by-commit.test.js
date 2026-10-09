// An applied update of which nothing but the history entry is left (the record for the undo was
// pruned, or the data directory was lost): a person undoes it by its commit. The deploy's copy for
// that very commit is put back first, the commit is reverted, and the service is judged by health.
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

test('undo by commit', async () => {
    const dir = tempDir('undo-commit');
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
    const store = fakeStore();
    const scanner = fakeScanner(dir, () => repo.files['docker-compose.yaml']);
    scanner.scan();

    // An ordinary apply.
    const bus1 = fakeBus();
    const first = new Updates({
        cfg: mergeConfig(UPDATES_CONFIG),
        dataDir: dir,
        repo,
        docker,
        backups: fakeBackups(),
        store,
        bus: bus1,
        scanner,
    });
    await first.start();
    await until(() => bus1.ofType('applied').length > 0, 10_000, 'the applied event');
    await until(() => bus1.signals.at(-1)?.active === false, 5_000, 'the apply to end');
    const history = await store.get('history');
    const entry = history[0];
    assert.ok(
        entry?.sha && entry.services?.includes('caddy'),
        `the history entry lacks the commit or the services: ${JSON.stringify(history)}`,
    );
    first.stop();

    // What survived: the history, not the record for the undo. The scan shows the repo as it is (the pin moved: no finding).
    store.map.delete('persisted');
    scanner.scan();
    const backups = fakeBackups({
        snapshots: [
            {
                id: 'c0ffee0000000001',
                time: new Date(Date.now() - 60_000).toISOString(),
                tags: [`deploy:${entry.sha}`, 'set:caddy'],
            },
            {id: '0ther00000000002', time: new Date().toISOString(), tags: ['deploy:unrelated0001', 'set:caddy']},
        ],
    });
    const bus = fakeBus();
    const second = new Updates({
        cfg: mergeConfig(UPDATES_CONFIG),
        dataDir: dir,
        repo,
        docker,
        backups,
        store,
        bus,
        scanner,
    });
    await second.start();
    await realSleep(300);
    const list = await second.undo();
    assert.equal(list.undoable.length, 0, 'no undo record should exist');
    assert.ok(
        list.by_commit.some((c) => c.sha === entry.sha),
        'the commit is offered',
    );
    const answer = await second.undo(entry.sha);
    assert.ok(answer.ok && /reverting the commit/.test(answer.note), JSON.stringify(answer));
    await until(() => bus.ofType('rolled_back').length > 0, 15_000, 'the rolled-back event');
    const [rolled] = bus.ofType('rolled_back');
    assert.equal(backups.restores[0].snapshot, 'c0ffee0000000001', "the commit's own copy is the one restored");
    assert.equal(backups.restores[0].set, 'caddy');
    assert.equal(backups.restores[0].start, false);
    assert.equal(repo.reverts[0], entry.sha);
    assert.equal(repo.pushes.length, 1, 'the commit was reverted, nothing pushed');
    assert.equal(rolled.undo, true);
    assert.match(String(rolled.data), /restored c0ffee00/);
    assert.match(rolled.after_rollback, /back on the previous version and healthy/);
    second.stop();
});
