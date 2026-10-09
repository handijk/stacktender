/**
 * Backup sets from the compose file, not from a list: a read-write bind mount under the repository
 * that git does not track is data; services sharing a directory, or depending on a service that
 * keeps one, form one set and are stopped together. Pure.
 */

import {parse as parseYaml} from 'yaml';

export const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function volumesOf(service) {
    const out = [];
    for (const v of service.volumes ?? []) {
        if (typeof v === 'string') {
            const parts = v.split(':');
            if (parts.length < 2) continue;
            out.push({source: parts[0], readOnly: (parts[2] ?? '').split(',').includes('ro')});
        } else if (v && typeof v === 'object') {
            if (v.type && v.type !== 'bind') continue;
            if (typeof v.source === 'string') out.push({source: v.source, readOnly: v.read_only === true});
        }
    }
    return out;
}

/** A repo-relative path for a bind source under the repo directory, or null for anything else (the repo itself included). */
export function relOf(source) {
    if (!source.startsWith('./')) return null;
    const rel = source.slice(2).replace(/\/+$/, '');
    return rel && SAFE_PATH.test(rel) && !rel.split('/').includes('..') ? rel : null;
}

function dependsOn(service) {
    const d = service.depends_on;
    if (Array.isArray(d)) return d.map(String);
    if (d && typeof d === 'object') return Object.keys(d);
    return [];
}

/**
 * @param {string} composeText
 * @param {object} o
 * @param {(rel: string) => boolean} o.committed whether git tracks the path (configuration, not data)
 * @param {string[]} [o.exclude] repo-relative directories never copied
 * @param {string[]} [o.data] paths that are data although tracked, or that nothing mounts
 * @param {string[]} [o.noStop] services never stopped; their directories are copied live
 * @param {string} [o.selfService] the service running stacktender: never stopped
 * @param {string[]} [o.builtinExclude]
 * @returns {Array<{name, paths, owners, services, stop, live}>}
 */
export function deriveSets(
    composeText,
    {
        committed,
        exclude = [],
        data = [],
        noStop = [],
        selfService = 'stacktender',
        builtinExclude = ['stacktender-data'],
    },
) {
    const doc = parseYaml(composeText);
    const services = doc?.services ?? {};
    const excluded = (rel) =>
        [...builtinExclude, ...exclude].some((e) => rel === e || rel.startsWith(`${e}/`)) || /(^|\/)logs?$/.test(rel);
    const isData = (rel) => !excluded(rel) && (data.includes(rel) || !committed(rel));
    const stoppable = (service) => service !== selfService && !noStop.includes(service);

    const parent = new Map();
    const find = (s) => {
        let p = s;
        while (parent.has(p) && parent.get(p) !== p) p = parent.get(p);
        return p;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    };
    const pathsOf = new Map();
    const mountedBy = new Map();
    const mounts = [];
    for (const [name, svc] of Object.entries(services)) {
        for (const v of volumesOf(svc)) {
            if (v.readOnly) continue;
            const rel = relOf(v.source);
            if (rel && isData(rel)) mounts.push([name, rel]);
        }
    }
    // A mount inside another data directory is part of that directory: its service joins the owner's set.
    const roots = [...new Set(mounts.map(([, rel]) => rel))].filter(
        (rel) => !mounts.some(([, other]) => other !== rel && rel.startsWith(`${other}/`)),
    );
    for (const [name, rel] of mounts.sort(([, a], [, b]) => a.length - b.length)) {
        const root = roots.includes(rel) ? rel : (roots.find((r) => rel.startsWith(`${r}/`)) ?? rel);
        if (root === rel) {
            if (!pathsOf.has(name)) pathsOf.set(name, new Set());
            pathsOf.get(name).add(rel);
        }
        const first = mountedBy.get(root);
        if (first) union(name, first);
        else mountedBy.set(root, name);
    }
    const members = (root) => Object.keys(services).filter((s) => find(s) === root);
    const inSet = (s) => members(find(s)).some((m) => pathsOf.has(m));
    const setStops = (s) => members(find(s)).some((m) => stoppable(m));
    for (let changed = true, rounds = 0; changed && rounds < 10; rounds++) {
        changed = false;
        for (const [name, svc] of Object.entries(services)) {
            if (!stoppable(name)) continue;
            for (const dep of dependsOn(svc)) {
                if (!services[dep] || !inSet(dep) || !setStops(dep) || find(dep) === find(name)) continue;
                union(name, dep);
                changed = true;
            }
        }
    }
    const out = [];
    const seen = new Set();
    for (const name of Object.keys(services)) {
        const root = find(name);
        if (seen.has(root) || !inSet(name)) continue;
        seen.add(root);
        const all = members(root).sort();
        const owners = all.filter((s) => pathsOf.has(s));
        const paths = [...new Set(owners.flatMap((s) => [...pathsOf.get(s)]))].sort();
        const named = owners.filter((s) => !s.endsWith('-init'));
        out.push({
            name: (named.length ? named : owners).join('+'),
            paths,
            owners,
            services: all,
            stop: all.filter(stoppable).map((s) => String(services[s].container_name ?? s)),
            live: owners.filter((s) => !stoppable(s)),
        });
    }
    const loose = data.filter((rel) => SAFE_PATH.test(rel) && !excluded(rel) && !mountedBy.has(rel));
    if (loose.length > 0) out.push({name: 'repo', paths: loose, owners: [], services: [], stop: [], live: []});
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The service → set map of what keeps data: the deploy copies before *their* image changes, not before a dependent's. */
export function byService(sets, selfService = 'stacktender') {
    return Object.fromEntries(
        sets.flatMap((s) => s.owners.filter((svc) => svc !== selfService).map((svc) => [svc, s.name])),
    );
}
