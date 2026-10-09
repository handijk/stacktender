/**
 * The stack's git repository, which is its working directory: files are read from the tree, a
 * change is the edits applied, committed and deployed, a revert is `git revert` and deployed.
 * The deploy is handed in (the shipped one, or the user's command); when it fails after the
 * commit landed, the change throws a DeployFailedError so the caller knows the repository is
 * ahead of what runs.
 */

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {DeployFailedError} from '../updates/engine.js';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The matcher for one edit: literal text, with a token boundary after it when asked (`x:7.2` not inside `x:7.2.5`). */
export function editPattern(e) {
    return new RegExp(escapeRegExp(e.find) + (e.wholeToken ? '(?![A-Za-z0-9._-])' : ''), 'g');
}

/** Apply edits to file contents; throws when a file does not hold its text. Returns the new contents by file. */
export function applyEdits(readFile, edits) {
    const out = {};
    for (const e of edits) {
        const text = out[e.file] ?? readFile(e.file);
        if (text === null || text === undefined) throw new Error(`${e.file}: no such file`);
        const pattern = editPattern(e);
        if (!pattern.test(text)) throw new Error(`${e.file}: expected text not found: ${e.find.slice(0, 80)}`);
        out[e.file] = text.replace(editPattern(e), () => e.replace);
    }
    return out;
}

export class GitRepo {
    /**
     * @param {object} a
     * @param {string} a.dir the stack directory
     * @param {(oldSha: string, newSha: string) => Promise<{ok: boolean, output: string}>} a.deploy
     * @param {{name?: string, email?: string}} [a.author]
     * @param {(msg: string) => void} [a.log]
     */
    constructor({dir, deploy, author = {}, log = () => {}}) {
        this.dir = dir;
        this.deploy = deploy;
        this.author = {name: author.name ?? 'stacktender', email: author.email ?? 'stacktender@localhost'};
        this.log = log;
        this.chain = Promise.resolve();
    }

    git(args, {input} = {}) {
        return new Promise((resolve, reject) => {
            const child = execFile(
                'git',
                [
                    '-c',
                    `user.name=${this.author.name}`,
                    '-c',
                    `user.email=${this.author.email}`,
                    '-c',
                    `safe.directory=${this.dir}`,
                    ...args,
                ],
                {cwd: this.dir, maxBuffer: 16 * 1024 * 1024, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}},
                (err, stdout, stderr) => {
                    if (err)
                        reject(
                            new Error(
                                `git ${args[0]}: ${String(stderr || err.message)
                                    .trim()
                                    .slice(0, 400)}`,
                            ),
                        );
                    else resolve(String(stdout));
                },
            );
            if (input !== undefined) child.stdin.end(input);
        });
    }

    /** One change at a time: edits, commits and deploys never interleave. */
    serial(fn) {
        const p = this.chain.then(fn, fn);
        this.chain = p.then(
            () => undefined,
            () => undefined,
        );
        return p;
    }

    async read(file) {
        try {
            return fs.readFileSync(path.join(this.dir, file), 'utf-8');
        } catch {
            return null;
        }
    }

    async head() {
        return (await this.git(['rev-parse', 'HEAD'])).trim();
    }

    async dirty() {
        return (await this.git(['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
    }

    async isRepo() {
        try {
            await this.git(['rev-parse', '--git-dir']);
            return true;
        } catch {
            return false;
        }
    }

    /** Make the directory a repository with everything but the data committed, when it is none. */
    async init(ignore = []) {
        if (await this.isRepo()) return false;
        await this.git(['init', '-q', '-b', 'main']);
        const ignoreFile = path.join(this.dir, '.gitignore');
        const have = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf-8') : '';
        const lines = ignore.map((d) => `${d.replace(/\/+$/, '')}/`).filter((l) => !have.split('\n').includes(l));
        if (lines.length > 0) {
            fs.writeFileSync(
                ignoreFile,
                `${have}${have && !have.endsWith('\n') ? '\n' : ''}# data directories, not configuration (stacktender)\n${lines.join('\n')}\n`,
            );
        }
        await this.git(['add', '-A']);
        await this.git(['commit', '-q', '-m', 'the stack as stacktender found it']);
        return true;
    }

    async changedFiles(oldSha, newSha) {
        const out = await this.git(['diff', '--name-only', oldSha, newSha]);
        return out.split('\n').filter(Boolean);
    }

    async show(sha, file) {
        try {
            return await this.git(['show', `${sha}:${file}`]);
        } catch {
            return null;
        }
    }

    async exists(sha) {
        try {
            await this.git(['cat-file', '-e', `${sha}^{commit}`]);
            return true;
        } catch {
            return false;
        }
    }

    async isAncestor(older, newer) {
        try {
            await this.git(['merge-base', '--is-ancestor', older, newer]);
            return true;
        } catch {
            return false;
        }
    }

    async subject(sha) {
        return (await this.git(['log', '-1', '--format=%s', sha]).catch(() => '')).trim();
    }

    /** Commit `message` with the edits applied, then deploy. Returns the commit. */
    change(edits, message) {
        return this.serial(async () => {
            if (await this.dirty())
                throw new Error('the stack directory has uncommitted changes; nothing is applied on a dirty tree');
            const before = await this.head();
            const contents = applyEdits((f) => {
                try {
                    return fs.readFileSync(path.join(this.dir, f), 'utf-8');
                } catch {
                    return null;
                }
            }, edits);
            for (const [file, text] of Object.entries(contents)) fs.writeFileSync(path.join(this.dir, file), text);
            await this.git(['add', '--', ...Object.keys(contents)]);
            await this.git(['commit', '-q', '-m', message]);
            const sha = await this.head();
            this.log(`committed ${sha.slice(0, 8)}: ${message}`);
            const result = await this.deploy(before, sha);
            if (!result.ok)
                throw new DeployFailedError(
                    `deploy failed for ${sha.slice(0, 8)}: ${result.output.split('\n').filter(Boolean).slice(-3).join(' | ')}`,
                );
            return sha;
        });
    }

    /** `git revert` of a commit, then deploy. Returns the revert commit. */
    revert(sha) {
        return this.serial(async () => {
            if (await this.dirty())
                throw new Error('the stack directory has uncommitted changes; nothing is reverted on a dirty tree');
            const before = await this.head();
            await this.git(['revert', '--no-edit', sha]);
            const head = await this.head();
            this.log(`reverted ${sha.slice(0, 8)} as ${head.slice(0, 8)}`);
            const result = await this.deploy(before, head);
            if (!result.ok)
                throw new DeployFailedError(
                    `deploy failed for the revert ${head.slice(0, 8)}: ${result.output.split('\n').filter(Boolean).slice(-3).join(' | ')}`,
                );
            return head;
        });
    }
}
