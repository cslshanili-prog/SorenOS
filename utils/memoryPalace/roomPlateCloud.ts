/**
 * 門牌整理走雲端那條路（提交 → 等結果 → 合併落庫）
 *
 * 本地那條路（roomPlates.ts 的 consolidatePlates）是「讀庫 → 調 LLM → 合併落庫」一條龍，
 * 全程 await，頁面一關就斷。雲端這條路把中間那段搬走：客戶端把材料裝成一份 job 交上去
 * 就返回，LLM 在用戶自己的 CF Worker 上跑；跑完結果落進服務端收件箱，客戶端下次上線
 * 補收回來，再做合併落庫。
 *
 * 合併為什麼留在本地：要合併進去的門牌本體在瀏覽器的 IndexedDB 裡，雲端夠不著。而合併
 * 語義（basedOn 繼承來歷、沒被重新輸出的條目淘汰）是純函數，放哪兒跑都一樣。
 *
 * 一個必須處理的時間差：提示詞是拿**提交那一刻**的門牌快照拼的，而結果可能幾分鐘後才
 * 回來，這中間門牌說不定已經被別的路徑動過（封盒、手動回填都在本地跑）。所以提交時把
 * 每條的 id 一起帶上、結果原樣回傳，落地時按 id 做兩件事：
 *   1. 把 `basedOn` 標籤重新對準當前條目（remapBasedOnLabels）；
 *   2. 把**快照之後新增的條目**護住不淘汰（mergeCloudPlateEntries）——LLM 沒見過它們，
 *      談不上「決定淘汰」。
 * 還有一道防線在提交側：同一個角色同時只許一份整理在飛（見 in-flight 記號），兩份結果
 * 先後落地就是拿兩份舊快照互相蓋。
 */

import { ActiveMsgClient, mayHaveCreatedBackgroundJob } from '../activeMsgClient';
import type { AmsgResultContext } from '../amsgResults';
import { cloudApiCallLogId, recordCloudApiCall, settleCloudApiCall } from '../apiCallLog';
import { buildCharMemoryCredRow } from '../amsgLlmCredentials';
import {
  PLATE_CONSOLIDATE_KIND,
  type PlateJobRoom,
  buildPlateJobInput,
  buildPlateJobMessages,
  parsePlateConsolidateResult,
  plateJobKey,
} from '../amsgPlateJob';
import { ROOM_PLATES_UPDATED_EVENT, mutatePlate } from './db';
import {
  PLATE_LLM_MAX_TOKENS,
  PLATE_LLM_TEMPERATURE,
  type PlateMaterial,
  mergeCloudPlateEntries,
  remapBasedOnLabels,
} from './roomPlateCore';
import type { PlateRoom, RoomPlate } from './types';

const HEADER = '🚪 [RoomPlate:雲端]';

/** 記憶宮殿副 API 的形狀（與本地那條路的 LightLLMConfig 同構）。 */
interface PlateLightLLM {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// ─── 在飛記號（同一角色同時只許一份整理） ─────────────

/**
 * 「這個角色有一份整理正在雲端跑」的記號。
 *
 * 沒有它的話，兩次消化捱得近（手動連點、或者一輪聊得快）就會先後交兩份 job，而它們拿
 * 的是**同一份或相鄰的舊快照**：後回來那份按自己那份快照做合併，先回來那份的整理成果
 * 被整塊蓋掉，還白燒一次 API。放 localStorage 而不是內存變量，是因為提交完用戶多半就
 * 切走了，頁面重開還得認得出上一份沒回來。
 */
const PLATE_JOB_INFLIGHT_KEY = (charId: string) => `mp_plateJobInFlight_${charId}`;

/**
 * 記號最多擋這麼久。超了就當那份不會回來了（worker 掛了 / 任務被清了 / 結果丟了），
 * 放行下一次——門牌一直不更新比偶爾重疊一次嚴重得多。
 */
const PLATE_JOB_INFLIGHT_TTL_MS = 30 * 60_000;

interface PlateJobInFlight {
  jobId: string;
  /**
   * 這份整理在雲端那條任務行的 uuid。
   *
   * 記著它才有辦法**回頭找到那條任務**：刪角色時要把它取消掉（不取消的話，一條已經
   * 沒有落腳點的整理會照常燒一次副 API），排障時也要靠它把「設置裡那筆雲端生成中」
   * 跟 D1 上那一行對上號。提交答覆丟在路上時拿不到（任務可能建了、編號卻沒回來），
   * 那種只能等 TTL——所以是可選的。
   */
  uuid?: string;
  /** 提交那一刻（epoch 毫秒）。TTL 從它算起。 */
  at: number;
  /**
   * 交上去那份門牌快照是**什麼時候讀出來的**（epoch 毫秒）。
   *
   * 跟 `at` 差著一小段：讀完門牌之後還要拼身份上下文、過一遍能不能交雲端那幾道門
   * （其中一道要發請求）、把消化剛提交的候選先保底並進去，才輪到提交。這段時間裡
   * 用戶在門牌面板上改的字，LLM 是看不到的——落地時得按**讀快照那一刻**去認「這條
   * 是不是等結果期間被本地改過」，按提交時刻認就會把這一段的編輯漏掉，用戶剛敲的字
   * 被一份陳舊結果原樣蓋回去。
   */
  snapshotAt: number;
}

/**
 * 讀在飛記號的**原值**：不看 TTL，也不做任何收尾。
 *
 * 「本地記著的那個 job 編號是什麼」和「那份還算不算在飛」是兩個問題，問後者的那個函數
 * （下面的 readPlateJobInFlight）會順手清記號，拿它來問前者就會在超時之後一律得到 null。
 * 刪角色時要清雲端那份輸入、結果落地時要認「這是不是當前這一份」，問的都是前者。
 */
export const readPlateJobInFlightRaw = (charId: string): PlateJobInFlight | null => {
  try {
    const raw = localStorage.getItem(PLATE_JOB_INFLIGHT_KEY(charId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlateJobInFlight>;
    if (typeof parsed?.jobId !== 'string') return null;
    if (typeof parsed?.at !== 'number' || typeof parsed?.snapshotAt !== 'number') return null;
    return {
      jobId: parsed.jobId,
      at: parsed.at,
      snapshotAt: parsed.snapshotAt,
      ...(typeof parsed.uuid === 'string' && parsed.uuid ? { uuid: parsed.uuid } : {}),
    };
  } catch {
    return null;
  }
};

/**
 * 這個角色現在有沒有一份整理在飛；沒有、讀不出來、或者已經超時都返回 null。
 *
 * **純判斷，不動任何狀態**。超時那份的收尾（清記號、把掛著的調用記錄記成失敗）是
 * sweepExpiredPlateJob 的活兒。合在一起過：這個函數在一輪整理裡會被問到兩次（決定
 * 交不交雲端時一次、提交拋錯後判斷「是不是已經建起來了」時一次），TTL 邊界正好落在
 * 兩次之間的話，第二次問會就地把閘刪掉、把那筆記成失敗，而第一次的決定是照著相反的
 * 答案做的。「問一句」和「收個尾」是兩件事，別讓問的人替答的人做決定。
 */
export const readPlateJobInFlight = (charId: string): PlateJobInFlight | null => {
  const mark = readPlateJobInFlightRaw(charId);
  if (!mark) return null;
  return Date.now() - mark.at > PLATE_JOB_INFLIGHT_TTL_MS ? null : mark;
};

/**
 * 把超時那份就地收掉：清記號 + 把「API 調用記錄」裡那筆掛著的記成失敗。
 *
 * 不收的話它會一直寫著「雲端生成中」，直到 5 天后被裁掉——用戶看到的是一條永遠轉圈的
 * 記錄，分不清是還在跑還是早就沒了。收尾要有個明確的時機，所以放在每輪整理的最開頭
 * （plateCloudGate）跑一次，而不是搭在「還在飛嗎」那句問話的便車上。
 */
export const sweepExpiredPlateJob = (charId: string): void => {
  const mark = readPlateJobInFlightRaw(charId);
  if (!mark) return;
  if (Date.now() - mark.at <= PLATE_JOB_INFLIGHT_TTL_MS) return;
  console.warn(`${HEADER} 上一份整理超過 ${PLATE_JOB_INFLIGHT_TTL_MS / 60_000} 分鐘沒回來，當它不會來了（job ${mark.jobId}）`);
  clearPlateJobInFlight(charId);
  settleCloudApiCall({ id: cloudApiCallLogId(mark.jobId), ok: false });
};

const markPlateJobInFlight = (charId: string, jobId: string, snapshotAt: number): void => {
  try {
    localStorage.setItem(
      PLATE_JOB_INFLIGHT_KEY(charId),
      JSON.stringify({ jobId, at: Date.now(), snapshotAt } satisfies PlateJobInFlight),
    );
  } catch { /* 存不下就退回沒有閘的老行為，不值得為它中斷整理 */ }
};

/**
 * 任務建起來之後把遠端編號補進記號裡。
 *
 * 分兩步寫是因為記號必須在**發請求之前**就落下（答覆丟在路上時它是唯一的痕跡），
 * 而 uuid 要等答覆回來才知道。補不上（記號這會兒已經被別人清了）就算了：那說明這一份
 * 已經不作數，寫回去反而會把一條死記號復活。
 */
const attachPlateJobUuid = (charId: string, jobId: string, uuid: string): void => {
  const mark = readPlateJobInFlightRaw(charId);
  if (!mark || mark.jobId !== jobId) return;
  try {
    localStorage.setItem(PLATE_JOB_INFLIGHT_KEY(charId), JSON.stringify({ ...mark, uuid } satisfies PlateJobInFlight));
  } catch { /* 補不上最多是刪角色時取消不掉那條任務，等它自己跑完 */ }
};

/** 清掉在飛記號。結果落地、提交失敗、以及刪角色時都要清。 */
export const clearPlateJobInFlight = (charId: string): void => {
  try { localStorage.removeItem(PLATE_JOB_INFLIGHT_KEY(charId)); } catch { /* 清不掉最多多擋半小時 */ }
};

// ─── 提交 ─────────────────────────────────────────────

/**
 * 這一輪能不能交給雲端跑：記憶宮殿副 API 配齊了才行。
 *
 * 刻意不回落到主 API——本地那條路也不回落（記憶宮殿 App 的手動按鈕在副 API 沒配時直接
 * 報錯），拿主 API 悄悄跑一遍後台整理會把用戶的額度花在他沒同意的地方。配不齊返回 null，
 * 調用方留在本地按原來的規矩跑。
 */
export const buildPlateCredRow = (charId: string, lightLLM: PlateLightLLM | null | undefined) =>
  buildCharMemoryCredRow(charId, lightLLM);

/**
 * 這一輪拏雲端怎麼辦的三種結論。
 *
 * `local` 和 `skip` 的區別是這道門最容易搞錯的地方：**「交不出去」和「不用交」不一樣**。
 * 交不出去（沒配、worker 太老）得退回本地把活兒幹了，不然門牌永遠不更新；不用交
 * （已經有一份在雲端跑著）反而必須什麼都不做——本地再全量整理一遍既白燒一次 API，
 * 結果還會和在飛那份互相蓋。
 */
export type PlateCloudGate = 'submit' | 'local' | 'skip';

/**
 * 這一輪該不該交雲端：副 API 配齊 + 這台 worker 認識後台任務 + 沒有另一份還在飛。
 *
 * 三道門的順序是這個函數最容易改錯的地方，兩頭都有坑：
 *
 *   - **「路斷了」要排在「有一份在飛」前面**。反過來的話，一份交出去再沒回來的任務會
 *     讓接下來半小時既不走雲端、也不退回本地——用戶中途關掉主動消息 2.0、或者 worker
 *     掛了，整理就整整半小時一次都不做，而 skip 的語義本來是「雲端正在替我們幹這件事」。
 *   - **但「這次沒問到」不算路斷**。探測要發一次請求，代理切換、CF 邊緣抖一下、D1 冷
 *     啟動超時都會讓它落空；這種時候手上那份任務多半好好地在雲端跑著，退回本地就是拿
 *     同一份快照再燒一次副 API，兩份結果還先後落地互相蓋——正是這道閘要防的事。所以
 *     「問不到」時先看有沒有在飛的，有就 skip，沒有才退回本地。
 *
 * 老 bundle 會把後台任務當聊天任務跑、終態失敗，而那條任務行不在用戶的清單裡，面板一片
 * 正常門牌卻永遠不更新——「不支持」那一支就是為了別走到那兒。
 *
 * 探測那道門收在這兒一起導出，調用方就只認這一個入口——分散到兩個模塊的話，探測換名字
 * 或換語義要改兩處，漏一處就是「點了燈卻走本地」那種查不出來的靜默分流。
 */
export const plateCloudGate = async (args: {
  charId: string;
  lightLLM: PlateLightLLM | null | undefined;
}): Promise<PlateCloudGate> => {
  // 上一份躺太久的先收掉，再往下判——收尾要有個明確的時機，別搭在下面那句「還在飛嗎」
  // 的便車上（見 readPlateJobInFlight / sweepExpiredPlateJob）。
  sweepExpiredPlateJob(args.charId);

  if (!buildPlateCredRow(args.charId, args.lightLLM)) return 'local';

  const { isAmsg2GlobalReady } = await import('../amsg2ToolBridge');
  if (!await isAmsg2GlobalReady()) return 'local';

  const support = await ActiveMsgClient.probeBackgroundJobSupportDetailed();
  if (support === 'unsupported') {
    console.log(`${HEADER} 這台 Worker 的代碼還不認識後台任務，這輪在本地整理`);
    return 'local';
  }

  const inFlight = readPlateJobInFlight(args.charId);
  if (inFlight) {
    console.log(`${HEADER} 上一份整理還在雲端跑（job ${inFlight.jobId}），這輪不重複交`);
    return 'skip';
  }

  if (support === 'unknown') {
    console.log(`${HEADER} 這輪沒問到 Worker 支不支持後台任務，手上也沒有在飛的整理，先在本地跑掉`);
    return 'local';
  }
  return 'submit';
};

/**
 * 把一次整理交給雲端。
 *
 * 一律拋錯，絕不靜默降級——靜默分流那種「三個點照亮、測試照過、雲端一條日誌都沒有」
 * 的坑踩過一次就夠了。
 *
 * 但**拋錯不等於「沒交出去」**：請求發出去卻沒等到答覆時，任務可能已經在雲端建起來了。
 * 那種情況這裡把在飛記號留著，調用方據此判斷能不能退回本地跑（見 tryCloudConsolidation）。
 */
export const submitPlateConsolidation = async (args: {
  charId: string;
  charName: string;
  userName: string;
  identityContext: string;
  plates: RoomPlate[];
  materials: PlateMaterial[];
  lightLLM: PlateLightLLM | null | undefined;
  /**
   * `plates` 是**什麼時候讀出來的**（epoch 毫秒）。不是「現在幾點」——落地時要靠它認出
   * 「LLM 看不到的那些本地修改」，取晚了這段時間裡的編輯就會被陳舊結果蓋回去。
   */
  snapshotAt: number;
}): Promise<{ jobId: string; uuid: string }> => {
  const credRow = buildPlateCredRow(args.charId, args.lightLLM);
  if (!credRow) throw new Error('記憶宮殿副 API 沒配齊，門牌整理交不了雲端');

  const rooms: PlateJobRoom[] = args.plates.map((p) => ({
    room: p.room,
    entries: p.entries.map((e) => e.text),
    entryIds: p.entries.map((e) => e.id),
  }));

  const jobId = crypto.randomUUID();
  const jobInput = buildPlateJobInput({
    charId: args.charId,
    charName: args.charName,
    userName: args.userName,
    identityContext: args.identityContext,
    rooms,
    materials: args.materials,
  });

  // 記號和調用記錄都在**發請求之前**落下。事後再落的話，「請求到了服務端、答覆卻丟在
  // 路上」那一種會一點痕跡都不留：任務照跑照扣費，本地卻當它沒交出去——這一輪退回本地
  // 再全量跑一遍（同一份快照燒兩次 API、兩份結果先後落地互相蓋），而那筆燒掉的副 API
  // 調用在「設置 → API 調用記錄」裡一條都看不到，排查「誰在燒我的 Key」直接斷線。
  markPlateJobInFlight(args.charId, jobId, args.snapshotAt);

  // 這一次調用記進「設置 → API 調用記錄」：請求是雲端發的，本地的 fetch 攔截器只認
  // `/chat/completions`，夠不著它。
  // 用量補不上：結果信封裡沒有 usage（跟即時對話那條路不同，那邊雲端隨末條推送捎回來），
  // 所以落地時只把 pending 收掉，token 那兩格空著。
  recordCloudApiCall({
    id: cloudApiCallLogId(jobId),
    route: 'cloud-plate-consolidate',
    baseUrl: args.lightLLM?.baseUrl || '',
    model: args.lightLLM?.model || '',
    messages: buildPlateJobMessages(jobInput),
    meta: { appName: '記憶宮殿', purpose: '門牌整理', charId: args.charId, charName: args.charName },
  });

  let uuid: string;
  try {
    ({ uuid } = await ActiveMsgClient.scheduleBackgroundJob({
      kind: PLATE_CONSOLIDATE_KIND,
      charId: args.charId,
      charName: args.charName,
      jobKey: plateJobKey(jobId),
      jobId,
      jobInput,
      credRow,
      // 與本地那條路同一組採樣參數（葉子裡那兩個常量），別讓同一批材料在兩條路上
      // 跑出不一樣的門牌：整理是照著材料重排不是創作，溫度要壓低；四塊門牌一次全量
      // 輸出很長，輸出上限要給足，不給的話回覆會被截斷、只能靠解析容錯搶救半份。
      temperature: PLATE_LLM_TEMPERATURE,
      maxTokens: PLATE_LLM_MAX_TOKENS,
    }));
  } catch (error) {
    // 服務端答覆了「不行」= 確定沒建成，痕跡全收乾淨，下一輪照常再試。
    // 沒等到答覆的那一種不收：任務可能真在雲端跑著，記號留著擋住下一輪重複提交，
    // 調用記錄留著等結果回來收尾；真沒建成的話，30 分鐘後 readPlateJobInFlight 會
    // 就地把兩樣都收掉。
    if (!mayHaveCreatedBackgroundJob(error)) {
      clearPlateJobInFlight(args.charId);
      settleCloudApiCall({ id: cloudApiCallLogId(jobId), ok: false });
    }
    throw error;
  }

  // 遠端編號補進記號：刪角色時要靠它把這條任務取消掉。
  attachPlateJobUuid(args.charId, jobId, uuid);

  console.log(`${HEADER} 已交給雲端整理 ${rooms.length} 塊門牌（job ${jobId}，任務 ${uuid}）`);
  return { jobId, uuid };
};

// ─── 落地 ─────────────────────────────────────────────

/**
 * 一份整理結果最多還能用多久。
 *
 * 結果晚到是常態（正是為此才上雲的），所以補收那條路刻意不拿聊天那兩天的窗口去卡它。
 * 但不能真的沒有上限：服務端帳本留 28 天，換設備 / 重裝 PWA / 清過 localStorage 的用戶
 * 第一次接上帳本時會把這些老結果一次性拉回來，那時候拿一份月前的快照去改寫門牌，改的是
 * 一塊早就被後來幾十輪整理翻過好幾遍的門牌。一週足夠覆蓋「關掉筆記本過個週末」，也攔得住
 * 「一個月後重裝」。
 */
const PLATE_RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 已經落過地的 job 編號（每角色留最近幾條）。
 *
 * 同一份結果會被送到兩次以上：銷帳那一步失敗（斷網）下次上線還會拉回來，推送直達那條腿
 * 收下之後壓根不銷帳、補收時又來一遍。落地本身不是冪等的——`mergePlateEntries` 對每條
 * 保留下來的條目 `sourceCount + 1`，那個數字就是門牌面板上的「印證 N 次」，重放一次全
 * 門牌集體虛增一次，版本號也白跳一格。所以認編號，見過的直接銷帳走人。
 */
const PLATE_JOB_DONE_KEY = (charId: string) => `mp_plateJobDone_${charId}`;
/** 留幾條。夠蓋住「一條結果反覆重放」和「幾份結果先後回來」，又不至於把 localStorage 撐大。 */
const PLATE_JOB_DONE_KEEP = 8;

const readDoneJobIds = (charId: string): string[] => {
  try {
    const raw = localStorage.getItem(PLATE_JOB_DONE_KEY(charId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

const markJobDone = (charId: string, jobId: string): void => {
  try {
    const next = [jobId, ...readDoneJobIds(charId).filter((id) => id !== jobId)].slice(0, PLATE_JOB_DONE_KEEP);
    localStorage.setItem(PLATE_JOB_DONE_KEY(charId), JSON.stringify(next));
  } catch { /* 記不下就退回沒有這道閘的老行為：重放會讓「印證 N 次」多加一次 */ }
};

/** 刪角色時連這本底帳一起清掉，別在 localStorage 裡留一串沒主的編號。 */
export const clearPlateJobDone = (charId: string): void => {
  try { localStorage.removeItem(PLATE_JOB_DONE_KEY(charId)); } catch { /* 清不掉只是佔幾十字節 */ }
};

/**
 * 雲端整理結果落地：重新對準標籤 → 合併（護住快照後新增的條目）→ 落庫。
 *
 * @param context 這條結果的隨身信息（`createdAt` = 它是什麼時候記進服務端帳本的）。
 *   推送直達那條腿是剛剛發生的事，不用傳。
 * @returns 這條結果能不能銷帳。落庫出錯時拋出去，由分發口記成「帳沒銷」——整理跑一次
 *   要一兩分鐘還燒一次 API，不能因為一次 IDB 抖動就丟掉。
 */
export const applyPlateConsolidateResult = async (
  payload: unknown,
  context?: AmsgResultContext,
): Promise<boolean> => {
  const result = parsePlateConsolidateResult(payload);
  if (!result) {
    console.warn(`${HEADER} 結果形狀認不出來，丟棄`, payload);
    return true;
  }

  const { charId, items } = result;

  // 先讀原值再動它：這枚記號既是「這份結果對應哪一次提交」的憑據，也帶著快照時刻
  // （下面合併時要靠它認出「快照之後被本地改過」的條目）。
  const inFlight = readPlateJobInFlightRaw(charId);
  const isCurrentJob = inFlight?.jobId === result.jobId;
  if (!isCurrentJob && inFlight) {
    console.warn(`${HEADER} 這份結果（job ${result.jobId}）不是當前在飛那一份（job ${inFlight.jobId}），照常落地但不動閘`);
  }

  /**
   * 閘放開。**只清自己那一份**：編號對不上還照清的話，一條遲到的（上一份超時之後才姍姍
   * 來遲）或者被重放的（銷帳失敗，下次上線又拉回來一遍）結果，會把另一份**真正還在跑**
   * 的任務的閘打開——下一輪又交一份上去，兩份帶著各自的舊快照先後落地互相蓋。
   */
  const releaseGate = () => { if (isCurrentJob) clearPlateJobInFlight(charId); };

  /**
   * 這一筆雲端調用的結論。**只在落庫真的走完之後才收**，而且只收一次。
   *
   * 收早了兩頭都會說謊：這份結果被丟掉（太舊、內容空）時那筆已經寫著 ok，而它其實白燒
   * 了；落庫中途炸掉時那筆也寫著 ok，可一條門牌都沒寫進去，而結果還會被重放、重放時又
   * 收一遍。所以三條出口各說各的實話，落庫失敗那條幹脆不收——帳沒銷，下次上線重放，
   * 那時候再照實收。
   */
  const settle = (ok: boolean) => settleCloudApiCall({ id: cloudApiCallLogId(result.jobId), ok });

  // 這份已經落過地了（銷帳失敗被重放、或者推送和補收兩條腿各送了一遍）。再合併一次的
  // 代價不是「白做一遍」而是**門牌被改壞**：合併對每條保留下來的條目 sourceCount + 1，
  // 門牌面板上的「印證 N 次」會跟著重放次數一路虛增。銷帳走人。
  if (readDoneJobIds(charId).includes(result.jobId)) {
    console.log(`${HEADER} 這份結果（job ${result.jobId}）之前已經落過地了，直接銷帳`);
    releaseGate();
    return true;
  }

  const age = typeof context?.createdAt === 'number' && context.createdAt > 0
    ? Date.now() - context.createdAt
    : 0;
  if (age > PLATE_RESULT_MAX_AGE_MS) {
    console.warn(`${HEADER} 這份結果已經躺了 ${Math.round(age / 86_400_000)} 天，門牌早翻過好幾輪了，丟棄（job ${result.jobId}）`);
    settle(false);
    releaseGate();
    return true;
  }

  if (items.length === 0) {
    // worker 那邊解析不出條目時壓根不會送結果，走到這裡說明形狀對但內容空。
    // 空列表當「LLM 決定清空」處理會把整塊門牌抹掉，寧可不動。
    console.warn(`${HEADER} 結果裡沒有條目，門牌保持不動（job ${result.jobId}）`);
    settle(false);
    releaseGate();
    return true;
  }

  // 角色還在不在。刪角色時清的是雲端那份**輸入**，可這份結果說明 LLM 早就跑完了——
  // 輸入那時候已經被 worker 自己刪掉，清了個寂寞。這裡不攔的話，下次上線補收會拿它
  // 給一個已經不存在的角色**重新建出四塊門牌**（loadOrCreatePlate 沒有就現造），
  // 裡面裝著那個角色蒸餾出來的全部認知，而刪除確認框跟用戶說的是「記憶將被清空」。
  try {
    const { DB } = await import('../db');
    const chars = await DB.getAllCharacters();
    if (!chars.some((c) => c.id === charId)) {
      console.warn(`${HEADER} 這份結果的角色已經被刪掉了，丟棄（job ${result.jobId}）`);
      settle(false);
      releaseGate();
      clearPlateJobDone(charId);
      return true;
    }
  } catch (error) {
    // 角色庫讀不出來（IDB 抖了一下）：不結論也不落地，帳留著下次再來。寧可晚幾分鐘，
    // 也別在「不知道角色還在不在」的時候往庫裡寫四塊門牌。
    console.warn(`${HEADER} 查不到角色還在不在，這份結果留著下次再落（job ${result.jobId}）`, error);
    return false;
  }

  const now = Date.now();
  const updated: PlateRoom[] = [];
  // 快照時刻：認得出它才知道哪些條目是「等結果這幾分鐘裡用戶自己改過的」，那批的文本
  // 以本地為準。編號對不上、或者記號早被 TTL 收走時問不到，傳 0 讓合併那側按
  // 「誰都可能被改過」保守處理（見 mergeCloudPlateEntries）。
  const snapshotAt = isCurrentJob ? (inFlight?.snapshotAt ?? 0) : 0;

  // 逐塊串行：併發跑會同時開好幾個 IDB 事務，連接一擠爆，推送收件那邊就會跟著超時。
  // 走 mutatePlate 而不是自己「讀一份 → 改 → 存回去」：同一塊門牌上還有別的路在寫
  // （門牌面板的手改、本地整理、送達保證兜底），各寫各的就是互相整塊蓋掉。
  for (const { room, entryIds } of result.rooms) {
    const roomItems = items.filter((i) => i.room === room);
    // 一個條目都沒提到的房間跳過保存——區分「LLM 決定清空」和「LLM 忘了這個房間 /
    // 輸出被截斷」，寧可保守不動，等下輪消化再整理。與本地那條路同一個規矩。
    if (roomItems.length === 0) continue;

    // 對齊之後一條不剩 = 這個房間的結果整份都是「保留幾條已經被刪掉的條目」。同樣按
    // 「寧可保守不動」處理：拿空列表往下走會被合併語義當成「LLM 決定清空」，把這塊門牌
    // 連同提交之後新增的條目一起抹掉。變換要保持是純的，所以只在裡面做個標記，
    // 日誌出來之後再打。
    let allDeleted = false;
    const saved = await mutatePlate(charId, room, (plate) => {
      const aligned = remapBasedOnLabels(room, roomItems, entryIds, plate.entries);
      if (aligned.length === 0) {
        allDeleted = true;
        return null;
      }
      return {
        ...plate,
        entries: mergeCloudPlateEntries(room, plate.entries, aligned, entryIds, now, snapshotAt),
        updatedAt: now,
        version: plate.version + 1,
      };
    });
    if (allDeleted) {
      console.warn(`${HEADER} 「${room}」這份結果保留的條目在提交之後都已被刪掉，門牌保持不動`);
      continue;
    }
    if (!saved) continue;
    updated.push(room);
    console.log(`${HEADER} 「${room}」v${saved.version}：${saved.entries.length} 條`);
  }

  // 記「這份落過地了」和放閘都留到**落庫全部走完**。提前做的話，中途某一塊存不進去
  // （IDB 配額、事務被中斷）這份結果不銷帳、下次上線還會重放：閘已經開著，期間的消化
  // 又交了一份新的上去，兩份帶著不同的舊快照先後落地互相蓋；而重放那次會被冪等閘擋在
  // 門外，剩下的房間就再也補不上了。
  markJobDone(charId, result.jobId);
  settle(true);
  releaseGate();

  if (updated.length > 0) {
    window.dispatchEvent(new CustomEvent(ROOM_PLATES_UPDATED_EVENT, { detail: { charId, rooms: updated } }));
  }
  return true;
};
