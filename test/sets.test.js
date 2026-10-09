import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {byService, deriveSets, relOf, volumesOf} from '../lib/backups/sets.js';

const compose = `services:
  stacktender:
    container_name: stacktender
    image: ghcr.io/handijk/stacktender:0.1.0
    volumes: ["./stacktender-data:/data", "/var/run/docker.sock:/var/run/docker.sock", ".:/stack"]
  postgres:
    container_name: postgres
    image: postgres:17
    volumes: ["./postgres-data:/var/lib/postgresql/data"]
  chat:
    container_name: chat
    build: ./chat
    depends_on: [postgres]
    volumes: ["./chat-data:/data"]
  synapse:
    container_name: synapse
    image: matrixdotorg/synapse:v1
    volumes: ["./matrix-data:/data"]
  synapse-init:
    container_name: synapse-init
    image: matrixdotorg/synapse:v1
    volumes: ["./matrix-data:/data"]
  bridge:
    container_name: bridge
    image: mautrix/signal:v1
    depends_on: [synapse]
    volumes: ["./matrix-data/bridges/signal:/data"]
  element:
    container_name: element
    image: vectorim/element-web:v1
    depends_on: [synapse]
  caddy:
    container_name: caddy
    image: caddy:2
    volumes: ["./caddy-data:/data", "./caddy/Caddyfile:/etc/caddy/Caddyfile:ro"]
  grafana:
    container_name: grafana
    image: grafana/grafana-oss:13
    volumes:
      - type: bind
        source: ./grafana-data
        target: /var/lib/grafana
      - type: bind
        source: ./grafana/provisioning
        target: /etc/grafana/provisioning
        read_only: true
  mosquitto:
    container_name: mosquitto
    image: eclipse-mosquitto:2
    volumes: ["./mosquitto/config:/mosquitto/config", "./mosquitto/data:/mosquitto/data", "./mosquitto/log:/mosquitto/log"]
  ollama:
    container_name: ollama
    image: ollama/ollama:0.5
    volumes: ["./ollama-data:/root/.ollama", "./logs:/logs"]
`;

const committedPaths = new Set([
    'caddy',
    'caddy/Caddyfile',
    'grafana',
    'grafana/provisioning',
    'mosquitto',
    'mosquitto/config',
    'chat',
    'chat/Dockerfile',
]);
// git tracks exactly these paths (the house checks existence in the committed tree): mosquitto/data is not among them
const committed = (rel) => committedPaths.has(rel);

describe('backup sets from the compose file', () => {
    const sets = deriveSets(compose, {committed, exclude: ['ollama-data'], data: ['.env'], noStop: ['mosquitto']});
    const by = (name) => sets.find((s) => s.name === name);

    test('services sharing data, or depending on a service that keeps some, form one set', () => {
        const cp = by('chat+postgres');
        assert.ok(cp, `sets: ${sets.map((s) => s.name)}`);
        assert.deepEqual(cp.paths, ['chat-data', 'postgres-data']);
        assert.deepEqual(cp.stop, ['chat', 'postgres']);
        const matrix = sets.find((s) => s.paths.includes('matrix-data'));
        assert.deepEqual(matrix.services, ['bridge', 'element', 'synapse', 'synapse-init']);
        assert.deepEqual(matrix.paths, ['matrix-data'], 'a mount inside matrix-data is not a path of its own');
        assert.equal(matrix.name, 'synapse', 'init containers do not name the set');
        assert.ok(matrix.stop.includes('element'), 'a dependent that keeps no data stops with the set');
    });

    test('what is never stopped, never copied, or copied live', () => {
        assert.ok(
            sets.every((s) => !s.stop.includes('stacktender')),
            'stacktender is never stopped',
        );
        assert.ok(
            sets.every((s) => !s.paths.some((p) => p.startsWith('stacktender-data'))),
            'its own directory is never copied',
        );
        assert.ok(
            sets.every((s) => !s.paths.some((p) => p.startsWith('ollama') || p === 'logs')),
            'excluded and logs directories are never copied',
        );
        const mq = by('mosquitto');
        assert.deepEqual(mq.paths, ['mosquitto/data']);
        assert.deepEqual(mq.live, ['mosquitto']);
        assert.deepEqual(mq.stop, []);
        assert.deepEqual(by('repo').paths, ['.env']);
        assert.deepEqual(by('caddy').paths, ['caddy-data'], 'a read-only or committed mount is configuration');
        assert.deepEqual(by('grafana').paths, ['grafana-data'], 'the long syntax too');
    });

    test('the service map names the data keepers only', () => {
        const map = byService(sets);
        assert.equal(map.caddy, 'caddy');
        assert.equal(map.postgres, 'chat+postgres');
        assert.equal(map.chat, 'chat+postgres');
        assert.equal(map.element, undefined);
        assert.equal(map.stacktender, undefined);
    });

    test('volume and path parsing', () => {
        assert.deepEqual(
            volumesOf({
                volumes: [
                    './a:/a',
                    './b:/b:ro',
                    {type: 'volume', source: 'named', target: '/n'},
                    {source: './c', target: '/c', read_only: true},
                ],
            }),
            [
                {source: './a', readOnly: false},
                {source: './b', readOnly: true},
                {source: './c', readOnly: true},
            ],
        );
        assert.equal(relOf('./x-data/'), 'x-data');
        assert.equal(relOf('/var/run/docker.sock'), null);
        assert.equal(relOf('./../outside'), null);
        assert.equal(relOf('.'), null);
    });
});
