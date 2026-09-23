/**
 * 雲端結果的分發口（`resultKind` → 誰來消化）
 *
 * worker 的 `ctx.emitResult` 送回來的東西不是聊天內容——是後台跑完的產物：整理好的一份
 * 數據、一條帳目、一份報告。它跟聊天正文走同一條送達通道（落服務端收件箱 + 視通知策略
 * 發推送），但到了客戶端要分頭處理，所以在這裡按 `resultKind` 派活。
 *
 * 兩個入口都指到這兒來：
 *   - **推送直達**：SW 收到 `messageKind: 'result'` → `active-msg-result` → activeMsgRuntime
 *   - **上線補收**：`GET /outbox?since=` 拉回來的 result 條目（amsgInstantChat 的補收）
 *
 * 返回值就一件事：**這條能不能銷帳**。`true` = 消化完了（或者確定消化不了，留著也沒用），
 * 客戶端把它從服務端帳本上劃掉；`false` = 這次沒處理成（比如落庫失敗），帳不銷，下次
 * 上線再拉回來重試。判斷反了的後果兩頭都難看：該銷不銷就是每次上線重放一次，該留不留
 * 就是結果靜默蒸發。
 */

import { PLATE_CONSOLIDATE_RESULT_KIND } from './amsgPlateJob';
import { SCHEDULE_CHANGE_RESULT_KIND } from './amsgScheduleResult';

const HEADER = '[amsg2:result]';

/** 從一條 push payload 上讀出結果種類；不是結果類 payload 就返回 null。 */
export const readResultKind = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).resultKind;
  return typeof raw === 'string' && raw ? raw : null;
};

/**
 * 分發排隊用的尾巴：同一時刻只跑一條結果。
 *
 * 上面那兩個入口能撞車——推送剛到、頁面同時因為 visibilitychange 跑了一趟補收，兩邊
 * 指的是同一條結果，或者兩條不同的結果落在同一塊數據上。handler 普遍是「讀一份 → 改 →
 * 整塊存回去」，併發跑就是後寫的把先寫的整塊蓋掉，而且兩邊日誌都顯示成功。排隊的代價
 * 只是後一條晚幾百毫秒落地，結果本來就是異步回來的，沒人在等。
 */
let dispatchChain: Promise<unknown> = Promise.resolve();

/**
 * 單條結果最多佔用隊伍這麼久。
 *
 * 隊是全局一條、所有 resultKind 共用的，所以「卡住」的代價不是這一條晚落地，而是**後面
 * 每一條都永遠排不上**。而 handler 幹的是 IndexedDB 的活兒：連接被別的標籤頁 block 住
 * （IndexedDB 連接風暴時就出過這種事）、事務卡在那兒不 settle，都是真實發生
 * 過的形態，promise 一輩子不 resolve。超時之後按「這條沒處理成」算——帳不銷，下次上線
 * 還會拉回來重試；卡住那次的活兒還在後台跑，但至少不再擋著別人。
 *
 * **超時只是放行，不是取消**：卡住那個 handler 還在跑，後面那條一進來就跟它並行了。所以
 * 這條隊不能是數據安全的唯一依靠——真正的互斥要落在被改的那份數據上（門牌那條路在
 * `mutatePlate` 裡按門牌排隊，兩個 handler 撞上同一塊也只會一前一後）。往這張表裡加新
 * handler 時照著辦：自己那份數據自己鎖，別指望這條隊。
 */
const DISPATCH_TIMEOUT_MS = 60_000;

/**
 * 把一條結果交給認領它的那一方。
 *
 * 具體 handler 走動態 import：它們要讀寫 IndexedDB，而這份文件被補收鏈路引著，
 * 靜態引進來會把整個記憶宮殿的依賴拖進那條路的首屏包裡。
 *
 * @param context 這條結果的隨身信息，轉交給 handler。補收那條腿要帶上 `createdAt`
 *   （帳本上記的時間）——handler 據此判「這份產物是不是已經陳到不能用了」。
 * @returns 這條能不能銷帳
 */
export const dispatchAmsgResult = async (
  payload: unknown,
  context?: AmsgResultContext,
): Promise<boolean> => {
  const next = () => guardDispatch(payload, context);
  // 前一條的成敗不影響後一條排上隊（catch 掉，別讓一次失敗把整條隊掐斷）。
  const run = dispatchChain.then(next, next);
  dispatchChain = run.catch(() => {});
  return run;
};

/** 一條結果的隨身信息（不是結果內容本身）。 */
export interface AmsgResultContext {
  /** 這條結果是什麼時候記進服務端帳本的（epoch 毫秒）。推送直達那條腿是剛剛，不用傳。 */
  createdAt?: number;
}

const guardDispatch = async (payload: unknown, context?: AmsgResultContext): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dispatchOne(payload, context),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`${HEADER} 一條結果消化了 ${DISPATCH_TIMEOUT_MS / 1000} 秒還沒完（IDB 卡住？），先放行後面的（帳沒銷）`, payload);
          resolve(false);
        }, DISPATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const dispatchOne = async (payload: unknown, context?: AmsgResultContext): Promise<boolean> => {
  const resultKind = readResultKind(payload);
  if (!resultKind) {
    console.warn(`${HEADER} 收到一條沒有 resultKind 的結果，丟棄`, payload);
    return true;
  }

  try {
    switch (resultKind) {
      case PLATE_CONSOLIDATE_RESULT_KIND: {
        const { applyPlateConsolidateResult } = await import('./memoryPalace/roomPlateCloud');
        return await applyPlateConsolidateResult(payload, context);
      }
      case SCHEDULE_CHANGE_RESULT_KIND: {
        const { applyScheduleChangeResult } = await import('./amsgScheduleResultApply');
        return await applyScheduleChangeResult(payload, context);
      }
      default:
        // 認不出來的多半是**前端比 worker 舊**：worker 可以脫開前端單獨更新（fork 的
        // Sync → Cloudflare Workers Builds），PWA 那邊還可能跑著緩存下來的舊包。銷帳
        // 丟掉的話，這份跑完的活兒在前端更新完之前就已經從服務端帳本上抹掉了，等前端
        // 認得它的時候東西已經沒了。
        //
        // 所以留著不銷：代價只是每次上線把它拉回來再看一眼、多打一行日誌，而收件箱
        // 本來就有 28 天保留期兜底，攢不住。這跟上面「沒有 resultKind」那一支的處置
        // 相反是有意的——那種是形狀本身就壞了，換個版本的前端也一樣讀不出來。
        console.warn(`${HEADER} 不認識的 resultKind=${resultKind}（前端比 worker 舊？），先留著不銷帳`);
        return false;
    }
  } catch (error) {
    console.warn(`${HEADER} 消化 ${resultKind} 出錯（帳沒銷，下次再來）`, error);
    return false;
  }
};
