import { describe, expect, it } from 'vitest';
import { describeOldFiles, formatFilesForModel, isSoreTextFile, SORE_FILE_MAX_CHARS, toSoreAttachment } from './attachments';
import { toModelMessages } from './engine';
import type { AssistantMessage } from '../../types';

describe('Sore 文字檔附件', () => {
    it('認得 .css／.txt／.json，不收別的', () => {
        expect(isSoreTextFile({ name: 'theme.CSS' })).toBe(true);
        expect(isSoreTextFile({ name: 'a.txt' })).toBe(true);
        expect(isSoreTextFile({ name: 'preset.json' })).toBe(true);
        expect(isSoreTextFile({ name: 'noext', type: 'text/css' })).toBe(true);
        expect(isSoreTextFile({ name: 'a.zip', type: 'application/zip' })).toBe(false);
    });

    it('Key 換成 [Key]，不截短字串長度以外的內容', () => {
        const key = 'abcdefghijklmnopqrstuvwxyz123456';
        const f = toSoreAttachment('a.txt', `apiKey: "${key}"\n其他 sk-ABCDEFGHIJKLMNOP1234\n.sully-chat-header { color: red; }`, [key]);
        expect(f.text).not.toContain(key);
        expect(f.text).not.toContain('sk-ABCDEFGHIJKLMNOP1234');
        expect(f.text).toContain('.sully-chat-header');
    });

    it('太長就截，記下截過', () => {
        const f = toSoreAttachment('big.css', 'a'.repeat(SORE_FILE_MAX_CHARS + 10));
        expect(f.text.length).toBe(SORE_FILE_MAX_CHARS);
        expect(f.truncated).toBe(true);
        expect(formatFilesForModel([f])).toContain('太長只附了前');
    });

    it('只有最近兩則帶檔案的訊息送全文，更早的只說附了什麼', () => {
        const mk = (id: string, name: string): AssistantMessage => ({ id, role: 'user', text: `看 ${name}`, at: 0, files: [{ name, text: `/* ${name} */\n.x{}` }] });
        const history = [mk('1', 'old.css'), mk('2', 'mid.css'), mk('3', 'new.css')];
        const out = toModelMessages(history).map(m => m.content as string);
        expect(out[0]).toContain(describeOldFiles(history[0].files!));
        expect(out[0]).not.toContain('/* old.css */');
        expect(out[1]).toContain('/* mid.css */');
        expect(out[2]).toContain('【附件：new.css（2 行）】');
    });
});
