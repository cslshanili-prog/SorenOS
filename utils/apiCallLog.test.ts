import { describe, it, expect, vi } from 'vitest';
import {
    buildApiRequestCapture,
    buildPromptBreakdown,
    captureApiRequestOnce,
    coreModelName,
    extractApiTokenUsage,
    formatApiRequestCaptureTxt,
    getApiCallAmbientContext,
    getApiRequestCaptureSectionContent,
    getApiRequestCaptureSectionSource,
    isApiRequestCaptureArmed,
    isFixedPromptBlockLabel,
    isSameCoreModel,
    scanSseForLog,
    setApiRequestCaptureArmed,
    setApiCallAmbientContext,
    summarizeApiRequestCaptureDuplicates,
    updateApiRequestCaptureUsage,
} from './apiCallLog';

describe('one-shot full API request capture', () => {
    it('uses the in-memory armed flag on the disabled hot path instead of reading localStorage per request', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('isApiRequestCaptureArmed must not read storage'); },
            setItem: () => {},
            removeItem: () => {},
        });
        setApiRequestCaptureArmed(true);
        expect(isApiRequestCaptureArmed()).toBe(true);
        setApiRequestCaptureArmed(false);
        expect(isApiRequestCaptureArmed()).toBe(false);
        vi.unstubAllGlobals();
    });

    it('keeps the complete payload and indexes memory, worldbook, history, tools and options', () => {
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: JSON.stringify({
                model: 'gpt-test',
                temperature: 0.7,
                messages: [
                    { role: 'system', content: '## 行為規範\n規則正文\n## 記憶召回\n昨天一起看了海。\n## 世界書\n海邊城市設定。' },
                    { role: 'user', content: '今天還去嗎？' },
                    { role: 'assistant', content: '當然。' },
                ],
                tools: [{ type: 'function', function: { name: 'read_calendar' } }],
            }),
            meta: { appName: '消息', charName: '測試角色' },
            capturedAt: 1234,
        });

        expect(capture.model).toBe('gpt-test');
        expect(capture.messageCount).toBe(3);
        expect(capture.meta.charName).toBe('測試角色');
        expect(capture.sections.some(section => section.kind === 'memory')).toBe(true);
        expect(capture.sections.some(section => section.kind === 'worldbook')).toBe(true);
        expect(capture.sections.some(section => section.kind === 'tools')).toBe(true);
        expect(capture.sections.some(section => section.kind === 'user')).toBe(true);

        const memory = capture.sections.find(section => section.kind === 'memory')!;
        expect(getApiRequestCaptureSectionContent(capture, memory)).toContain('昨天一起看了海');
        expect(getApiRequestCaptureSectionSource(memory)).toContain('記憶系統召回');
        expect(memory.path).toBe('messages[0].content · 分塊 2');
        expect(JSON.stringify(capture.payload)).toContain('read_calendar');
        expect(JSON.stringify(capture.payload)).toContain('今天還去嗎');
    });

    it('classifies group-chat background separately instead of calling it a system prompt', () => {
        const content = [
            '## 行為規範',
            '普通規則',
            '### 【群聊背景 · 你親歷的近期群聊】',
            '[2026-08-05 12:00] [群：朋友們] 小夏：晚上吃什麼？',
            '### 群聊場景共享設定 (Group Scene)',
            '本群成員都知道今天下雨。',
        ].join('\n');
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'gpt-test', messages: [{ role: 'system', content }] },
        });

        const groupSections = capture.sections.filter(section => section.kind === 'group');
        expect(groupSections).toHaveLength(2);
        expect(groupSections.every(section => getApiRequestCaptureSectionSource(section).includes('群聊'))).toBe(true);
        expect(capture.sections.filter(section => section.kind === 'system')).toHaveLength(1);
        expect(capture.sections
            .filter(section => section.messageIndex != null)
            .reduce((sum, section) => sum + section.chars, 0)).toBe(content.length);
    });

    it('classifies embedded full conversation history separately from system prompts', () => {
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: {
                model: 'gpt-test',
                messages: [{
                    role: 'user',
                    content: [
                        `## 角色此刻看到的完整上下文\n${'設定'.repeat(3000)}`,
                        `## 完整對話歷史（與主 API 看到的消息歷史一致）\n${'[用戶] 你好\n[角色] 嗨\n'.repeat(300)}`,
                        '## 任務\n分析當前情緒。',
                    ].join('\n'),
                }],
            },
        });

        const history = capture.sections.find(section => section.kind === 'history');
        expect(history).toBeTruthy();
        expect(history?.label).toContain('完整對話歷史');
        expect(getApiRequestCaptureSectionSource(history!)).toContain('既往用戶與角色對話');
    });

    it('reads real token usage from common OpenAI, Anthropic and Gemini-compatible fields', () => {
        expect(extractApiTokenUsage({ usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } }))
            .toEqual({ prompt: 123, completion: 45, total: 168 });
        expect(extractApiTokenUsage({ usage: { input_tokens: 70, output_tokens: 20 } }))
            .toEqual({ prompt: 70, completion: 20, total: undefined });
        expect(extractApiTokenUsage({ usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 90 } }))
            .toEqual({ prompt: 80, completion: 10, total: 90 });
    });

    it('backfills the real response usage into the same one-shot capture', async () => {
        const { DB } = await import('./db');
        await DB.clearApiRequestCapture();
        setApiRequestCaptureArmed(true);
        const captureId = captureApiRequestOnce({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'gpt-test', messages: [{ role: 'user', content: '你好' }] },
        });
        expect(captureId).toEqual(expect.any(String));

        updateApiRequestCaptureUsage({
            captureId,
            ok: true,
            response: { usage: { prompt_tokens: 456, completion_tokens: 78, total_tokens: 534 } },
        });

        await vi.waitFor(async () => {
            expect(await DB.getApiRequestCapture()).toMatchObject({
                id: captureId,
                promptTokens: 456,
                completionTokens: 78,
                totalTokens: 534,
                usageStatus: 'reported',
            });
        });
    });

    it('detects duplicated long prompt blocks in the client request without flagging short reminders', () => {
        const duplicated = `## 固定規則\n${'不要重複發送這段提示詞。'.repeat(30)}`;
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: {
                model: 'gpt-test',
                messages: [
                    { role: 'system', content: duplicated },
                    { role: 'system', content: duplicated },
                    { role: 'system', content: '短提醒' },
                    { role: 'system', content: '短提醒' },
                ],
            },
        });

        const summary = summarizeApiRequestCaptureDuplicates(capture);
        expect(summary.groups).toBe(1);
        expect(summary.repeatedSections).toBe(2);
        expect(summary.extraChars).toBe(duplicated.length);
        expect(summary.examples[0]).toMatchObject({ occurrences: 2, chars: duplicated.length });
    });

    it('exports a readable TXT report with source ranking, paths, section content and raw JSON', () => {
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: {
                model: 'gpt-test',
                messages: [
                    { role: 'system', content: '## 記憶召回\n記憶正文' },
                    { role: 'user', content: '用戶正文' },
                ],
            },
            meta: { appName: '消息', purpose: '聊天回覆' },
            capturedAt: 1234,
        });
        const txt = formatApiRequestCaptureTxt(capture);

        expect(txt).toContain('來源體積排行');
        expect(txt).toContain('記憶系統召回後注入本次請求的內容');
        expect(txt).toContain('位置：messages[0].content · 分塊 1');
        expect(txt).toContain('記憶正文');
        expect(txt).toContain('完整原始請求 JSON');
        expect(txt).toContain('"content": "用戶正文"');
        expect(txt).toContain('請求體總字符（不是 Token）');
        expect(txt).toContain('客戶端發出前重複檢查');
        expect(txt).toContain('未發現完全相同的長文本被客戶端重複發送');
    });

    it('replaces oversized inline binary data but preserves its original size for diagnosis', () => {
        const dataUrl = `data:image/png;base64,${'a'.repeat(5000)}`;
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'vision', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }] },
        });

        expect(capture.binaryPlaceholders).toBe(1);
        const raw = JSON.stringify(capture.payload);
        expect(raw).toContain('原始 5,022 字符');
        expect(raw).not.toContain('a'.repeat(100));
    });
});

describe('API call ambient context snapshots', () => {
    it('keeps the request-start App even after ambient navigation changes', () => {
        setApiCallAmbientContext({ appId: 'social', appName: 'Spark' });
        const requestStart = getApiCallAmbientContext();
        setApiCallAmbientContext({ appId: 'group_chat', appName: '群聊' });
        expect(requestStart).toEqual({ appId: 'social', appName: 'Spark' });
        setApiCallAmbientContext({});
    });
});

// 鎖住 API 調用記錄的 SSE 兜底解析：流式響應 JSON.parse 必然失敗，
// 後端自報 model（首個非空）與 usage（末個非空）從 data: 行裡掃出來。

describe('scanSseForLog', () => {
    it('摳出首個 model 與最後一個 usage', () => {
        const sse = [
            'data: {"id":"x","model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"a"}}]}',
            'data: {"model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"b"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15572,"completion_tokens":725,"total_tokens":16297}}',
            'data: [DONE]',
        ].join('\n');
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('[逆-V]gemini-3.1-pro-preview-c');
        expect((usage as any).prompt_tokens).toBe(15572);
        expect((usage as any).total_tokens).toBe(16297);
    });

    it('壞行/空行/[DONE] 跳過不崩', () => {
        const sse = 'data: 不是json\n\ndata: [DONE]\ndata: {"model":"m1","choices":[]}';
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('m1');
        expect(usage).toBeUndefined();
    });

    it('非 SSE 文本返回空結果', () => {
        expect(scanSseForLog('{"model":"x"}')).toEqual({ model: undefined, usage: undefined });
    });
});

describe('coreModelName 核心名歸一化（實際後端琥珀判定用）', () => {
    it('剝方括號/半角圓括號/全角圓括號渠道標籤', () => {
        expect(coreModelName('[千島-自營]gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('（官轉）gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    });

    it('渠道標籤不同但核心名相同 → 判定一致（不誤報琥珀）', () => {
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
        expect(coreModelName('[co假流]Gemini-3.1-Pro-Preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
    });

    it('核心名真的不同（如 -c 後綴）→ 判定不一致（該報琥珀）', () => {
        expect(coreModelName('[逆-V]gemini-3.1-pro-preview-c')).not.toBe(coreModelName('[千島-自營]gemini-3.1-pro-preview'));
    });
});

describe('isSameCoreModel 方向性同名判定', () => {
    it('裸前綴 / 路徑前綴 → 同名（gcli-X↔X、X↔models/X）', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'models/gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('(按次)gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('[千島-自營]gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
    });

    it('尾部變體 → 不同名（縮水降級信號必須報琥珀）', () => {
        expect(isSameCoreModel('[千島-自營]gemini-3.1-pro-preview', '[逆-V]gemini-3.1-pro-preview-c')).toBe(false);
        expect(isSameCoreModel('gpt-4o', 'gpt-4o-mini')).toBe(false);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'gemini-3.1-flash-preview')).toBe(false);
    });

    it('短名不做 endsWith 寬容；空值不報警', () => {
        expect(isSameCoreModel('4o', 'gpt-4o')).toBe(false);
        expect(isSameCoreModel('x', '')).toBe(true);
    });
});

describe('coreModelName 家族錨點裸前綴剝離（兩頭前綴不一樣也能對上）', () => {
    it('兩頭貼不同裸前綴 → 同名', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'vertex-gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', '[逆-V]az-gemini-3.1-pro-preview')).toBe(true);
    });

    it('家族名本身開頭的名字不被誤剝', () => {
        expect(coreModelName('chatgpt-4o-latest')).toBe('chatgpt-4o-latest');
        expect(coreModelName('deepseek-chat')).toBe('deepseek-chat');
        expect(coreModelName('gpt-4o-mini')).toBe('gpt-4o-mini');
    });

    it('剝前綴後尾部變體仍然抓得住', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'az-gemini-3.1-pro-preview-c')).toBe(false);
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'vertex-gemini-3.1-flash-preview')).toBe(false);
    });
});

// 輸入構成統計：回答「prompt_tokens 為什麼這麼大」——system 按 ###/[System:] 塊頭
// 切開逐塊計數，歷史消息按角色聚合。只存統計不存原文。
describe('buildPromptBreakdown', () => {
    it('system 按塊頭切開，歷史按角色聚合', () => {
        const body = JSON.stringify({
            model: 'x',
            messages: [
                { role: 'system', content: '### 你的身份 (Character)\n設定文本\n### 記憶系統 (Memory Bank)\n- 一條記憶\n- 兩條記憶' },
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '嗨嗨' },
                { role: 'user', content: '在嗎' },
                { role: 'system', content: '[System: 實時狀態 (Live Context)]\n現在是晚上' },
            ],
        });
        const blocks = buildPromptBreakdown(body)!;
        const labels = blocks.map(b => b.label);
        expect(labels).toEqual([
            '你的身份 (Character)',
            '記憶系統 (Memory Bank)',
            '[System: 實時狀態 (Live Context)]',
            '聊天歷史·用戶消息 ×2',
            '聊天歷史·角色消息 ×1',
        ]);
        // 字數守恆：system 各塊之和 = 原文長度 + 每行換行補償
        const memBlock = blocks.find(b => b.label.startsWith('記憶系統'))!;
        expect(memBlock.chars).toBeGreaterThan(0);
        expect(blocks.find(b => b.label === '聊天歷史·用戶消息 ×2')!.chars).toBe(4);
    });

    it('無塊頭的短 system（尾部提醒）用首行當名字', () => {
        const blocks = buildPromptBreakdown({
            messages: [{ role: 'system', content: '[MCP 工具 ON · 永遠用角色語氣回覆別空回]' }],
        })!;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].label.startsWith('[MCP 工具 ON')).toBe(true);
    });

    it('多模態 content 攤平計數，圖片按佔位符', () => {
        const blocks = buildPromptBreakdown({
            messages: [
                { role: 'user', content: [{ type: 'text', text: '看圖' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
            ],
        })!;
        // 單條請求走「提示詞整體」標註（見下方 describe），此處只鎖多模態計數口徑
        expect(blocks[0].label).toBe('提示詞整體「看圖 [圖片]」');
        expect(blocks[0].chars).toBe('看圖 [圖片]'.length);
    });

    it('解析不了 / 沒 messages 時返回 undefined', () => {
        expect(buildPromptBreakdown('{broken')).toBeUndefined();
        expect(buildPromptBreakdown({ model: 'x' })).toBeUndefined();
        expect(buildPromptBreakdown(undefined)).toBeUndefined();
    });

    it('病態多塊時合併尾巴限容', () => {
        const sys = Array.from({ length: 80 }, (_, i) => `### 塊${i}\n內容${i}`).join('\n');
        const blocks = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }] })!;
        expect(blocks.length).toBeLessThanOrEqual(48);
        expect(blocks[blocks.length - 1].label).toContain('其餘');
    });
});

// 情緒評估形態：完整上下文打包成一條巨型 user 消息——必須拆塊，否則面板只顯示
// 「用戶消息 ×1 · 100%」，用戶會誤以為評估請求裡沒有角色設定。
describe('buildPromptBreakdown · 巨型 user 消息拆塊', () => {
    it('超閾值且含多個塊頭的 user 消息按 system 同款規則拆開', () => {
        const evalPrompt = [
            '你是一個角色情緒分析系統。請分析角色「Noir」當前的情緒底色狀態。',
            '## 角色此刻看到的完整上下文（與主 API 發送的 system prompt 完全一致）',
            `### 你的身份 (Character)\n${'設'.repeat(6000)}`,
            '## 完整對話歷史（與主 API 看到的消息歷史完全一致）',
            `${'[用戶]: 在嗎\n'.repeat(300)}`,
            '## 任務\n基於以上對話……',
        ].join('\n');
        const blocks = buildPromptBreakdown({ messages: [{ role: 'user', content: evalPrompt }] })!;
        const labels = blocks.map(b => b.label);
        expect(labels.some(l => l.startsWith('角色此刻看到的完整上下文'))).toBe(true);
        expect(labels.some(l => l.startsWith('你的身份'))).toBe(true);
        expect(labels.some(l => l === '任務')).toBe(true);
        expect(labels.some(l => l.startsWith('聊天歷史·用戶消息'))).toBe(false);
    });

    it('普通短 user 消息仍走角色聚合，不拆', () => {
        const blocks = buildPromptBreakdown({
            messages: [
                { role: 'user', content: '## 今天的計劃\n買菜' },
                { role: 'user', content: '在嗎' },
            ],
        })!;
        expect(blocks).toEqual([{ label: '聊天歷史·用戶消息 ×2', chars: '## 今天的計劃\n買菜'.length + 2 }]);
    });
});

// 單條 user 提示詞（記憶提取/日程生成等大量調用點的形態）：標「提示詞整體」而非
// 「聊天歷史」，用首行摘要標識任務。
describe('buildPromptBreakdown · 單條提示詞標註', () => {
    it('無塊頭的單條 user 請求標成「提示詞整體『首行』」', () => {
        const blocks = buildPromptBreakdown({
            messages: [{ role: 'user', content: '請從以下對話中提取記憶事件。\n對話：……' }],
        })!;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].label).toBe('提示詞整體「請從以下對話中提取記憶事件。」');
    });

    it('多條消息時仍按聊天歷史聚合', () => {
        const blocks = buildPromptBreakdown({
            messages: [
                { role: 'system', content: '### 規則\n……' },
                { role: 'user', content: '你好' },
            ],
        })!;
        expect(blocks.map(b => b.label)).toContain('聊天歷史·用戶消息 ×1');
    });
});

// 圍欄感知 + 固定塊識別：行為規範裡的日記示例（``` 內的 ## 行）不能被切成獨立塊；
// 固定骨架塊名能被 isFixedPromptBlockLabel 識別（展示層據此合併）。
describe('buildPromptBreakdown · 圍欄感知與固定塊', () => {
    it('``` 代碼塊內的 ##/### 行不開新塊', () => {
        const sys = [
            '### 聊天 App 行為規範 (Chat App Rules)',
            '規則正文',
            '```',
            '## 今天的小確幸',
            '### 小標題（會變成彩色卡片）',
            '```',
            '規則繼續',
            '### 表達底線 (Anti-Filler)',
            '正文',
        ].join('\n');
        const labels = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] })!
            .map(b => b.label);
        expect(labels).toEqual([
            '聊天 App 行為規範 (Chat App Rules)',
            '表達底線 (Anti-Filler)',
            '聊天歷史·用戶消息 ×1',
        ]);
    });

    it('固定骨架塊名識別，數據塊不誤傷', () => {
        expect(isFixedPromptBlockLabel('聊天 App 行為規範 (Chat App Rules)')).toBe(true);
        expect(isFixedPromptBlockLabel('最後，回到你自己')).toBe(true);
        expect(isFixedPromptBlockLabel('[MCP 工具 ON · 永遠用角色語氣回覆別空回')).toBe(true);
        expect(isFixedPromptBlockLabel('記憶系統 (Memory Bank)')).toBe(false);
        expect(isFixedPromptBlockLabel('底色認知 (Resident Knowledge)')).toBe(false);
        expect(isFixedPromptBlockLabel('[Background Context: Recent Group Activi')).toBe(false);
    });
});

// 落單圍欄防吞噬：用戶數據裡奇數個 ``` 不能把後面所有塊頭吞進上一塊
// （實測事故：記憶摘要帶半個圍欄 → 62K「記憶系統」行吞掉對話歷史+評估框架）。
describe('buildPromptBreakdown · 落單圍欄', () => {
    it('奇數個 ``` 時最後一個不算開欄，後續塊頭照常識別', () => {
        const sys = [
            '### 記憶系統 (Memory Bank)',
            '- 某條記憶裡帶了半個圍欄 ```',
            '### 表達底線 (Anti-Filler)',
            '正文',
            '## 任務',
            '評估任務說明',
        ].join('\n');
        const labels = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] })!
            .map(b => b.label);
        expect(labels).toContain('表達底線 (Anti-Filler)');
        expect(labels).toContain('任務');
    });

    it('成對圍欄仍然屏蔽示例塊頭', () => {
        const sys = '### 規則\n```\n## 示例標題\n```\n### 下一塊\n正文';
        const labels = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] })!
            .map(b => b.label);
        expect(labels).toEqual(['規則', '下一塊', '聊天歷史·用戶消息 ×1']);
    });
});
