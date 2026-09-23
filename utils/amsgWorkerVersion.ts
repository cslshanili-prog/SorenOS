/**
 * amsg worker 版本比較（設置頁「重新粘貼部署」探測用）。
 *
 * 為什麼 features 探測不夠：amsg-server 2.6.0 的 next.4 / next.5 / next.6 三版
 * SERVER_FEATURES 清單完全相同（六項都在），而本波依賴的能力上游大多沒發獨立
 * feature flag——GET /messages 的 charId/clientTaskId 投影、onBeforeFire 的
 * { skip: true } 出口（next.5 起）、任務佔位租約（next.6 起）、hook 的 writeState
 * 與 Web Push 大小護欄（next.7 起）。舊粘貼部署只查 features 會被誤判為最新：
 * 防穿幫閘在 worker 側靜默不存在、任務列表全部誤標「遠端不存在」、長任務被相鄰
 * cron tick 重複觸發。只能再比 serverVersion。
 *
 * 比較語義按 semver + 數字化 prerelease：
 *   2.6.0-next.4 < 2.6.0-next.5 < 2.6.0-next.10 < 2.6.0 < 2.6.1-next.1
 * 解析不了的版本串（上游改格式等）視為「不達標」——寧可多亮一次「重新部署」，
 * 也不靜默降級（與 capabilities 探測的設計初衷一致）。
 */

interface ParsedVersion {
  main: [number, number, number];
  /** null = 正式版（高於同主版本號的任何 prerelease）。 */
  pre: Array<string | number> | null;
}

const parseVersion = (value: string): ParsedVersion | null => {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/.exec(value || '');
  if (!m) return null;
  return {
    main: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : null,
  };
};

/** a<b → -1，a==b → 0，a>b → 1；任一側解析失敗 → null。 */
export const compareAmsgServerVersions = (a: string, b: string): number | null => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.main[i] !== pb.main[i]) return pa.main[i] < pb.main[i] ? -1 : 1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // 前綴相同時段數少的更低（semver 規則）
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) return (x as number) < (y as number) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1; // 數字段低於字母段（semver 規則）
    return (x as string) < (y as string) ? -1 : 1;
  }
  return 0;
};

export const isAmsgServerVersionAtLeast = (
  version: string | undefined | null,
  floor: string,
): boolean => {
  const cmp = compareAmsgServerVersions(version ?? '', floor);
  return cmp != null && cmp >= 0;
};
