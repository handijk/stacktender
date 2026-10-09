/**
 * Verification: the affected containers must run the new image and be healthy (running without
 * restarts where there is no health check), then stay so for the soak. Pure judgement plus a
 * loop over the Docker port.
 */

/** Why a container is not fine yet, or null. One-shot init containers end with exit 0, and that is their healthy state. */
export function judge(c, prev, image) {
    if (!c) return 'container missing';
    if (image && c.image !== image) return `still on ${c.image}`;
    if (c.running) return c.health && c.health !== 'healthy' ? `health ${c.health}` : null;
    return prev && !prev.running && prev.exitCode === 0 && c.exitCode === 0 ? null : `exited with code ${c.exitCode}`;
}

/** Thrown inside an apply when the engine was stopped: the journal stays and the next instance carries on. */
export class HandOver extends Error {
    constructor() {
        super('handed over');
        this.name = 'HandOver';
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until every affected service runs `image` and is healthy, then soak. Resolves null on
 * success, a reason on failure.
 * @param {object} a
 * @param {object} a.docker port: containers(services) → Map
 * @param {string[]} a.services
 * @param {string} a.image the new image reference, or "" to judge by health alone
 * @param {Map} a.before container states before the apply
 * @param {number} a.deployTimeoutMs
 * @param {number} a.soakMs
 * @param {() => boolean} a.stopped
 */
export async function verify({docker, services, image, before, deployTimeoutMs, soakMs, stopped}) {
    if (services.length === 0) return null;
    const deadline = Date.now() + deployTimeoutMs;
    let problem = 'did not start';
    let baseline = null;
    while (Date.now() < deadline) {
        await sleep(15_000);
        if (stopped()) throw new HandOver();
        let now;
        try {
            now = await docker.containers(services);
        } catch (err) {
            problem = `docker API: ${err?.message ?? err}`;
            continue;
        }
        const looping = services.find(
            (s) => (now.get(s)?.restartCount ?? 0) >= 3 && judge(now.get(s), before.get(s), image),
        );
        if (looping)
            return `${looping} keeps restarting (${now.get(looping).restartCount} times): ${judge(now.get(looping), before.get(looping), image)}`;
        const problems = services
            .map((s) => {
                const p = judge(now.get(s), before.get(s), image);
                return p ? `${s}: ${p}` : null;
            })
            .filter(Boolean);
        if (problems.length > 0) {
            problem = problems.join('; ');
            continue;
        }
        baseline = now;
        break;
    }
    if (!baseline) return `not healthy after ${Math.round(deployTimeoutMs / 60_000)} min (${problem})`;

    const soakEnd = Date.now() + soakMs;
    while (Date.now() < soakEnd) {
        await sleep(20_000);
        if (stopped()) throw new HandOver();
        let now;
        try {
            now = await docker.containers(services);
        } catch {
            continue;
        }
        for (const s of services) {
            const p = judge(now.get(s), before.get(s), image);
            if (p) return `${s} went bad during the soak: ${p}`;
            if ((now.get(s)?.restartCount ?? 0) > (baseline.get(s)?.restartCount ?? 0))
                return `${s} restarted during the soak (crash loop?)`;
        }
    }
    return null;
}
