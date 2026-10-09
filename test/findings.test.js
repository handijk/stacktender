import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {mergeConfig} from '../lib/config.js';
import {applyPersisted, buildItems, decidePolicy, editsFor} from '../lib/updates/findings.js';
import {inWindow, parseRef, shortVersion, versionOf} from '../lib/updates/refs.js';
import {CADDY_NEW, CADDY_OLD, UPDATES_CONFIG} from './helpers.js';

const report = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'report-caddy.json'), 'utf-8'));
const services = {caddy: {image: CADDY_OLD, owner: 'root'}, stacktender: {image: null, owner: 'root'}};

describe('image references', () => {
    test('name, tag, digest and registry ports', () => {
        assert.deepEqual(parseRef('redis:7.4.8-alpine'), {name: 'redis', tag: '7.4.8-alpine', digest: null});
        assert.deepEqual(parseRef('ghcr.io/handijk/tado2mqtt:0.1.0@sha256:abc'), {
            name: 'ghcr.io/handijk/tado2mqtt',
            tag: '0.1.0',
            digest: 'sha256:abc',
        });
        assert.deepEqual(parseRef('registry.local:5000/app'), {name: 'registry.local:5000/app', tag: '', digest: null});
        assert.equal(versionOf('1.0', null), '1.0');
        assert.equal(versionOf('1.0', 'sha256:ab'), '1.0@sha256:ab');
        assert.equal(shortVersion(CADDY_OLD.split(':').slice(1).join(':')), '2.11.6-alpine@sha256:d44355d3c214…');
        assert.equal(shortVersion(null), null);
    });

    test('windows, also past midnight', () => {
        const at = (h, m) => new Date(Date.UTC(2026, 9, 9, h, m));
        assert.equal(inWindow({from: '10:00', to: '17:00'}, 'UTC', at(12, 0)), true);
        assert.equal(inWindow({from: '10:00', to: '17:00'}, 'UTC', at(17, 0)), false);
        assert.equal(inWindow({from: '22:00', to: '05:00'}, 'UTC', at(23, 30)), true);
        assert.equal(inWindow({from: '22:00', to: '05:00'}, 'UTC', at(4, 59)), true);
        assert.equal(inWindow({from: '22:00', to: '05:00'}, 'UTC', at(12, 0)), false);
        assert.equal(
            inWindow({from: '02:00', to: '05:00'}, 'Europe/Amsterdam', at(1, 30)),
            true,
            '03:30 Amsterdam summer time',
        );
    });
});

describe('the findings from a report', () => {
    test('a patch with a digest is one silent finding with the edit', () => {
        const cfg = mergeConfig(UPDATES_CONFIG);
        const {items} = buildItems(report, services, cfg);
        assert.equal(items.length, 1);
        const [caddy] = items;
        assert.equal(caddy.kind, 'image');
        assert.equal(caddy.name, 'caddy');
        assert.equal(caddy.updateType, 'patch');
        assert.equal(caddy.policy, 'silent');
        assert.equal(caddy.state, 'pending');
        assert.deepEqual(caddy.services, ['caddy']);
        assert.equal(caddy.current, CADDY_OLD.slice('caddy:'.length));
        assert.equal(caddy.target, CADDY_NEW.slice('caddy:'.length));
        assert.deepEqual(caddy.edits, [
            {file: 'docker-compose.yaml', find: CADDY_OLD, replace: CADDY_NEW, wholeToken: true},
        ]);
        assert.equal(caddy.ageDays, 2);
    });

    test('a young release waits; digests off keeps the digest out of the target', () => {
        const waiting = buildItems(report, services, mergeConfig({...UPDATES_CONFIG, minimumReleaseAgeDays: 3}))
            .items[0];
        assert.equal(waiting.state, 'waiting');
        assert.equal(waiting.policy, 'silent');
        const noDigest = buildItems(report, services, mergeConfig({...UPDATES_CONFIG, digests: false})).items[0];
        assert.equal(
            noDigest.target,
            CADDY_NEW.slice('caddy:'.length),
            'the pin has a digest already, so the new one keeps it',
        );
    });

    test('a rule wins, and holds or asks with its reason', () => {
        const cfg = mergeConfig({
            ...UPDATES_CONFIG,
            rules: [{match: '^caddy$', updateTypes: ['patch'], policy: 'hold', why: 'caddy is pinned on purpose'}],
        });
        const [caddy] = buildItems(report, services, cfg).items;
        assert.equal(caddy.policy, 'hold');
        assert.equal(caddy.reason, 'caddy is pinned on purpose');
        assert.equal(caddy.byRule, true);
    });

    test('policies for the shapes the registry reports', () => {
        const cfg = mergeConfig(UPDATES_CONFIG);
        const d = (base) =>
            decidePolicy(cfg, {
                kind: 'image',
                manager: 'docker-compose',
                name: 'x',
                ageDays: 10,
                behindDays: 10,
                ...base,
            });
        assert.equal(d({updateType: 'major'}).policy, 'ask');
        assert.equal(d({updateType: 'minor', newMajor: 0}).policy, 'ask');
        assert.equal(d({updateType: 'minor', newMajor: 2}).policy, 'silent');
        assert.equal(d({updateType: 'minor', newMajor: 2, behindDays: 200}).policy, 'ask');
        assert.equal(d({updateType: 'minor', newMajor: 2, behindDays: null}).policy, 'ask');
        assert.equal(d({updateType: 'digest'}).policy, 'silent');
        assert.equal(d({updateType: 'pinDigest'}).policy, 'silent');
        assert.equal(
            decidePolicy(mergeConfig({...UPDATES_CONFIG, digests: false}), {
                kind: 'image',
                manager: 'x',
                name: 'x',
                updateType: 'digest',
                ageDays: null,
                behindDays: null,
            }).policy,
            'hold',
        );
        assert.equal(d({kind: 'unpinned', updateType: 'unversioned'}).policy, 'ask');
        assert.equal(d({updateType: 'patch', ageDays: null}).reason.includes('no release date'), true);
        const withAssessor = mergeConfig({...UPDATES_CONFIG, hooks: {assessor: 'http://x', assessorAskAnyway: []}});
        assert.equal(
            decidePolicy(withAssessor, {
                kind: 'image',
                manager: 'x',
                name: 'x',
                updateType: 'minor',
                newMajor: 2,
                ageDays: 10,
                behindDays: 10,
            }).policy,
            'ask',
        );
    });

    test('edits are all or nothing', () => {
        const item = {
            name: 'caddy',
            places: [
                {file: 'a.yaml', text: 'image: caddy:1'},
                {file: 'b.yaml', text: 'image: caddy:2'},
            ],
        };
        assert.deepEqual(editsFor(item, '1', '3'), []);
        const one = {name: 'caddy', places: [{file: 'a.yaml', text: 'image: caddy:1'}]};
        assert.deepEqual(editsFor(one, '1', '3'), [
            {file: 'a.yaml', find: 'image: caddy:1', replace: 'image: caddy:3', wholeToken: true},
        ]);
    });

    test('what was decided before: dismissed, failed, queued, forgotten', () => {
        const cfg = mergeConfig(UPDATES_CONFIG);
        const fresh = () => buildItems(report, services, cfg).items;
        const [a] = applyPersisted(
            fresh(),
            {[fresh()[0].id]: {dismissedUntil: new Date(Date.now() + 86_400_000).toISOString(), note: 'not now'}},
            cfg,
        );
        assert.equal(a.state, 'dismissed');
        const [b] = applyPersisted(fresh(), {[fresh()[0].id]: {state: 'failed', note: 'did not come up'}}, cfg);
        assert.equal(b.state, 'failed');
        assert.equal(b.policy, 'ask');
        assert.match(b.reason, /was tried and rolled back/);
        const held = buildItems(
            report,
            services,
            mergeConfig({...UPDATES_CONFIG, rules: [{match: 'caddy', policy: 'ask', why: 'rule'}]}),
        ).items;
        const [c] = applyPersisted(held, {[held[0].id]: {queued: true}}, cfg);
        assert.equal(c.policy, 'silent');
        assert.match(c.reason, /asked for it to be tried/);
        const [e] = applyPersisted(
            fresh(),
            {[fresh()[0].id]: {dismissedUntil: new Date(Date.now() - 1000).toISOString()}},
            cfg,
        );
        assert.equal(e.state, 'pending', 'an expired dismissal is over');
    });
});
