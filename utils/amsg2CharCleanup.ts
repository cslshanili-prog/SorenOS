/**
 * 角色級的雲端善後：把 ta 在 worker D1 裡的那份數據清掉。刪角色和「關掉這個角色的
 * 定時主動消息」都走這裡，區別只在清單（見 CharCloudPurgePlan）。
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
import {
  ALL_CREDENTIAL_PURPOSES,
  charCredId,
  forgetCredIds,
  type LlmCredentialPurpose,
} from './amsgLlmCredentials';

/**
 * 這一趟要清掉哪幾樣。
 *
 * 分出這個是因為「角色被刪了」和「角色只是關掉了定時主動消息」不是一回事：前者名下
 * 一切都該清，後者還有東西活著——即時對話開著的話雲端那份上下文每輪聊天都會重寫，
 * 記憶宮殿的後台活兒也照舊要用它自己那行憑據。照著刪角色那套清一遍，清掉的是別人
 * 還在用的東西。
 */
export interface CharCloudPurgePlan {
  /** 清掉角色命名空間下的全部條目（fire_pack / tool_pack / 自述日誌 / 旁路會話都在裡面）。 */
  clientState: boolean;
  /** 要刪掉的憑據用途。 */
  credPurposes: readonly LlmCredentialPurpose[];
  /** 撤掉還在飛的記憶宮殿門牌整理（任務行 + 它那份一次性輸入）。 */
  inFlightPlateJob: boolean;
}

/** 刪角色用的全量清單：名下一切都清掉。 */
export const FULL_CHAR_PURGE: CharCloudPurgePlan = {
  clientState: true,
  credPurposes: ALL_CREDENTIAL_PURPOSES,
  inFlightPlateJob: true,
};

/**
 * 關掉角色的定時主動消息時用的清單。
 *
 * 雲端那份上下文（fire_pack 是完整角色卡加最近 30 條對話原文）存在的意義就是給到點
 * 觸發用的，任務都取消了它就是純殘留——而且關掉之後打髒那道門會把這個角色永久擋在
 * 外面，既不會再刷新也不會再被清掉，永遠凍在關閉那一刻的對話原文上。
 *
 * 但即時對話還開著的話它是活的：每一輪聊天都會重寫它，這時候清只是白清一次，下一句
 * 話又傳上去。所以按即時對話還生不生效分兩種清單。記憶宮殿那行憑據兩種都保留——
 * 門牌整理跟主動消息是兩條獨立的路，關掉這個不該把那個也弄停。
 */
export const disableScheduleCharPurge = (instantChatStillLive: boolean): CharCloudPurgePlan => ({
  clientState: !instantChatStillLive,
  credPurposes: instantChatStillLive ? ['chat'] : ['chat', 'instant', 'emotion'],
  inFlightPlateJob: false,
});

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
 *
 * `plan` 說清這一趟要清哪幾樣，默認是刪角色那份全量清單。關掉定時主動消息走的是
 * 另一份（見 disableScheduleCharPurge）：那時候即時對話和記憶宮殿的後台活兒可能還
 * 活著，照全量清一遍會把它們正在用的東西清掉。
 */
export const purgeCharCloudState = async (
  char: CharacterProfile | undefined,
  plan: CharCloudPurgePlan = FULL_CHAR_PURGE,
): Promise<CharCloudStateCleanup> => {
  if (!charMayHaveCloudState(char)) return { status: 'skipped' };
  return purgeCloudCharById(char!.id, plan);
};

/**
 * 同上，但只認角色 id。
 *
 * 給「雲端還留著一個本地已經不存在的角色」那種情況用——導入備份換掉整套角色之後，
 * 舊檔角色在雲端的那份上下文和憑據行就是這種，本地壓根拿不出對應的 CharacterProfile。
 * 這類殘留沒人會再刷新、也沒人會再清：client_state 的角色命名空間在 worker 側沒有
 * TTL，不在這時候清掉就是永久留著，而裡面裝的是完整角色卡加最近 30 條對話原文。
 */
export const purgeCloudCharById = async (
  charId: string,
  plan: CharCloudPurgePlan = FULL_CHAR_PURGE,
): Promise<CharCloudStateCleanup> => {
  if (!charId) return { status: 'skipped' };

  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) return { status: 'skipped' };
  } catch {
    // 連本地配置都讀不到，等於無從判斷有沒有云端；按沒有處理，別為它彈錯誤。
    return { status: 'skipped' };
  }

  // 這個角色名下登記的 API 憑據行也一起清掉：沒人再用的那幾行留著只是白佔雲端的
  // 行數上限，而且裡面裝的是 API Key。跟 client_state 各清各的——憑據沒清成不該
  // 讓上下文也留在雲端。失敗只 warn：附帶清理攔不住主線（下次同名 credId 覆蓋即可）。
  const credIds = plan.credPurposes.map((purpose) => charCredId(charId, purpose));
  if (credIds.length > 0) {
    try {
      await ActiveMsgClient.deleteLlmCredentials({ credIds });
    } catch (error) {
      console.warn('[Amsg2CharCleanup] 清雲端 API 憑據失敗（不影響主流程）', error);
      // 本地那本指紋底帳照劃：雲端那行已經當作不存在了，底帳留著會讓後台重傳
      // 一直以為「傳過了」，下次真要用時反而補不回來。
      forgetCredIds(credIds);
    }
  }

  // 後台任務的一次性輸入不住在角色命名空間裡（它按 job 編號存在共用的 amsg:job 下，
  // 見 amsgTaskKinds），所以下面那趟清不到它。裡面裝的是這個角色的門牌全文、蒸餾材料
  // 和身份上下文——正是刪除確認框承諾會清掉的那類東西，不能讓它躺滿 3 天等 TTL。
  if (plan.inFlightPlateJob) await purgeInFlightPlateJob(charId);

  if (!plan.clientState) return { status: 'cleared', keys: [] };

  try {
    const keys = await ActiveMsgClient.clearCharClientState(charId);
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
