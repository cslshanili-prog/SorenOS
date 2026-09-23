import { describe, expect, it } from 'vitest';
import { parseQixiJsonObject } from './qixiJson';

describe('parseQixiJsonObject', () => {
    it('accepts fenced JSON with harmless prose and trailing commas', () => {
        const parsed = parseQixiJsonObject(`我整理好了：\n\`\`\`json\n{ "touch": { "hold": "別鬆手", }, }\n\`\`\`\n以上。`, ['touch']);
        expect(parsed).toEqual({ touch: { hold: '別鬆手' } });
    });

    it('repairs smart/single quotes, full-width separators and bare keys', () => {
        const parsed = parseQixiJsonObject(`｛result：{ touch: ｛'complete'：“約好了”，｝ }｝`, ['touch']);
        expect(parsed).toEqual({ touch: { complete: '約好了' } });
    });

    it('closes a lightly truncated final container and unwraps common envelopes', () => {
        const parsed = parseQixiJsonObject(`{"data":{"userMagpies":[{"name":"那杯飲料"}]`, ['userMagpies']);
        expect(parsed).toEqual({ userMagpies: [{ name: '那杯飲料' }] });
    });

    it('does not invent an object when no JSON-like payload exists', () => {
        expect(parseQixiJsonObject('我這次沒有成功生成。', ['scenes'])).toBeNull();
    });
});
