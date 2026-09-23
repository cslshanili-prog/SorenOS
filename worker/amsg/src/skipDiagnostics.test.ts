import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureSkipDiagnostics,
  describeLlmResponseShape,
  excerptLlmResponse,
  isDebugFlagOn,
  logSkipDiagnostic,
} from './skipDiagnostics';

const FAKE_KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';

// last_skip 裡只有一個 empty-generation，分辨是哪一種「沒說話」全靠這份形狀。
// 哪個字段退化成恆定值，排障就又回到瞎猜。
describe('describeLlmResponseShape：幾種「沒說話」各有各的樣子', () => {
  it('中轉站把報錯包在 200 裡 → 沒有 choices，報錯原話進 bodyError 且脫敏', () => {
    const shape = describeLlmResponseShape({
      error: { message: `Invalid token: ${FAKE_KEY}`, code: 'invalid_api_key' },
    }, '');
    expect(shape.hasChoices).toBe(false);
    expect(shape.contentType).toBe('missing');
    expect(shape.bodyError).toContain('[invalid_api_key] Invalid token');
    expect(shape.bodyError).not.toContain(FAKE_KEY);
  });

  it('頂層 message 只在沒有 choices 時才當報錯', () => {
    expect(describeLlmResponseShape({ message: '餘額不足' }, '').bodyError).toBe('餘額不足');
    expect(describeLlmResponseShape({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
      message: 'ok',
    }, '').bodyError).toBeNull();
  });

  it('只回了工具調用 / 被審核攔下 → content 為 null，finish_reason 和工具數照實記', () => {
    const shape = describeLlmResponseShape({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
        },
      }],
    }, '');
    expect(shape).toMatchObject({
      hasChoices: true, contentType: 'null', contentChars: 0, toolCalls: 1, finishReason: 'tool_calls',
    });
  });

  it('content 是數組 → 記下段數和字數（上游只認 string，這種會被當成空）', () => {
    const shape = describeLlmResponseShape({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: [{ type: 'text', text: '在的' }, { type: 'text', text: '呀' }] },
      }],
    }, '');
    expect(shape).toMatchObject({ contentType: 'array', contentParts: 2, contentChars: 3, visibleChars: 0 });
  });

  it('思考把 token 燒光 → finish_reason length、思考字數和 reasoning_tokens 都在', () => {
    const shape = describeLlmResponseShape({
      model: 'deepseek-reasoner',
      choices: [{
        finish_reason: 'length',
        message: { role: 'assistant', content: '', reasoning_content: '想'.repeat(50) },
      }],
      usage: { prompt_tokens: 1000, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } },
    }, '');
    expect(shape).toMatchObject({
      model: 'deepseek-reasoner',
      finishReason: 'length',
      contentType: 'string',
      contentChars: 0,
      reasoningChars: 50,
      usage: { promptTokens: 1000, completionTokens: 4096, reasoningTokens: 4096 },
    });
  });

  it('正文全在 <think> 裡 → contentChars 有數、visibleChars 為 0', () => {
    const text = '<think>要不要回呢……算了</think>';
    const shape = describeLlmResponseShape({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    }, text);
    expect(shape.contentChars).toBe(text.length);
    expect(shape.visibleChars).toBe(0);
  });

  it('響應根本不是對象也不拋', () => {
    expect(describeLlmResponseShape(undefined, '')).toMatchObject({
      hasChoices: false, contentType: 'missing', usage: null, bodyError: null,
    });
    expect(describeLlmResponseShape('oops', '').hasChoices).toBe(false);
  });
});

describe('excerptLlmResponse', () => {
  it('有 choices 時取正文開頭、思考鏈末尾、工具調用，全部脫敏', () => {
    const excerpt = excerptLlmResponse({
      choices: [{
        message: {
          content: `key 是 ${FAKE_KEY} ${'字'.repeat(400)}`,
          reasoning_content: `${'前'.repeat(300)}結尾在這`,
          tool_calls: [{ function: { name: 'x' } }],
        },
      }],
    });
    expect(excerpt.content!.startsWith('key 是')).toBe(true);
    expect(excerpt.content).not.toContain(FAKE_KEY);
    expect(excerpt.content!.length).toBeLessThanOrEqual(301);
    expect(excerpt.reasoningTail!.endsWith('結尾在這')).toBe(true);
    expect(excerpt.toolCalls).toContain('"name":"x"');
    expect(excerpt.body).toBeUndefined();
  });

  it('沒有 choices 時給整個 body 的開頭', () => {
    expect(excerptLlmResponse({ error: { message: '模型不存在' } }).body).toContain('模型不存在');
  });
});

describe('logSkipDiagnostic', () => {
  afterEach(() => {
    configureSkipDiagnostics({ rawExcerpt: false });
    vi.restoreAllMocks();
  });

  const input = {
    sessionId: 'sess_1',
    reason: 'empty-generation',
    iteration: 0,
    llmResponse: { choices: [{ finish_reason: 'stop', message: { content: '<think>悄悄話</think>' } }] },
    llmOutputText: '<think>悄悄話</think>',
  };

  // 迴歸守衛：聊天正文默認不能進日誌，只有用戶自己打開開關才帶。
  it('默認只記形狀，日誌裡沒有一個字的正文', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSkipDiagnostic(input);
    const [tag, payload] = warn.mock.calls[0];
    expect(tag).toBe('[amsg:skip-diag]');
    expect(payload).toMatchObject({
      sessionId: 'sess_1', reason: 'empty-generation', contentType: 'string', visibleChars: 0,
    });
    expect(payload).not.toHaveProperty('raw');
    expect(JSON.stringify(payload)).not.toContain('悄悄話');
  });

  it('打開原文開關後帶上片段', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureSkipDiagnostics({ rawExcerpt: true });
    logSkipDiagnostic(input);
    expect(warn.mock.calls[0][1].raw.content).toContain('悄悄話');
  });
});

describe('isDebugFlagOn', () => {
  it('只認 1 / true（不分大小寫、容忍空白），其餘一律關', () => {
    for (const on of ['1', 'true', ' TRUE ']) expect(isDebugFlagOn(on)).toBe(true);
    for (const off of [undefined, '', '0', 'false', 'yes', 1]) expect(isDebugFlagOn(off)).toBe(false);
  });
});
