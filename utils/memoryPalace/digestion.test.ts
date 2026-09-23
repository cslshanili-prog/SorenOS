import { describe, it, expect } from 'vitest';
import { runCognitiveDigestion, incrementDigestRound, getDigestRoundCount } from './digestion';

// fake-indexeddb + localStorage stub 由 test-setup.ts 注入。
// 迴歸守衛：消化的"無材料早退"分支必須歸零輪數計數器。
// 此前它漏掉 resetDigestRounds → 計數器卡在 ≥50 → 之後每一輪聊天都重觸發
// 自動消化（掛上門牌整理後 = 每輪彈浮窗 + 每輪燒一次 LLM）。
// 空庫上早退發生在任何 LLM 調用之前（回填也因 totalLines=0 直接返回），測試不碰網絡。

describe('認知消化 — 輪數計數器', () => {
    it('無材料早退分支也必須歸零計數器（防每輪重觸發自動消化）', async () => {
        const charId = 'char_digest_counter_test';
        // 模擬聊到第 50 輪：計數器達到自動消化閾值
        let shouldDigest = false;
        for (let i = 0; i < 50; i++) shouldDigest = incrementDigestRound(charId);
        expect(shouldDigest).toBe(true);
        expect(getDigestRoundCount(charId)).toBe(50);

        // 空庫 → 走早退分支（在任何 LLM 調用之前返回）
        const result = await runCognitiveDigestion(
            charId, '測試角色', '人設', { baseUrl: 'http://invalid.test', apiKey: 'k', model: 'm' },
        );
        expect(result).not.toBeNull();

        // 關鍵斷言：計數器歸零，下一輪 increment 後是 1 而不是 51
        expect(getDigestRoundCount(charId)).toBe(0);
        expect(incrementDigestRound(charId)).toBe(false);
    });

    it('進場即歸零：消化一開始計數器就清零，進行中的新輪次計入下一個50', async () => {
        const charId = 'char_digest_entry_reset';
        for (let i = 0; i < 50; i++) incrementDigestRound(charId);

        const run = runCognitiveDigestion(
            charId, '測試角色', '人設', { baseUrl: 'http://invalid.test', apiKey: 'k', model: 'm' },
        );
        // 消化剛啟動（未 await 完成），計數器已經是 0——
        // 這期間來的新聊天輪 increment 到 1/2/3…不會再次觸發
        expect(getDigestRoundCount(charId)).toBe(0);
        expect(incrementDigestRound(charId)).toBe(false);
        await run;
    });

    it('併發鎖：同一角色的第二個消化直接返回 null，不重複跑', async () => {
        const charId = 'char_digest_lock_test';
        const first = runCognitiveDigestion(
            charId, '測試角色', '人設', { baseUrl: 'http://invalid.test', apiKey: 'k', model: 'm' },
        );
        const second = await runCognitiveDigestion(
            charId, '測試角色', '人設', { baseUrl: 'http://invalid.test', apiKey: 'k', model: 'm' },
        );
        expect(second).toBeNull();
        expect(await first).not.toBeNull();
        // 鎖釋放後可以再跑
        const third = await runCognitiveDigestion(
            charId, '測試角色', '人設', { baseUrl: 'http://invalid.test', apiKey: 'k', model: 'm' },
        );
        expect(third).not.toBeNull();
    });
});
