// The Docker port against a fake Engine API on a unix socket of its own: containers of our compose
// project only, stop and start, the digest that runs, the prune.
import {test, describe, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import {DockerPort, DockerSocket} from '../lib/ports/docker.js';
import {tempDir} from './helpers.js';

const containers = new Map();
const calls = [];
const entry = (name, c) => ({
    Id: `id-${name}`,
    Names: [`/${name}`],
    Image: c.image,
    ImageID: `sha256:img-${name}`,
    State: c.running ? 'running' : 'exited',
    Labels: {'com.docker.compose.service': c.service, 'com.docker.compose.project': c.project ?? 'stack'},
});
const inspect = (name, c) => ({
    Id: `id-${name}`,
    Name: `/${name}`,
    RestartCount: c.restartCount ?? 0,
    Image: `sha256:img-${name}`,
    Config: {
        Image: c.image,
        Labels: {'com.docker.compose.service': c.service, 'com.docker.compose.project': c.project ?? 'stack'},
    },
    State: {Running: c.running, ExitCode: c.exitCode ?? 0, ...(c.health ? {Health: {Status: c.health}} : {})},
});
const byRef = (ref) => {
    const name = ref.startsWith('id-') ? ref.slice(3) : ref;
    const c = containers.get(name);
    return c ? [name, c] : null;
};
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://docker');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (body, status = 200) => {
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(body));
    };
    let m;
    if (req.method === 'GET' && url.pathname === '/containers/json')
        return json([...containers].map(([n, c]) => entry(n, c)));
    if (req.method === 'GET' && (m = url.pathname.match(/^\/containers\/([^/]+)\/json$/))) {
        const f = byRef(decodeURIComponent(m[1]));
        return f ? json(inspect(...f)) : json({message: 'No such container'}, 404);
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/containers\/([^/]+)\/(stop|start)$/))) {
        const f = byRef(decodeURIComponent(m[1]));
        if (!f) return json({message: 'No such container'}, 404);
        const want = m[2] === 'start';
        if (f[1].running === want) {
            res.writeHead(304);
            return res.end();
        }
        f[1].running = want;
        res.writeHead(204);
        return res.end();
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/images\/([^/]+)\/json$/))) {
        const id = decodeURIComponent(m[1]);
        const c = [...containers.values()].find((x) => `sha256:img-${x.service}` === id);
        return c
            ? json({RepoDigests: [`${c.image.split(':')[0]}@sha256:running${c.service}`]})
            : json({message: 'no such image'}, 404);
    }
    if (req.method === 'POST' && url.pathname === '/images/prune')
        return json({
            ImagesDeleted: [{Untagged: 'old:1'}, {Deleted: 'sha256:a'}, {Deleted: 'sha256:b'}],
            SpaceReclaimed: 1234567890,
        });
    json({message: `no ${req.method} ${url.pathname}`}, 404);
});
const socketPath = path.join(tempDir('docker-port'), 'docker.sock');
await new Promise((r) => server.listen(socketPath, r));
after(() => server.close());

containers.set('stacktender', {service: 'stacktender', image: 'ghcr.io/handijk/stacktender:0.1.0', running: true});
containers.set('caddy', {
    service: 'caddy',
    image: 'caddy:2.11.6-alpine',
    running: true,
    health: 'healthy',
    restartCount: 1,
});
containers.set('other-caddy', {service: 'caddy', image: 'caddy:2.9', running: true, project: 'other'});
containers.set('init', {service: 'init', image: 'alpine:3', running: false, exitCode: 0});

describe('docker port', () => {
    const port = new DockerPort({socket: new DockerSocket(socketPath), selfService: 'stacktender'});

    test('containers of our compose project, by service', async () => {
        const map = await port.containers(['caddy', 'init', 'missing']);
        assert.deepEqual([...map.keys()].sort(), ['caddy', 'init']);
        const caddy = map.get('caddy');
        assert.equal(caddy.image, 'caddy:2.11.6-alpine', "the other project's caddy is not ours");
        assert.equal(caddy.health, 'healthy');
        assert.equal(caddy.restartCount, 1);
        assert.equal(map.get('init').running, false);
        assert.equal(map.get('init').exitCode, 0);
        assert.equal(await port.ownProject(), 'stack');
    });

    test('one container, stop and start, 304 when already so', async () => {
        assert.equal((await port.container('caddy')).running, true);
        assert.equal(await port.container('nothing'), null);
        assert.equal(await port.container('other-caddy'), null, 'another project');
        await port.stop('caddy', 5);
        assert.equal(containers.get('caddy').running, false);
        await port.stop('caddy', 5);
        await port.start('caddy');
        assert.equal(containers.get('caddy').running, true);
        assert.ok(calls.some((c) => c === 'POST /containers/caddy/stop?t=5'));
    });

    test('the digest that runs, and the prune', async () => {
        assert.equal(
            await port.runningDigest({kind: 'image', name: 'caddy', services: ['caddy']}),
            'sha256:runningcaddy',
        );
        assert.equal(await port.runningDigest({kind: 'image', name: 'caddy', services: ['nope']}), null);
        assert.deepEqual(await port.pruneImages(14), {images: 2, bytes: 1234567890});
        assert.ok(calls.some((c) => c.startsWith('POST /images/prune?filters=')));
    });
});
