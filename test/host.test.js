// The host report from the files any Ubuntu has: pending security updates, a stale nightly run, a
// waiting reboot, a full disk; the ones that only matter after some days wait.
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {mergeConfig} from '../lib/config.js';
import {hostItems, readHost} from '../lib/updates/host.js';
import {tempDir} from './helpers.js';

describe('host report', () => {
    const dir = tempDir('host');
    fs.mkdirSync(path.join(dir, 'update-notifier'), {recursive: true});
    fs.mkdirSync(path.join(dir, 'apt-periodic'), {recursive: true});
    fs.mkdirSync(path.join(dir, 'modules', '6.8.0-111-generic'), {recursive: true});
    fs.mkdirSync(path.join(dir, 'modules', '6.8.0-120-generic'));
    fs.writeFileSync(
        path.join(dir, 'update-notifier', 'updates-available'),
        '\n12 updates can be applied immediately.\n3 of these updates are standard security updates.\n',
    );
    fs.writeFileSync(path.join(dir, 'apt-periodic', 'upgrade-stamp'), '');
    const old = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(path.join(dir, 'apt-periodic', 'upgrade-stamp'), old, old);
    fs.writeFileSync(path.join(dir, 'running'), '6.8.0-111-generic\n');
    const cfg = mergeConfig({host: {report: true}});

    test('what the files say', () => {
        const host = readHost(dir);
        assert.match(host.summary, /12 updates/);
        assert.deepEqual(host.kernels.sort(), ['6.8.0-111-generic', '6.8.0-120-generic']);
        assert.equal(host.running, '6.8.0-111-generic');
        assert.ok(Date.now() - host.upgradeAt > 9 * 86_400_000);
    });

    test('findings, with their waiting periods', () => {
        const persisted = {};
        const items = hostItems(readHost(dir), cfg, persisted, {percent: 85, freeGb: 20, totalGb: 200});
        const names = items.map((i) => i.name);
        assert.deepEqual(names, ['host: disk', 'host: unattended upgrades', 'host: security updates', 'host: reboot']);
        assert.equal(items[0].policy, 'ask', 'the disk asks at once');
        assert.equal(items[1].policy, 'ask', 'a stale nightly run asks at once');
        assert.equal(items[2].policy, 'hold', 'security updates wait for the nightly run first');
        assert.equal(items[3].policy, 'hold', 'a reboot waits a week');
        assert.match(items[3].target, /6\.8\.0-120-generic/);
        // Eight days later the reboot asks.
        const later = hostItems(readHost(dir), cfg, persisted, null, Date.now() + 8 * 86_400_000);
        assert.equal(later.find((i) => i.name === 'host: reboot').policy, 'ask');
        assert.equal(later.find((i) => i.name === 'host: security updates').policy, 'ask');
        assert.equal(
            later.find((i) => i.name === 'host: disk'),
            undefined,
        );
    });

    test('no summary at all is a finding after some days', () => {
        const items = hostItems({summary: null, kernels: [], running: ''}, cfg, {}, null);
        assert.equal(items.length, 1);
        assert.equal(items[0].policy, 'hold');
        assert.match(items[0].reason, /cannot be read/);
    });
});
