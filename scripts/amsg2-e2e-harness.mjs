/**
 * amsg2 本地全流程實測 harness（上線前檢查用，跑法：`node scripts/amsg2-e2e-harness.mjs`）。
 *
 * 需 amsg-server ≥2.6.0-next.10 的 bundle 才能跑：斷言依賴發送後回執 onAfterSend
 * （self_log 的實際發送時刻）與 tzId 時間渲染，舊 bundle 會在這些斷言上掛。
 *
 * 跑的是倉庫裡提交的 **同一份** worker/amsg/worker.bundle.js（用戶粘進 CF Dashboard 的就是它），
 * 外圍環境全部真實化：
 *   - D1 → node:sqlite 內存庫（prepare/bind/run/first/all/batch 語義對齊；需要 Node 22+）
 *   - Web Push → 真實 VAPID + RFC8291 aes128gcm 加密，harness 持有瀏覽器側私鑰現場解密驗內容
 *   - LLM → mock（按請求內容路由腳本回復，校驗請求裡的 prompt 是不是 fire-time 現場渲染）
 *   - HTTP → node:http 橋接 worker.fetch，前端同款 @rei-standard/amsg-client 直連
 *
 * 場景：
 *   S0 鑑權/CORS/capabilities   S1 init-tenant + get-user-key + vapid-public-key
 *   S2 fixed 一次性任務端到端    S3 滿血 v2 多任務（fire_pack 現場填槽 + RECALL 工具循環 +
 *      directives + occurrenceMs + 大值分塊 + daily 推進 + /messages 投影 + cancel）
 *   S4 防穿幫閘：錨點前進 → skip  S5a 活躍租約新鮮 → skip（無 fire_pack 也攔）
 *   S5b 租約過期 + 無 fire_pack → 拋錯不降級        S6 force 策略 → 全綠燈照發
 *   S7 clear-client-state
 *   S8 通用 MCP native（tools 聲明 → 直連真 MCP 服務器 → 結果回喂 → 暗號進 push）
 *   S8b 通用 MCP 正文兜底（不帶 tools，提示詞教協議，正文裡的調用被識別執行）
 *   S9 自排鏈（角色到點給自己排下一條 → 用戶全程不上線 → 下一條讀得到上一條說了什麼）
 *
 * 有意不進 vitest：它要起真端口、真等 cron 到點（多處 1.4s sleep）、並 mock 全局 fetch，
 * 是發佈前手動跑的端到端體檢，不是單測。改 worker/amsg 或升 amsg-server 後跑一次。
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(`${REPO}/package.json`);
const webpush = require('web-push');
const { ReiClient } = await import(pathToFileURL(`${REPO}/node_modules/@rei-standard/amsg-client/dist/index.mjs`));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ─── 斷言與結果帳本 ───
const results = [];
let failures = 0;
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failures++;
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${cond ? '' : detail ? `  ← ${detail}` : ''}`);
};
const section = (t) => console.log(`\n━━ ${t}`);

// ─── D1 shim（node:sqlite） ───
class D1Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p.map((v) => v === undefined ? null : v); return this; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
}
class D1Shim {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new D1Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
  raw(sql) { return this.db.prepare(sql).all(); }
}

// ─── 環境（與 CF Dashboard 部署一致的 env） ───
const vapidKeys = webpush.generateVAPIDKeys();
const SERVER_TOKEN = 'launch-check-shared-secret';
const d1 = new D1Shim();
const env = {
  AMSG_MASTER_KEY: crypto.randomBytes(32).toString('hex'),
  VAPID_EMAIL: 'mailto:e2e@example.com',
  VAPID_PUBLIC_KEY: vapidKeys.publicKey,
  VAPID_PRIVATE_KEY: vapidKeys.privateKey,
  AMSG_SERVER_TOKEN: SERVER_TOKEN,
  DB: d1,
};

// ─── 瀏覽器側 push 訂閱密鑰（真實 P-256 + auth secret），並實現 RFC8291 解密 ───
const receiver = crypto.createECDH('prime256v1');
receiver.generateKeys();
const authSecret = crypto.randomBytes(16);
const subscriptionFor = (tag) => ({
  endpoint: `https://push.test/${tag}`,
  keys: { p256dh: b64u(receiver.getPublicKey()), auth: b64u(authSecret) },
});
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
function decryptPush(bodyBuf) {
  const salt = bodyBuf.subarray(0, 16);
  const idlen = bodyBuf[20];
  const senderPub = bodyBuf.subarray(21, 21 + idlen);
  const ct = bodyBuf.subarray(21 + idlen);
  const shared = receiver.computeSecret(senderPub);
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPub]);
  const ikm = hkdf(authSecret, shared, prkInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 0x02) throw new Error('bad aes128gcm padding delimiter');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

// ─── 出網 fetch 攔截：push 端點 + mock LLM，其餘透傳（本地 http 走 127.0.0.1 不受影響） ───
const realFetch = globalThis.fetch;
const pushes = [];            // { tag, headers, payload }
const llmRequests = [];       // 原始請求體

// mock LLM 的兩個應答構造器：一次普通回覆 / 一次「順手給自己排下一條」的工具調用。
const llmReply = (content, toolCalls) => new Response(JSON.stringify({
  choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
}), { status: 200, headers: { 'content-type': 'application/json' } });
const scheduleCall = (id, sendAt, promptHint) => ({
  id, type: 'function',
  function: {
    name: 'schedule_active_message',
    arguments: JSON.stringify({
      send_at: sendAt,
      ...(promptHint ? { mode: 'prompted', prompt_hint: promptHint } : {}),
    }),
  },
});
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://push.test/')) {
    const tag = url.slice('https://push.test/'.length);
    const headers = init.headers || {};
    const payload = decryptPush(Buffer.from(init.body));
    pushes.push({ tag, headers, payload });
    return new Response(null, { status: 201 });
  }
  if (url.startsWith('https://llm.test/')) {
    const req = JSON.parse(init.body);
    llmRequests.push(req);
    const all = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const hasToolResult = req.messages.some((m) => m.role === 'tool');
    let content;
    if (all.includes('FIREPACK_FRESH_char-full') && !hasToolResult) {
      content = '（先想想上個月的事）等我翻翻記憶。\n[[RECALL: 2026-06]]';
    } else if (all.includes('FIREPACK_FRESH_char-full') && hasToolResult) {
      content = '想起來了，六月那天的煙花真好看。\n今晚也想拉你去河邊。\n[[ACTION:POKE]]';
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && !hasToolResult) {
      // native 模式第 1 輪：正文寫旁白 + 走 function calling 通道發起 MCP 調用。
      // 這條要連 tool_calls 一起給，所以不套用下面統一的「只有 content」的包裝。
      return new Response(JSON.stringify({ choices: [{ message: {
        role: 'assistant', content: '我問問那邊今天的暗號。',
        tool_calls: [{
          id: 'call_mcp_1', type: 'function',
          function: { name: 'mcp__get_secret_word', arguments: '{"asked_by":"小滿"}' },
        }],
      } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，今天的暗號是 ${m ? m[0] : '（工具結果裡沒找到）'}。`;
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && !hasToolResult) {
      // 正文兜底模式第 1 輪：模型把調用「演」在正文裡（不支持 FC 的中轉常見形態）
      content = '我問問那邊今天的暗號。\nget_secret_word({"asked_by":"小滿"})';
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，暗號是 ${m ? m[0] : '（沒找到）'}。`;
    } else if (all.includes('FROZEN_char-frozen')) {
      content = '凍結提示詞兜底照發成功。';
    } else if (all.includes('FIREPACK_FRESH_char-force')) {
      content = '鬧鐘型強制發送，正在聊天也照發。';
    } else if (all.includes('FIREPACK_FRESH_char-chain')) {
      // 自排鏈：角色在這條消息裡給自己排下一條，走 function calling 通道。
      // 分支只看「prompt 和回喂裡出現了什麼」，不數輪次——鏈斷在任何一環，走到的
      // 分支就會不一樣，斷言直接紅，比事後比對正文更貼近「角色到底看見了沒有」。
      // 判定順序要緊：ok:true 排在被打回那條前面，否則第三輪還會看到第一輪的打回記錄。
      const seenPass = all.match(/CHAIN-PASS-\d+/);
      if (seenPass) {
        // 第二次觸發。口令只可能來自雲端自述回寫（上一條正文），prompt 裡讀不到就接不上。
        content = `接著剛才那條說，口令還是 ${seenPass[0]}，我沒忘。`;
      } else if (all.includes('"ok":true')) {
        content = '口令給你留一個：CHAIN-PASS-8823，等下我再來對。';
      } else if (all.includes('send_at_too_soon')) {
        // 被打回後按回喂裡的話改口，換一個合法時間（5 分鐘後）重排。
        return llmReply('那就往後挪挪。', [
          scheduleCall('call_sched_2', new Date(Date.now() + 5 * 60_000).toISOString(), '接著口令那件事往下說'),
        ]);
      } else {
        // 第一輪故意把時間寫太近（30 秒後）：驗「參數寫歪只回喂讓它改口，不讓整條 fire 失敗」。
        return llmReply('等我先把後面那條排上。', [scheduleCall('call_sched_1', new Date(Date.now() + 30_000).toISOString())]);
      }
    } else {
      content = '（默認回覆：未匹配任何腳本分支）';
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

// ─── 載入與線上部署同一份的 worker bundle，並起 http 橋 ───
const worker = (await import(pathToFileURL(`${REPO}/worker/amsg/worker.bundle.js`))).default;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) || body.length === 0 ? undefined : body,
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.stack || e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ─── S8 的 mock MCP 服務器（真 HTTP；worker 直連，不走 fetch 攔截） ───
// 地址是 127.0.0.1，上面那層 fetch 攔截只認 push.test / llm.test，所以 worker 發出的
// JSON-RPC 是真的走到了這個進程內的 HTTP 服務器上——握手、通知、tools/call 一步不少。
const MCP_PASSPHRASE = 'HARNESS-MCP-7731';
const mcpSeen = [];           // 收到的 JSON-RPC method 順序
const mcpServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  mcpSeen.push(body.method);
  const reply = (obj, extra = {}) => {
    res.writeHead(200, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };
  if (body.method === 'initialize') {
    return reply(
      {
        jsonrpc: '2.0', id: body.id,
        result: {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'harness-mcp', version: '1.0.0' },
        },
      },
      { 'Mcp-Session-Id': 'harness-session' },
    );
  }
  if (String(body.method).startsWith('notifications/')) { res.writeHead(202); return res.end(); }
  if (body.method === 'tools/call' && body.params?.name === 'get_secret_word') {
    return reply({
      jsonrpc: '2.0', id: body.id,
      result: { content: [{ type: 'text', text: `暗號是 ${MCP_PASSPHRASE}` }] },
    });
  }
  reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `method not found: ${body.method}` } });
});
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r));
const MCP_URL = `http://127.0.0.1:${mcpServer.address().port}`;
// tool_config 直接寫字面量（不過 collectMcpFireServers），所以本機地址不會被上雲側的
// 公網可達性過濾掉。useNative=false 對應前台「兼容模式」：請求不帶 tools，改教正文協議。
const MCP_TOOL_CONFIG = (useNative) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
  mcpUseNativeTools: useNative,
  mcpServers: [{
    id: 'srv1', name: '暗號服務器', url: MCP_URL,
    tools: [{
      name: 'get_secret_word',
      description: '取回今日暗號',
      inputSchema: { type: 'object', properties: { asked_by: { type: 'string' } } },
    }],
  }],
});

const runCron = () => worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 前端同款 client ───
const USER_ID = crypto.randomUUID();
const client = new ReiClient({ baseUrl: BASE, userId: USER_ID, serverToken: SERVER_TOKEN });

const authedHeaders = (extra = {}) => ({
  'X-Client-Token': SERVER_TOKEN, 'X-User-Id': USER_ID, ...extra,
});
// 復刻 activeMsgClient.fetchWithAuth + encryptPayload 的排程調用
async function scheduleTask(payload) {
  const encrypted = await client._encrypt(JSON.stringify(payload));
  const res = await realFetch(`${BASE}/schedule-message`, {
    method: 'POST',
    headers: authedHeaders({
      'Content-Type': 'application/json',
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
    }),
    body: JSON.stringify(encrypted),
  });
  return res.json();
}
async function listAllTasks() {
  const res = await realFetch(`${BASE}/messages?limit=100&offset=0`, {
    method: 'GET',
    headers: authedHeaders({ 'X-Response-Encrypted': 'true', 'X-Encryption-Version': '1' }),
  });
  const json = await res.json();
  if (!json.success) throw new Error('messages failed: ' + JSON.stringify(json.error));
  const data = json.encrypted === true ? await client._decrypt(json.data) : json.data;
  return data;
}
async function cancelTask(uuid) {
  const res = await realFetch(`${BASE}/cancel-message?id=${encodeURIComponent(uuid)}`, {
    method: 'DELETE', headers: authedHeaders(),
  });
  return res.json();
}
const putState = (entries) => client.putClientState(entries);

// fire_pack / tool_pack / chat_presence 的形狀與 key（與 utils/amsgFirePack.ts、
// utils/amsgToolPack.ts、utils/amsgChatPresence.ts 一致；parse 不過 worker 會靜默回退，
// 場景斷言裡的 FIREPACK_FRESH 標記會立刻暴露）
const NS = (charId) => `amsg:char:${charId}`;
const SLOT_TIME = '{{AMSG_CURRENT_TIME}}';
const SLOT_SINCE = '{{AMSG_TIME_SINCE_USER}}';
const SLOT_AWAY = '{{AMSG_AWAY_HINT}}';
const SLOT_TASK = '{{AMSG_TASK_INSTRUCTION}}';
const SLOT_SELF_LOG = '{{AMSG_SELF_LOG}}';
const SLOT_TASK_LIST = '{{AMSG_TASK_LIST}}';
/** 自述回寫那一段的小標題（utils/amsgFirePack.ts renderSelfLogBlock），S9 靠它判斷段落到沒到。 */
const SELF_LOG_HEADING = '【這之後你又主動發過（對方還沒回）】';
/** 排程清單那一段的小標題（utils/amsg2Tasks.ts buildFireTaskListBlock）。 */
const TASK_LIST_HEADING = '【你還掛著這些排程·僅你可見】';
/**
 * 客戶端打上來的 fire_pack（v3）。槽位順序照客戶端實際打包的樣子：自述回寫緊跟對話記錄，
 * 排程清單在時間信息之後、本次任務之前。
 * opts: { fillerKb 世界書填充體積, builtAt 打包時刻, pendingTasks 打包那一刻掛著的任務 }
 */
const firePack = (marker, lastUserMessageAt, opts = {}) => ({
  v: 3,
  template: [
    `【角色系統設定】${marker} 的完整人設……`,
    opts.fillerKb ? `【世界書填充】${'填'.repeat(opts.fillerKb * 512)}【填充結束FILLER_END】` : '',
    '【最近對話上下文】',
    'user: 想起什麼就跟我說。',
    SLOT_SELF_LOG,
    `當前本地時間：${SLOT_TIME}`,
    SLOT_SINCE,
    SLOT_AWAY,
    SLOT_TASK_LIST,
    '【本次任務】',
    SLOT_TASK,
  ].join('\n'),
  lastUserMessageAt,
  // 與客戶端 buildFirePack 同款（必填）：worker 側一切給角色看的時間都按這個參照系渲染。
  tzId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  targetName: '測試者',
  builtAt: opts.builtAt ?? Date.now(),
  pendingTasks: opts.pendingTasks ?? [],
});
const toolPack = (charName) => ({
  v: 1,
  charName,
  xhsEnabled: false,
  // 2026-06 不在激活月清單 → runRecall 走「取回月度總結」正路（激活月按設計返回 null）
  activeMemoryMonths: [],
  memories: [{ date: '2026-06-15', summary: 'RECALL_MEMORY_MARKER 六月一起看了煙花', mood: '開心' }],
});
const presence = (charId, activeAt, lastUserMessageAt) => ({ v: 1, charId, activeAt, lastUserMessageAt });

// 復刻 activeMsgClient.scheduleCharacterTask 的 AI 任務 payload（字段一字不差）
function aiTaskPayload({ charId, charName, mode, firstSendTime, recurrenceType, expirePolicy, anchorMs, taskInstruction, frozenPrompt }) {
  const clientTaskId = crypto.randomUUID();
  return {
    clientTaskId,
    payload: {
      contactName: charName,
      avatarUrl: null,
      messageType: mode,
      messageSubtype: 'chat',
      firstSendTime,
      recurrenceType,
      pushSubscription: subscriptionFor(charId),
      metadata: {
        charId, charName,
        source: 'active_msg_2',
        amsgMode: mode,
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: expirePolicy,
        amsgRecurrence: recurrenceType,
        amsgAnchorMs: anchorMs ?? 0,
        amsgTaskInstruction: taskInstruction,
      },
      completePrompt: frozenPrompt,
      apiUrl: 'https://llm.test/v1/chat/completions',
      apiKey: 'sk-e2e',
      primaryModel: 'mock-model',
    },
  };
}

// ══════════════════════════ 場景 ══════════════════════════
try {
  section('S0 鑑權 / CORS / capabilities');
  {
    const r1 = await realFetch(`${BASE}/capabilities`);
    check('無密鑰請求被 401 拒絕', r1.status === 401, `got ${r1.status}`);
    const r2 = await realFetch(`${BASE}/capabilities`, { headers: { 'X-Client-Token': 'wrong' } });
    check('錯誤密鑰被 401 拒絕', r2.status === 401, `got ${r2.status}`);
    const pre = await realFetch(`${BASE}/schedule-message`, {
      method: 'OPTIONS', headers: { origin: 'https://sully.example', 'access-control-request-method': 'POST' },
    });
    check('CORS 預檢 204 + allow-origin *', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*',
      `status=${pre.status} origin=${pre.headers.get('access-control-allow-origin')}`);
    const caps = await client.getCapabilities();
    // 與 package.json 聲明的 amsg-server 版本對比（不寫死）：升依賴後 harness 零改動，
    // 且能抓住「升了依賴忘了 pnpm build:workers 重打 bundle」——bundle 內嵌的是舊版本號。
    const declaredServer = String(
      require(`${REPO}/package.json`).devDependencies['@rei-standard/amsg-server'] || '',
    ).replace(/^[\^~]/, '');
    check(`capabilities: serverVersion 與 package.json 聲明一致（${declaredServer}）`,
      !!declaredServer && caps?.serverVersion === declaredServer, JSON.stringify(caps));
    for (const f of ['client-state', 'client-state-chunking', 'agentic-hooks', 'agentic-scratch', 'vapid-public-key']) {
      check(`capabilities.features 含 ${f}`, caps?.features?.includes(f));
    }
  }

  section('S1 連接流程：init-tenant → get-user-key → vapid-public-key');
  {
    const init = await (await realFetch(`${BASE}/init-tenant`, { method: 'POST', headers: authedHeaders() })).json();
    check('POST /init-tenant 冪等建表成功', init?.success === true, JSON.stringify(init));
    const init2 = await (await realFetch(`${BASE}/init-tenant`, { method: 'POST', headers: authedHeaders() })).json();
    check('再次 init-tenant 冪等', init2?.success === true);
    await client.init();
    check('client.init() 拿到 user key（加密通道就緒）', true);
    const vk = await client.getVapidPublicKey();
    check('GET /vapid-public-key 與 env 一致', vk === vapidKeys.publicKey);
  }

  section('S2 fixed 一次性任務端到端（排程 → cron → push → 解密驗文）');
  {
    const clientTaskId = crypto.randomUUID();
    const sched = await scheduleTask({
      contactName: '小固', avatarUrl: null,
      messageType: 'fixed', messageSubtype: 'chat',
      userMessage: '到點了，這是固定消息正文。',
      firstSendTime: new Date(Date.now() + 1000).toISOString(),
      recurrenceType: 'none',
      pushSubscription: subscriptionFor('char-fixed'),
      metadata: {
        charId: 'char-fixed', charName: '小固', source: 'active_msg_2', amsgMode: 'fixed',
        amsgClientTaskId: clientTaskId, amsgExpirePolicy: 'force', amsgRecurrence: 'none', amsgAnchorMs: 0,
      },
    });
    check('schedule-message(fixed) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const listed = await listAllTasks();
    const row = listed.tasks.find((t) => t.uuid === sched.data.uuid);
    check('GET /messages 投影 charId', row?.charId === 'char-fixed', JSON.stringify(row));
    check('GET /messages 投影 clientTaskId', row?.clientTaskId === clientTaskId);
    await sleep(1400);
    await runCron();
    const mine = pushes.filter((p) => p.tag === 'char-fixed');
    check('cron 到點後收到 1 條 push', mine.length === 1, `got ${mine.length}`);
    const p = mine[0]?.payload;
    check('push 正文 = 固定消息原文', p?.message === '到點了，這是固定消息正文。', JSON.stringify(p?.message));
    check('push 元數據帶 amsgClientTaskId（送達歸屬鍵）', p?.metadata?.amsgClientTaskId === clientTaskId);
    check('push messageIndex/totalMessages = 1/1', p?.messageIndex === 1 && p?.totalMessages === 1);
    check('push 帶 VAPID Authorization 頭', String(mine[0]?.headers?.Authorization || mine[0]?.headers?.authorization || '').startsWith('vapid'));
    const after = await listAllTasks();
    check('一次性任務發完即從遠端清單消失', !after.tasks.some((t) => t.uuid === sched.data.uuid));
  }

  section('S3 滿血 v2：fire_pack 現場填槽 + RECALL 工具循環 + directives + daily 推進');
  let s3uuid = null;
  {
    const now = Date.now();
    // 大值：fire_pack 裡塞 ~256KB 填充，驗證 2.6.0-next.4 存儲層透明分塊讀回
    await putState([
      { namespace: NS('char-full'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-full', now - 3600_000, { fillerKb: 512 })), updatedAt: now },
      { namespace: NS('char-full'), key: 'tool_pack', value: JSON.stringify(toolPack('小滿')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: JSON.stringify({ v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false }), updatedAt: now },
    ]);
    check('putClientState(fire_pack ~256KB + tool_pack + tool_config) 成功', true);

    const fireAt = new Date(now + 1000);
    const { payload, clientTaskId } = aiTaskPayload({
      charId: 'char-full', charName: '小滿', mode: 'auto',
      firstSendTime: fireAt.toISOString(), recurrenceType: 'daily', expirePolicy: 'expire',
      anchorMs: now - 3600_000, // 錨點=1小時前的最後用戶消息；fire_pack.lastUserMessageAt 同值 → 不作廢
      taskInstruction: '這是一條需要 AI 自主生成的主動消息。\nTASK_SLOT_MARKER_FULL\n可選靈感補充：無',
      frozenPrompt: 'FROZEN_char-full 排程時凍結的完整 prompt（不應被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule-message(auto/daily) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    s3uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('工具循環共 2 輪 LLM 調用', reqs.length === 2, `got ${reqs.length}`);
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('第 1 輪 prompt 來自 fire_pack 現場渲染（非凍結 prompt）', r1c.includes('FIREPACK_FRESH_char-full') && !r1c.includes('FROZEN_char-full'));
    check('大值分塊讀回完整（256KB 填充尾標在）', r1c.includes('【填充結束FILLER_END】'));
    // ② 起時間槽是自然中文（與 buildCoreContext 同款）：2026年8月1日 週六 早晨 08:00
    check('時間槽位已在 fire 時刻填值（自然中文格式）',
      /[当當]前本地[时時][间間]：\d{4}年\d{1,2}月\d{1,2}日 周[日一二三四五六] (?:凌晨|早晨|上午|中午|下午|傍晚|晚上|深夜) \d{2}:\d{2}/.test(r1c)
      && !r1c.includes(SLOT_TIME));
    check('任務指令槽位從 task metadata 填入', r1c.includes('TASK_SLOT_MARKER_FULL') && !r1c.includes(SLOT_TASK));
    check('時間差文案按 fire 時刻現算（約 1 小時）', /距[离離]用[户戶]上次主[动動][发發]消息大[约約] 1 小[时時]/.test(r1c), r1c.match(/距[离離]用[户戶][^\n]*/)?.[0]);
    const r2msgs = reqs[1]?.messages || [];
    const toolMsg = r2msgs.find((m) => m.role === 'tool');
    check('第 2 輪帶回 RECALL 工具結果（月度總結命中）', String(toolMsg?.content || '').includes('RECALL_MEMORY_MARKER'), String(toolMsg?.content || '').slice(0, 120));

    const mine = pushes.filter((p) => p.tag === 'char-full');
    check('finish 後按行分段推送 3 條', mine.length === 3, `got ${mine.length}`);
    const [p1, , pLast] = [mine[0]?.payload, mine[1]?.payload, mine[mine.length - 1]?.payload];
    check('旁白（round-1 prefix）保序排在正文前', String(p1?.message || '').includes('翻翻記憶'), JSON.stringify(p1?.message));
    check('正文引用工具結果（跨輪上下文連續）', mine.some((m) => String(m.payload?.message || '').includes('煙花')));
    check('directives 只掛最後一條 push', !!pLast?.metadata?.directives?.length && mine.slice(0, -1).every((m) => !m.payload?.metadata?.directives));
    check('POKE 副作用被結構化為 directive', JSON.stringify(pLast?.metadata?.directives || []).toLowerCase().includes('poke'));
    check('正文不再含 [[ACTION:POKE]] 裸標籤', mine.every((m) => !String(m.payload?.message || '').includes('[[ACTION:POKE]]')));
    check('每條 push 帶 amsgOccurrenceMs = 本次觸發時刻', mine.every((m) => m.payload?.metadata?.amsgOccurrenceMs === fireAt.getTime()),
      JSON.stringify(mine.map((m) => m.payload?.metadata?.amsgOccurrenceMs)));
    check('push 元數據帶 amsgClientTaskId', mine.every((m) => m.payload?.metadata?.amsgClientTaskId === clientTaskId));
    check('通知橫幅 body 為淨化文本', mine.every((m) => typeof m.payload?.notification?.body === 'string' && !m.payload.notification.body.includes('[[')));
    check('messageIndex 1-based 連續編號', mine.map((m) => m.payload?.messageIndex).join(',') === '1,2,3' && mine.every((m) => m.payload?.totalMessages === 3));

    const listed = await listAllTasks();
    const row = listed.tasks.find((t) => t.uuid === s3uuid);
    check('daily 任務 fire 後仍在清單且 next_send_at +24h', !!row && Math.abs(new Date(row.nextSendAt).getTime() - (fireAt.getTime() + 24 * 3600_000)) < 1500,
      JSON.stringify({ nextSendAt: row?.nextSendAt, expect: new Date(fireAt.getTime() + 24 * 3600_000).toISOString() }));
    check('清單行仍帶 charId/clientTaskId 投影', row?.charId === 'char-full' && row?.clientTaskId === clientTaskId);
    const cancel = await cancelTask(s3uuid);
    check('cancel-message 取消 daily 任務成功', cancel?.success === true, JSON.stringify(cancel));
    const after = await listAllTasks();
    check('取消後遠端清單不再含該任務', !after.tasks.some((t) => t.uuid === s3uuid));
  }

  section('S4 防穿幫閘：一次性任務錨點後有新用戶消息 → onBeforeFire skip');
  {
    const now = Date.now();
    const anchor = now - 3600_000;
    await putState([
      // 用戶在排程後（錨點後）又說過話：lastUserMessageAt > anchor → 應作廢
      { namespace: NS('char-anchor'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-anchor', anchor + 60_000)), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-anchor', charName: '小錨', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: anchor,
      taskInstruction: '（skip 場景不應見到這條指令進入 LLM）',
      frozenPrompt: 'FROZEN_char-anchor（skip 場景不應被調用）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    check('skip：零 LLM 調用', llmRequests.length === llmBefore, `+${llmRequests.length - llmBefore}`);
    check('skip：零 push', pushes.length === pushBefore, `+${pushes.length - pushBefore}`);
    const listed = await listAllTasks();
    check('skip 出口任務照常出清（一次性刪除，不再重試）', !listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S5a 活躍會話租約新鮮 → 無 fire_pack 也攔（第一道快速門）');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-presence'), key: 'chat_presence', value: JSON.stringify(presence('char-presence', now, now - 5000)), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-presence', charName: '小租', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '（presence skip 場景不應進入 LLM）',
      frozenPrompt: 'FROZEN_char-presence（presence skip 場景不應被調用）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    check('新鮮租約 → 零 LLM / 零 push', llmRequests.length === llmBefore && pushes.length === pushBefore,
      `llm+${llmRequests.length - llmBefore} push+${pushes.length - pushBefore}`);
    const listed = await listAllTasks();
    check('presence skip 後任務出清', !listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S5b 租約過期 + 無 fire_pack → 拋 AMSG2_FIRE_STATE_MISSING（不降級）');
  {
    const now = Date.now();
    await putState([
      // 過期租約（2 分鐘前）不攔；該角色沒有 fire_pack → 雲端狀態不全，onBeforeFire 直接拋錯。
      // 任務體裡那份凍結 prompt 是排程那一刻的上下文，發出去用戶根本看不出它是舊的——
      // 寧可這次不發（走投遞失敗路徑重試），也不拿它頂包。
      { namespace: NS('char-frozen'), key: 'chat_presence', value: JSON.stringify(presence('char-frozen', now - 120_000, now - 120_000)), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-frozen', charName: '小凍', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '（狀態缺失場景不應進入 LLM）',
      frozenPrompt: 'FROZEN_char-frozen 排程時凍結的完整 prompt，不該再被任何路徑吃到。',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    const reqs = llmRequests.slice(llmBefore);
    check('狀態缺失 → 零 LLM 調用（不吃凍結 prompt）', reqs.length === 0, `reqs=${reqs.length}`);
    const mine = pushes.slice(pushBefore).filter((p) => p.tag === 'char-frozen');
    check('狀態缺失 → 零 push', mine.length === 0, JSON.stringify(mine.map((m) => m.payload?.message)));
    const listed = await listAllTasks();
    check('任務不被當成發完出清（留在遠端等重試）', listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S5c fire_pack 缺 tzId → 整包按格式不對打回（tzId 必填，沒有第二套時間算法）');
  {
    const now = Date.now();
    const { tzId: _tz, ...packNoTz } = firePack('FIREPACK_NOTZ_char-no-tz', now);
    await putState([
      { namespace: NS('char-no-tz'), key: 'fire_pack', value: JSON.stringify(packNoTz), updatedAt: now },
      { namespace: NS('char-no-tz'), key: 'tool_pack', value: JSON.stringify(toolPack('小無')), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-no-tz', charName: '小無', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000,
      taskInstruction: '（缺 tzId 場景不應進入 LLM）',
      frozenPrompt: 'FROZEN_char-no-tz（不應被用到）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    check('缺 tzId → 零 LLM 調用（parse 失敗走 fire-state 錯誤路徑）',
      llmRequests.length === llmBefore, `llm+${llmRequests.length - llmBefore}`);
    const mine = pushes.slice(pushBefore).filter((p) => p.tag === 'char-no-tz');
    check('缺 tzId → 零 push', mine.length === 0, JSON.stringify(mine.map((m) => m.payload?.message)));
    const listed = await listAllTasks();
    check('缺 tzId 的任務留在遠端等重試（不靜默出清）', listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S6 force 策略：新鮮租約 + 錨點已前進也照發（鬧鐘語義）');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-force'), key: 'chat_presence', value: JSON.stringify(presence('char-force', now, now)), updatedAt: now },
      { namespace: NS('char-force'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-force', now)), updatedAt: now },
      // tool_pack 與 fire_pack 同批上傳，缺一樣就是狀態異常（worker 直接拋錯）。
      // 這節測的是 force 繞開閘，狀態得給齊，別把斷言掛在別的原因上。
      { namespace: NS('char-force'), key: 'tool_pack', value: JSON.stringify(toolPack('小強')), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-force', charName: '小強', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000,
      taskInstruction: 'FORCE_TASK_MARKER 到點必須叫用戶',
      frozenPrompt: 'FROZEN_char-force（不應被用到）',
    });
    const sched = await scheduleTask(payload);
    const uuid = sched?.data?.uuid;
    const llmBefore = llmRequests.length; const pushBefore = pushes.length;
    await sleep(1400);
    await runCron();
    const reqs = llmRequests.slice(llmBefore);
    check('force：照走滿血鏈路（fire_pack 渲染 + 任務槽）', reqs.length === 1 && JSON.stringify(reqs[0]).includes('FIREPACK_FRESH_char-force') && JSON.stringify(reqs[0]).includes('FORCE_TASK_MARKER'), `reqs=${reqs.length}`);
    const mine = pushes.slice(pushBefore).filter((p) => p.tag === 'char-force');
    check('force：push 送達', mine.length >= 1 && String(mine[0]?.payload?.message || '').includes('照發'));
    const listed = await listAllTasks();
    check('force 任務發完出清', !listed.tasks.some((t) => t.uuid === uuid));
  }

  section('S6b 旁路存儲：客戶端讀回 + 寫空值刪除（push 裝不下時的取回路徑）');
  {
    // worker 把裝不下一條 push 的 XHS 會話數據寫進 client_state、push 只帶引用鍵，
    // 客戶端上線後按鍵取回再刪。這裡驗的就是取回和刪除這兩步——它們走的是 HTTP
    // GET/PUT /client-state，跟 hook 的 writeState 是同一張表，兩邊必須真的通。
    const ns = NS('char-offload');
    const key = 'xhs_session:task-offload-1';
    const value = JSON.stringify({
      notes: [{ idx: 1, note: { noteId: 'note-1', title: '旁路筆記', desc: '描述', likes: 1, author: 'a', authorId: 'a1' } }],
      xsecTokens: [['note-1', 'tok-1']],
    });
    await putState([{ namespace: ns, key, value, updatedAt: Date.now() }]);

    const read = await client.getClientState(ns);
    const hit = (read?.data?.entries || []).find((e) => e.key === key);
    check('按 namespace + key 讀回旁路存儲，內容逐字一致', hit?.value === value, JSON.stringify(hit?.value || read));

    // 客戶端只能把內容清空，刪不掉整行：`value: null` 的刪除語義是 hook 側
    // ctx.writeState 獨有的，HTTP PUT 會把這條當無效條目跳過。這條斷言就是釘住這個
    // 差異——別哪天照著 writeState 的用法改客戶端，然後以為自己清乾淨了。
    await client.putClientState([{ namespace: ns, key, value: null, updatedAt: Date.now() }]);
    const afterNull = await client.getClientState(ns);
    const nullNoop = (afterNull?.data?.entries || []).find((e) => e.key === key);
    check('HTTP PUT 不認 value:null（內容原封不動，刪不掉行）', nullNoop?.value === value, JSON.stringify(nullNoop?.value));

    await client.putClientState([{ namespace: ns, key, value: '', updatedAt: Date.now() }]);
    const afterClear = await client.getClientState(ns);
    const cleared = (afterClear?.data?.entries || []).find((e) => e.key === key);
    check('寫空串把內容清掉（取回落庫後騰回空間）', cleared !== undefined && !cleared.value, JSON.stringify(cleared));
  }

  section('S7 clear-client-state（設置頁「清除雲端狀態」）');
  {
    const r = await client.clearClientState();
    check('clearClientState 成功且刪除了條目', r?.success === true && (r?.data?.deleted ?? 0) > 0, JSON.stringify(r));
  }

  // S8 / S8b 共用全局 namespace 的那行 tool_config（後者覆蓋前者），必須順序跑；
  // 跑完這兩段它就停在「帶 MCP 配置」的版本，後面再加場景要自己重寫這一行。
  section('S8 通用 MCP · native：tools 聲明 → 真連服務器 → 結果回喂 → 暗號進 push');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-native'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-native', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-native'), key: 'tool_pack', value: JSON.stringify(toolPack('小滿')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(true), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-native', charName: '小滿', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '問一下今天的暗號，然後告訴用戶。',
      frozenPrompt: 'FROZEN_char-mcp-native（不應被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule-message(MCP native) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length; const pushBefore = pushes.length; const mcpBefore = mcpSeen.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('native：工具循環共 2 輪 LLM 調用', reqs.length === 2, `got ${reqs.length}`);
    const declared = Array.isArray(reqs[0]?.tools) ? reqs[0].tools.map((t) => t?.function?.name) : null;
    check('第 1 輪請求體聲明了 mcp__ 工具（native tools 數組）',
      Array.isArray(reqs[0]?.tools) && declared.includes('mcp__get_secret_word'), JSON.stringify(declared));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('提示詞尾部帶 MCP 工具塊（列出工具與說明）',
      r1c.includes('【外部工具') && r1c.includes('- get_secret_word：取回今日暗號'), r1c.slice(-300));
    check('native 模式不教正文調用協議（教了反而勾引模型往正文寫）',
      !r1c.includes('tool_name({"參數":"值"})') && !r1c.includes('get_secret_word('), r1c.slice(-300));
    const mcpCalls = mcpSeen.slice(mcpBefore);
    check('worker 真連了 MCP 服務器（initialize + tools/call）',
      mcpCalls.includes('initialize') && mcpCalls.includes('tools/call'), JSON.stringify(mcpCalls));

    const r2msgs = reqs[1]?.messages || [];
    const assistant = r2msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    check('第 2 輪 assistant 消息原樣帶回 native tool_calls',
      assistant?.tool_calls?.[0]?.id === 'call_mcp_1'
      && assistant?.tool_calls?.[0]?.function?.name === 'mcp__get_secret_word',
      JSON.stringify(assistant?.tool_calls));
    const toolMsg = r2msgs.find((m) => m.role === 'tool');
    check('tool 消息與 assistant 的 tool_call id 配對', toolMsg?.tool_call_id === 'call_mcp_1', JSON.stringify(toolMsg?.tool_call_id));
    const toolText = String(toolMsg?.content || '');
    check('工具結果按暗號原文回喂', toolText.includes(MCP_PASSPHRASE), toolText.slice(0, 160));
    check('回喂措辭可讀，且不漏 mcp__ 內部前綴',
      toolText.includes('調用「get_secret_word」') && !toolText.includes('mcp__'), toolText.slice(0, 160));

    const mine = pushes.slice(pushBefore).filter((p) => p.tag === 'char-mcp-native');
    check('native：push 帶回暗號', mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)),
      JSON.stringify(mine.map((m) => m.payload?.message)));
    check('native：旁白保序排在正文前', String(mine[0]?.payload?.message || '').includes('問問那邊'), JSON.stringify(mine[0]?.payload?.message));
    check('native：正文無工具調用語法殘留', mine.every((m) => !String(m.payload?.message || '').includes('get_secret_word(')));
  }

  section('S8b 通用 MCP · 正文兜底：中轉拒 tools → 提示詞教協議 → 正文調用被識別');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-text'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-text', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-text'), key: 'tool_pack', value: JSON.stringify(toolPack('小滿')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(false), updatedAt: now },
    ]);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-text', charName: '小滿', mode: 'auto',
      firstSendTime: new Date(now + 1000).toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: now - 3600_000,
      taskInstruction: '問一下今天的暗號，然後告訴用戶。',
      frozenPrompt: 'FROZEN_char-mcp-text（不應被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule-message(MCP 正文兜底) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length; const pushBefore = pushes.length; const mcpBefore = mcpSeen.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('正文兜底：工具循環共 2 輪 LLM 調用', reqs.length === 2, `got ${reqs.length}`);
    check('兩輪請求體都不帶 tools 參數（中轉拒 tools 的場景）',
      reqs.every((r) => !('tools' in r)), JSON.stringify(reqs.map((r) => Object.keys(r))));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('提示詞改教正文調用協議（帶參數簽名與寫法示例）',
      r1c.includes('- get_secret_word(asked_by:string)：取回今日暗號') && r1c.includes('tool_name({"參數":"值"})'),
      r1c.slice(-300));
    const mcpCalls = mcpSeen.slice(mcpBefore);
    check('正文裡的調用被識別並真跑到了 MCP 服務器',
      mcpCalls.includes('initialize') && mcpCalls.includes('tools/call'), JSON.stringify(mcpCalls));
    const toolText = String((reqs[1]?.messages || []).find((m) => m.role === 'tool')?.content || '');
    check('正文兜底：工具結果按暗號原文回喂', toolText.includes(MCP_PASSPHRASE), toolText.slice(0, 160));

    const mine = pushes.slice(pushBefore).filter((p) => p.tag === 'char-mcp-text');
    check('正文兜底：push 帶回暗號', mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)),
      JSON.stringify(mine.map((m) => m.payload?.message)));
    check('正文兜底：調用語法被剝掉，不進 push',
      mine.length > 0 && mine.every((m) => !String(m.payload?.message || '').includes('get_secret_word(')),
      JSON.stringify(mine.map((m) => m.payload?.message)));
  }

  section('S9 自排鏈：角色到點給自己排下一條，下一條接得上（用戶全程不上線）');
  {
    const ns = NS('char-chain');
    const t0 = Date.now();
    const builtAt = t0 - 120_000;   // 客戶端兩分鐘前聊完那一輪打的包
    const readSelfLog = async () => {
      const read = await client.getClientState(ns);
      const hit = (read?.data?.entries || []).find((e) => e.key === 'self_log');
      if (!hit?.value) return null;
      try { return JSON.parse(hit.value); } catch { return { parseError: hit.value }; }
    };
    const taskRecord = (over) => ({
      mode: 'auto', recurrenceType: 'none', expirePolicy: 'expire',
      anchorLastUserMsgAt: t0 - 3600_000, source: 'user', status: 'scheduled', createdAt: builtAt, ...over,
    });
    const promptsOf = (from) => llmRequests.slice(from)
      .map((r) => r.messages.map((m) => String(m.content)).join('\n')).join('\n');

    // ── 第一次觸發：角色一邊說話一邊給自己排下一條 ──
    const fire1 = new Date(t0 + 1000);
    const first = aiTaskPayload({
      charId: 'char-chain', charName: '小鏈', mode: 'auto',
      firstSendTime: fire1.toISOString(), recurrenceType: 'none', expirePolicy: 'expire',
      anchorMs: t0 - 3600_000,
      taskInstruction: '第一條：隨口給用戶留個口令。',
      frozenPrompt: 'FROZEN_char-chain（不應被用到）',
    });
    const sched1 = await scheduleTask(first.payload);
    check('schedule-message(自排鏈·第一條) 成功', sched1?.success === true, JSON.stringify(sched1?.error || sched1));

    // fire_pack 裡放兩條「客戶端此刻已知的排程」：正在發的這條（應被摘掉）+ 另一條掛著的（應列出）
    const otherTask = taskRecord({
      taskUuid: 'chainother-0001', clientTaskId: 'chain-other-client',
      firstSendTime: new Date(t0 + 3600_000).toISOString(),
    });
    const firingTask = taskRecord({
      taskUuid: sched1?.data?.uuid, clientTaskId: first.clientTaskId, firstSendTime: fire1.toISOString(),
    });
    await putState([
      { namespace: ns, key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-chain', t0 - 3600_000, { builtAt, pendingTasks: [otherTask, firingTask] })), updatedAt: t0 },
      { namespace: ns, key: 'tool_pack', value: JSON.stringify(toolPack('小鏈')), updatedAt: t0 },
      // S8/S8b 把全局那行換成帶 MCP 的版本了，這裡換回無工具版——本場景只測自排鏈
      { namespace: 'amsg:global', key: 'tool_config', value: JSON.stringify({ v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false }), updatedAt: t0 },
    ]);

    let llmBefore = llmRequests.length;
    let pushBefore = pushes.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('第一次觸發跑了三輪（排程被打回 → 改口重排 → 寫正文）', reqs.length === 3, `got ${reqs.length}`);
    const p1 = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    const declared = Array.isArray(reqs[0]?.tools) ? reqs[0].tools.map((t) => t?.function?.name) : null;
    check('請求裡聲明了 schedule_active_message（角色手上真有這個工具）',
      !!declared?.includes('schedule_active_message'), JSON.stringify(declared));
    check('提示詞帶「你可以給自己排下一條」說明塊', p1.includes('【你可以給自己排下一條】'), p1.slice(-400));
    check('第一次沒有自述段（雲端還沒日誌）', !p1.includes(SELF_LOG_HEADING));
    check('空日誌時槽位被抹平，不裸露給模型', !p1.includes(SLOT_SELF_LOG));
    check('排程清單塊列出另一條掛著的任務', p1.includes(TASK_LIST_HEADING) && p1.includes('[chainoth]'),
      p1.slice(p1.indexOf(TASK_LIST_HEADING), p1.indexOf(TASK_LIST_HEADING) + 200));
    check('排程清單塊摘掉正在發的這一條（否則角色以為還要再排一次）',
      !p1.includes(`[${String(sched1?.data?.uuid).slice(0, 8)}]`));

    const fb1 = String((reqs[1]?.messages || []).find((m) => m.role === 'tool')?.content || '');
    check('時間寫太近被打回，回喂一句能照做的話（不讓整條 fire 失敗）',
      fb1.includes('send_at_too_soon') && fb1.includes('至少要比現在晚 1 分鐘'), fb1.slice(0, 200));
    const fb2 = String((reqs[2]?.messages || []).filter((m) => m.role === 'tool').pop()?.content || '');
    check('改口後排上了（回喂 ok:true + 任務號）',
      fb2.includes('"ok":true') && fb2.includes('排好了'), fb2.slice(0, 200));

    const mine1 = pushes.slice(pushBefore).filter((p) => p.tag === 'char-chain');
    const text1 = mine1.map((m) => String(m.payload?.message || '')).join('\n');
    check('第一條 push 帶上口令', text1.includes('CHAIN-PASS-8823'), text1);
    const selfScheduled = mine1[mine1.length - 1]?.payload?.metadata?.amsgSelfScheduled;
    check('自排的任務隨最後一條 push 帶回客戶端認領',
      Array.isArray(selfScheduled) && selfScheduled.length === 1, JSON.stringify(selfScheduled));
    check('只掛最後一條（收側 isLastChunk 保證只重放一次）',
      mine1.slice(0, -1).every((m) => !m.payload?.metadata?.amsgSelfScheduled));
    const selfTask = selfScheduled?.[0];
    check('帶回的記錄標著來源是角色自己排的', selfTask?.source === 'character' && selfTask?.mode === 'prompted',
      JSON.stringify(selfTask));
    check('任務 uuid 由角色 + 本次觸發時刻推出來（投遞失敗重跑不會多排一條）',
      selfTask?.taskUuid === `amsgself-char-chain-${fire1.getTime()}-0`, String(selfTask?.taskUuid));

    const listedAfter1 = await listAllTasks();
    const bRow = listedAfter1.tasks.find((t) => t.uuid === selfTask?.taskUuid);
    check('自排的任務真在遠端建了行（不依賴客戶端在線）', !!bRow, JSON.stringify(listedAfter1.tasks.map((t) => t.uuid)));
    check('遠端行投影 charId / clientTaskId（面板列得出、用戶也能取消）',
      bRow?.charId === 'char-chain' && bRow?.clientTaskId === selfTask?.clientTaskId, JSON.stringify(bRow));
    const wantMs = new Date(selfTask?.firstSendTime).getTime();
    check('遠端行的觸發時刻 = 角色要的那個時間', !!bRow && new Date(bRow.nextSendAt).getTime() === wantMs,
      JSON.stringify({ got: bRow?.nextSendAt, want: selfTask?.firstSendTime }));
    check('角色要的是 5 分鐘後（改口後那次）', Math.abs(wantMs - (Date.now() + 5 * 60_000)) < 5000,
      `差 ${Math.round((wantMs - Date.now()) / 1000)}s`);

    const log1 = await readSelfLog();
    check('發完把正文寫回雲端（1 條）', log1?.v === 2 && log1?.entries?.length === 1, JSON.stringify(log1?.entries));
    check('日誌錨在這份 fire_pack 的 builtAt 上', log1?.basePackAt === builtAt,
      JSON.stringify({ got: log1?.basePackAt, want: builtAt }));
    check('記的就是剛發出去那條正文（含口令）',
      String(log1?.entries?.[0]?.text || '').includes('CHAIN-PASS-8823'), JSON.stringify(log1?.entries?.[0]));
    // ⑥ 起 at 記的是**實際發送時刻**（onAfterSend 裡取的 now），不再是名義 occurrenceMs；
    // 去重仍靠 id = clientTaskId@occurrenceMs，重試不會記成兩條。
    check('時間戳是實際發送時刻（≥ 名義時刻、在本輪 cron 的合理窗口內）',
      typeof log1?.entries?.[0]?.at === 'number'
      && log1.entries[0].at >= fire1.getTime()
      && log1.entries[0].at <= Date.now(),
      JSON.stringify({ got: log1?.entries?.[0]?.at, nominal: fire1.getTime(), now: Date.now() }));
    check('去重 id 仍錨在名義時刻上（clientTaskId@occurrenceMs）',
      String(log1?.entries?.[0]?.id || '').endsWith(`@${fire1.getTime()}`),
      JSON.stringify(log1?.entries?.[0]?.id));
    check('自排的任務也記進日誌（客戶端沒認領之前，下次到點仍看得見）',
      log1?.tasks?.length === 1 && log1.tasks[0].taskUuid === selfTask?.taskUuid, JSON.stringify(log1?.tasks));

    // ── 時間旅行：任務確實排在 5 分鐘後（上面已斷言），harness 不真等那 5 分鐘，
    //    把遠端行的到點時刻改到現在，讓下一跳 cron 撈到它。改的只是「什麼時候到點」，
    //    鏈路其餘部分照常跑。客戶端從頭到尾沒上線過，也沒認領這條任務。
    const dueAt = new Date(Date.now() - 1000).toISOString();
    d1.db.prepare('UPDATE scheduled_messages SET next_send_at = ? WHERE uuid = ?').run(dueAt, selfTask?.taskUuid);

    llmBefore = llmRequests.length;
    pushBefore = pushes.length;
    await runCron();

    const reqs2 = llmRequests.slice(llmBefore);
    check('第二次到點自動觸發（用戶全程沒上線）', reqs2.length === 1, `got ${reqs2.length}`);
    const p2 = promptsOf(llmBefore);
    check('第二次 prompt 出現自述段', p2.includes(SELF_LOG_HEADING), p2.slice(0, 300));
    check('自述段裡是第一條的原話（口令讀得回來）', p2.includes('CHAIN-PASS-8823'));
    check('自述段落在對話記錄之後、本次任務之前（讀起來是一條時間線）',
      p2.indexOf(SELF_LOG_HEADING) > p2.indexOf('【最近對話上下文】')
      && p2.indexOf(SELF_LOG_HEADING) < p2.indexOf('【本次任務】'));
    check('本次任務指令是角色自己當初寫的方向', p2.includes('接著口令那件事往下說'),
      p2.slice(p2.indexOf('【本次任務】'), p2.indexOf('【本次任務】') + 200));
    check('排程清單不再列正在發的這條自排任務',
      !p2.includes(`[${String(selfTask?.taskUuid).slice(0, 8)}]`));

    const mine2 = pushes.slice(pushBefore).filter((p) => p.tag === 'char-chain');
    const text2 = mine2.map((m) => String(m.payload?.message || '')).join('\n');
    check('第二條 push 接著上一條說（複述了自己留的口令）',
      text2.includes('CHAIN-PASS-8823') && text2.includes('沒忘'), text2);
    check('第二條 push 的觸發時刻 = 改寫後的到點時刻',
      mine2.every((m) => m.payload?.metadata?.amsgOccurrenceMs === new Date(dueAt).getTime()),
      JSON.stringify(mine2.map((m) => m.payload?.metadata?.amsgOccurrenceMs)));

    const log2 = await readSelfLog();
    check('兩次觸發各記一筆（累計 2 條，同一份日誌）',
      log2?.entries?.length === 2 && log2?.basePackAt === builtAt,
      JSON.stringify(log2?.entries?.map((e) => e.text)));
    const listedAfter2 = await listAllTasks();
    check('自排的一次性任務發完出清', !listedAfter2.tasks.some((t) => t.uuid === selfTask?.taskUuid));
  }
} catch (e) {
  failures++;
  console.error('\n💥 harness 異常中止：', e && e.stack || e);
} finally {
  server.close();
  mcpServer.close();
}

console.log(`\n═══ 結果：${results.filter((r) => r.ok).length}/${results.length} 通過，${failures} 失敗 ═══`);
process.exit(failures ? 1 : 0);
