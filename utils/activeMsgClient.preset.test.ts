import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildFirePack } from './activeMsgClient';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

// 私聊預設接上主動消息 2.0（plans/preset-library.md 第 2b 批）：fire_pack 模板的【角色系統設定】
// 照預設組；沒選預設就是原本那一串（buildSystemPrompt，forFirePack）。

const doc: any = {
    schema: 'soren.meeting-preset', version: 1, name: '日月', generation: {}, regexScripts: [], groups: [], globalVars: {},
    prompts: [
        { id: 'main', name: '主提示', enabled: true, role: 'system', content: '你是{{char}}，文筆細膩。' },
        { id: 'chatHistory', name: '聊天記錄', enabled: true, role: 'system', content: '', slot: 'chatHistory' },
        { id: 'jb', name: '破限', enabled: true, role: 'system', content: '照劇情走。' },
    ],
};
const user = { name: '小明' } as any;
const pack = (char: any) => buildFirePack({ id: 'char-1', name: '小滿', memories: [], ...char } as any, user, [], undefined, { all: [], categories: [] });

describe('fire_pack 的角色設定照私聊預設', () => {
    beforeEach(() => {
        vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
        vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
    });
    afterEach(() => vi.restoreAllMocks());

    it('選了預設：主提示在前、Soren 功能照補、文風不補、破限在最後', async () => {
        vi.spyOn(DB, 'getMeetingPreset').mockResolvedValue({ id: 'p1', name: '日月', doc, createdAt: 0, updatedAt: 0 } as any);
        const legacy = vi.spyOn(ChatPrompts, 'buildSystemPrompt');
        const out = await pack({ chatPresetId: 'p1' });
        expect(legacy).not.toHaveBeenCalled();
        const block = out.template.split('【角色系統設定】\n')[1].split('\n（注意：上面角色設定裡')[0];
        expect(block.startsWith('你是小滿，文筆細膩。')).toBe(true);
        expect(block).toContain('**TOP 1｜ChatApp 格式');
        expect(block).not.toContain('1. **沉浸感**');
        expect(block).not.toContain('### 最後，回到你自己');
        expect(block.trim().endsWith('照劇情走。')).toBe(true);
    });

    it('沒選預設：照舊走 buildSystemPrompt（forFirePack）', async () => {
        const spy = vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
        const out = await pack({});
        expect(spy).toHaveBeenCalledTimes(1);
        expect(out.template).toContain('SYS_PROMPT_MARKER');
    });
});
