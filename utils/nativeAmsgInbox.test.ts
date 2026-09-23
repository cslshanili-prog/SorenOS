import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveInboxMessage: vi.fn().mockResolvedValue(undefined),
  flushInboxToChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { saveInboxMessage: mocks.saveInboxMessage },
}));
vi.mock('./activeMsgRuntime', () => ({
  flushInboxToChat: mocks.flushInboxToChat,
}));

import { ingestNativeAmsgPayload, parseNativeAmsgPayload } from './nativeAmsgInbox';

describe('UnifiedPush payload 入庫橋', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.saveInboxMessage.mockClear();
    mocks.flushInboxToChat.mockClear();
  });

  it('接受對象或 JSON 字符串，拒絕無效內容', () => {
    expect(parseNativeAmsgPayload({ message: 'hi' })).toEqual({ message: 'hi' });
    expect(parseNativeAmsgPayload('{"message":"hi"}')).toEqual({ message: 'hi' });
    expect(parseNativeAmsgPayload('not-json')).toBeNull();
  });

  it('把標準 AMSG payload 交給現有 inbox 管線並按 messageId 去重', async () => {
    const payload = {
      messageId: 'msg-up-1',
      message: '該醒啦',
      contactName: '小明',
      timestamp: '2026-08-09T08:00:00.000Z',
      metadata: { charId: 'char-1', charName: '小明' },
    };

    await ingestNativeAmsgPayload(payload);
    await ingestNativeAmsgPayload(payload);

    expect(mocks.saveInboxMessage).toHaveBeenCalledTimes(1);
    expect(mocks.saveInboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-up-1',
      charId: 'char-1',
      body: '該醒啦',
      sentAt: Date.parse('2026-08-09T08:00:00.000Z'),
    }));
    expect(mocks.flushInboxToChat).toHaveBeenCalledTimes(1);
  });
});
