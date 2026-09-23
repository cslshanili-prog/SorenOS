// utils/amsgLlmCredentials.test.ts
//
// 迴歸守衛（憑據行本身）：
//   1. 起名。三種用途各一行，名字進了任務就不再改——名字錯一次，雲端那行永遠沒人認領，
//      任務到點只會報「憑據不存在」。
//   2. 取值。角色開了「單獨 API」時定時消息那行必須寫單獨 API 的值；情緒評估沒單獨配
//      時回落到全局聊天 API。算錯等於用戶以為在用 A 模型、實際雲端在用 B。
//   3. 指紋門控。值沒變就不該重傳（每次排程 / 每條消息都白發一次 PUT），變了必須重傳
//      （不然換完 Key 雲端還是舊的，已排任務到點全 401）。
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildCharChatCredRow,
  buildCharEmotionCredRow,
  buildCharInstantCredRow,
  charCredId,
  charCredIds,
  chunkCredRows,
  forgetAllCredIds,
  forgetCredIds,
  knownCredIds,
  normalizeChatApiUrl,
  parseCharCredId,
  pickChangedCredRows,
  rememberCredRows,
  supportsLlmCredentials,
  toCredentialValue,
} from './amsgLlmCredentials';

const CHAR = { id: 'char-1' } as any;
const API = { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'gpt-global' };
const SECONDARY = { baseUrl: 'https://alt.example.dev/v1', apiKey: 'sk-alt', model: 'gpt-alt' };

beforeEach(() => {
  forgetAllCredIds();
});

describe('能力位', () => {
  it('features 裡有 llm-credentials 才算達標', () => {
    expect(supportsLlmCredentials(['client-state', 'llm-credentials'])).toBe(true);
    expect(supportsLlmCredentials(['client-state'])).toBe(false);
  });

  it('探不到（null / undefined）一律不達標——不知道 ≠ 可以用新寫法', () => {
    expect(supportsLlmCredentials(null)).toBe(false);
    expect(supportsLlmCredentials(undefined)).toBe(false);
  });
});

describe('credId 起名', () => {
  it('每種用途各一個名字，拆得回去', () => {
    expect(charCredId('c1', 'chat')).toBe('char:c1/chat');
    expect(charCredId('c1', 'instant')).toBe('char:c1/instant');
    expect(charCredId('c1', 'emotion')).toBe('char:c1/emotion');
    expect(charCredId('c1', 'memory')).toBe('char:c1/memory');
    expect(charCredIds('c1')).toEqual([
      'char:c1/chat', 'char:c1/instant', 'char:c1/emotion', 'char:c1/memory',
    ]);
    expect(parseCharCredId('char:c1/emotion')).toEqual({ charId: 'c1', purpose: 'emotion' });
    expect(parseCharCredId('char:c1/memory')).toEqual({ charId: 'c1', purpose: 'memory' });
  });

  // 迴歸守衛：刪角色時按 charCredIds 清雲端憑據行。用途表漏了一檔，那一行就永遠留在
  // 雲端 —— 角色刪了，他那份副 API 的 Key 還在別人的 D1 裡躺著。
  it('新增用途必須同時進 ALL_CREDENTIAL_PURPOSES 和 parseCharCredId', () => {
    for (const credId of charCredIds('c1')) {
      expect(parseCharCredId(credId)).not.toBeNull();
    }
  });

  it('不認識的形狀拆出來是 null（別把別人的鍵當成角色憑據去重算）', () => {
    expect(parseCharCredId('global/chat')).toBeNull();
    expect(parseCharCredId('char:c1/whatever')).toBeNull();
    expect(parseCharCredId('')).toBeNull();
  });

  it('名字在上游的長度上限（128）之內', () => {
    // 角色 id 是 uuid，最長的那個名字也就四十來個字符。
    expect(charCredId('7f2b1c8a-9d4e-4a1b-8c2d-000000000001', 'instant').length).toBeLessThanOrEqual(128);
  });
});

describe('憑據行取值', () => {
  it('地址歸一成 /chat/completions（任務行裡存的是終點地址）', () => {
    expect(normalizeChatApiUrl('https://api.example.dev/v1/')).toBe('https://api.example.dev/v1/chat/completions');
    expect(toCredentialValue(API)).toEqual({
      apiUrl: 'https://api.example.dev/v1/chat/completions',
      apiKey: 'sk-global',
      primaryModel: 'gpt-global',
    });
  });

  it('缺地址 / 缺模型 → null（一份配不齊的憑據不該被寫到雲端）', () => {
    expect(toCredentialValue({ baseUrl: '', apiKey: 'k', model: 'm' })).toBeNull();
    expect(toCredentialValue({ baseUrl: 'https://x.dev', apiKey: 'k', model: '' })).toBeNull();
  });

  it('定時消息那行：沒開單獨 API → 全局聊天 API', () => {
    const row = buildCharChatCredRow(CHAR, { enabled: true } as any, API);
    expect(row).toEqual({
      credId: 'char:char-1/chat',
      value: { apiUrl: 'https://api.example.dev/v1/chat/completions', apiKey: 'sk-global', primaryModel: 'gpt-global' },
    });
  });

  it('定時消息那行：開了單獨 API → 寫單獨 API 的值（絕不能被全局蓋掉）', () => {
    const row = buildCharChatCredRow(
      CHAR, { enabled: true, useSecondaryApi: true, secondaryApi: SECONDARY } as any, API,
    );
    expect(row?.value).toEqual({
      apiUrl: 'https://alt.example.dev/v1/chat/completions', apiKey: 'sk-alt', primaryModel: 'gpt-alt',
    });
  });

  it('定時消息那行：開關開著但單獨 API 沒填地址 → 回落全局（口徑同排程時的 resolveApiConfig）', () => {
    const row = buildCharChatCredRow(
      CHAR, { enabled: true, useSecondaryApi: true, secondaryApi: { baseUrl: '', apiKey: '', model: '' } } as any, API,
    );
    expect(row?.value.primaryModel).toBe('gpt-global');
  });

  it('即時對話那行：原樣收下當輪終值（claude 系開思考時的 -thinking 後綴不能被抹掉）', () => {
    const row = buildCharInstantCredRow('char-1', {
      baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'claude-sonnet-4-thinking',
    });
    expect(row).toEqual({
      credId: 'char:char-1/instant',
      value: {
        apiUrl: 'https://api.example.dev/v1/chat/completions',
        apiKey: 'sk-global',
        primaryModel: 'claude-sonnet-4-thinking',
      },
    });
  });

  it('情緒評估那行：配了副 API 用副 API，沒配回落全局聊天 API', () => {
    expect(buildCharEmotionCredRow('char-1', SECONDARY, API)?.value.primaryModel).toBe('gpt-alt');
    expect(buildCharEmotionCredRow('char-1', undefined, API)?.value.primaryModel).toBe('gpt-global');
    expect(buildCharEmotionCredRow('char-1', { baseUrl: '', apiKey: '', model: '' }, API)?.value.primaryModel)
      .toBe('gpt-global');
  });
});

describe('指紋門控', () => {
  const row = () => buildCharChatCredRow(CHAR, { enabled: true } as any, API)!;

  it('沒傳過 → 要傳；傳過且值沒變 → 不再傳', () => {
    expect(pickChangedCredRows([row()])).toHaveLength(1);
    rememberCredRows([row()]);
    expect(pickChangedCredRows([row()])).toHaveLength(0);
  });

  it('換了 Key → 重新算成「要傳」（不然雲端永遠是舊 Key，已排任務到點 401）', () => {
    rememberCredRows([row()]);
    const rotated = buildCharChatCredRow(CHAR, { enabled: true } as any, { ...API, apiKey: 'sk-new' })!;
    expect(pickChangedCredRows([rotated])).toHaveLength(1);
  });

  it('換了模型也算變（同一把 Key 不同模型是兩份不同的憑據）', () => {
    rememberCredRows([row()]);
    const remodeled = buildCharChatCredRow(CHAR, { enabled: true } as any, { ...API, model: 'gpt-new' })!;
    expect(pickChangedCredRows([remodeled])).toHaveLength(1);
  });

  it('劃掉某一行之後必須重傳（雲端刪了 / 上一次其實沒落地時的自愈前提）', () => {
    rememberCredRows([row()]);
    forgetCredIds([row().credId]);
    expect(pickChangedCredRows([row()])).toHaveLength(1);
  });

  it('底帳裡記著傳過哪些行（後台補傳按它決定重算哪幾行）', () => {
    rememberCredRows([row(), buildCharEmotionCredRow('char-1', undefined, API)!]);
    expect(knownCredIds().sort()).toEqual(['char:char-1/chat', 'char:char-1/emotion']);
    forgetAllCredIds();
    expect(knownCredIds()).toEqual([]);
  });

  it('憑據本體一個字節都不進 localStorage（底帳只記指紋）', () => {
    rememberCredRows([row()]);
    expect(JSON.stringify(localStorage.getItem('amsg2_llm_cred_fingerprints'))).not.toContain('sk-global');
  });
});

describe('批量切片', () => {
  it('按上游單批上限切開（一次 PUT 最多 100 條）', () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({
      credId: `char:c${i}/chat`,
      value: { apiUrl: 'u', apiKey: 'k', primaryModel: 'm' },
    }));
    expect(chunkCredRows(rows).map((batch) => batch.length)).toEqual([100, 100, 5]);
  });
});
