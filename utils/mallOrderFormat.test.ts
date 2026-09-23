import { describe, it, expect } from 'vitest';
import { extractMallOrderCommands, formatMallOrderRecord } from './mallOrderFormat';

describe('formatMallOrderRecord', () => {
    it('按 kind/mode/items/amount/status 拼出記錄行', () => {
        const line = formatMallOrderRecord({
            kind: 'food', mode: 'daifu', items: [{ name: '簡餐套餐', qty: 1 }], amount: 32, status: 'pending',
        });
        expect(line).toBe('[[記錄:MALL|kind=food|mode=daifu|items=簡餐套餐x1|amount=32|status=待處理]]');
    });

    it('多件商品用頓號拼接', () => {
        const line = formatMallOrderRecord({
            kind: 'shop', mode: 'gift', items: [{ name: 'A', qty: 2 }, { name: 'B', qty: 1 }], amount: 99, status: 'sent',
        });
        expect(line).toContain('items=Ax2、Bx1');
    });
});

describe('extractMallOrderCommands · GIFT（角色主動送禮）', () => {
    it('[[ACTION:GIFT|item=|price=|note=]] 解析出 send 事件', () => {
        const r = extractMallOrderCommands('給你帶了個小禮物~[[ACTION:GIFT|item=草莓蛋糕|price=23|note=路過甜品店順手買的]]');
        expect(r.events).toEqual([{ kind: 'send', item: '草莓蛋糕', price: '23', note: '路過甜品店順手買的' }]);
        expect(r.text).toBe('給你帶了個小禮物~');
    });

    it('沒有 note 時 note 為 undefined', () => {
        const r = extractMallOrderCommands('[[ACTION:GIFT|item=咖啡|price=18]]');
        expect(r.events).toEqual([{ kind: 'send', item: '咖啡', price: '18', note: undefined }]);
    });

    it('缺 item 或 price 時當無效標籤剝掉、不產生事件', () => {
        expect(extractMallOrderCommands('[[ACTION:GIFT|price=18]]').events).toEqual([]);
        expect(extractMallOrderCommands('[[ACTION:GIFT|item=咖啡]]').events).toEqual([]);
    });

    it('price 不是純數字時當無效標籤剝掉、不產生事件', () => {
        const r = extractMallOrderCommands('[[ACTION:GIFT|item=咖啡|price=十八元]]');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('');
    });
});

describe('extractMallOrderCommands', () => {
    it('[[ACTION:DAIFU_ACCEPT]] 解析出 accept 事件', () => {
        const r = extractMallOrderCommands('行，這頓我請了。[[ACTION:DAIFU_ACCEPT]]');
        expect(r.events).toEqual([{ kind: 'accept' }]);
        expect(r.text).toBe('行，這頓我請了。');
    });

    it('[[ACTION:DAIFU_DECLINE|reason=...]] 解析出 decline 事件 + 原因', () => {
        const r = extractMallOrderCommands('不行。[[ACTION:DAIFU_DECLINE|reason=說好的減肥呢]]');
        expect(r.events).toEqual([{ kind: 'decline', reason: '說好的減肥呢' }]);
    });

    it('DAIFU_DECLINE 不帶 reason 時 reason 為 undefined', () => {
        const r = extractMallOrderCommands('[[ACTION:DAIFU_DECLINE]]');
        expect(r.events).toEqual([{ kind: 'decline', reason: undefined }]);
    });

    it('[[記錄:MALL|...]] 是冪等哨兵：只消費不產生事件', () => {
        const r = extractMallOrderCommands('[[記錄:MALL|kind=food|mode=daifu|items=簡餐套餐x1|amount=32|status=待處理]] 我看看這單', );
        expect(r.events).toEqual([]);
        expect(r.text).toBe('我看看這單');
        expect(r.consumed).toBe(1);
    });

    it('沒有任何標籤時原樣返回、零事件', () => {
        const r = extractMallOrderCommands('今天天氣不錯');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('今天天氣不錯');
        expect(r.consumed).toBe(0);
    });

    it('空字符串輸入不崩', () => {
        expect(extractMallOrderCommands('')).toEqual({ text: '', events: [], consumed: 0 });
    });
});
