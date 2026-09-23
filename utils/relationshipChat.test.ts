import { describe, it, expect } from 'vitest';
import { normName, matchRealChar, clampAffinity, upsertContact, flipTranscript, parseTranscript, serializeTurns, appendLearned, topicText } from './relationshipChat';
import type { PhoneContact } from '../types';

describe('relationshipChat · 純函數', () => {
    it('normName 去括號身份/空白/大小寫', () => {
        expect(normName('阿哲 (社團學長)')).toBe('阿哲');
        expect(normName('  Alice  ')).toBe('alice');
        expect(normName('小明（前任）')).toBe('小明');
    });

    it('matchRealChar 精確 + 包含匹配', () => {
        const roster = [{ id: 'c1', name: '阿哲' }, { id: 'c2', name: 'Bella' }];
        expect(matchRealChar('阿哲', roster)).toBe('c1');
        expect(matchRealChar('阿哲 (學長)', roster)).toBe('c1');
        expect(matchRealChar('學長阿哲', roster)).toBe('c1'); // 包含
        expect(matchRealChar('bella', roster)).toBe('c2');
        expect(matchRealChar('陌生人', roster)).toBeUndefined();
        expect(matchRealChar('', roster)).toBeUndefined();
    });

    it('clampAffinity 鉗制並取整到 -100..100', () => {
        expect(clampAffinity(150)).toBe(100);
        expect(clampAffinity(-150)).toBe(-100);
        expect(clampAffinity(12.6)).toBe(13);
        expect(clampAffinity(NaN)).toBe(0);
    });

    it('upsertContact 新增 / 合併不丟 id 與 createdAt', () => {
        const base: PhoneContact[] = [];
        const added = upsertContact(base, { name: '阿哲', kind: 'real', linkedCharId: 'c1', affinity: 30 });
        expect(added).toHaveLength(1);
        expect(added[0].id).toBeTruthy();
        expect(added[0].affinity).toBe(30);

        const origId = added[0].id;
        const origCreated = added[0].createdAt;
        const merged = upsertContact(added, { name: '阿哲 ', note: '欠我錢', affinity: 50 });
        expect(merged).toHaveLength(1); // 按名字歸一去重
        expect(merged[0].id).toBe(origId);
        expect(merged[0].createdAt).toBe(origCreated);
        expect(merged[0].note).toBe('欠我錢');
        expect(merged[0].affinity).toBe(50);
    });

    it('upsertContact 好感鉗制', () => {
        const r = upsertContact([], { name: 'X', affinity: 999 });
        expect(r[0].affinity).toBe(100);
    });

    it('flipTranscript 翻轉我/對方視角', () => {
        const aDetail = '我: 在嗎\n對方: 在的\n我: 借點錢';
        const flipped = flipTranscript(aDetail);
        expect(flipped).toBe('對方: 在嗎\n我: 在的\n對方: 借點錢');
        // 翻兩次回到原樣
        expect(flipTranscript(flipped)).toBe(aDetail);
    });

    it('parseTranscript 多行消息的續行跟隨上一條說話人（修復錯位）', () => {
        const detail = '我: 第一句\n還有第二句\n對方: 收到\n好的';
        expect(parseTranscript(detail)).toEqual([
            { isMe: true, text: '第一句' },
            { isMe: true, text: '還有第二句' }, // 續行歸「我」，不被誤判給對方
            { isMe: false, text: '收到' },
            { isMe: false, text: '好的' },      // 續行歸「對方」
        ]);
    });

    it('parseTranscript 續寫可指定首行歸屬（修復 NPC 續寫繁殖 char 的話）', () => {
        // 無前綴續寫：上一句是 host(我)→下一句輪到對方，傳 false，整段歸對方
        expect(parseTranscript('收到\n好的', false)).toEqual([
            { isMe: false, text: '收到' }, { isMe: false, text: '好的' },
        ]);
        // 傳 true → 歸我
        expect(parseTranscript('在的\n稍等', true)).toEqual([
            { isMe: true, text: '在的' }, { isMe: true, text: '稍等' },
        ]);
        // 有顯式前綴時前綴優先，default 只管首行無前綴的兜底
        expect(parseTranscript('對方: 嗯\n我: 好', true)).toEqual([
            { isMe: false, text: '嗯' }, { isMe: true, text: '好' },
        ]);
    });

    it('parseTranscript + serializeTurns 續寫無損（修復續寫覆蓋/吞內容）', () => {
        const detail = '我: a\nb\n對方: c';
        // 舊邏輯會丟掉無前綴的「b」，導致續寫時整段替換後內容變短；現在每行都補回前綴
        expect(serializeTurns(parseTranscript(detail))).toBe('我: a\n我: b\n對方: c');
    });

    it('flipTranscript 多行消息也整體翻轉、補全前綴', () => {
        expect(flipTranscript('我: a\nb\n對方: c')).toBe('對方: a\n對方: b\n我: c');
    });

    it('appendLearned 累積/去重/限長', () => {
        expect(appendLearned('', '其實在讀研')).toBe('其實在讀研');
        expect(appendLearned('其實在讀研', '欠房東兩個月房租')).toBe('其實在讀研\n欠房東兩個月房租');
        // 完全相同的不重複加
        expect(appendLearned('其實在讀研', '其實在讀研')).toBe('其實在讀研');
        // 空了解不改動已有
        expect(appendLearned('其實在讀研', '  ')).toBe('其實在讀研');
        // 超過上限只留最近 N 行
        const many = Array.from({ length: 10 }, (_, i) => `事${i}`).join('\n');
        const r = appendLearned(many, '新事', 8).split('\n');
        expect(r).toHaveLength(8);
        expect(r[r.length - 1]).toBe('新事');
        expect(r[0]).toBe('事3'); // 最早的事0~事2 被擠掉
    });

    it('topicText 拼接/過濾空/限最近 N 條', () => {
        expect(topicText(undefined)).toBe('');
        expect(topicText([])).toBe('');
        const box = [
            { id: '1', text: '聊了借錢', createdAt: 1 },
            { id: '2', text: '  ', createdAt: 2 },     // 空白過濾
            { id: '3', text: '和好了', createdAt: 3 },
        ];
        expect(topicText(box)).toBe('· 聊了借錢\n· 和好了');
        // 只取最近 N 條
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, text: `t${i}`, createdAt: i }));
        const out = topicText(many, 3).split('\n');
        expect(out).toEqual(['· t9', '· t10', '· t11']);
    });

    it('upsertContact 不用 undefined 抹掉已有字段，且保留已有非空備註', () => {
        const seed = upsertContact([], { name: '阿哲', kind: 'real', linkedCharId: 'c1', note: '欠我錢', identity: '同事', affinity: 30 });
        // 再次 upsert（如掃描/對話回填）不帶 note/identity：不得清空
        const after = upsertContact(seed, { name: '阿哲', kind: 'real', affinity: 40 });
        expect(after[0].note).toBe('欠我錢');
        expect(after[0].identity).toBe('同事');
        expect(after[0].affinity).toBe(40);
        // 即便帶了新的 note，也不覆蓋用戶已寫的非空備註（顯式編輯走 UI 不經此函數）
        const after2 = upsertContact(seed, { name: '阿哲', note: 'AI 瞎編的備註' });
        expect(after2[0].note).toBe('欠我錢');
    });

    it('upsertContact 不覆蓋用戶手動確認的備註名，包括明確留空', () => {
        const automatic = upsertContact([], { name: '小林', identity: '同事' });
        expect(upsertContact(automatic, { name: '小林', identity: '學長' })[0].identity).toBe('學長');

        const manual = upsertContact([], {
            name: '阿哲', kind: 'real', linkedCharId: 'c1', identity: '學長', identityManual: true,
        });
        const after = upsertContact(manual, { name: '阿哲', identity: '機主名字' });
        expect(after[0].identity).toBe('學長');
        expect(after[0].identityManual).toBe(true);

        const cleared = [{ ...manual[0], identity: undefined, identityManual: true }];
        const afterCleared = upsertContact(cleared, { name: '阿哲', identity: '同事' });
        expect(afterCleared[0].identity).toBeUndefined();
        expect(afterCleared[0].identityManual).toBe(true);
    });
});
