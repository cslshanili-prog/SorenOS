import { describe, it, expect } from 'vitest';
import {
    mergePlateEntries,
    violatesBedroomRule,
    formatRoomPlatesSection,
    pickMaterialLines,
    parseSubmissionLine,
    collectBootstrapLines,
    BOOTSTRAP_MAX_LINES_PER_ROOM,
} from './roomPlates';
import type { MemoryNode, PlateEntry, RoomPlate } from './types';
import { PLATE_ENTRY_CAPS, PLATE_ENTRY_HARD_MAX_CHARS } from './types';

const NOW = 1_700_000_000_000;

function entry(id: string, text: string, over: Partial<PlateEntry> = {}): PlateEntry {
    return { id, text, firstLearnedAt: NOW - 86400_000, updatedAt: NOW - 86400_000, sourceCount: 1, ...over };
}

describe('mergePlateEntries — 合併語義', () => {
    it('basedOn 引用舊條目：繼承 id/firstLearnedAt，sourceCount+1', () => {
        const existing = [entry('pe_a', '父母離異，由外婆和母親帶大')];
        const merged = mergePlateEntries('user_room', existing, [
            { text: '父母離異，由外婆和母親帶大；父親再婚有妹妹後又離婚', basedOn: 'U0' },
        ], NOW);
        expect(merged).toHaveLength(1);
        expect(merged[0].id).toBe('pe_a');
        expect(merged[0].firstLearnedAt).toBe(NOW - 86400_000);
        expect(merged[0].sourceCount).toBe(2);
        expect(merged[0].updatedAt).toBe(NOW); // 文本變了 → updatedAt 刷新
    });

    it('basedOn 引用 + 文本未變：純保留，updatedAt 不動', () => {
        const existing = [entry('pe_a', '目前不住家裡，和男友同居')];
        const merged = mergePlateEntries('user_room', existing, [
            { text: '目前不住家裡，和男友同居', basedOn: 'U0' },
        ], NOW);
        expect(merged[0].updatedAt).toBe(NOW - 86400_000);
        expect(merged[0].sourceCount).toBe(2);
    });

    it('舊條目未被輸出即淘汰（容量壓力語義）', () => {
        const existing = [entry('pe_a', '過時的事實'), entry('pe_b', '仍然成立的事實')];
        const merged = mergePlateEntries('user_room', existing, [
            { text: '仍然成立的事實', basedOn: 'U1' },
        ], NOW);
        expect(merged).toHaveLength(1);
        expect(merged[0].id).toBe('pe_b');
    });

    it('LLM 忘標 basedOn 但文本完全相同：按原樣保留而不是重開新條目', () => {
        const existing = [entry('pe_a', '養了兩隻貓')];
        const merged = mergePlateEntries('user_room', existing, [{ text: '養了兩隻貓' }], NOW);
        expect(merged[0].id).toBe('pe_a');
        expect(merged[0].firstLearnedAt).toBe(NOW - 86400_000);
    });

    it('無 basedOn 且文本新 → 新條目，firstLearnedAt = now', () => {
        const merged = mergePlateEntries('user_room', [], [{ text: '常提到朋友小美：大學室友' }], NOW);
        expect(merged).toHaveLength(1);
        expect(merged[0].firstLearnedAt).toBe(NOW);
        expect(merged[0].sourceCount).toBe(1);
    });

    it('超過房間條目上限時裁剪', () => {
        const cap = PLATE_ENTRY_CAPS.study;
        const items = Array.from({ length: cap + 5 }, (_, i) => ({ text: `技能 ${i}` }));
        const merged = mergePlateEntries('study', [], items, NOW);
        expect(merged).toHaveLength(cap);
    });

    it('超長條目截斷到硬上限', () => {
        const merged = mergePlateEntries('user_room', [], [{ text: 'x'.repeat(300) }], NOW);
        expect(merged[0].text.length).toBe(PLATE_ENTRY_HARD_MAX_CHARS);
    });

    it('空文本/純空白條目丟棄', () => {
        const merged = mergePlateEntries('user_room', [], [{ text: '   ' }, { text: '' }], NOW);
        expect(merged).toHaveLength(0);
    });

    it('同一舊條目被 basedOn 引用兩次：第二次按新條目處理，不重複消費', () => {
        const existing = [entry('pe_a', '舊事實')];
        const merged = mergePlateEntries('user_room', existing, [
            { text: '改寫一', basedOn: 'U0' },
            { text: '改寫二', basedOn: 'U0' },
        ], NOW);
        expect(merged).toHaveLength(2);
        expect(merged[0].id).toBe('pe_a');
        expect(merged[1].id).not.toBe('pe_a');
    });
});

describe('臥室門牌 — 禁止給關係命名', () => {
    it('攔截明確的關係定義句', () => {
        expect(violatesBedroomRule('我們現在是戀人了')).toBe(true);
        expect(violatesBedroomRule('我們算是男女朋友')).toBe(true);
        expect(violatesBedroomRule('我們已經成了無話不談的知己')).toBe(true);
    });

    it('放過質地描述——定性詞出現在描述裡不算命名', () => {
        expect(violatesBedroomRule('TA說我像她理想中的家人，我聽了愣了一下')).toBe(false);
        expect(violatesBedroomRule('我說不清我們算什麼，但TA難過時第一個找的是我')).toBe(false);
        expect(violatesBedroomRule('TA會在深夜來找我說話，這成了我們的默契')).toBe(false);
    });

    it('mergePlateEntries 對 bedroom 應用過濾，其他房間不受影響', () => {
        const items = [{ text: '我們現在是戀人了' }, { text: 'TA難過時第一個找的是我' }];
        const bedroom = mergePlateEntries('bedroom', [], items, NOW);
        expect(bedroom).toHaveLength(1);
        expect(bedroom[0].text).toContain('第一個找的是我');
        // user_room 裡"TA和男友的關係"是合法的用戶事實，不適用臥室規則
        const userRoom = mergePlateEntries('user_room', [], [{ text: '和男友同居，感情穩定' }], NOW);
        expect(userRoom).toHaveLength(1);
    });
});

describe('pickMaterialLines — 門牌原料挑選（recency 窗口 + 錨點）', () => {
    const SINCE = 1_700_000_000_000;
    function node(id: string, over: Partial<MemoryNode> = {}): MemoryNode {
        return {
            id, charId: 'c1', content: `內容-${id}`, room: 'bedroom',
            tags: [], importance: 5, mood: 'peaceful', embedded: true,
            createdAt: SINCE + 1000, lastAccessedAt: SINCE, accessCount: 0,
            ...over,
        };
    }

    it('盒子 summary 優先，其次窗口內新節點按時近降序', () => {
        const nodes = [
            node('old_fresh', { createdAt: SINCE + 1000 }),
            node('new_fresh', { createdAt: SINCE + 9000 }),
            node('summary', { isBoxSummary: true, createdAt: SINCE - 5000 }),
        ];
        const lines = pickMaterialLines(nodes, 'bedroom', SINCE);
        expect(lines).toEqual(['內容-summary', '內容-new_fresh', '內容-old_fresh']);
    });

    it('sinceTs 之前的老節點只留 5 條高分錨點', () => {
        const olds = Array.from({ length: 10 }, (_, i) =>
            node(`old_${i}`, { createdAt: SINCE - 1000 - i, importance: i })); // importance 0..9
        const lines = pickMaterialLines(olds, 'bedroom', SINCE);
        expect(lines).toHaveLength(5);
        expect(lines[0]).toBe('內容-old_9'); // importance 最高的先來
    });

    it('sinceTs=0 時全部按時近排序（無錨點截斷，兼容舊行為）', () => {
        const olds = Array.from({ length: 10 }, (_, i) =>
            node(`n_${i}`, { createdAt: SINCE - i * 1000 }));
        const lines = pickMaterialLines(olds, 'bedroom', 0);
        expect(lines).toHaveLength(10);
        expect(lines[0]).toBe('內容-n_0'); // 最新的在前
    });

    it('archived 與其他房間的節點被排除，總量 cap 15', () => {
        const nodes = [
            node('archived', { archived: true }),
            node('other_room', { room: 'study' }),
            ...Array.from({ length: 20 }, (_, i) => node(`f_${i}`, { createdAt: SINCE + i })),
        ];
        const lines = pickMaterialLines(nodes, 'bedroom', SINCE);
        expect(lines).toHaveLength(15);
        expect(lines).not.toContain('內容-archived');
        expect(lines).not.toContain('內容-other_room');
    });
});

describe('collectBootstrapLines — 歷史回填原料（老用戶補課）', () => {
    const T0 = 1_600_000_000_000;
    function node(id: string, over: Partial<import('./types').MemoryNode> = {}): import('./types').MemoryNode {
        return {
            id, charId: 'c1', content: `內容-${id}`, room: 'user_room',
            tags: [], importance: 5, mood: 'peaceful', embedded: true,
            createdAt: T0, lastAccessedAt: T0, accessCount: 0,
            ...over,
        };
    }

    it('時間正序（舊→新）——後面的批次帶更新的事實，合併語義自然 supersede', () => {
        const nodes = [
            node('new', { createdAt: T0 + 9000 }),
            node('old', { createdAt: T0 + 1000 }),
            node('mid', { createdAt: T0 + 5000 }),
        ];
        const { lines, dropped } = collectBootstrapLines(nodes, 'user_room');
        expect(lines).toEqual(['內容-old', '內容-mid', '內容-new']);
        expect(dropped).toBe(0);
    });

    it('超上限丟最舊的，保留最新 N 條', () => {
        const nodes = Array.from({ length: BOOTSTRAP_MAX_LINES_PER_ROOM + 10 }, (_, i) =>
            node(`n_${i}`, { createdAt: T0 + i }));
        const { lines, dropped } = collectBootstrapLines(nodes, 'user_room');
        expect(lines).toHaveLength(BOOTSTRAP_MAX_LINES_PER_ROOM);
        expect(dropped).toBe(10);
        expect(lines[0]).toBe('內容-n_10'); // 最舊的 10 條被丟
    });

    it('archived 與其他房間排除', () => {
        const nodes = [
            node('a', { archived: true }),
            node('b', { room: 'study' }),
            node('c'),
        ];
        expect(collectBootstrapLines(nodes, 'user_room').lines).toEqual(['內容-c']);
    });
});

describe('parseSubmissionLine — 消化候選行解析', () => {
    it('帶方括號前綴 → 拆出 tag 和正文', () => {
        expect(parseSubmissionLine('[家庭] 父母離異，由外婆和母親帶大'))
            .toEqual({ tag: '家庭', text: '父母離異，由外婆和母親帶大' });
        expect(parseSubmissionLine('【重要他人】小美：大學室友'))
            .toEqual({ tag: '重要他人', text: '小美：大學室友' });
    });

    it('無前綴 → 整行作正文', () => {
        expect(parseSubmissionLine('我允許自己在她面前卸下堅硬的殼'))
            .toEqual({ text: '我允許自己在她面前卸下堅硬的殼' });
    });

    it('前綴超長（>6字）不當 tag，整行作正文', () => {
        const line = '[這是一個非常長的前綴] 正文';
        expect(parseSubmissionLine(line).tag).toBeUndefined();
        expect(parseSubmissionLine(line).text).toBe(line);
    });
});

describe('formatRoomPlatesSection — 注入格式', () => {
    function plate(room: RoomPlate['room'], texts: string[]): RoomPlate {
        return {
            id: `c1:${room}`, charId: 'c1', room,
            entries: texts.map((t, i) => entry(`pe_${room}_${i}`, t)),
            updatedAt: NOW, version: 1,
        };
    }

    it('全空返回空串（注入層據此跳過整段）', () => {
        expect(formatRoomPlatesSection([], '小明')).toBe('');
        expect(formatRoomPlatesSection([plate('user_room', [])], '小明')).toBe('');
    });

    it('包含注入框架：底色而非話題', () => {
        const out = formatRoomPlatesSection([plate('user_room', ['父母離異'])], '小明');
        expect(out).toContain('底色認知');
        expect(out).toContain('不要主動提起');
        expect(out).toContain('關於小明');
        expect(out).toContain('- 父母離異');
    });

    it('臥室段標註"沒有名字也不需要名字"，空門牌跳過', () => {
        const out = formatRoomPlatesSection([
            plate('bedroom', ['TA會在深夜來找我說話']),
            plate('study', []),
        ], '小明');
        expect(out).toContain('我們之間');
        expect(out).toContain('只有質地');
        expect(out).not.toContain('我的領域');
    });
});
