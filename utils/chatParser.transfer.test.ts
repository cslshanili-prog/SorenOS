import { describe, expect, it } from 'vitest';
import { extractTransferCommands } from './transferFormat';

// 本文件原為 master 上 chatParser.extractAssistantTransfers 的測試。合併時那份實現被
// utils/transferFormat.ts:extractTransferCommands 取代 (與 worker classifier 共用一份源碼,
// 額外覆蓋 kv 形態 / [[記錄:]] 冪等哨兵 / 收退回執 / 方向校驗), 其能力 (全角括號【】/
// 主語「我」/ credits 後綴) 已併入。這裡逐條保留原測試的行為斷言, 改打新入口。

const sendAmounts = (input: string) =>
    extractTransferCommands(input).events.flatMap(e => (e.kind === 'send' ? [e.amount] : []));

describe('extractTransferCommands — 承接 extractAssistantTransfers 的行為', () => {
    it('keeps supporting the canonical action format', () => {
        const r = extractTransferCommands('給你。\n[[ACTION:TRANSFER:520]]');
        expect(r.text).toBe('給你。');
        expect(sendAmounts('給你。\n[[ACTION:TRANSFER:520]]')).toEqual(['520']);
    });

    it('tolerates full-width punctuation, currency symbols and decimals', () => {
        const input = '[[ ACTION：TRANSFER：￥1,999.50 元 ]]';
        const r = extractTransferCommands(input);
        expect(r.text).toBe('');
        // 金額歸一化: 1,999.50 → 1999.5 (原實現保留尾零 '1999.50'; 數值等價,
        // formatTransferAmount 整數去點、非整數保兩位, 與 metadata.amount 的既有形態一致)
        expect(sendAmounts(input)).toEqual(['1999.5']);
    });

    it('recovers a transfer when the model imitates a system log', () => {
        const r1 = extractTransferCommands('拿著。\n[系統: 你向小魚轉帳 1999]');
        expect(r1.text).toBe('拿著。');
        expect(sendAmounts('拿著。\n[系統: 你向小魚轉帳 1999]')).toEqual(['1999']);

        // 全角括號 + 主語「我」(角色以第一人稱說話): 同樣是合法轉帳
        const r2 = extractTransferCommands('【系統：我向你轉帳￥520元】');
        expect(r2.text).toBe('');
        expect(sendAmounts('【系統：我向你轉帳￥520元】')).toEqual(['520']);
    });

    it('does not turn an incoming user transfer log into an outgoing transfer', () => {
        // 原實現把這行原樣留在正文裡; 我們更進一步: 整塊消費掉且零事件 —— 這是歷史 leak,
        // 落進氣泡就是用戶反饋的原樣復現 (sanitize 終線同樣會剝, 這裡在解析層就攔掉)。
        const incoming = '[系統: 用戶向你轉帳 1999]';
        const r = extractTransferCommands(incoming);
        expect(r.events).toEqual([]);
        expect(r.consumed).toBe(1);
        expect(r.text).toBe('');
    });

    it('extracts multiple transfers and ignores zero-value actions', () => {
        const input = '[[ACTION:TRANSFER:520]]\n[[ACTION:TRANSFER:0]]\n[[ACTION:TRANSFER:1314]]';
        const r = extractTransferCommands(input);
        expect(r.text).toBe('');
        expect(sendAmounts(input)).toEqual(['520', '1314']);
    });

    it('credits 後綴同樣解析 (原 CANONICAL_TRANSFER_RE 允許)', () => {
        expect(sendAmounts('[[ACTION:TRANSFER:520 credits]]')).toEqual(['520']);
    });
});
