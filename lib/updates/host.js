/**
 * The host, reported and never changed: whether security patches still arrive, whether a reboot
 * has been waiting, how full the disk is. Read from directories any Ubuntu or Debian has, mounted
 * read-only into the container: apt's own summary of pending updates and the stamps of its runs,
 * the installed kernels. Pure given the file contents.
 */

import fs from 'node:fs';
import path from 'node:path';
import {idOf} from './refs.js';
import {ruleFor} from './findings.js';

const days = (ms) => Math.floor(ms / 86_400_000);
const kernelOf = (name) => ({
    name,
    nums: (name.match(/\d+/g) ?? []).map(Number),
    flavour: name.replace(/^[\d.-]+/, ''),
});
const newerKernel = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return false;
};

/**
 * Read what the host says about itself.
 * @param {string} hostDir with update-notifier/updates-available, apt-periodic/*, modules/, and the running kernel in `running`
 */
export function readHost(hostDir) {
    const read = (rel) => {
        try {
            return fs.readFileSync(path.join(hostDir, rel), 'utf-8');
        } catch {
            return null;
        }
    };
    const stamp = (rel) => {
        try {
            return fs.statSync(path.join(hostDir, rel)).mtimeMs;
        } catch {
            return null;
        }
    };
    let kernels = [];
    try {
        kernels = fs.readdirSync(path.join(hostDir, 'modules'));
    } catch {
        // no modules directory mounted
    }
    return {
        summary: read('update-notifier/updates-available'),
        summaryAt: stamp('update-notifier/updates-available'),
        upgradeAt: stamp('apt-periodic/upgrade-stamp'),
        updateAt: stamp('apt-periodic/update-success-stamp'),
        kernels,
        running: (read('running') ?? '').trim(),
    };
}

/**
 * Findings about the host. `persisted` keeps when each was first seen, so a finding that only
 * matters after some days waits.
 */
export function hostItems(host, cfg, persisted, disk, now = Date.now()) {
    const out = [];
    const add = (key, current, target, what, after = 0) => {
        const id = `host${idOf('host', key)}`;
        persisted[id] = {...persisted[id], firstSeen: persisted[id]?.firstSeen ?? new Date(now).toISOString()};
        const waited = days(now - Date.parse(persisted[id].firstSeen));
        const rule = ruleFor(cfg, {name: key, manager: 'host', updateType: 'host'});
        const [policy, reason] = rule
            ? [rule.policy, rule.why]
            : waited < after
              ? ['hold', `${what} Seen for ${waited} day(s); a person is asked after ${after}.`]
              : ['ask', after > 0 ? `${what} That has been so for ${waited} day(s).` : what];
        out.push({
            id,
            kind: 'host',
            name: `host: ${key}`,
            files: [],
            current,
            target,
            updateType: 'host',
            released: null,
            ageDays: null,
            behindDays: null,
            sourceUrl: null,
            services: [],
            owners: [],
            policy,
            reason: `${reason} Nothing here can change the host: this is for a person with sudo.`,
            edits: [],
            state: 'pending',
        });
    };
    if (disk && disk.percent >= cfg.host.diskAskPercent) {
        add(
            'disk',
            `${disk.percent}% full`,
            `below ${cfg.host.diskAskPercent}%`,
            `The root disk is ${disk.percent}% full (${disk.freeGb} GB free of ${disk.totalGb}).`,
        );
    }
    if (!host) return out;
    if (host.summary === null) {
        add(
            'update summary',
            'missing',
            null,
            "The machine's summary of pending updates (/var/lib/update-notifier/updates-available) cannot be read, so nothing can be said about security patches.",
            cfg.host.staleDays,
        );
        return out;
    }
    const security = [
        ...host.summary.matchAll(/(\d+) of these updates (?:is an?|are) [\w ]*security updates?/g),
    ].reduce((n, m) => n + Number(m[1]), 0);
    const pending = Number(/(\d+) updates? can be applied/.exec(host.summary)?.[1] ?? 0);
    const upgradeAge = host.upgradeAt ? days(now - host.upgradeAt) : null;
    if (upgradeAge !== null && upgradeAge > cfg.host.staleDays) {
        add(
            'unattended upgrades',
            `last ran ${upgradeAge} day(s) ago`,
            'nightly',
            `The nightly unattended upgrade has not run for ${upgradeAge} days (apt-periodic/upgrade-stamp).`,
            0,
        );
    }
    if (security > 0) {
        add(
            'security updates',
            `${security} pending`,
            '0 pending',
            `${security} security update(s) are waiting (${pending} updates in all); the nightly run normally installs them.`,
            cfg.host.pendingDays,
        );
    }
    if (host.running && host.kernels.length > 0) {
        const running = kernelOf(host.running);
        const newest = host.kernels
            .map(kernelOf)
            .filter((k) => k.flavour === running.flavour)
            .sort((a, b) => (newerKernel(a.nums, b.nums) ? -1 : 1))[0];
        if (newest && newerKernel(newest.nums, running.nums)) {
            add(
                'reboot',
                `kernel ${host.running}`,
                `kernel ${newest.name}`,
                `A newer kernel is installed; the machine runs ${host.running} until it reboots.`,
                cfg.host.rebootDays,
            );
        }
    }
    return out;
}
