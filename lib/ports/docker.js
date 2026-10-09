/**
 * Docker over its unix socket: the Engine API with node:http, and on it the port the engines use.
 * Containers are looked at through the compose project stacktender itself runs in (found by the
 * label of the `selfService` container), so another project with the same service names on the
 * machine is never mistaken for ours.
 */

import http from 'node:http';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

/**
 * The socket the docker CLI on this machine talks to: DOCKER_SOCKET, else a unix DOCKER_HOST, else
 * the current docker context (Docker Desktop keeps its daemon on a socket of its own), else the
 * usual place. The runners and the deploy go through the CLI, so the port must see the same daemon.
 */
export function resolveDockerSocket() {
    if (process.env.DOCKER_SOCKET) return process.env.DOCKER_SOCKET;
    const host = process.env.DOCKER_HOST ?? '';
    if (host.startsWith('unix://')) return host.slice('unix://'.length);
    try {
        const out = execFileSync('docker', ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'], {
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();
        if (out.startsWith('unix://')) return out.slice('unix://'.length);
    } catch {
        // no docker CLI, or no context
    }
    return '/var/run/docker.sock';
}

export class DockerSocket {
    constructor(socketPath = resolveDockerSocket()) {
        this.socketPath = socketPath;
    }

    /** Status and body as they came; nothing thrown for a non-2xx. */
    call(method, path, body) {
        return new Promise((resolve, reject) => {
            const data = body === undefined ? null : JSON.stringify(body);
            const req = http.request(
                {
                    socketPath: this.socketPath,
                    path,
                    method,
                    headers: data
                        ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}
                        : {},
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () =>
                        resolve({status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8')}),
                    );
                },
            );
            req.on('error', reject);
            req.setTimeout(60_000, () => req.destroy(new Error(`docker API ${method} ${path}: timeout`)));
            if (data) req.write(data);
            req.end();
        });
    }

    /** The parsed JSON of a 200 answer; anything else throws with the start of the body. */
    async json(path, method = 'GET', body) {
        const {status, body: text} = await this.call(method, path, body);
        if (status !== 200) throw new Error(`docker API ${status}: ${text.slice(0, 200)}`);
        return JSON.parse(text);
    }
}

export class DockerPort {
    /**
     * @param {object} a
     * @param {DockerSocket} [a.socket]
     * @param {string} [a.selfService] the compose service stacktender runs as; its project is ours
     * @param {string} [a.project] the compose project, when known (overrides the lookup)
     */
    constructor({socket = new DockerSocket(), selfService = 'stacktender', project = null} = {}) {
        this.socket = socket;
        this.selfService = selfService;
        this.project = project;
        this.looked = Boolean(project);
    }

    async list() {
        return this.socket.json('/containers/json?all=true');
    }

    /** Our compose project, read off the stacktender container's label; null outside compose (then nothing is filtered). */
    async ownProject(list) {
        if (this.looked) return this.project;
        const all = list ?? (await this.list());
        const self = all.find((c) => c.Labels?.['com.docker.compose.service'] === this.selfService);
        this.project = self?.Labels?.['com.docker.compose.project'] ?? null;
        this.looked = true;
        return this.project;
    }

    /** Current container per compose service: image, running, exit code, health, restarts. */
    async containers(wanted) {
        const out = new Map();
        const list = await this.list();
        const project = await this.ownProject(list);
        for (const c of list) {
            const service = c.Labels?.['com.docker.compose.service'];
            if (!service || !wanted.includes(service)) continue;
            if (project && c.Labels?.['com.docker.compose.project'] !== project) continue;
            const info = await this.socket.json(`/containers/${c.Id}/json`);
            out.set(service, {
                service,
                name: String(info.Name ?? '').replace(/^\//, ''),
                image: String(info.Config?.Image ?? c.Image ?? ''),
                running: info.State?.Running === true,
                exitCode: typeof info.State?.ExitCode === 'number' ? info.State.ExitCode : null,
                health: info.State?.Health?.Status ?? null,
                restartCount: Number(info.RestartCount ?? 0),
            });
        }
        return out;
    }

    /** One container by name, or null when our project has none of that name. */
    async container(name) {
        const r = await this.socket.call('GET', `/containers/${encodeURIComponent(name)}/json`);
        if (r.status === 404) return null;
        if (r.status !== 200) throw new Error(`docker API ${r.status}: ${r.body.slice(0, 200)}`);
        const info = JSON.parse(r.body);
        const project = await this.ownProject();
        if (project && info.Config?.Labels?.['com.docker.compose.project'] !== project) return null;
        return {
            running: info.State?.Running === true,
            image: String(info.Config?.Image ?? ''),
            imageId: String(info.Image ?? ''),
            restartCount: Number(info.RestartCount ?? 0),
        };
    }

    async stop(name, seconds = 30) {
        const r = await this.socket.call('POST', `/containers/${encodeURIComponent(name)}/stop?t=${seconds}`);
        if (r.status !== 204 && r.status !== 304)
            throw new Error(`stopping ${name}: docker API ${r.status}: ${r.body.slice(0, 200)}`);
    }

    async start(name) {
        const r = await this.socket.call('POST', `/containers/${encodeURIComponent(name)}/start`);
        if (r.status !== 204 && r.status !== 304)
            throw new Error(`starting ${name}: docker API ${r.status}: ${r.body.slice(0, 200)}`);
    }

    /** The digest of the image a finding's services run on right now, or of a base image as it sits in the local store. */
    async runningDigest(item) {
        const ofRepo = (repoDigests) => {
            for (const entry of Array.isArray(repoDigests) ? repoDigests : []) {
                const [repo, digest] = String(entry).split('@');
                if (
                    digest &&
                    (repo === item.name ||
                        repo === `docker.io/${item.name}` ||
                        repo === `docker.io/library/${item.name}`)
                )
                    return digest;
            }
            return null;
        };
        if (item.kind === 'base-image') {
            const info = await this.socket
                .json(`/images/${encodeURIComponent(`${item.name}:${item.current}`)}/json`)
                .catch(() => null);
            return ofRepo(info?.RepoDigests);
        }
        const list = await this.list();
        const project = await this.ownProject(list);
        for (const c of list) {
            if (!item.services.includes(c.Labels?.['com.docker.compose.service'])) continue;
            if (project && c.Labels?.['com.docker.compose.project'] !== project) continue;
            const info = await this.socket.json(`/images/${c.ImageID}/json`).catch(() => null);
            const digest = ofRepo(info?.RepoDigests);
            if (digest) return digest;
        }
        return null;
    }

    /** Tagged images no container uses, older than keepDays. */
    async pruneImages(keepDays) {
        const filters = encodeURIComponent(
            JSON.stringify({dangling: {false: true}, until: {[`${keepDays * 24}h`]: true}}),
        );
        const r = await this.socket.json(`/images/prune?filters=${filters}`, 'POST');
        return {images: (r.ImagesDeleted ?? []).filter((d) => d?.Deleted).length, bytes: Number(r.SpaceReclaimed ?? 0)};
    }
}

/** The disk under a directory: percent full, free and total in GB; null when it cannot be read. */
export function diskOf(dir) {
    try {
        const s = fs.statfsSync(dir);
        const used = s.blocks - s.bfree;
        const total = used + s.bavail;
        return {
            percent: Math.round((used / total) * 100),
            freeGb: Math.round((s.bavail * s.bsize) / 1e9),
            totalGb: Math.round((s.blocks * s.bsize) / 1e9),
        };
    } catch {
        return null;
    }
}
