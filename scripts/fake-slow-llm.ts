// fake-slow-llm — OpenAI-compatible 慢速假 LLM，純測試用。
//
// 幹什麼的: 假裝是一個 chat completions 端點, 收到請求後乾等一段時間
// (默認 120 秒) 再吐回覆。用來測 worker 在「LLM 很慢 + 客戶端斷開/殺 App」
// 場景下的存活窗口、超時與推送兜底, 不消耗任何真實 token。
//
// 跑法 (二選一):
//   - 本地:      deno run --allow-net --allow-env scripts/fake-slow-llm.ts
//   - 線上:      整個文件貼進 app.deno.com 的 Playground
//
// 配置 (全部可選):
//   - 環境變量 FAKE_DELAY_MS    默認 120000 (兩分鐘)
//   - 請求頭   x-fake-delay-ms  單次覆蓋, 方便不同場景混測
//
// 端點:
//   - GET  …/models, …/v1/models          → 模型列表 (過前端「測試連接」)
//   - POST …/chat/completions (任意前綴)   → 等 delay 後回非流式 JSON;
//                                           body 帶 stream:true 時回 SSE
//   - 其餘路徑 404
//
// API key 隨便填, 不校驗。

export {};

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

const DEFAULT_DELAY_MS = 120_000;
const MODEL_ID = 'fake-slow-llm';

// 多句回覆, 讓分句器能切出多條推送來測多段消息鏈路。
const REPLY_SENTENCES = [
  '這是一條來自假 LLM 的慢速測試回覆。',
  '如果你看到這條消息, 說明 worker 熬過了漫長的等待。',
  '現在可以確認推送鏈路在慢響應下依然完整。',
  '測試完成, 辛苦啦。',
];

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-fake-delay-ms',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function parseDelay(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null; // Number(null/'') 會變 0, 必須先擋掉
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolveDelayMs(request: Request): number {
  return (
    parseDelay(request.headers.get('x-fake-delay-ms')) ??
    parseDelay(Deno.env.get('FAKE_DELAY_MS')) ??
    DEFAULT_DELAY_MS
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function completionPayload(content: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-fake-${now}`,
    object: 'chat.completion',
    created: now,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * 非流式慢響應。不能傻等再一次性返回: Deno Deploy 邊緣網關對 ~105s 內
 * 不出首字節的響應直接回 502 (實測)。JSON 允許任意前導空白 —— 等待期間
 * 每 5s 滴一個空格保活, 最後吐完整 JSON, res.json() 照常解析。
 */
function slowJsonResponse(delayMs: number): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        const startedAt = Date.now();
        controller.enqueue(encoder.encode(' '));
        let remaining = delayMs - (Date.now() - startedAt);
        while (remaining > 0) {
          await sleep(Math.min(5000, remaining));
          controller.enqueue(encoder.encode(' '));
          remaining = delayMs - (Date.now() - startedAt);
        }
        controller.enqueue(
          encoder.encode(JSON.stringify(completionPayload(REPLY_SENTENCES.join('')))),
        );
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS } },
  );
}

/** stream:true 時: 等完 delay 再逐句吐 SSE chunk, 模擬慢首字 + 正常流速。 */
function streamResponse(delayMs: number): Response {
  const encoder = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-fake-${now}`,
      object: 'chat.completion.chunk',
      created: now,
      model: MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  return new Response(
    new ReadableStream({
      async start(controller) {
        // 等待期間用 SSE 註釋行保活, 防邊緣網關掐首字節超時 (同 slowJsonResponse)
        const startedAt = Date.now();
        let remaining = delayMs;
        while (remaining > 0) {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
          await sleep(Math.min(5000, remaining));
          remaining = delayMs - (Date.now() - startedAt);
        }
        controller.enqueue(encoder.encode(chunk({ role: 'assistant' }, null)));
        for (const sentence of REPLY_SENTENCES) {
          controller.enqueue(encoder.encode(chunk({ content: sentence }, null)));
          await sleep(200);
        }
        controller.enqueue(encoder.encode(chunk({}, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream', ...CORS_HEADERS } },
  );
}

Deno.serve(async (request: Request) => {
  const { pathname } = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // /models, /v1/models — 前端「測試連接」拉模型列表
  if (request.method === 'GET' && /\/models\/?$/.test(pathname)) {
    return json({
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'fake' }],
    });
  }

  // 任意前綴的 /chat/completions — 調用方會按 apiUrl 形態自動拼路徑
  if (request.method === 'POST' && /\/chat\/completions\/?$/.test(pathname)) {
    const delayMs = resolveDelayMs(request);
    let wantsStream = false;
    try {
      const body = await request.json();
      wantsStream = body?.stream === true;
    } catch {
      // body 不是 JSON 也無所謂, 反正是假的
    }

    if (wantsStream) return streamResponse(delayMs);
    return slowJsonResponse(delayMs);
  }

  return json({ error: { message: `no such route: ${request.method} ${pathname}` } }, 404);
});
