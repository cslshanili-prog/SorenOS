import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import type { Emoji, EmojiCategory } from '../types';

// 鎖住「角色只能用自己範圍內的表情包」的修復。
//
// 表情包分類可以設 allowedCharacterIds 限定可見角色。私聊路徑 (Chat.tsx) 在餵給
// LLM 前會按角色過濾；但主動消息 (activeMsgClient.buildCompletePrompt) 之前漏了這步，
// 直接把全部表情塞進 system prompt，導致 B 在主動消息裡用到只規定給 A 的表情包。
// 修復把過濾收口到 ChatPrompts.filterVisibleEmojis，兩條路徑共用。這裡釘住 helper 行為。

const categories: EmojiCategory[] = [
  { id: 'public', name: '通用' }, // 無 allowedCharacterIds = 所有人可見
  { id: 'onlyA', name: '只給A', allowedCharacterIds: ['A'] },
  { id: 'emptyList', name: '空名單', allowedCharacterIds: [] }, // 空名單 = 所有人可見
];

const emojis: Emoji[] = [
  { name: '通用表情', url: 'u1', categoryId: 'public' },
  { name: 'A專屬', url: 'u2', categoryId: 'onlyA' },
  { name: '無分類', url: 'u3' }, // 無 categoryId 始終可見
  { name: '空名單表情', url: 'u4', categoryId: 'emptyList' },
];

describe('ChatPrompts.filterVisibleEmojis', () => {
  it('保留範圍內角色的受限表情', () => {
    const res = ChatPrompts.filterVisibleEmojis(emojis, categories, 'A');
    expect(res.emojis.map(e => e.name).sort()).toEqual(
      ['A專屬', '無分類', '空名單表情', '通用表情'].sort(),
    );
    expect(res.categories.map(c => c.id).sort()).toEqual(
      ['emptyList', 'onlyA', 'public'].sort(),
    );
  });

  it('對範圍外角色隱藏受限分類下的表情', () => {
    const res = ChatPrompts.filterVisibleEmojis(emojis, categories, 'B');
    expect(res.emojis.map(e => e.name)).not.toContain('A專屬');
    // 通用 / 空名單 / 無分類 仍然可見
    expect(res.emojis.map(e => e.name).sort()).toEqual(
      ['無分類', '空名單表情', '通用表情'].sort(),
    );
    expect(res.categories.map(c => c.id)).not.toContain('onlyA');
  });

  it('沒有任何受限分類時原樣返回（短路）', () => {
    const openCats: EmojiCategory[] = [{ id: 'public', name: '通用' }];
    const res = ChatPrompts.filterVisibleEmojis(emojis, openCats, 'B');
    expect(res.emojis).toBe(emojis);
  });

  it('同名表情只保留當前角色綁定的版本，避免按名字反查到其他角色的 URL', () => {
    const scopedCategories: EmojiCategory[] = [
      { id: 'onlyA', name: 'A 專屬', allowedCharacterIds: ['A'] },
      { id: 'onlyB', name: 'B 專屬', allowedCharacterIds: ['B'] },
    ];
    const duplicateNames: Emoji[] = [
      { name: '揮手', url: 'a-only-url', categoryId: 'onlyA' },
      { name: '揮手', url: 'b-only-url', categoryId: 'onlyB' },
    ];

    const res = ChatPrompts.filterVisibleEmojis(duplicateNames, scopedCategories, 'B');

    expect(res.emojis).toEqual([
      { name: '揮手', url: 'b-only-url', categoryId: 'onlyB' },
    ]);
    expect(res.emojis.find(e => e.name === '揮手')?.url).toBe('b-only-url');
  });
});
