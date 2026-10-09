// stacktender restarts in the middle of an apply, after the push landed and before the
// verification ended. The next instance carries on from the journal and ends in "applied",
// without pushing again.
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
    tempDir,
    until,
} from './helpers.js';
import {mergeConfig} from '../lib/config.js';
import {Updates} from '../lib/updates/engine.js';

installClock();

test('an apply cut by a restart is finished by the next instance', async () => {
    const dir = tempDir('resume');
    const journal = path.join(dir, 'apply.json');
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
    const logs = [];
    const make = (bus) =>
        new Updates({
            cfg: mergeConfig(UPDATES_CONFIG),
            dataDir: dir,
            repo,
            docker,
            backups: fakeBackups(),
            store,
            bus,
            scanner,
            log: (m) => logs.push(m),
        });

    const first = make(fakeBus());
    await first.start();
    await until(
        () => fs.existsSync(journal) && JSON.parse(fs.readFileSync(journal, 'utf-8')).phase === 'verifying',
        10_000,
        'the journal to reach verifying',
    );
    // The restart: the instance is stopped mid-apply; the journal stays.
    first.stop();
    assert.equal(repo.pushes.length, 1);

    const bus = fakeBus();
    const second = make(bus);
    await second.start();
    await until(() => bus.ofType('applied').length > 0, 10_000, 'the applied event after the resume');
    assert.ok(!fs.existsSync(journal), 'the journal is gone after the apply ended');
    assert.equal(repo.pushes.length, 1, 'the resumed apply must not push again');
    assert.ok(
        logs.some((l) => /in flight|resuming|carries on|pushed before the restart/.test(l)),
        `no sign of a resume in the log: ${logs.slice(-5)}`,
    );
    second.stop();
});
