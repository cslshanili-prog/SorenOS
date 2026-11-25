import { describe, expect, it } from 'vitest';
import { createTopLevelJsonParser } from './jsonTopLevelStream';

/** 用解析器把文字拆開、再照原樣組回一個物件，跟 JSON.parse 比 */
const reassemble = (text: string, chunkSizes: number[] | number) => {
    const out: Record<string, any> = {};
    const order: string[] = [];
    const parser = createTopLevelJsonParser({
        onArrayStart: key => { out[key] = []; order.push(`[${key}`); },
        onArrayItem: (key, item) => { out[key].push(JSON.parse(item)); },
        onArrayEnd: key => { order.push(`${key}]`); },
        onValue: (key, value) => { out[key] = JSON.parse(value); order.push(key); },
    });
    let at = 0; let n = 0;
    while (at < text.length) {
        const size = typeof chunkSizes === 'number' ? chunkSizes : chunkSizes[n++ % chunkSizes.length];
        parser.push(text.slice(at, at + size));
        at += size;
    }
    parser.end();
    return { out, order };
};

const SAMPLE = {
    timestamp: 1764000000000,
    version: 3,
    ok: true, no: false, nothing: null, negative: -12.5e-3,
    title: '備份 "引號" \\ 反斜線 \n 換行 ☃ 😀 結尾',
    emptyString: '',
    theme: { wallpaper: 'assets/a.png', nested: { list: [1, [2, [3, { deep: '}]{[' }]]], quote: '"' } },
    emptyObject: {},
    emptyArray: [],
    characters: [{ id: 'c1', name: '甲', tags: ['a', 'b'], bio: '有 ] 和 } 和 , 的字' }, { id: 'c2', name: '乙\\"' }],
    messages: Array.from({ length: 50 }, (_, i) => ({ id: i, content: `第 ${i} 則："好"，[嗯] {喔} \\\\`, meta: i % 3 ? null : { a: [i, { b: i }] } })),
    mixed: [1, 'two', null, true, false, -3.5, [4, 5], { six: 6 }, '', '"', ']'],
    'key with "quote" and \\ slash': 'value',
    last: 'end',
};

describe('頂層 JSON 拆解器', () => {
    it('拆開再組回來跟 JSON.parse 一樣：緊湊、縮排、各種切法', () => {
        for (const text of [JSON.stringify(SAMPLE), JSON.stringify(SAMPLE, null, 2), JSON.stringify(SAMPLE, null, '\t')]) {
            for (const sizes of [1, 2, 3, 7, 64, 1000, text.length, [1, 5, 2, 13, 3]]) {
                expect(reassemble(text, sizes).out).toEqual(SAMPLE);
            }
        }
    });

    it('亂數切段跑很多次，結果都一樣', () => {
        const text = JSON.stringify(SAMPLE);
        let seed = 42;
        const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
        for (let run = 0; run < 200; run++) {
            const sizes = Array.from({ length: 17 }, () => 1 + (next() % 40));
            expect(reassemble(text, sizes).out).toEqual(SAMPLE);
        }
    });

    it('頂層欄位的順序照檔案裡的順序吐出來；陣列有開始和結束', () => {
        const { order } = reassemble('{"a":1,"list":[1,2],"b":{"x":[3]},"empty":[]}', 4);
        expect(order).toEqual(['a', '[list', 'list]', 'b', '[empty', 'empty]']);
    });

    it('陣列是一筆一筆吐的，不用等整個陣列讀完', () => {
        const seen: string[] = [];
        const parser = createTopLevelJsonParser({ onArrayItem: (_k, item) => seen.push(item), onValue: () => {} });
        parser.push('{"messages":[{"id":1},{"id":2},');
        expect(seen).toEqual(['{"id":1}', '{"id":2}']);
        parser.push('{"id":3');
        expect(seen).toHaveLength(2);
        parser.push('}]}');
        expect(seen).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
        parser.end();
    });

    it('一筆很大的值（內嵌圖片那種長字串）跨很多段也接得起來', () => {
        const big = 'data:image/png;base64,' + 'QUJD'.repeat(300_000);
        const text = JSON.stringify({ gallery: [{ id: 'g1', src: big }, { id: 'g2', src: big }], wallpaper: big });
        const { out } = reassemble(text, 65_536);
        expect(out.gallery[1].src.length).toBe(big.length);
        expect(out.wallpaper).toBe(big);
    });

    it('空物件、只有空白、前後有空白都可以', () => {
        expect(reassemble('{}', 1).out).toEqual({});
        expect(reassemble('  \n{ }\n ', 2).out).toEqual({});
        expect(reassemble(' { "a" : [ ] , "b" : 1 } ', 3).out).toEqual({ a: [], b: 1 });
    });

    it('最外層不是物件、被截斷、少逗號、結束後還有東西：都報錯', () => {
        expect(() => reassemble('[1,2,3]', 2)).toThrow(/最外層不是物件/);
        expect(() => reassemble('"just a string"', 2)).toThrow(/最外層不是物件/);
        expect(() => reassemble('{"a":[1,2', 3)).toThrow(/沒有收尾/);
        expect(() => reassemble('{"a":"沒關的字串', 3)).toThrow(/沒有收尾/);
        expect(() => reassemble('{"a":{"b":1}', 3)).toThrow(/沒有收尾/);
        expect(() => reassemble('', 3)).toThrow(/沒有收尾/);
        expect(() => reassemble('{"a":1 "b":2}', 3)).toThrow(/少了逗號/);
        expect(() => reassemble('{"a":[1 2]}', 3)).toThrow();
        expect(() => reassemble('{"a":1}{"b":2}', 3)).toThrow(/結束後還有內容/);
        expect(() => reassemble('{a:1}', 3)).toThrow(/雙引號/);
        expect(() => reassemble('{"a" 1}', 3)).toThrow(/冒號/);
    });

    it('一筆的內容壞掉由呼叫端的 JSON.parse 抓到（拆解器只管結構）', () => {
        expect(() => reassemble('{"a":[{"x":tru}]}', 4)).toThrow();
        expect(() => reassemble('{"a":nul}', 4)).toThrow();
    });
});
