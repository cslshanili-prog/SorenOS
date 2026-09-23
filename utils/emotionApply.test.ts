/**
 * 情緒評估輸出解析容錯 — parseEmotionEvalOutput / applyEmotionEvalRaw / extractAssistantText.
 *
 * 背景: 情緒 buff 依賴副 API 返回一段 JSON, 模型 (尤其 Claude 系) 偶發輸出:
 * 圍欄包裹 / 前後夾閒聊 / 字符串裡裸引號裸換行 / 尾逗號 / max_tokens 截斷半截 JSON。
 * 舊實現任一環節失敗就整體返回 null → buff/意識流靜默蒸發 (「情緒 buff 不輸出內容」)。
 * 這裡鎖住修復鏈 + 字段級搶救的行為。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveCharacter = vi.fn(async (_char: any) => {});
vi.mock('./db', () => ({ DB: { saveCharacter: (c: any) => saveCharacter(c) } }));

import { parseEmotionEvalOutput, applyEmotionEvalRaw, extractAssistantText } from './emotionApply';

const makeChar = (extra: any = {}): any => ({
    id: 'char-1',
    name: '測試角色',
    activeBuffs: [{ id: 'buff_old', name: 'old_feeling', label: '舊情緒', intensity: 2 }],
    buffInjection: '### 舊注入',
    ...extra,
});

const VALID = {
    changed: true,
    buffs: [
        { id: 'buff_a', name: 'anxiety', label: '焦慮', intensity: 4, emoji: '⚠️', color: '#ef4444', description: 'desc' },
    ],
    injection: '### [當前情緒底色]\n焦慮 強度: ●●●●',
    innerState: '她還沒回消息……',
};

beforeEach(() => {
    saveCharacter.mockClear();
});

describe('parseEmotionEvalOutput — 正常形態', () => {
    it('裸 JSON', () => {
        const r = parseEmotionEvalOutput(JSON.stringify(VALID));
        expect(r?.changed).toBe(true);
        expect(r?.buffs?.[0]?.label).toBe('焦慮');
        expect(r?.innerState).toBe('她還沒回消息……');
        expect(r?.salvaged).toBeUndefined();
    });

    it('```json 圍欄包裹', () => {
        const r = parseEmotionEvalOutput('```json\n' + JSON.stringify(VALID) + '\n```');
        expect(r?.injection).toContain('當前情緒底色');
    });

    it('裸 ``` 圍欄 (沒寫 json 標籤)', () => {
        const r = parseEmotionEvalOutput('```\n' + JSON.stringify(VALID) + '\n```');
        expect(r?.buffs?.length).toBe(1);
    });

    it('前後夾閒聊文字 (後綴含 } 也不誤吞)', () => {
        const raw = `好的，我來分析角色的情緒狀態：\n${JSON.stringify(VALID)}\n以上就是分析結果 {希望有幫助}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.changed).toBe(true);
        expect(r?.innerState).toBe('她還沒回消息……');
    });

    it('changed 為字符串 "true" 也認', () => {
        const r = parseEmotionEvalOutput(JSON.stringify({ ...VALID, changed: 'true' }));
        expect(r?.changed).toBe(true);
    });
});

describe('parseEmotionEvalOutput — 格式劣化修復', () => {
    it('字符串值裡的裸英文雙引號 (prompt 示例學壞的經典 case)', () => {
        const raw = `{
  "changed": true,
  "buffs": [{"id": "b1", "name": "waiting", "label": "患得患失", "intensity": 3}],
  "injection": "現在這個沉默不是"沒事了"，是"還在疼"。",
  "innerState": "但我想要的是一個字，一個"嗯"都好。"
}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.changed).toBe(true);
        expect(r?.innerState).toContain('嗯');
        expect(r?.injection).toContain('沒事了');
    });

    it('字符串值裡的真實換行 / 製表符', () => {
        const raw = `{"changed": true, "buffs": [], "injection": "第一行\n第二行\t縮進", "innerState": "內心\n獨白"}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.injection).toBe('第一行\n第二行\t縮進');
        expect(r?.innerState).toBe('內心\n獨白');
    });

    it('尾逗號', () => {
        const raw = `{"changed": true, "buffs": [{"name": "a", "label": "甲", "intensity": 2},], "injection": "x", "innerState": "y",}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.buffs?.length).toBe(1);
    });

    it('max_tokens 截斷: innerState 字符串寫到一半戛然而止', () => {
        const full = JSON.stringify({ changed: true, buffs: VALID.buffs, injection: VALID.injection, innerState: '她到底是睡著了還是在疼' });
        const truncated = full.slice(0, full.lastIndexOf('在疼') + 2); // 引號和大括號全丟
        const r = parseEmotionEvalOutput(truncated);
        expect(r?.changed).toBe(true);
        expect(r?.buffs?.length).toBe(1);
        expect(r?.injection).toContain('當前情緒底色');
        expect(r?.innerState).toContain('睡著');
    });

    it('圍欄也被截斷 (```json 開了沒閉合)', () => {
        const full = '```json\n' + JSON.stringify(VALID);
        const r = parseEmotionEvalOutput(full.slice(0, full.length - 8));
        expect(r?.changed).toBe(true);
        expect(r?.buffs?.length).toBe(1);
    });

    it('字段級搶救: JSON 爛到修不好, 仍摳出 innerState / injection', () => {
        // buffs 數組中間爛掉 (裸引號+截斷+錯括號), 整體 parse 必然失敗
        const raw = `{"changed": true, "buffs": [{"name": : broken!!], "injection": "### 注入內容", "innerState": "搶救出來的獨白"`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.salvaged).toBe(true);
        expect(r?.injection).toBe('### 注入內容');
        expect(r?.innerState).toBe('搶救出來的獨白');
    });

    it('徹底沒有 JSON → null', () => {
        expect(parseEmotionEvalOutput('抱歉，我無法完成這個分析。')).toBeNull();
        expect(parseEmotionEvalOutput('')).toBeNull();
    });
});

describe('applyEmotionEvalRaw — 落庫語義', () => {
    it('changed=true 完整結果 → 保存 + 返回 innerState', async () => {
        const char = makeChar();
        const inner = await applyEmotionEvalRaw(JSON.stringify(VALID), char);
        expect(inner).toBe('她還沒回消息……');
        expect(saveCharacter).toHaveBeenCalledTimes(1);
        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs[0].label).toBe('焦慮');
        expect(saved.activeBuffs[0].intensity).toBe(3); // 4 被鉗到上限 3
        expect(saved.buffInjection).toContain('當前情緒底色');
    });

    it('changed=false → 不動 buff, 只返回 innerState', async () => {
        const inner = await applyEmotionEvalRaw(
            JSON.stringify({ changed: false, innerState: '平穩的獨白' }),
            makeChar(),
        );
        expect(inner).toBe('平穩的獨白');
        expect(saveCharacter).not.toHaveBeenCalled();
    });

    it('changed=true 但 buffs/injection 全缺 → 不清空已有情緒狀態', async () => {
        const inner = await applyEmotionEvalRaw(
            JSON.stringify({ changed: true, innerState: '只有獨白' }),
            makeChar(),
        );
        expect(inner).toBe('只有獨白');
        expect(saveCharacter).not.toHaveBeenCalled();
    });

    it('搶救場景: 只摳出 injection → 保留舊 buffs, 換新 injection', async () => {
        const raw = `{"changed": true, "buffs": [{"name": : broken!!], "injection": "### 新注入", "innerState": "獨白"`;
        const inner = await applyEmotionEvalRaw(raw, makeChar());
        expect(inner).toBe('獨白');
        expect(saveCharacter).toHaveBeenCalledTimes(1);
        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs[0].id).toBe('buff_old'); // 舊 buff 保住
        expect(saved.buffInjection).toBe('### 新注入');
    });

    it('buff 缺 name 用 id 兜底、缺 label 用 name 兜底, 不再整條丟棄', async () => {
        const raw = JSON.stringify({
            changed: true,
            buffs: [
                { id: 'buff_x', label: '只有中文標籤', intensity: 2 },
                { name: 'only_name', intensity: 2 },
                { intensity: 2 }, // 兩者全缺才丟
            ],
            injection: 'x',
        });
        await applyEmotionEvalRaw(raw, makeChar());
        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs.length).toBe(2);
        expect(saved.activeBuffs[0].name).toBe('buff_x');
        expect(saved.activeBuffs[1].label).toBe('only_name');
    });

    it('解析徹底失敗 → null 且不動 DB', async () => {
        const inner = await applyEmotionEvalRaw('模型拒絕了輸出', makeChar());
        expect(inner).toBeNull();
        expect(saveCharacter).not.toHaveBeenCalled();
    });
});

describe('extractAssistantText — 響應形態兜底', () => {
    it('普通字符串 content', () => {
        expect(extractAssistantText({ content: 'hello' })).toBe('hello');
    });

    it('分塊數組 content', () => {
        expect(extractAssistantText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    });

    it('content 為空時回退 reasoning_content', () => {
        expect(extractAssistantText({ content: '', reasoning_content: '{"changed":false}' })).toBe('{"changed":false}');
    });

    it('全空 → 空字符串', () => {
        expect(extractAssistantText({ content: '' })).toBe('');
        expect(extractAssistantText(null)).toBe('');
    });
});

describe('applyEmotionEvalRaw — 失敗可見性 (chat-gen-emotion-failed)', () => {
    // 評估失敗過去只寫 console.warn，用戶側「情緒不更新但沒報錯」沒法自查（真實反饋）。
    // 鎖住：解析全滅時必須派發失敗事件（OSContext 監聽彈 toast）。
    it('解析全滅 → 派發 chat-gen-emotion-failed，detail 帶 charId/reason', async () => {
        const dispatched: any[] = [];
        (globalThis as any).window = {
            dispatchEvent: (e: any) => { dispatched.push(e); return true; },
        };
        try {
            const inner = await applyEmotionEvalRaw('完全不是 JSON 的輸出', makeChar());
            expect(inner).toBeNull();
            const failed = dispatched.find((e) => e.type === 'chat-gen-emotion-failed');
            expect(failed).toBeTruthy();
            expect(failed.detail.charId).toBe('char-1');
            expect(failed.detail.charName).toBe('測試角色');
            expect(typeof failed.detail.reason).toBe('string');
        } finally {
            delete (globalThis as any).window;
        }
    });

    it('解析成功（即使 salvage）不派發失敗事件', async () => {
        const dispatched: any[] = [];
        (globalThis as any).window = {
            dispatchEvent: (e: any) => { dispatched.push(e); return true; },
        };
        try {
            await applyEmotionEvalRaw(JSON.stringify(VALID), makeChar());
            expect(dispatched.some((e) => e.type === 'chat-gen-emotion-failed')).toBe(false);
            // 正常路徑照舊廣播 emotion-updated
            expect(dispatched.some((e) => e.type === 'emotion-updated')).toBe(true);
        } finally {
            delete (globalThis as any).window;
        }
    });
});
