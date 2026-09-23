// utils/agenticToolFeedback.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildDuplicateToolMessage,
  buildToolResultMessage,
  describeTool,
  toolCallFingerprint,
  type ToolCallRecord,
} from './agenticToolFeedback';

describe('toolCallFingerprint', () => {
  it('同名同參算同一次調用', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .toBe(toolCallFingerprint('recall', { year: '2026', month: '06' }));
  });

  // 模型兩輪之間重新拼參數時字段順序常常會變，不規範化的話同一個查詢會被當成兩次不同的，
  // 重複調用閘就形同虛設。
  it('參數字段順序不同仍算同一次', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .toBe(toolCallFingerprint('recall', { month: '06', year: '2026' }));
  });

  it('嵌套對象裡的順序也一樣處理', () => {
    expect(toolCallFingerprint('x', { a: { p: 1, q: 2 } }))
      .toBe(toolCallFingerprint('x', { a: { q: 2, p: 1 } }));
  });

  it('換參數就是另一次調用——多輪能力不能被閘誤傷', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .not.toBe(toolCallFingerprint('recall', { year: '2026', month: '07' }));
    expect(toolCallFingerprint('web_search', { query: 'a' }))
      .not.toBe(toolCallFingerprint('web_search', { query: 'b' }));
  });

  it('工具名不同就是不同調用', () => {
    expect(toolCallFingerprint('recall', {})).not.toBe(toolCallFingerprint('web_search', {}));
  });

  it('無參數 / undefined 不炸', () => {
    expect(toolCallFingerprint('xhs_browse', undefined)).toBe(toolCallFingerprint('xhs_browse', {}));
  });
});

describe('describeTool', () => {
  it('已知工具給人話', () => {
    expect(describeTool('recall')).toBe('調取某個月的記憶');
    expect(describeTool('web_search')).toBe('聯網搜索');
  });

  it('不認識的工具用原名，不編一個出來', () => {
    expect(describeTool('some_future_tool')).toBe('some_future_tool');
  });

  // 後台到點時角色能給自己排下一條消息。漏在標籤表外的話，回喂會拼出
  // 「你schedule_active_message，拿回了…」——內部工具名直接進了模型看得見的散文。
  it('排下一條消息的工具有人話說法，不把內部工具名漏進散文', () => {
    expect(describeTool('schedule_active_message')).toBe('給自己排下一條消息');
    expect(buildToolResultMessage({
      name: 'schedule_active_message',
      result: { ok: true },
      history: [{ name: 'schedule_active_message', fingerprint: 'a' }],
    })).not.toContain('schedule_active_message');
  });

  // 用戶自配的 MCP 工具不在標籤表裡。原名直接回填會拼出「你mcp__get_secret，拿回了…」——
  // 句子讀不通，路由用的前綴還漏進了模型能看見的散文（模型照著學就往正文裡寫假調用）。
  it('MCP 工具剝掉路由前綴，湊成讀得通的動賓短語', () => {
    expect(describeTool('mcp__get_secret')).toBe('調用「get_secret」');
  });
});

describe('buildToolResultMessage', () => {
  const history: ToolCallRecord[] = [
    { name: 'recall', fingerprint: toolCallFingerprint('recall', { year: '2026', month: '06' }) },
  ];

  it('把工具結果原樣帶上', () => {
    const msg = buildToolResultMessage({
      name: 'recall',
      result: { ok: true, logsText: '六月發生的事' },
      history,
    });
    expect(msg).toContain('六月發生的事');
  });

  it('MCP 工具的回喂句子讀得通，且不把 mcp__ 前綴漏給模型', () => {
    const msg = buildToolResultMessage({
      name: 'mcp__get_secret',
      result: { ok: true, data: '暗號' },
      history: [{ name: 'mcp__get_secret', fingerprint: toolCallFingerprint('mcp__get_secret', {}) }],
    });
    expect(msg).toContain('調用「get_secret」');
    expect(msg).not.toContain('mcp__');
  });

  // 這條是整個改動的意義所在：裸 JSON 裡沒有任何東西告訴模型「這一步做完了」，
  // 提示詞裡但凡有一句常駐的「先去查 X」，它就會每輪照做，直到跑滿上限。
  it('結尾必須寫明別重複調用', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: { ok: true }, history });
    expect(msg).toContain('不要再來一遍');
  });

  it('把已經用過的工具點名列出來', () => {
    const msg = buildToolResultMessage({
      name: 'web_search',
      result: { ok: true },
      history: [
        ...history,
        { name: 'web_search', fingerprint: toolCallFingerprint('web_search', { query: 'x' }) },
      ],
    });
    expect(msg).toContain('調取某個月的記憶');
    expect(msg).toContain('聯網搜索');
  });

  it('同一個工具用過多次只在清單裡列一次', () => {
    const msg = buildToolResultMessage({
      name: 'recall',
      result: { ok: true },
      history: [
        { name: 'recall', fingerprint: 'a' },
        { name: 'recall', fingerprint: 'b' },
      ],
    });
    expect(msg.match(/[调調]取某[个個]月的[记記][忆憶]/g)?.length).toBe(2); // 開頭一次 + 清單一次
  });

  it('給出「直接寫消息」這條出路，別把調工具當成回答', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: {}, history });
    expect(msg).toContain('直接把要發的消息寫出來');
  });

  // 「把要發的消息寫出來」很容易被讀成「從頭再寫一遍」：模型把已經說出去的幾句連同裡面的
  // 標記一起重抄，下游照著標記再執行一次（轉帳就真的發兩次）。所以得明說接著往下寫。
  it('提醒別重寫已經說出去的內容和標籤', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: { ok: true }, history });
    expect(msg).toContain('前面已經說出去的內容和標籤不要重寫');
  });

  // 搜索結果裡沒有任何時間信息，模型看不出這條是今早的還是三年前的，很容易把舊聞
  // 當成剛發生的事講給用戶聽。
  it('搜索結果帶一句「不一定是最新的」', () => {
    const msg = buildToolResultMessage({
      name: 'web_search',
      result: { ok: true, resultsText: '某某公司發佈了新品' },
      history: [{ name: 'web_search', fingerprint: 'a' }],
    });
    expect(msg).toContain('不一定是最新的');
  });

  it('這句只跟著搜索走，別的工具不加', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: { ok: true }, history });
    expect(msg).not.toContain('不一定是最新的');
  });

  // 迴歸守衛：小紅書 / MCP 服務器多半跑在用戶自己電腦上，後台到點時人睡了機器關了，
  // worker 怎麼也連不上。以前這種失敗跟「搜過了但沒結果」共用一個 reason，模型看見
  // ok:false 就挑個說法圓過去——「我剛在小紅書搜了下，沒啥好東西誒」。一次根本沒發生的
  // 搜索被說成發生過。現在這類失敗的回喂裡明寫「這件事沒有發生，別說你查過」。
  describe('這次調用沒跑起來時，得攔住角色說「我查過了」', () => {
    const neverRanCases: Array<[string, string]> = [
      ['xhs_search', 'unreachable'],
      ['xhs_browse', 'not_enabled'],
      ['notion_read_diary', 'not_configured'],
      ['web_search', 'no_api_key'],
      ['mcp__get_secret', 'mcp_error'],
      // empty_content 看著像「跑了但是空的」，實際只在「條目找到了、正文一篇都沒讀回來」
      // 時出現——真的空白日記會帶著「（空白日記）」正常返回。所以它也是一次讀取失敗。
      ['notion_read_diary', 'empty_content'],
      ['read_note', 'empty_content'],
    ];

    it.each(neverRanCases)('%s / %s → 明說這件事沒發生', (name, reason) => {
      const msg = buildToolResultMessage({
        name,
        result: { ok: false, reason },
        history: [{ name, fingerprint: toolCallFingerprint(name, {}) }],
      });
      expect(msg).toContain('沒能跑起來');
      expect(msg).toContain('這件事**沒有發生**');
      expect(msg).not.toContain('拿回了下面這些');
    });

    it('「跑了但沒東西」不加這句——角色說「我搜了下沒啥」是實話', () => {
      for (const reason of ['no_results', 'not_found', 'no_logs']) {
        const msg = buildToolResultMessage({
          name: 'xhs_search',
          result: { ok: false, reason },
          history: [{ name: 'xhs_search', fingerprint: 'a' }],
        });
        expect(msg, reason).toContain('拿回了下面這些');
        expect(msg, reason).not.toContain('沒有發生');
      }
    });

    it('成功的結果照舊', () => {
      const msg = buildToolResultMessage({ name: 'xhs_search', result: { ok: true, notes: [] }, history });
      expect(msg).toContain('拿回了下面這些');
      expect(msg).not.toContain('沒有發生');
    });
  });
});

describe('buildDuplicateToolMessage', () => {
  it('說清這次沒真去查，結果在上面', () => {
    const msg = buildDuplicateToolMessage('recall');
    expect(msg).toContain('調取某個月的記憶');
    expect(msg).toContain('沒有再執行');
  });

  // 同上：被打回之後讓它「把要發的消息寫出來」，模型很容易連前面說過的話帶標記一起重寫，
  // 下游就會照著標記再執行一次。
  it('提醒別重寫已經說出去的內容和標籤', () => {
    expect(buildDuplicateToolMessage('recall')).toContain('前面已經說出去的內容和標籤不要重寫');
  });
});
