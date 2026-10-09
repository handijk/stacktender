/**
 * MQTT for the bus, when configured: the maintenance signal of every source as a retained
 * document (so a watchdog can hold its alerts while planned work runs), the events as messages,
 * and the state documents retained. One connection, reconnecting by itself.
 */

import mqtt from 'mqtt';

export class MqttPublisher {
    /**
     * @param {object} a
     * @param {string} a.url mqtt://broker[:port]
     * @param {string} [a.username]
     * @param {string} [a.password]
     * @param {string} [a.maintenanceTopic] prefix; the signal of a source goes to `<prefix>/<name>-<source>`
     * @param {string} [a.eventsTopic]
     * @param {string} [a.stateTopic] prefix; a source's state goes to `<prefix>/<source>`
     * @param {string} [a.name] this instance's name in the topics
     * @param {(msg: string) => void} [a.log]
     * @param {typeof mqtt.connect} [a.connect] for tests
     */
    constructor({
        url,
        username,
        password,
        maintenanceTopic = 'stacktender/maintenance',
        eventsTopic = 'stacktender/events',
        stateTopic = 'stacktender/state',
        name = 'stacktender',
        log = () => {},
        connect = mqtt.connect,
    }) {
        this.maintenanceTopic = maintenanceTopic;
        this.eventsTopic = eventsTopic;
        this.stateTopic = stateTopic;
        this.name = name;
        this.log = log;
        this.client = connect(url, {
            username,
            password,
            clientId: `${name}_${Math.random().toString(16).slice(2, 10)}`,
            reconnectPeriod: 5000,
        });
        this.client.on('connect', () => this.log(`mqtt connected ${url}`));
        this.client.on('error', (err) => this.log(`mqtt: ${err?.message ?? err}`));
    }

    publish(topic, payload, {retain = false} = {}) {
        return new Promise((resolve) => {
            this.client.publish(
                topic,
                typeof payload === 'string' ? payload : JSON.stringify(payload),
                {retain, qos: 0},
                () => resolve(),
            );
        });
    }

    maintenance(source, active, info) {
        return this.publish(
            `${this.maintenanceTopic}/${this.name}-${source}`,
            {active, source: `${this.name}-${source}`, ...info, at: info?.at ?? new Date().toISOString()},
            {retain: true},
        );
    }

    event(event) {
        return this.publish(this.eventsTopic, event);
    }

    state(source, doc) {
        return this.publish(`${this.stateTopic}/${source}`, doc, {retain: true});
    }

    close() {
        return new Promise((resolve) => this.client.end(false, {}, () => resolve()));
    }
}
