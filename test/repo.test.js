// The git repository port on a real repository in a temporary directory: whole-token edits, a
// commit that deploys, a deploy that fails after the commit, a revert, a dirty tree refused.
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {GitRepo, applyEdits, editPattern} from '../lib/ports/repo.js';
import {DeployFailedError} from '../lib/updates/engine.js';
import {tempDir} from './helpers.js';

describe('edits', () => {
    test('a whole-token edit does not match inside a longer version', () => {
        const text = 'a: redis:7.2\nb: redis:7.2.5\nc: redis:7.2\n';
        const out = applyEdits(() => text, [{file: 'x', find: 'redis:7.2', replace: 'redis:7.3', wholeToken: true}]);
        assert.equal(out.x, 'a: redis:7.3\nb: redis:7.2.5\nc: redis:7.3\n');
        assert.equal(editPattern({find: 'a.b', wholeToken: false}).source, 'a\\.b');
        assert.throws(
            () => applyEdits(() => 'nothing here', [{file: 'x', find: 'redis:7.2', replace: 'redis:7.3'}]),
            /expected text not found/,
        );
        assert.throws(() => applyEdits(() => null, [{file: 'x', find: 'a', replace: 'b'}]), /no such file/);
    });
});

describe('git repository', () => {
    const dir = tempDir('repo');
    fs.writeFileSync(path.join(dir, 'docker-compose.yaml'), 'services:\n  caddy:\n    image: caddy:2.11.6\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
    const deploys = [];
    let deployOk = true;
    const repo = new GitRepo({
        dir,
        deploy: async (o, n) => (
            deploys.push([o, n]),
            {ok: deployOk, output: deployOk ? 'done' : 'ERROR: build failed'}
        ),
    });

    test('init makes the directory a repository with everything committed', async () => {
        assert.equal(await repo.isRepo(), false);
        assert.equal(await repo.init(), true);
        assert.equal(await repo.init(), false);
        assert.equal(await repo.dirty(), false);
        assert.match(await repo.subject(await repo.head()), /as stacktender found it/);
    });

    test('a change is a commit that deploys from the previous head', async () => {
        const before = await repo.head();
        const sha = await repo.change(
            [{file: 'docker-compose.yaml', find: 'caddy:2.11.6', replace: 'caddy:2.11.7', wholeToken: true}],
            'bump caddy 2.11.6 → 2.11.7 (patch)',
        );
        assert.equal(sha, await repo.head());
        assert.deepEqual(deploys.at(-1), [before, sha]);
        assert.match(await repo.read('docker-compose.yaml'), /caddy:2\.11\.7/);
        assert.deepEqual(await repo.changedFiles(before, sha), ['docker-compose.yaml']);
        assert.match(await repo.show(before, 'docker-compose.yaml'), /2\.11\.6/);
        assert.equal(await repo.isAncestor(before, sha), true);
        assert.equal(await repo.isAncestor(sha, before), false);
    });

    test('a deploy that fails after the commit is a DeployFailedError; the commit stays', async () => {
        deployOk = false;
        const before = await repo.head();
        await assert.rejects(
            repo.change([{file: 'README.md', find: 'hi', replace: 'hello'}], 'docs'),
            (err) => err instanceof DeployFailedError && /build failed/.test(err.message),
        );
        assert.notEqual(await repo.head(), before, 'the commit landed');
        deployOk = true;
    });

    test('a revert is a commit that deploys too; a dirty tree is refused', async () => {
        const bad = await repo.head();
        const reverted = await repo.revert(bad);
        assert.equal(await repo.read('README.md'), 'hi\n');
        assert.equal(deploys.at(-1)[1], reverted);
        fs.writeFileSync(path.join(dir, 'README.md'), 'edited by hand\n');
        await assert.rejects(
            repo.change([{file: 'docker-compose.yaml', find: 'caddy:2.11.7', replace: 'caddy:2.11.8'}], 'x'),
            /uncommitted changes/,
        );
        execFileSync('git', ['checkout', '--', 'README.md'], {cwd: dir});
        assert.equal(await repo.dirty(), false);
    });
});
