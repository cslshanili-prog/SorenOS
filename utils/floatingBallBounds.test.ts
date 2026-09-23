import { describe, it, expect } from 'vitest';
import { clampBubblePos, clampExpandedBottom, resolveInsets, resolveSafeTopInset } from './floatingBallBounds';

// 設備模型：豎屏 iPhone，父容器 390×800，頂部劉海 44、底部 home 條 34。
const parentW = 390;
const parentH = 800;
const insetTop = 44;
const insetBottom = 34;
const bubble = 40;
const pad = 8;

describe('clampBubblePos（摺疊小球）', () => {
  it('拖到底部時停在 home 條上方，不被手勢條擋住', () => {
    const { y } = clampBubblePos(0, 9999, { parentW, parentH, insetTop, insetBottom });
    // 舊邏輯（不減 insetBottom）會停在 752，球底正好壓進 home 條區域；現在應停在更上方
    expect(y).toBe(parentH - bubble - pad - insetBottom); // 718
  });

  it('拖到頂部時停在劉海下方，不鑽進劉海', () => {
    const { y } = clampBubblePos(0, -9999, { parentW, parentH, insetTop, insetBottom });
    expect(y).toBe(pad + insetTop); // 52，而非舊的 8
  });

  it('橫向仍只留 EDGE_PAD（豎屏無左右安全區）', () => {
    expect(clampBubblePos(-100, 100, { parentW, parentH, insetTop, insetBottom }).x).toBe(pad);
    expect(clampBubblePos(9999, 100, { parentW, parentH, insetTop, insetBottom }).x).toBe(parentW - bubble - pad);
  });

  it('無安全區設備退化為純物理邊界', () => {
    const { x, y } = clampBubblePos(9999, 9999, { parentW, parentH, insetTop: 0, insetBottom: 0 });
    expect(x).toBe(parentW - bubble - pad);
    expect(y).toBe(parentH - bubble - pad);
  });
});

describe('clampExpandedBottom（展開條）', () => {
  const selfH = 60;

  it('向下拖到底時離 home 條至少留出安全區 + 間距', () => {
    const b = clampExpandedBottom(0, { parentH, selfH, insetTop, insetBottom });
    expect(b).toBe(pad + insetBottom); // 42，而非舊的 8
  });

  it('向上拖到頂時條頂不鑽進劉海', () => {
    const b = clampExpandedBottom(9999, { parentH, selfH, insetTop, insetBottom });
    expect(b).toBe(parentH - selfH - pad - insetTop); // 688，而非舊的 732
  });
});

describe('resolveInsets（安全區合成）', () => {
  it('已遷移 App：外殼 paddingTop 為 0，仍用真機劉海兜底，球不進劉海', () => {
    // 迴歸守衛：若有人把頂部改成只讀 paddingTop，已遷移 App 會重新鑽進劉海，這條會掛
    expect(resolveInsets({ padTop: 0, padBottom: 0, safeTop: 44 }).insetTop).toBe(44);
  });

  it('未遷移 App：paddingTop 已是劉海高度，取它', () => {
    expect(resolveInsets({ padTop: 44, padBottom: 34, safeTop: 44 }).insetTop).toBe(44);
  });

  it('頂部取 padding 與真機劉海的較大值', () => {
    expect(resolveInsets({ padTop: 50, padBottom: 0, safeTop: 44 }).insetTop).toBe(50);
    expect(resolveInsets({ padTop: 20, padBottom: 0, safeTop: 44 }).insetTop).toBe(44);
  });

  it('底部只取 paddingBottom，不疊加真機 safe-bottom（避免已遷移 App 多讓）', () => {
    expect(resolveInsets({ padTop: 0, padBottom: 0, safeTop: 44 }).insetBottom).toBe(0);
    expect(resolveInsets({ padTop: 0, padBottom: 34, safeTop: 44 }).insetBottom).toBe(34);
  });
});

describe('resolveSafeTopInset（頂部安全區來源）', () => {
  it('iOS standalone 冷啟動：raw probe 為 0 時複用 CSS 變量兜底', () => {
    expect(resolveSafeTopInset({
      standaloneSafeTop: 44,
      probedSafeTop: 0,
      isIOSStandalone: true,
    })).toBe(44);
  });

  it('CSS 變量還沒初始化且 raw probe 仍為 0 時，iOS standalone 繼續兜 44px', () => {
    expect(resolveSafeTopInset({
      standaloneSafeTop: 0,
      probedSafeTop: 0,
      isIOSStandalone: true,
    })).toBe(44);
  });

  it('非 iOS standalone 沒有安全區讀數時保持 0', () => {
    expect(resolveSafeTopInset({
      standaloneSafeTop: 0,
      probedSafeTop: 0,
      isIOSStandalone: false,
    })).toBe(0);
  });
});
