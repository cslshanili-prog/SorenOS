import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DB, openDB } from './db';

// fake-indexeddb 已由 test-setup.ts 注入。
//
// 這組用例釘住 db.ts 裡幾個寫函數的「落盤可感知」：IndexedDB 的 put 失敗（最常見的
// QuotaExceededError，iOS Safari 快滿時天天見）走的是 error 事件 → 事務 abort，
// 而不是同步拋異常。誰要是發完 put 就 resolve，調用方拿到的永遠是「保存成功」，
// 庫裡卻什麼都沒寫進去——「一鍵優化」就是這麼報出「已轉 N 張、釋放約 X」，
// 而表行其實還是 base64、轉出來的 Blob 全成了孤兒。
//
// 正確寫法見同文件的 saveAsset：等 transaction.oncomplete 再 resolve，
// onerror / onabort 一律 reject。

const DB_SOURCE = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');

// 被 review 點名的六個寫函數：以前都是「發完 put 就 resolve」
const DURABLE_WRITERS = [
    'updateMessage',
    'saveEmoji',
    'saveTheme',
    'saveGalleryImage',
    'saveCustomCreatorPart',
    'saveSong',
] as const;

const originalPut = IDBObjectStore.prototype.put;

/**
 * 造一次「put 失敗」。
 *
 * fake-indexeddb 造不出真的配額不足，但配額不足的最終形態就是事務被 abort，
 * 所以這裡直接在 put 被調用的瞬間掐掉它所屬的事務，等價於真機上的
 * QuotaExceededError → abort。只掐指定的表，別把測試自己的準備工作也帶崩。
 */
function abortOnPut(storeName: string) {
    return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        if (this.name === storeName) {
            this.transaction.abort();
            // 事務已經沒了，返回值沒人會去監聽，給個佔位殼即可
            return { onsuccess: null, onerror: null } as unknown as IDBRequest;
        }
        return (originalPut as any).apply(this, args);
    });
}

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    // 先把庫打開，免得 openDB 的建表流程撞上後面裝的 put 攔截
    await openDB();
    for (const s of ['messages', 'emojis', 'themes', 'gallery', 'cc_custom_parts', 'songs']) {
        await clearStore(s);
    }
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('寫入失敗必須讓調用方感知（不再靜默 resolve）', () => {
    // 五個「一句 put 了事」的保存函數，寫法一致，用表格跑
    const cases: { name: string; store: string; run: () => Promise<void> }[] = [
        {
            name: 'saveEmoji',
            store: 'emojis',
            run: () => DB.saveEmoji('表情A', 'data:image/png;base64,AQID', 'default'),
        },
        {
            name: 'saveTheme',
            store: 'themes',
            run: () => DB.saveTheme({ id: 'theme-1', name: '測試主題' } as any),
        },
        {
            name: 'saveGalleryImage',
            store: 'gallery',
            run: () => DB.saveGalleryImage({ id: 'g-1', charId: 'c-1', url: 'data:image/png;base64,AQID', timestamp: 1 } as any),
        },
        {
            name: 'saveCustomCreatorPart',
            store: 'cc_custom_parts',
            run: () => DB.saveCustomCreatorPart({ id: 'part-1', createdAt: 1 } as any),
        },
        {
            name: 'saveSong',
            store: 'songs',
            run: () => DB.saveSong({ id: 'song-1', title: '測試' } as any),
        },
    ];

    for (const c of cases) {
        it(`${c.name}: put 失敗（事務 abort）時 reject，而不是假裝成功`, async () => {
            abortOnPut(c.store);
            await expect(c.run()).rejects.toBeTruthy();
        });
    }

    it('updateMessage: put 失敗（事務 abort）時 reject，而不是假裝改寫成功', async () => {
        const id = await DB.saveMessage({ charId: 'c-1', role: 'user', content: '原文' } as any);
        abortOnPut('messages');
        await expect(DB.updateMessage(id, '改寫後')).rejects.toBeTruthy();
    });

    it('updateMessage: 消息不存在時照舊 reject', async () => {
        await expect(DB.updateMessage(99999, '隨便')).rejects.toThrow('Message not found');
    });
});

describe('寫入成功時行為不變', () => {
    it('saveEmoji resolve 之後，數據已經能讀到', async () => {
        await DB.saveEmoji('表情B', 'data:image/png;base64,BAUG');
        const all = await DB.getEmojis();
        expect(all.map(e => e.name)).toContain('表情B');
    });

    it('updateMessage resolve 之後，改寫已經落庫', async () => {
        const id = await DB.saveMessage({ charId: 'c-2', role: 'assistant', content: '舊內容' } as any);
        await DB.updateMessage(id, '新內容');
        const msgs = await DB.getMessagesByCharId('c-2');
        expect(msgs.find(m => m.id === id)?.content).toBe('新內容');
    });
});

describe('源碼錨點：六個寫函數都得等事務完成', () => {
    /** 截出 DB 裡某個成員函數的源碼（從簽名到那一行 `  },`） */
    function sliceMember(name: string): string {
        const start = DB_SOURCE.indexOf(`\n  ${name}: async (`);
        expect(start, `db.ts 裡找不到 ${name}`).toBeGreaterThan(-1);
        const end = DB_SOURCE.indexOf('\n  },', start);
        expect(end, `${name} 的函數體沒找到結尾`).toBeGreaterThan(start);
        return DB_SOURCE.slice(start, end);
    }

    for (const name of DURABLE_WRITERS) {
        it(`${name} 掛了 oncomplete / onerror / onabort`, () => {
            const body = sliceMember(name);
            expect(body).toMatch(/\.oncomplete\s*=/);
            expect(body).toMatch(/\.onerror\s*=/);
            expect(body).toMatch(/\.onabort\s*=/);
        });
    }
});
