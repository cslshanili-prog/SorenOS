// worker/amsg/src/emotionEval.test.ts
//
// 佔位符還原：前端把評估提示詞裡兩段大文本（角色的 system prompt、完整對話歷史）
// 留成佔位符發上來，worker 用本次請求已有的消息填回原位。填錯一個字，評估看到的
// 就不是角色真正看到的那份上下文，判出來的情緒對不上它剛說的話——而這種偏差在
// 界面上完全看不出來，只會表現為「情緒越來越不準」。
import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  resolveEmotionEvalApi,
  restoreEvalPrompt,
  runAmsgEmotionEval,
  takeEmotionEvalSpec,
} from './emotionEval';

const TEMPLATE = [
  '## 角色此刻看到的完整上下文',
  '__EMOTION_EVAL_SYSTEM_PROMPT__',
  '## 完整對話歷史',
  '__EMOTION_EVAL_HISTORY__',
].join('\n');

describe('restoreEvalPrompt', () => {
  it('system prompt 進第一個槽，其餘消息按 [角色]: 正文 拼進第二個槽', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在嗎' },
      { role: 'assistant', content: '在的。' },
    ], 'Nyah');

    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
    expect(out).toContain('你是 Nyah。');
    expect(out).toContain('[用戶]: 在嗎');
    expect(out).toContain('[Nyah]: 在的。');
  });

  // String.replace 的第二個參數裡，`$&`（整個匹配）、`$1`、`$'` 都是替換模式。
  // 用戶設定裡出現這些字符完全正常（寫代碼、寫價格、寫顏文字），naive 的
  // `.replace(槽位, 文本)` 會把它們當指令展開——system prompt 裡憑空多出一串
  // 「__EMOTION_EVAL_SYSTEM_PROMPT__」，用戶的原話反而丟了。函數式 replacer 才不會。
  it('設定裡帶 $& / $1 這類字符時逐字還原，不被當成替換模式展開', () => {
    const nastySystem = '規則：價格寫成 $1，強調用 $& 包起來，別寫 $`。';
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: nastySystem },
      { role: 'user', content: '懂了 $&' },
    ], 'Nyah');

    expect(out).toContain(nastySystem);
    expect(out).toContain('[用戶]: 懂了 $&');
    // naive 實現下 $& 會被展開成佔位符本身，這兩條就是那種走樣的樣子
    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
  });

  it('帶圖片的結構化消息拍平成「文字 [圖片]」（跟本地那份逐字同款）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看這個' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ], 'Nyah');

    expect(out).toContain('[用戶]: 看這個 [圖片]');
    // 圖片的 base64 一個字節都不該進評估請求（白燒 token，還可能撐爆請求體）
    expect(out).not.toContain('base64');
  });

  // 即時對話的時效塊（現在幾點、外面在下雨）是追加在末尾的 system 消息。
  // 它必須進歷史，評估才知道角色剛才是對著什麼時間說的那句話。
  it('末尾追加的 system 塊進歷史，標成 [系統]', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在嗎' },
      { role: 'system', content: '【此刻的系統信息·僅你可見】\n現在是 2026年8月1日 早晨 08:00。' },
    ], 'Nyah');

    expect(out).toContain('[系統]: 【此刻的系統信息·僅你可見】');
    expect(out).toContain('現在是 2026年8月1日 早晨 08:00。');
  });

  it('第一條不是 system 時全都算歷史（不硬吃掉一條當設定）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'user', content: '在嗎' },
    ], 'Nyah');

    expect(out).toContain('[用戶]: 在嗎');
    // 設定槽位填空串：沒有就是沒有，不能拿第一條用戶消息頂上去
    expect(out).toContain('## 角色此刻看到的完整上下文\n\n## 完整對話歷史');
  });
});

// 失敗原因這句話最終要走 push 出門（評估失敗信號帶給客戶端），裡頭絕不能有 apiKey。
// 個別中轉會把整個請求（含 Authorization 頭）回顯在錯誤頁裡，所以打碼必須先於截斷：
// 先截的話，切口正好落在 key 中間時整串裡查不到完整 key，半截憑據就原樣帶出去了。
describe('評估失敗原因的脫敏', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('錯誤正文裡的 apiKey 被截斷切中也不許漏出半截（先打碼後截斷）', async () => {
    const apiKey = 'sk-secondary-0123456789abcdef0123456789abcdef';
    // 110 個填充字符 + key：120 字符的切口正好穿過 key 的前半截。
    const body = 'x'.repeat(110) + apiKey + ' tail';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => body,
    })));

    const outcome = await runAmsgEmotionEval(
      { prompt: TEMPLATE },
      { baseUrl: 'https://eval.example.com/v1', apiKey, model: 'eval-mini' },
      [{ role: 'user', content: '在嗎' }],
      'Nyah',
    );

    expect(outcome.raw).toBeNull();
    expect(outcome.error).toContain('副 API HTTP 401');
    expect(outcome.error).toContain('***');
    expect(outcome.error, 'key 的前綴一個字節都不許出門').not.toContain(apiKey.slice(0, 10));
  });
});

// 評估配置的兩種長相：存量任務把副 API 憑據整份塞在 metadata 裡；新任務只帶提示詞模板，
// 憑據在 llm_credentials 表裡、任務只帶 credRefs.emotion 這個名字。兩種都得認。
describe('副 API 憑據的來路（內聯 / 憑據表）', () => {
  const SPEC_INLINE = {
    prompt: 'T',
    api: { baseUrl: 'https://inline.example.dev/v1', apiKey: 'sk-inline', model: 'inline-mini' },
  };

  it('存量任務裡內聯的那份優先（不去勞動憑據表）', async () => {
    const resolve = vi.fn();
    await expect(resolveEmotionEvalApi(SPEC_INLINE, { emotion: 'char:c1/emotion' }, resolve))
      .resolves.toEqual(SPEC_INLINE.api);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('只帶引用 → 按名字現讀，apiUrl 摘回 baseUrl 口徑（評估請求自己會補 /chat/completions）', async () => {
    const resolve = vi.fn(async () => ({
      apiUrl: 'https://tabled.example.dev/v1/chat/completions',
      apiKey: 'sk-tabled',
      primaryModel: 'tabled-mini',
    }));

    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, resolve))
      .resolves.toEqual({
        baseUrl: 'https://tabled.example.dev/v1', apiKey: 'sk-tabled', model: 'tabled-mini',
      });
    expect(resolve).toHaveBeenCalledWith('char:c1/emotion');
  });

  it('雲端那行沒了 / 老部署根本沒有這個方法 → null，這一輪不評估（主回覆照發）', async () => {
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, async () => null))
      .resolves.toBeNull();
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, undefined))
      .resolves.toBeNull();
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, null, async () => null)).resolves.toBeNull();
  });

  it('讀憑據拋錯也只是不評估，絕不把這一輪的正文連累掉', async () => {
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, async () => {
      throw new Error('D1 掛了');
    })).resolves.toBeNull();
  });
});

// 兩道防線一道都不能少：任務 metadata 走的是加密信封，放憑據安全；推送出了這台 worker
// 就歸推送服務管了，所以捕獲點就地刪、組 push 前再刪一次。
describe('takeEmotionEvalSpec 認新舊兩種形狀', () => {
  it('只帶提示詞模板（新任務）→ 認，並就地把鍵刪掉', () => {
    const metadata: Record<string, unknown> = { charId: 'c1', amsgEmotionEval: { prompt: 'T' } };
    expect(takeEmotionEvalSpec(metadata)).toEqual({ prompt: 'T' });
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('帶整份內聯憑據（存量任務）→ 照舊認，鍵同樣就地刪掉', () => {
    const spec = { prompt: 'T', api: { baseUrl: 'https://x.dev', apiKey: 'sk-x', model: 'm' } };
    const metadata: Record<string, unknown> = { amsgEmotionEval: spec };
    expect(takeEmotionEvalSpec(metadata)).toEqual(spec);
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('帶了 api 卻配不齊 → 判不可用，鍵照刪（那份裡同樣有 apiKey）', () => {
    const metadata: Record<string, unknown> = {
      amsgEmotionEval: { prompt: 'T', api: { baseUrl: '', apiKey: 'sk-x', model: '' } },
    };
    expect(takeEmotionEvalSpec(metadata)).toBeNull();
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('沒有提示詞模板 → 不可用（評估無從談起）', () => {
    expect(takeEmotionEvalSpec({ amsgEmotionEval: { prompt: '' } })).toBeNull();
  });
});
