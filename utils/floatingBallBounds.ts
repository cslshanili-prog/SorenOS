/**
 * 全局懸浮球（GlobalMiniPlayer）的拖拽邊界計算。
 *
 * 抽成純函數是為了能脫離 DOM 單測：把「球不能拖進 safe area（劉海 / home 條）」這條
 * 行為釘住，防止以後又退回成只按物理容器尺寸 clamp。
 *
 * 座標系：父容器（PhoneShell 的外殼 div）的 padding box，原點在左上。
 *  - insetTop    頂部要讓出的高度（劉海 / 狀態欄），= max(父容器 paddingTop, env safe-top)
 *  - insetBottom 底部要讓出的高度（home 手勢條），= 父容器 paddingBottom
 *    （未遷移 App 外殼用 paddingBottom 讓位安全區；已遷移 App 外殼已把底邊收回安全區內，paddingBottom 為 0）
 */

export const DEFAULT_BUBBLE_SIZE = 40;
export const DEFAULT_EDGE_PAD = 8;
export const IOS_STANDALONE_TOP_FALLBACK = 44;

const clampRange = (value: number, lo: number, hi: number): number =>
  Math.min(Math.max(value, lo), Math.max(lo, hi));

export interface BubbleBoundsInput {
  parentW: number;
  parentH: number;
  insetTop: number;
  insetBottom: number;
  bubble?: number;
  pad?: number;
}

/** 摺疊小球（left/top 定位）：橫向只留 EDGE_PAD，縱向額外讓出 safe area。 */
export const clampBubblePos = (
  x: number,
  y: number,
  { parentW, parentH, insetTop, insetBottom, bubble = DEFAULT_BUBBLE_SIZE, pad = DEFAULT_EDGE_PAD }: BubbleBoundsInput,
): { x: number; y: number } => ({
  x: clampRange(x, pad, parentW - bubble - pad),
  y: clampRange(y, pad + insetTop, parentH - bubble - pad - insetBottom),
});

export interface ExpandedBoundsInput {
  parentH: number;
  selfH: number;
  insetTop: number;
  insetBottom: number;
  pad?: number;
}

/** 展開條（bottom 定位）：bottom 是距父容器底邊的距離，越大越靠上。 */
export const clampExpandedBottom = (
  bottom: number,
  { parentH, selfH, insetTop, insetBottom, pad = DEFAULT_EDGE_PAD }: ExpandedBoundsInput,
): number =>
  clampRange(bottom, pad + insetBottom, parentH - selfH - pad - insetTop);

export interface RawInsets {
  padTop: number;
  padBottom: number;
  safeTop: number;
}

export interface SafeTopInsetInput {
  standaloneSafeTop: number;
  probedSafeTop: number;
  isIOSStandalone: boolean;
  fallback?: number;
}

/**
 * 頂部安全區的來源優先級：
 * 1. :root 上的 --standalone-safe-area-top（iosStandalone.ts 已帶 iOS 冷啟動 44px 兜底）
 * 2. 當前 env/probe 讀數
 * 3. iOS standalone 下最後再兜 44px，防止變量還沒初始化時先拖進劉海
 */
export const resolveSafeTopInset = ({
  standaloneSafeTop,
  probedSafeTop,
  isIOSStandalone,
  fallback = IOS_STANDALONE_TOP_FALLBACK,
}: SafeTopInsetInput): number => {
  if (standaloneSafeTop > 0) return standaloneSafeTop;
  if (probedSafeTop > 0) return probedSafeTop;
  return isIOSStandalone ? fallback : 0;
};

/**
 * 把外殼 padding 與真機劉海合成球要讓出的安全區高度。
 * 頂部取兩者較大：未遷移 App 的 paddingTop 已是劉海高度；已遷移 App paddingTop 為 0，靠真機 safe-top 兜底——
 * 兩種 App 都不會讓球鑽進劉海。
 * 底部只取 paddingBottom：未遷移 App 即安全區高度，已遷移 App 外殼已把底邊收回安全區內（為 0）；
 * 不疊加真機 safe-bottom（否則已遷移 App 會多讓一截、球停得偏高）。
 */
export const resolveInsets = ({ padTop, padBottom, safeTop }: RawInsets): { insetTop: number; insetBottom: number } => ({
  insetTop: Math.max(padTop, safeTop),
  insetBottom: padBottom,
});
