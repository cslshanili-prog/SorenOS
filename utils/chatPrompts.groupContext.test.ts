import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { setCharNameRegistry, getCharNameById } from './charNameRegistry';

// 群聊背景注入的發言人標註：之前所有角色發言（包括收到注入的角色自己）都被匿名成
// "Member"，私聊被問起群裡的事時角色分不清誰說了什麼、認不出自己的發言。
// 修復後：user 顯示用戶名，注入對象自己的發言標「你（名字）」，其他成員經
// charNameRegistry 解析出真實名字，查不到的兜底「群友」。

const charA = { id: 'char-a', name: '阿一' } as any;
const userProfile = { name: '條條' } as any;
const groups = [{ id: 'g-test', name: '深夜茶話會', members: ['char-a', 'char-b'] }] as any;

describe('群聊背景注入 · 發言人真實標註', () => {
    it('charNameRegistry 基本行為', () => {
        setCharNameRegistry([{ id: 'x', name: '小明' }]);
        expect(getCharNameById('x')).toBe('小明');
        expect(getCharNameById('missing')).toBeNull();
        expect(getCharNameById(null)).toBeNull();
    });

    it('注入塊標註：用戶名 / 你（自己） / 真實成員名 / 未知兜底群友', async () => {
        setCharNameRegistry([
            { id: 'char-a', name: '阿一' },
            { id: 'char-b', name: '阿二' },
        ]);
        await DB.saveMessage({ charId: 'user', groupId: 'g-test', role: 'user', type: 'text', content: '今晚吃火鍋嗎' } as any);
        await DB.saveMessage({ charId: 'char-a', groupId: 'g-test', role: 'assistant', type: 'text', content: '我要毛肚' } as any);
        await DB.saveMessage({ charId: 'char-b', groupId: 'g-test', role: 'assistant', type: 'text', content: '加寬粉' } as any);
        await DB.saveMessage({ charId: 'char-ghost', groupId: 'g-test', role: 'assistant', type: 'text', content: '幽靈發言' } as any);

        const parts = await ChatPrompts.buildSystemPromptParts(
            charA, userProfile, groups, [], [], [],
        );
        const injected = parts.volatileState;

        expect(injected).toContain('你親歷的近期群聊');
        expect(injected).toContain('條條: 今晚吃火鍋嗎');
        expect(injected).toContain('你（阿一）: 我要毛肚');
        expect(injected).toContain('阿二: 加寬粉');
        expect(injected).toContain('群友: 幽靈發言');
        expect(injected).not.toContain('Member');
    });
});
