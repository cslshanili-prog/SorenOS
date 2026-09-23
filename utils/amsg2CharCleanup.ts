/**
 * 刪角色時的雲端善後：把 ta 在 worker D1 `client_state` 裡的那份數據清掉。
 *
 * 雲端存的不是元數據，是**完整的角色系統提示詞 + 最近 30 條對話原文**（fire_pack，
 * 實測一個角色 32KB 起步），旁邊還有 tool_pack、活躍會話租約、以及 push 裝不下時
 * 旁路存的小紅書會話。刪除確認框跟用戶說的是「該操作不可恢復，記憶將被清空」，
 * 用戶按下確認那一刻的預期就包含雲端那份；留著既對不上這句承諾，也讓每刪一個角色
 * 就在 D1 裡堆一份聊天記錄。設置頁那個「清除雲端狀態」是全局按鈕、要用戶主動去點，
 * 指望不上它替刪角色收尾。
 *
 * 這一步是 best-effort：斷網、worker 掛了都不該攔著角色刪掉（用戶想刪的是這個角色，
 * 而且今天刪不掉明天還是刪不掉）。所以異常在這裡就地吞掉、用返回值把結果交給調用方，
 * 調用方照常刪本地記錄，只是多彈一條提示。
 */

import { CharacterProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { charCredIds, forgetCredIds } from './amsgLlmCredentials';

export type CharCloudStateCleanup =
  /** 沒有云端可清（角色不存在，或壓根沒填 worker 地址）—— 一個請求都沒發。 */
  | { status: 'skipped' }
  /** 清完了；keys 是實際被清空的條目（本來就空的角色是空數組）。 */
  | { status: 'cleared'; keys: string[] }
  /** 沒清成（斷網 / worker 掛了 / 沒填 worker 地址）。角色照刪，調用方負責提示。 */
  | { status: 'failed'; error: unknown };

/**
 * 判斷這個角色雲端有沒有可能留著東西。
 *
 * 只要角色存在就當「可能有」：往雲端寫狀態的路不止面板那幾條——全局即時對話開著時，
 * **從沒打開過 2.0 面板的角色**（activeMsg2Config 缺失，只是跟隨全局默認開）每輪聊天
 * 也在經 POST /instant-chat 往 client_state 寫完整對話和提示詞（worker 側還會寫
 * chat_outbox / chat_fail）。按「配沒配過」猜寫沒寫過，猜漏一條路聊天原文就永久留在
 * D1 裡。清理是冪等操作、成本一次網絡請求，寧可多發不可漏，所以這裡不做任何按角色的
 * capability 預檢；真正的門只有一道——「壓根沒配 worker 連接」，那一道由調用方
 * （purgeCharCloudState、deleteCharacter 的前置檢查）讀全局配置來把。
 */
export const charMayHaveCloudState = (char: CharacterProfile | undefined): boolean =>
  Boolean(char);

/**
 * 清掉該角色的雲端 client_state。永遠不拋錯（見文件頭：不能阻塞角色刪除）。
 *
 * 發請求之前先確認真有個 worker 可發。沒填地址時雲端一個字節都沒寫過，
 * 那不是「清理失敗」，跳過就好——報成失敗會讓用戶對著一條根本不存在的殘留發愁。
 * 這也是唯一的一道門：只要 worker 配置在，就不再按角色猜「寫沒寫過」，清一次是冪等的。
 *
 * 判斷放在發請求之前、而不是靠 catch 裡認錯誤文案：錯誤文案改一次這裡就失效了。
 */
export const purgeCharCloudState = async (
  char: CharacterProfile | undefined,
): Promise<CharCloudStateCleanup> => {
  if (!charMayHaveCloudState(char)) return { status: 'skipped' };

  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) return { status: 'skipped' };
  } catch {
    // 連本地配置都讀不到，等於無從判斷有沒有云端；按沒有處理，別為它彈錯誤。
    return { status: 'skipped' };
  }

  // 這個角色名下登記的 API 憑據行也一起清掉：角色都沒了，那幾行再留著只是白佔
  // 雲端的行數上限。跟 client_state 各清各的——憑據沒清成不該讓上下文也留在雲端。
  // 失敗只 warn：刪角色的路上一個附帶清理攔不住主線（下次同名 credId 覆蓋即可）。
  try {
    await ActiveMsgClient.deleteLlmCredentials({ credIds: charCredIds(char!.id) });
  } catch (error) {
    console.warn('[Amsg2CharCleanup] 刪角色時清雲端 API 憑據失敗（不影響刪除）', error);
    // 本地那本指紋底帳照劃：角色都沒了，留著幾條死帳只會一直佔 localStorage，
    // 後台重傳也會一遍遍去查一個不存在的角色。
    forgetCredIds(charCredIds(char!.id));
  }

  // 後台任務的一次性輸入不住在角色命名空間裡（它按 job 編號存在共用的 amsg:job 下，
  // 見 amsgTaskKinds），所以上面那趟清不到它。裡面裝的是這個角色的門牌全文、蒸餾材料
  // 和身份上下文——正是刪除確認框承諾會清掉的那類東西，不能讓它躺滿 3 天等 TTL。
  await purgeInFlightPlateJob(char!.id);

  try {
    const keys = await ActiveMsgClient.clearCharClientState(char!.id);
    return { status: 'cleared', keys };
  } catch (error) {
    return { status: 'failed', error };
  }
};

/**
 * 清掉這個角色那份還在雲端跑的門牌整理：把任務取消掉，再撤掉它的一次性輸入。
 *
 * 只清「在飛」那一條：跑完的 worker 自己會刪，而同一角色同時只許一份在飛（見
 * roomPlateCloud 的在飛記號），所以本地記著的那個 job 編號就是全部。
 *
 * 讀記號要用**不看 TTL 的那個**（readPlateJobInFlightRaw）。帶 TTL 的那個問的是
 * 「這份還算不算在飛」，超過半小時一律回 null——而躺得越久的那份越是沒人管的：worker
 * 沒送回結果、行還在雲端佔著，那行裡裝的是整塊門牌原文、蒸餾材料和身份上下文，會一直
 * 留到 TTL 到期。刪角色時的承諾是「記憶將被清空」，不能因為它躺久了就跳過。
 *
 * **先取消任務，再撤輸入**。只撤輸入的話任務行還在，到點照樣起跑、照樣按重試梯子重來
 * 幾輪（讀到空值會安靜跳過，但每一輪都是一次調度），而它已經沒有任何落腳點了。取消是
 * 冪等的：一次性任務跑完就刪行，遠端回 404 就是取消要達到的終態。
 *
 * 撤輸入跟別的清理一樣是**寫空串**而不是刪行（HTTP 的 PUT /client-state 沒有刪除語義）。
 */
const purgeInFlightPlateJob = async (charId: string): Promise<void> => {
  try {
    const { readPlateJobInFlightRaw, clearPlateJobInFlight, clearPlateJobDone } =
      await import('./memoryPalace/roomPlateCloud');
    const inFlight = readPlateJobInFlightRaw(charId);
    // 本地記號先清：雲端那步失敗也不該讓這個已經不存在的角色繼續佔著閘。
    // 「哪些結果已經落過地」那本底帳一起清掉——角色都沒了，留著只是一串沒主的編號。
    clearPlateJobInFlight(charId);
    clearPlateJobDone(charId);
    if (!inFlight) return;

    // 記號一清，那個 job 編號就再沒有別的地方記著了——「設置 → API 調用記錄」裡那筆
    // 「雲端生成中」於是永遠等不到人來收，一直轉圈到 5 天后被裁掉。在飛記號超時那條路
    // 特意繞開的就是這個坑，刪角色這條路同樣得收。
    const { cloudApiCallLogId, settleCloudApiCall } = await import('./apiCallLog');
    settleCloudApiCall({ id: cloudApiCallLogId(inFlight.jobId), ok: false });

    // 任務行先撤。拿不到 uuid 的只有一種情況：提交的答覆丟在了路上（任務可能建了、編號
    // 卻沒回來），那種只能等它自己跑完——讀到空輸入會安靜跳過。
    if (inFlight.uuid) {
      try {
        await ActiveMsgClient.cancelTask(inFlight.uuid);
      } catch (error) {
        console.warn('[Amsg2CharCleanup] 刪角色時取消門牌整理任務失敗（輸入照撤）', error);
      }
    }

    const { AMSG_JOB_NAMESPACE } = await import('./amsgTaskKinds');
    const { plateJobKey } = await import('./amsgPlateJob');
    await ActiveMsgClient.clearClientStateValue(AMSG_JOB_NAMESPACE, plateJobKey(inFlight.jobId));
  } catch (error) {
    console.warn('[Amsg2CharCleanup] 刪角色時清在飛的門牌整理輸入失敗（等 TTL 兜底）', error);
  }
};
