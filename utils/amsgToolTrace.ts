/**
 * 雲端工具痕跡 —— 「這一輪角色在雲端跑過哪些工具」怎麼說給用戶聽。
 *
 * 即時對話把整輪交給雲端跑，搜索、翻記憶這些都發生在用戶看不見的地方（本地那條路
 * 一直有「正在搜索網頁…」的狀態條，雲端這條路全程靜默）。worker 把跑過的工具隨最後
 * 一條推送捎回來，氣泡底下畫一行灰字：
 *
 *     調用了工具：搜索網頁 ×2 · 讀取記憶
 *
 * 線上傳的是**原始工具名 + 次數**（見 worker/amsg/src/index.ts 的 condenseToolTrace），
 * 翻譯成人話全在這一份裡做——顯示的事歸客戶端，wire 上少一層約定就少一處對不齊。
 */

import { MCP_FIRE_NAME_PREFIX } from './mcpFireCore';

/** worker 捎回來的一項：跑過的工具原始名 + 這一輪跑了幾次。 */
export interface AmsgToolTraceEntry {
  name: string;
  count: number;
}

/**
 * 內置工具 → 給用戶看的說法。
 *
 * 表外的名字原樣顯示，不編——露個英文名總好過給用戶一個錯的說法。
 */
const TOOL_DISPLAY_LABELS: Record<string, string> = {
  web_search: '搜索網頁',
  recall: '讀取記憶',
  notion_read_diary: '讀取 Notion',
  read_note: '讀取 Notion',
  feishu_read_diary: '讀取飛書',
  xhs_search: '讀取小紅書',
  xhs_browse: '讀取小紅書',
  xhs_my_profile: '讀取小紅書',
  xhs_detail: '讀取小紅書',
  schedule_active_message: '給自己排消息',
  cancel_active_message: '取消排好的消息',
  renew_active_message: '改排好的消息時間',
  list_active_messages: '查自己排的消息',
};

/**
 * 一個工具名 → 給用戶看的說法。認不出來的原樣返回，名字是空的返回空串（調用方丟掉）。
 *
 * MCP 工具剝掉內部前綴就直接用：那是用戶自己接進來的服務器，只有他知道那工具是幹嘛的，
 * 我們編不出比原名更準的說法；前綴又是我們拿來分流的，露出去跟他在設置裡填的對不上號。
 */
const describeToolForUser = (rawName: unknown): string => {
  if (typeof rawName !== 'string') return '';
  const name = rawName.trim();
  if (!name) return '';
  if (name.startsWith(MCP_FIRE_NAME_PREFIX)) return name.slice(MCP_FIRE_NAME_PREFIX.length);
  return TOOL_DISPLAY_LABELS[name] ?? name;
};

/**
 * 工具痕跡 → 氣泡底下那行灰字裡的內容（不含「調用了工具：」那個前綴）。
 *
 * `[{ name: 'web_search', count: 2 }, { name: 'recall', count: 1 }]`
 *   → `搜索網頁 ×2 · 讀取記憶`
 *
 * 兩條規矩：
 *   - 只跑過一次的省掉 `×1`。不然一行全是 ×1，反倒看不出哪個跑了好幾遍。
 *   - 說法相同的幾項合併計次（小紅書那幾個工具在用戶眼裡是同一件事），
 *     否則會畫出「讀取小紅書 · 讀取小紅書」，像渲染出了 bug。
 *
 * 形狀不對就返回空串、這一行整個不畫：這份數據是 worker 隨推送捎回來的，老版本 worker
 * 壓根不帶，寧可少一行也不要在氣泡底下渲染出 `[object Object]`。
 */
export const formatAmsgToolTrace = (raw: unknown): string => {
  if (!Array.isArray(raw)) return '';
  const byLabel = new Map<string, number>();
  for (const entry of raw) {
    const label = describeToolForUser((entry as Partial<AmsgToolTraceEntry> | null)?.name);
    if (!label) continue;
    // 次數缺了 / 是垃圾值時按「跑過一次」算：這一項存在本身就說明至少跑過一次。
    const parsed = Number((entry as Partial<AmsgToolTraceEntry>).count);
    const count = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
    byLabel.set(label, (byLabel.get(label) ?? 0) + count);
  }
  return [...byLabel]
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(' · ');
};
