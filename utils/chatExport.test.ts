import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { buildSorenChatExport, buildStChatJsonl, chatScopeMessages, dayEnd, dayStart, exportFileName, formatChatTxt, parseChatExportJson, parseSorenChatExport } from './chatExport';
import { findAlreadyImported, toMemoryFragments } from './chatImportPhone';
import { planImportRows } from './chatImportPhoneWrite';
import { parseStChat } from './stChat';

// 假資料
const T = new Date(2026, 0, 2, 9, 5).getTime();
const msg = (id: number, over: Partial<Message>): Message => ({ id, charId: 'c1', role: 'user', type: 'text', content: '', timestamp: T + id * 60000, ...over });
const MSGS: Message[] = [
    msg(1, { content: '早安' }),
    msg(2, { role: 'assistant', content: '嗯，早。', metadata: { thinkingChain: '她起得真早', deliveryId: 'd1' }, replyTo: { id: 1, content: '早安', name: '我' } }),
    msg(3, { role: 'assistant', type: 'image', content: 'https://img.example/a.jpg', metadata: { visionDescription: '一杯咖啡' } }),
    msg(4, { type: 'emoji', content: 'https://img.example/s.png', metadata: { stickerName: '偷看' } }),
    msg(5, { role: 'assistant', content: '見面時說的', metadata: { source: 'date' } }),
    msg(6, { role: 'assistant', content: '隔天', timestamp: T + 86400000 }),
];

describe('私聊匯出', () => {
    it('只拿私聊畫面那些、照日期區間', () => {
        expect(chatScopeMessages(MSGS).map(m => m.id)).toEqual([1, 2, 3, 4, 6]);
        const key = `${new Date(T).getFullYear()}-${String(new Date(T).getMonth() + 1).padStart(2, '0')}-${String(new Date(T).getDate()).padStart(2, '0')}`;
        expect(chatScopeMessages(MSGS, { from: dayStart(key), to: dayEnd(key) }).map(m => m.id)).toEqual([1, 2, 3, 4]);
    });

    it('TXT：日期分段、名字 時間：內容', () => {
        const txt = formatChatTxt({ charName: '阿岳', userName: '小晴', messages: chatScopeMessages(MSGS), stickerName: (_u, f) => f || '貼圖' });
        expect(txt).toContain('===== 2026/01/02（週五） =====');
        expect(txt).toContain('小晴 09:06：早安');
        expect(txt).toContain('阿岳 09:07：（回覆「早安」）嗯，早。');
        expect(txt).toContain('[圖片：一杯咖啡]');
        expect(txt).toContain('[貼圖：偷看]');
        expect(txt).not.toContain('見面時說的');
    });

    it('Soren JSON 匯回同一條線：全部認得、不會多一份；引用接回原本那則', () => {
        const file = JSON.parse(JSON.stringify(buildSorenChatExport({ char: { id: 'c1', name: '阿岳' }, userName: '小晴', messages: chatScopeMessages(MSGS), memories: [{ id: 'm', date: '2026-01-02', summary: '喝咖啡' }] })));
        expect(file.messages[1].metadata).toEqual({ thinkingChain: '她起得真早' });
        const parsed = parseChatExportJson(file);
        expect(parsed).toMatchObject({ kind: 'private', origin: 'soren', character: { name: '阿岳' } });
        expect(findAlreadyImported(chatScopeMessages(MSGS), parsed.messages).existingMessageIds).toHaveLength(5);
        const plan = planImportRows({ messages: parsed.messages, existing: chatScopeMessages(MSGS), duplicate: 'skip', place: () => ({ charId: 'c1' }) });
        expect(plan.rows).toHaveLength(0);
        // 匯到空的角色：引用指回匯進來的那則
        const fresh = planImportRows({ messages: parsed.messages, existing: [], duplicate: 'skip', place: () => ({ charId: 'c2' }) });
        expect(fresh.rows).toHaveLength(5);
        expect(fresh.sources[1].replyToSourceId).toBe(fresh.sources[0].metadata.importedFrom.id);
        expect(toMemoryFragments(parsed.memories)[0].summary).toBe('喝咖啡');
        expect(() => parseSorenChatExport({ foo: 1 } as any)).toThrow();
    });

    it('檔名', () => {
        expect(exportFileName('阿/岳', '聊天紀錄', 'txt', T)).toBe('阿_岳_聊天紀錄_20260102.txt');
    });
});

describe('見面故事 → ST jsonl', () => {
    it('匯出再匯回 Soren：正文、思考、開場白都在', () => {
        const story: Message[] = [
            msg(10, { role: 'assistant', content: '雨下了三天。', metadata: { source: 'date', isOpening: true } }),
            msg(11, { content: '「還開著嗎？」', metadata: { source: 'date' } }),
            msg(12, { role: 'assistant', content: '「進來。」', metadata: { source: 'date', dateRaw: '<thinking>她淋濕了</thinking>\n「進來。」', dateReasoning: '她淋濕了' } }),
            msg(13, { role: 'assistant', type: 'image', content: 'x', metadata: { source: 'date' } }),
        ];
        const jsonl = buildStChatJsonl({ charName: '阿岳', userName: '小晴', messages: story });
        const lines = jsonl.trim().split('\n').map(l => JSON.parse(l));
        expect(lines[0]).toMatchObject({ user_name: '小晴', character_name: '阿岳' });
        expect(lines).toHaveLength(4);
        expect(lines[3]).toMatchObject({ name: '阿岳', is_user: false, mes: '「進來。」', extra: { reasoning: '她淋濕了' }, swipe_id: 0 });
        const back = parseStChat(jsonl);
        expect(back.charName).toBe('阿岳');
        expect(back.messages.map(m => m.content)).toEqual(['雨下了三天。', '「還開著嗎？」', '「進來。」']);
        expect(back.messages[0].metadata.isOpening).toBe(true);
        expect(back.messages[2].metadata.dateReasoning).toBe('她淋濕了');
    });
});
