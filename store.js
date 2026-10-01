// Independent browser database. No settings, chat metadata, or network writes.
export const LIMITS = Object.freeze({ versions: 120, bytes: 1024 * 1024, text: 256 * 1024, chats: 32 });
const stamp = () => performance.timeOrigin + performance.now();
export { stamp };
// Phones commonly open ST over plain LAN HTTP, where randomUUID is unavailable.
function snapshotId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
}

export class DraftStore {
    constructor(name = 'tavern-draft-guard-v1') { this.name = name; }

    async open() {
        if (this.db) return;
        if (!this.opening) this.opening = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.name, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore('chats', { keyPath: 'key' });
                const snapshots = req.result.createObjectStore('snapshots', { keyPath: ['key', 'id'] });
                snapshots.createIndex('chat', 'key');
            };
            req.onsuccess = () => {
                this.db = req.result;
                this.db.onversionchange = () => { this.db.close(); this.db = null; this.opening = null; };
                resolve();
            };
            req.onerror = () => { this.opening = null; reject(req.error); };
            req.onblocked = () => { this.opening = null; reject(new Error('数据库升级被其他酒馆页面占用，请关闭其他页面后重试。')); };
        });
        await this.opening;
    }

    async transact(mode, run) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['chats', 'snapshots'], mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error('草稿数据库事务中断。'));
            tx.onerror = () => {}; // onabort reports the transaction failure exactly once.
            try { run(tx.objectStore('chats'), tx.objectStore('snapshots'), value => { result = value; }); }
            catch (error) { tx.abort(); reject(error); }
        });
    }

    async save(key, text, at = stamp()) {
        if (text.length > LIMITS.text) throw new Error('单份草稿超过 262144 个 UTF-16 字符，未保存；请先导出或缩短正文。');
        return this.transact('readwrite', (chats, snapshots, done) => {
            const request = chats.get(key);
            request.onsuccess = () => {
                const fresh = !request.result;
                const meta = request.result || { key, current: [], previous: [], updated: at };
                const write = () => {
                    const id = snapshotId();
                    const row = { key, id, text, at };
                    snapshots.put(row);
                    meta.current.push({ id, at, bytes: text.length * 2 });
                    this.trim(meta.current, snapshots, key);
                    meta.updated = at;
                    chats.put(meta);
                    if (fresh) this.evict(chats, snapshots, key);
                    done(row);
                };
                const last = meta.current.at(-1);
                if (!last) { if (text) write(); else done(null); return; }
                const prior = snapshots.get([key, last.id]);
                prior.onsuccess = () => prior.result?.text === text ? done(prior.result) : write();
            };
        });
    }

    trim(list, snapshots, key) {
        let bytes = list.reduce((sum, item) => sum + item.bytes, 0);
        while (list.length > LIMITS.versions || (bytes > LIMITS.bytes && list.length > 1)) {
            const old = list.shift(); bytes -= old.bytes; snapshots.delete([key, old.id]);
        }
    }

    evict(chats, snapshots, activeKey) {
        const req = chats.getAll();
        req.onsuccess = () => {
            const rows = req.result.sort((a, b) => a.updated - b.updated);
            let remaining = rows.length;
            for (const row of rows) {
                if (remaining <= LIMITS.chats) break;
                if (row.key === activeKey) continue;
                this.removeRows(row, snapshots);
                chats.delete(row.key); remaining--;
            }
        };
    }

    removeRows(meta, snapshots) {
        for (const item of [...meta.current, ...meta.previous]) snapshots.delete([meta.key, item.id]);
    }

    // Rotate both lists in one transaction: a crash cannot leave half a rotation.
    // Text entered after the send-time clear stays in the next draft.
    async sent(key, text, boundary = stamp(), sentAt = stamp(), consumeCurrent = true) {
        if (text.length > LIMITS.text) throw new Error('已发送正文过长，历史未轮换；旧历史已保留。');
        return this.transact('readwrite', (chats, snapshots, done) => {
            const request = chats.get(key);
            request.onsuccess = () => {
                const fresh = !request.result;
                const meta = request.result || { key, current: [], previous: [], updated: sentAt };
                for (const old of meta.previous) snapshots.delete([key, old.id]);
                meta.previous = consumeCurrent ? meta.current.filter(item => item.at <= boundary) : [];
                if (consumeCurrent) meta.current = meta.current.filter(item => item.at > boundary);
                // A programmatic clear is not a useful final sent version.
                while (meta.previous.at(-1)?.bytes === 0) snapshots.delete([key, meta.previous.pop().id]);
                const finish = () => {
                    this.trim(meta.previous, snapshots, key);
                    meta.updated = sentAt;
                    chats.put(meta);
                    if (fresh) this.evict(chats, snapshots, key);
                    done(true);
                };
                const addFinal = () => {
                    if (text) {
                        const id = snapshotId();
                        snapshots.put({ key, id, text, at: boundary });
                        meta.previous.push({ id, at: boundary, bytes: text.length * 2 });
                    }
                    finish();
                };
                const last = meta.previous.at(-1);
                if (!last) { addFinal(); return; }
                const prior = snapshots.get([key, last.id]);
                prior.onsuccess = () => prior.result?.text === text ? finish() : addFinal();
            };
        });
    }

    async list(key) {
        return this.transact('readonly', (chats, snapshots, done) => {
            const request = chats.get(key);
            request.onsuccess = () => done(request.result || { key, current: [], previous: [] });
        });
    }

    async read(key, id) {
        return this.transact('readonly', (chats, snapshots, done) => {
            const request = snapshots.get([key, id]);
            request.onsuccess = () => done(request.result || null);
        });
    }
}
