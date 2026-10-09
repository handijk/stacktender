/**
 * The bus: events to webhooks and into a log the API serves; retained state documents by source;
 * the maintenance signal per source, so one engine waits for another's planned work. Each engine
 * gets a view bound to its own source name.
 */

export const EVENT_TEXT = {
    needs_decision: (e) =>
        `${e.count} update(s) need a decision: ${(e.items ?? []).map((i) => `${i.name} ${i.current} → ${i.target} (${i.type})`).join(', ')}`,
    applied: (e) => `applied ${e.item?.name} ${e.item?.current} → ${e.item?.target}`,
    rolled_back: (e) =>
        `rolled back ${e.item?.name} ${e.item?.current} → ${e.item?.target}: ${e.problem}${e.data ? ` (data: ${e.data})` : ''}`,
    rollback_failed: (e) =>
        `ROLLBACK FAILED for ${e.item?.name} ${e.item?.current} → ${e.item?.target}: ${e.problem}; ${e.rollback_error}`,
    backup_done: (e) => `backup done: ${e.sets} set(s), ${e.added_mb} MB new, ${e.seconds} s`,
    backup_failed: (e) => `backup FAILED: ${e.error}`,
    deploy_failed: (e) => `deploy of ${String(e.sha ?? '').slice(0, 8)} FAILED: ${e.reason}`,
    host_attention: (e) => `host: ${e.message}`,
};

/** The body for one webhook, by its format. */
export function webhookBody(hook, type, payload) {
    const text = (EVENT_TEXT[type] ?? ((e) => JSON.stringify(e)))(payload);
    switch (hook.format) {
        case 'text':
            return {
                headers: {
                    'Content-Type': 'text/plain',
                    Title: `stacktender: ${type}`,
                    Tags:
                        type === 'rollback_failed' ? 'rotating_light' : type === 'rolled_back' ? 'warning' : 'package',
                },
                body: text,
            };
        case 'discord':
            return {
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({content: `**stacktender** ${text}`}),
            };
        case 'slack':
            return {
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({text: `stacktender: ${text}`}),
            };
        default:
            return {
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({source: 'stacktender', type, text, ...payload}),
            };
    }
}

/** A webhook entry from the config: a URL string (JSON) or {url, format}. */
export function normalizeHook(entry) {
    if (typeof entry === 'string') {
        const format = /ntfy/.test(entry)
            ? 'text'
            : /discord\.com\/api\/webhooks/.test(entry)
              ? 'discord'
              : /hooks\.slack\.com/.test(entry)
                ? 'slack'
                : 'json';
        return {url: entry, format};
    }
    return {url: entry.url, format: entry.format ?? 'json', headers: entry.headers ?? {}};
}

export class Bus {
    /**
     * @param {object} a
     * @param {Array<string|{url: string, format?: string}>} [a.webhooks]
     * @param {(msg: string) => void} [a.log]
     * @param {typeof fetch} [a.fetch]
     */
    constructor({webhooks = [], log = () => {}, fetch: fetchFn = globalThis.fetch} = {}) {
        this.hooks = webhooks.map(normalizeHook);
        this.log = log;
        this.fetch = fetchFn;
        this.events = [];
        this.states = new Map();
        this.signals = new Map(); // source → {active, info, since}
        this.listeners = new Set();
    }

    /** A view for one engine: its events and state carry its source; otherWork() is everybody else's. */
    forSource(source) {
        return {
            event: (type, payload) => this.event(source, type, payload),
            state: (doc) => this.state(source, doc),
            maintenance: (active, info) => this.maintenance(source, active, info),
            otherWork: () => this.otherWork(source),
        };
    }

    onEvent(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    async event(source, type, payload) {
        const event = {source, type, at: new Date().toISOString(), ...payload};
        this.events.push(event);
        this.events = this.events.slice(-200);
        for (const fn of this.listeners) {
            try {
                fn(event);
            } catch {
                // a listener's problem
            }
        }
        await Promise.all(this.hooks.map((hook) => this.send(hook, type, event)));
    }

    async send(hook, type, payload) {
        const {headers, body} = webhookBody(hook, type, payload);
        try {
            const res = await this.fetch(hook.url, {
                method: 'POST',
                headers: {...headers, ...(hook.headers ?? {})},
                body,
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) this.log(`webhook ${hook.url}: HTTP ${res.status}`);
        } catch (err) {
            this.log(`webhook ${hook.url}: ${err?.message ?? err}`);
        }
    }

    async state(source, doc) {
        this.states.set(source, doc);
    }

    async maintenance(source, active, info = {}) {
        if (active) this.signals.set(source, {active: true, since: info.since ?? new Date().toISOString(), ...info});
        else this.signals.delete(source);
    }

    /** Sources other than `source` with planned work under way (a signal older than 30 minutes without an end counts as stale). */
    otherWork(source) {
        const out = [];
        for (const [s, sig] of this.signals) {
            if (s === source) continue;
            if (Date.now() - Date.parse(sig.since) > 30 * 60_000) continue;
            out.push(s);
        }
        return out;
    }

    snapshot() {
        return {
            states: Object.fromEntries(this.states),
            maintenance: Object.fromEntries(this.signals),
            events: this.events.slice(-50),
        };
    }
}
