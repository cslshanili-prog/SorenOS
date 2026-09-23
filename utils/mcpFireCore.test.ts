import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildMcpDirectHeaders,
    buildMcpFireBlock,
    buildMcpFireTools,
    buildMcpNameMap,
    callMcpToolCore,
    createMcpSessionState,
    extractTextFakedMcpCalls,
    filterMcpServersForChar,
    MCP_FIRE_NAME_BUDGET,
    MCP_FIRE_NAME_PREFIX,
    MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION,
    sanitizeMcpToolName,
    stripTextFakedMcpCalls,
    withMcpDedupeSuffix,
    type McpFireServer,
    type McpTransportTarget,
} from './mcpFireCore';

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

    // 下面兩條守的是同一個坑：兜底後綴被 64 字符上限截掉後，候選名恆定不變、
    // while 循環再也退不出去。第一條才是真正的迴歸守衛——同步死循環會把
    // 整個 vitest 進程卡住，testTimeout 也救不回來，紅不了。
    it('重名後綴不會被 64 字符上限吃掉：不同計數必須得到不同名字', () => {
        const base = 'x'.repeat(64);
        const a = withMcpDedupeSuffix(base, 2);
        const b = withMcpDedupeSuffix(base, 3);
        expect(a).not.toBe(b);
        expect(a.length).toBeLessThanOrEqual(64);
    });

    it('前 20 字符同名的多台服務器 + 撐滿 64 的工具名，每個工具仍拿到互異的暴露名', () => {
        const longTool = 'a'.repeat(43);
        const servers = ['-alpha', '-beta', '-gamma', '-delta'].map((sfx, i) =>
            srv({ id: `s${i}`, name: `MyCompanyToolServer${sfx}`, tools: [{ name: longTool }] }));
        const map = buildMcpNameMap(servers);
        expect(map.size).toBe(servers.length);
        expect([...map.keys()].every((k) => k.length <= 64)).toBe(true);
    });

    it('maxNameLen 可收緊預算（給 worker 側的前綴留位），收緊後暴露名依然互異', () => {
        const longTool = 'a'.repeat(43);
        const servers = ['-alpha', '-beta', '-gamma', '-delta'].map((sfx, i) =>
            srv({ id: `s${i}`, name: `MyCompanyToolServer${sfx}`, tools: [{ name: longTool }] }));
        const map = buildMcpNameMap(servers, { maxNameLen: MCP_FIRE_NAME_BUDGET });
        // Map 的鍵天然去重，size 等於工具數就等於「沒有互相覆蓋」
        expect(map.size).toBe(servers.length);
        expect([...map.keys()].every((k) => k.length <= MCP_FIRE_NAME_BUDGET)).toBe(true);
    });
});

describe('工具名長度預算', () => {
    // 名長預算是調用方算出來的（上限減前綴），算出 0 或負數時不能給出怪結果：
    // 不許返回空名，也不許被 slice 的負數下標反過來吐出一長串。
    it('名長預算被壓到 0/負數時仍給出可用的短名字', () => {
        expect(sanitizeMcpToolName('xyz', 0)).toBe('x');
        expect(sanitizeMcpToolName('xyz', -5)).toBe('x');
        expect(withMcpDedupeSuffix('abc', 2, 1)).toBe('_2');
        expect(withMcpDedupeSuffix('x'.repeat(64), 2, 1).length).toBeLessThanOrEqual('_2'.length);
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

// 瀏覽器那條路徑由 mcpClient.test.ts 蓋住；這裡守的是 worker 直連——請求頭
// 自己拼、會話狀態自己拿著，所以斷言要看真實發出去的請求體和請求頭。
describe('JSON-RPC 傳輸層（直連路徑）', () => {
    interface SentRequest {
        url: string;
        headers: Record<string, string>;
        body: any;
    }

    const directServer = (over: Partial<McpFireServer> = {}): McpFireServer => srv({
        token: 'tk-1',
        customHeaders: [{ name: 'X-Api-Key', value: 'k1' }],
        ...over,
    });

    const directTarget = (server: McpFireServer): McpTransportTarget => ({
        url: server.url,
        headers: (sessionId, protocolVersion) => buildMcpDirectHeaders(server, sessionId, protocolVersion),
    });

    const jsonResp = (payload: any, extraHeaders: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...extraHeaders },
        });

    /** 把每次 fetch 的 URL / 頭 / 請求體記下來，由 handler 決定回什麼 */
    const stubFetch = (handler: (sent: SentRequest) => Response): SentRequest[] => {
        const sent: SentRequest[] = [];
        vi.stubGlobal('fetch', vi.fn((url: any, init: any) => {
            const record: SentRequest = {
                url: String(url),
                headers: (init?.headers || {}) as Record<string, string>,
                body: JSON.parse(String(init?.body || '{}')),
            };
            sent.push(record);
            return Promise.resolve(handler(record));
        }));
        return sent;
    };

    beforeEach(() => {
        vi.spyOn(console, 'info').mockImplementation(() => { /* 別刷屏 */ });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('一次 tools/call 依次發出 initialize → notifications/initialized → tools/call，直連頭帶鑑權和自定義頭', async () => {
        const server = directServer();
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} });
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"temp":21}' }] } });
        });

        const result = await callMcpToolCore(
            directTarget(server), createMcpSessionState(), 'get_weather', { city: '上海' },
        );

        expect(result).toMatchObject({ success: true, data: { temp: 21 } });
        expect(sent.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
        expect(sent.every((s) => s.url === server.url)).toBe(true);
        expect(sent[0].headers['Authorization']).toBe('Bearer tk-1');
        expect(sent[0].headers['X-Api-Key']).toBe('k1');
        expect(sent[0].headers['Accept']).toBe('application/json, text/event-stream');
        expect(sent[0].body.params.protocolVersion).toBe(MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION);
        // 還沒握手完，第一發不該憑空帶 session
        expect(sent[0].headers['Mcp-Session-Id']).toBeUndefined();
        expect(sent[0].headers['MCP-Protocol-Version']).toBeUndefined();
        // 服務端未顯式回版本時按本次請求版本繼續；握手後的通知和調用都必須帶版本頭。
        expect(sent[1].headers['MCP-Protocol-Version']).toBe(MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION);
        expect(sent[2].headers['MCP-Protocol-Version']).toBe(MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION);
        expect(sent[2].body.params).toEqual({ name: 'get_weather', arguments: { city: '上海' } });
    });

    it('接受服務端協商到受支持的較早 Streamable HTTP 版本，並把協商結果帶到後續請求', async () => {
        const server = directServer();
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') return jsonResp({
                jsonrpc: '2.0', id: body.id,
                result: {
                    protocolVersion: '2025-03-26',
                    serverInfo: { name: 'legacy-streamable', version: '2.0.0' },
                    capabilities: { tools: {} },
                },
            });
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        });

        const session = createMcpSessionState();
        const result = await callMcpToolCore(directTarget(server), session, 'get_weather', {});

        expect(result.success).toBe(true);
        expect(session.protocolVersion).toBe('2025-03-26');
        expect(session.serverInfo).toMatchObject({ name: 'legacy-streamable', version: '2.0.0' });
        expect(sent[1].headers['MCP-Protocol-Version']).toBe('2025-03-26');
        expect(sent[2].headers['MCP-Protocol-Version']).toBe('2025-03-26');
    });

    it('拒絕把舊 HTTP+SSE 版本當作單端點 Streamable HTTP 繼續調用', async () => {
        const server = directServer();
        stubFetch(({ body }) => jsonResp({
            jsonrpc: '2.0', id: body.id,
            result: { protocolVersion: '2024-11-05' },
        }));

        const result = await callMcpToolCore(directTarget(server), createMcpSessionState(), 'get_weather', {});
        expect(result.success).toBe(false);
        expect(result.error).toContain('2024-11-05 屬於舊 HTTP+SSE 雙端點');
    });

    it('initialize 響應頭裡的 Mcp-Session-Id 記進會話，之後每一發都帶上', async () => {
        const server = directServer();
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') {
                return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} }, { 'Mcp-Session-Id': 'sess-A' });
            }
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        });

        const session = createMcpSessionState();
        await callMcpToolCore(directTarget(server), session, 'get_weather', {});

        expect(session.sessionId).toBe('sess-A');
        expect(sent[1].headers['Mcp-Session-Id']).toBe('sess-A');
        expect(sent[2].headers['Mcp-Session-Id']).toBe('sess-A');
    });

    it('tools/call 撞上 HTTP 404 時重置會話、重新握手並重試一次', async () => {
        const server = directServer();
        let handshakes = 0;
        let toolCalls = 0;
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') {
                return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} }, { 'Mcp-Session-Id': `sess-${++handshakes}` });
            }
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            toolCalls++;
            // 服務器重啟後老 session 失效，第一發 tools/call 被判 404
            if (toolCalls === 1) return new Response('session expired', { status: 404 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        });

        // 和 mcpClient 的真實用法一致：會話對象由外面拿著，不傳任何額外選項
        const session = createMcpSessionState();
        const result = await callMcpToolCore(directTarget(server), session, 'get_weather', {});

        expect(result).toMatchObject({ success: true, data: 'ok' });
        // 握手真的重來了一遍，而不是拿 initialized 的舊會話直接重發
        expect(handshakes).toBe(2);
        expect(toolCalls).toBe(2);
        // 重試帶的是新握手拿到的 session，而不是拿失效的那個再撞一次
        expect(sent[sent.length - 1].headers['Mcp-Session-Id']).toBe('sess-2');
        expect(session.sessionId).toBe('sess-2');
    });

    it('遠端一直不迴響應時按 timeoutMs 超時，返回失敗結果而不是永久掛著', async () => {
        vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })));

        const result = await callMcpToolCore(
            directTarget(directServer()), createMcpSessionState(), 'get_weather', {}, { timeoutMs: 20 },
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('超時');
    });

    it('JSON-RPC id 按會話獨立計數：兩個會話都從 1 起，互不串號', async () => {
        const server = directServer();
        const sent = stubFetch(({ body }) => {
            if (body.method === 'initialize') return jsonResp({ jsonrpc: '2.0', id: body.id, result: {} });
            if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
            return jsonResp({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        });

        const first = createMcpSessionState();
        const second = createMcpSessionState();
        await callMcpToolCore(directTarget(server), first, 'get_weather', {});
        await callMcpToolCore(directTarget(server), second, 'get_weather', {});

        // 通知類請求本來就沒有 id；兩個會話各自數出 1（initialize）和 2（tools/call）
        expect(sent.map((s) => s.body.id)).toEqual([1, undefined, 2, 1, undefined, 2]);
        expect(first.nextId).toBe(2);
        expect(second.nextId).toBe(2);
    });
});

describe('buildMcpFireBlock / buildMcpFireTools', () => {
    const servers = [srv({
        tools: [{
            name: 'get_weather',
            description: '查天氣',
            inputSchema: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'number' } }, required: ['city'] },
        }],
    })];
    const map = buildMcpNameMap(servers);

    // 來源標註看的是服務器台數，不是工具條數——同一台服務器的幾個工具之間沒什麼可區分的。
    const twoTools = [srv({ tools: [
        { name: 'get_weather', description: '查天氣' },
        { name: 'get_news', description: '查新聞' },
    ] })];
    const twoServers = [
        srv({ id: 's1', name: '服務器A', tools: [{ name: 'get_weather', description: '查天氣' }] }),
        srv({ id: 's2', name: '服務器B', tools: [{ name: 'get_news', description: '查新聞' }] }),
    ];

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

    it('空映射返回空串（不往 prompt 裡塞空殼）', () => {
        expect(buildMcpFireBlock(new Map(), { mode: 'native' })).toBe('');
    });

    it('單台服務器的多個工具之間不標來源', () => {
        expect(buildMcpFireBlock(buildMcpNameMap(twoTools), { mode: 'native' }))
            .not.toContain('（來源:');
        expect(buildMcpFireBlock(buildMcpNameMap(twoTools), { mode: 'text' }))
            .not.toContain('（來源:');
    });

    // native / text 兩條分支各自拼行，判據得分別守——只測一條時另一條壞了也照樣綠。
    it('跨服務器時才標來源', () => {
        expect(buildMcpFireBlock(buildMcpNameMap(twoServers), { mode: 'native' }))
            .toContain('（來源: 服務器A）');
        expect(buildMcpFireBlock(buildMcpNameMap(twoServers), { mode: 'text' }))
            .toContain('（來源: 服務器A）');
    });

    it('fire tools 數組帶 mcp__ 前綴，單台服務器時 description 不綴服務器名', () => {
        const tools = buildMcpFireTools(map);
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            type: 'function',
            function: { name: 'mcp__get_weather', description: '查天氣' },
        });
        expect((tools[0].function as any).parameters.required).toEqual(['city']);
    });

    it('跨服務器時 fire tools 的 description 綴上服務器名', () => {
        const tools = buildMcpFireTools(buildMcpNameMap(twoServers));
        expect(tools.map((t) => t.function.description)).toEqual(['[服務器A] 查天氣', '[服務器B] 查新聞']);
    });

    // 這條守的是兩邊協同：名映射按 MCP_FIRE_NAME_BUDGET 收緊後，fire tools 拼上前綴
    // 不能越過 OpenAI 的 64。兩個常量是同一個式子的兩頭（預算 = 64 − 前綴長），
    // 誰被單獨改一頭這條就紅。
    it('按 MCP_FIRE_NAME_BUDGET 建的映射，拼上前綴後仍不超 64', () => {
        expect(MCP_FIRE_NAME_BUDGET + MCP_FIRE_NAME_PREFIX.length).toBe(64);
        const longTool = 'a'.repeat(43);
        const wideServers = ['-alpha', '-beta', '-gamma', '-delta'].map((sfx, i) =>
            srv({ id: `s${i}`, name: `MyCompanyToolServer${sfx}`, tools: [{ name: longTool }] }));
        const tools = buildMcpFireTools(buildMcpNameMap(wideServers, { maxNameLen: MCP_FIRE_NAME_BUDGET }));
        expect(tools).toHaveLength(wideServers.length);
        expect(tools.every((t) => t.function.name.startsWith(MCP_FIRE_NAME_PREFIX))).toBe(true);
        expect(tools.every((t) => t.function.name.length <= 64)).toBe(true);
    });
});

// native 模式下 tools 數組裡的名字是帶 mcp__ 前綴的，模型掉格式把調用演進正文時
// 寫的多半也是帶前綴那個。第二層兜底得認它，否則調用語法原樣推給用戶。
describe('extractTextFakedMcpCalls 的 mcp__ 前綴兼容', () => {
    const map = buildMcpNameMap([srv({
        tools: [{
            name: 'get_weather',
            description: '查天氣',
            inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        }],
    })]);
    const withPrefix = { alsoMatchPrefix: 'mcp__' };

    it('括號形態：帶前綴的調用被認出來，exposedName 仍回裸名', () => {
        const content = '等我看看天氣哦\nmcp__get_weather({"city":"上海"})';
        const calls = extractTextFakedMcpCalls(content, map, withPrefix);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ exposedName: 'get_weather', toolName: 'get_weather', args: { city: '上海' } });
        // matched 要含前綴原文，剝完正文才不留殘渣
        expect(calls[0].matched).toContain('mcp__');
        expect(stripTextFakedMcpCalls(content, calls)).toBe('等我看看天氣哦');
    });

    it('行首冒號形態：帶前綴同樣認', () => {
        const content = '我查一下\nmcp__get_weather: 上海';
        const calls = extractTextFakedMcpCalls(content, map, withPrefix);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ exposedName: 'get_weather', args: { city: '上海' } });
        expect(calls[0].matched).toContain('mcp__');
        expect(stripTextFakedMcpCalls(content, calls)).toBe('我查一下');
    });

    // 前台不傳 opts，行為必須逐字節不變：帶前綴的寫法在前台不該被認成調用
    it('不傳 opts 時帶前綴的寫法不命中（前台行為迴歸釘）', () => {
        expect(extractTextFakedMcpCalls('mcp__get_weather({"city":"上海"})', map)).toEqual([]);
        expect(extractTextFakedMcpCalls('mcp__get_weather: 上海', map)).toEqual([]);
    });

    it('裸名照舊命中，開不開前綴都一樣', () => {
        const content = 'get_weather({"city":"北京"})';
        for (const opts of [undefined, withPrefix]) {
            const calls = extractTextFakedMcpCalls(content, map, opts);
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({ exposedName: 'get_weather', args: { city: '北京' } });
        }
    });
});

describe('葉子紀律', () => {
    // 這份文件會被打進 amsg worker bundle，import 到帶瀏覽器依賴的模塊就會在
    // worker 裡炸。靠源碼掃描當場攔住，不用等到構建才發現。
    it('mcpFireCore 保持環境無關：不 import 任何模塊', () => {
        const src = readFileSync(new URL('./mcpFireCore.ts', import.meta.url), 'utf8');
        // 後續任務確需引入環境無關葉子時，在這裡逐條放開白名單
        expect(src.match(/^\s*import\s.+$/gm) ?? []).toEqual([]);
        // 連 `export … 自其它模塊` 這種轉出寫法一起卡（它同樣會把別的模塊拖進 bundle）
        expect(src.match(/\bfrom\s*['"]/g) ?? []).toEqual([]);
        // 動態引入同理，運行期才炸更難查
        expect(src.match(/\bimport\s*\(/g) ?? []).toEqual([]);
    });
});
