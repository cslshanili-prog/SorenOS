import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';

afterEach(() => vi.restoreAllMocks());

describe('通知前必須確認消息/定時任務已提交', () => {
    it('定時任務寫入事務中止時不能報告成功', async () => {
        await openDB();
        const originalPut = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
            const request = (originalPut as any).apply(this, args) as IDBRequest;
            this.transaction.abort();
            return request;
        });
        await expect(DB.saveScheduledMessage({
            id: 'failed-schedule', charId: 'schedule-abort', content: '該出門了', dueAt: 1, createdAt: 1,
        })).rejects.toBeTruthy();
        expect(await DB.getDueScheduledMessages('schedule-abort')).toEqual([]);
    });

    it('消息 add 成功但事務隨後中止時，不能讓調用方發出成功通知', async () => {
        await openDB();
        const originalAdd = IDBObjectStore.prototype.add;
        vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
            const request = (originalAdd as any).apply(this, args) as IDBRequest;
            request.addEventListener('success', () => this.transaction.abort());
            return request;
        });
        await expect(DB.saveMessage({
            charId: 'message-abort', role: 'assistant', type: 'text', content: '晚安',
        })).rejects.toBeTruthy();
        expect(await DB.getMessagesByCharId('message-abort', true)).toEqual([]);
    });

    it('任務與消息成功提交後能讀到，刪除任務也等提交完成', async () => {
        await DB.saveScheduledMessage({ id: 'saved-schedule', charId: 'schedule-ok', content: '到了', dueAt: 1, createdAt: 1 });
        expect(await DB.getDueScheduledMessages('schedule-ok')).toHaveLength(1);
        const id = await DB.saveMessage({ charId: 'schedule-ok', role: 'assistant', type: 'text', content: '到了' });
        expect((await DB.getMessagesByCharId('schedule-ok', true))[0].id).toBe(id);
        await DB.deleteScheduledMessage('saved-schedule');
        expect(await DB.getDueScheduledMessages('schedule-ok')).toEqual([]);
    });
});
