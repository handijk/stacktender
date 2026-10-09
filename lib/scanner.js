/**
 * The scanner: Renovate in lookup mode, one container per scan, against the stack directory
 * mounted read-only. It reads the compose files, the Dockerfiles and the lockfiles, asks the
 * registries, writes a report, and changes nothing. One scan at a time; a request while one runs
 * queues one more.
 */

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const RENOVATE_IMAGE = 'renovate/renovate:44';

export class RenovateScanner {
    /**
     * @param {object} a
     * @param {string} a.stackDir the stack directory as the host sees it (bind-mounted into the scanner)
     * @param {string} a.dataDir the host path of the data directory; the report lands in it
     * @param {string} [a.image]
     * @param {string} [a.tz]
     * @param {(msg: string) => void} [a.log]
     * @param {(args: string[]) => Promise<{code: number, output: string}>} [a.run] `docker <args>`, for tests
     */
    constructor({stackDir, dataDir, image = RENOVATE_IMAGE, tz = 'UTC', log = () => {}, run}) {
        this.stackDir = stackDir;
        this.dataDir = dataDir;
        this.image = image;
        this.tz = tz;
        this.log = log;
        this.run = run ?? ((args) => dockerRun(args));
        this.running = null;
        this.again = false;
        this.lastResult = null;
    }

    get reportFile() {
        return path.join(this.dataDir, 'report.json');
    }

    /** Ask for a scan; returns at once. */
    request() {
        if (this.running) {
            this.again = true;
            return;
        }
        this.running = this.scan()
            .catch((err) => this.log(`scan failed: ${err?.message ?? err}`))
            .finally(() => {
                this.running = null;
                if (this.again) {
                    this.again = false;
                    this.request();
                }
            });
    }

    async scan() {
        fs.mkdirSync(this.dataDir, {recursive: true});
        const tmp = path.join(this.dataDir, 'report.tmp.json');
        const started = Date.now();
        this.log('scan: renovate lookup starting');
        const {code, output} = await this.run([
            'run',
            '--rm',
            '--name',
            `stacktender-scan-${started.toString(36)}`,
            '-v',
            `${this.stackDir}:/usr/src/app:ro`,
            '-v',
            `${this.dataDir}:/out`,
            '-w',
            '/usr/src/app',
            // Renovate's image runs as a user of its own; the report must be ours
            ...(typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
            '-e',
            'HOME=/tmp',
            '-e',
            'RENOVATE_BASE_DIR=/tmp/renovate',
            '-e',
            'LOG_LEVEL=warn',
            '-e',
            'RENOVATE_PLATFORM=local',
            '-e',
            'RENOVATE_ONBOARDING=false',
            '-e',
            'RENOVATE_REQUIRE_CONFIG=optional',
            '-e',
            'RENOVATE_REPORT_TYPE=file',
            '-e',
            'RENOVATE_REPORT_PATH=/out/report.tmp.json',
            '-e',
            `TZ=${this.tz}`,
            this.image,
            'renovate',
        ]);
        fs.writeFileSync(path.join(this.dataDir, 'scan.log'), output);
        if (code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
            this.lastResult = {
                ok: false,
                at: new Date().toISOString(),
                error: `renovate exit ${code}: ${output.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`,
            };
            throw new Error(this.lastResult.error);
        }
        fs.renameSync(tmp, this.reportFile);
        this.lastResult = {ok: true, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000)};
        this.log(`scan: report written in ${this.lastResult.seconds} s`);
    }

    /** The report with its time, or null before the first scan. */
    report() {
        if (!fs.existsSync(this.reportFile)) return null;
        try {
            return {
                mtime: fs.statSync(this.reportFile).mtimeMs,
                report: JSON.parse(fs.readFileSync(this.reportFile, 'utf-8')),
            };
        } catch {
            return null;
        }
    }
}

/** `docker <args>` with its combined output. */
export function dockerRun(args, {cwd} = {}) {
    return new Promise((resolve) => {
        execFile('docker', args, {cwd, maxBuffer: 64 * 1024 * 1024, env: process.env}, (err, stdout, stderr) => {
            resolve({code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}`});
        });
    });
}
