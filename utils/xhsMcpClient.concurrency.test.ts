// utils/xhsMcpClient.concurrency.test.ts
// MCP 握手的併發安全。
//
// mcpCallTool 裡是 `if (!mcpInitialized) await mcpInitialize(...)` 這種 check-then-act：
// 兩個調用同時進來時都會看到 mcpInitialized=false，於是各握一次手，後完成的那個把
// 模塊級 mcpSessionId 覆蓋掉——先發起的那個再拿它發 tools/call，用的就是別人的 session
// （表現是隨機的 MCP session error / 空結果）。
//
// worker 到點最多併發跑 8 個任務，兩個任務同一分鐘都用小紅書工具就會踩到。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SERVER = 'https://xhs.example.com/mcp';

/** 記錄每次 fetch 的 method 與帶上的 session 頭。 */
type Seen = { method: string; session: string | null };

const setupFetch = (opts: { initDelayMs: number }) => {
  const seen: Seen[] = [];
  let sessionSeq = 0;

  const fetchMock = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const session = (init.headers || {})['Mcp-Session-Id'] ?? null;
    seen.push({ method: body.method, session });

    if (body.method === 'initialize') {
      // 握手慢：給併發的第二個調用留出「也看到 mcpInitialized=false」的窗口
      await new Promise((r) => setTimeout(r, opts.initDelayMs));
      const id = `sess-${++sessionSeq}`;
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'mcp-session-id' ? id : 'application/json') },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }),
      };
    }
    if (body.method === 'tools/list') {
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'mcp-session-id' ? null : 'application/json') },
        text: async () => JSON.stringify({
          jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search' }] },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'mcp-session-id' ? null : 'application/json') },
      text: async () => JSON.stringify({
        jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"notes":[]}' }] },
      }),
    };
  });

  vi.stubGlobal('fetch', fetchMock);
  return { seen };
};

describe('XHS MCP 握手的併發安全', () => {
  beforeEach(() => {
    vi.resetModules();  // 模塊級 session 狀態每個用例重來
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('兩個調用併發進來，只握一次手（迴歸：重複 initialize）', async () => {
    const { seen } = setupFetch({ initDelayMs: 20 });
    const { XhsMcpClient } = await import('./xhsMcpClient');

    await Promise.all([
      XhsMcpClient.search(SERVER, 'k1'),
      XhsMcpClient.search(SERVER, 'k2'),
    ]);

    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
  });

  it('兩個併發調用帶的是同一個 session（迴歸：後握手的把先前的 session 覆蓋掉）', async () => {
    const { seen } = setupFetch({ initDelayMs: 20 });
    const { XhsMcpClient } = await import('./xhsMcpClient');

    await Promise.all([
      XhsMcpClient.search(SERVER, 'k1'),
      XhsMcpClient.search(SERVER, 'k2'),
    ]);

    const callSessions = seen.filter((s) => s.method === 'tools/call').map((s) => s.session);
    expect(callSessions).toHaveLength(2);
    expect(callSessions[0]).toBe('sess-1');
    expect(callSessions[1]).toBe('sess-1');
  });

  it('握手完成後的調用直接複用，不再重複握手', async () => {
    const { seen } = setupFetch({ initDelayMs: 0 });
    const { XhsMcpClient } = await import('./xhsMcpClient');

    await XhsMcpClient.search(SERVER, 'k1');
    await XhsMcpClient.search(SERVER, 'k2');

    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
  });

  it('握手失敗不留下「正在握手」的殘留，下一次調用能重新握手', async () => {
    const failing = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', failing);
    const { XhsMcpClient } = await import('./xhsMcpClient');

    const first = await XhsMcpClient.search(SERVER, 'k1');
    expect(first.success).toBe(false);

    const { seen } = setupFetch({ initDelayMs: 0 });
    const second = await XhsMcpClient.search(SERVER, 'k2');
    expect(second.success).toBe(true);
    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
  });
});
