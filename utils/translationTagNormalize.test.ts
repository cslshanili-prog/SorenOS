import { describe, it, expect } from 'vitest';
import { normalizeTranslationTags, sanitizeForBubble, sanitizeForNotification, sanitizeIntoSegments } from './sanitize';

// applyAssistantPostProcessing Step 8 的嚴格雙語判定/拆泡正則 (utils/applyAssistantPostProcessing.ts)。
// 自愈的目標就是讓掉格式輸出重新命中它 —— 這裡用同一條正則做端到端斷言。
const STEP8_RE = /<翻[译譯]>\s*<原文>[\s\S]*?<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/;
const CANON = (a: string, b: string) => `<翻譯><原文>${a}</原文><譯文>${b}</譯文></翻譯>`;

describe('normalizeTranslationTags', () => {
    it('無翻譯標籤的文本原樣返回 (fast path)', () => {
        expect(normalizeTranslationTags('普通聊天文本，沒有任何標籤')).toBe('普通聊天文本，沒有任何標籤');
        expect(normalizeTranslationTags('原文和譯文這兩個詞本身不該被動')).toBe('原文和譯文這兩個詞本身不該被動');
    });

    it('規範塊冪等：完整格式不被改壞', () => {
        const s = CANON('你好！', 'こんにちは！') + CANON('今天做什麼？', '今日は何する？');
        expect(normalizeTranslationTags(s)).toBe(s);
    });

    // ─── 截圖報告形態 ───

    it('尾部截斷 `</譯文` (少寫 > 且丟 </翻譯>) → 補全成規範塊', () => {
        const s = '<翻譯><原文>如果硬撐著一整天不睡，胃也會難受的。</原文><譯文>丸一日無理して起きてたら、胃もキリキリ痛くなっちゃうよ。</譯文';
        const out = normalizeTranslationTags(s);
        expect(out).toBe(CANON('如果硬撐著一整天不睡，胃也會難受的。', '丸一日無理して起きてたら、胃もキリキリ痛くなっちゃうよ。'));
        expect(STEP8_RE.test(out)).toBe(true);
    });

    it('全裸文本只剩孤兒 `</譯文` 殘尾 → 剝乾淨，正文保留', () => {
        const s = '如果硬撐著一整天不睡，胃也會難受的。\n丸一日無理して起きてたら、胃もキリキリ痛くなっちゃうよ。</譯文';
        const out = normalizeTranslationTags(s);
        expect(out).not.toMatch(/[<＜]/);
        expect(out).toContain('胃也會難受的。');
        expect(out).toContain('痛くなっちゃうよ。');
    });

    // ─── 結構掉格式 ───

    it('缺外層 <翻譯> 包裹 → 補齊', () => {
        const out = normalizeTranslationTags('<原文>你好！</原文>\n<譯文>こんにちは！</譯文>');
        expect(out).toBe(CANON('你好！', 'こんにちは！'));
    });

    it('缺 </翻譯> 閉合 → 補齊', () => {
        const out = normalizeTranslationTags('<翻譯><原文>你好！</原文><譯文>こんにちは！</譯文>');
        expect(out).toBe(CANON('你好！', 'こんにちは！'));
    });

    it('sibling 幻覺形態 <翻譯>X</翻譯><譯文>Y</譯文> → 規範塊', () => {
        const out = normalizeTranslationTags('<翻譯>你好！</翻譯><譯文>こんにちは！</譯文>');
        expect(out).toBe(CANON('你好！', 'こんにちは！'));
    });

    it('譯文塊未閉合 (流截斷) → 末尾補閉合再規範化', () => {
        const out = normalizeTranslationTags('<翻譯><原文>你好！</原文><譯文>こんにちは！');
        expect(out).toBe(CANON('你好！', 'こんにちは！'));
    });

    it('多句混合：規範塊 + 掉格式塊同現，各自修好', () => {
        const s = CANON('你好！', 'こんにちは！') + '\n<原文>今天做什麼？</原文><譯文>今日は何する？</譯文';
        const out = normalizeTranslationTags(s);
        expect(out).toContain(CANON('你好！', 'こんにちは！'));
        expect(out).toContain(CANON('今天做什麼？', '今日は何する？'));
    });

    // ─── 字形掉格式 ───

    it('全角尖括號 / 全角斜槓 / 標籤內空格 → 規範半角', () => {
        const out = normalizeTranslationTags('＜翻譯＞＜原文＞你好！＜／原文＞< 譯文 >こんにちは！</ 譯文 >＜/翻譯＞');
        expect(out).toBe(CANON('你好！', 'こんにちは！'));
    });

    it('簡繁互換 譯文/翻譯 → 規範簡體', () => {
        const out = normalizeTranslationTags('<翻譯><原文>你好！</原文><譯文>こんにちは！</譯文></翻譯>');
        expect(out).toBe(CANON('你好！', 'こんにちは！'));
    });

    // ─── 兜底不變量 ───

    it('孤兒閉合 / 配不成對的標籤一律剝除，絕不漏給用戶', () => {
        expect(normalizeTranslationTags('前面</翻譯>後面')).toBe('前面後面');
        // 配不成對的 <譯文> 整塊 = 重複的目標語內容，按 extractTranslationOriginal 既有策略丟棄
        expect(normalizeTranslationTags('只有譯文塊<譯文>こんにちは！</譯文>')).toBe('只有譯文塊');
    });

    it('規範多行塊（標籤間帶換行）原樣保留，不被壓扁', () => {
        const s = '<翻譯>\n<原文>Wait... seriously?</原文>\n<譯文>等等…？</譯文>\n</翻譯>';
        expect(normalizeTranslationTags(s)).toBe(s);
    });

    it('自愈後不變量：除規範塊外無任何翻譯標籤殘留', () => {
        const messy = '碎片</譯文\n<翻譯>半個塊<譯文>訳</譯文>\n＜原文 正文繼續';
        const out = normalizeTranslationTags(messy);
        const rest = out.replace(/<翻[译譯]><原文>[\s\S]*?<\/原文><[译譯]文>[\s\S]*?<\/[译譯]文><\/翻[译譯]>/g, '');
        expect(rest).not.toMatch(/[<＜]\s*[/／]?\s*(?:翻[译譯譯]|原文|[译譯譯]文)/);
    });

    it('冪等：修復結果再跑一遍不變', () => {
        const once = normalizeTranslationTags('<原文>你好！</原文><譯文>こんにちは！</譯文');
        expect(normalizeTranslationTags(once)).toBe(once);
    });
});

describe('facade 集成', () => {
    it('sanitizeForBubble：掉格式輸出修回 Step 8 可命中的規範塊', () => {
        const out = sanitizeForBubble('<翻譯><原文>早上好</原文><譯文>おはよう</譯文');
        expect(STEP8_RE.test(out)).toBe(true);
    });

    it('sanitizeForNotification：掉格式塊也能提取原文進 banner', () => {
        const out = sanitizeForNotification('<原文>早上好</原文><譯文>おはよう</譯文>');
        expect(out).toBe('早上好');
    });

    it('sanitizeIntoSegments：修復後整塊被 Phase 1.5 原子保護，banner 預覽取原文', () => {
        const segs = sanitizeIntoSegments('<翻譯><原文>早上好</原文><譯文>おはよう</譯文');
        expect(segs).toHaveLength(1);
        expect(STEP8_RE.test(segs[0].raw)).toBe(true);
        expect(segs[0].sanitized).toBe('早上好');
    });
});
