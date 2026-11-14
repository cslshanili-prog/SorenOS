import { describe, expect, it } from 'vitest';
import { isStChatText, parseStChat, splitThinking, stChatTitle } from './stChat';

// 假資料：照 ST 聊天檔的形狀，內容是編的
const jsonl = (rows: any[]) => rows.map(r => JSON.stringify(r)).join('\n');
const FILE = jsonl([
    { user_name: 'unused', character_name: 'unused', chat_metadata: { note_prompt: '', variables: {} } },
    { name: '阿岳', is_user: false, is_system: false, send_date: '2026-01-02T03:00:00.000Z', mes: '雨下了三天。\r\n\r\n他把店門推開。', swipes: ['版本一', '雨下了三天。\r\n\r\n他把店門推開。', '版本三'], swipe_id: 1, extra: {} },
    { name: '小晴', is_user: true, is_system: false, send_date: '2026-01-02T03:05:00.000Z', mes: '「還開著嗎？」', extra: { media: [{ url: 'user/images/a.png' }] } },
    { name: '阿岳', is_user: false, send_date: '2026-01-02T03:06:00.000Z', mes: '<thinking>\n她淋濕了\n</thinking>\n<title>第一章</title>\n「進來。」', extra: { model: 'x', reasoning: '先想一下' } },
    { name: '阿岳', is_user: false, is_system: true, send_date: '2026-01-02T03:07:00.000Z', mes: '（藏起來的一段）', extra: {} },
    { name: '阿岳', is_user: false, send_date: '2026-01-02T03:08:00.000Z', mes: '<thinking>只有思考</thinking>', extra: {} },
    { name: '小晴', is_user: true, send_date: 'November 2, 2026 4:43am', mes: '舊格式的時間', extra: {} },
]);

describe('SillyTavern 聊天檔', () => {
    it('認得 jsonl，認不得別的', () => {
        expect(isStChatText(FILE)).toBe(true);
        expect(isStChatText('{"messages":[]}')).toBe(false);
        expect(isStChatText('not json')).toBe(false);
        expect(() => parseStChat('{"foo":1}')).toThrow('不是 SillyTavern 的聊天檔');
    });

    it('只收選中的那版、拆思考、隱藏的照收', () => {
        const r = parseStChat(FILE);
        expect(r.charName).toBe('阿岳');
        expect(r.userName).toBeUndefined();
        expect(r.messages.map(m => m.role)).toEqual(['assistant', 'user', 'assistant', 'assistant', 'user']);
        const [open, user, reply, hidden, old] = r.messages;
        expect(open).toMatchObject({ content: '雨下了三天。\n\n他把店門推開。' });
        expect(open.metadata).toMatchObject({ source: 'date', isOpening: true });
        expect(user.metadata.isOpening).toBeUndefined();
        expect(reply.content).toBe('<title>第一章</title>\n「進來。」');
        expect(reply.metadata.dateReasoning).toBe('先想一下\n\n她淋濕了');
        expect(reply.metadata.dateRaw).toContain('<thinking>');
        expect(hidden.metadata.stHidden).toBe(true);
        expect(new Date(old.timestamp).getHours()).toBe(4);
        expect(r.stats).toMatchObject({ user: 2, char: 3, hidden: 1, withThinking: 1, droppedSwipes: 2, images: 1 });
        expect(r.skipped).toEqual({ '只有思考、沒有正文': 1 });
        expect(new Set(r.messages.map(m => m.metadata.importedFrom.id)).size).toBe(5);
    });

    it('沒收尾的 <thinking> 後面全算思考', () => {
        expect(splitThinking('正文<thinking>想到一半')).toEqual({ body: '正文', thinking: '想到一半' });
    });

    it('檔名當標題，拿掉 ST 的時間戳', () => {
        expect(stChatTitle('阿岳 - 2026-01-02@03h04m05s.jsonl')).toBe('阿岳');
        expect(stChatTitle('雨夜.jsonl')).toBe('雨夜');
    });
});
