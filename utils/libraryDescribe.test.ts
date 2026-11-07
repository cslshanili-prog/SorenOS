import { describe, expect, it } from 'vitest';
import { cleanLibraryDescription, libraryDescribeOptions } from './libraryDescribe';

describe('資料庫 · AI 寫描述', () => {
    it('選單：主 API 在前，沒填完整的不列', () => {
        const main = { baseUrl: 'https://a/v1', apiKey: 'k', model: 'gpt-x' } as any;
        const presets = [
            { id: 'p1', name: '看圖用', config: { baseUrl: 'https://b/v1 ', apiKey: 'k2', model: 'gemini' } },
            { id: 'p2', name: '缺 key', config: { baseUrl: 'https://c/v1', apiKey: '', model: 'm' } },
        ] as any;
        const options = libraryDescribeOptions(main, presets);
        expect(options.map(o => o.id)).toEqual(['main', 'p1']);
        expect(options[0].label).toBe('主 API（gpt-x）');
        expect(options[1].api.baseUrl).toBe('https://b/v1');
        expect(libraryDescribeOptions({ baseUrl: '', apiKey: '', model: '' } as any, [])).toEqual([]);
    });

    it('清掉模型自己加的開頭、引號、思考', () => {
        expect(cleanLibraryDescription('<think>嗯</think>描述：「傍晚的海邊，\n浪很小。」')).toBe('傍晚的海邊， 浪很小。');
        expect(cleanLibraryDescription('字'.repeat(600)).length).toBe(500);
    });
});
