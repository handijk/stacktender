/**
 * The restic runner: a container stacktender keeps running next to the stack, with the stack
 * directory, the repository and the jobs directory mounted; it executes one job script at a
 * time from the jobs directory. Started here when it is missing, recreated when its image or
 * mounts changed.
 */

import {dockerRun} from '../scanner.js';
import {RUNNER_SCRIPT} from './engine.js';

export const RUNNER_NAME = 'stacktender-restic';

/**
 * @param {object} a
 * @param {string} a.stackDir host path of the stack directory
 * @param {string} a.jobsHostDir host path of the backups data directory (the runner's /out)
 * @param {string} a.repository the restic repository: a host path (mounted at /repo) or a restic URL
 * @param {string} a.image
 * @param {string} [a.user] uid:gid the runner runs as (the stack directory's owner)
 * @param {string} [a.tz]
 * @param {(msg: string) => void} [a.log]
 * @param {(args: string[]) => Promise<{code: number, output: string}>} [a.run]
 */
export async function ensureRunner({
    stackDir,
    jobsHostDir,
    repository,
    image,
    user,
    tz = 'UTC',
    log = () => {},
    run = dockerRun,
}) {
    const isUrl = /^[a-z0-9]+:/.test(repository) && !repository.startsWith('/');
    const env = ['-e', `TZ=${tz}`];
    const volumes = ['-v', `${stackDir}:/src`, '-v', `${jobsHostDir}:/out`];
    if (!isUrl) volumes.push('-v', `${repository}:/repo`);
    else env.push('-e', `RESTIC_REPOSITORY_URL=${repository}`);
    const wanted = JSON.stringify({image, volumes, env, user: user ?? null});
    const inspect = await run([
        'inspect',
        RUNNER_NAME,
        '--format',
        '{{.Config.Image}}|{{.State.Running}}|{{index .Config.Labels "stacktender.spec"}}',
    ]);
    if (inspect.code === 0) {
        const [img, running, spec] = inspect.output.trim().split('|');
        if (img === image && spec === wanted) {
            if (running !== 'true') await run(['start', RUNNER_NAME]);
            return {created: false};
        }
        log(`restic runner: recreating (${img !== image ? 'new image' : 'changed mounts'})`);
        await run(['rm', '-f', RUNNER_NAME]);
    }
    const args = [
        'run',
        '-d',
        '--name',
        RUNNER_NAME,
        '--restart',
        'unless-stopped',
        '--label',
        `stacktender.spec=${wanted}`,
        ...env,
        ...volumes,
    ];
    if (user) args.push('--user', user);
    args.push('--entrypoint', '/bin/sh', image, '-c', RUNNER_SCRIPT);
    const r = await run(args);
    if (r.code !== 0) throw new Error(`cannot start the restic runner: ${r.output.trim().slice(-300)}`);
    log(`restic runner started (${image})`);
    return {created: true};
}
