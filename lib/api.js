/**
 * The HTTP API on localhost: the list and the history, approve/dismiss/undo, a scan, the backups,
 * a deploy (for the git hook of a push by hand), the maintenance signal of an outside source. JSON
 * in, JSON out, no authentication: bind it to localhost or put it behind something that has one.
 */

import http from 'node:http';
import {RequestError} from './backups/engine.js';

const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text)});
    res.end(text);
};

const readBody = (req) =>
    new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
            } catch {
                resolve({});
            }
        });
    });

/**
 * @param {object} a
 * @param {object} a.updates the Updates engine
 * @param {object} a.backups the Backups engine
 * @param {object} a.deploy the Deploy
 * @param {object} a.bus the Bus
 * @param {object} a.repo
 * @param {object} [a.scanner]
 * @param {object} a.pkg
 */
export function createApi({updates, backups, deploy, bus, repo, scanner, pkg}) {
    const routes = [];
    const route = (method, pattern, handler) =>
        routes.push({method, pattern: new RegExp(`^${pattern.replace(/:[a-z]+/g, '([^/]+)')}$`), handler});

    route('GET', '/', () => ({name: pkg.name, version: pkg.version, status: updates.status, backups: backups.status}));
    route('GET', '/status', () => ({
        version: pkg.version,
        updates: updates.status,
        backups: backups.status,
        last_scan: scanner?.lastResult ?? null,
        last_deployed: deploy.lastDeployed,
        ...bus.snapshot(),
    }));
    route('GET', '/updates', (q) => updates.list({only: q.get('only') ?? 'all'}));
    route('POST', '/updates/:id/apply', (_q, body, [id]) => updates.apply(id, {inWindow: body.in_window === true}));
    route('POST', '/updates/:id/dismiss', (_q, body, [id]) =>
        updates.dismiss(id, {days: body.days, reason: body.reason}),
    );
    route('POST', '/updates/:id/undo', (_q, _b, [id]) => updates.undo(id));
    route('GET', '/updates/undoable', () => updates.undo());
    route('POST', '/scan', () => updates.scanNow());
    route('GET', '/backups', () => ({
        ...backups.setsInfo(),
        status: backups.status,
        last_nightly: backups.lastNightly,
        runs: backups.runs.slice(-10).map((r) => backups.briefRun(r)),
    }));
    route('GET', '/backups/sets', () => backups.setsInfo());
    route('GET', '/backups/snapshots', (q) =>
        backups
            .snapshots({set: q.get('set'), tag: q.get('tag'), since: q.get('since'), refresh: q.get('refresh') === '1'})
            .then((snapshots) => ({snapshots})),
    );
    route('POST', '/backups/snapshot', (_q, body) => backups.snapshot(body));
    route('POST', '/backups/restore', (_q, body) => backups.restore(body));
    route('POST', '/backups/now', (_q, body) => backups.backupNow(body));
    route('GET', '/backups/jobs/:id', (_q, _b, [id]) => backups.job(id) ?? new RequestError(404, 'no such job'));
    route('POST', '/deploy', async (_q, body) => {
        const old = String(body.old ?? '');
        const head = body.new ? String(body.new) : await repo.head();
        return deploy.deploy(old, head, {reason: String(body.reason ?? 'push')});
    });
    route('GET', '/deploys', () => ({runs: deploy.runs.map((r) => ({...r, output: undefined}))}));
    route(
        'GET',
        '/deploys/:id',
        (_q, _b, [id]) => deploy.runs.find((r) => r.id === id) ?? new RequestError(404, 'no such deploy'),
    );
    route('POST', '/maintenance', (_q, body) => {
        const source = String(body.source ?? 'external');
        if (['updates', 'backups', 'deploy'].includes(source))
            return new RequestError(400, "that source is stacktender's own");
        return bus
            .maintenance(source, body.active !== false, {what: body.what, since: body.since})
            .then(() => ({ok: true}));
    });
    route('GET', '/events', (q) => ({events: bus.events.slice(-Number(q.get('limit') ?? 50))}));

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const found = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!found) return json(res, 404, {error: `no ${req.method} ${url.pathname}`});
        const params = url.pathname.match(found.pattern).slice(1).map(decodeURIComponent);
        try {
            const body = req.method === 'POST' ? await readBody(req) : {};
            const out = await found.handler(url.searchParams, body, params);
            if (out instanceof RequestError) return json(res, out.status, {error: out.message});
            json(
                res,
                out && typeof out === 'object' && 'error' in out && Object.keys(out).length <= 3 ? 400 : 200,
                out ?? {ok: true},
            );
        } catch (err) {
            if (err instanceof RequestError) return json(res, err.status, {error: err.message});
            json(res, 500, {error: err?.message ?? String(err)});
        }
    });
    return {
        server,
        listen: (port, host = '127.0.0.1') =>
            new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
