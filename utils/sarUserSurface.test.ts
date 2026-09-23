import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { buildSARUserSurfaceRequest, parseSARUserSurfaces, selectSARUserSurfaceTargets } from './vrWorld/sarUserSurface';
import { installSARModuleOnUser } from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';
const runtime = installSARModuleOnUser(SAR_MODULE_CATALOG[0], { id: 'c', name: '角色' }, 100);
const msg = (id: number, content: string, extra = {}): Message => ({ id, charId: 'c', role: 'user', type: 'text', content, timestamp: 200, ...extra } as Message);
const targets = [msg(10, '討厭你！'), msg(11, '你是壞蛋！')];
describe('SAR user surface boundaries', () => {
    it('selects only this chat unanswered text after installation', () => {
        const history = [msg(1, '舊消息'), msg(2, '已回覆', { role: 'assistant' }), msg(3, '安裝前', { timestamp: 99 }), ...targets, msg(12, '圖片', { type: 'image' }), msg(13, '別人的', { charId: 'other' })];
        expect(selectSARUserSurfaceTargets(history, 'c', runtime)).toEqual(targets);
        expect(selectSARUserSurfaceTargets(history, 'c')).toEqual([]);
        expect(selectSARUserSurfaceTargets([...history, msg(14, '回覆', { role: 'assistant' })], 'c', runtime)).toEqual([]);
    });
    it('supplies explicit ids and raw content rather than timestamped history', () => {
        const request = buildSARUserSurfaceRequest(targets);
        expect(request).toContain(JSON.stringify(targets.map(({ id, content }) => ({ id, content }))));
        expect(request).toContain('不得把多條合併');
        expect(buildSARUserSurfaceRequest([])).toMatch(/\[\]$/);
    });
    it('maps shuffled ids without changing canonical messages', () => {
        const before = JSON.stringify(targets);
        expect([...parseSARUserSurfaces('[{"id":11,"surface":"蛋是壞你！"},{"id":10,"surface":"討你厭！"}]', targets)])
            .toEqual([[10, '討你厭！'], [11, '蛋是壞你！']]);
        expect(JSON.stringify(targets)).toBe(before);
    });
    it('recovers screenshot legacy timestamps into separate corresponding bubbles', () => {
        expect([...parseSARUserSurfaces('[2026-09-13 16:04]\n討……討你厭！\n[2026-09-13 16:04]\n蛋是壞你……不是！你是壞蛋！', targets)])
            .toEqual([[10, '討……討你厭！'], [11, '蛋是壞你……不是！你是壞蛋！']]);
    });
    it('never assigns ambiguous merged history to the last bubble', () => {
        expect(parseSARUserSurfaces('討你厭！\n蛋是壞你！', targets).size).toBe(0);
        expect(parseSARUserSurfaces('[2026-09-13 16:04]\n舊話\n[2026-09-13 16:05]\n新話', [targets[1]]).size).toBe(0);
    });
    it('rejects unknown, duplicate and malformed entries without dropping valid ones', () => {
        expect([...parseSARUserSurfaces('[{"id":10,"surface":"甲"},{"id":10,"surface":"乙"},{"id":99,"surface":"越界"},{"id":"11","surface":"好"}]', targets)])
            .toEqual([[11, '好']]);
        for (const raw of ['[{"id":10,', '{"surface":"bad"}', '[]', undefined]) expect(parseSARUserSurfaces(raw, [targets[0]]).size).toBe(0);
    });
    it('accepts fenced JSON and removes history wrappers from an identified surface', () => {
        const raw = '```json\n' + JSON.stringify([{id: 10, surface: '[2026-09-13 16:04]\n討你厭！'}]) + '\n```';
        expect(parseSARUserSurfaces(raw, targets).get(10)).toBe('討你厭！');
    });
    it('preserves single-message multiline, actions, translation and authored dates', () => {
        for (const text of ['第一行\n第二行', '（抱住你）', '好き（喜歡）', '<翻譯><原文>Hi</原文><譯文>你好</譯文></翻譯>', '記住 [2026-09-13 16:04] 這個時刻', '[2026-09-13 16:04]\n日記原文']) {
            expect(parseSARUserSurfaces(text, [msg(1, text)]).get(1)).toBe(text);
        }
    });
});
