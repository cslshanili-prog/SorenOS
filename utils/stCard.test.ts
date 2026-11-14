import { describe, expect, it } from 'vitest';
import { cardToSoren, characterBookToWorldInfo, extractCardJsonFromPng, normalizeStCard, parseStCardFile, readPngTextChunks } from './stCard';

const enc = new TextEncoder();
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: Uint8Array) => [...u32(data.length), ...enc.encode(type), ...data, 0, 0, 0, 0];
const latin = (s: string) => Uint8Array.from([...s].map(c => c.charCodeAt(0)));
const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));
/** 假 PNG：簽名＋IHDR＋文字區塊＋IEND（讀卡不驗 CRC，也不解圖） */
const fakePng = (texts: Record<string, string>) => Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', new Uint8Array(13)),
    ...Object.entries(texts).flatMap(([k, v]) => chunk('tEXt', latin(`${k}\0${v}`))),
    ...chunk('IEND', new Uint8Array(0)),
]);

const V2 = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: '段司宴', description: '{{char}} 是天馳資本的合夥人。', personality: '冷淡、克制。', scenario: '海城，六月。',
        first_mes: '「坐。」', alternate_greetings: ['「下車。」', ''], mes_example: '<START>\n{{user}}: 你好\n{{char}}: 嗯。',
        system_prompt: '{{original}}\n用第三人稱寫。', post_history_instructions: '', creator_notes: '作者的話', creator: 'someone', tags: ['都市', '豪門', '冷淡'],
        character_book: { name: '海城', entries: [
            { keys: ['天馳'], content: '天馳資本是一家投資公司。', enabled: true, insertion_order: 10, position: 'before_char', comment: '公司' },
            { keys: [], content: '常駐的設定', constant: true, enabled: false, extensions: { position: 4, depth: 2, role: 1 } },
        ] },
        extensions: { depth_prompt: { prompt: '記得他戴眼鏡。', depth: 3, role: 'system' } },
    },
};

describe('ST 角色卡', () => {
    it('PNG：chara（V2）和 ccv3（V3 優先）', () => {
        const png = fakePng({ chara: b64(JSON.stringify(V2)) });
        expect(readPngTextChunks(png).chara).toBeTruthy();
        expect(extractCardJsonFromPng(png).data.name).toBe('段司宴');
        const both = fakePng({ chara: b64(JSON.stringify(V2)), ccv3: b64(JSON.stringify({ ...V2, spec: 'chara_card_v3', data: { ...V2.data, name: 'V3 的名字' } })) });
        const card = parseStCardFile(both);
        expect(card).toMatchObject({ spec: 'v3', name: 'V3 的名字' });
        expect(() => parseStCardFile(fakePng({ Comment: 'hi' }))).toThrow('沒有角色卡資料');
    });

    it('JSON：V2 和沒有 spec 的 V1', () => {
        const v2 = parseStCardFile(enc.encode(JSON.stringify(V2)));
        expect(v2).toMatchObject({ spec: 'v2', name: '段司宴', alternateGreetings: ['「下車。」'], tags: ['都市', '豪門', '冷淡'] });
        expect(v2.depthPrompt).toEqual({ prompt: '記得他戴眼鏡。', depth: 3, role: 'system' });
        const v1 = normalizeStCard({ name: '小萌', description: '經紀人', first_mes: '哎～', mes_example: '' });
        expect(v1).toMatchObject({ spec: 'v1', name: '小萌', firstMes: '哎～' });
        expect(() => normalizeStCard({ description: 'x' })).toThrow('沒有名字');
        expect(() => parseStCardFile(enc.encode('not json'))).toThrow();
    });

    it('卡內世界書轉成 ST 世界書檔的條目', () => {
        const wi = characterBookToWorldInfo(V2.data.character_book.entries);
        expect(wi.entries[0]).toMatchObject({ key: ['天馳'], content: '天馳資本是一家投資公司。', order: 10, position: 0, disable: false, comment: '公司' });
        expect(wi.entries[1]).toMatchObject({ constant: true, disable: true, position: 4, depth: 2, role: 1 });
    });

    it('對到 Soren：人設、開場白、大綱、範例、世界書＋深度提示', () => {
        const { fields, worldbooks } = cardToSoren(normalizeStCard(V2), 1000);
        expect(fields.name).toBe('段司宴');
        expect(fields.systemPrompt).toContain('{{char}} 是天馳資本的合夥人。');
        expect(fields.systemPrompt).toContain('冷淡、克制。');
        expect(fields.systemPrompt).toContain('【角色卡附帶的系統提示】\n用第三人稱寫。');
        expect(fields.systemPrompt).not.toContain('{{original}}');
        expect(fields.dateScenario).toBe('海城，六月。');
        expect(fields.dateGreetings!.map(g => g.text)).toEqual(['「坐。」', '「下車。」']);
        expect(fields.dialogueExamples).toContain('<START>');
        expect(fields.description).toBe('都市 · 豪門 · 冷淡');
        expect(worldbooks).toHaveLength(3);
        expect(worldbooks.every(b => b.category === '海城')).toBe(true);
        expect(worldbooks[0]).toMatchObject({ title: '公司', key: ['天馳'], position: 0 });
        expect(worldbooks[2]).toMatchObject({ title: '角色卡的深度提示', constant: true, position: 4, depth: 3, role: 0 });
    });

    it('沒有世界書、沒有開場白也能匯', () => {
        const { fields, worldbooks } = cardToSoren(normalizeStCard({ name: 'A', description: 'B' }));
        expect(worldbooks).toEqual([]);
        expect(fields.dateGreetings).toBeUndefined();
        expect(fields.systemPrompt).toBe('B');
    });
});
