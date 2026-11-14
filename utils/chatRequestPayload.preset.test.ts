import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildChatRequestPayload, type BuildChatPayloadInput } from './chatRequestPayload';
import { DB } from './db';

// 私聊自訂預設（plans/preset-library.md 第 2 批）：角色選了一份通用預設就照預設組；
// 沒選＝內建，送出結構照舊是「穩定段＋聊天記錄＋易變尾段」。

const doc: any = {
    schema: 'soren.meeting-preset', version: 1, name: '日月', generation: {}, regexScripts: [], groups: [], globalVars: {},
    prompts: [
        { id: 'main', name: '主提示', enabled: true, role: 'system', content: '你是{{char}}，文筆細膩。' },
        { id: 'chatHistory', name: '聊天記錄', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
        { id: 'jb', name: '破限', enabled: true, role: 'system', content: '照劇情走。' },
    ],
};

const input = (char: any, profile: any = { name: '小明' }): BuildChatPayloadInput => ({
    char: { id: 'c-preset', name: '阿一', ...char },
    userProfile: profile,
    groups: [], emojis: [], categories: [],
    historyMsgs: [{ id: 1, charId: 'c-preset', role: 'user', type: 'text', content: '在嗎', timestamp: Date.now() }] as any[],
    contextLimit: 20,
});

afterEach(() => vi.restoreAllMocks());

describe('私聊照預設組', () => {
    it('沒選預設：照舊三段，收尾是「回到你自己」', async () => {
        const payload = await buildChatRequestPayload(input({}));
        expect(payload.flags.chatPresetActive).toBe(false);
        expect(payload.fullMessages[0].content).toContain('### 聊天 App 行為規範');
        expect(String(payload.fullMessages[payload.fullMessages.length - 1].content)).toContain('### 最後，回到你自己');
    });

    it('角色選了一份：主提示在最前面，功能照補，文風不補，實時狀態在聊天記錄後', async () => {
        vi.spyOn(DB, 'getMeetingPreset').mockResolvedValue({ id: 'p1', name: '日月', doc, createdAt: 0, updatedAt: 0 } as any);
        const payload = await buildChatRequestPayload(input({ chatPresetId: 'p1' }));
        expect(payload.flags.chatPresetActive).toBe(true);
        const first = String(payload.fullMessages[0].content);
        expect(first.startsWith('你是阿一，文筆細膩。')).toBe(true);
        expect(first).toContain('**TOP 1｜ChatApp 格式');
        expect(first).toContain('[[SEND_EMOJI:');
        expect(first).not.toContain('1. **沉浸感**');
        const all = payload.fullMessages.map(m => String(m.content)).join('\n');
        expect(all).not.toContain('### 最後，回到你自己');
        const userIdx = payload.fullMessages.findIndex(m => m.role === 'user');
        const tail = String(payload.fullMessages[userIdx + 1].content);
        expect(tail).toContain('[System: 實時狀態 (Live Context)]');
        expect(tail.trim().endsWith('照劇情走。')).toBe(true);
        expect(payload.volatileTailIndex).toBe(userIdx + 1);
    });

    it('場景預設：角色沒選就跟私聊的場景預設；角色選內建就是內建', async () => {
        vi.spyOn(DB, 'getMeetingPreset').mockResolvedValue({ id: 'p1', name: '日月', doc, createdAt: 0, updatedAt: 0 } as any);
        const profile = { name: '小明', presetSceneDefaults: { chat: 'p1' } };
        expect((await buildChatRequestPayload(input({}, profile))).flags.chatPresetActive).toBe(true);
        expect((await buildChatRequestPayload(input({ chatPresetId: 'builtin' }, profile))).flags.chatPresetActive).toBe(false);
    });

    it('即時對話（交給雲端生成）也照預設：worker 只在最後補時效段', async () => {
        vi.spyOn(DB, 'getMeetingPreset').mockResolvedValue({ id: 'p1', name: '日月', doc, createdAt: 0, updatedAt: 0 } as any);
        const payload = await buildChatRequestPayload({ ...input({ chatPresetId: 'p1' }), timelyByWorker: true });
        expect(payload.flags.chatPresetActive).toBe(true);
        expect(String(payload.fullMessages[0].content).startsWith('你是阿一，文筆細膩。')).toBe(true);
    });

    it('沒選預設也沒設場景預設：不讀預設表', async () => {
        const spy = vi.spyOn(DB, 'getMeetingPreset');
        await buildChatRequestPayload(input({}));
        expect(spy).not.toHaveBeenCalled();
    });

    it('選的那份被刪了：退回內建', async () => {
        vi.spyOn(DB, 'getMeetingPreset').mockResolvedValue(undefined);
        const payload = await buildChatRequestPayload(input({ chatPresetId: 'gone' }));
        expect(payload.flags.chatPresetActive).toBe(false);
    });
});
