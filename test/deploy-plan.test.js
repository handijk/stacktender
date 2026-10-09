// The pure parts of the deploy: which services a change rebuilds, which images changed between
// two compose files, which data directories to create; and one deploy end to end against fakes.
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {Deploy, classify, dataDirs, imageChanges} from '../lib/deploy.js';
import {fakeBus, tempDir} from './helpers.js';

describe('the plan', () => {
    test('changed files fall into build contexts, the compose file, or reload paths', () => {
        const contexts = {statebridge: 'statebridge', chat: 'chat', root: '.'};
        const plan = classify(
            [
                'statebridge/lib/x.ts',
                'chat/Dockerfile',
                'docs/README.md',
                'docker-compose.yaml',
                'statebridge/automations/a.ts',
            ],
            contexts,
            {reloadPaths: ['statebridge/automations/']},
        );
        assert.deepEqual(plan, {
            build: ['chat', 'statebridge'],
            composeChanged: true,
            reload: ['statebridge/automations/'],
        });
        assert.deepEqual(classify(['README.md'], contexts), {build: [], composeChanged: false, reload: []});
        assert.deepEqual(
            classify(['a/b/c.js'], {outer: 'a', inner: 'a/b'}).build,
            ['inner'],
            'the longest prefix wins',
        );
    });

    test('image changes between two compose documents', () => {
        const old = {services: {a: {image: 'x:1'}, b: {image: 'y:1'}, c: {build: '.'}}};
        const now = {services: {a: {image: 'x:2'}, b: {image: 'y:1'}, c: {build: '.'}, d: {image: 'z:1'}}};
        assert.deepEqual(imageChanges(old, now), ['a']);
        assert.deepEqual(imageChanges(null, now), []);
    });

    test('data directories of the compose file', () => {
        assert.deepEqual(
            dataDirs(
                'services:\n  a:\n    volumes:\n      - ./a-data:/d\n      - ./b-data/sub:/s\n      - ./conf:/c\n      - /var/run/x:/x\n',
            ),
            ['a-data', 'b-data'],
        );
    });
});

describe('a deploy against fakes', () => {
    test('build, test gate, copy before an image change, up, marker', async () => {
        const stackDir = tempDir('deploy-stack');
        const dataDir = tempDir('deploy-data');
        const composeOld =
            'services:\n  app:\n    build: ./app\n  db:\n    image: postgres:17.1\n    volumes: ["./db-data:/var/lib/postgresql/data"]\n';
        const composeNew = composeOld.replace('postgres:17.1', 'postgres:17.2');
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), composeNew);
        const docker = {
            started: [],
            async container(name) {
                return name === 'db'
                    ? {running: true, image: 'postgres:17.1', imageId: 'sha256:db', restartCount: 0}
                    : null;
            },
            async start(name) {
                this.started.push(name);
            },
        };
        const jobs = [];
        const backups = {
            ready: true,
            setsInfo() {
                return {sets: [], by_service: {db: 'db'}, ready: this.ready};
            },
            snapshot(body) {
                jobs.push(body);
                return {job: 'snap-1', sets: ['db'], stop: ['db']};
            },
            job() {
                return {done: true, ok: true, stopped: ['db']};
            },
        };
        const repo = {
            async read() {
                return composeNew;
            },
            async subject() {
                return 'bump postgres';
            },
            async exists() {
                return false;
            },
            async isAncestor() {
                return false;
            },
            async changedFiles() {
                return ['docker-compose.yaml', 'app/server.js'];
            },
            async show() {
                return composeOld;
            },
        };
        const dockerCalls = [];
        const run = async (args) => {
            dockerCalls.push(args.join(' '));
            if (args[0] === 'compose' && args.includes('config') && args.includes('--format')) {
                const text = args.includes('-f') ? composeOld : composeNew;
                const services = {};
                for (const m of text.matchAll(/^ {2}(\w+):\n((?: {4}.*\n)*)/gm)) {
                    const body = m[2];
                    services[m[1]] = {
                        ...(/build: (.*)/.exec(body) ? {build: {context: path.join(stackDir, 'app')}} : {}),
                        ...(/image: (.*)/.exec(body) ? {image: /image: (.*)/.exec(body)[1]} : {}),
                    };
                }
                return {code: 0, output: JSON.stringify({services})};
            }
            return {code: 0, output: ''};
        };
        const shellCalls = [];
        const shell = async (cmd) => {
            shellCalls.push(cmd);
            return {code: 0, output: '12 passed\n'};
        };
        const bus = fakeBus();
        const deploy = new Deploy({
            stackDir,
            dataDir,
            repo,
            backups,
            docker,
            bus,
            cfg: {selfService: 'stacktender', test: {command: 'npm test', paths: ['app/']}, reload: []},
            run,
            shell,
        });
        const result = await deploy.deploy('aaaaaaaa', 'bbbbbbbb');
        assert.equal(result.ok, true, result.output);
        assert.ok(dockerCalls.includes('compose build app'), dockerCalls.join('\n'));
        assert.deepEqual(shellCalls, ['npm test']);
        assert.deepEqual(
            jobs,
            [{services: ['db'], tag: 'deploy:bbbbbbbb', start: false}],
            'the copy before the image change',
        );
        assert.ok(dockerCalls.includes('compose up -d'), 'everything, since the compose file changed');
        assert.deepEqual(docker.started, ['db'], 'what the copy stopped runs again');
        assert.equal(fs.readFileSync(path.join(dataDir, 'last-deployed-sha'), 'utf-8'), 'bbbbbbbb');
        assert.ok(fs.existsSync(path.join(stackDir, 'db-data')), 'the data directory was created as us');
        assert.equal(bus.signals.at(-1).active, false);

        // A failing test gate refuses the deploy before anything is recreated; what was stopped is started.
        const bad = new Deploy({
            stackDir,
            dataDir,
            repo,
            backups,
            docker,
            bus,
            cfg: {selfService: 'stacktender', test: {command: 'npm test', paths: ['app/']}},
            run,
            shell: async () => ({code: 1, output: 'FAIL'}),
        });
        const refused = await bad.deploy('bbbbbbbb', 'cccccccc');
        assert.equal(refused.ok, false);
        assert.match(refused.output, /the tests fail/);
        assert.equal(
            fs.readFileSync(path.join(dataDir, 'last-deployed-sha'), 'utf-8'),
            'bbbbbbbb',
            'the marker stays at the last deploy that went through',
        );
        assert.ok(bus.ofType('deploy_failed').length === 1);
    });
});
