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
            if (args[0] === 'compose' && args.includes('config') && args.includes('--services'))
                return {code: 0, output: 'app\ndb\nstacktender\n'};
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
        assert.ok(
            dockerCalls.includes('compose up -d --remove-orphans app db'),
            `everything but stacktender itself, since the compose file changed: ${dockerCalls.filter((c) => c.startsWith('compose up'))}`,
        );
        assert.ok(!result.output.includes('recreated once'), "stacktender's own definition did not change");
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

    test('a build that reproduces the running image ends there: no copy, no recreate', async () => {
        const stackDir = tempDir('deploy-stack-same');
        const dataDir = tempDir('deploy-data-same');
        const compose = 'services:\n  app:\n    build: ./app\n    volumes: ["./app-data:/data"]\n';
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), compose);
        let builtId = 'sha256:one';
        const docker = {
            started: [],
            async containers(wanted) {
                return new Map(
                    wanted
                        .filter((s) => s === 'app')
                        .map((s) => [s, {service: s, running: true, image: 'stack-app', imageId: 'sha256:one'}]),
                );
            },
            async container() {
                return null;
            },
            async start(name) {
                this.started.push(name);
            },
        };
        const jobs = [];
        const backups = {
            setsInfo() {
                return {sets: [], by_service: {app: 'app'}, ready: true};
            },
            snapshot(body) {
                jobs.push(body);
                return {job: 'snap-1', sets: ['app'], stop: ['app']};
            },
            job() {
                return {done: true, ok: true, stopped: ['app']};
            },
        };
        const repo = {
            async read() {
                return compose;
            },
            async subject() {
                return 'a test file';
            },
            async exists() {
                return false;
            },
            async isAncestor() {
                return false;
            },
            async changedFiles() {
                return ['app/test/x.test.js'];
            },
            async show() {
                return compose;
            },
        };
        const dockerCalls = [];
        const run = async (args) => {
            dockerCalls.push(args.join(' '));
            if (args[0] === 'compose' && args.includes('config') && args.includes('--format'))
                return {
                    code: 0,
                    output: JSON.stringify({
                        name: 'stack',
                        services: {app: {build: {context: path.join(stackDir, 'app')}}},
                    }),
                };
            if (args[0] === 'image' && args[1] === 'inspect') return {code: 0, output: `${builtId}\n`};
            return {code: 0, output: ''};
        };
        const shellCalls = [];
        const deploy = new Deploy({
            stackDir,
            dataDir,
            repo,
            backups,
            docker,
            bus: fakeBus(),
            cfg: {selfService: 'stacktender', test: 'npm test', reload: []},
            run,
            shell: async (cmd) => {
                shellCalls.push(cmd);
                return {code: 0, output: 'ok\n'};
            },
        });
        const same = await deploy.deploy('aaaaaaaa', 'bbbbbbbb');
        assert.equal(same.ok, true, same.output);
        assert.ok(dockerCalls.includes('compose build app'), dockerCalls.join('\n'));
        assert.deepEqual(shellCalls, ['npm test'], 'the gate runs: the context changed, and a string is a command');
        assert.match(same.output, /same image after the build: app/);
        assert.deepEqual(jobs, [], 'no copy');
        assert.ok(!dockerCalls.some((c) => c.startsWith('compose up')), 'no recreate');
        assert.equal(fs.readFileSync(path.join(dataDir, 'last-deployed-sha'), 'utf-8'), 'bbbbbbbb');

        // The same change with a build that produces a new image: the copy and the recreate as before.
        builtId = 'sha256:two';
        dockerCalls.length = 0;
        const changed = await deploy.deploy('bbbbbbbb', 'cccccccc');
        assert.equal(changed.ok, true, changed.output);
        assert.deepEqual(jobs, [{services: ['app'], tag: 'deploy:cccccccc', start: false}], 'the copy');
        assert.ok(dockerCalls.includes('compose up -d app'), dockerCalls.join('\n'));
        assert.deepEqual(docker.started, ['app'], 'what the copy stopped runs again');
    });

    test('its own definition changed: recreated after the answer, by a helper container', async () => {
        const stackDir = tempDir('deploy-stack-self');
        const dataDir = tempDir('deploy-data-self');
        const composeOld =
            'services:\n  stacktender:\n    image: ghcr.io/x/stacktender:1\n  web:\n    image: nginx:1\n';
        const composeNew = composeOld.replace('stacktender:1', 'stacktender:2');
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), composeNew);
        const docker = {
            async container(name) {
                return name === 'stacktender'
                    ? {running: true, image: 'ghcr.io/x/stacktender:1', imageId: 'sha256:one', restartCount: 0}
                    : null;
            },
            async containers() {
                return new Map();
            },
            async start() {},
        };
        const backups = {
            setsInfo() {
                return {sets: [], by_service: {}, ready: true};
            },
        };
        const repo = {
            async read() {
                return composeNew;
            },
            async subject() {
                return 'stacktender 2';
            },
            async exists() {
                return false;
            },
            async isAncestor() {
                return false;
            },
            async changedFiles() {
                return ['docker-compose.yaml'];
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
                for (const m of text.matchAll(/^ {2}(\w+):\n {4}image: (.*)\n/gm)) services[m[1]] = {image: m[2]};
                return {code: 0, output: JSON.stringify({name: 'stack', services})};
            }
            return {code: 0, output: ''};
        };
        const deploy = new Deploy({
            stackDir,
            dataDir,
            repo,
            backups,
            docker,
            bus: fakeBus(),
            cfg: {selfService: 'stacktender', reload: []},
            run,
            socketPath: '/run/docker.sock',
        });
        deploy.selfRecreateDelayMs = 10;
        const result = await deploy.deploy('aaaaaaaa', 'bbbbbbbb');
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /recreated once this deploy has answered/);
        assert.ok(dockerCalls.includes('compose up -d --remove-orphans web'), 'everything but itself, right away');
        assert.ok(!dockerCalls.some((c) => c.includes('--no-deps')), 'not itself before the answer');
        await new Promise((res) => setTimeout(res, 60));
        const helper = dockerCalls.find((c) => c.startsWith('run -d --rm --name stacktender-recreate-'));
        assert.ok(helper, dockerCalls.join('\n'));
        assert.ok(
            helper.endsWith(
                `-v /run/docker.sock:/var/run/docker.sock -v ${stackDir}:${stackDir} -w ${stackDir} --entrypoint docker ghcr.io/x/stacktender:1 compose up -d --no-deps stacktender`,
            ),
            helper,
        );
    });

    test('a change of its configuration file: recreated with --force-recreate after the answer', async () => {
        const stackDir = tempDir('deploy-stack-config');
        const dataDir = tempDir('deploy-data-config');
        const compose = 'services:\n  stacktender:\n    image: ghcr.io/x/stacktender:1\n  web:\n    image: nginx:1\n';
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), compose);
        const docker = {
            async container(name) {
                return name === 'stacktender'
                    ? {running: true, image: 'ghcr.io/x/stacktender:1', imageId: 'sha256:one', restartCount: 0}
                    : null;
            },
            async containers() {
                return new Map();
            },
            async start() {},
        };
        const repo = {
            async read() {
                return compose;
            },
            async subject() {
                return 'autopilot on';
            },
            async exists() {
                return false;
            },
            async isAncestor() {
                return false;
            },
            async changedFiles() {
                return ['stacktender.yaml'];
            },
            async show() {
                return compose;
            },
        };
        const dockerCalls = [];
        const run = async (args) => {
            dockerCalls.push(args.join(' '));
            if (args[0] === 'compose' && args.includes('config') && args.includes('--format'))
                return {
                    code: 0,
                    output: JSON.stringify({
                        name: 'stack',
                        services: {stacktender: {image: 'ghcr.io/x/stacktender:1'}, web: {image: 'nginx:1'}},
                    }),
                };
            return {code: 0, output: ''};
        };
        const deploy = new Deploy({
            stackDir,
            dataDir,
            repo,
            backups: {setsInfo: () => ({sets: [], by_service: {}, ready: true})},
            docker,
            bus: fakeBus(),
            cfg: {selfService: 'stacktender', reload: []},
            run,
        });
        deploy.selfRecreateDelayMs = 10;
        const result = await deploy.deploy('aaaaaaaa', 'bbbbbbbb');
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /own configuration changed: it is recreated/);
        assert.ok(!dockerCalls.some((c) => c.startsWith('compose up')), 'nothing else is touched');
        await new Promise((res) => setTimeout(res, 60));
        const helper = dockerCalls.find((c) => c.startsWith('run -d --rm --name stacktender-recreate-'));
        assert.ok(helper, dockerCalls.join('\n'));
        assert.ok(helper.endsWith('compose up -d --no-deps --force-recreate stacktender'), helper);
    });

    test('a slow reload does not bring its own recreate forward: the helper starts after the answer', async () => {
        const stackDir = tempDir('deploy-stack-slow');
        const dataDir = tempDir('deploy-data-slow');
        const compose = 'services:\n  stacktender:\n    image: ghcr.io/x/stacktender:1\n  web:\n    image: nginx:1\n';
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), compose);
        const docker = {
            async container(name) {
                return name === 'stacktender'
                    ? {running: true, image: 'ghcr.io/x/stacktender:1', imageId: 'sha256:one', restartCount: 0}
                    : null;
            },
            async containers() {
                return new Map();
            },
            async start() {},
        };
        const repo = {
            async read() {
                return compose;
            },
            async subject() {
                return 'config and an automation';
            },
            async exists() {
                return false;
            },
            async isAncestor() {
                return false;
            },
            async changedFiles() {
                return ['stacktender.yaml', 'statebridge/automations/a.ts'];
            },
            async show() {
                return compose;
            },
        };
        const dockerCalls = [];
        const run = async (args) => {
            dockerCalls.push(args.join(' '));
            if (args[0] === 'compose' && args.includes('config') && args.includes('--format'))
                return {
                    code: 0,
                    output: JSON.stringify({
                        name: 'stack',
                        services: {stacktender: {image: 'ghcr.io/x/stacktender:1'}, web: {image: 'nginx:1'}},
                    }),
                };
            return {code: 0, output: ''};
        };
        const deploy = new Deploy({
            stackDir,
            dataDir,
            repo,
            backups: {setsInfo: () => ({sets: [], by_service: {}, ready: true})},
            docker,
            bus: fakeBus(),
            cfg: {selfService: 'stacktender', reload: [{paths: ['statebridge/automations/'], command: 'reload'}]},
            run,
            // The reload outlasts the recreate delay by far.
            shell: async () => {
                await new Promise((res) => setTimeout(res, 50));
                return {code: 0, output: ''};
            },
        });
        deploy.selfRecreateDelayMs = 10;
        const result = await deploy.deploy('aaaaaaaa', 'bbbbbbbb');
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /reload: reload/);
        assert.ok(!dockerCalls.some((c) => c.includes('stacktender-recreate-')), 'not before the answer');
        await new Promise((res) => setTimeout(res, 60));
        const helper = dockerCalls.find((c) => c.startsWith('run -d --rm --name stacktender-recreate-'));
        assert.ok(helper, dockerCalls.join('\n'));
        assert.ok(helper.endsWith('compose up -d --no-deps --force-recreate stacktender'), helper);
    });

    test('reload after the compose up, retried while the recreated service starts', async () => {
        const stackDir = tempDir('deploy-stack-reload');
        const dataDir = tempDir('deploy-data-reload');
        const compose = 'services:\n  app:\n    image: app:1\n';
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), compose.replace('app:1', 'app:2'));
        const order = [];
        let reloads = 0;
        const deploy = new Deploy({
            stackDir,
            dataDir,
            repo: {
                async read() {
                    return compose.replace('app:1', 'app:2');
                },
                async subject() {
                    return 'a mount and code';
                },
                async exists() {
                    return false;
                },
                async isAncestor() {
                    return false;
                },
                async changedFiles() {
                    return ['docker-compose.yaml', 'app/automations/x.ts'];
                },
                async show() {
                    return compose;
                },
            },
            backups: {setsInfo: () => ({sets: [], by_service: {}, ready: true})},
            docker: {
                async container() {
                    return null;
                },
                async containers() {
                    return new Map();
                },
                async start() {},
            },
            bus: fakeBus(),
            cfg: {selfService: 'stacktender', reload: [{paths: ['app/automations/'], command: 'reload app'}]},
            run: async (args) => {
                if (args[0] === 'compose' && args.includes('up')) order.push('up');
                if (args[0] === 'compose' && args.includes('config') && args.includes('--format'))
                    return {
                        code: 0,
                        output: JSON.stringify({
                            name: 'stack',
                            services: {app: {image: args.includes('-f') ? 'app:1' : 'app:2'}},
                        }),
                    };
                return {code: 0, output: ''};
            },
            shell: async (cmd) => {
                order.push(cmd);
                reloads++;
                return reloads < 3 ? {code: 1, output: 'connection refused'} : {code: 0, output: '{}'};
            },
        });
        deploy.reloadRetryMs = 1;
        const result = await deploy.deploy('aaaaaaaa', 'bbbbbbbb');
        assert.equal(result.ok, true, result.output);
        assert.deepEqual(
            order,
            ['up', 'reload app', 'reload app', 'reload app'],
            'up first, then the reload until it answers',
        );
        assert.ok(!result.output.includes('reload failed'), result.output);
    });

    test('a backup run in progress: the deploy waits for it before it touches a container', async () => {
        const stackDir = tempDir('deploy-stack-busy');
        const dataDir = tempDir('deploy-data-busy');
        const compose = 'services:\n  web:\n    image: nginx:1\n';
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), compose.replace('nginx:1', 'nginx:2'));
        const backups = {
            current: {kind: 'nightly', id: 'n1'},
            setsInfo: () => ({sets: [], by_service: {}, ready: true}),
        };
        setTimeout(() => {
            backups.current = null;
        }, 50);
        const dockerCalls = [];
        const run = async (args) => {
            dockerCalls.push({at: Date.now(), call: args.join(' ')});
            if (args[0] === 'compose' && args.includes('config') && args.includes('--format'))
                return {
                    code: 0,
                    output: JSON.stringify({
                        name: 'stack',
                        services: {web: {image: args.includes('-f') ? 'nginx:1' : 'nginx:2'}},
                    }),
                };
            return {code: 0, output: ''};
        };
        const deploy = new Deploy({
            stackDir,
            dataDir,
            repo: {
                async read() {
                    return compose.replace('nginx:1', 'nginx:2');
                },
                async subject() {
                    return 'nginx 2';
                },
                async exists() {
                    return false;
                },
                async isAncestor() {
                    return false;
                },
                async changedFiles() {
                    return ['docker-compose.yaml'];
                },
                async show() {
                    return compose;
                },
            },
            backups,
            docker: {
                async container() {
                    return null;
                },
                async containers() {
                    return new Map();
                },
                async start() {},
            },
            bus: fakeBus(),
            cfg: {selfService: 'stacktender', reload: []},
            run,
        });
        deploy.backupsWaitMs = 10;
        const started = Date.now();
        const result = await deploy.deploy('aaaaaaaa', 'bbbbbbbb');
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /a backup run is in progress \(nightly\); waiting for it/);
        const up = dockerCalls.find((c) => c.call.startsWith('compose up'));
        assert.ok(up && up.at - started >= 50, 'compose up went before the backup run ended');
    });
});
