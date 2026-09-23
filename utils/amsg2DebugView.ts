/**
 * amsg2 調試面板的純派生層：把角色數據攤成「一條任務一行、帶狀態標註」的視圖。
 *
 * 這裡不碰 React、不碰 IndexedDB，全是可單測的純函數——面板顯示錯了很容易把排查
 * 帶偏（「面板說還沒到點，實際早就作廢了」），所以判定口徑必須釘死並測出來。
 *
 * 兩條口徑跟系統其它地方對齊，別在這裡另起一套：
 *   1. 活/死的分界完全等於 amsg2Tasks.isPendingTask（pending + firing = 它為真）；
 *   2. 人讀文案一律用 amsg2Tasks 的 describeXxx，跟角色上下文塊、list 工具、設置面板說同一套詞。
 */

import { ActiveMsg2TaskRecord, CharacterProfile } from '../types';
import { currentOccurrenceMs, isAmsg2EnabledForChar, isPendingTask } from './amsg2Tasks';

const MINUTE_MS = 60_000;

/**
 * pending  還沒到點，倒計時往下走
 * firing   已過名義時間但還在送達寬限內——正在發或正在被閘攔，這會兒最值得盯
 * expired  一次性任務過點超過寬限還沒動靜
 * cancelled 已取消（清單裡短暫存在，取消後就被移除）
 */
export type Amsg2DebugTaskState = 'pending' | 'firing' | 'expired' | 'cancelled';

export interface Amsg2DebugTaskView {
  task: ActiveMsg2TaskRecord;
  charId: string;
  charName: string;
  /** 該角色的主動消息總開關。關著的話任務再正常也不會響。 */
  charEnabled: boolean;
  state: Amsg2DebugTaskState;
  /** 當前這一次觸發的名義時刻；循環任務已按週期推算。時間串壞掉時為 null。 */
  occurrenceMs: number | null;
  /** cron 每分鐘跑一次，這是這一次觸發會被哪一分鐘的 cron 領走。 */
  cronTickMs: number | null;
}

/**
 * 這一次觸發會被哪一分鐘的 cron 領走。
 *
 * worker 的觸發器是 "* * * * *"（見 worker/amsg/wrangler.toml），每分鐘跑一次；跑起來時
 * 把名義時間已經到了的任務全部領走（底帳查詢是 next_send_at <= 當前時刻）。所以答案是
 * 「名義時間之後的第一個整分」，含名義時間自己壓在整分上的情況：
 *
 *   名義時間 11:47:00 → 11:47 這一分鐘的 cron 領走（面板裡倒計時歸零的同一分鐘）
 *   名義時間 11:47:30 → 11:47 那次跑過去時還沒到點，等 11:48 這一分鐘的 cron
 *
 * cron 實際起跑會比整分晚幾秒（平台調度的抖動），這裡按整分記——面板要的是「哪一分鐘」，
 * 秒級先後不影響讀數。
 */
export const nextCronTickMs = (occurrenceMs: number): number =>
  Math.ceil(occurrenceMs / MINUTE_MS) * MINUTE_MS;

/** 面板離視口邊緣至少留這麼多，四邊一致。 */
export const DEBUG_PANEL_MARGIN_PX = 8;

export interface Amsg2PanelPosition { x: number; y: number }
export interface Amsg2PanelSize { width: number; height: number }

/**
 * 把面板落點約束回視口內。拖動過程、鬆手、視口變化（轉屏 / 手機地址欄伸縮）都走這一個口徑。
 *
 * 面板比視口還大時（小屏 + 長列表）上下界會翻過來，此時取上界——寧可底部溢出，
 * 也要保證標題欄那排按鈕留在屏幕裡，不然全屏 / 關閉都點不到了。
 */
export const clampPanelPosition = (
  position: Amsg2PanelPosition,
  panel: Amsg2PanelSize,
  viewport: Amsg2PanelSize,
): Amsg2PanelPosition => {
  const axis = (value: number, extent: number, available: number) => {
    const max = available - extent - DEBUG_PANEL_MARGIN_PX;
    return Math.min(Math.max(value, DEBUG_PANEL_MARGIN_PX), Math.max(DEBUG_PANEL_MARGIN_PX, max));
  };
  return {
    x: axis(position.x, panel.width, viewport.width),
    y: axis(position.y, panel.height, viewport.height),
  };
};

/** 倒計時文案：未到點 T-4m12s，已過點 T+30s。 */
export const formatCountdown = (deltaMs: number): string => {
  const sign = deltaMs < 0 ? 'T+' : 'T-';
  const total = Math.floor(Math.abs(deltaMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${sign}${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s}s`;
};

const resolveState = (
  task: ActiveMsg2TaskRecord,
  occurrenceMs: number | null,
  nowMs: number,
): Amsg2DebugTaskState => {
  if (task.status !== 'scheduled') return 'cancelled';
  // 活/死一律問 isPendingTask，別在這裡重寫判定——兩邊一旦走岔，面板就會騙人。
  if (!isPendingTask(task, nowMs)) return 'expired';
  return occurrenceMs != null && nowMs >= occurrenceMs ? 'firing' : 'pending';
};

const STATE_ORDER: Record<Amsg2DebugTaskState, number> = {
  firing: 0,
  pending: 1,
  expired: 2,
  cancelled: 3,
};

/**
 * 全部角色的 amsg2 任務攤平成一張表。失效的任務照樣留著（置灰顯示）——
 * 排查「怎麼沒響」時，看得見那條死任務比它憑空消失有用得多。
 */
export const buildAmsg2DebugTasks = (
  characters: CharacterProfile[],
  nowMs: number,
): Amsg2DebugTaskView[] => {
  const views: Amsg2DebugTaskView[] = [];
  for (const char of characters) {
    const config = char?.activeMsg2Config;
    if (!config || !Array.isArray(config.tasks)) continue;
    for (const task of config.tasks) {
      const occurrenceMs = currentOccurrenceMs(task, nowMs);
      views.push({
        task,
        charId: char.id,
        charName: char.name || char.id,
        charEnabled: isAmsg2EnabledForChar(char),
        state: resolveState(task, occurrenceMs, nowMs),
        occurrenceMs,
        cronTickMs: occurrenceMs == null ? null : nextCronTickMs(occurrenceMs),
      });
    }
  }
  // 正在發的最要緊，其次是快到點的；失效的沉底，越近失效的越靠前。
  return views.sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    const at = a.occurrenceMs ?? Number.MAX_SAFE_INTEGER;
    const bt = b.occurrenceMs ?? Number.MAX_SAFE_INTEGER;
    const dead = a.state === 'expired' || a.state === 'cancelled';
    return dead ? bt - at : at - bt;
  });
};
