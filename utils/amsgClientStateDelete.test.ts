// utils/amsgClientStateDelete.test.ts
//
// 雲端 client_state 刪行那份不聯網的判斷：特性位、旁路空殼的挑法、切批。
import { describe, expect, it } from 'vitest';

import {
  AMSG_SIDECHANNEL_KEY_PREFIXES,
  CLIENT_STATE_PUT_BATCH_MAX,
  chunkClientStateEntries,
  isSidechannelKey,
  pickSidechannelShellKeys,
  supportsClientStateDelete,
} from './amsgClientStateDelete';

describe('supportsClientStateDelete', () => {
  it('features 裡有 client-state-delete 才算', () => {
    expect(supportsClientStateDelete(['client-state', 'client-state-delete'])).toBe(true);
    expect(supportsClientStateDelete(['client-state', 'llm-credentials'])).toBe(false);
  });

  it('探不到（null / undefined / 不是數組）一律 false', () => {
    expect(supportsClientStateDelete(null)).toBe(false);
    expect(supportsClientStateDelete(undefined)).toBe(false);
    expect(supportsClientStateDelete('client-state-delete' as any)).toBe(false);
  });
});

describe('pickSidechannelShellKeys', () => {
  it('三個旁路前綴 + 值為空串 → 是空殼', () => {
    const entries = AMSG_SIDECHANNEL_KEY_PREFIXES.map((prefix) => ({ key: `${prefix}uuid`, value: '' }));
    expect(pickSidechannelShellKeys(entries)).toEqual(['reasoning:uuid', 'emotion_update:uuid', 'xhs_session:uuid']);
  });

  it('旁路鍵還有內容 → 不是空殼（客戶端還沒取走）', () => {
    expect(pickSidechannelShellKeys([
      { key: 'reasoning:a', value: 'gz1:...' },
      { key: 'xhs_session:b', value: '{"notes":[]}' },
    ])).toEqual([]);
  });

  it('長期狀態就算是空的也不碰', () => {
    expect(pickSidechannelShellKeys([
      { key: 'fire_pack', value: '' },
      { key: 'tool_pack', value: '' },
      { key: 'self_log', value: '' },
      { key: 'chat_presence', value: '' },
      { key: 'last_skip', value: '' },
    ])).toEqual([]);
  });

  it('前綴只認開頭，不認包含', () => {
    expect(isSidechannelKey('my_reasoning:a')).toBe(false);
    expect(pickSidechannelShellKeys([{ key: 'my_reasoning:a', value: '' }])).toEqual([]);
  });

  it('條目缺 key / 值不是字符串 / 沒有條目 → 都不算', () => {
    expect(pickSidechannelShellKeys([{ value: '' }, { key: 'reasoning:a', value: null }, { key: 'reasoning:b' }])).toEqual([]);
    expect(pickSidechannelShellKeys(null)).toEqual([]);
    expect(pickSidechannelShellKeys(undefined)).toEqual([]);
  });
});

describe('chunkClientStateEntries', () => {
  it('按上游單批上限切，最後一批裝餘數', () => {
    const items = Array.from({ length: CLIENT_STATE_PUT_BATCH_MAX * 2 + 1 }, (_, i) => i);
    const batches = chunkClientStateEntries(items);
    expect(batches.map((b) => b.length)).toEqual([CLIENT_STATE_PUT_BATCH_MAX, CLIENT_STATE_PUT_BATCH_MAX, 1]);
    expect(batches.flat()).toEqual(items);
  });

  it('不超上限 → 就一批；空數組 → 零批', () => {
    expect(chunkClientStateEntries([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(chunkClientStateEntries([])).toEqual([]);
  });
});
