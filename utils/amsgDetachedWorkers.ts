/**
 * 斷開過的 Worker 地址備忘。
 *
 * 清空或更換 Worker 地址都不會動雲端那份數據——這兩個動作沒有毀滅的意味，換反代端點、
 * 換自定義域名走的也是同一條路，背後往往還是同一台 worker、同一個 D1，照著「地址變了」
 * 就去清，等於把用戶正在用的數據刪了。真要清有專門的入口（設置頁的「清空雲端數據」），
 * 那是用戶親手點的。
 *
 * 但地址一換，本地就再沒有別的地方記得上一個地址了，而那台 worker 上的定時任務照樣到點
 * 跑、照樣燒 API 額度、照樣往這台設備推消息。這本備忘就是回去的門：記下地址和斷開時間，
 * 用戶想清的時候知道該填哪個地址。
 *
 * 只記地址和時間，不記共享密鑰和主密鑰。那兩樣是鑰匙，存在這裡沒有對應的用途——這份
 * 記錄只夠「提醒你那邊還留著東西」，真要連回去清，密鑰還得用戶自己填。
 */

const LS_KEY = 'amsg2_detached_workers_v1';
/** 留最近幾條就夠了：再往前的地址用戶自己也認不出來是哪台。 */
const MAX_ENTRIES = 5;

export interface DetachedWorkerRecord {
  /** 斷開時那個 Worker 地址。 */
  url: string;
  /** 斷開時間（epoch ms）。 */
  detachedAt: number;
}

const isRecord = (value: unknown): value is DetachedWorkerRecord =>
  !!value
  && typeof value === 'object'
  && typeof (value as DetachedWorkerRecord).url === 'string'
  && !!(value as DetachedWorkerRecord).url
  && typeof (value as DetachedWorkerRecord).detachedAt === 'number';

/** 讀備忘，最近斷開的排在前面。讀壞了當沒有（這本帳丟了不影響任何功能）。 */
export const readDetachedWorkers = (): DetachedWorkerRecord[] => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).sort((a, b) => b.detachedAt - a.detachedAt);
  } catch {
    return [];
  }
};

/**
 * 記一筆「這個地址斷開了」。
 *
 * 同一個地址反覆斷開只留最新那次：用戶關心的是「那邊還有沒有東西」，不是斷過幾回。
 */
export const rememberDetachedWorker = (url: string | undefined | null): void => {
  const trimmed = url?.trim();
  if (!trimmed) return;
  try {
    const next = [
      { url: trimmed, detachedAt: Date.now() },
      ...readDetachedWorkers().filter((record) => record.url !== trimmed),
    ].slice(0, MAX_ENTRIES);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    // 寫不進去就算了：這本帳是給用戶的提示，不該因為存儲滿了而打斷正在進行的操作。
  }
};

/** 用戶已經把那台清乾淨了（或者確認不用管了），從備忘裡劃掉。 */
export const forgetDetachedWorker = (url: string): void => {
  try {
    const remaining = readDetachedWorkers().filter((record) => record.url !== url);
    if (remaining.length === 0) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, JSON.stringify(remaining));
  } catch {
    /* 同上，失敗無所謂 */
  }
};
