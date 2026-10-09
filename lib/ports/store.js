/** Durable state as one JSON file per key under the data directory. */

import fs from 'node:fs';
import path from 'node:path';

export class FileStore {
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, {recursive: true});
    }

    file(key) {
        return path.join(this.dir, `${String(key).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
    }

    async get(key) {
        try {
            return JSON.parse(fs.readFileSync(this.file(key), 'utf-8'));
        } catch {
            return null;
        }
    }

    async set(key, value) {
        const file = this.file(key);
        if (value === null || value === undefined) {
            try {
                fs.unlinkSync(file);
            } catch {
                // not there
            }
            return;
        }
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
        fs.renameSync(`${file}.tmp`, file);
    }
}
