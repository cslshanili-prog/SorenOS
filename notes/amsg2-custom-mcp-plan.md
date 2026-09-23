# amsg2 後台支持用戶自配 MCP — 實施計劃（v2：上游透傳 tools）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定時主動消息（amsg2）到點時，worker 能直連用戶自配的 MCP 服務器調工具，結果進最終推送——前台關著也一樣。

**Architecture:** 三處斷點三段修：① MCP 服務器清單（含憑證）作為 `tool_config.mcpServers` 隨既有加密通道上雲；② worker 在 fire 時刻從 tool_config 現場生成工具說明塊拼進 prompt（提示詞與憑據同源同拍）；③ **上游 amsg-server 補上 `tools` 請求體透傳**（它的循環早就會給 assistant 消息補 tool_calls、配對 role:tool 結果，唯獨請求體不會聲明 tools——這次補齊這個不對稱），worker 以 native function calling 為主路，正文協議 `tool_name({...})` 為第二層兜底（與前台聊天的雙層設計完全對齊，由同一個「兼容模式」開關控制）。為此先把 mcpClient/mcpToolBridge 裡的純邏輯抽成環境無關葉子 `utils/mcpFireCore.ts`。

**Tech Stack:** TypeScript、vitest（`pnpm vitest run`）、node:test（ReiStandard）、esbuild worker bundle（`pnpm build:workers`）、node:http e2e harness（`node scripts/amsg2-e2e-harness.mjs`，Node 22+）。

---

## 方案取捨（已定，執行者不需要再選）

上一版計劃選了「純正文協議、不改上游」；經權衡改為**上游透傳 + 雙層**。對比：

| | 純正文協議（v1 方案） | 上游透傳 tools + 正文兜底（本方案） |
|---|---|---|
| 上游改動 | 無 | `llm.js` 透傳 + `normalizeBeforeFireResult` 兩字段 + 循環一行 + assistant 補章改合併，約 30 行 + 測試 |
| 部署聯動 | 無 | **只是 bundle 內自帶**：amsg-server 被 esbuild 打進 worker.bundle.js，升級 = 發預發版 + bump + 重新粘貼，走的就是 2.6.0-next.x 一路走來的熟路 |
| 參數可靠性 | 三形態容錯解析，嵌套參數靠模型手寫 JSON | native FC 結構化傳參為主，正文解析降為第二層 |
| 與前台一致性 | 後台單獨一套「只教正文協議」 | 與前台完全同構：native 優先 + 兼容模式兜底，同一個 `useNativeTools` 開關管兩端 |
| 部署版本歪斜 | **靜默**：老 worker 忽略 mcpServers，無從察覺 | capabilities 新增 `agentic-fire-tools` + 版本門檻，設置頁照現有模式亮「重新粘貼」牌 |
| 庫的合理性 | 繞開庫的缺口 | 修根因：循環已實現 FC 協議的下半場，補上上半場對任何宿主都通用 |

**其餘已定決策（與 v1 相同）：**
- 提示詞塊 worker fire 時生成，不進 fire_pack——沒有陳舊窗口。
- 上雲的服務器**不帶 proxyUrl/proxyKey**（worker 直連、無 CORS），**帶 token/customHeaders**（走 client_state 端到端加密通道，與 notion/飛書憑據同一信任模型）。
- localhost / 私網地址的服務器不上雲（CF worker 打不通）。
- worker 側工具名統一 `mcp__` 前綴（native 聲明時就帶上），杜絕與內置工具（recall/search/…）重名歧義。
- 前台聊天路徑一字不動；instant-push worker 不在本計劃範圍。
- 中轉拒 tools（4xx）的用戶：前台早就會遇到並把「兼容模式」開關撥到關（`aetheros.mcp.useNativeTools='0'`），該開關隨 tool_config 上雲，worker 同樣退到正文協議——不做 fire 內的 4xx 自動重試（庫沒有該 hook，且這類拒絕是確定性的）。

## 文件地圖

| 文件 | 動作 | 職責 |
|---|---|---|
| **ReiStandard** `packages/rei-standard-amsg/server/src/server/lib/llm.js` | 改 | `buildAiRequestBody` 透傳 tools/tool_choice |
| **ReiStandard** `…/lib/agentic-fire.js` | 改 | onBeforeFire 返回值收 tools；每輪 callLlm 帶上；assistant 補章改「native+合成」合併 |
| **ReiStandard** `…/handlers/capabilities.js`、`.changeset/` | 改 | feature `agentic-fire-tools`；版本走 changeset（機器人發版，預計 next.8+） |
| **ReiStandard** `…/test/agentic-fire.test.mjs`、`…/test/message-processor.test.mjs` | 改 | 透傳與合併的迴歸測試 |
| `utils/mcpFireCore.ts` | 新建 | 環境無關 MCP 核心：類型、名映射、傳輸、假調用解析、結果格式化、fire 塊、fire tools 數組 |
| `utils/mcpFireCore.test.ts` | 新建 | 上述純函數單測 |
| `utils/mcpClient.ts` | 改 | 瀏覽器側保留（localStorage/代理/發現），傳輸委託 core；新增 `collectMcpFireServers` |
| `utils/mcpToolBridge.ts` | 改 | 名映射/解析委託 core，原導出名全保留 |
| `utils/amsgToolPack.ts` | 改 | `mcpServers` + `mcpUseNativeTools` 字段 |
| `utils/activeMsgClient.ts` | 改 | `buildToolConfigEntry` 咽喉帶上 MCP 配置 |
| `components/settings/ActiveMsgGlobalSettingsModal.tsx` | 改 | REQUIRED_WORKER_VERSION / FEATURES 抬門檻 |
| `apps/Settings.tsx` | 改 | MCP 卡片保存後觸發 tool_config 重傳 |
| `worker/amsg/src/agentic.ts` | 改 | processLLMRound：native 歸併 + 正文第二層 |
| `worker/amsg/src/index.ts` | 改 | fire 時注入塊與 tools；executeToolCalls 按 `mcp__` 分流；`runMcpFireTool` |
| `scripts/amsg2-e2e-harness.mjs` | 改 | S8 native 場景 + S8b 正文兜底場景 |
| `docs/mcp-user-guide.md`、`docs/mcp-client.md` | 改 | 文檔 |

分支：SullyOS 在 `feat/amsg2-multitask-gate` 上繼續；ReiStandard 按其倉庫慣例開分支、加 changeset（發版由用戶合併 PR 後經 Changesets 機器人完成）。**禁用 `link:../ReiStandard` 聯調後直接提交 lockfile**（有 Netlify frozen install 掛掉的前科）——提交前 `grep ReiStandard pnpm-lock.yaml` 自查。

---

### Task 0: 上游 amsg-server 透傳 tools（ReiStandard 倉庫）

**Files:**
- Modify: `packages/rei-standard-amsg/server/src/server/lib/llm.js:82-118`
- Modify: `packages/rei-standard-amsg/server/src/server/lib/agentic-fire.js:119-134, 301-335, 及 assistant 補章處`
- Modify: `packages/rei-standard-amsg/server/src/server/handlers/capabilities.js:19-27`
- Modify: `packages/rei-standard-amsg/server/src/server/lib/version.js`、`package.json`
- Test: `packages/rei-standard-amsg/server/test/message-processor.test.mjs`、`test/agentic-fire.test.mjs`

- [ ] **Step 1: 寫失敗測試（buildAiRequestBody 透傳）**

追加到 `test/message-processor.test.mjs`（`buildAiRequestBody` 已是具名導出）：

```js
test('buildAiRequestBody forwards tools/tool_choice verbatim; absent when not provided', () => {
  const tools = [{ type: 'function', function: { name: 'mcp__x', parameters: { type: 'object' } } }];
  const withTools = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }], tools, toolChoice: 'auto' });
  assert.deepEqual(withTools.tools, tools);
  assert.equal(withTools.tool_choice, 'auto');

  const without = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('tools' in without, false);
  assert.equal('tool_choice' in without, false);

  // 空數組不透傳（避免部分中轉把 tools: [] 當協議錯誤拒掉）
  const empty = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal('tools' in empty, false);
});
```

- [ ] **Step 2: 寫失敗測試（循環逐輪攜帶 + assistant 合併補章）**

追加到 `test/agentic-fire.test.mjs` 的 `agentic fire loop` describe（沿用文件裡現成的 `makeTask` / `makeCtx` / `stubLlm` / `TOOL_CALL`）：

```js
test('onBeforeFire may return { messages, tools }: every round carries them', async () => {
  const { task } = await makeTask();
  const tools = [{ type: 'function', function: { name: 'mcp__probe', parameters: { type: 'object', properties: {} } } }];
  const decisions = [
    { decision: 'tool-request', toolCalls: [TOOL_CALL] },
    { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
  ];
  let i = 0;
  const hooks = {
    onBeforeFire: async () => ({ messages: [{ role: 'user', content: 'U' }], tools }),
    onLLMOutput: async () => decisions[i++],
    executeToolCalls: async () => [{ tool_call_id: 'call_1', role: 'tool', content: '{}' }],
  };
  const llm = stubLlm([toolRound, finishRound]);
  try {
    await processSingleMessage(task, makeCtx({ hooks, pushSpy: () => {} }));
    assert.deepEqual(llm.calls[0].body.tools, tools);   // 第 1 輪帶 tools
    assert.deepEqual(llm.calls[1].body.tools, tools);   // 工具輪之後同樣帶
  } finally { llm.restore(); }
});

test('assistant stamping merges native tool_calls with synthesized ones (no orphan role:tool)', async () => {
  const { task } = await makeTask();
  const nativeCall = { id: 'call_native', type: 'function', function: { name: 'mcp__probe', arguments: '{}' } };
  const synthesized = { id: 'call_tag', type: 'function', function: { name: 'recall', arguments: '{"month":"2026-06"}' } };
  const decisions = [
    { decision: 'tool-request', toolCalls: [nativeCall, synthesized] },  // 同輪 native + 文本合成
    { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
  ];
  let i = 0;
  const hooks = {
    onBeforeFire: async () => [{ role: 'user', content: 'U' }],
    onLLMOutput: async () => decisions[i++],
    executeToolCalls: async (calls) => calls.map((c) => ({ tool_call_id: c.id, role: 'tool', content: '{}' })),
  };
  // 第 1 輪響應裡 assistant 自帶 native tool_calls
  const nativeRound = { choices: [{ message: { role: 'assistant', content: '旁白', tool_calls: [nativeCall] } }] };
  const llm = stubLlm([nativeRound, finishRound]);
  try {
    await processSingleMessage(task, makeCtx({ hooks, pushSpy: () => {} }));
    const round2 = llm.calls[1].body.messages;
    const assistant = round2.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    // native + 合成的都在 assistant.tool_calls 裡，兩條 role:tool 都有歸屬
    assert.deepEqual(assistant.tool_calls.map((tc) => tc.id).sort(), ['call_native', 'call_tag']);
  } finally { llm.restore(); }
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd ../ReiStandard/packages/rei-standard-amsg/server && node --test test/`
Expected: 新用例 FAIL

- [ ] **Step 4: 實現 llm.js 透傳**

`buildAiRequestBody` 中 `requestBody` 組好之後、`maxTokens` 段之前插入：

```js
  // tools mode (added in v2.6.0): forward the caller's OpenAI tools array
  // verbatim — same philosophy as messages mode above. The agentic loop
  // already appends assistant tool_calls + role:'tool' results; this is
  // the request-side half of the same protocol.
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    requestBody.tools = payload.tools;
    if (payload.toolChoice !== undefined && payload.toolChoice !== null) {
      requestBody.tool_choice = payload.toolChoice;
    }
  }
```

- [ ] **Step 5: 實現 agentic-fire.js 三處**

`normalizeBeforeFireResult`（119 行）對象分支加兩字段（報錯文案同步提及 tools）：

```js
    return {
      messages: result.messages,
      maxToolIterations: result.maxToolIterations,
      totalTimeoutMs: result.totalTimeoutMs,
      tools: Array.isArray(result.tools) && result.tools.length > 0 ? result.tools : undefined,
      toolChoice: result.toolChoice,
    };
```

每輪 callLlm（326 行）帶上：

```js
    const { response: llmResponse } = await callLlm(
      {
        ...decryptedPayload,
        messages,
        ...(normalized.tools ? { tools: normalized.tools, toolChoice: normalized.toolChoice } : {}),
      },
      { requireContent: false, timeoutMs: roundTimeoutMs }
    );
```

assistant 補章處（現為「native 有就原樣、沒有才蓋合成的」二選一）改為**按 id 合併**——native 與文本合成同輪並存時，兩邊的 role:'tool' 結果都要有歸屬，否則嚴格中轉會拒第 2 輪：

```js
    const nativeCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    const nativeIds = new Set(nativeCalls.map((tc) => tc && tc.id));
    const synthesized = toolCalls.filter((tc) => !nativeIds.has(tc && tc.id));
    const assistantWithTools = synthesized.length === 0
      ? assistantMessage
      : { ...assistantMessage, tool_calls: [...nativeCalls, ...synthesized] };
```

- [ ] **Step 6: capabilities + 版本**

`capabilities.js` 的 `SERVER_FEATURES` 追加 `'agentic-fire-tools'`。

版本：**不手改** `version.js` / `package.json`——該倉庫版本由 Changesets 機器人 PR 抬（`version.js` 是 tsup 構建期注入），手改會跟機器人打架。按倉庫先例（`79da9e4`）添加 `.changeset/*.md`（minor），實際發版號由發版時的機器人 PR 決定（main 已在 next.7，預計 next.8+）。

- [ ] **Step 7: 跑測試確認通過**

Run: `node --test test/`
Expected: 全 PASS（既有用例全綠 = 合併補章不迴歸）

- [ ] **Step 8: Commit + 發版 + SullyOS bump**

```bash
# ReiStandard 倉庫內：只 git add 明確改過的文件（倉庫可能有無關髒改動），開分支提交、開 PR。
# 不發版——發版 = 用戶合併 PR + Changesets 機器人 PR，發出來的號記為 <released>（≥ 2.6.0-next.8）。
# 用戶發版之後，回到 SullyOS:
pnpm update @rei-standard/amsg-server
grep -c ReiStandard pnpm-lock.yaml   # 必須為 0（link: 汙染自查）
pnpm build:workers && pnpm vitest run
git add package.json pnpm-lock.yaml worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "chore(amsg2): amsg-server 升 <released>（fire 支持 tools 透傳）"
```

---

### Task 1: mcpFireCore 骨架 — 類型與工具名映射

**Files:**
- Create: `utils/mcpFireCore.ts`
- Create: `utils/mcpFireCore.test.ts`
- Modify: `utils/mcpToolBridge.ts:27-63`（sanitize/slug/映射邏輯改為委託）

- [ ] **Step 1: 寫失敗測試**

`utils/mcpFireCore.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildMcpNameMap, filterMcpServersForChar, type McpFireServer } from './mcpFireCore';

const srv = (over: Partial<McpFireServer>): McpFireServer => ({
  id: 's1', name: '服務器A', url: 'https://a.example.com/mcp',
  tools: [{ name: 'get_weather' }],
  ...over,
});

describe('buildMcpNameMap', () => {
  it('工具名 sanitize 成 OpenAI 允許的字符集', () => {
    const map = buildMcpNameMap([srv({ tools: [{ name: 'ns.get/weather' }] })]);
    expect([...map.keys()]).toEqual(['ns_get_weather']);
    expect(map.get('ns_get_weather')).toMatchObject({ toolName: 'ns.get/weather' });
  });

  it('跨服務器重名時後者加服務器前綴', () => {
    const map = buildMcpNameMap([
      srv({ id: 's1', name: 'AAA', tools: [{ name: 'search' }] }),
      srv({ id: 's2', name: 'BBB', tools: [{ name: 'search' }] }),
    ]);
    expect([...map.keys()]).toEqual(['search', 'BBB_search']);
    expect(map.get('BBB_search')?.server.id).toBe('s2');
  });
});

describe('filterMcpServersForChar', () => {
  it('charIds 為空 = 通用；非空 = 只對綁定角色可見', () => {
    const servers = [
      srv({ id: 'g', charIds: undefined }),
      srv({ id: 'bound', charIds: ['char-1'] }),
      srv({ id: 'other', charIds: ['char-2'] }),
    ];
    expect(filterMcpServersForChar(servers, 'char-1').map((s) => s.id)).toEqual(['g', 'bound']);
  });

  it('沒有 url 或沒發現工具的不進清單; 入參 undefined 得空數組', () => {
    expect(filterMcpServersForChar([srv({ url: '' }), srv({ tools: [] })], 'c')).toEqual([]);
    expect(filterMcpServersForChar(undefined, 'c')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run utils/mcpFireCore.test.ts`
Expected: FAIL（模塊不存在）

- [ ] **Step 3: 實現 mcpFireCore 第一段**

`utils/mcpFireCore.ts`：

```ts
/**
 * mcpFireCore — 通用 MCP 的環境無關核心（瀏覽器 / amsg worker 共用葉子）。
 *
 * mcpClient.ts 管瀏覽器側的事（localStorage 配置、代理包裝、發現流程）；
 * 這裡只放兩端都要跑的純邏輯：工具名映射、JSON-RPC 傳輸、正文假調用解析、
 * 結果格式化、後台 fire 的提示詞塊與 tools 數組。
 *
 * 環境無關葉子模塊：不 import 任何帶瀏覽器依賴的東西（會進 worker bundle）。
 */

export interface McpFireToolDef {
  name: string;
  description?: string;
  inputSchema?: any;
}

/**
 * 上雲 / 進 worker 的服務器形狀：McpServerConfig 的結構子集
 * （沒有 proxyUrl/proxyKey——worker 側 fetch 沒有 CORS，直連 url）。
 */
export interface McpFireServer {
  id: string;
  name: string;
  url: string;
  /** Bearer Token，可選（Authorization: Bearer <token>） */
  token?: string;
  customHeaders?: Array<{ name: string; value: string }>;
  /** 空/缺省 = 通用；非空 = 只有這些角色可見（與 mcpClient.getEnabledMcpServers 同語義） */
  charIds?: string[];
  tools?: McpFireToolDef[];
}

export interface McpResolvedToolCore<S extends McpFireServer = McpFireServer> {
  server: S;
  toolName: string;
}

// OpenAI 工具名只允許 [A-Za-z0-9_-]，最長 64；MCP 工具名可能帶點號等
export const sanitizeMcpToolName = (name: string): string =>
  (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';

const serverSlug = (server: McpFireServer): string =>
  sanitizeMcpToolName(server.name).slice(0, 20) || 'srv';

/**
 * 暴露名 → 真實工具 的映射。暴露名默認用工具原名（sanitize 後）；
 * 跨服務器重名時後者加 <服務器名>_ 前綴。前台 buildMcpOpenAITools 與
 * worker fire 路徑都用這一份，保證兩端看到同一套名字。
 */
export const buildMcpNameMap = <S extends McpFireServer>(
  servers: S[],
): Map<string, McpResolvedToolCore<S>> => {
  const resolve = new Map<string, McpResolvedToolCore<S>>();
  for (const server of servers) {
    for (const t of server.tools || []) {
      let exposed = sanitizeMcpToolName(t.name);
      if (resolve.has(exposed)) {
        exposed = sanitizeMcpToolName(`${serverSlug(server)}_${t.name}`);
        let i = 2;
        while (resolve.has(exposed)) exposed = sanitizeMcpToolName(`${serverSlug(server)}_${t.name}_${i++}`);
      }
      resolve.set(exposed, { server, toolName: t.name });
    }
  }
  return resolve;
};

/** fire 時按角色過濾可見服務器（與 getEnabledMcpServers 的 charIds 語義一致）。 */
export const filterMcpServersForChar = <S extends McpFireServer>(
  servers: S[] | undefined,
  charId: string,
): S[] =>
  (servers || []).filter((s) =>
    !!s.url && (s.tools?.length || 0) > 0 &&
    (!s.charIds?.length || s.charIds.includes(charId)),
  );
```

- [ ] **Step 4: mcpToolBridge 委託給 core**

`utils/mcpToolBridge.ts`：刪掉本地的 `sanitizeToolName`（27-29 行）與 `serverSlug`（31-32 行），`buildMcpOpenAITools`（39-63 行）改為：

```ts
import { buildMcpNameMap } from './mcpFireCore';
// ResolvedMcpTool 保持原導出形狀（server: McpServerConfig），調用方零改動
export const buildMcpOpenAITools = (charId?: string): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const servers = getEnabledMcpServers(charId);
    const resolve = buildMcpNameMap(servers);
    const tools: OpenAIMcpTool[] = [];
    for (const [exposed, { server, toolName }] of resolve) {
        const t = (server.tools || []).find((d) => d.name === toolName);
        if (!t) continue;
        tools.push({
            type: 'function',
            function: {
                name: exposed,
                description: buildToolDescription(server, t, servers.length > 1),
                parameters: t.inputSchema || { type: 'object', properties: {} },
            },
        });
    }
    return { tools, resolve };
};
```

- [ ] **Step 5: 跑測試確認通過（含既有迴歸）**

Run: `pnpm vitest run utils/mcpFireCore.test.ts utils/mcpClient.test.ts`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpFireCore.test.ts utils/mcpToolBridge.ts
git commit -m "refactor(mcp): 工具名映射抽進環境無關核心 mcpFireCore"
```

---

### Task 2: 正文假調用解析遷入 core

**Files:**
- Modify: `utils/mcpFireCore.ts`（追加）
- Modify: `utils/mcpToolBridge.ts:125-351`（解析段整體遷走，re-export 保名）

- [ ] **Step 1: 遷移（純搬家，邏輯零改動）**

把 `utils/mcpToolBridge.ts` 中以下符號**原樣搬**到 `utils/mcpFireCore.ts`（含註釋）：

- `escapeRegExp`（204 行）、`stripQuotes`（206-210）、`positionalKeys`（213-217）、`coerceBySchema`（219-231）、`splitTopLevel`（234-251）、`parseFakedArgs`（254-285）
- `stripTextFakedMcpCalls`（144-148）、`extractTextFakedMcpCalls`（291-351）
- `FakedMcpCall` 接口（135-141）
- `MCP_RESULT_MAX_CHARS`（78）、`formatMcpToolResult`（80-86）

類型上唯一的改動：泛型化——

```ts
export interface FakedMcpCall<S extends McpFireServer = McpFireServer> {
    exposedName: string;
    server: S;
    toolName: string;
    args: Record<string, any>;
    matched: string;
}

export const extractTextFakedMcpCalls = <S extends McpFireServer>(
    content: string,
    resolve: Map<string, McpResolvedToolCore<S>>,
): FakedMcpCall<S>[] => { /* 函數體原樣 */ };

export const stripTextFakedMcpCalls = (content: string, calls: Array<{ matched: string }>): string => { /* 原樣 */ };
```

- [ ] **Step 2: mcpToolBridge 改為 re-export（原導出名一個不少）**

```ts
export {
    MCP_RESULT_MAX_CHARS,
    formatMcpToolResult,
    stripTextFakedMcpCalls,
    extractTextFakedMcpCalls,
} from './mcpFireCore';
export type { FakedMcpCall } from './mcpFireCore';
```

- [ ] **Step 3: 跑全量 MCP 相關測試**

Run: `pnpm vitest run utils/mcpClient.test.ts utils/mcpFireCore.test.ts utils/xhsMcpClient.concurrency.test.ts`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpToolBridge.ts
git commit -m "refactor(mcp): 正文假調用解析遷入 mcpFireCore"
```

---

### Task 3: JSON-RPC 傳輸層遷入 core

**Files:**
- Modify: `utils/mcpFireCore.ts`（追加傳輸段）
- Modify: `utils/mcpClient.ts:130-534`（session/post/initialize/callMcpTool 委託給 core）

- [ ] **Step 1: core 傳輸層公開面**

在 `utils/mcpFireCore.ts` 追加。**搬家部分**（從 `utils/mcpClient.ts` 原樣搬，含註釋）：`parseSse`（214-224）、`parseResp`（226-236）、`readSseResponse`（238-274）、`normalizeMcpValueBySchema` 一族（394-474，含 `isRecord`/`resolveLocalSchemaRef`/`schemaAccepts`/`normalizeMcpToolArguments`）、`McpToolResult` 接口（51-56）、`MCP_PROTOCOL_VERSION`（60）、`MCP_REQUEST_TIMEOUT_MS`（63）。

**新寫部分**（把綁死 localStorage 配置和模塊級 session Map 的機制改成顯式傳參）：

```ts
/** 一個 MCP 服務器連接的會話狀態。持有者自己決定生命週期：
 *  瀏覽器 = 模塊級 Map（跨輪複用）；worker = 掛在單次 fire 的 stash 上。 */
export interface McpSessionState {
  sessionId: string | null;
  initialized: boolean;
  initPromise: Promise<void> | null;
  nextId: number;
}
export const createMcpSessionState = (): McpSessionState =>
  ({ sessionId: null, initialized: false, initPromise: null, nextId: 0 });

/** 一次請求的目標：最終 URL + 請求頭構造。瀏覽器側包代理，worker 側直連。 */
export interface McpTransportTarget {
  url: string;
  headers: (sessionId: string | null) => Headers | Record<string, string>;
}

const buildRpcRequest = (session: McpSessionState, method: string, params?: any, isNotification = false) => {
  const req: { jsonrpc: '2.0'; method: string; params?: any; id?: number } = { jsonrpc: '2.0', method, params };
  if (!isNotification) req.id = ++session.nextId;
  return req;
};

const postCore = async (
  target: McpTransportTarget,
  session: McpSessionState,
  body: ReturnType<typeof buildRpcRequest>,
  timeoutMs: number,
  expectResponse = true,
) => { /* mcpClient.ts post() 276-345 的函數體原樣搬入，機械替換：
         - buildMcpFetchUrl(server) → target.url
         - buildMcpRequestHeaders(server, session.sessionId) → target.headers(session.sessionId)
         - MCP_REQUEST_TIMEOUT_MS → timeoutMs（報錯文案裡的秒數同步換算）
         - CORS 提示分支話術保持原文（瀏覽器仍是主要用戶） */ };

const initializeCore = async (target: McpTransportTarget, session: McpSessionState, timeoutMs: number): Promise<void> => {
  /* doInitialize 347-363 原樣搬入：post→postCore，clientInfo 不變（SullyOS-MCP/1.0.0） */
};

const ensureInitializedCore = async (target: McpTransportTarget, session: McpSessionState, timeoutMs: number): Promise<void> => {
  /* ensureInitialized 365-375 原樣搬入 */
};

/** 握手 + tools/list（瀏覽器發現流程用；worker 不需要——工具清單隨 tool_config 上雲）。 */
export const discoverMcpToolsCore = async (
  target: McpTransportTarget,
  session: McpSessionState,
  timeoutMs: number,
): Promise<McpFireToolDef[]> => { /* discoverMcpTools 380-392 函數體原樣搬入 */ };

/**
 * 調一個工具（自動補握手；HTTP 400/404 視為 session 失效，重握手一次）。
 * inputSchema 用於把中轉雙重編碼的參數按 schema 還原（normalizeMcpToolArguments）。
 */
export const callMcpToolCore = async (
  target: McpTransportTarget,
  session: McpSessionState,
  toolName: string,
  args: Record<string, any>,
  opts: { timeoutMs?: number; inputSchema?: any; resetSession?: () => void } = {},
): Promise<McpToolResult> => {
  /* callMcpTool 477-534 的 try 塊原樣搬入，機械替換：
     - server.tools 查 schema → opts.inputSchema
     - post → postCore(target, session, ..., timeoutMs)
     - resetMcpSession(server.id); await ensureInitialized(server)
       → (opts.resetSession ?? (() => { Object.assign(session, createMcpSessionState()); }))();
         await ensureInitializedCore(target, session, timeoutMs)
     - finish() 裡的 console.info 日誌保留（server 名換成 target.url 的 host） */
};

/** worker 直連請求頭（瀏覽器側的代理頭邏輯留在 mcpClient.buildMcpRequestHeaders）。 */
export const buildMcpDirectHeaders = (
  server: McpFireServer,
  sessionId: string | null,
): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  for (const item of server.customHeaders || []) {
    const name = String(item?.name || '').trim();
    const value = String(item?.value || '').trim();
    if (name && value) headers[name] = value;
  }
  if (server.token) headers['Authorization'] = `Bearer ${server.token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return headers;
};
```

- [ ] **Step 2: mcpClient 委託**

`utils/mcpClient.ts` 刪掉已搬走的實現，瀏覽器側薄殼：

```ts
import {
    callMcpToolCore, createMcpSessionState, discoverMcpToolsCore, normalizeMcpToolArguments,
    MCP_REQUEST_TIMEOUT_MS, type McpSessionState, type McpToolResult,
} from './mcpFireCore';
export { MCP_REQUEST_TIMEOUT_MS, normalizeMcpToolArguments };
export type { McpToolResult };

const sessions = new Map<string, McpSessionState>();
const getSession = (serverId: string): McpSessionState => {
    let s = sessions.get(serverId);
    if (!s) { s = createMcpSessionState(); sessions.set(serverId, s); }
    return s;
};
export const resetMcpSession = (serverId: string): void => { sessions.delete(serverId); };

const targetFor = (server: McpServerConfig) => ({
    url: buildMcpFetchUrl(server),
    headers: (sessionId: string | null) => buildMcpRequestHeaders(server, sessionId),
});

export const callMcpTool = async (
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any> = {},
): Promise<McpToolResult> =>
    callMcpToolCore(targetFor(server), getSession(server.id), toolName, args, {
        inputSchema: (server.tools || []).find((t) => t.name === toolName)?.inputSchema,
        resetSession: () => { sessions.set(server.id, createMcpSessionState()); },
    });

export const discoverMcpTools = async (server: McpServerConfig): Promise<McpToolDef[]> => {
    resetMcpSession(server.id);
    return discoverMcpToolsCore(targetFor(server), getSession(server.id), MCP_REQUEST_TIMEOUT_MS);
};
```

`buildMcpFetchUrl` / `buildMcpRequestHeaders` / 配置 CRUD / 導入導出 / `testMcpConnection` 留在 mcpClient 不動。

- [ ] **Step 3: 跑全量既有測試（重構不迴歸的硬門檻）**

Run: `pnpm vitest run utils/mcpClient.test.ts utils/mcpFireCore.test.ts`
Expected: 全 PASS（SSE 解析、雙重編碼還原、fallback body 的既有用例綠了才算搬乾淨）

- [ ] **Step 4: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpClient.ts
git commit -m "refactor(mcp): JSON-RPC 傳輸層遷入 mcpFireCore, 瀏覽器側委託"
```

---

### Task 4: fire 的提示詞塊與 tools 數組

**Files:**
- Modify: `utils/mcpFireCore.ts`（追加 `buildMcpFireBlock` + `buildMcpFireTools`）
- Modify: `utils/mcpFireCore.test.ts`

- [ ] **Step 1: 寫失敗測試**

追加到 `utils/mcpFireCore.test.ts`：

```ts
import { buildMcpFireBlock, buildMcpFireTools } from './mcpFireCore';

describe('buildMcpFireBlock / buildMcpFireTools', () => {
  const servers = [srv({
    tools: [{
      name: 'get_weather',
      description: '查天氣',
      inputSchema: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'number' } }, required: ['city'] },
    }],
  })];
  const map = buildMcpNameMap(servers);

  it('native 模式：只講紀律，不教正文協議', () => {
    const block = buildMcpFireBlock(map, { mode: 'native' });
    expect(block).toContain('get_weather');
    expect(block).toContain('不要編造結果');
    expect(block).not.toContain('tool_name({"參數":"值"})');
  });

  it('text 模式：簽名含必填星標與類型，教正文協議', () => {
    const block = buildMcpFireBlock(map, { mode: 'text' });
    expect(block).toContain('get_weather(city*:string, days:number)');
    expect(block).toContain('tool_name({"參數":"值"})');
  });

  it('空映射返回空串', () => {
    expect(buildMcpFireBlock(new Map(), { mode: 'native' })).toBe('');
  });

  it('fire tools 數組帶 mcp__ 前綴與來源標註', () => {
    const tools = buildMcpFireTools(map);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'mcp__get_weather', description: '[服務器A] 查天氣' },
    });
    expect((tools[0].function as any).parameters.required).toEqual(['city']);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run utils/mcpFireCore.test.ts`
Expected: FAIL（未導出）

- [ ] **Step 3: 實現**

（勘誤：下面參考代碼裡的來源標註/描述前綴判據 `resolve.size > 1` 應為「按 server.id 去重後的台數 > 1」，
與前台 buildToolDescription 的 servers.length > 1 對齊；返回類型具名為 `McpFireOpenAITool`。
以 Task 4 修正輪的實際代碼為準。）

追加到 `utils/mcpFireCore.ts`：

```ts
/**
 * fire 請求的 tools 數組（native 模式）。暴露名直接帶 mcp__ 前綴——模型按這個名字
 * 調回來，executeToolCalls 零歧義分流，不會撞內置工具（recall/search/…）的名字。
 */
export const buildMcpFireTools = <S extends McpFireServer>(
  resolve: Map<string, McpResolvedToolCore<S>>,
): Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }> => {
  const tools = [];
  // Task 1 修正輪後 McpResolvedToolCore 自帶 tool 定義，不再 find 反查（同服務器
  // 重名工具不會串台）。resolve 必須是用 { maxNameLen: 59 } 建的（見 Task 6）——
  // 拼上 mcp__ 前綴後不超 OpenAI 的 64 字符工具名上限。
  for (const [exposed, { server, tool }] of resolve) {
    tools.push({
      type: 'function' as const,
      function: {
        name: `mcp__${exposed}`,
        description: `[${server.name}] ${(tool.description || '').trim()}`.trim(),
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      },
    });
  }
  return tools;
};

/**
 * 後台 fire 的 MCP 工具說明塊（worker 到點拼進 user prompt 尾部）。
 *
 * native 模式（默認）：tools 參數已隨請求聲明，這裡只列來源和紀律——與前台
 * buildMcpSystemBlock 的口徑一致，不教正文語法（教了反而勾引模型往正文裡寫）。
 * text 模式（用戶在設置裡關掉「兼容模式」開關 = 中轉拒 tools 時）：請求不帶
 * tools 參數，這裡教正文協議 tool_name({...})，簽名格式與前台
 * buildMcpRejectedToolsFallbackBody 對齊——同一個模型兩端見到的長一個樣。
 */
export const buildMcpFireBlock = <S extends McpFireServer>(
  resolve: Map<string, McpResolvedToolCore<S>>,
  opts: { mode: 'native' | 'text'; userName?: string },
): string => {
  if (!resolve.size) return '';
  const userName = opts.userName || '用戶';
  const lines: string[] = [];
  for (const [exposed, { server, tool }] of resolve) {
    const desc = (tool.description || '').trim();
    if (opts.mode === 'native') {
      lines.push(`- ${exposed}${desc ? `：${desc}` : ''}${resolve.size > 1 ? `（來源: ${server.name}）` : ''}`);
      continue;
    }
    const schema = tool.inputSchema || {};
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const args = Object.entries(schema.properties || {}).map(([name, d]: [string, any]) =>
      `${name}${required.has(name) ? '*' : ''}:${d?.type || 'any'}`);
    lines.push(`- ${exposed}(${args.join(', ')})${desc ? `：${desc}` : ''}${resolve.size > 1 ? `（來源: ${server.name}）` : ''}`);
  }
  const howTo = opts.mode === 'native'
    ? '需要時直接通過系統的工具調用接口發起（系統會自動執行並把結果給你），不要把工具名和參數寫進正文。'
    : '需要工具時，單獨輸出一行 tool_name({"參數":"值"})，系統會代為執行並把結果給你，然後你繼續寫。* 表示必填參數。';
  return [
    '',
    '---',
    `【外部工具 —— ${userName} 在設置裡給你連了 MCP 工具服務器，主動消息裡也可以用】`,
    howTo,
    '紀律：不需要就別硬調；沒收到系統返回前不要聲稱工具成功，也不要編造結果；工具失敗就換個方式或如實帶過；結果只挑相關部分用角色語氣轉述，別復讀 JSON。',
    '可用工具：',
    ...lines,
    '---',
  ].join('\n');
};
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm vitest run utils/mcpFireCore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpFireCore.test.ts
git commit -m "feat(amsg2): fire 的 MCP 提示詞塊（native/text 雙模）與 tools 數組"
```

---

### Task 5: MCP 配置隨 tool_config 上雲

**Files:**
- Modify: `utils/amsgToolPack.ts`（`mcpServers` + `mcpUseNativeTools` 字段）
- Modify: `utils/mcpClient.ts`（新增 `collectMcpFireServers`）
- Modify: `utils/activeMsgClient.ts:457-465`（buildToolConfigEntry 咽喉）
- Modify: `apps/Settings.tsx`（保存鉤子）
- Test: `utils/amsgToolPack.test.ts`、`utils/mcpClient.test.ts`

- [ ] **Step 1: 寫失敗測試（amsgToolPack）**

追加到 `utils/amsgToolPack.test.ts` 的 `buildToolConfig / parseToolConfig` describe：

```ts
it('mcp 配置隨 tool_config 往返, 壞條目被丟棄', () => {
  const servers = [{
    id: 's1', name: '探針', url: 'https://probe.example.com',
    token: 'tok', tools: [{ name: 'get_secret' }],
  }];
  const config = buildToolConfig(undefined, { servers, useNativeTools: false });
  const parsed = parseToolConfig(JSON.stringify(config));
  expect(parsed?.mcpServers).toEqual(servers);
  expect(parsed?.mcpUseNativeTools).toBe(false);

  const dirty = { ...config, mcpServers: [servers[0], { id: 'bad' }, null, { name: 'x', url: 'u' }] };
  expect(parseToolConfig(JSON.stringify(dirty))?.mcpServers).toEqual(servers);
});

it('不傳 mcp 配置時兩個字段都不出現（老 worker 解析零影響）', () => {
  const config = buildToolConfig(undefined);
  expect('mcpServers' in config).toBe(false);
  expect('mcpUseNativeTools' in config).toBe(false);
});
```

- [ ] **Step 2: 寫失敗測試（collectMcpFireServers）**

追加到 `utils/mcpClient.test.ts`（沿用文件現成的 localStorage 清理）：

```ts
import { collectMcpFireServers } from './mcpClient';

describe('collectMcpFireServers', () => {
  it('只帶 enabled + 已發現工具 + 公網地址; 剝代理字段、留 token', () => {
    localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
      { id: 'a', name: 'ok', url: 'https://mcp.example.com', enabled: true, token: 'tok', proxyUrl: 'https://proxy.x', proxyKey: 'pk', charIds: ['c1'], tools: [{ name: 't1', inputSchema: { type: 'object' } }], updatedAt: 1 },
      { id: 'b', name: 'disabled', url: 'https://x.com', enabled: false, tools: [{ name: 't' }], updatedAt: 1 },
      { id: 'c', name: 'no-tools', url: 'https://y.com', enabled: true, tools: [], updatedAt: 1 },
      { id: 'd', name: 'local', url: 'http://localhost:18061/mcp', enabled: true, tools: [{ name: 't' }], updatedAt: 1 },
      { id: 'e', name: 'lan', url: 'http://192.168.1.5/mcp', enabled: true, tools: [{ name: 't' }], updatedAt: 1 },
    ]));
    const out = collectMcpFireServers();
    expect(out.map((s) => s.id)).toEqual(['a']);
    expect(out[0]).toEqual({
      id: 'a', name: 'ok', url: 'https://mcp.example.com', token: 'tok',
      charIds: ['c1'], tools: [{ name: 't1', description: undefined, inputSchema: { type: 'object' } }],
    });
    expect('proxyUrl' in out[0]).toBe(false);
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `pnpm vitest run utils/amsgToolPack.test.ts utils/mcpClient.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 4: 實現 amsgToolPack 側**

`utils/amsgToolPack.ts`：

```ts
import type { McpFireServer } from './mcpFireCore';   // type-only, 不碰運行時

// AmsgToolConfig 追加字段：
export interface AmsgToolConfig extends AgenticToolRealtimeConfig {
  // …既有字段不動…
  /**
   * 用戶自配的通用 MCP 服務器（enabled 且已發現工具、worker 夠得著的那部分，
   * 見 mcpClient.collectMcpFireServers）。代理字段不上雲——worker 直連沒有 CORS。
   */
  mcpServers?: McpFireServer[];
  /** 前台「兼容模式」同款開關：false = 中轉拒 tools，worker 退到正文協議。缺省按 true。 */
  mcpUseNativeTools?: boolean;
}

// buildToolConfig 加可選參（不讀 localStorage, 保持環境無關；由瀏覽器側調用方傳入）：
export const buildToolConfig = (
  realtimeConfig: RealtimeConfig | undefined,
  mcp?: { servers: McpFireServer[]; useNativeTools: boolean },
): AmsgToolConfig => {
  // …函數體不動，返回對象末尾加：
  //   ...(mcp?.servers.length ? { mcpServers: mcp.servers, mcpUseNativeTools: mcp.useNativeTools } : {}),
};

// parseToolConfig 裡 return 前加輕校驗（壞條目丟棄，不炸 fire 鏈）：
const cleaned = Array.isArray(parsed.mcpServers)
  ? parsed.mcpServers.filter((s: any) =>
      s && typeof s === 'object' &&
      typeof s.id === 'string' && typeof s.name === 'string' &&
      typeof s.url === 'string' && Array.isArray(s.tools))
  : undefined;
if (cleaned?.length) parsed.mcpServers = cleaned; else delete parsed.mcpServers;
```

- [ ] **Step 5: 實現 collectMcpFireServers（mcpClient.ts）**

```ts
import type { McpFireServer } from './mcpFireCore';

/** CF worker 直連打不通的地址（localhost/私網）不上雲——上了只會教角色用一個必失敗的工具。 */
const isWorkerReachableUrl = (url: string): boolean => {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return false;
        const h = u.hostname;
        return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ||
            /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h));
    } catch { return false; }
};

/**
 * 上雲給 amsg worker 用的服務器子集。注意不走 getEnabledMcpServers：
 * 那個函數缺 charId 時只回通用服務器，而這裡要的是全部 enabled（含綁定角色的），
 * charIds 原樣帶上、由 worker 在 fire 時按角色過濾。
 */
export const collectMcpFireServers = (): McpFireServer[] =>
    loadMcpServers()
        .filter((s) => s.enabled && s.url && (s.tools?.length || 0) > 0 && isWorkerReachableUrl(s.url))
        .map((s) => ({
            id: s.id, name: s.name, url: s.url,
            ...(s.token ? { token: s.token } : {}),
            ...(s.customHeaders?.length ? { customHeaders: s.customHeaders } : {}),
            ...(s.charIds?.length ? { charIds: s.charIds } : {}),
            tools: (s.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }));
```

- [ ] **Step 6: 咽喉接線（activeMsgClient.ts:457）**

```ts
import { collectMcpFireServers, getMcpUseNativeTools } from './mcpClient';

const buildToolConfigEntry = (
  realtimeConfig: RealtimeConfig | undefined,
  updatedAt: number,
) => ({
  namespace: AMSG_GLOBAL_NAMESPACE,
  key: AMSG_TOOL_CONFIG_KEY,
  // MCP 配置在這裡現讀現帶：三條上傳路徑（排程 / fire_pack 沖刷 / 設置保存）
  // 全走這個咽喉，不會出現某條路漏帶的版本分叉。
  value: JSON.stringify(buildToolConfig(realtimeConfig, {
    servers: collectMcpFireServers(),
    useNativeTools: getMcpUseNativeTools(),
  })),
  updatedAt,
});
```

- [ ] **Step 7: 設置頁保存鉤子（apps/Settings.tsx）**

`McpServersCard`（107 行起）加可選 prop，persist（117 行 saveMcpServers 處）與「兼容模式」開關切換（setMcpUseNativeTools 調用處）之後都調它：

```tsx
const McpServersCard: React.FC<{ addToast: (msg: string, type?: any) => void; onMcpConfigChanged?: () => void }> =
    ({ addToast, onMcpConfigChanged }) => {
    // persist 內 saveMcpServers(next) 之後、以及 setMcpUseNativeTools(...) 之後追加：
    //   onMcpConfigChanged?.();
```

父組件（3097 行）傳入：

```tsx
<McpServersCard addToast={addToast} onMcpConfigChanged={() => {
    // MCP 配置變更只需重傳 tool_config：提示詞塊與 tools 數組由 worker 在 fire 時
    // 從 tool_config 現場生成（見 mcpFireCore），不經過 fire_pack，沒有陳舊問題，
    // 所以不用像實時感知那樣連提示詞一起刷（syncAmsgToolConfigAndPrompts）。
    // 沒配 amsg2 時 ensureWorkerReady 會拋，吞掉即可——與 amsgStateSync:157 同款。
    ActiveMsgClient.syncToolConfig(realtimeConfig).catch(() => {});
}} />
```

（`ActiveMsgClient` 若未在 Settings.tsx import，則從 `../utils/activeMsgClient` 引入。）

- [ ] **Step 8: 跑測試確認通過**

Run: `pnpm vitest run utils/amsgToolPack.test.ts utils/mcpClient.test.ts utils/activeMsgClient.test.ts`
Expected: 全 PASS

- [ ] **Step 9: Commit**

```bash
git add utils/amsgToolPack.ts utils/mcpClient.ts utils/activeMsgClient.ts apps/Settings.tsx utils/amsgToolPack.test.ts utils/mcpClient.test.ts
git commit -m "feat(amsg2): 自配 MCP 配置隨 tool_config 上雲"
```

---

### Task 6: worker fire 時注入工具塊與 tools，版本門檻抬升

**Files:**
- Modify: `worker/amsg/src/index.ts`（FireStash + onBeforeFire）
- Modify: `components/settings/ActiveMsgGlobalSettingsModal.tsx`（REQUIRED_WORKER_VERSION / FEATURES）

- [ ] **Step 1: FireStash 擴容與注入**

`worker/amsg/src/index.ts`：

imports 追加：

```ts
import {
  buildMcpFireBlock, buildMcpFireTools, buildMcpNameMap, createMcpSessionState, filterMcpServersForChar,
  type McpResolvedToolCore, type McpSessionState,
} from '../../../utils/mcpFireCore';
```

`FireStash`（141-148 行）追加：

```ts
interface FireStash {
  // …既有字段不動…
  /** 通用 MCP：暴露名 → 服務器/工具。tool_config 裡沒配（或對該角色不可見）時為 null。 */
  mcpResolve: Map<string, McpResolvedToolCore> | null;
  /** 每服務器一份連接會話，單次 fire 內跨輪複用，fire 結束隨 scratch 丟棄。 */
  mcpSessions: Map<string, McpSessionState>;
}
```

`onBeforeFire` 裡 `buildToolCtx` 調用（405 行）之後、返回處：

```ts
    // 通用 MCP：提示詞塊 / tools 數組與憑據同源同拍（都來自這一行 tool_config），
    // 不存在「教了角色用、憑據卻沒到」的窗口。charIds 過濾與前台同語義。
    // mcpUseNativeTools=false = 用戶的中轉拒 tools（前台兼容模式同款開關），
    // 請求不帶 tools 參數、提示詞塊教正文協議，識別走 processLLMRound 第二層。
    const mcpServers = filterMcpServersForChar(toolConfig.mcpServers, charId);
    // maxNameLen 59：暴露名後面要拼 mcp__ 前綴（5 字符），總長不能超 OpenAI 的 64。
    const mcpResolve = mcpServers.length ? buildMcpNameMap(mcpServers, { maxNameLen: 59 }) : null;
    const mcpNative = toolConfig.mcpUseNativeTools !== false;

    const { toolCtx, proxyWorkerUrl, xhsCookie } = buildToolCtx(toolPack, toolConfig);
    ctx.scratch.fire = {
      session: createFireSessionState(),
      toolCtx,
      proxyWorkerUrl,
      xhsCookie,
      occurrenceMs,
      mcpResolve,
      mcpSessions: new Map(),
    } satisfies FireStash;

    // fire_pack v2：「本次任務」指令隨任務 metadata 走，這裡填槽。
    // MCP 塊拼在渲染好的 prompt 之後（同一條 user 消息）。
    const prompt = renderFirePack(pack, ctx.now.getTime(), taskMeta.amsgTaskInstruction)
      + (mcpResolve ? buildMcpFireBlock(mcpResolve, { mode: mcpNative ? 'native' : 'text' }) : '');
    return {
      messages: [{ role: 'user' as const, content: prompt }],
      // amsg-server 帶 agentic-fire-tools feature 的版本起透傳給每輪 LLM 請求；
      // 老 bundle 裡不會走到這（tools 是隨本次 bundle 一起升上去的）。
      ...(mcpResolve && mcpNative ? { tools: buildMcpFireTools(mcpResolve) } : {}),
    };
```

- [ ] **Step 2: 設置頁版本門檻**

`REQUIRED_WORKER_VERSION` 已在依賴升級提交（`chore(amsg2): amsg-server 升 2.6.0-next.8`）裡同步抬到 `2.6.0-next.8`——倉庫有守衛測試釘著「門檻 = package.json 聲明版本」，升依賴時就已被迫同步，這一步不用再動它。可選：`REQUIRED_WORKER_FEATURES` 追加 `'agentic-fire-tools'` 作顯式語義（版本比對已覆蓋判定，加 feature 只是讓意圖更可讀）。舊粘貼部署會照現有模式亮「重新粘貼 worker」的牌子，MCP 靜默失效變成看得見的提示（部署一致性優先於前端兜底）。

- [ ] **Step 3: 編譯確認**

Run: `pnpm build:workers && pnpm vitest run worker/amsg/src/index.test.ts`
Expected: 構建成功、既有測試綠

- [ ] **Step 4: Commit**

```bash
git add worker/amsg/src/index.ts components/settings/ActiveMsgGlobalSettingsModal.tsx worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "feat(amsg2): fire 時注入 MCP 工具塊與 tools 聲明, 版本門檻抬至 next.6"
```

---

### Task 7: 工具循環歸併 native 調用 + 正文第二層

**Files:**
- Modify: `worker/amsg/src/agentic.ts`（processLLMRound）
- Modify: `worker/amsg/src/index.ts:439-459`（onLLMOutput 提取 native tool_calls）
- Test: `worker/amsg/src/agentic.test.ts`

- [ ] **Step 1: 寫失敗測試**

追加到 `worker/amsg/src/agentic.test.ts`（`buildInput()` 若文件裡沒有現成構造器，按既有 PushBuildInput 字面量補一個最小工廠）：

```ts
import { buildMcpNameMap, type McpFireServer } from '../../../utils/mcpFireCore';

const mcpSrv: McpFireServer = {
  id: 's1', name: '探針', url: 'https://probe.example.com',
  tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }],
};
const mcpResolve = buildMcpNameMap([mcpSrv]);
const nativeCall = (args = '{}') => ({
  id: 'call_n1', type: 'function' as const,
  function: { name: 'mcp__get_secret', arguments: args },
});

describe('processLLMRound + MCP', () => {
  it('native tool_calls → tool-request 原樣透傳, 正文全文入旁白', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去問問暗號。', buildInput(),
      { resolve: mcpResolve, nativeToolCalls: [nativeCall('{"who":"小滿"}')] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeCall('{"who":"小滿"}')]);
    expect(state.narrations.join('')).toContain('我去問問暗號');
  });

  it('第二層：無 native 時識別正文假調用, 名字帶 mcp__ 前綴, 旁白剝淨語法', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去問問暗號。\nget_secret({"who":"小滿"})', buildInput(),
      { resolve: mcpResolve });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');
    expect(JSON.parse(d.toolCalls[0].function.arguments)).toEqual({ who: '小滿' });
    expect(state.narrations.join('')).not.toContain('get_secret(');
  });

  it('模型把帶前綴的名字寫進正文（native 模式掉格式）也認', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, 'mcp__get_secret({"who":"小滿"})', buildInput(), { resolve: mcpResolve });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');   // 不出現 mcp__mcp__
  });

  it('native 與數據標籤同輪 → 合併進同一個 tool-request', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '[[RECALL: 2026-06]]', buildInput(),
      { resolve: mcpResolve, nativeToolCalls: [nativeCall()] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    const names = d.toolCalls.map((tc) => tc.function.name);
    expect(names).toContain('recall');
    expect(names).toContain('mcp__get_secret');
  });

  it('無 MCP 參與時行為與不傳第 4 參完全一致（迴歸）', () => {
    const a = processLLMRound(createFireSessionState(), '正常收尾文本。', buildInput(), { resolve: mcpResolve });
    const b = processLLMRound(createFireSessionState(), '正常收尾文本。', buildInput());
    expect(a).toEqual(b);
  });

  it('finish 後最終推送正文不含調用語法（防洩漏迴歸守衛）', () => {
    const state = createFireSessionState();
    processLLMRound(state, '先問暗號。\nget_secret({})', buildInput(), { resolve: mcpResolve });
    const d = processLLMRound(state, '拿到了，暗號是 X。', buildInput(), { resolve: mcpResolve });
    expect(d.decision).toBe('finish');
    if (d.decision !== 'finish') return;
    const all = d.pushPayloads.map((p) => String(p.message)).join('\n');
    expect(all).toContain('先問暗號');
    expect(all).not.toContain('get_secret(');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run worker/amsg/src/agentic.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 實現 processLLMRound**

`worker/amsg/src/agentic.ts`：

imports 追加：

```ts
import {
  extractTextFakedMcpCalls, stripTextFakedMcpCalls,
  type McpFireServer, type McpResolvedToolCore,
} from '../../../utils/mcpFireCore';
```

簽名與函數體開頭：

```ts
export interface McpRoundInput {
  resolve: Map<string, McpResolvedToolCore<McpFireServer>>;
  /** 本輪 LLM 響應裡已按 mcp__ 前綴過濾好的 native tool_calls；文本模式/無調用時缺省。 */
  nativeToolCalls?: ToolCall[];
}

export function processLLMRound(
  state: FireSessionState,
  llmOutputText: string,
  build: PushBuildInput,
  mcp?: McpRoundInput | null,
): RoundDecision {
  // 通用 MCP 兩層識別（與前台同構）：native tool_calls 優先；沒有 native 時
  // 用前台「兼容模式」同一個解析器從正文裡摳 tool_name({...})。兩種來源都可能
  // 與數據標籤同輪出現，最終合併成同一個 tool-request，executeToolCalls 按
  // mcp__ 前綴分流。正文裡出現過的調用語法一律剝掉——它不能進旁白/推送。
  //
  // 正文解析認 mcp__ 前綴名（native 模式下模型在 tools 數組裡見到的名字帶前綴，
  // 掉格式寫進正文時寫的也是它）——core 的 alsoMatchPrefix 選項負責，exposedName 回裸名。
  const nativeToolCalls = mcp?.nativeToolCalls ?? [];
  const textCalls = mcp?.resolve.size
    ? extractTextFakedMcpCalls(llmOutputText, mcp.resolve, { alsoMatchPrefix: 'mcp__' })
    : [];
  const scanText = textCalls.length ? stripTextFakedMcpCalls(llmOutputText, textCalls) : llmOutputText;
  // native 在場時正文摳出來的不再入列（同一意圖大概率兩處都寫了；而且庫只給
  // assistant 消息合併 decision 裡的 toolCalls，native 已含語義）。語法照剝。
  const mcpToolCalls: ToolCall[] = nativeToolCalls.length > 0
    ? nativeToolCalls
    : textCalls.map((c, i) => ({
        // id 只需在一輪的 assistant/tool 消息配對裡唯一；用累計工具數做輪間區分度。
        id: `mcp_${state.toolCalls.length}_${i}`,
        type: 'function',
        // exposedName 恆為裸名（alsoMatchPrefix 的命中也回裸名），統一補前綴即可。
        function: { name: `mcp__${c.exposedName}`, arguments: JSON.stringify(c.args) },
      }));

  const result = classifyLLMOutput(scanText);
  const isToolRound = result.kind === 'tool-request' || mcpToolCalls.length > 0;

  if (isToolRound) {
    // MCP-only 輪沒有數據標籤，整段剝淨後的文本都是旁白（與 tag 輪的 prefix 同角色）。
    const narration = result.kind === 'tool-request' ? result.prefix : scanText;
    if (narration.trim()) state.narrations.push(narration);
    if (state.duplicateToolCalls < MAX_DUPLICATE_TOOL_CALLS) {
      return {
        decision: 'tool-request',
        toolCalls: result.kind === 'tool-request' ? [...result.toolCalls, ...mcpToolCalls] : mcpToolCalls,
      };
    }
  }

  // ↓ 原有 finish 段僅兩處機械替換：
  //   const thisRound = result.kind === 'tool-request' ? '' : llmOutputText;
  //     → const thisRound = isToolRound ? '' : scanText;
  //   const finalScan = fullText === llmOutputText ? result : classifyLLMOutput(fullText);
  //     → const finalScan = fullText === scanText ? result : classifyLLMOutput(fullText);
  //   （result 是在 scanText 上算的，比對基準跟著換；無 MCP 時 scanText === llmOutputText，行為不變。）
```



- [ ] **Step 4: index.ts onLLMOutput 提取 native**

`worker/amsg/src/index.ts` 的 `processLLMRound(session, content, {...})`（445 行）調用處之前：

```ts
    // native tool_calls：只認 tools 數組裡聲明過的 mcp__ 名字。模型幻覺出的
    // 未聲明調用（比如給 tag 工具編一個 native 調用）丟棄並留日誌——直接透傳
    // 會讓 executeToolCalls 撞上沒有 stash 映射的名字。
    const rawToolCalls = (ctx.llmResponse as { choices?: Array<{ message?: { tool_calls?: unknown } }> })
      ?.choices?.[0]?.message?.tool_calls;
    const nativeMcpCalls = (Array.isArray(rawToolCalls) ? rawToolCalls : []).filter((tc: any) => {
      const n = tc?.function?.name;
      const hit = typeof n === 'string' && n.startsWith('mcp__') && !!stash.mcpResolve?.has(n.slice('mcp__'.length));
      if (!hit && tc) console.warn('[amsg:agentic] 丟棄未聲明的 native tool_call', { name: tc?.function?.name });
      return hit;
    });
```

調用改為：

```ts
    const decision = processLLMRound(session, content, {
      /* …build 入參不動… */
    }, stash.mcpResolve ? { resolve: stash.mcpResolve, nativeToolCalls: nativeMcpCalls } : null);
```

- [ ] **Step 5: 跑測試 + 構建**

Run: `pnpm vitest run worker/amsg/src/agentic.test.ts && pnpm build:workers`
Expected: 全 PASS + 構建成功

- [ ] **Step 6: Commit**

```bash
git add worker/amsg/src/agentic.ts worker/amsg/src/index.ts worker/amsg/src/agentic.test.ts worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "feat(amsg2): 工具循環歸併 native MCP 調用, 正文協議作第二層"
```

---

### Task 8: worker 直連執行 MCP 工具

**Files:**
- Modify: `worker/amsg/src/index.ts`（runMcpFireTool + executeToolCalls 分流）
- Test: `worker/amsg/src/index.test.ts`

- [ ] **Step 1: 寫失敗測試**

追加到 `worker/amsg/src/index.test.ts`：

```ts
import { vi, describe, it, expect, afterEach } from 'vitest';
import { runMcpFireTool } from './index';
import { buildMcpNameMap, createMcpSessionState, type McpFireServer } from '../../../utils/mcpFireCore';

const probe: McpFireServer = {
  id: 's1', name: '探針', url: 'https://probe.example.com/mcp',
  token: 'tok-1', tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: {} } }],
};
const stashFragment = () => ({ mcpResolve: buildMcpNameMap([probe]), mcpSessions: new Map() });

const rpcOk = (id: number, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('runMcpFireTool', () => {
  it('握手 + tools/call 直連 server.url, 帶 Bearer, 結果 ok', async () => {
    const seen: Array<{ url: string; body: any; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(input), body, auth: new Headers(init.headers).get('Authorization') });
      if (body.method === 'initialize') return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: '暗號 MARKER-123' }] });
    }));
    const result = await runMcpFireTool(stashFragment() as any, 'mcp__get_secret', {});
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain('MARKER-123');
    expect(seen.every((s) => s.url.startsWith('https://probe.example.com/mcp'))).toBe(true);
    expect(seen.every((s) => s.auth === 'Bearer tok-1')).toBe(true);
    expect(seen.map((s) => s.body.method)).toContain('tools/call');
  });

  it('未配置的工具名 → ok:false 而不是拋錯（回餵給模型圓場）', async () => {
    const result = await runMcpFireTool(stashFragment() as any, 'mcp__nope', {});
    expect(result).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('服務器錯誤 → ok:false 帶原因（不炸 fire 鏈）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await runMcpFireTool(stashFragment() as any, 'mcp__get_secret', {});
    expect(result).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run worker/amsg/src/index.test.ts`
Expected: 新用例 FAIL（runMcpFireTool 未導出）

- [ ] **Step 3: 實現**

`worker/amsg/src/index.ts`：imports 補 `buildMcpDirectHeaders, callMcpToolCore, formatMcpToolResult`（mcpFireCore）。新增（放在 `amsgHooks` 之前）：

```ts
/**
 * 單個 MCP 調用的超時。總 fire 預算 240s / 最多 5 輪，一個慢服務器不能吃光
 * 整條鏈（瀏覽器側是 60s，那邊沒有輪次預算壓力）。
 */
const MCP_CALL_TIMEOUT_MS = 25_000;

/**
 * 執行一個 mcp__ 前綴的工具調用。永不拋錯——失敗也以 ok:false 回餵給 LLM
 * 圓場（與 dispatchAgenticTool 的失敗語義對齊）。export 只為單測。
 */
export const runMcpFireTool = async (
  stash: Pick<FireStash, 'mcpResolve' | 'mcpSessions'>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const exposed = name.slice('mcp__'.length);
  const hit = stash.mcpResolve?.get(exposed);
  if (!hit) {
    return { ok: false, reason: 'unknown_tool', message: `未配置的 MCP 工具: ${exposed}` };
  }
  let session = stash.mcpSessions.get(hit.server.id);
  if (!session) {
    session = createMcpSessionState();
    stash.mcpSessions.set(hit.server.id, session);
  }
  const result = await callMcpToolCore(
    { url: hit.server.url, headers: (sid) => buildMcpDirectHeaders(hit.server, sid) },
    session,
    hit.toolName,
    args as Record<string, any>,
    {
      timeoutMs: MCP_CALL_TIMEOUT_MS,
      inputSchema: (hit.server.tools || []).find((t) => t.name === hit.toolName)?.inputSchema,
    },
  );
  return result.success
    ? { ok: true, source: hit.server.name, data: formatMcpToolResult(result.data) }
    : { ok: false, reason: 'mcp_error', source: hit.server.name, message: result.error };
};
```

`executeToolCalls` 裡 549 行的一行調用改成分流（dup 閘、toolCalls 記帳、回喂沿用原位代碼）：

```ts
        const result = name.startsWith('mcp__')
          ? await runMcpFireTool(stash, name, args)
          : await dispatchAgenticTool(name, args, stash.toolCtx);
```

- [ ] **Step 4: 跑測試 + 構建**

Run: `pnpm vitest run worker/amsg/src/index.test.ts worker/amsg/src/agentic.test.ts && pnpm build:workers`
Expected: 全 PASS + 構建成功

- [ ] **Step 5: Commit**

```bash
git add worker/amsg/src/index.ts worker/amsg/src/index.test.ts worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "feat(amsg2): worker 直連執行自配 MCP 工具"
```

---

### Task 9: e2e harness S8（native）+ S8b（正文兜底）

**Files:**
- Modify: `scripts/amsg2-e2e-harness.mjs`

- [ ] **Step 1: 起 mock MCP 服務器（真 HTTP，worker bundle 直連）**

放在既有 worker http 橋之後：

```js
// ─── S8 的 mock MCP 服務器（真 HTTP；worker 直連，不走 fetch 攔截） ───
const MCP_PASSPHRASE = 'HARNESS-MCP-7731';
const mcpSeen = [];
const mcpServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  mcpSeen.push(body.method);
  const reply = (obj, extra = {}) => {
    res.writeHead(200, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };
  if (body.method === 'initialize') {
    return reply(
      { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'harness-mcp', version: '1.0.0' } } },
      { 'Mcp-Session-Id': 'harness-session' },
    );
  }
  if (String(body.method).startsWith('notifications/')) { res.writeHead(202); return res.end(); }
  if (body.method === 'tools/call' && body.params?.name === 'get_secret_word') {
    return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `暗號是 ${MCP_PASSPHRASE}` }] } });
  }
  reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `method not found: ${body.method}` } });
});
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r));
const MCP_URL = `http://127.0.0.1:${mcpServer.address().port}`;
const MCP_TOOL_CONFIG = (useNative) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
  mcpUseNativeTools: useNative,
  mcpServers: [{
    id: 'srv1', name: '暗號服務器', url: MCP_URL,
    tools: [{ name: 'get_secret_word', description: '取回今日暗號', inputSchema: { type: 'object', properties: { asked_by: { type: 'string' } } } }],
  }],
});
```

末尾收尾處補 `mcpServer.close()`。

- [ ] **Step 2: mock LLM 加路由分支（native 回 tool_calls，text 回正文調用）**

在 llm.test 分支裡（`FROZEN_char-frozen` 之前）插入；注意 native 分支返回的是**完整 message 對象**：

```js
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && !hasToolResult) {
      return new Response(JSON.stringify({ choices: [{ message: {
        role: 'assistant', content: '我問問那邊今天的暗號。',
        tool_calls: [{ id: 'call_mcp_1', type: 'function', function: { name: 'mcp__get_secret_word', arguments: '{"asked_by":"小滿"}' } }],
      } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，今天的暗號是 ${m ? m[0] : '（工具結果裡沒找到）'}。`;
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && !hasToolResult) {
      content = '我問問那邊今天的暗號。\nget_secret_word({"asked_by":"小滿"})';
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，暗號是 ${m ? m[0] : '（沒找到）'}。`;
```

- [ ] **Step 3: S8 + S8b 場景（照 S3 的 helper 用法）**

放在 S7 之後：

```js
  section('S8 通用 MCP（native）：tools 聲明 → native tool_calls → worker 直連 → 暗號進 push');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-native'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-native', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-native'), key: 'tool_pack', value: JSON.stringify(toolPack('小滿')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(true), updatedAt: now },
    ]);
    const fireAt = new Date(now + 1000);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-native', charName: '小滿', mode: 'auto',
      firstSendTime: fireAt.toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000, taskInstruction: '把今天的暗號告訴用戶。',
      frozenPrompt: 'FROZEN_char-mcp-native（不應被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule(MCP native) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length;
    const seenBefore = mcpSeen.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('native 場景走了 2 輪 LLM', reqs.length === 2, `got ${reqs.length}`);
    check('第 1 輪請求體聲明 tools（mcp__ 前綴）',
      Array.isArray(reqs[0]?.tools) && reqs[0].tools.some((t) => t?.function?.name === 'mcp__get_secret_word'),
      JSON.stringify(reqs[0]?.tools));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('native 模式提示詞塊不教正文協議', r1c.includes('暗號服務器') && !r1c.includes('tool_name({"參數":"值"})'));
    const rpc = mcpSeen.slice(seenBefore);
    check('worker 對 MCP 服務器完成 initialize + tools/call', rpc.includes('initialize') && rpc.includes('tools/call'), JSON.stringify(rpc));
    const round2 = reqs[1]?.messages || [];
    const assistant = round2.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    check('第 2 輪 assistant 帶 native tool_calls（配對完整）', assistant?.tool_calls?.[0]?.id === 'call_mcp_1');
    const toolMsg = round2.find((m) => m.role === 'tool');
    check('第 2 輪迴喂含 MCP 結果', String(toolMsg?.content || '').includes(MCP_PASSPHRASE), String(toolMsg?.content || '').slice(0, 160));
    const mine = pushes.filter((p) => p.tag === 'char-mcp-native');
    check('最終 push 攜帶 MCP 取回的暗號',
      mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)),
      JSON.stringify(mine.map((m) => m.payload?.message)));
    check('旁白保序進 push', mine.some((m) => String(m.payload?.message || '').includes('問問那邊')));
  }

  section('S8b 通用 MCP（正文兜底）：mcpUseNativeTools=false → 請求不帶 tools → 正文協議');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-text'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-text', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-text'), key: 'tool_pack', value: JSON.stringify(toolPack('小滿')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(false), updatedAt: now },
    ]);
    const fireAt = new Date(now + 1000);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-text', charName: '小滿', mode: 'auto',
      firstSendTime: fireAt.toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000, taskInstruction: '把今天的暗號告訴用戶。',
      frozenPrompt: 'FROZEN_char-mcp-text（不應被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule(MCP text) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('text 場景走了 2 輪 LLM', reqs.length === 2, `got ${reqs.length}`);
    check('請求體不帶 tools', reqs.every((r) => !('tools' in r)), JSON.stringify(Object.keys(reqs[0] || {})));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('text 模式提示詞塊教正文協議', r1c.includes('get_secret_word(') && r1c.includes('tool_name({"參數":"值"})'));
    const mine = pushes.filter((p) => p.tag === 'char-mcp-text');
    check('最終 push 攜帶暗號且無調用語法殘留',
      mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)) &&
      mine.every((m) => !String(m.payload?.message || '').includes('get_secret_word(')),
      JSON.stringify(mine.map((m) => m.payload?.message)));
  }
```

- [ ] **Step 4: 全量跑 harness + 單測**

Run: `pnpm build:workers && node scripts/amsg2-e2e-harness.mjs && pnpm vitest run`
Expected: S0–S8b 全 ✅（S0–S7 綠 = 零迴歸），單測全 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/amsg2-e2e-harness.mjs
git commit -m "test(amsg2): e2e harness 補通用 MCP 場景（native + 正文兜底）"
```

---

### Task 10: 文檔同步

**Files:**
- Modify: `docs/mcp-user-guide.md`
- Modify: `docs/mcp-client.md`

- [ ] **Step 1: 用戶教程補一節**

`docs/mcp-user-guide.md` 末尾追加（平鋪直敘，未發佈特性不寫遷移敘述）：

```markdown
## 主動消息裡也能用

配好的 MCP 工具在定時主動消息（主動消息 2.0）裡同樣可用：角色到點想用工具時，
由你部署的 amsg worker 直接連你的 MCP 服務器，不需要瀏覽器開著。

需要滿足的條件：
- amsg worker 是較新的部署（設置頁會在版本過舊時提示重新粘貼）；
- 服務器地址是公網可訪問的（`localhost` 或局域網地址只有你的瀏覽器夠得著，
  worker 連不上，這類服務器不會帶進主動消息）；
- 服務器在設置裡處於啟用狀態、且已「發現工具」。

代理設置對主動消息不生效：worker 在服務端直連你填的服務器地址，沒有瀏覽器的
跨域限制，所以不需要代理。綁定聊天的設置照常生效——綁定了角色的服務器只有
那個角色的主動消息能用。「兼容模式」開關也照常生效：關掉後主動消息同樣改用
正文方式調工具，適合拒絕 tools 參數的中轉。

改動 MCP 配置後會自動同步到雲端；下一次到點的主動消息用的就是新配置。
```

- [ ] **Step 2: 開發者文檔補一節**

`docs/mcp-client.md` 追加：

```markdown
## amsg2 後台路徑

主動消息 2.0 的 worker 到點調 MCP 走與前台不同的一條鏈：

- 配置：`mcpClient.collectMcpFireServers()` 把 enabled + 已發現工具 + 公網地址的
  服務器（含 token/customHeaders，剝代理字段）與「兼容模式」開關一起作為
  `tool_config.mcpServers` / `mcpUseNativeTools` 隨 client_state 加密通道上雲
  （`activeMsgClient.buildToolConfigEntry` 唯一咽喉）。
- 提示詞與 tools：worker 在 onBeforeFire 用 `mcpFireCore.buildMcpFireBlock` /
  `buildMcpFireTools` 從 tool_config 現場生成——與憑據同源，不經過 fire_pack。
  amsg-server 帶 `agentic-fire-tools` feature 的版本起，fire 循環透傳 tools 請求參數。
- 調用識別（與前台同構的兩層）：native tool_calls 優先；沒有 native 時用前台
  「兼容模式」同一個解析器（`extractTextFakedMcpCalls`）從正文摳
  `tool_name({...})`。統一 `mcp__` 前綴路由。
- 執行：`executeToolCalls` 按前綴分流到 `runMcpFireTool`，worker 直連
  `server.url`（服務端 fetch 無 CORS），單次調用超時 25s。
- 純邏輯都在 `utils/mcpFireCore.ts`（環境無關葉子，進 worker bundle，禁加瀏覽器
  依賴）；瀏覽器側 mcpClient/mcpToolBridge 委託同一份實現。
- 版本歪斜可見：capabilities 的 `agentic-fire-tools` + 設置頁版本門檻，
  老 worker 不會靜默吞掉 MCP 配置。

迴歸守衛：`scripts/amsg2-e2e-harness.mjs` S8/S8b + `worker/amsg/src/agentic.test.ts`、
`index.test.ts`、`utils/mcpFireCore.test.ts` + ReiStandard `agentic-fire.test.mjs`。
```

- [ ] **Step 3: Commit**

```bash
git add docs/mcp-user-guide.md docs/mcp-client.md
git commit -m "docs(mcp): 主動消息後台可用 MCP 的用戶與開發者說明"
```

---

### Task 11: 真機端到端驗收（人工步驟）

前置：`sullyos-mcp-probe` 探針仍部署在 CF（`https://sullyos-mcp-probe.yukine0v0.workers.dev`，工具 `get_secret_passphrase` 返回口令 `KUMQUAT-7731-VELVET-9042`，KV 留痕）。2026-07-29 的失敗實測用的就是它——同一探針，修復前後對照。

- [ ] **Step 1: 部署新 worker（先 worker 後前端）**

```bash
pnpm build:workers
# 二選一：設置頁「複製 Worker 代碼」粘進 CF Dashboard；或部署倉庫同步後 wrangler deploy
```

- [ ] **Step 2: 前端配置**

本地 `pnpm dev` 打開 SullyOS → 設置：確認 amsg2 面板不再亮「重新粘貼」牌（capabilities 門檻過了）；MCP 服務器卡片裡探針已啟用、已發現工具。保存觸發 tool_config 同步。

- [ ] **Step 3: 建任務並離開前台**

給已連 amsg2 的角色建一條 2 分鐘後的 prompted 任務，promptHint：
`請用 MCP 工具 get_secret_passphrase 取回今日暗號口令並原樣告訴我；拿不到就直說，不要編造。`
然後關掉 SullyOS 頁面。

- [ ] **Step 4: 驗收斷言（全部滿足才算過）**

1. 推送到達，消息裡含 `KUMQUAT-7731-VELVET-9042`（不是「拿不到口令」）；
2. `curl https://sullyos-mcp-probe.yukine0v0.workers.dev` 的 KV 日誌新增 `initialize` + `tools/call`，`ua` 來自 CF worker 而非瀏覽器；
3. CF Dashboard 裡 sullyos-amsg 的 Workers Logs 有 `[amsg:agentic] {type:'tool_done', tool:'mcp__get_secret_passphrase'}`。

- [ ] **Step 5: 反向驗證（推薦）**

a. 設置裡把「兼容模式」開關關掉（`useNativeTools=false`）→ 重跑 Step 3 → 仍能拿到口令（正文協議兜底鏈路真機可用）；
b. 停用探針服務器 → 再建任務 → 角色表示沒有這個工具（塊未注入），而不是報錯。

---

## Self-Review 結論

- 三處斷點 ↔ 任務覆蓋：斷點 1（提示詞）= Task 4+6；斷點 2（憑證上雲）= Task 5；斷點 3（執行通道）= Task 0+3+7+8。端到端守衛 = Task 9+11；版本歪斜可見性 = Task 0(capabilities)+6(門檻)。
- 類型/符號一致性：`McpFireServer` / `McpResolvedToolCore`（含 `tool` 字段）/ `buildMcpNameMap`（`maxNameLen` 可選參）/ `withMcpDedupeSuffix` / `buildMcpFireTools` / `buildMcpFireBlock` / `callMcpToolCore` / `createMcpSessionState` / `buildMcpDirectHeaders` / `filterMcpServersForChar` / `collectMcpFireServers` / `runMcpFireTool` / `McpRoundInput` / `mcp__` 前綴 / `MCP_CALL_TIMEOUT_MS` / `mcpUseNativeTools`，各任務間已對齊。
- 已知邊界（有意為之）：本地/私網服務器不進後台（Task 5 過濾 + 文檔）；fire 內不做拒-tools 的 4xx 自動降級（確定性拒絕由用戶開關處理，任務失敗會帶 lastError 可見）；instant-push worker 與前台聊天路徑不動。
