import { describe, expect, it } from 'vitest';
import type { MountedWorldbook, Worldbook } from '../types';
import {
    injectWorldbookDepthEntries,
    isWorldbookEntryActive,
    parseStandardWorldbook,
    resolveWorldbookEntries,
    serializeStandardWorldbook,
    splitWorldbookKeywords,
    splitWorldbookSections,
    toMountedWorldbook,
    upsertMountedWorldbooks,
} from './worldbook';

const book = (overrides: Partial<MountedWorldbook> = {}): MountedWorldbook => ({
    id: 'book-1',
    title: '測試條目',
    content: '{{char}} 在 {{user}} 提到月亮時會想起故鄉。',
    category: '測試',
    ...overrides,
});

describe('worldbook activation', () => {
    it('keeps legacy entries constantly active after character definitions', () => {
        const resolved = resolveWorldbookEntries([book()], [], '阿澈', '小雨');
        expect(resolved).toHaveLength(1);
        expect(resolved[0].position).toBe(1);
        expect(resolved[0].content).toContain('阿澈 在 小雨');
    });

    it('activates keyword entries only when the recent scan buffer matches', () => {
        const keywordBook = book({ constant: false, key: ['月亮'], scanDepth: 2 });
        expect(isWorldbookEntryActive(keywordBook, [{ content: '今晚有月亮' }])).toBe(true);
        expect(isWorldbookEntryActive(keywordBook, [{ content: '今晚下雨' }])).toBe(false);
    });

    it('respects secondary keyword logic and disabled state', () => {
        const selectiveBook = book({
            constant: false,
            key: ['學校'],
            keysecondary: ['老師', '同學'],
            selective: true,
            selectiveLogic: 3,
        });
        expect(isWorldbookEntryActive(selectiveBook, [{ content: '學校裡的老師和同學' }])).toBe(true);
        expect(isWorldbookEntryActive(selectiveBook, [{ content: '學校裡的老師' }])).toBe(false);
        expect(isWorldbookEntryActive({ ...selectiveBook, disable: true }, [{ content: '學校裡的老師和同學' }])).toBe(false);
    });
});

describe('worldbook positions', () => {
    it('splits standard positions and injects at-depth entries using their role', () => {
        const resolved = resolveWorldbookEntries([
            book({ id: 'before', position: 0 }),
            book({ id: 'depth', position: 4, depth: 1, role: 1 }),
        ]);
        const sections = splitWorldbookSections(resolved);
        expect(sections.beforeCharacter.map(entry => entry.book.id)).toEqual(['before']);

        const messages = injectWorldbookDepthEntries(
            [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }],
            sections.atDepth,
        );
        expect(messages.map(message => message.role)).toEqual(['user', 'user', 'assistant']);
        expect(messages[1].content).toContain('{{char}}');
    });
});

describe('standard worldbook import', () => {
    it('converts entries into a SullyOS category without losing activation metadata', () => {
        const imported = parseStandardWorldbook(JSON.stringify({
            entries: {
                0: {
                    uid: 7,
                    comment: '月亮設定',
                    content: '月亮是藍色的。',
                    key: ['月亮'],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    order: 120,
                    position: 4,
                    depth: 2,
                    role: 0,
                    disable: false,
                    probability: 80,
                    useProbability: true,
                },
            },
        }), '導入測試', 1234);

        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
            title: '月亮設定',
            category: '導入測試',
            key: ['月亮'],
            constant: false,
            position: 4,
            depth: 2,
            role: 0,
            order: 120,
            probability: 80,
            useProbability: true,
            sourceUid: 7,
        });
    });

    it('exports a whole group as a standard worldbook that can be imported again', () => {
        const source = [{
            ...book({
                id: 'export-1',
                title: '導出條目',
                content: '導出內容',
                constant: false,
                key: ['導出'],
                position: 4,
                depth: 3,
                role: 2,
            }),
            category: '導出組',
            createdAt: 1,
            updatedAt: 1,
        }];

        const json = serializeStandardWorldbook(source);
        const raw = JSON.parse(json);
        expect(raw.entries['0']).toMatchObject({
            comment: '導出條目',
            key: ['導出'],
            position: 4,
            depth: 3,
            role: 2,
        });

        const imported = parseStandardWorldbook(json, '重新導入', 2);
        expect(imported[0]).toMatchObject({
            title: '導出條目',
            content: '導出內容',
            key: ['導出'],
            position: 4,
            depth: 3,
            role: 2,
        });
    });
});

describe('mounted worldbook synchronization', () => {
    it('copies edited activation and injection settings into the character mount cache', () => {
        const mounted = toMountedWorldbook({
            ...book({
                constant: false,
                key: ['月亮'],
                keysecondary: ['夜晚'],
                selective: true,
                selectiveLogic: 0,
                position: 4,
                depth: 2,
                role: 1,
                disable: true,
                order: 180,
                scanDepth: 6,
                useProbability: true,
                probability: 75,
            }),
            category: '同步測試',
            createdAt: 1,
            updatedAt: 2,
        });

        expect(mounted).toMatchObject({
            constant: false,
            key: ['月亮'],
            keysecondary: ['夜晚'],
            selective: true,
            position: 4,
            depth: 2,
            role: 1,
            disable: true,
            order: 180,
            scanDepth: 6,
            useProbability: true,
            probability: 75,
        });
        expect(mounted).not.toHaveProperty('createdAt');
        expect(mounted).not.toHaveProperty('updatedAt');
    });

    it('mounts a complete generated group without duplicates and keeps it injectable', () => {
        const now = Date.now();
        const generated: Worldbook[] = [
            { ...book({ id: 'generated-1', title: '常駐校規', content: '午夜後禁止離開宿舍。', category: '學院', constant: true, order: 10, position: 1 }), createdAt: now, updatedAt: now },
            { ...book({ id: 'generated-2', title: '雨夜鐘樓', content: '鐘樓會在雨夜開放。', category: '學院', constant: false, key: ['鐘樓'], scanDepth: 4, order: 20, position: 1 }), createdAt: now, updatedAt: now },
        ];
        const mounted = upsertMountedWorldbooks([book({ id: 'existing', title: '已有條目', order: 300 })], generated);
        const retried = upsertMountedWorldbooks(mounted, generated);

        expect(retried.map(entry => entry.id)).toEqual(['existing', 'generated-1', 'generated-2']);
        expect(retried.filter(entry => entry.category === '學院')).toHaveLength(2);
        expect(resolveWorldbookEntries(retried, [{ content: '我們去鐘樓看看' }]).map(entry => entry.book.id)).toEqual(['generated-1', 'generated-2', 'existing']);
    });
});

describe('SillyTavern alignment', () => {
    const scan = (text: string) => [{ role: 'user', content: text }];
    const keyed = (key: string[], extra: Partial<MountedWorldbook> = {}) => book({ constant: false, key, ...extra });

    it('treats CJK neighbours as word boundaries when whole-word matching is on, like ST', () => {
        const entry = keyed(['學院'], { matchWholeWords: true });
        expect(isWorldbookEntryActive(entry, scan('我去學院了'))).toBe(true);
        const english = keyed(['cat'], { matchWholeWords: true });
        expect(isWorldbookEntryActive(english, scan('a category'))).toBe(false);
        expect(isWorldbookEntryActive(english, scan('the Cat sat'))).toBe(true);
        expect(isWorldbookEntryActive(keyed(['cat'], { matchWholeWords: true, caseSensitive: true }), scan('the Cat sat'))).toBe(false);
        expect(isWorldbookEntryActive(keyed(['black cat'], { matchWholeWords: true }), scan('a black category'))).toBe(true);
    });

    it('matches /regex/flags keywords and ignores invalid ones as plain text', () => {
        expect(isWorldbookEntryActive(keyed(['/貓|狗/']), scan('家裡有隻狗'))).toBe(true);
        expect(isWorldbookEntryActive(keyed(['/moon/i']), scan('MOON'))).toBe(true);
        expect(isWorldbookEntryActive(keyed(['/moon/']), scan('MOON'))).toBe(false);
        // g flag would make repeated test() calls flip; it is dropped
        const global = keyed(['/月/g']);
        expect(isWorldbookEntryActive(global, scan('月亮'))).toBe(true);
        expect(isWorldbookEntryActive(global, scan('月亮'))).toBe(true);
        expect(isWorldbookEntryActive(keyed(['/[/']), scan('/[/'))).toBe(true);
    });

    it('keeps regex keywords containing commas whole when splitting editor input', () => {
        expect(splitWorldbookKeywords('/a{1,3}/i, 月亮，故鄉\n/x/')).toEqual(['/a{1,3}/i', '月亮', '故鄉', '/x/']);
        expect(splitWorldbookKeywords('/未閉合, 月亮')).toEqual(['/未閉合', '月亮']);
    });

    it('imports outlet entries without injecting them', () => {
        const [imported] = parseStandardWorldbook(JSON.stringify({
            entries: { 0: { uid: 0, content: 'outlet 內容', position: 7, constant: true, outletName: 'scene' } },
        }), 'ST', 1);
        expect(imported.position).toBe(7);
        expect(resolveWorldbookEntries([imported], [], '阿澈', '小雨')).toHaveLength(0);
    });

    it('round-trips ST-only fields and keys exported entries by uid', () => {
        const json = JSON.stringify({
            entries: {
                3: { uid: 3, displayIndex: 0, comment: '甲', content: '甲', key: ['甲'], sticky: 2, group: '天氣', extensions: { foo: 1 }, title: '協同雜欄位' },
                1: { uid: 1, displayIndex: 1, comment: '乙', content: '乙', key: ['乙'], cooldown: 3 },
            },
        });
        const imported = parseStandardWorldbook(json, 'ST', 1);
        expect(imported.map(entry => entry.title)).toEqual(['甲', '乙']);
        expect(imported[0].stExtra).toEqual({ sticky: 2, group: '天氣', extensions: { foo: 1 } });
        expect(toMountedWorldbook(imported[0])).not.toHaveProperty('stExtra');

        const raw = JSON.parse(serializeStandardWorldbook(imported));
        expect(Object.keys(raw.entries).sort()).toEqual(['1', '3']);
        expect(raw.entries['3']).toMatchObject({ uid: 3, displayIndex: 0, sticky: 2, group: '天氣', comment: '甲' });
        expect(raw.entries['3']).not.toHaveProperty('title');
        expect(raw.entries['1']).toMatchObject({ uid: 1, displayIndex: 1, cooldown: 3 });
    });
});
