// utils/amsgChatPresence.test.ts
import { describe, it, expect } from 'vitest';
import {
  AmsgChatPresence,
  CHAT_PRESENCE_TTL_MS,
  isFreshChatPresence,
  parseAmsgChatPresence,
} from './amsgChatPresence';

const presence = (over: Partial<AmsgChatPresence> = {}): AmsgChatPresence => ({
  v: 1,
  charId: 'char-1',
  activeAt: 1_000_000,
  lastUserMessageAt: 999_000,
  ...over,
});

describe('parseAmsgChatPresence', () => {
  it('合法 JSON → 還原對象', () => {
    const raw = JSON.stringify(presence());
    expect(parseAmsgChatPresence(raw)).toEqual(presence());
  });

  it('lastUserMessageAt 允許為 null', () => {
    const raw = JSON.stringify(presence({ lastUserMessageAt: null }));
    expect(parseAmsgChatPresence(raw)).toEqual(presence({ lastUserMessageAt: null }));
  });

  it('損壞 JSON → null', () => {
    expect(parseAmsgChatPresence('{ not json')).toBeNull();
  });

  it('undefined / 空串 → null', () => {
    expect(parseAmsgChatPresence(undefined)).toBeNull();
    expect(parseAmsgChatPresence('')).toBeNull();
  });

  it('版本號不對 / 字段類型不對 → null', () => {
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), v: 2 }))).toBeNull();
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), charId: 123 }))).toBeNull();
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), activeAt: 'x' }))).toBeNull();
    expect(parseAmsgChatPresence(JSON.stringify({ ...presence(), lastUserMessageAt: 'x' }))).toBeNull();
  });
});

describe('isFreshChatPresence', () => {
  const now = 2_000_000;

  it('同角色 + 未過期 → true', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - 1000 }), 'char-1', now)).toBe(true);
  });

  it('null / undefined → false', () => {
    expect(isFreshChatPresence(null, 'char-1', now)).toBe(false);
    expect(isFreshChatPresence(undefined, 'char-1', now)).toBe(false);
  });

  it('不同角色 → false', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - 1000 }), 'char-2', now)).toBe(false);
  });

  it('超過 TTL 過期 → false', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - CHAT_PRESENCE_TTL_MS - 1 }), 'char-1', now)).toBe(false);
  });

  it('剛好落在 TTL 邊界內 → true', () => {
    expect(isFreshChatPresence(presence({ activeAt: now - CHAT_PRESENCE_TTL_MS }), 'char-1', now)).toBe(true);
  });

  it('未來時鐘偏移過大（超過 10s 寬限）→ false', () => {
    expect(isFreshChatPresence(presence({ activeAt: now + 10_001 }), 'char-1', now)).toBe(false);
  });

  it('小幅未來偏移（10s 寬限內）→ true', () => {
    expect(isFreshChatPresence(presence({ activeAt: now + 5_000 }), 'char-1', now)).toBe(true);
  });
});
