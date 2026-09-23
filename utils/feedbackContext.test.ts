import { beforeEach, describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { DB } from './db';
import { loadCharacterContextMessages } from './chatContextRange';
import { DatePrompts } from './datePrompts';

describe('各入口共用角色上下文範圍', () => {
    beforeEach(() => localStorage.clear());
    const char = (mode: 'adaptive' | 'manual'): CharacterProfile => ({
        id: 'feedback-context', name: '角色', avatar: '', description: '', systemPrompt: '', memories: [],
        contextLimit: 10, contextRangeMode: mode, contextRangePolicyVersion: 1, autoArchiveEnabled: true,
    });
    const rows = (): Message[] => Array.from({ length: 60 }, (_, index) => ({
        id: index + 1, charId: 'feedback-context', role: index % 2 ? 'assistant' : 'user',
        type: 'text', content: `原文標記${index + 1}結束`, timestamp: 1700000000000 + index,
        metadata: { source: index < 10 ? 'chat' : index < 30 ? 'date' : 'call' },
    }));
    it('見面自適應不受殘留 10 條影響，發送和重寫都保留水位後的全部來源', async () => {
        localStorage.setItem('mp_lastMsgId_feedback-context', '10');
        for (const variant of ['send', 'reroll'] as const) {
            const result = await DatePrompts.buildSessionPayload({ char: char('adaptive'), userProfile: { name: '用戶' } as UserProfile, allMsgs: rows(), emojis: [], userText: '現在', variant });
            const text = JSON.stringify(result.messages);
            expect(text).toContain('原文標記11結束');
            expect(text).toContain('原文標記31結束');
            expect(text).not.toContain('原文標記10結束');
        }
    });
    it('見面手動範圍忽略水位線，感知開場也不會再固定截 50 條', async () => {
        localStorage.setItem('mp_lastMsgId_feedback-context', '58');
        const c = { ...char('manual'), contextLimit: 60 };
        const result = await DatePrompts.buildSessionPayload({ char: c, userProfile: { name: '用戶' } as UserProfile, allMsgs: rows(), emojis: [], userText: '現在', variant: 'send' });
        expect(JSON.stringify(result.messages)).toContain('原文標記1結束');
        expect(JSON.stringify(DatePrompts.buildPeekPayload({ char: c, userProfile: { name: '用戶' } as UserProfile, allMsgs: rows(), emojis: [] }))).toContain('原文標記1結束');
    });
    it('數據庫入口支持按角色對象和 ID 讀取，手動模式可跨過歸檔線', async () => {
        const c = { ...char('adaptive'), id: 'feedback-db' };
        await DB.saveCharacter(c);
        const ids: number[] = [];
        for (let i = 0; i < 24; i++) ids.push(await DB.saveMessage({ charId: c.id, role: 'user', type: 'text', content: `msg-${i}` }));
        localStorage.setItem(`mp_lastMsgId_${c.id}`, String(ids[3]));
        expect(await loadCharacterContextMessages(c.id)).toHaveLength(20);
        const manual = await loadCharacterContextMessages({ ...c, contextRangeMode: 'manual', contextLimit: 24 });
        expect(manual.map(row => row.id)).toEqual(ids);
    });
});
