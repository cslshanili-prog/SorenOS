import { describe, it, expect } from 'vitest';
import { extractMallOrderCommands, formatMallOrderRecord } from './mallOrderFormat';

describe('formatMallOrderRecord', () => {
    it('按 kind/mode/items/amount/status 拼出记录行', () => {
        const line = formatMallOrderRecord({
            kind: 'food', mode: 'daifu', items: [{ name: '简餐套餐', qty: 1 }], amount: 32, status: 'pending',
        });
        expect(line).toBe('[[记录:MALL|kind=food|mode=daifu|items=简餐套餐x1|amount=32|status=待处理]]');
    });

    it('多件商品用顿号拼接', () => {
        const line = formatMallOrderRecord({
            kind: 'shop', mode: 'gift', items: [{ name: 'A', qty: 2 }, { name: 'B', qty: 1 }], amount: 99, status: 'sent',
        });
        expect(line).toContain('items=Ax2、Bx1');
    });
});

describe('extractMallOrderCommands', () => {
    it('[[ACTION:DAIFU_ACCEPT]] 解析出 accept 事件', () => {
        const r = extractMallOrderCommands('行，这顿我请了。[[ACTION:DAIFU_ACCEPT]]');
        expect(r.events).toEqual([{ kind: 'accept' }]);
        expect(r.text).toBe('行，这顿我请了。');
    });

    it('[[ACTION:DAIFU_DECLINE|reason=...]] 解析出 decline 事件 + 原因', () => {
        const r = extractMallOrderCommands('不行。[[ACTION:DAIFU_DECLINE|reason=说好的减肥呢]]');
        expect(r.events).toEqual([{ kind: 'decline', reason: '说好的减肥呢' }]);
    });

    it('DAIFU_DECLINE 不带 reason 时 reason 为 undefined', () => {
        const r = extractMallOrderCommands('[[ACTION:DAIFU_DECLINE]]');
        expect(r.events).toEqual([{ kind: 'decline', reason: undefined }]);
    });

    it('[[记录:MALL|...]] 是幂等哨兵：只消费不产生事件', () => {
        const r = extractMallOrderCommands('[[记录:MALL|kind=food|mode=daifu|items=简餐套餐x1|amount=32|status=待处理]] 我看看这单', );
        expect(r.events).toEqual([]);
        expect(r.text).toBe('我看看这单');
        expect(r.consumed).toBe(1);
    });

    it('没有任何标签时原样返回、零事件', () => {
        const r = extractMallOrderCommands('今天天气不错');
        expect(r.events).toEqual([]);
        expect(r.text).toBe('今天天气不错');
        expect(r.consumed).toBe(0);
    });

    it('空字符串输入不崩', () => {
        expect(extractMallOrderCommands('')).toEqual({ text: '', events: [], consumed: 0 });
    });
});
