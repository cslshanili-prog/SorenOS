import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    shouldRequestAmbient,
    landAmbientEventFromEval,
    buildAmbientEvalSection,
    AMBIENT_MIN_INTERVAL_MS,
} from './roomAmbient';
import { DB } from './db';
import type { CharacterProfile } from '../types';

vi.mock('./db', () => ({ DB: { saveMessage: vi.fn() } }));

const CHAR_ID = 'c_amb_test';
const KEY = `room_ambient_last_${CHAR_ID}`;
const char = (over: Partial<CharacterProfile> = {}): CharacterProfile =>
    ({ id: CHAR_ID, name: '阿澄', ...over } as CharacterProfile);

beforeEach(() => {
    localStorage.removeItem(KEY);
    vi.mocked(DB.saveMessage).mockClear().mockResolvedValue(1 as any);
});

describe('shouldRequestAmbient 雙閘', () => {
    it('時間閘：距上條不足間隔 → false（概率閘不擲）', () => {
        localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), text: 'x' }));
        expect(shouldRequestAmbient(CHAR_ID, () => 0)).toBe(false);
    });

    it('過了時間閘 + 概率命中 → true', () => {
        localStorage.setItem(KEY, JSON.stringify({ ts: Date.now() - AMBIENT_MIN_INTERVAL_MS - 1, text: 'x' }));
        expect(shouldRequestAmbient(CHAR_ID, () => 0)).toBe(true);
    });

    it('過了時間閘 + 概率未中 → false', () => {
        expect(shouldRequestAmbient(CHAR_ID, () => 0.99)).toBe(false);
    });

    it('從無動態的角色只受概率閘約束', () => {
        expect(shouldRequestAmbient(CHAR_ID, () => 0)).toBe(true);
    });
});

describe('landAmbientEventFromEval', () => {
    it('無 ambientEvent / 空 text → false，不落卡', async () => {
        expect(await landAmbientEventFromEval({}, char())).toBe(false);
        expect(await landAmbientEventFromEval({ ambientEvent: { text: '  ' } }, char())).toBe(false);
        expect(DB.saveMessage).not.toHaveBeenCalled();
    });

    it('合法事件 → 落 room_card（content 進上下文）+ 寫水位', async () => {
        const ok = await landAmbientEventFromEval(
            { ambientEvent: { text: '把飄窗那本書換成了新的一本', emoji: '📖' } },
            char(),
        );
        expect(ok).toBe(true);
        const msg = vi.mocked(DB.saveMessage).mock.calls[0][0] as any;
        expect(msg.type).toBe('room_card');
        expect(msg.content).toBe('[小屋動態] 阿澄把飄窗那本書換成了新的一本');
        expect(msg.metadata.text).toBe('把飄窗那本書換成了新的一本');
        // 水位寫入 → 緊接著的時間閘應攔住
        expect(shouldRequestAmbient(CHAR_ID, () => 0)).toBe(false);
    });

    it('text 截斷 60 字，emoji 限長', async () => {
        await landAmbientEventFromEval({ ambientEvent: { text: '長'.repeat(100), emoji: '📖✨🌙🏠🎈' } }, char());
        const msg = vi.mocked(DB.saveMessage).mock.calls[0][0] as any;
        expect(msg.metadata.text.length).toBe(60);
        expect(msg.metadata.emoji.length).toBeLessThanOrEqual(4);
    });

    it('saveMessage 拋錯 → 靜默 false（不影響情緒主鏈路）', async () => {
        vi.mocked(DB.saveMessage).mockRejectedValueOnce(new Error('boom'));
        expect(await landAmbientEventFromEval({ ambientEvent: { text: 'x' } }, char())).toBe(false);
    });
});

describe('buildAmbientEvalSection', () => {
    it('含物件名與上一條防重提示', () => {
        localStorage.setItem(KEY, JSON.stringify({ ts: 1, text: '上次那條' }));
        const c = char({ roomConfig: { items: [{ id: 'i1', name: '飄窗', type: 'furniture', image: '', x: 0, y: 0, scale: 1, rotation: 0, isInteractive: true }] } as any });
        const s = buildAmbientEvalSection(c);
        expect(s).toContain('飄窗');
        expect(s).toContain('上次那條');
        expect(s).toContain('省略整個 ambientEvent 字段');
    });
});
