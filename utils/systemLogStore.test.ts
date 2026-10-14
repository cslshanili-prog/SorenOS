import { describe, expect, it } from 'vitest';
import type { SystemLog } from '../types';
import {
    appendSystemLog, loadSystemLogs, markAllSystemLogsRead, saveSystemLogs, unreadSystemLogs,
    SYSTEM_LOG_MAX, SYSTEM_LOG_STORAGE_KEY, SYSTEM_LOG_TTL_MS,
} from './systemLogStore';

const MIN = 60_000;
const log = (over: Partial<SystemLog> = {}): SystemLog => ({
    id: `log-${Math.random()}`, timestamp: 1_000_000_000_000, type: 'network', source: 'Network', message: 'Failed to fetch', ...over,
});
const memStorage = () => {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, v); },
        removeItem: (k: string) => { map.delete(k); },
    };
};

describe('appendSystemLog', () => {
    it('新的放最前面、標成未讀', () => {
        const a = log({ message: 'A' });
        const b = log({ message: 'B', timestamp: a.timestamp + MIN });
        const list = appendSystemLog(appendSystemLog([], a), b);
        expect(list.map(l => l.message)).toEqual(['B', 'A']);
        expect(list.every(l => l.read === false)).toBe(true);
    });
    it('同一個錯誤 10 分鐘內合併、記次數、換成新 id；超過就另起一筆', () => {
        const t0 = 1_000_000_000_000;
        let list = appendSystemLog([], log({ id: 'a', timestamp: t0 }));
        list = appendSystemLog(list, log({ id: 'b', timestamp: t0 + 3 * MIN }));
        list = appendSystemLog(list, log({ id: 'c', timestamp: t0 + 6 * MIN }));
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: 'c', count: 3, firstAt: t0, timestamp: t0 + 6 * MIN });
        list = appendSystemLog(list, log({ id: 'd', timestamp: t0 + 30 * MIN }));
        expect(list).toHaveLength(2);
    });
    it('合併後又變回未讀；不同來源或訊息不合併', () => {
        const t0 = 1_000_000_000_000;
        let list = markAllSystemLogsRead(appendSystemLog([], log({ timestamp: t0 })));
        expect(unreadSystemLogs(list)).toHaveLength(0);
        list = appendSystemLog(list, log({ timestamp: t0 + MIN }));
        expect(unreadSystemLogs(list)).toHaveLength(1);
        list = appendSystemLog(list, log({ timestamp: t0 + 2 * MIN, source: 'API Request' }));
        expect(list).toHaveLength(2);
    });
    it('超過 7 天的丟掉、最多 200 筆、太長的截短', () => {
        const t0 = 1_000_000_000_000;
        let list = appendSystemLog([], log({ message: 'old', timestamp: t0 }));
        list = appendSystemLog(list, log({ message: 'new', timestamp: t0 + SYSTEM_LOG_TTL_MS + MIN }));
        expect(list.map(l => l.message)).toEqual(['new']);
        list = [];
        for (let i = 0; i < SYSTEM_LOG_MAX + 20; i++) list = appendSystemLog(list, log({ message: `m${i}`, timestamp: t0 + i }));
        expect(list).toHaveLength(SYSTEM_LOG_MAX);
        const big = appendSystemLog([], log({ detail: 'x'.repeat(5000) }));
        expect(big[0].detail!.length).toBeLessThan(2100);
    });
});

describe('load / save', () => {
    it('存了再讀：上次留下的一律當已讀（開機不跳紅膠囊），過期的丟掉', () => {
        const storage = memStorage();
        const now = 1_000_000_000_000;
        saveSystemLogs([log({ message: 'keep', timestamp: now - MIN, read: false }), log({ message: 'expired', timestamp: now - SYSTEM_LOG_TTL_MS - MIN })], storage);
        const loaded = loadSystemLogs(now, storage);
        expect(loaded.map(l => l.message)).toEqual(['keep']);
        expect(loaded[0].read).toBe(true);
    });
    it('空了就移除；壞資料讀成空；配額不夠砍半再寫', () => {
        const storage = memStorage();
        saveSystemLogs([log()], storage);
        saveSystemLogs([], storage);
        expect(storage.map.has(SYSTEM_LOG_STORAGE_KEY)).toBe(false);
        storage.setItem(SYSTEM_LOG_STORAGE_KEY, '{not json');
        expect(loadSystemLogs(Date.now(), storage)).toEqual([]);
        let writes = 0;
        const tight = { ...memStorage(), setItem: (_k: string, v: string) => { writes++; if (v.length > 400) throw new Error('quota'); } };
        saveSystemLogs(Array.from({ length: 8 }, (_, i) => log({ message: `m${i}` })), tight);
        expect(writes).toBeGreaterThan(1);
    });
});

describe('遮掉網址裡的 Key', () => {
    it('?key= / &api_key= 換成 ***，其他參數不動', () => {
        const [l] = appendSystemLog([], log({ detail: 'URL: https://x.test/v1/models?key=AIzaSECRET&alt=sse\nURL2: https://y.test/?a=1&api_key=sk-abc' }));
        expect(l.detail).toContain('?key=***&alt=sse');
        expect(l.detail).toContain('&api_key=***');
        expect(l.detail).not.toContain('AIzaSECRET');
        expect(l.detail).not.toContain('sk-abc');
    });
});
