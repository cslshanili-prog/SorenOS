import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    armDateResumeAttempt,
    clearDateResumeAttempt,
    takeCrashedDateResume,
} from './dateSessionRecovery';

// 鎖住見面「繼續上次」崩潰自愈的兩段式護欄:
// arm(恢復開始) → clear(恢復成功/乾淨退出); 若進程在兩者之間被 iOS WebKit 殺掉,
// 哨兵殘留, 下次 take 讀到 = 上次恢復崩了 → 調用方丟棄有毒的 savedDateState。
//
// 測試環境是 node (無 sessionStorage)，用 Map 後端的 stub 模擬，與 chunkLoadRecovery.test.ts 一致。

const KEY = 'sullyos_date_resume_attempt';

const stubSessionStorage = () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
    });
    return store;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('dateSessionRecovery 兩段式護欄', () => {
    it('arm 後正常 clear（恢復成功）→ 再進見面無殘留', () => {
        stubSessionStorage();
        armDateResumeAttempt('char-1');
        clearDateResumeAttempt();
        expect(takeCrashedDateResume()).toBeNull();
    });

    it('arm 後沒 clear（進程崩潰）→ 下次進見面檢出崩潰的 charId', () => {
        stubSessionStorage();
        armDateResumeAttempt('char-42');
        // 模擬崩潰 + reload：sessionStorage 在同一 tab 會話內留存，哨兵仍在
        expect(takeCrashedDateResume()).toBe('char-42');
    });

    it('take 只讀一次：讀到後自動清除，第二次返回 null', () => {
        stubSessionStorage();
        armDateResumeAttempt('char-7');
        expect(takeCrashedDateResume()).toBe('char-7');
        expect(takeCrashedDateResume()).toBeNull();
    });

    it('從未 arm → take 返回 null（正常全新進入不誤傷）', () => {
        stubSessionStorage();
        expect(takeCrashedDateResume()).toBeNull();
    });

    it('後一次 arm 覆蓋前一次的 charId', () => {
        stubSessionStorage();
        armDateResumeAttempt('char-a');
        armDateResumeAttempt('char-b');
        expect(takeCrashedDateResume()).toBe('char-b');
    });

    it('哨兵內容損壞（非法 JSON）→ take 安全返回 null，不拋異常，並清除', () => {
        const store = stubSessionStorage();
        store.set(KEY, '{not valid json');
        expect(() => takeCrashedDateResume()).not.toThrow();
        expect(store.has(KEY)).toBe(false);
    });

    it('哨兵缺 charId 字段 → take 返回 null', () => {
        const store = stubSessionStorage();
        store.set(KEY, JSON.stringify({ at: 123 }));
        expect(takeCrashedDateResume()).toBeNull();
    });

    it('sessionStorage 不可用時靜默降級，不影響調用方', () => {
        // 不 stub sessionStorage → 訪問拋 ReferenceError → 內部 catch
        expect(() => armDateResumeAttempt('char-x')).not.toThrow();
        expect(() => clearDateResumeAttempt()).not.toThrow();
        expect(takeCrashedDateResume()).toBeNull();
    });
});
