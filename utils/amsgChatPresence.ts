// utils/amsgChatPresence.ts
/**
 * 同角色活躍會話租約（Heartbeat）— 純常量、類型與解析/新鮮度判定。
 *
 * ⚠️ 葉子模塊：會被 worker/amsg 打進 Cloudflare bundle，同時被瀏覽器側
 * （amsgStateSync 的租約 timer / activeMsgClient 的 PUT）複用——不得 import
 * DB / React / 任何瀏覽器環境依賴（與 utils/amsg2ExpireGuard.ts 同一約束）。
 *
 * 語義：一輪真實用戶消息進入生成流程時立即寫 `amsg:char:<charId>/chat_presence`，
 * 等待角色回覆期間每 15s 續租；成功/失敗/中斷後停止續租，遠端值靠 45s TTL 自然失效。
 * 它只代表「正在和這個角色交互」，不是 App 在線狀態。worker 對 expire AI 任務先檢查
 * 新鮮租約，新鮮則 { skip: true }，再走 last-message 規則。
 */

export const AMSG_CHAT_PRESENCE_KEY = 'chat_presence';
export const CHAT_PRESENCE_HEARTBEAT_MS = 15_000;
export const CHAT_PRESENCE_TTL_MS = 45_000;

export interface AmsgChatPresence {
  v: 1;
  charId: string;
  /** 最近一次續租的 epoch ms。worker 以自己的 ctx.now 判斷 TTL。 */
  activeAt: number;
  /** 最近一條真實用戶消息，用於一次性任務的 anchor 規則。 */
  lastUserMessageAt: number | null;
}

export const parseAmsgChatPresence = (raw: string | undefined): AmsgChatPresence | null => {
  try {
    const value = raw ? JSON.parse(raw) : null;
    return value?.v === 1 && typeof value.charId === 'string' &&
      typeof value.activeAt === 'number' &&
      (value.lastUserMessageAt === null || typeof value.lastUserMessageAt === 'number')
      ? value as AmsgChatPresence : null;
  } catch {
    return null;
  }
};

export const isFreshChatPresence = (
  value: AmsgChatPresence | null | undefined,
  charId: string,
  nowMs: number,
): boolean => Boolean(
  value && value.v === 1 && value.charId === charId &&
  value.activeAt <= nowMs + 10_000 && nowMs - value.activeAt <= CHAT_PRESENCE_TTL_MS,
);
