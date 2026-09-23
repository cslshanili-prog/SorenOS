// utils/amsgStateClock.ts
//
// 雲端 client_state 那一行該蓋幾點的版本號（`updatedAt`）。
//
// 雲端的寫入是條件寫：新來的 `updatedAt` 不比庫裡那行晚，整條就跳過（舊不蓋新，
// 見 worker 的 `WHERE excluded.updated_at >= client_state.updated_at`）。這道閘護的是
// 「慢包後到別蓋掉新包」，判據卻是客戶端自己報的時間——於是它護不住設備時鐘本身跑偏：
// 手機的鐘只要領先過真實時間，那一刻同步上去的行就帶著一個**還沒到的時刻**，之後每
// 次上傳都比它「舊」，雲端從此一直拒收。
//
// 這不是理論上的坑。2026-09-01 有用戶改過一次系統時間，之後那個角色的即時對話一直
// 報 409，刪消息、重啟、重裝小手機、重填 Worker 地址全都不管用——那一行在雲端 D1 裡，
// 本地做什麼都碰不到它；而常規的批量同步撞上同一道閘只打一行 log，那個角色的雲端上
// 下文就一直停在舊版本，界面上什麼都看不出來。
//
// 所以本地記一道水位：蓋出去的時間戳只會往前走，絕不回頭。正常情況下（時鐘沒跑偏）
// 水位就是上次寫入的時刻，`Date.now()` 每次都比它大，行為與直接用牆鍾完全一致；
// 只有在時鐘被回撥、或雲端那行已經落在未來時，水位才接管，保證這一次寫得進去。
//
// 水位有兩個抬升來源：自己每次蓋戳（同一毫秒內連寫兩次也能嚴格遞增），以及
// `observeRemoteStateUpdatedAt` —— 雲端明說了它那份更新時，照它的數對齊。

const HEADER = '[AmsgStateClock]';

/** 水位的落盤位置。存 localStorage 而不是內存：關掉頁面再回來，雲端那行還在原地。 */
export const AMSG_STATE_CLOCK_LS_KEY = 'amsg2_state_clock_watermark';

/** 水位領先本機時鐘超過這麼久就喊一聲——正常狀態下兩者只差幾毫秒。 */
const CLOCK_SKEW_WARN_MS = 60_000;

/** 內存裡的當前水位；null = 還沒從 localStorage 讀回來。 */
let watermark: number | null = null;

const readWatermark = (): number => {
  if (watermark !== null) return watermark;
  try {
    const raw = Number(localStorage.getItem(AMSG_STATE_CLOCK_LS_KEY));
    watermark = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  } catch {
    // 隱私模式 / 沒有 localStorage 的環境：退回純內存，本次會話內仍然單調。
    watermark = 0;
  }
  return watermark;
};

const writeWatermark = (value: number) => {
  watermark = value;
  try {
    localStorage.setItem(AMSG_STATE_CLOCK_LS_KEY, String(value));
  } catch {
    // 存儲滿 / 寫不進去：這一輪蓋的戳仍然是對的，只是重啟後退回本地時鐘。
  }
};

const warnIfAhead = (value: number, now: number, reason: string) => {
  const skew = value - now;
  if (skew <= CLOCK_SKEW_WARN_MS) return;
  console.warn(
    `${HEADER} 雲端狀態的時間戳領先本機時鐘 ${Math.round(skew / 1000)} 秒（${reason}）。`
    + '設備時鐘大概被改過，雲端那行要等真實時間追上來才會回到正常節奏。',
  );
};

/**
 * 給這一次 client_state 寫入蓋一個時間戳：本機時鐘與水位取大的那個，且嚴格遞增。
 *
 * 凡是往雲端寫狀態的地方都該用它，別再各自 `Date.now()` —— 只要有一條路漏了，
 * 那條路就會在時鐘跑偏後一直被雲端拒收。
 */
export const stampStateUpdatedAt = (): number => {
  const now = Date.now();
  const at = Math.max(now, readWatermark() + 1);
  writeWatermark(at);
  warnIfAhead(at, now, '本地水位');
  return at;
};

/**
 * 雲端那份的時間戳比本地水位還新時，照它對齊（返回是否真的抬動了）。
 *
 * 用在「被條件寫攔下」之後：攔下就說明雲端那行的時間戳我們跨不過去，讀回來對齊一次，
 * 下一次寫入自然就蓋得上。返回 false 表示水位沒動——那這次被攔不是時間戳的事，
 * 重發也是白發。
 */
export const observeRemoteStateUpdatedAt = (remoteUpdatedAt: unknown): boolean => {
  if (typeof remoteUpdatedAt !== 'number' || !Number.isSafeInteger(remoteUpdatedAt)) return false;
  if (remoteUpdatedAt <= readWatermark()) return false;
  writeWatermark(remoteUpdatedAt);
  warnIfAhead(remoteUpdatedAt, Date.now(), '雲端那行');
  return true;
};

/** 當前水位（排障與單測用；日常代碼不需要看它）。 */
export const readStateClockWatermark = (): number => readWatermark();

/** 把水位清零（單測用：各條用例之間不互相汙染）。 */
export const resetStateClock = () => {
  watermark = null;
  try {
    localStorage.removeItem(AMSG_STATE_CLOCK_LS_KEY);
  } catch {
    // 同上，讀不到就當沒有。
  }
};
