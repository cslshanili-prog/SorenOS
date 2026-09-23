import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
  companionExpressionKey,
  getCompanionDateSprites,
  listCompanionDateOutfits,
  resolveCompanionPortrait,
} from './companionAvatar';

const character = {
  id: 'char-1',
  name: 'Sully',
  avatar: 'avatar.png',
  sprites: { normal: 'base-normal.png', happy: 'base-happy.png', chibi: 'chibi.png' },
  dateSkinSets: [
    { id: 'coat', name: '風衣', sprites: { normal: 'coat-normal.png', shy: 'coat-shy.png' } },
  ],
  companionAvatar: { version: 1, source: 'date', skinSetId: 'coat' },
} as unknown as CharacterProfile;

describe('靜態陪伴形象', () => {
  it('把桌面演出情緒映射到見面模式的五類表情', () => {
    expect(companionExpressionKey('happy')).toBe('happy');
    expect(companionExpressionKey('surprised')).toBe('shy');
    expect(companionExpressionKey('calm', ['blush'])).toBe('shy');
    expect(companionExpressionKey('disgusted')).toBe('angry');
  });

  it('為桌面保留獨立衣服選擇並在缺圖時回退到 normal', () => {
    expect(getCompanionDateSprites(character)).toBe(character.dateSkinSets?.[0].sprites);
    expect(resolveCompanionPortrait(character, 'surprised')).toBe('coat-shy.png');
    expect(resolveCompanionPortrait(character, 'happy')).toBe('coat-normal.png');
  });

  it('列出默認立繪和有圖片的見面衣櫥，並忽略 chibi', () => {
    const outfits = listCompanionDateOutfits(character);
    expect(outfits.map(item => item.name)).toEqual(['默認立繪', '風衣']);
    expect(outfits[0].expressionCount).toBe(2);
    expect(outfits[0].preview).toBe('base-normal.png');
  });

  it('導入單圖始終使用原始 PNG/GIF 引用', () => {
    const uploaded = {
      ...character,
      companionAvatar: { version: 1, source: 'upload', imageRef: 'blobref:portrait' },
    } as unknown as CharacterProfile;
    expect(resolveCompanionPortrait(uploaded, 'angry')).toBe('blobref:portrait');
  });
});
