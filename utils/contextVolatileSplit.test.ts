import { describe, it, expect } from 'vitest';
import { ContextBuilder } from './context';

// 鎖住「穩定/易變分層」拆分的守恆性:
//   buildCoreContext(deferVolatile) + buildVolatileCoreState ＝ 原 buildCoreContext 的全部信息。
// 三塊易變內容（分鐘級時間 / 記憶宮殿召回 / 情緒 buff）必須且只能出現在 volatile 側 ——
// 出現在 stable 側會打斷中轉的 prompt 前綴緩存（TTFT 優化失效）；兩側都沒有則是信息丟失。

const makeChar = () => ({
    id: 'c1',
    name: '測試角色',
    systemPrompt: '你是測試角色。',
    timeAwarenessEnabled: true,
    memoryPalaceEnabled: true,
    memoryPalaceInjection: '### 記憶宮殿召回\n- 【召回片段】上週一起看了流星雨',
    scheduleFeatureEnabled: true,
    emotionConfig: { enabled: true },
    buffInjection: '### [當前情緒底色]\n【測試buff】甜蜜的期待 強度: ●●●○○',
    activeBuffs: [],
} as any);

const user = { name: '測試用戶', bio: '' } as any;

describe('buildCoreContext deferVolatile 分層', () => {
    it('默認（不傳 layout）：時間/召回/buff 都在 core 裡，行為與舊版一致', () => {
        const core = ContextBuilder.buildCoreContext(makeChar(), user, true);
        expect(core).toContain('### 當前時間 (Now)');
        expect(core).toContain('【召回片段】');
        expect(core).toContain('【測試buff】');
    });

    it('deferVolatile：三塊易變內容從 core 移除', () => {
        const core = ContextBuilder.buildCoreContext(makeChar(), user, true, undefined, undefined, undefined, { deferVolatile: true });
        expect(core).not.toContain('### 當前時間 (Now)');
        expect(core).not.toContain('【召回片段】');
        expect(core).not.toContain('【測試buff】');
        // 穩定內容仍在
        expect(core).toContain('你是測試角色。');
        expect(core).toContain('### 記憶系統 (Memory Bank)');
    });

    it('buildVolatileCoreState 恰好補齊三塊，順序為 時間→召回→buff', () => {
        const volatile = ContextBuilder.buildVolatileCoreState(makeChar(), { includeDetailedMemories: true });
        const iTime = volatile.indexOf('### 當前時間 (Now)');
        const iPalace = volatile.indexOf('【召回片段】');
        const iBuff = volatile.indexOf('【測試buff】');
        expect(iTime).toBeGreaterThanOrEqual(0);
        expect(iPalace).toBeGreaterThan(iTime);
        expect(iBuff).toBeGreaterThan(iPalace);
    });

    it('各開關關閉時 volatile 對應塊也不輸出（與舊版內聯判定一致）', () => {
        const char = makeChar();
        char.timeAwarenessEnabled = false;
        char.memoryPalaceEnabled = false;     // 宮殿總開關關 → 殘留 injection 不得注入
        char.emotionConfig = { enabled: false };
        const volatile = ContextBuilder.buildVolatileCoreState(char, { includeDetailedMemories: true });
        expect(volatile).not.toContain('### 當前時間 (Now)');
        expect(volatile).not.toContain('【召回片段】');
        expect(volatile).not.toContain('【測試buff】');
    });

    it('includeDetailedMemories=false 時 volatile 不含宮殿召回（對齊舊版 5b 判定）', () => {
        const volatile = ContextBuilder.buildVolatileCoreState(makeChar(), { includeDetailedMemories: false });
        expect(volatile).not.toContain('【召回片段】');
        expect(volatile).toContain('### 當前時間 (Now)');
    });
});
