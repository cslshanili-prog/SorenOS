import { afterEach, describe, expect, it } from 'vitest';
import type { Worldbook } from '../types';
import { globalCategories, setGlobalWorldbooks, withGlobalWorldbooks } from './globalWorldbooks';
import { serializeStandardWorldbook, toMountedWorldbook } from './worldbook';

const wb = (id: string, category: string, global?: boolean): Worldbook => ({ id, title: id, content: `內容${id}`, category, createdAt: 0, updatedAt: 0, constant: true, ...(global ? { global } : {}) });

describe('全局世界書', () => {
    afterEach(() => setGlobalWorldbooks([]));

    it('角色自己掛的＋全局的，同一條不重複', () => {
        setGlobalWorldbooks([wb('g1', '規則', true), wb('g2', '規則', true), wb('x', '別的')]);
        const own = [toMountedWorldbook(wb('a', '角色')), toMountedWorldbook(wb('g1', '規則'))];
        expect(withGlobalWorldbooks(own).map(b => b.id)).toEqual(['a', 'g1', 'g2']);
        expect(withGlobalWorldbooks(undefined).map(b => b.id)).toEqual(['g1', 'g2']);
        // 掛載緩存不帶 global 欄位
        expect('global' in withGlobalWorldbooks(undefined)[0]).toBe(false);
    });

    it('沒有全局就原樣回傳', () => {
        const own = [toMountedWorldbook(wb('a', '角色'))];
        expect(withGlobalWorldbooks(own)).toBe(own);
    });

    it('整組都開才算全局組', () => {
        const cats = globalCategories([wb('1', 'A', true), wb('2', 'A', true), wb('3', 'B', true), wb('4', 'B'), wb('5', 'C')]);
        expect([...cats]).toEqual(['A']);
    });

    it('匯出到 ST 不帶 global', () => {
        const text = serializeStandardWorldbook([wb('1', 'A', true)]);
        expect(text).not.toContain('global');
    });

    it('組提示詞時讀得到全局條目', async () => {
        const { ContextBuilder } = await import('./context');
        setGlobalWorldbooks([{ ...wb('g1', '規則', true), title: '全局規則', content: '所有人都要說繁體中文', position: 0 }]);
        const char = { id: 'c1', name: '阿岳', systemPrompt: '人設', description: '', avatar: '', memories: [] } as any;
        const text = ContextBuilder.buildCoreContext(char, { name: '小晴', avatar: '', bio: '' } as any, false);
        expect(text).toContain('所有人都要說繁體中文');
    });
});
