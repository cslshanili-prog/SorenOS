import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import {
    buildNpcMemoryBlock, buildNpcMemoryUpdatePrompt, cleanNpcMemoryOutput, formatGroupTranscriptForNpc,
    NPC_MEMORY_GROUP_THRESHOLD, NPC_MEMORY_MAX_CHARS, pendingGroupMemorySlice, resolveNpcApi,
} from './npcMemory';

const msg = (id: number, charId: string, content: string, role: Message['role'] = 'assistant'): Message =>
    ({ id, charId, role, type: 'text', content, timestamp: id } as Message);

describe('記憶塊', () => {
    it('沒記憶是空字串，有就帶名字', () => {
        expect(buildNpcMemoryBlock({ name: '房東' })).toBe('');
        expect(buildNpcMemoryBlock({ name: '房東', memory: '  ' })).toBe('');
        expect(buildNpcMemoryBlock({ name: '房東', memory: '- 小夏欠房租' })).toContain('房東 記得的事');
    });
});

describe('群聊水位', () => {
    const msgs = Array.from({ length: 40 }, (_, i) => msg(i + 1, 'c1', `第${i + 1}句`));

    it('水位之後攢到門檻才整理，系統消息不算', () => {
        expect(pendingGroupMemorySlice(msgs, 40 - NPC_MEMORY_GROUP_THRESHOLD + 1)).toBeNull();
        const slice = pendingGroupMemorySlice(msgs, 40 - NPC_MEMORY_GROUP_THRESHOLD);
        expect(slice?.messages).toHaveLength(NPC_MEMORY_GROUP_THRESHOLD);
        expect(slice?.endId).toBe(40);
        const withSystem = [...msgs.slice(0, 29), msg(99, 'c1', '誰退群了', 'system')];
        expect(pendingGroupMemorySlice(withSystem, 0)).toBeNull();
    });

    it('force 時有新消息就整理；沒有新消息回 null', () => {
        expect(pendingGroupMemorySlice(msgs, 38, { force: true })?.messages.map(m => m.id)).toEqual([39, 40]);
        expect(pendingGroupMemorySlice(msgs, 40, { force: true })).toBeNull();
    });
});

describe('逐字稿與提示詞', () => {
    it('NPC 自己說的標「我」，用戶標名字', () => {
        const text = formatGroupTranscriptForNpc(
            [msg(1, 'user', '房租晚點給', 'user'), msg(2, 'n1', '又晚？'), msg(3, 'c1', '我幫他作證')],
            'n1', id => (id === 'c1' ? '小夏' : '?'), '小安',
        );
        expect(text).toBe('小安: 房租晚點給\n我: 又晚？\n小夏: 我幫他作證');
    });

    it('提示詞帶上舊記憶、來源、字數上限', () => {
        const prompt = buildNpcMemoryUpdatePrompt({
            npc: { name: '房東', description: '大叔', memory: '- 舊事' },
            sourceLabel: '群聊「公寓」', transcript: '小夏: 嗨', userName: '小安',
        });
        expect(prompt).toContain('- 舊事');
        expect(prompt).toContain('剛經歷的：群聊「公寓」');
        expect(prompt).toContain(`${NPC_MEMORY_MAX_CHARS} 字`);
    });
});

describe('輸出收尾', () => {
    it('去掉程式碼框和標題行', () => {
        expect(cleanNpcMemoryOutput('```\n記憶：\n- 一\n- 二\n```')).toBe('- 一\n- 二');
    });

    it('超長在換行處截斷', () => {
        const long = Array.from({ length: 200 }, (_, i) => `- 第${i}條記憶內容`).join('\n');
        const out = cleanNpcMemoryOutput(long);
        expect(out.length).toBeLessThanOrEqual(Math.round(NPC_MEMORY_MAX_CHARS * 1.25));
        expect(out.endsWith('記憶內容')).toBe(true);
    });
});

describe('API', () => {
    it('NPC 自己配了完整的才用，否則用後備', () => {
        const fallback = { baseUrl: 'https://a', apiKey: 'k', model: 'm' };
        expect(resolveNpcApi({}, fallback)).toBe(fallback);
        expect(resolveNpcApi({ chatApi: { baseUrl: 'https://b', apiKey: '', model: 'x' } }, fallback)).toBe(fallback);
        expect(resolveNpcApi({ chatApi: { baseUrl: 'https://b', apiKey: 'kk', model: 'x' } }, fallback).baseUrl).toBe('https://b');
    });
});
