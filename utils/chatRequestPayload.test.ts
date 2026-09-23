import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildChatRequestPayload } from './chatRequestPayload';
import type { BuildChatPayloadInput } from './chatRequestPayload';
import { RealtimeContextManager } from './realtimeContext';
import { installSARModuleOnCharacter, installSARModuleOnUser } from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';
import { ChatPrompts } from './chatPrompts';

// 即時對話（這一輪交給用戶自己的 amsg worker 生成）那份 prompt 裡，凡是 worker 到點
// 會自己補一遍的時效段，前端就不再烤進去：當前時間塊、【真實世界感知系統】（節日 /
// 天氣 / 熱搜）、MCP 工具說明。兩邊都寫的話，模型在同一份 prompt 裡看到兩個鍾、兩份
// 互不重疊的熱搜（前端快照版 + worker 現拉版）、兩套工具名。
//
// 本地私有的易變段（記憶宮殿召回、情緒 buff、音樂、群聊背景、日程、彼方、小程序）照常
// 保留——它們在發送那一刻是新鮮的，而 worker 拿不到。

const MCP_SERVERS_KEY = 'aetheros.mcp.servers';

const userProfile = { name: '小明' } as any;

const realtimeConfig = { weatherEnabled: true, newsEnabled: true } as any;

const baseInput = (): BuildChatPayloadInput => ({
    char: { id: 'char-timely', name: '阿一' } as any,
    userProfile,
    groups: [],
    emojis: [],
    categories: [],
    historyMsgs: [
        { id: 1, charId: 'char-timely', role: 'user', type: 'text', content: '在嗎', timestamp: Date.now() },
    ] as any[],
    contextLimit: 20,
    realtimeConfig,
});

const joinMessages = (messages: Array<{ content: any }>): string =>
    messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

it('keeps this request history when the archive waterline advances during async prompt construction', async () => {
    const input = baseInput();
    input.char = { ...input.char, autoArchiveEnabled: true, contextRangeMode: 'adaptive' };
    const key = `mp_lastMsgId_${input.char.id}`;
    localStorage.setItem(key, '0');
    const original = ChatPrompts.buildSystemPromptParts;
    vi.spyOn(ChatPrompts, 'buildSystemPromptParts').mockImplementation(async (...args) => {
        const result = await original(...args);
        localStorage.setItem(key, '99999');
        return result;
    });
    try {
        const payload = await buildChatRequestPayload(input);
        expect(payload.cleanedApiMessages.some(m => m.role === 'user' && String(m.content).includes('在嗎'))).toBe(true);
        expect(localStorage.getItem(key)).toBe('99999');
        // 新請求仍須遵守推進後的水位，不能把快照變成永久繞過。
        const next = await buildChatRequestPayload(input);
        expect(next.cleanedApiMessages).toEqual([]);
        expect(localStorage.getItem(key)).toBe('99999');
    } finally { localStorage.removeItem(key); }
});

beforeEach(() => {
    // 天氣/熱搜真去聯網太慢也不穩定，樁成固定內容；測的是「這一段進沒進 prompt」。
    vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue({
        city: '上海', description: '晴', temp: 31, feelsLike: 35, humidity: 60,
    } as any);
    vi.spyOn(RealtimeContextManager, 'fetchNews').mockResolvedValue([
        { title: '某某官宣', source: '微博' },
    ] as any);
    // MCP 工具塊要有內容才測得出來：塞一台已發現工具的服務器（isMcpChatAvailable 讀它）。
    localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify([
        { id: 'mcp-1', name: '天氣台', url: 'https://mcp.example.com/sse', enabled: true, tools: [{ name: 'get_weather' }] },
    ]));
});

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(MCP_SERVERS_KEY);
});

describe('timelyByWorker —— 時效段交給 worker，前端這份不重複烤', () => {
    it('ChatApp 格式以簡短 TOP 1 規則置於行為規範最前', async () => {
        const payload = await buildChatRequestPayload({ ...baseInput() });
        const systemPrompt = String(payload.fullMessages[0]?.content || '');
        const topRule = '**TOP 1｜ChatApp 格式（本節最高優先級）**';
        expect(systemPrompt).toContain(topRule);
        expect(systemPrompt.indexOf(topRule)).toBeLessThan(systemPrompt.indexOf('1. **沉浸感**'));
        expect(systemPrompt).toContain('你是發消息的真實存在，以自然短句、短氣泡為主；一個氣泡一行，氣泡間直接另起一行（實際換行，不要輸出“\\n”字樣）。');
        expect(systemPrompt).toContain('每行渲染為一個氣泡；空格和標點不會拆泡');
    });

    it('timelyByWorker: 時鐘與真實世界塊不進 volatileTail，MCP 塊與 tail reminder 不注入', async () => {
        const withMode = await buildChatRequestPayload({ ...baseInput(), timelyByWorker: true });
        const joined = joinMessages(withMode.fullMessages);
        expect(joined).not.toContain('### 當前時間 (Now)');
        expect(joined).not.toContain('【真實世界感知系統】');
        expect(joined).not.toContain('【今日特殊】');
        expect(joined).not.toContain('[外部工具已接入');
        expect(joined).not.toContain('[MCP 工具 ON');
        // 本地私有段仍在（抽一個代表：實時狀態框定行本身還在，說明 volatile 段沒被整段砍掉）
        expect(joined).toContain('[System: 實時狀態 (Live Context)]');
        // 只掐文字注入，不改「這一輪算不算 MCP 模式」——上層還靠它決定要不要帶 tools。
        expect(withMode.flags.mcpChatActive).toBe(true);
    });

    it('默認構建（不帶 timelyByWorker）行為不變：時間塊照常注入', async () => {
        const normal = await buildChatRequestPayload({ ...baseInput() });
        const joined = joinMessages(normal.fullMessages);
        expect(joined).toContain('### 當前時間 (Now)');
        // 上一條的 not.toContain 要有意義，得先確認默認構建裡這幾段真的在
        expect(joined).toContain('【真實世界感知系統】');
        expect(joined).toContain('[外部工具已接入');
        expect(joined).toContain('[MCP 工具 ON');
        expect(normal.flags.mcpChatActive).toBe(true);
    });

    it('只裁文本不動 flag：mcpChatActive 照實反映有沒有 MCP 可用', async () => {
        // 上層還要靠這個 flag 決定請求帶不帶 tools、出錯了要不要按 MCP 那套降級重試。
        // 跟著文字注入一起掐掉的話，這些判斷會全部讀成「這一輪沒有 MCP」。
        const withMcp = await buildChatRequestPayload({ ...baseInput(), timelyByWorker: true });
        expect(withMcp.flags.mcpChatActive).toBe(true);

        localStorage.removeItem(MCP_SERVERS_KEY);
        const withoutMcp = await buildChatRequestPayload({ ...baseInput(), timelyByWorker: true });
        expect(withoutMcp.flags.mcpChatActive).toBe(false);
    });

    it('關掉天氣熱搜時的「今日特殊」節日兜底同樣交給 worker', async () => {
        // 天氣/熱搜關著時，前端只補一條節日行。worker 的 realtimeWorld 裡也有節日
        // （跟著角色的時間感知開關走），兩邊都寫就會看到兩遍「今天是七夕」。
        vi.spyOn(RealtimeContextManager, 'checkSpecialDates').mockReturnValue(['七夕'] as any);
        const quietConfig = { weatherEnabled: false, newsEnabled: false } as any;

        const normal = await buildChatRequestPayload({ ...baseInput(), realtimeConfig: quietConfig });
        expect(joinMessages(normal.fullMessages)).toContain('【今日特殊】');

        const withMode = await buildChatRequestPayload({
            ...baseInput(), realtimeConfig: quietConfig, timelyByWorker: true,
        });
        expect(joinMessages(withMode.fullMessages)).not.toContain('【今日特殊】');
    });

    it('M2 只把當下交流節奏注入 ChatApp，不進入其他 App 的寫作提示', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { interactionAdaptation: true },
        }));
        const energeticInput = {
            ...baseInput(),
            char: { id: 'char-timely', name: '阿一', memoryPalaceEnabled: false } as any,
            historyMsgs: [
                { id: 1, charId: 'char-timely', role: 'user', type: 'text', content: '我過啦！！！', timestamp: Date.now() },
            ] as any[],
        };

        const chatApp = await buildChatRequestPayload({
            ...energeticInput,
            recallEntryPoint: 'chat_app',
        });
        const anotherApp = await buildChatRequestPayload({
            ...energeticInput,
            recallEntryPoint: 'world_home',
        });

        expect(joinMessages(chatApp.fullMessages)).toContain('### 此刻的交流節奏');
        expect(joinMessages(anotherApp.fullMessages)).not.toContain('### 此刻的交流節奏');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 v2 只把談話參與策略注入 ChatApp', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const depthInput = {
            ...baseInput(),
            char: { id: 'char-timely', name: '測試角色', memoryPalaceEnabled: false } as any,
            historyMsgs: [
                {
                    id: 1,
                    charId: 'char-timely',
                    role: 'user',
                    type: 'text',
                    content: '我想認真分析一個虛構規則：它一邊要求開放，一邊不斷增加限制，這背後的邏輯是什麼？',
                    timestamp: Date.now(),
                },
            ] as any[],
        };

        const chatApp = await buildChatRequestPayload({ ...depthInput, recallEntryPoint: 'chat_app' });
        const anotherApp = await buildChatRequestPayload({ ...depthInput, recallEntryPoint: 'world_home' });

        expect(joinMessages(chatApp.fullMessages)).toContain('### 當前談話參與策略');
        expect(joinMessages(chatApp.fullMessages)).toContain('### 談話參與原則');
        expect(joinMessages(chatApp.fullMessages)).toContain('對方出現負面情緒，不代表當前談話的目標是消除這種情緒');
        expect(joinMessages(chatApp.fullMessages)).toContain('情緒是談話的一部分，不應覆蓋談話本身');
        expect(joinMessages(anotherApp.fullMessages)).not.toContain('### 當前談話參與策略');
        expect(joinMessages(anotherApp.fullMessages)).not.toContain('### 談話參與原則');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 v2 的核心原則不依賴當輪是否命中 opening', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: { id: 'char-m3-core', name: '測試角色', memoryPalaceEnabled: false } as any,
            historyMsgs: [{
                id: 102,
                charId: 'char-m3-core',
                role: 'user',
                type: 'text',
                content: '這個函數返回什麼？',
                timestamp: Date.now(),
            }] as any[],
            recallEntryPoint: 'chat_app',
        });
        const joined = joinMessages(payload.fullMessages);

        expect(joined).toContain('### 談話參與原則');
        expect(joined).toContain('對方出現負面情緒，不代表當前談話的目標是消除這種情緒');
        expect(joined).toContain('先聽見，再瞭解，再形成看法');
        expect(joined).not.toContain('### 當前談話參與策略');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 關閉時不注入核心原則', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: false },
        }));
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            recallEntryPoint: 'chat_app',
        });

        expect(joinMessages(payload.fullMessages)).not.toContain('### 談話參與原則');
        localStorage.removeItem('os_memory_palace_config');
    });

    it('M3 v2 會把“我很累，事情很多”識別為尚未講完的 opening', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: { id: 'char-opening', name: '測試角色', memoryPalaceEnabled: false } as any,
            historyMsgs: [{
                id: 101,
                charId: 'char-opening',
                role: 'user',
                type: 'text',
                content: '我很累，事情很多。',
                timestamp: Date.now(),
            }] as any[],
            recallEntryPoint: 'chat_app',
        });
        const joined = joinMessages(payload.fullMessages);

        expect(joined).toContain('### 當前談話參與策略');
        expect(joined).toContain('對方正在開啟一件還沒有講完的事情');
        expect(joined).toContain('不要用“別想了”“回來就好”“一切都會過去”');
        expect(joined).not.toContain('### 此刻的交流深度');
    });

    it('角色和 User 都沒有模塊時，Chat prompt 不增加 SAR 文本或輸出容器', async () => {
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: {
                id: 'char-sar-empty',
                name: '測試角色',
                memoryPalaceEnabled: false,
                vrState: { enabled: true, intervalMinutes: 120 },
            } as any,
            userProfile: { ...userProfile, vrState: { enabled: true } } as any,
            recallEntryPoint: 'chat_app',
        });
        const joined = joinMessages(payload.fullMessages);

        expect(payload.flags.sarModuleActive).toBe(false);
        expect(joined).not.toContain('### SAR 臨時模塊');
        expect(joined).not.toContain('<SAR_MODULE_OUTPUT>');
        expect(joined).not.toContain('[SAR MODULE REMINDER:');
    });

    it('SAR 與內置翻譯同時開啟時，以 SAR 為外層、翻譯標籤留在兩個內容字段內', async () => {
        const runtime = installSARModuleOnCharacter(SAR_MODULE_CATALOG[0], 1);
        const payload = await buildChatRequestPayload({
            ...baseInput(),
            char: {
                id: 'char-sar-bilingual',
                name: '測試角色',
                memoryPalaceEnabled: false,
                vrState: { enabled: true, intervalMinutes: 120, sarModule: runtime },
            } as any,
            userProfile: { ...userProfile, vrState: { enabled: true } } as any,
            historyMsgs: [{
                id: 201,
                charId: 'char-sar-bilingual',
                role: 'user',
                type: 'text',
                content: '你怎麼說話怪怪的？',
                timestamp: Date.now(),
            }] as any[],
            recallEntryPoint: 'chat_app',
            translationConfig: { enabled: true, sourceLang: '日語', targetLang: '中文' },
        });
        const joined = joinMessages(payload.fullMessages);

        expect(payload.flags.sarModuleActive).toBe(true);
        expect(payload.flags.bilingualActive).toBe(true);
        expect(joined).toContain('最外層必須是 <SAR_MODULE_OUTPUT>');
        expect(joined).toContain('CHAR_TRUE 和 CHAR_SURFACE 內的每個氣泡');
        expect(joined).toContain('原文/譯文語義一致');
    });
});

describe('volatileTailIndex —— 想插在鋼印之前的塊按它定位', () => {
    it('指向易變尾段那條 system，「回到你自己」在它末尾', async () => {
        const payload = await buildChatRequestPayload({ ...baseInput() });
        // 排程清單這類「有用但不該搶最後一眼」的塊插在這個下標前；下標要是錯位了，
        // 塊會落進歷史消息中間（讀起來像用戶說的話）或者又跑到鋼印後面去。
        expect(payload.volatileTailIndex).toBeGreaterThan(0);
        const tail = payload.fullMessages[payload.volatileTailIndex];
        expect(tail?.role).toBe('system');
        expect(String(tail?.content)).toContain('回到你自己');
        // 它前面一條是本輪用戶消息（前綴緩存的斷點在那兒，插入不影響命中）
        expect(payload.fullMessages[payload.volatileTailIndex - 1]?.role).toBe('user');
    });
});

it('ChatApp user modules explicitly identify the pending messages without changing other callers', async () => {
    const input = baseInput();
    input.userProfile = { ...input.userProfile, vrState: { enabled: true, sarModule: installSARModuleOnUser(SAR_MODULE_CATALOG[0], input.char, 1) } } as any;
    const chat = await buildChatRequestPayload({ ...input, recallEntryPoint: 'chat_app' });
    const request = chat.fullMessages.find(m => typeof m.content === 'string' && m.content.startsWith('USER_SURFACE 的聊天專用格式'));
    expect(request?.content).toContain(JSON.stringify(input.historyMsgs.map(({ id, content }) => ({ id, content }))));
    const other = await buildChatRequestPayload(input);
    expect(joinMessages(other.fullMessages)).not.toContain('USER_SURFACE 的聊天專用格式');
});
