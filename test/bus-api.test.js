// The bus: webhooks in their formats, the maintenance signals between sources; the API: a few
// routes through to stub engines, errors as statuses.
import {test, describe, after} from 'node:test';
import assert from 'node:assert/strict';

import {Bus, normalizeHook, webhookBody} from '../lib/bus.js';
import {createApi} from '../lib/api.js';
import {RequestError} from '../lib/backups/engine.js';

describe('bus', () => {
    test('webhook formats', () => {
        assert.deepEqual(normalizeHook('https://ntfy.sh/stack'), {url: 'https://ntfy.sh/stack', format: 'text'});
        assert.equal(normalizeHook('https://discord.com/api/webhooks/1/x').format, 'discord');
        assert.equal(normalizeHook('https://hooks.slack.com/services/x').format, 'slack');
        assert.equal(normalizeHook('https://example.org/hook').format, 'json');
        const event = {
            type: 'rolled_back',
            item: {name: 'caddy', current: '1', target: '2'},
            problem: 'unhealthy',
            data: 'restored abc',
        };
        assert.equal(
            webhookBody({format: 'text'}, 'rolled_back', event).body,
            'rolled back caddy 1 → 2: unhealthy (data: restored abc)',
        );
        assert.equal(webhookBody({format: 'text'}, 'rolled_back', event).headers.Tags, 'warning');
        assert.match(
            JSON.parse(webhookBody({format: 'discord'}, 'applied', {item: {name: 'x', current: '1', target: '2'}}).body)
                .content,
            /applied x 1 → 2/,
        );
        const json = JSON.parse(webhookBody({format: 'json'}, 'applied', {item: {name: 'x'}}).body);
        assert.equal(json.source, 'stacktender');
        assert.equal(json.type, 'applied');
    });

    test('events reach the hooks and the log; signals of other sources count as work', async () => {
        const sent = [];
        const published = [];
        const publisher = {
            maintenance: async (source, active, info) => published.push(['maintenance', source, active, info.what]),
            event: async (e) => published.push(['event', e.type]),
            state: async (source) => published.push(['state', source]),
        };
        const bus = new Bus({
            webhooks: ['https://example.org/hook'],
            publisher,
            fetch: async (url, init) => (sent.push({url, body: init.body}), {ok: true}),
        });
        const updates = bus.forSource('updates');
        const backups = bus.forSource('backups');
        await updates.event('applied', {item: {name: 'x', current: '1', target: '2'}});
        assert.equal(sent.length, 1);
        assert.equal(bus.events[0].source, 'updates');
        await backups.maintenance(true, {what: 'nightly'});
        assert.deepEqual(updates.otherWork(), ['backups']);
        assert.deepEqual(backups.otherWork(), []);
        await backups.maintenance(false, {});
        assert.deepEqual(updates.otherWork(), []);
        await bus.maintenance('deploy', true, {since: new Date(Date.now() - 31 * 60_000).toISOString()});
        assert.deepEqual(updates.otherWork(), [], 'a signal without an end goes stale after 30 minutes');
        await updates.state({items: []});
        assert.deepEqual(published, [
            ['event', 'applied'],
            ['maintenance', 'backups', true, 'nightly'],
            ['maintenance', 'backups', false, undefined],
            ['maintenance', 'deploy', true, undefined],
            ['state', 'updates'],
        ]);
    });
});

describe('api', () => {
    const calls = [];
    const api = createApi({
        pkg: {name: 'stacktender', version: '0.0.1'},
        updates: {
            status: {level: 'running', message: 'ok'},
            list: (o) => ({items: [], only: o.only}),
            dismiss: async (id, o) => (calls.push(['dismiss', id, o]), {ok: true}),
            apply: async (id) => ({error: `no such finding ${id}`}),
            undo: async () => ({undoable: []}),
            scanNow: () => ({ok: true}),
        },
        backups: {
            status: {level: 'idle', message: 'ok'},
            setsInfo: () => ({sets: [], by_service: {}, ready: true}),
            snapshots: async () => [],
            snapshot: () => {
                throw new RequestError(409, 'busy');
            },
            job: () => null,
            runs: [],
            briefRun: (r) => r,
            lastNightly: null,
        },
        deploy: {lastDeployed: 'abc', runs: [], deploy: async (o, n) => ({ok: true, output: `${o}..${n}`})},
        bus: {
            snapshot: () => ({states: {}, maintenance: {}, events: []}),
            events: [],
            maintenance: async () => undefined,
        },
        repo: {head: async () => 'headsha'},
        scanner: {lastResult: null},
    });
    let base;
    test('routes', async () => {
        const address = await api.listen(0);
        base = `http://127.0.0.1:${address.port}`;
        const status = await (await fetch(`${base}/status`)).json();
        assert.equal(status.version, '0.0.1');
        assert.equal(status.last_deployed, 'abc');
        const list = await (await fetch(`${base}/updates?only=silent`)).json();
        assert.equal(list.only, 'silent');
        const d = await fetch(`${base}/updates/abc12345/dismiss`, {
            method: 'POST',
            body: JSON.stringify({days: 3, reason: 'later'}),
            headers: {'Content-Type': 'application/json'},
        });
        assert.equal(d.status, 200);
        assert.deepEqual(calls[0], ['dismiss', 'abc12345', {days: 3, reason: 'later'}]);
        const bad = await fetch(`${base}/updates/nope/apply`, {method: 'POST'});
        assert.equal(bad.status, 400);
        const busy = await fetch(`${base}/backups/snapshot`, {method: 'POST', body: '{}'});
        assert.equal(busy.status, 409);
        assert.equal((await busy.json()).error, 'busy');
        const dep = await (
            await fetch(`${base}/deploy`, {
                method: 'POST',
                body: JSON.stringify({old: 'o'}),
                headers: {'Content-Type': 'application/json'},
            })
        ).json();
        assert.equal(dep.output, 'o..headsha');
        const own = await fetch(`${base}/maintenance`, {method: 'POST', body: JSON.stringify({source: 'updates'})});
        assert.equal(own.status, 400);
        assert.equal((await fetch(`${base}/nothing`)).status, 404);
    });
    after(() => api.close());
});
