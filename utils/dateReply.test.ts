import { describe, expect, it } from 'vitest';
import { appendDateRerollNote, contentFromDateRaw, countDateChars, dateReplyMeta, readDateReply } from './dateReply';
import type { MeetingRegexScript } from './meetingPreset/types';

const script = (patch: Partial<MeetingRegexScript>): MeetingRegexScript => ({
    id: 's', scriptName: 's', findRegex: '', replaceString: '', trimStrings: [], placement: [2], disabled: false,
    markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null, ...patch,
});

describe('見面回覆 · 原文與思考', () => {
    it('原文、原生思考、正文分開拿', () => {
        const data = { choices: [{ message: { content: '<think>想</think><electric>思維鏈</electric>\n正文', reasoning_content: '原生思考' } }] };
        const reply = readDateReply(data);
        expect(reply.raw).toBe('<think>想</think><electric>思維鏈</electric>\n正文');
        expect(reply.reasoning).toBe('原生思考');
        expect(reply.content).toBe('<electric>思維鏈</electric>\n正文');
    });

    it('原文跟正文一樣就不重存', () => {
        expect(dateReplyMeta({ raw: '正文', reasoning: '' }, '正文')).toEqual({});
        expect(dateReplyMeta({ raw: '<x>a</x>正文', reasoning: '想' }, '正文', '預設 A')).toEqual({ dateRaw: '<x>a</x>正文', dateReasoning: '想', datePresetName: '預設 A' });
    });

    it('改過的原文重新換出正文：拿掉 think、跑存檔正則（只改顯示的不跑）', () => {
        const scripts = [
            script({ findRegex: '/<electric>[\\s\\S]*?<\\/electric>/g' }),
            script({ id: 'd', findRegex: '/正文/g', replaceString: '顯示用', markdownOnly: true }),
        ];
        expect(contentFromDateRaw('<think>想</think><electric>鏈</electric>\n正文', scripts)).toBe('正文');
        expect(contentFromDateRaw('<think>沒收尾', [])).toBe('');
    });

    it('字數不算空白', () => {
        expect(countDateChars('一 二\n三')).toBe(3);
    });

    it('重新生成的說明：插在最後，有預填就放在它前面；空的不加', () => {
        const base = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
        expect(appendDateRerollNote(base, '太短')).toHaveLength(3);
        expect(appendDateRerollNote(base, '太短')[2].content).toContain('太短');
        const withPrefill = [...base, { role: 'assistant', content: '<electric>' }];
        const out = appendDateRerollNote(withPrefill, '照格式');
        expect(out.map(m => m.role)).toEqual(['system', 'user', 'system', 'assistant']);
        expect(appendDateRerollNote(base, '  ')).toBe(base);
    });
});
