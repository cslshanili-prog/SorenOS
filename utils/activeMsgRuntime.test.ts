import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  AMSG2_TASKS_ADOPTED_EVENT,
  EXPIRE_DECISION_TTL_MS,
  INBOX_FRESH_DELIVERY_WINDOW_MS,
  MAX_INBOX_ORDER_HOLDS,
  MAX_INBOX_PROCESS_ATTEMPTS,
  OrphanedCharacterError,
  PUSH_SUBSCRIPTION_CHANGED_KV_ID,
  buildSelfLogEntryId,
  catchUpMissedPushes,
  catchUpMissedPushesManually,
  resetOutboxCatchUpThrottleForTesting,
  findInboxArtifacts,
  findMissingChunkIndexes,
  findPersistedChunkIndexes,
  flushInboxToChat,
  handlePageBecameVisible,
  isFreshInboxDelivery,
  notePageBecameVisible,
  wasDeliveredWhileAway,
  purgeInboxArtifacts,
  refreshPushSubscriptionIfMarked,
  resolveBackfillTimestamp,
  resolveFireExpireDecision,
  resolveInboxFailureAction,
  resolveInboxPersistTimestamp,
  resolveInboxRetryDelay,
  revokeSwallowedSelfLogEntry,
  runInstantChatStatusCheck,
  cancelLateEmotionPoll,
  describeMultipartFailure,
  handleInstantErrorPushMessage,
  startLateEmotionPoll,
  sweepLocalInbox,
  shouldRenderInstantly,
  isOutboxBackfill,
} from './activeMsgRuntime';
import { MULTIPART_FAILURE_REASON } from '@rei-standard/amsg-shared';
import * as Analytics from './analytics';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  AMSG_OUTBOX_ADOPTED_LS_KEY,
  INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS,
  getInstantChatPending,
  getStagedInstantChatExpiredNotices,
  listInstantChatPendings,
  setInstantChatPending,
  stageInstantChatExpiredNotices,
} from './amsgInstantChat';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { AMSG_SELF_LOG_KEY, amsgStateNamespace } from './amsgFirePack';
import { CHAT_GEN_EVENTS } from './chatGenEvents';
import { DB } from './db';
import { readAllInstantTraces } from './instantTraceLog';

// resolveFireExpireDecision 是從「防穿幫閘·客戶端兜底」吞沒閘抽出來的 get-or-compute
// helper（帶 TTL 清掃），單測把閘的關鍵不變量釘住，防迴歸：
//   1. 一次 fire 的多分段 push 共用同一個決定（evaluate 只跑一次，絕不吞一半）；
//   2. TTL 過後同 fireKey 才允許重新判定（遲到分段仍復用同一決定）。
// 用注入的臨時 Map 做隔離，不碰模塊級 expireDecisionByFire，也不需要 DB / 瀏覽器。

describe('resolveFireExpireDecision', () => {
  it('一次 fire 的多分段 push（到達順序 3 → 1 → 2）複用同一個決定，evaluate 只跑一次', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;
    const occ = 1_700_000_000_000;
    const taskIdentity = 'task-A';
    // fireKey 不含 messageIndex：三段 push（messageIndex 3/1/2）解析到同一個 key。
    const fireKey = `${taskIdentity}:${occ}`;

    let calls = 0;
    const evaluate = async () => { calls++; return true; };

    // 按 3 → 1 → 2 的到達順序處理三段
    const decisions: boolean[] = [];
    for (const messageIndex of [3, 1, 2]) {
      void messageIndex; // 段序不進 key，僅表意
      decisions.push(await resolveFireExpireDecision(cache, fireKey, T0, evaluate));
    }

    expect(calls).toBe(1);                       // 只判一次
    expect(decisions).toEqual([true, true, true]); // 三段同吞
  });

  it('TTL 內複用緩存不重判，TTL 過後同 fireKey 重新判定（並刷新決定）', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;
    const fireKey = 'task-B:1700000000000';

    let calls = 0;
    let decision = false;
    const evaluate = async () => { calls++; return decision; };

    // 首判：false
    const first = await resolveFireExpireDecision(cache, fireKey, T0, evaluate);
    expect(first).toBe(false);
    expect(calls).toBe(1);

    // TTL 尚未到期：即便底層判定已改變，也命中緩存、不重判
    decision = true;
    const within = await resolveFireExpireDecision(cache, fireKey, T0 + EXPIRE_DECISION_TTL_MS - 1, evaluate);
    expect(within).toBe(false);
    expect(calls).toBe(1);

    // TTL 過後：清掃掉舊條目，重新判定，拿到新決定
    const after = await resolveFireExpireDecision(cache, fireKey, T0 + EXPIRE_DECISION_TTL_MS + 1, evaluate);
    expect(after).toBe(true);
    expect(calls).toBe(2);
  });

  // 迴歸守衛：判不出來的時候絕不能把「判不了」當成「可以發」緩存下來。
  // evaluate 拋錯時不寫緩存，下次才是真的重判——否則一次讀取失敗會讓這次 fire 的
  // 後續分段全部沿用一個憑空捏造的結論。
  it('evaluate 拋錯 → 不緩存，下次重判', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;

    let calls = 0;
    const evaluate = async () => {
      calls++;
      if (calls === 1) throw new Error('IndexedDB read failed');
      return true;
    };

    await expect(resolveFireExpireDecision(cache, 'task-D:333', T0, evaluate)).rejects.toThrow();
    expect(cache.size).toBe(0);

    const second = await resolveFireExpireDecision(cache, 'task-D:333', T0, evaluate);
    expect(calls).toBe(2);
    expect(second).toBe(true);
  });

  it('同任務不同 occurrence 用不同 fireKey，各判各的（不串判定）', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;

    let calls = 0;
    const evaluate = async () => { calls++; return calls === 1; }; // 第一次 true，第二次 false

    const d1 = await resolveFireExpireDecision(cache, 'task-C:111', T0, evaluate);
    const d2 = await resolveFireExpireDecision(cache, 'task-C:222', T0, evaluate);

    expect(calls).toBe(2);      // 兩個 occurrence 各判一次
    expect(d1).toBe(true);
    expect(d2).toBe(false);
  });
});

// 迴歸守衛：push 處理失敗時的去向。
// 過去一律就地存原稿——原稿裡的表情 / 卡片 / 轉帳都還是標記形態，渲染時被剝掉，
// 用戶看到殘缺版，而角色下一輪讀歷史會當成「我已經發過了」：一次暫時的本地故障
// 就此變成永久的錯誤前提。現在默認留著重試，重試到頭才退回存原稿。
describe('resolveInboxFailureAction', () => {
  it('角色已不存在 → 孤兒，不重試（重試多少次都沒用，該去清遠端任務）', () => {
    const err = new OrphanedCharacterError('char-gone');
    expect(resolveInboxFailureAction(err, 1)).toBe('orphan');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 5)).toBe('orphan');
  });

  it('普通失敗且沒到上限 → 重試，不把殘缺版固化進聊天記錄', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, 1)).toBe('retry');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS - 1)).toBe('retry');
  });

  it('重試到上限 → 退回存原稿保底（殘缺也好過什麼都沒有）', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS)).toBe('degrade');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 1)).toBe('degrade');
  });
});

// 迴歸守衛：重試等多久。
//
// 這條路上最常見的失敗是 IndexedDB 的「將死連接」——App 切後台時系統強關連接，頁面剛
// 解凍就處理推送，正好撞在重建窗口裡，db.transaction() 同步拋 InvalidStateError
// （db.ts 的 onclose 註釋寫著這個形態：當次失敗、下一次調用就自愈）。線上埋點裡
// 「重試中」佔失敗的 96.7%，而「重試到頭退回存原稿」幾乎沒有——全是一兩次就緩過來了。
//
// 自愈是毫秒級的，等半分鐘純屬讓用戶對著「正在輸入」乾等：推送通知早就把這句話完整
// 顯示過了，聊天界面卻要過 30 秒才追上。所以第一次重試必須是秒級；真的連著失敗再拉長
// 間隔，避免存儲持續故障時空轉。
describe('resolveInboxRetryDelay（重試等多久）', () => {
  it('第一次重試是秒級——瞬態故障下一次調用就自愈，不該讓用戶乾等', () => {
    expect(resolveInboxRetryDelay(1)).toBeLessThanOrEqual(1_000);
  });

  it('連著失敗就拉長間隔，別在持續故障時空轉', () => {
    expect(resolveInboxRetryDelay(2)).toBeGreaterThan(resolveInboxRetryDelay(1));
    expect(resolveInboxRetryDelay(3)).toBeGreaterThan(resolveInboxRetryDelay(2));
  });

  it('次數超出上限也給得出延遲，不返回 undefined/NaN', () => {
    const last = resolveInboxRetryDelay(MAX_INBOX_PROCESS_ATTEMPTS + 5);
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeGreaterThan(0);
  });

  it('attempts 非法（0 / 負數 / NaN）時退到第一檔，別算出 0 或負延遲', () => {
    expect(resolveInboxRetryDelay(0)).toBe(resolveInboxRetryDelay(1));
    expect(resolveInboxRetryDelay(-3)).toBe(resolveInboxRetryDelay(1));
    expect(resolveInboxRetryDelay(Number.NaN)).toBe(resolveInboxRetryDelay(1));
  });
});

// 迴歸守衛：重試不能把已經寫進聊天記錄的氣泡再寫一遍。
//
// 後處理是逐條落庫的（十幾處 DB.saveMessage），第 3 條寫失敗時前兩條已經在庫裡了。
// 「失敗就整條重跑」最多跑 4 趟（3 次重試 + 最後存原稿保底），不先認領並清掉上一趟的
// 半成品，用戶就會看到同一段話出現三四遍——而重複進了聊天記錄是永久的。
// 認領的依據是每條氣泡都繼承的 metadata.activeMsg2.messageId（每條 push 唯一）。
describe('findInboxArtifacts', () => {
  const bubble = (id: number, messageId: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: 'assistant',
    metadata: { source: 'active_msg_2', activeMsg2: { messageId }, ...extra },
  });

  it('認出同一條 push 寫下的全部氣泡', () => {
    const found = findInboxArtifacts(
      [bubble(1, 'msg_a'), bubble(2, 'msg_a'), bubble(3, 'msg_b')],
      'msg_a',
    );
    expect(found.map((m) => m.id)).toEqual([1, 2]);
  });

  it('別的 push / 別的來源一律不動（多分段 push 每段各有各的 messageId）', () => {
    const messages = [
      bubble(1, 'msg_b'),
      { id: 2, role: 'assistant', metadata: { source: 'chat' } },
      { id: 3, role: 'assistant' },
      { id: 4, role: 'user', metadata: { activeMsg2: { messageId: 'msg_a' } } },
    ];
    expect(findInboxArtifacts(messages as any, 'msg_a')).toEqual([]);
  });

  it('一趟都沒寫成（第一條就掛了）→ 空清單，調用方據此判定副作用還得重放', () => {
    expect(findInboxArtifacts([bubble(1, 'msg_b')], 'msg_a')).toEqual([]);
  });

  it('退回存原稿那條也帶同一個 messageId，所以也認得出來（免得原稿跟殘留氣泡並排）', () => {
    const raw = { id: 9, role: 'assistant', metadata: { activeMsg2: { messageId: 'msg_a' } } };
    expect(findInboxArtifacts([raw] as any, 'msg_a')).toHaveLength(1);
  });
});

// 上面那條是純判定，這條走真庫（fake-indexeddb）釘住實際刪除行為：
// 重試前不清場的話，重跑一趟就是把同樣的氣泡再寫一遍，用戶看到重複的一段話。
describe('purgeInboxArtifacts（走真庫）', () => {
  const CHAR = 'char-purge';

  const saveBubble = (content: string, messageId: string | null, type = 'text') => DB.saveMessage({
    charId: CHAR,
    role: 'assistant',
    type,
    content,
    metadata: messageId
      ? { source: 'active_msg_2', activeMsg2: { messageId } }
      : { source: 'chat' },
  } as any);

  it('只刪這條 push 寫下的氣泡，別人的一條不動', async () => {
    await saveBubble('上一趟寫了一半 1', 'msg_a');
    await saveBubble('上一趟寫了一半 2', 'msg_a');
    await saveBubble('另一條 push 的', 'msg_b');
    await saveBubble('普通聊天回覆', null);

    const { removed, evidence } = await purgeInboxArtifacts({ charId: CHAR, messageId: 'msg_a' } as any);

    expect(removed).toBe(2);
    expect(evidence).toBe(2);
    const left = await DB.getRecentMessagesByCharId(CHAR, 200);
    expect(left.map((m) => m.content)).toEqual(['另一條 push 的', '普通聊天回覆']);
  });

  it('一條都沒寫過 → 刪 0 條，也不報錯（首次處理走的就是這條）', async () => {
    await expect(purgeInboxArtifacts({ charId: 'char-empty', messageId: 'msg_x' } as any))
      .resolves.toEqual({ removed: 0, evidence: 0 });
  });

  // 副作用產物跟正文氣泡帶著同一個 activeMsg2.messageId（chatParser 落庫時統一掛的）。
  // 一起刪掉的話：本輪又因為「認出了標記」不重放 directives，那張轉帳卡就永遠回不來了。
  // 所以「算不算憑據」和「刪不刪」必須分開——憑據照數，刪只刪渲染型氣泡。
  it('副作用產物（轉帳卡等）算憑據但不刪，只刪渲染型氣泡', async () => {
    const charId = 'char-purge-sideeffect';
    const save = (content: string, type: string) => DB.saveMessage({
      charId, role: 'assistant', type, content,
      metadata: { source: 'active_msg_2', activeMsg2: { messageId: 'msg_mixed' } },
    } as any);

    await save('半截正文', 'text');
    await save('[表情]', 'emoji');
    await save('[HTML卡片]', 'html_card');
    await save('給你轉 5 塊', 'transfer');
    await save('戳了戳你', 'interaction');
    await save('今天的熱點', 'news_card');
    await save('[音樂]', 'music_card');
    await save('日程已加', 'info');
    await save('今天的生活記錄', 'life_card');
    await save('小紅書筆記', 'xhs_card');

    const { removed, evidence } = await purgeInboxArtifacts({ charId, messageId: 'msg_mixed' } as any);

    expect(removed, '只刪 text / emoji / html_card').toBe(3);
    expect(evidence, '憑據要把副作用產物一起數上，否則重試會二次轉帳').toBe(10);
    const left = await DB.getRecentMessagesByCharId(charId, 200);
    expect(left.map((m) => m.type)).toEqual([
      'transfer', 'interaction', 'news_card', 'music_card', 'info', 'life_card', 'xhs_card',
    ]);
  });
});

// 迴歸守衛：主動消息落庫時間戳一律取 sentAt（雲端真正發出那一刻）。
//
// 氣泡在聊天流裡的位置只看自增 id（db.ts 按 charId 索引游標讀、Chat.tsx 的 displayMessages
// 不排序），跟 timestamp 無關，所以標 sentAt 不會讓消息跑到用戶正在聊的內容上面。timestamp
// 只決定氣泡上顯示的那個數字。唯一要防的是「位置在下、數字往回走」的倒掛，那個由
// resolveBackfillTimestamp 精確接管（本地真有更晚的消息才退讓）。
//
// 這裡不再按「消息夠不夠新」二選一：那個判據回答不了「用戶在不在場」——到點彈的通知，
// 用戶隔幾分鐘才點進來，消息就會被標成他點進來的那一刻。而在線送達時 sentAt 距落庫
// 只有幾秒，標 sentAt 一樣顯示「剛剛」，觀感沒有差別。
//
// 落庫時間戳還會餵給 amsg2ExpireGuard.hasDeliveredProactiveNear（判定窗
// [occurrence-90s, occurrence+30min]）：sentAt ≈ occurrence + 雲端生成耗時，穩落在窗內，
// 已送達的消息不會被誤判成沒送到而生成假作廢回執。
describe('resolveInboxPersistTimestamp（邊界值）', () => {
  const NOW = 1_700_000_000_000;

  it('剛送達（幾秒 / 一分鐘前）→ 也落 sentAt，不再改成寫庫當刻', () => {
    expect(resolveInboxPersistTimestamp(NOW - 3_000, NOW)).toBe(NOW - 3_000);
    expect(resolveInboxPersistTimestamp(NOW - 60_000, NOW)).toBe(NOW - 60_000);
    expect(resolveInboxPersistTimestamp(NOW, NOW)).toBe(NOW);
  });

  // 現場那一例：17:35 到點彈通知，17:43 才點進去，氣泡標成了 17:43。
  it('到點彈通知、隔 8 分鐘才點進來 → 落 sentAt（不是點進來的那一刻）', () => {
    const sentAt = NOW - 8 * 60_000;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('隔夜典型場景：13 小時前的 sentAt 原樣返回', () => {
    const sentAt = NOW - 13 * 3_600_000;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('sentAt 缺失 / 非法（老 push 可能不帶）→ undefined，交給寫庫當刻', () => {
    expect(resolveInboxPersistTimestamp(undefined, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(0, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(Number.NaN, NOW)).toBeUndefined();
  });

  it('sentAt 在未來（時鐘偏差）→ undefined，別把氣泡標到未來', () => {
    expect(resolveInboxPersistTimestamp(NOW + 5 * 60_000, NOW)).toBeUndefined();
  });
});

// 迴歸守衛：補收的消息跳過擬人打字延遲。
//
// 氣泡是一條條冒出來的——後處理管線每條之間夾 0.5~2 秒 setTimeout，模擬角色在打字。
// 實時收到時這是對的（角色正在你眼前說話）；但補收的消息早在幾小時前就在雲端生成完了，
// 再慢放一遍只會讓用戶乾等，而且這段時間裡用戶來得及插話，把倒掛的口子撐開
// （見 resolveBackfillTimestamp）。所以躺過窗口的消息一次性回填。
//
// 判據用 receivedAt（消息落到這台設備的時刻）而不是 sentAt：它剔除了雲端到設備之間的
// 網絡延遲，問的正是「這條在收件箱裡躺了多久沒人消費」。
describe('isFreshInboxDelivery（決定要不要慢放打字節奏）', () => {
  const NOW = 1_700_000_000_000;

  it('剛落到設備（幾秒前）→ 保留打字節奏', () => {
    expect(isFreshInboxDelivery(NOW - 3_000, NOW)).toBe(true);
    expect(isFreshInboxDelivery(NOW, NOW)).toBe(true);
  });

  it('前台連收幾條排隊處理（一分鐘前）→ 仍算剛到，用戶就在看著', () => {
    expect(isFreshInboxDelivery(NOW - 60_000, NOW)).toBe(true);
  });

  it('恰好等於窗口 → 仍算剛到（規則是「超過」才算補收）', () => {
    expect(isFreshInboxDelivery(NOW - INBOX_FRESH_DELIVERY_WINDOW_MS, NOW)).toBe(true);
  });

  it('點通知隔 8 分鐘才進來 → 算補收，一次性回填不慢放', () => {
    expect(isFreshInboxDelivery(NOW - 8 * 60_000, NOW)).toBe(false);
  });

  it('隔夜補收 → 算補收', () => {
    expect(isFreshInboxDelivery(NOW - 13 * 3_600_000, NOW)).toBe(false);
  });

  it('receivedAt 缺失 / 非法 → 當剛到處理（保守：寧可慢放，也別把實時消息秒刷出來）', () => {
    expect(isFreshInboxDelivery(undefined, NOW)).toBe(true);
    expect(isFreshInboxDelivery(0, NOW)).toBe(true);
    expect(isFreshInboxDelivery(Number.NaN, NOW)).toBe(true);
  });

  it('窗口要明顯短於用戶「看到通知再點進來」的典型間隔，否則補收照樣慢放', () => {
    expect(INBOX_FRESH_DELIVERY_WINDOW_MS).toBeLessThanOrEqual(2 * 60_000);
  });
});

// 慢放的第二個判據：消息落到設備時，用戶在不在看這個頁面。
//
// 「夠不夠新」只回答了「這句話是不是剛生成的」，回答不了「用戶讀沒讀過」。推送到達時
// 頁面在後台，系統通知就已經把整句話完整顯示過了——用戶再點進來，看到的是一句他剛讀完
// 的話被一個字一個字重演一遍。慢放的意義是「角色正在你眼前打字」，人不在場時它只剩等待。
//
// 反過來，用戶本來就開著聊天界面時收到的消息要保留慢放：那才是它想要的場景。
/**
 * 這一組守的是線上那條「補收回來的消息還在一條條演打字」。
 *
 * 補收在寫庫時會把整批消息的到達時間統一改寫成「現在」，於是原來那兩條判據（是不是剛
 * 到的、送達時人在不在場）問的全是同一個已經被改壞的值，雙雙得出「剛到、用戶在場」，
 * 補收就把自己偽裝成了實時消息。判據必須認補收路徑自己蓋的標記。
 */
describe('shouldRenderInstantly（這條要不要跳過打字慢放）', () => {
  const NOW = 1_700_000_000_000;

  it('補收回來的：哪怕到達時間被改成現在、用戶也算在場，照樣一次性回填', () => {
    const rewritten = NOW;               // 被補收改寫過的到達時間
    const visibleSince = NOW - 60_000;   // 用戶一分鐘前就在前台 → 會被判成「在場」

    // 先釘死「另外兩條判據在這個場景下確實指望不上」——它們倆都投了「保留慢放」：
    expect(isFreshInboxDelivery(rewritten, NOW)).toBe(true);
    expect(wasDeliveredWhileAway(rewritten, visibleSince)).toBe(false);

    // 認標記就不會被騙。
    expect(shouldRenderInstantly({ amsgOutboxBackfill: true }, rewritten, NOW, visibleSince)).toBe(true);
  });

  it('SW 直送、用戶就在前台看著的：保留打字節奏', () => {
    expect(shouldRenderInstantly({ sessionId: 'sess-1' }, NOW - 3_000, NOW, NOW - 60_000)).toBe(false);
  });

  it('在收件箱裡躺了十分鐘才被撈出來的：一次性回填', () => {
    expect(shouldRenderInstantly(undefined, NOW - 10 * 60_000, NOW, NOW - 60_000)).toBe(true);
  });

  it('送達時人不在場（系統通知已經念過一遍）：一次性回填', () => {
    expect(shouldRenderInstantly(undefined, NOW - 3_000, NOW, NOW - 1_000)).toBe(true);
  });

  it('補收標記只認真的 true，SW 直送那份不帶這個鍵', () => {
    expect(isOutboxBackfill({ amsgOutboxBackfill: true })).toBe(true);
    expect(isOutboxBackfill({ sessionId: 'sess-1' })).toBe(false);
    expect(isOutboxBackfill(undefined)).toBe(false);
  });
});

/**
 * 這一組守的是線上那條「消息早就在手機裡了，頁面卻白等幾十秒」。
 *
 * iOS 上 App 不在最前台時，Service Worker 拿到的「當前有哪些頁面」名單是空的，存完消息
 * 喊了也沒人聽見（實測一輪 8 條推送 8 次全空）。所以頁面不能等人喊，得自己隔幾秒數一眼
 * 收件箱——但這趟巡查幾秒就跑一次，空表時必須什麼都不做，否則光是空轉的記錄就能把排障
 * 要看的東西全頂出緩衝區。
 */
describe('本地收件箱守望', () => {
  it('庫裡沒貨：不動收件箱，也不留下衝刷記錄', async () => {
    await ActiveMsgStore.consumeInboxMessages();  // 先清乾淨
    const before = readAllInstantTraces().length;
    const consume = vi.spyOn(ActiveMsgStore, 'consumeInboxMessages');

    await sweepLocalInbox();

    expect(consume, '空表就該在數完個數之後收手').not.toHaveBeenCalled();
    expect(readAllInstantTraces().length, '空轉不許寫進 trace 緩衝').toBe(before);
    consume.mockRestore();
  });

  it('庫裡有貨：自己就接著沖刷，不用等任何人來喊', async () => {
    await ActiveMsgStore.consumeInboxMessages();
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-sweep-1',
      charId: 'char-sweep',
      charName: '小明',
      body: '在嗎',
      messageType: 'text',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId: 'char-sweep' },
    } as any);
    // 取空這一步換成空實現：這條守的是「數出有貨就往下走」，沖刷內部怎麼處理有它自己
    // 的用例，不該在這裡連帶跑一遍真管線（還會往後面的用例裡漏重試定時器）。
    const consume = vi.spyOn(ActiveMsgStore, 'consumeInboxMessages').mockResolvedValue([]);
    try {
      await sweepLocalInbox();
      expect(consume, '數出有貨就該接著沖刷').toHaveBeenCalled();
    } finally {
      consume.mockRestore();
      await ActiveMsgStore.consumeInboxMessages();  // 別把這條留給後面的用例
    }
  });

  it('頁面不可見時連數都不數（後台數了也做不了什麼）', async () => {
    const hadDocument = 'document' in globalThis;
    (globalThis as any).document = { visibilityState: 'hidden' };
    const count = vi.spyOn(ActiveMsgStore, 'countInboxMessages');
    try {
      await sweepLocalInbox();
      expect(count).not.toHaveBeenCalled();
    } finally {
      if (!hadDocument) delete (globalThis as any).document;
      count.mockRestore();
    }
  });
});

describe('wasDeliveredWhileAway（送達時用戶在不在場）', () => {
  const NOW = 1_700_000_000_000;

  it('頁面回到前台之前就送到了 → 用戶是從通知知道的，跳過慢放', () => {
    expect(wasDeliveredWhileAway(NOW - 30_000, NOW)).toBe(true);
  });

  it('App 在前台時送到 → 保留慢放，角色在他眼前說話', () => {
    expect(wasDeliveredWhileAway(NOW + 5_000, NOW)).toBe(false);
  });

  it('恰好在回到前台那一刻送到 → 算在場（規則是「早於」才算缺席）', () => {
    expect(wasDeliveredWhileAway(NOW, NOW)).toBe(false);
  });

  it('receivedAt 缺失 / 非法 → 當作用戶在場，寧可慢放也別誤傷實時消息', () => {
    expect(wasDeliveredWhileAway(undefined, NOW)).toBe(false);
    expect(wasDeliveredWhileAway(0, NOW)).toBe(false);
    expect(wasDeliveredWhileAway(Number.NaN, NOW)).toBe(false);
  });

  it('還沒記錄過「回到前台」的時刻 → 不把所有消息都判成缺席', () => {
    expect(wasDeliveredWhileAway(NOW - 30_000, 0)).toBe(false);
  });
});

// 接線守衛：回到前台時，「記下時刻」必須排在「去 flush」之前。
//
// 順序反了的話，後台期間攢下的那條消息在 flush 那一刻還查不到回到前台的時刻，會被判成
// 「用戶在場」照常慢放——而它恰恰是最該跳過的一條（用戶就是看著通知點進來的）。
// 這種錯法不會有任何報錯，消息照常出現，只是又慢了一遍。
describe('handlePageBecameVisible（回到前台的入口）', () => {
  afterEach(() => { notePageBecameVisible(0); });

  it('先記下回到前台的時刻，之前送達的消息據此判為「用戶不在場」', () => {
    notePageBecameVisible(0);
    const earlier = Date.now() - 5_000;
    expect(wasDeliveredWhileAway(earlier), '前置條件：還沒回過前台時不該判缺席').toBe(false);

    handlePageBecameVisible();

    expect(wasDeliveredWhileAway(earlier), '回到前台後，更早送達的那條算缺席送達').toBe(true);
  });
});

// 端到端（走真庫 + 真 flush）：釘住主路徑（post-processing 逐條落庫）和降級存原稿路徑
// 用的是同一個口徑——離線補收落 sentAt，在線送達落寫庫當刻。修復前主路徑永遠落寫庫當刻
// （離線補收用例掛）、降級路徑永遠落 sentAt（在線送達用例掛），兩套口徑各錯一半。
describe('flushInboxToChat 落庫時間戳（走真庫）', () => {
  beforeAll(async () => {
    // flush 尾部會 dispatch 'active-msg-received' 等事件；node 測試環境沒有 window，
    // 給個最小 stub（事件本身不在本組斷言範圍內）。
    (globalThis as any).window ??= { dispatchEvent: () => true };
    // 主路徑要查得到角色才不會走孤兒分支。
    await DB.saveCharacter({ id: 'char-ts-main', name: '守夜角色' } as any);
  });

  const inboxMsg = (over: Record<string, unknown>) => ({
    charId: 'char-ts-main',
    charName: '守夜角色',
    body: '還沒睡嗎，早點休息',
    receivedAt: Date.now(),
    ...over,
  }) as any;

  const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');

  it('主路徑·離線補收：sentAt 超過閾值 → 每條氣泡都落 sentAt', async () => {
    const sentAt = Date.now() - 13 * 3_600_000; // 昨晚推的，今天中午才打開
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-stale',
      messageType: 'text', // ASSISTANT_TEXT_TYPES 白名單內 → 走 post-processing 主路徑
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs('char-ts-main');
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBe(sentAt);
  }, 20000);

  // 循環判定讀的是 push 頂層的 recurrenceType（庫蓋上去的，用戶排的和角色自排的走同
  // 一份）。任務 metadata 裡那份是排程方自己抄的，角色在 fire 裡自排那條路徑壓根不會
  // 抄——照著 metadata 判的話，每日提醒只要用戶開過一次口就會被永遠吞掉，而 worker 那邊
  // 照常生成、照常推、照常記「我說過這句」。幾天後角色會說「我連著叫你三天你都不理我」。
  it('角色自排的 daily 任務不被當成一次性吞掉（頂層 recurrenceType 說了算）', async () => {
    const charId = 'char-selfsched-daily';
    await DB.saveCharacter({ id: charId, name: '每日提醒角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3 * 3_600_000;   // 排程那一刻的錨點：三小時前
    // 用戶在錨點之後開過口，但離本次觸發還有兩小時——一次性任務的判據（錨點之後有新
    // 消息就作廢）會中招，循環任務的窗口（觸發時刻前 10 分鐘起算）夠不著它。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '在嗎',
      timestamp: occurrenceMs - 2 * 3_600_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-selfsched-daily',
      charId,
      charName: '每日提醒角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',   // push 頂層，庫蓋的
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-selfsched',
        // 角色自排那條路徑不往 metadata 抄 recurrence，這裡刻意留空。
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length, '循環任務不該被防穿幫閘吞掉').toBeGreaterThan(0);
  }, 20000);

  // 記帳要排在防穿幫閘之前。排在後面的話，被吞掉的那條 push 會把任務認領一起帶走：
  // 任務照常到點觸發，面板卻列不出來、用戶取消不掉，訂閱登記和憑據刷新也都夠不著它。
  it('消息被防穿幫閘吞掉，角色自排的任務照樣認領下來', async () => {
    const charId = 'char-adopt-before-gate';
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [] },
    } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3_600_000;
    // 到點前一分鐘用戶還在說話 → 循環任務的「正在熱聊」窗口命中，這條 push 會被吞。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '我在忙',
      timestamp: occurrenceMs - 60_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-adopt-before-gate',
      charId,
      charName: '自排角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-adopt',
        amsgSelfScheduled: [{
          taskUuid: 'amsgself-adopt-1',
          clientTaskId: 'client-task-adopt-next',
          mode: 'auto',
          firstSendTime: new Date(occurrenceMs + 90 * 60_000).toISOString(),
          recurrenceType: 'none',
          expirePolicy: 'expire',
          source: 'character',
          status: 'scheduled',
          createdAt: occurrenceMs,
        }],
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '這條消息該被閘吞掉').toHaveLength(0);
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    expect(
      char?.activeMsg2Config?.tasks?.map((t: any) => t.taskUuid),
      '被吞的是這次要說的話，不是這條任務',
    ).toContain('amsgself-adopt-1');
  }, 20000);

  // 防穿幫閘的三種去向必須各留各的痕。吞掉是這條鏈路上唯一「用戶什麼都看不到」的出口
  // （不進聊天流、不彈提示、還去雲端帳本銷了帳），線上出過一次真實事故：通知彈出來了、
  // 點進去沒有，而客戶端、worker、雲端帳本三處加起來都說不出發生過什麼。
  // 這兩條釘的就是「判定輸入必須原樣留在 trace 裡」——不留的話下次照樣只能靠猜。
  it('被閘吞掉時，判定輸入原樣進 trace（吞是靜默的，只剩這一行說得出為什麼）', async () => {
    localStorage.removeItem('instant_push_trace_log_v1');
    const charId = 'char-gate-trace-swallow';
    await DB.saveCharacter({ id: charId, name: '留痕角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3_600_000;
    const lastUserAt = occurrenceMs - 60_000;   // 到點前一分鐘還在聊 → 循環任務判作廢
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '我在忙', timestamp: lastUserAt,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-gate-trace-swallow',
      charId,
      charName: '留痕角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-trace-swallow',
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '前提：這條該被吞').toHaveLength(0);
    const decision = readAllInstantTraces()
      .find((e) => e.event === 'runtime-expire-decision-swallow');
    expect(decision, '吞掉必須留一條判定 trace').toBeTruthy();
    // 這幾個字段是「為什麼吞」的全部依據，少一個就還得靠猜。
    expect(decision).toMatchObject({
      charId,
      policy: 'expire',
      recurrenceType: 'daily',
      lastUserMessageAt: lastUserAt,
      occurrenceMs,
    });
  }, 20000);

  // 線上真實事故的最小復現：角色半夜說「明早九點半叫你起床」，用戶回一句「晚安」，
  // 七小時後那條早安到了設備上卻被這一層判成「對話已經前進了」整條吞掉——不進聊天流、
  // 不彈提示、還去雲端帳本銷了帳，而通知早就彈到鎖屏上了。用戶看到的是「通知說角色
  // 發了消息，點進去什麼都沒有」，消息再也補不回來。
  // 錨點規則沒有時間窗，跨夜任務幾乎必然中招（說完「明早叫你」，用戶基本一定會再回
  // 一句），所以客戶端這一層不再跑它。這條測試就是那道閘別被順手加回來的守衛。
  it('跨夜的一次性任務不再被吞：說完「明早叫你」之後用戶回過話，早安照樣送達', async () => {
    const charId = 'char-overnight-oneshot';
    await DB.saveCharacter({ id: charId, name: '叫早角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 8 * 3_600_000;        // 八小時前排的任務
    await DB.saveMessage({                                 // 排完之後用戶回了句「晚安」
      charId, role: 'user', type: 'text', content: '好，晚安',
      timestamp: anchorMs + 60_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-overnight-oneshot',
      charId,
      charName: '叫早角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'none',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-overnight',
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '跨夜的早安不該被錨點規則吞掉').toHaveLength(1);
  }, 20000);

  it('閘放行時也留一條 trace（否則「判了沒吞」和「閘根本沒跑」長得一模一樣）', async () => {
    localStorage.removeItem('instant_push_trace_log_v1');
    const charId = 'char-gate-trace-pass';
    await DB.saveCharacter({ id: charId, name: '放行角色' } as any);

    const occurrenceMs = Date.now();
    // 用戶最後一次開口在錨點之前 → 一次性任務照發。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '晚安', timestamp: occurrenceMs - 7_200_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-gate-trace-pass',
      charId,
      charName: '放行角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'none',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-trace-pass',
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '前提：這條該放行').toHaveLength(1);
    expect(
      readAllInstantTraces().some((e) => e.event === 'runtime-expire-decision-pass'),
      '放行也要留痕',
    ).toBe(true);
  }, 20000);

  /**
   * 這條守的是「排障能力本身」。收件箱裡的消息有七八條路能撈出來，其中只有 SW 實時喊
   * 頁面那條是快的，其餘（輪詢、回前台、補收）都帶著幾秒到一分鐘的固有延遲。線上出過
   * 一次實時通道整個斷掉、消息全靠 60 秒輪詢兜底的故障——功能表面正常，只是每條都白等，
   * 而當時的記錄裡沒有觸發源，只能靠算時間差反推。所以這個字段必須一直在。
   */
  it('每趟沖刷都要記下是誰觸發的，否則查不出實時通道斷沒斷', async () => {
    const charId = 'char-flush-trigger';
    await DB.saveCharacter({ id: charId, name: '觸發源角色' } as any);
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-flush-trigger',
      charId,
      messageType: 'text',
      sentAt: Date.now(),
    }));

    await flushInboxToChat('輪詢補收');

    const flushStarts = readAllInstantTraces().filter((e) => e.event === 'runtime-flush-start');
    expect(flushStarts.length, '前提：這趟沖刷要留痕').toBeGreaterThan(0);
    expect(
      flushStarts.some((e) => e.trigger === '輪詢補收'),
      '沖刷記錄裡必須帶上觸發源',
    ).toBe(true);
  }, 20000);

  it('主路徑·剛送達：一樣落 sentAt（本地沒有更晚的消息，不需要退讓）', async () => {
    const charId = 'char-ts-main-fresh';
    await DB.saveCharacter({ id: charId, name: '在線角色' } as any);
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-fresh',
      charId,
      messageType: 'text',
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBe(sentAt);
  }, 20000);

  // 到點彈通知、用戶隔幾分鐘才點進來 —— 這一例的舊行為是把氣泡標成點進來的那一刻。
  it('主路徑·點通知隔 8 分鐘進來：落 sentAt，不是點進來的那一刻', async () => {
    const charId = 'char-ts-main-notif';
    await DB.saveCharacter({ id: charId, name: '定時角色' } as any);
    const sentAt = Date.now() - 8 * 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-notif',
      charId,
      messageType: 'text',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.timestamp).toBe(sentAt);
      expect(m.timestamp, '別再標成點進來的那一刻').toBeLessThan(before);
    }
  }, 20000);

  // 倒掛守衛仍然在崗：用戶先說了話，補收的消息就不能標成比它更早。
  it('主路徑·補收時本地已有更晚的消息 → 退回寫庫當刻，時間戳不倒掛', async () => {
    const charId = 'char-ts-main-backfill';
    await DB.saveCharacter({ id: charId, name: '倒掛守衛角色' } as any);
    const sentAt = Date.now() - 13 * 3_600_000;   // 昨晚推的
    // 用戶今天打開 App 先說了一句，落庫時刻比 sentAt 晚得多。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '早',
      timestamp: Date.now() - 5_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-backfill',
      charId,
      messageType: 'text',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBeGreaterThanOrEqual(before);
  }, 20000);

  it('降級存原稿路徑·離線補收：與主路徑同口徑，落 sentAt', async () => {
    const charId = 'char-ts-raw-stale';
    const sentAt = Date.now() - 13 * 3_600_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-stale',
      charId,
      messageType: 'forum', // 白名單外 → 不走 post-processing，直接原稿落庫
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('還沒睡嗎，早點休息');
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);

  // 接線守衛：判據（isFreshInboxDelivery）算出來的結論要真的傳到後處理管線去。
  //
  // 閾值錨在真實常量上，不是拍腦袋的容差：擬人打字延遲每條氣泡至少 500ms
  // （applyAssistantPostProcessing 的 `Math.max(chunk.length * 50, 500)`），所以
  // 「跑沒跑那個 setTimeout」在耗時上是 500ms 起 vs 幾十毫秒的落庫開銷，中間隔著
  // 一整個數量級。取 400ms 當界：慢機器把落庫拖慢幾倍也夠不著，而慢放路徑必然超過。
  // （別改成「補收比實時快」這種相對比較——接線被刪掉時兩邊都慢放、耗時相當，
  //   誰快誰慢就由噪聲決定，測試會時過時掛。）
  it('補收的消息跳過擬人打字延遲，實時收到的照舊慢放', async () => {
    const runFlush = async (charId: string, receivedAt: number) => {
      await DB.saveCharacter({ id: charId, name: '打字節奏角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: `msg-pace-${charId}`,
        charId,
        messageType: 'text',
        sentAt: receivedAt,
        receivedAt,
      }));
      const t0 = Date.now();
      await flushInboxToChat('SW通知');
      return Date.now() - t0;
    };

    const freshMs = await runFlush('char-pace-fresh', Date.now());
    const staleMs = await runFlush('char-pace-stale', Date.now() - 8 * 60_000);

    // 實時那條確實慢放了，否則下面那條斷言就成了空氣
    expect(freshMs, '實時送達該保留打字節奏').toBeGreaterThan(400);
    expect(staleMs, '補收該跳過打字延遲').toBeLessThan(400);
  }, 20000);

  // 接線守衛：第二個判據（wasDeliveredWhileAway）也要真的傳到後處理管線去。
  //
  // 這條跟上一條的差別只有「送達時用戶在不在場」：消息一樣新鮮，一樣走實時口徑。
  // 人不在場時系統通知已經把整句話顯示完了，再演一遍打字過程就只剩乾等——這正是
  // 「通知都看到了，App 裡還得再等幾十秒」那個反饋的後半截。
  // 閾值同上：慢放每條氣泡至少 500ms，落庫開銷是幾十毫秒，取 400ms 當界。
  it('實時送達、但送達時用戶不在場 → 也跳過慢放（他已經在通知裡讀過了）', async () => {
    const charId = 'char-pace-away';
    await DB.saveCharacter({ id: charId, name: '缺席送達角色' } as any);
    const receivedAt = Date.now();
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-pace-away',
      charId,
      messageType: 'text',
      sentAt: receivedAt,
      receivedAt,
    }));

    // 消息落到設備之後，用戶才把頁面切回前台 = 他是從通知知道這條消息的。
    notePageBecameVisible(receivedAt + 1_000);
    const t0 = Date.now();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      notePageBecameVisible(0); // 全局狀態，別漏給後面的用例
    }

    expect(Date.now() - t0, '人不在場時該跳過打字延遲').toBeLessThan(400);
  }, 20000);

  // 同一條推送的「第二次到達」（outbox 補收先落庫、被推送服務延遲的原始 push 幾分鐘後
  // 才送達；或補收銷帳時 cancelTask 沒攔住、worker 重試重跑複用同 messageId）不該再上
  // 屏一遍：落庫前按聊天近史裡的 activeMsg2.messageId 去重。
  it('聊天記錄裡已有同 messageId → 第二次到達整條丟棄，不重複上屏', async () => {
    const charId = 'char-dedup-redelivery';
    await DB.saveCharacter({ id: charId, name: '去重角色' } as any);
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg_task_9@1700000000000_hook_0',
      charId,
      messageType: 'text',
      sentAt: Date.now() - 8 * 60_000, // 走補收口徑，跳過擬人慢放
    }));
    await flushInboxToChat('SW通知');
    const first = await assistantMsgs(charId);
    expect(first.length).toBeGreaterThan(0);

    // 同一條（同 messageId）再次入庫 = 遲到的原始推送終於送達
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg_task_9@1700000000000_hook_0',
      charId,
      messageType: 'text',
      sentAt: Date.now() - 8 * 60_000,
    }));
    await flushInboxToChat('SW通知');

    expect((await assistantMsgs(charId)).length, '第二次到達不能再上屏').toBe(first.length);
  }, 20000);

  // 即時對話的情緒評估在 worker 裡跟主回覆並行跑，結果掛在最後一條推送的 metadata 上。
  // 收側得跟單獨一條 emotion_update 消息走同一條鏈：同一個 applyEmotionEvalRaw 落 buff、
  // 同一個 'instant-emotion-done' 熄燈。漏了這一段，用戶看到的是「回覆來了、情緒永遠不更新、
  // 頭頂那盞『情緒更新中』亮滿十一分鐘」。
  describe('即時對話帶回來的情緒評估', () => {
    /** 記下這一段派了哪些事件（spy 而不是手工換函數：restore 交給 vitest，漏還原不了）。 */
    const captureEvents = () => {
      const seen: Array<{ type: string; detail: any }> = [];
      const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
        seen.push({ type: event?.type, detail: event?.detail });
        return true;
      });
      return { seen, restore: () => spy.mockRestore() };
    };

    it('評估原文隨回覆一起到 → 落 buff + 熄燈（跟 emotion_update 同一條鏈）', async () => {
      const charId = 'char-emotion-inline';
      await DB.saveCharacter({ id: charId, name: '情緒角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-inline',
        charId,
        charName: '情緒角色',
        messageType: 'text',
        metadata: {
          charId,
          amsgEmotionDone: true,
          amsgEmotionUpdate: JSON.stringify({
            changed: true,
            buffs: [{ label: '雀躍', emoji: '✨', intensity: 3 }],
            injection: '你此刻心情很好。',
            innerState: '他記得我說過的話。',
          }),
        },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label)).toContain('雀躍');
      expect(updated.buffInjection).toContain('心情很好');
      // 意識流餵給下一輪 + 徽章熄滅，兩個事件都得發（點燈的那一側只認它們）
      expect(seen.some((e) => e.type === 'emotion-innerstate-updated' && e.detail?.charId === charId)).toBe(true);
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
      // 正文照常上屏：情緒只是附贈，不能把這條消息帶跑
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
    }, 20000);

    it('雲端評估沒跑出東西 → 照樣熄燈，並把 worker 捎回來的原因原樣給用戶看', async () => {
      const charId = 'char-emotion-empty';
      await DB.saveCharacter({ id: charId, name: '空評估角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-empty',
        charId,
        charName: '空評估角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionDone: true, amsgEmotionError: '副 API HTTP 401：no credit' },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
      const failed = seen.find((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId);
      expect(failed).toBeTruthy();
      // 「可查 worker 日誌」對自己部署 worker 的用戶等於沒說；具體狀態碼才查得下去
      expect(failed!.detail.reason).toContain('副 API HTTP 401');
      expect(failed!.detail.reason).toContain('no credit');
    }, 20000);

    it('老 worker 沒帶原因 → 退回那句籠統的（不至於什麼都不說）', async () => {
      const charId = 'char-emotion-noreason';
      await DB.saveCharacter({ id: charId, name: '舊版角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-noreason',
        charId,
        charName: '舊版角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionDone: true },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      const failed = seen.find((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId);
      expect(failed!.detail.reason).toContain('雲端情緒評估無輸出');
    }, 20000);

    // 晚投：worker 那頭評估沒趕上回復，push 只掛引用鍵 + pending 標記，結果收尾時才寫進
    // 旁路。收側不許當場熄燈（結論還沒有），也不許立刻按 ref 取（鍵多半還空著，白打
    // 一個「被下一輪覆蓋」的 warn）。迴歸守衛——舊行為會把 ref 當旁路結果取、當場熄燈。
    it('晚投標記（amsgEmotionPending）→ 不熄燈、不立刻取，交給補落輪詢', async () => {
      const charId = 'char-emotion-pending';
      await DB.saveCharacter({ id: charId, name: '晚投角色' } as any);
      const ref = 'emotion_update:client-task-late';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue(JSON.stringify({ changed: true, buffs: [] }));

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-pending',
        charId,
        charName: '晚投角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionPending: true, amsgEmotionRef: ref },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
        // 收掉這一輪排下的補落定時器，別讓它帶著生產間隔漂進後面的測試
        cancelLateEmotionPoll(charId);
      }

      // 結論未到：燈不熄、不報失敗、也不立刻去讀旁路鍵
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(false);
      expect(seen.some((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId)).toBe(false);
      expect(readSpy).not.toHaveBeenCalled();
      // 正文照常上屏
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
      readSpy.mockRestore();
    }, 20000);

    it('補落輪詢：第二跳等到結果 → 落 buff + 熄燈 + 刪雲端副本', async () => {
      const charId = 'char-emotion-late-land';
      await DB.saveCharacter({ id: charId, name: '補落角色' } as any);
      const ref = 'emotion_update:client-task-land';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValueOnce(null)
        .mockResolvedValue(JSON.stringify({
          changed: true,
          buffs: [{ label: '釋然', emoji: '🌤', intensity: 2 }],
          injection: '你此刻很釋然。',
        }));
      const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);

      const { seen, restore } = captureEvents();
      try {
        startLateEmotionPoll(charId, ref, '補落角色', { intervalMs: 10, maxTries: 5 });
        await vi.waitFor(() => {
          expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
        }, { timeout: 5000 });
      } finally {
        restore();
        cancelLateEmotionPoll(charId);
      }

      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label)).toContain('釋然');
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
      expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      readSpy.mockRestore();
      clearSpy.mockRestore();
    }, 20000);

    it('補落輪詢：跳數用盡還沒等到 → 報「最終沒等到」+ 熄燈', async () => {
      const charId = 'char-emotion-late-timeout';
      await DB.saveCharacter({ id: charId, name: '超時角色' } as any);
      const ref = 'emotion_update:client-task-timeout';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);

      const { seen, restore } = captureEvents();
      try {
        startLateEmotionPoll(charId, ref, '超時角色', { intervalMs: 10, maxTries: 3 });
        await vi.waitFor(() => {
          expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
        }, { timeout: 5000 });
      } finally {
        restore();
        cancelLateEmotionPoll(charId);
      }

      const failed = seen.find((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId);
      expect(failed).toBeTruthy();
      expect(failed!.detail.reason).toContain('最終沒等到');
      expect(readSpy).toHaveBeenCalledTimes(3);
      readSpy.mockRestore();
    }, 20000);

    it('裝不下時挪進 client_state：按 amsgEmotionRef 取回來照樣落 buff，用完就刪', async () => {
      const charId = 'char-emotion-ref';
      await DB.saveCharacter({ id: charId, name: '旁路角色' } as any);
      const ref = 'emotion_update:client-task-ref';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue(JSON.stringify({
          changed: true,
          buffs: [{ label: '安心', emoji: '🍵', intensity: 2 }],
          injection: '你此刻很安心。',
        }));
      const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-ref',
        charId,
        charName: '旁路角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionDone: true, amsgEmotionRef: ref },
      }));

      await flushInboxToChat('SW通知');

      expect(readSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label)).toContain('安心');
      expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      readSpy.mockRestore();
      clearSpy.mockRestore();
    }, 20000);

    // 降級存原稿（post-processing 失敗到頭 / 白名單外類型）也要消費情緒附贈：全倉庫
    // 唯一的消費點在主路徑裡面，降級只把 metadata 原樣抄進聊天記錄的話，結果永遠無人
    // 再讀——徽章亮滿十來分鐘的安全網，然後彈「worker 可能是舊版」的假告警，其實結論
    // 早就到了本地。
    it('降級存原稿路徑 → 照樣落 buff + 熄燈（結果不能躺在 metadata 裡爛掉）', async () => {
      const charId = 'char-emotion-degraded';
      await DB.saveCharacter({ id: charId, name: '降級角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-degraded',
        charId,
        charName: '降級角色',
        messageType: 'forum', // 白名單外 → 不走 post-processing，直接原稿落庫（routed=false）
        metadata: {
          charId,
          amsgEmotionDone: true,
          amsgEmotionUpdate: JSON.stringify({
            changed: true,
            buffs: [{ label: '釋然', emoji: '🌿', intensity: 2 }],
            injection: '你此刻很釋然。',
          }),
        },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label), '降級路徑也要落 buff').toContain('釋然');
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId),
        '降級路徑也要熄燈，別把安全網的假告警等出來').toBe(true);
      // 原稿本體照常上屏
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
    }, 20000);

    // 降級 × 晚投的組合：降級分支也得認 pending 標記——舊行為是立刻按 ref 去讀旁路
    // （鍵還空著，白打「被下一輪覆蓋」的 warn），然後既不熄燈也不補落，安全網到點彈
    // 「worker 可能是舊版」的假告警。迴歸守衛——舊行為下 readSpy 會被立即調用。
    it('降級存原稿 × 晚投標記 → 不熄燈、不立刻取，交給補落輪詢', async () => {
      const charId = 'char-emotion-degraded-pending';
      await DB.saveCharacter({ id: charId, name: '降級晚投角色' } as any);
      const ref = 'emotion_update:client-task-degraded-late';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue(JSON.stringify({ changed: true, buffs: [] }));

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-degraded-pending',
        charId,
        charName: '降級晚投角色',
        messageType: 'forum', // 白名單外 → 降級存原稿分支（routed=false）
        metadata: { charId, amsgEmotionPending: true, amsgEmotionRef: ref },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
        // 收掉這一輪排下的補落定時器，別讓它帶著生產間隔漂進後面的測試
        cancelLateEmotionPoll(charId);
      }

      // 結論未到：燈不熄、不報失敗、也不立刻去讀旁路鍵
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(false);
      expect(seen.some((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId)).toBe(false);
      expect(readSpy).not.toHaveBeenCalled();
      // 原稿本體照常上屏
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
      readSpy.mockRestore();
    }, 20000);
  });

  // 聊天走即時對話時，思考是在 worker 裡生成的，客戶端手上沒有那份 reasoning。
  // worker 把它掛在第一條 push 的 metadata.amsgReasoning 上；收側不認的話，用戶開著
  // 「顯示思考鏈」卻只在本地生成時看得到卡片，雲端這條路整個缺席。
  describe('雲端帶回來的思考鏈', () => {
    const thinkingChainOf = async (charId: string) =>
      (await assistantMsgs(charId)).map((m: any) => m.metadata?.thinkingChain).filter(Boolean);

    it('隨第一條 push 回來 → 掛到第一條氣泡的 thinkingChain 上', async () => {
      const charId = 'char-reasoning-inline';
      await DB.saveCharacter({ id: charId, name: '會思考的角色', showThinkingChain: true } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-reasoning-inline',
        charId,
        charName: '會思考的角色',
        messageType: 'text',
        metadata: { charId, messageIndex: 1, amsgReasoning: '他這句問得很輕，先接住。' },
      }));

      await flushInboxToChat('SW通知');

      expect(await thinkingChainOf(charId)).toEqual(['他這句問得很輕，先接住。']);
    }, 20000);

    it('太長挪進了 client_state → 按 amsgReasoningRef 取回來，用完就刪', async () => {
      const charId = 'char-reasoning-ref';
      await DB.saveCharacter({ id: charId, name: '想很多的角色', showThinkingChain: true } as any);
      const ref = 'reasoning:client-task-reasoning';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue('想了很久才決定這麼說。');
      const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-reasoning-ref',
        charId,
        charName: '想很多的角色',
        messageType: 'text',
        metadata: { charId, messageIndex: 1, amsgReasoningRef: ref },
      }));

      await flushInboxToChat('SW通知');

      expect(readSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      expect(await thinkingChainOf(charId)).toEqual(['想了很久才決定這麼說。']);
      expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      readSpy.mockRestore();
      clearSpy.mockRestore();
    }, 20000);

    // 卡片只能掛第一條氣泡。後面幾段要是也認，同一段思考會在這輪對話裡重複冒出來。
    it('後面幾段 push 不認（哪怕 worker 出 bug 每條都掛）', async () => {
      const charId = 'char-reasoning-late';
      await DB.saveCharacter({ id: charId, name: '第二段角色', showThinkingChain: true } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-reasoning-late',
        charId,
        charName: '第二段角色',
        messageType: 'text',
        metadata: { charId, messageIndex: 2, amsgReasoning: '這段不該出現在卡片裡。' },
      }));

      await flushInboxToChat('SW通知');

      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);   // 正文照常上屏
      expect(await thinkingChainOf(charId)).toEqual([]);
    }, 20000);
  });

  // worker 把「這一輪跑過哪些工具」掛在最後一條 push 的 metadata.amsgToolTrace 上，
  // 氣泡底下那行灰字照它渲染。它走的是 mcdInheritMeta 這條通道——push 的 metadata 整份
  // 鋪到每條落庫的氣泡上。這一份必須鋪進去，哪天漏了，這行灰字會靜默消失
  // （用戶只看到角色憑空知道了新聞）。
  describe('雲端帶回來的工具痕跡', () => {
    const TRACE = [{ name: 'web_search', count: 2 }, { name: 'recall', count: 1 }];

    it('隨 push 回來 → 落到這條 push 拆出的氣泡 metadata 上，跟固定那幾個字段並存', async () => {
      const charId = 'char-tooltrace';
      await DB.saveCharacter({ id: charId, name: '會查東西的角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-tooltrace',
        charId,
        charName: '會查東西的角色',
        messageType: 'text',
        body: '我看了下。\n沒什麼大事。',
        // 補收（跳過打字節奏），這條用例只關心元數據落到哪
        receivedAt: Date.now() - 3_600_000,
        sentAt: Date.now() - 3_600_000,
        metadata: { charId, amsgToolTrace: TRACE },
      }));

      await flushInboxToChat('SW通知');

      const msgs = await assistantMsgs(charId);
      expect(msgs.length).toBeGreaterThan(0);
      for (const m of msgs) {
        expect((m.metadata as any)?.amsgToolTrace).toEqual(TRACE);
        // 同一份 metadata 裡那幾個固定字段照舊在：痕跡是加進來的，不是擠掉別人換來的
        expect((m.metadata as any)?.source).toBe('active_msg_2');
        expect((m.metadata as any)?.activeMsg2?.messageId).toBe('msg-tooltrace');
      }
    }, 20000);

    it('沒跑工具的那一輪 → 氣泡上一個字段都沒有', async () => {
      const charId = 'char-tooltrace-none';
      await DB.saveCharacter({ id: charId, name: '沒查東西的角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-tooltrace-none',
        charId,
        charName: '沒查東西的角色',
        messageType: 'text',
        receivedAt: Date.now() - 3_600_000,
        sentAt: Date.now() - 3_600_000,
        metadata: { charId },
      }));

      await flushInboxToChat('SW通知');

      const msgs = await assistantMsgs(charId);
      expect(msgs.length).toBeGreaterThan(0);
      for (const m of msgs) expect((m.metadata as any)?.amsgToolTrace).toBeUndefined();
    }, 20000);
  });

  it('降級存原稿路徑·剛送達：與主路徑同口徑，落 sentAt', async () => {
    const charId = 'char-ts-raw-fresh';
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-fresh',
      charId,
      messageType: 'forum',
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);
});

// ─── ② pushsubscriptionchange 標記消費（真庫 fake-indexeddb）───
// SW 換訂閱時往 ActiveMsg 庫 kv store 寫固定 key 的標記（worker/sw-keep-alive.ts），
// 這裡釘主線程的消費口徑：有標記才刷；刷成功才清；不支持 / 部分失敗 / 拋錯都留著
// 下次再試（清了就再也沒人補——marker 只在 pushsubscriptionchange 那一刻寫一次）。
describe('refreshPushSubscriptionIfMarked', () => {
  const openAmsgDb = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ActiveMsg');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  /** 按 SW 寫入的同款記錄形狀（KvRecord {id, value}）把標記放進真庫。 */
  const putMarker = async () => {
    await ActiveMsgStore.getGlobalConfig(); // 先把 schema 建到當前版本（含 kv store）
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({
        id: PUSH_SUBSCRIPTION_CHANGED_KV_ID,
        value: { changedAt: Date.now(), resubscribed: false },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  const markerExists = async (): Promise<boolean> => {
    const db = await openAmsgDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const request = tx.objectStore('kv').get(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
        request.onsuccess = () => resolve(Boolean(request.result));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  const clearMarker = async () => {
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMarker();
  });

  it('沒有標記 → 不發起登記', async () => {
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockResolvedValue(undefined);

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('no-marker');
    expect(register).not.toHaveBeenCalled();
  });

  // 登記是一次覆蓋寫，覆蓋到的是用戶級那一份訂閱——本地知不知道有哪些任務、有沒有
  // 任務，都跟它無關。所以只有「成功清標記 / 失敗留標記」兩種歸宿。
  it('有標記 + 登記成功 → 調一次並清掉標記', async () => {
    await putMarker();
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockResolvedValue(undefined);

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('refreshed');
    expect(register).toHaveBeenCalledTimes(1);
    await expect(markerExists()).resolves.toBe(false);
  });

  it('登記拋錯（斷網 / 權限被收回）→ 標記保留下次再試', async () => {
    await putMarker();
    vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockRejectedValue(new Error('offline'));

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('kept');
    await expect(markerExists()).resolves.toBe(true);
  });
});

// ─── ③ 角色自排任務：認領之後要廣播出去 ───
// 認領只寫了 IndexedDB 的話，React 那側內存裡的任務清單還是舊的：任務面板列不出這條、
// 按任務數 / 憑據 / 訂閱這三道門做判斷的地方也都看不見它，而它照常到點觸發。
// 事件名和 detail 形狀是與 OSContext 監聽側的約定，這組用例把它釘死。
describe('認領角色自排任務後廣播 amsg2-tasks-adopted', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** 把 flush 期間派發的事件都收下來（node 環境沒有真 window，只記錄不分發）。 */
  const captureEvents = (): any[] => {
    const seen: any[] = [];
    vi.spyOn((globalThis as any).window, 'dispatchEvent')
      .mockImplementation((event: any) => { seen.push(event); return true; });
    return seen;
  };

  const selfScheduledTask = (taskUuid: string, at: number) => ({
    taskUuid,
    clientTaskId: `client-${taskUuid}`,
    mode: 'auto',
    firstSendTime: new Date(at + 90 * 60_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'character',
    status: 'scheduled',
    createdAt: at,
  });

  const pushWithSelfScheduled = (charId: string, messageId: string, tasks: unknown[]) =>
    ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '自排角色',
      body: '晚點再找你',
      // 白名單外的類型 → 走原稿落庫，不必為這組用例跑整條後處理管線。
      messageType: 'forum',
      receivedAt: Date.now(),
      metadata: { charId, amsgSelfScheduled: tasks },
    } as any);

  it('認領到新任務 → 派發一次，detail.charId 是這個角色', async () => {
    const charId = 'char-adopt-event';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [] },
    } as any);
    await pushWithSelfScheduled(charId, 'msg-adopt-event-1', [selfScheduledTask('amsgself-evt-1', now)]);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    const adopted = events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT);
    expect(adopted, '修復前只寫庫不廣播，這裡拿到 0 條').toHaveLength(1);
    expect(adopted[0].detail).toEqual({ charId });
  }, 20000);

  it('同一條任務再來一次（push 重放）→ 不重複派發，別讓 UI 白重讀', async () => {
    const charId = 'char-adopt-event-dup';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId,
      name: '自排角色',
      activeMsg2Config: { enabled: true, tasks: [selfScheduledTask('amsgself-evt-dup', now)] },
    } as any);
    await pushWithSelfScheduled(charId, 'msg-adopt-event-2', [selfScheduledTask('amsgself-evt-dup', now)]);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    expect(events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT)).toHaveLength(0);
  }, 20000);

  // 對稱的消帳側：角色在 fire 裡取消 / 改期掉的既有任務（amsgTaskMutations）。
  // D1 行已經沒了（或換了時間），本地清單不跟著動的話，面板會一直列著一條
  // 永遠不會響（或時間不對）的任務。
  it('取消 + 改期隨 amsgTaskMutations 落到本地清單，並廣播一次', async () => {
    const charId = 'char-mutations';
    const now = Date.now();
    const keep = selfScheduledTask('amsgself-mut-keep', now);
    const gone = selfScheduledTask('amsgself-mut-gone', now);
    const moved = selfScheduledTask('amsgself-mut-moved', now);
    const newSendAt = new Date(now + 5 * 3600_000).toISOString();
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [keep, gone, moved] },
    } as any);
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-mutations-1',
      charId,
      charName: '自排角色',
      body: '那條不用等了',
      messageType: 'forum',
      receivedAt: Date.now(),
      metadata: {
        charId,
        amsgTaskMutations: {
          cancelled: ['amsgself-mut-gone'],
          renewed: [{ taskUuid: 'amsgself-mut-moved', sendAt: newSendAt }],
        },
      },
    } as any);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    const chars = await DB.getAllCharacters();
    const tasks = chars.find((c: any) => c.id === charId)?.activeMsg2Config?.tasks ?? [];
    expect(tasks.map((t: any) => t.taskUuid).sort()).toEqual(['amsgself-mut-keep', 'amsgself-mut-moved']);
    const renewed = tasks.find((t: any) => t.taskUuid === 'amsgself-mut-moved');
    expect(renewed?.firstSendTime).toBe(newSendAt);
    expect(renewed?.nextSendAt).toBe(newSendAt);
    expect(events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT)).toHaveLength(1);
  }, 20000);

  it('帳已經平了（重放同一份 mutations）→ 不寫庫不廣播', async () => {
    const charId = 'char-mutations-replay';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId, name: '自排角色',
      activeMsg2Config: { enabled: true, tasks: [selfScheduledTask('amsgself-mut-r', now)] },
    } as any);
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-mutations-replay-1',
      charId,
      charName: '自排角色',
      body: '……',
      messageType: 'forum',
      receivedAt: Date.now(),
      metadata: {
        charId,
        // 取消的那條本地早就沒有了 → 清單不變，什麼都不該發生
        amsgTaskMutations: { cancelled: ['amsgself-mut-already-gone'] },
      },
    } as any);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    expect(events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT)).toHaveLength(0);
  }, 20000);
});

// ─── ④ 被吞掉的消息，雲端「我說過什麼」也要跟著撤 ───
// worker 發完就把正文記進了 client_state 的 self_log，而這條在客戶端被防穿幫閘吞掉、
// 用戶一個字沒看到。不撤的話，下一次到點的 prompt 裡【這之後你又主動發過】列著它，
// 角色接著一句沒人看過的話往下說。
describe('revokeSwallowedSelfLogEntry', () => {
  const CHAR = 'char-selflog';
  const NS = amsgStateNamespace(CHAR);
  const ENTRY_ID = 'client-task-x@1700000000000';

  // 形狀跟 amsgFirePack 的 AmsgSelfLog 對齊（parseSelfLog 認版本號，對不上一律當沒有）。
  const cloudLog = (
    entries: Array<{ id: string; at: number; text: string }>,
    tasks: unknown[] = [],
  ) => JSON.stringify({
    v: 4,
    basePackAt: 1_700_000_000_000,
    anchorUserMsgAt: null,
    entries,
    unansweredSends: entries.length,
    tasks,
  });

  const entry = (id: string) => ({ id, at: 1_700_000_000_000, text: '在忙嗎' });

  const stubCloud = (raw: string | null) => {
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(raw);
    return {
      clear: vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined),
      write: vi.spyOn(ActiveMsgClient, 'writeClientStateValue').mockResolvedValue(undefined),
    };
  };

  /** 讀回這次寫上去的那份日誌。 */
  const writtenLog = (write: any) => JSON.parse(write.mock.calls[0][2]);

  afterEach(() => { vi.restoreAllMocks(); });

  it('日誌裡只剩這一條 → 整份清空（對 worker 而言等價於「重新建一份空的」）', async () => {
    const { clear, write } = stubCloud(cloudLog([entry(ENTRY_ID)]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('cleared');
    expect(clear).toHaveBeenCalledWith(NS, AMSG_SELF_LOG_KEY);
    expect(write).not.toHaveBeenCalled();
  });

  it('還有別的條目 → 只摘掉被吞那條，其餘原樣寫回', async () => {
    const { clear, write } = stubCloud(cloudLog([entry('other@1'), entry(ENTRY_ID)]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('rewritten');
    expect(clear, '整份清空會把用戶真收到過的話也抹掉').not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(NS, AMSG_SELF_LOG_KEY, expect.any(String));
    expect(writtenLog(write).entries.map((e: any) => e.id)).toEqual(['other@1']);
  });

  // 連發計數不退回去的話，「用戶清空了聊天記錄」那條吞消息的分支會留下糊塗帳：那時
  // lastUserMessageAt 是 null，下一次 fire 的 reconcileSelfLogWithPack 歸零條件夠不到，
  // 這些用戶根本沒看見的消息一直佔著額度，直到正常的主動消息被攔下。
  it('摘掉條目時連發計數跟著退回去（被吞的那條用戶沒看見，不該佔額度）', async () => {
    const { write } = stubCloud(cloudLog([entry('other@1'), entry(ENTRY_ID)]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('rewritten');
    expect(writtenLog(write).unansweredSends, '吞掉一條就該退一格').toBe(1);
  });

  // 加法那側（appendSelfLogEntry）對 reply 就沒 +1，這裡減了會把計數越撤越小。
  it('撤的是即時對話的回覆 → 計數不動（它當初就沒記進連發）', async () => {
    const raw = JSON.parse(cloudLog([entry('other@1'), entry(ENTRY_ID)]));
    raw.entries[1].reply = true;
    raw.unansweredSends = 1;
    const { write } = stubCloud(JSON.stringify(raw));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('rewritten');
    expect(writtenLog(write).unansweredSends).toBe(1);
  });

  it('日誌裡還掛著角色自排的任務 → 摘條目、任務原樣留著', async () => {
    const { clear, write } = stubCloud(cloudLog([entry(ENTRY_ID)], [{ taskUuid: 'amsgself-1' }]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('rewritten');
    expect(clear).not.toHaveBeenCalled();
    const next = writtenLog(write);
    expect(next.entries).toEqual([]);
    expect(next.tasks, '任務清單缺一塊，角色下次會把同一件事再排一遍').toEqual([{ taskUuid: 'amsgself-1' }]);
    expect(next.basePackAt, 'basePackAt 要原樣帶著，改了整份日誌就對不上號作廢了').toBe(1_700_000_000_000);
  });

  it('日誌裡沒有這條（id 對不上 / 已經被別處清了）→ 什麼都不寫', async () => {
    const { clear, write } = stubCloud(cloudLog([entry('someone-else@2')]));

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('not-found');
    expect(clear).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('雲端壓根沒有這份日誌 → 什麼都不寫', async () => {
    const { clear, write } = stubCloud(null);

    await expect(revokeSwallowedSelfLogEntry(CHAR, ENTRY_ID)).resolves.toBe('no-log');
    expect(clear).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

// 條目 id 的拼法必須跟 worker 寫日誌那份逐字對齊（`<clientTaskId>@<觸發時刻>`），
// 差一個字符就永遠認領不到——而認領不到是靜默的，沒人會發現。
describe('buildSelfLogEntryId', () => {
  it('有任務歸屬鍵 → `<clientTaskId>@<觸發時刻>`', () => {
    expect(buildSelfLogEntryId({
      occurrenceMs: 1_700_000_000_000,
      metadata: { amsgClientTaskId: 'client-task-x' },
    } as any)).toBe('client-task-x@1700000000000');
  });

  it('缺任務歸屬鍵 → 用 worker 那邊同款的字面量 task', () => {
    expect(buildSelfLogEntryId({ occurrenceMs: 1_700_000_000_000, metadata: {} } as any))
      .toBe('task@1700000000000');
  });

  it('缺觸發時刻（老 push 不帶）→ null，寧可不動也不瞎猜', () => {
    expect(buildSelfLogEntryId({ metadata: { amsgClientTaskId: 'client-task-x' } } as any)).toBeNull();
  });
});

// 走真 flush 釘住接線：閘吞掉之後確實去撤了對應的那條，且用的是上面那套 id 拼法。
describe('防穿幫閘吞掉消息後撤銷雲端自述日誌（走真庫）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('吞掉一條 → 按 `<clientTaskId>@<觸發時刻>` 把雲端那條撤掉', async () => {
    const charId = 'char-swallow-selflog';
    await DB.saveCharacter({ id: charId, name: '被吞角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3_600_000;
    // 到點前一分鐘用戶還在說話 → 循環任務的「正在熱聊」窗口命中，這條 push 會被吞。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '我在忙',
      timestamp: occurrenceMs - 60_000,
    } as any);

    const entryId = `client-task-swallow@${occurrenceMs}`;
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(JSON.stringify({
      v: 4,
      basePackAt: 1_700_000_000_000,
      anchorUserMsgAt: null,
      entries: [{ id: entryId, at: occurrenceMs, text: '剛看到樓下那隻貓又來了' }],
      unansweredSends: 1,
      tasks: [],
    }));
    const clear = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined);

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-swallow-selflog',
      charId,
      charName: '被吞角色',
      body: '剛看到樓下那隻貓又來了',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',
      occurrenceMs,
      receivedAt: Date.now(),
      sentAt: occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-swallow',
      },
    } as any);

    await flushInboxToChat('SW通知');

    // 撤銷是 best-effort、不攔著 flush，所以等它自己跑完。
    await vi.waitFor(() => {
      expect(clear, '修復前這裡一次都不會被調').toHaveBeenCalledWith(
        amsgStateNamespace(charId), AMSG_SELF_LOG_KEY,
      );
    });
  }, 20000);
});

// ─── ⑤ 多段消息的等齊守衛 ───
// 一次生成拆成幾條 push，Web Push 不保證按序到達；App 開著時每條 push 各觸發一次 flush，
// 兩段落進兩批的話「同批按段序排」根本夠不著——顯示順序按自增 id，後段先到就永久顛倒。
describe('findPersistedChunkIndexes / findMissingChunkIndexes', () => {
  const bubble = (sessionId: string, messageIndex: number, role = 'assistant') => ({
    role,
    metadata: { sessionId, messageIndex },
  });

  it('認出同 session 已經落過庫的段序（一條 push 拆成幾個氣泡也只算一段）', () => {
    const found = findPersistedChunkIndexes(
      [bubble('S', 1), bubble('S', 1), bubble('S', 3), bubble('T', 2), bubble('S', 2, 'user')],
      'S',
    );
    expect([...found].sort()).toEqual([1, 3]);
  });

  it('前面的段都齊了 → 不缺；缺哪段就報哪段', () => {
    expect(findMissingChunkIndexes(3, new Set([1, 2]))).toEqual([]);
    expect(findMissingChunkIndexes(3, new Set([2]))).toEqual([1]);
    expect(findMissingChunkIndexes(3, new Set())).toEqual([1, 2]);
    expect(findMissingChunkIndexes(1, new Set()), '第一段沒有前面的段').toEqual([]);
  });
});

describe('多段消息跨批到達的等齊守衛（走真庫）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    // 扣住時會排一次幾秒後的重看；這組用例自己手動驅動 flush，別讓真定時器插進來。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterAll(() => { vi.useRealTimers(); });

  const chunk = (charId: string, sessionId: string, index: number, total: number, body: string) =>
    ActiveMsgStore.saveInboxMessage({
      messageId: `${sessionId}-${index}`,
      charId,
      charName: '分段角色',
      body,
      // 白名單外 → 原稿落庫，這組只關心落庫順序。
      messageType: 'forum',
      receivedAt: Date.now() + index,
      sentAt: Date.now() + index,
      metadata: { sessionId, messageIndex: index, totalMessages: total },
    } as any);

  const bodies = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50))
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);

  it('後段先到 → 先扣住等前段；前段到了之後兩條按序落庫', async () => {
    const charId = 'char-chunk-order';
    const sessionId = 'sess-order';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 2, 2, '……不然我一個人吃不完');
    await flushInboxToChat('SW通知');

    expect(await bodies(charId), '修復前後段會直接落庫，順序就此固定').toEqual([]);
    expect(
      (await ActiveMsgStore.listInboxMessages()).map((m) => m.messageId),
      '被扣住的消息留在收件箱裡等下一次',
    ).toEqual([`${sessionId}-2`]);

    await chunk(charId, sessionId, 1, 2, '晚上一起吃火鍋吧');
    await flushInboxToChat('SW通知');

    expect(await bodies(charId)).toEqual(['晚上一起吃火鍋吧', '……不然我一個人吃不完']);
  }, 20000);

  it('前段真丟了 → 扣到上限就放行，絕不永遠扣著後段', async () => {
    const charId = 'char-chunk-giveup';
    const sessionId = 'sess-giveup';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 2, 2, '……你說呢');

    // 扣滿上限的那幾次
    for (let i = 0; i < MAX_INBOX_ORDER_HOLDS; i += 1) {
      await flushInboxToChat('SW通知');
      expect(await bodies(charId), `第 ${i + 1} 次還該扣著`).toEqual([]);
    }
    // 再來一次：放行
    await flushInboxToChat('SW通知');

    expect(await bodies(charId)).toEqual(['……你說呢']);
    expect(await ActiveMsgStore.listInboxMessages()).toEqual([]);
  }, 20000);

  it('第一段（messageIndex=1）從不扣，單條 push 也照常直接落庫', async () => {
    const charId = 'char-chunk-first';
    const sessionId = 'sess-first';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 1, 2, '在嗎');
    await flushInboxToChat('SW通知');

    expect(await bodies(charId)).toEqual(['在嗎']);
  }, 20000);
});

// ─── ⑥ 補收時間戳不能倒掛 ───
// 「打開 App」和「後台補投的 push 送到」之間隔著好幾秒，用戶來得及先說一句話。
// 這時候還按 sentAt 落庫，聊天流裡就會出現：08:01 用戶說「早安」，下面緊跟著一條
// 標著昨晚 23:00 的角色消息。
describe('resolveBackfillTimestamp', () => {
  const SENT_AT = 1_700_000_000_000;

  it('本地沒有更晚的消息 → 保住 sentAt（隔夜補收就該顯示昨晚的時間）', () => {
    expect(resolveBackfillTimestamp(SENT_AT, undefined)).toBe(SENT_AT);
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT - 60_000)).toBe(SENT_AT);
  });

  it('本地已有更晚的消息 → 退回寫庫當刻（undefined），別讓時間戳往回走', () => {
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT + 1)).toBeUndefined();
  });

  it('恰好同一時刻 → 不算更晚，保住 sentAt（同一次觸發的幾段常常同時刻）', () => {
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT)).toBe(SENT_AT);
  });

  it('本來就是在線送達（寫庫當刻）→ 原樣返回 undefined', () => {
    expect(resolveBackfillTimestamp(undefined, SENT_AT + 1)).toBeUndefined();
  });
});

describe('離線補收落庫時間戳與本地歷史的先後（走真庫）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });

  const backfillPush = (charId: string, messageId: string, sentAt: number) =>
    ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '守夜角色',
      body: '早點睡',
      messageType: 'forum',
      receivedAt: sentAt,
      sentAt,
    } as any);

  const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');

  it('用戶已經先說了話 → 補收的這條落寫庫當刻，不倒掛到他那句話前面', async () => {
    const charId = 'char-backfill-after-user';
    const sentAt = Date.now() - 13 * 3_600_000;   // 昨晚 23:00 推的
    await DB.saveCharacter({ id: charId, name: '守夜角色' } as any);
    // 用戶今早先開的口（push 補投比它晚到幾秒）
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '早安', timestamp: Date.now() - 60_000,
    } as any);
    await backfillPush(charId, 'msg-backfill-after-user', sentAt);

    const before = Date.now();
    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp, '修復前這裡落的是昨晚 23:00，排在「早安」下面').toBeGreaterThanOrEqual(before);
  }, 20000);

  it('用戶沒說話 → 照舊落 sentAt（跟正文裡角色說的晚上的話對得上）', async () => {
    const charId = 'char-backfill-quiet';
    const sentAt = Date.now() - 13 * 3_600_000;
    await DB.saveCharacter({ id: charId, name: '守夜角色' } as any);
    await backfillPush(charId, 'msg-backfill-quiet', sentAt);

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);
});

// ─── ⑦ 重試清場：只清正文，副作用產物留在原地 ───
// 副作用產物（轉帳卡等）跟正文氣泡帶著同一個 activeMsg2.messageId。一起刪掉的話，
// 本輪又因為「認出了標記」判定副作用上次已跑完、不重放 directives —— 卡片刪了又不重建，
// 用戶看到的就是「角色說轉了帳，但沒有轉帳卡」，而錢是真的轉過。
describe('重試清場時副作用產物不受牽連（走真庫）', () => {
  beforeAll(async () => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    await DB.saveCharacter({ id: 'char-retry-sideeffect', name: '轉帳角色' } as any);
  });

  it('轉帳卡 + 半截正文 → 只刪正文，卡還在，directives 也不重放', async () => {
    const charId = 'char-retry-sideeffect';
    const messageId = 'msg-retry-sideeffect';
    const stale = (content: string, type: string) => DB.saveMessage({
      charId, role: 'assistant', type, content,
      metadata: { source: 'active_msg_2', activeMsg2: { messageId } },
    } as any);

    // 上一趟：副作用跑完了（轉帳卡已落庫），正文寫到一半掛了
    await stale('給你轉 5 塊', 'transfer');
    await stale('給你轉個帳', 'text');

    await ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '轉帳角色',
      body: '給你轉個帳',
      messageType: 'text',          // 白名單內 → 走後處理主路徑（重試清場在這條路上）
      receivedAt: Date.now(),
      sentAt: Date.now(),
      processAttempts: 1,           // 這是一次重試
      metadata: { directives: [{ type: 'transfer', amount: 5 }] },
    } as any);

    await flushInboxToChat('SW通知');

    const msgs = await DB.getRecentMessagesByCharId(charId, 200);
    const transfers = msgs.filter((m) => m.type === 'transfer');
    expect(transfers, '刪了又不重放 → 0 張；刪了還重放 → 2 張（二次轉帳）').toHaveLength(1);
    expect(transfers[0].content).toBe('給你轉 5 塊');
    expect(
      msgs.filter((m) => m.type === 'text' && m.content === '給你轉個帳'),
      '上一趟的半截正文該被清掉、由這一趟重新渲染，不該並排兩條',
    ).toHaveLength(1);
  }, 20000);
});

// 更狠的一種半成品：副作用跑完了、正文一條都沒來得及寫。
// 這時可刪的氣泡是 0 條，但「上一趟已經轉過帳」是鐵證——憑據要是照著「刪了幾條」算，
// 這一趟就會把 directives 再放一遍，用戶帳上真的少兩筆。
describe('重試清場·只留下副作用產物的半成品（走真庫）', () => {
  beforeAll(async () => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    await DB.saveCharacter({ id: 'char-retry-cardonly', name: '轉帳角色' } as any);
  });

  it('上一趟只寫下了轉帳卡 → 不重放 directives，卡還是一張', async () => {
    const charId = 'char-retry-cardonly';
    const messageId = 'msg-retry-cardonly';
    await DB.saveMessage({
      charId, role: 'assistant', type: 'transfer', content: '給你轉 8 塊',
      metadata: { source: 'active_msg_2', activeMsg2: { messageId } },
    } as any);

    await ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '轉帳角色',
      body: '給你轉個帳',
      messageType: 'text',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      processAttempts: 1,
      metadata: { directives: [{ type: 'transfer', amount: 8 }] },
    } as any);

    await flushInboxToChat('SW通知');

    const transfers = (await DB.getRecentMessagesByCharId(charId, 200))
      .filter((m) => m.type === 'transfer');
    expect(transfers, '憑據按「刪了幾條」算的話這裡會變成 2 張 —— 二次轉帳').toHaveLength(1);
    expect(transfers[0].content).toBe('給你轉 8 塊');
  }, 20000);
});

// ─── 即時對話：待收記錄的生命週期（走真庫）───
//
// 「正在輸入…」那盞燈掛在待收記錄上，而生成不在本機跑——所以三件事必須釘死：
//   1. 角色一開口就銷帳（燈滅），別讓用戶對著一條已經收到的回覆繼續等；
//   2. **等多久都不是判據**。只有雲端點名回來的結論（任務已失敗 / 行沒了）才收尾，
//      雲端還說 pending 就一直等——worker 一次 fire 能跑 10 分鐘，失敗還要按
//      2/4/6 分鐘重試，任何客戶端定時宣判都會搶在結論前把還在路上的回覆判死；
//   3. 下結論前**先拉一次雲端副本**。推送靜默丟是常態，不拉就報失敗的話，用戶會為
//      一條其實已經生成好的回覆重發一遍（再燒一輪 LLM）。
describe('即時對話的待收記錄（走真庫）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });

  beforeEach(() => {
    localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
    // 默認「帳本讀得到、裡面是空的」。要區分「讀到了、確實沒有」和「壓根沒讀成」的
    // 那幾條自己覆蓋：前者才構成結論，後者只能繼續等。
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // umami 是直接掛在 window 上的，restoreAllMocks 管不著，留著會串到下一條測試。
    delete (globalThis as any).window.umami;
  });

  /** 服務端帳本上的一條：`push` 就是推送信封本身，跟 SW 收到的那份逐字一致。 */
  const outboxEntries = (charId: string, messageId: string, taskUuid: string) => [{
    id: 1,
    messageId,
    taskUuid,
    sessionId: 'sess-instant',
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: null,
    push: {
      messageKind: 'content',
      messageType: 'instant',
      source: 'scheduled',
      message: '在的，剛看到',
      contactName: '即時角色',
      messageId,
      sessionId: 'sess-instant',
      messageIndex: 1,
      totalMessages: 1,
      taskUuid,
      timestamp: new Date().toISOString(),
      metadata: { charId, charName: '即時角色', amsgInstantChat: true },
    },
  }];

  it('欠著的那一輪回復到了 → 待收記錄銷帳（燈滅）', async () => {
    const charId = 'char-instant-clear';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-clear');

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-instant-clear',
      charId,
      charName: '即時角色',
      body: '在的',
      messageType: 'instant',
      taskUuid: 'uuid-clear',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId },
    } as any);
    await flushInboxToChat('SW通知');

    expect(getInstantChatPending(charId)).toBeNull();
  }, 20000);

  // 「任務被作廢」的回執隨 chat 段一起上雲，發出時只記帳（worker 回 202 僅表示受理）。
  // 真正銷帳要等回覆落庫——這一輪要是整個失敗了，回執得留著下輪重新注入，否則角色
  // 永遠不知道自己許過的那條排程已經沒了，既不會續期也不會解釋。
  it('隨這一輪上雲的作廢回執 → 回覆落庫時才銷帳', async () => {
    const charId = 'char-instant-notices';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-notices');
    stageInstantChatExpiredNotices(charId, 'uuid-notices', ['expired-1', 'expired-2']);

    const marked = vi.spyOn(ActiveMsgStore, 'markExpiredNoticesNotified').mockResolvedValue(undefined as any);

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-instant-notices',
      charId,
      charName: '即時角色',
      body: '在的',
      messageType: 'instant',
      taskUuid: 'uuid-notices',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId },
    } as any);
    await flushInboxToChat('SW通知');

    expect(marked).toHaveBeenCalledWith(charId, ['expired-1', 'expired-2']);
    expect(getStagedInstantChatExpiredNotices(charId)).toBeNull();
  }, 20000);

  // 銷帳認 taskUuid，不認「這個角色開口了」：定時任務的主動消息、被頂掉的上一輪遲到
  // 的回覆都可能先落地。按角色銷帳的話，60s 點名連同 outbox 兜底當場全停——這一輪的
  // 推送真丟了就再也沒人去補，用戶對著滅掉的燈以為沒事，其實回覆正躺在 outbox 裡。
  it('同角色的別的消息（定時主動消息 / 舊一輪遲到的回覆）→ 不銷帳、燈不滅', async () => {
    const charId = 'char-instant-unrelated';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-awaited');

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-scheduled-1',
      charId,
      charName: '即時角色',
      body: '到點想你了',
      messageType: 'auto',
      taskUuid: 'uuid-some-scheduled-task',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId },
    } as any);
    await flushInboxToChat('SW通知');

    expect(getInstantChatPending(charId)?.uuid, '別的消息不能替這一輪銷帳').toBe('uuid-awaited');
  }, 20000);

  /**
   * 60s 那個點名定時器只記下來、不真的掛在測試進程上（否則跑完測試還得等它）。
   * 別的 setTimeout 一律照常走真的——測試裡還有別人在用，一起吞掉會把它們弄壞。
   * 返回排過的間隔清單；用完在斷言前 restore。
   */
  const captureStatusPollTimers = () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: any, ms?: number, ...rest: any[]
    ) => {
      if (ms !== INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS) return realSetTimeout(fn, ms, ...rest);
      delays.push(ms);
      return 0 as any;
    }) as any);
    return { delays, restore: () => spy.mockRestore() };
  };

  it('雲端帳本里有那條 → 補收上屏，不查狀態也不報失敗', async () => {
    const charId = 'char-instant-outbox';
    const messageId = 'msg_task_9@1700000000000_hook_0';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-outbox', Date.now());
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries')
      .mockResolvedValue(outboxEntries(charId, messageId, 'uuid-outbox') as any);
    const status = vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus')
      .mockResolvedValue({ state: 'gone' });
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: 'uuid-outbox', alreadyGone: true });

    await runInstantChatStatusCheck();

    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'assistant'), '推送丟了的那條該被補回來').toBe(true);
    expect(msgs.some((m) => m.role === 'system'), '補收成功就不該再報失敗').toBe(false);
    expect(getInstantChatPending(charId)).toBeNull();
    // 補收就把帳銷了，這一輪已經有結論，不用再去問雲端。
    expect(status).not.toHaveBeenCalled();
    // 但要盡力取消那條任務行：回覆是從 outbox 撿回來的 = 真推送沒送到 = 行多半還掛在
    // 2/4/6 分鐘的重試隊列裡，不取消的話重試跑起來就是同一輪的第二份回覆（段數更多時
    // 多出的段成孤兒氣泡）。行已經刪掉的場景取消打到 404，一樣安靜。
    expect(cancel).toHaveBeenCalledWith('uuid-outbox');
  }, 20000);

  it('雲端仍是 pending → 不銷帳、不落失敗說明、不取消任務（等多久都不是判據）', async () => {
    const charId = 'char-instant-still-running';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    // 受理時刻故意放到半小時前：worker 一次 fire 能跑 10 分鐘，失敗還要按 2/4/6 分鐘
    // 重試，等了多久本身不構成任何結論。
    setInstantChatPending(charId, 'uuid-still-running', Date.now() - 30 * 60_000);
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    const status = vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus')
      // nextSendAt 已經過去是重試中的常態（雲端只往前推 retry_after），不是放棄的信號。
      .mockResolvedValue({ state: 'pending', retryCount: 2, nextSendAt: new Date(Date.now() - 60_000).toISOString() });
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: 'uuid-still-running', alreadyGone: false });

    const timers = captureStatusPollTimers();
    await runInstantChatStatusCheck();
    timers.restore();

    expect(status).toHaveBeenCalledWith('uuid-still-running');
    expect(getInstantChatPending(charId)?.uuid, '雲端還在跑，帳不能銷').toBe('uuid-still-running');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system'), '還在跑就不該留失敗說明').toBe(false);
    expect(cancel, '客戶端不再替雲端宣判，更不許把還在跑的任務掐掉').not.toHaveBeenCalled();
    expect(timers.delays).toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  }, 20000);

  it('雲端說任務已失敗 → 再補收一次仍沒有 → 銷帳 + 落帶失敗原因的說明', async () => {
    const charId = 'char-instant-failed';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-failed', Date.now());
    // 失敗原因從 chat_fail 留痕一次點名讀回（worker fire 收尾時寫的），不再全量拉任務列表。
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockImplementation(async (_ns, key) => (
      key === 'chat_fail'
        ? JSON.stringify({ v: 1, uuid: 'uuid-failed', reason: '上游 502', retryCount: 3, at: Date.now() })
        : null
    ));
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'completed' });

    await runInstantChatStatusCheck();

    expect(getInstantChatPending(charId)).toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('即時對話');
    expect(systemMsgs[0].content, '雲端記下的失敗原因要帶到用戶眼前').toContain('上游 502');
    // 措辭是即時對話自己的：用戶剛按下發送，「上次到點沒發出去」那套排程口吻不成話。
    expect(systemMsgs[0].content).toContain('生成失敗（重試 3 次後放棄）');
    expect(systemMsgs[0].content).not.toContain('到點');
  }, 20000);

  // 查失敗原因要去雲端點名讀一份 chat_fail 留痕，這中間用戶看指示燈不動又發了一條
  // 是很自然的事。結論回來時不認 uuid 的話，銷掉的是新那一輪的帳：「正在輸入」當場
  // 熄滅，聊天流裡還多一條它其實沒失敗的說明。
  it('查失敗原因的空檔裡用戶又發了一條 → 遲到的結論不動新那一輪', async () => {
    const charId = 'char-instant-resend';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-old', Date.now());
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'completed' });
    (globalThis as any).window.umami = { track: vi.fn() };

    // 手動掌控 chat_fail 那次點名：卡在半路，好讓「用戶重發」精確插進這個空檔。
    // outbox 兜底的讀照常立即回空——卡住的必須只是失敗原因那一步。
    let releaseFail!: (raw: string | null) => void;
    const failCalled = new Promise<void>((markCalled) => {
      vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockImplementation((_ns, key) => {
        if (key !== 'chat_fail') return Promise.resolve(null);
        markCalled();
        return new Promise((resolve) => { releaseFail = resolve; });
      });
    });

    const timers = captureStatusPollTimers();
    const sweep = runInstantChatStatusCheck();
    await failCalled;
    setInstantChatPending(charId, 'uuid-new'); // 用戶重發，待收記錄換人
    releaseFail(JSON.stringify({ v: 1, uuid: 'uuid-old', reason: '上游 502', retryCount: 3, at: Date.now() }));
    await sweep;
    timers.restore();

    expect(getInstantChatPending(charId)?.uuid, '新那一輪還等著，別把它的燈滅了').toBe('uuid-new');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system'), '新那一輪沒失敗，不該有失敗說明').toBe(false);
    expect((globalThis as any).window.umami.track).not.toHaveBeenCalled();
  }, 20000);

  it('雲端那行已經沒了、outbox 裡也沒有 → 銷帳 + 說明「回覆沒能取回」', async () => {
    const charId = 'char-instant-gone';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-gone', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    await runInstantChatStatusCheck();

    expect(getInstantChatPending(charId)).toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('回覆沒能取回');
  }, 20000);

  // gone 不都是「發成功後行被刪」：模型空輸出 / 純拒答被 worker 判 skip-push 時，一次性
  // 行同樣被上游當成功消費刪掉，worker 在那一刻寫過 chat_fail。gone 分支不讀它的話，
  // 給用戶的解釋是「雲端已處理但回覆沒能取回」——把「沒生成出來」說成了「取不回」，
  // 用戶以為是投遞故障白重發，其實該知道的是模型這輪沒說話。
  it('行沒了 + outbox 為空 + chat_fail 說是 skip → 照實說「模型這輪沒有生成內容」', async () => {
    const charId = 'char-instant-skip';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-skip', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockImplementation(async (_ns, key) => (
      key === 'chat_fail'
        ? JSON.stringify({ v: 1, uuid: 'uuid-skip', reason: 'empty-generation', retryCount: 0, at: Date.now() })
        : null
    ));
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    await runInstantChatStatusCheck();

    expect(getInstantChatPending(charId)).toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('模型這輪沒有生成內容');
    expect(systemMsgs[0].content, '不許把「沒生成」說成「取不回」').not.toContain('回覆沒能取回');
  }, 20000);

  // 「不按時長宣判」只對雲端還答得上話的等待成立。worker 被刪（未知路由回 HTML 頁）、
  // 共享密鑰被換（401）這類用戶自己動過環境的場景，狀態查詢永遠拋錯——不設線的話
  // 「正在輸入…」跨重啟常亮、每 60s 空轉、該角色 fire_pack 同步被無限期掛起。
  it('聯網狀態下狀態查詢連續失敗到第 5 次 → 先取消遠端那行，再判失聯收場', async () => {
    const charId = 'char-instant-unreachable';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-unreachable', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('Unexpected token < in JSON'));
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: 'uuid-unreachable', alreadyGone: false });

    const timers = captureStatusPollTimers();
    try {
      for (let i = 0; i < 4; i += 1) {
        await runInstantChatStatusCheck();
        expect(getInstantChatPending(charId)?.uuid, `第 ${i + 1} 次失敗還不夠判死`).toBe('uuid-unreachable');
        expect(cancel, '還沒判死就不許動遠端那行').not.toHaveBeenCalled();
      }
      await runInstantChatStatusCheck();
    } finally {
      timers.restore();
    }

    expect(getInstantChatPending(charId), '連續 5 次問不出話就該收場').toBeNull();
    // 這條路跟 completed / gone 不一樣：雲端從頭到尾沒給過結論，那行完全可能還掛在
    // 重試梯子上。不取消就宣判 = 用戶照說明重發一遍，原來那行隨後又跑成功，一輪對話
    // 燒兩次 LLM、聊天流裡冒出兩份幾乎一樣的回覆。
    expect(cancel, '判死這一輪就得把遠端那行也了結掉').toHaveBeenCalledWith('uuid-unreachable');
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('聯繫不上雲端 worker');
    expect(systemMsgs[0].content, '要給用戶指條能走的路').toContain('重新連接並驗證');
    // 取消成功 = 那行真沒了，不用再嚇唬用戶「回覆可能還會來」
    expect(systemMsgs[0].content).not.toContain('稍後可能還會送到');
  }, 20000);

  // 會走到失聯判定的典型場景（worker 被刪、共享密鑰被換），取消同樣打不通。要求取消
  // 成功才準判死的話，「正在輸入…」永亮這個原病就又被請回來了——所以照判，只是把話說
  // 清楚：那行可能自己跑完，回覆還會來。
  it('判死時連取消也失敗 → 照樣收場，但說明裡挑明回覆可能稍後還會到', async () => {
    const charId = 'char-instant-unreachable-nocancel';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-nocancel', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('Unexpected token < in JSON'));
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask').mockRejectedValue(new Error('worker 也連不上'));

    const timers = captureStatusPollTimers();
    try {
      for (let i = 0; i < 5; i += 1) await runInstantChatStatusCheck();
    } finally {
      timers.restore();
    }

    expect(cancel).toHaveBeenCalledWith('uuid-nocancel');
    expect(getInstantChatPending(charId), '取消不掉也不能永遠等下去').toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('聯繫不上雲端 worker');
    expect(systemMsgs[0].content, '取消沒落地就得如實說').toContain('稍後可能還會送到');
  }, 20000);

  // 斷網的失敗是這台設備的問題，攢不出「worker 失聯」的結論——恢復網絡後從頭計。
  it('設備離線時的查詢失敗不計入失聯判定', async () => {
    const charId = 'char-instant-airplane';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-airplane', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('Failed to fetch'));
    vi.stubGlobal('navigator', { onLine: false });

    const timers = captureStatusPollTimers();
    try {
      for (let i = 0; i < 6; i += 1) await runInstantChatStatusCheck();
    } finally {
      timers.restore();
      vi.unstubAllGlobals();
    }

    expect(getInstantChatPending(charId)?.uuid, '離線失敗次數再多也不許判死').toBe('uuid-airplane');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system')).toBe(false);
  }, 20000);

  // 「取不回」的結論 = 行沒了 **且帳本讀到了、裡面確實沒有**。帳本那一步讀失敗
  // 時（網絡抖、worker 500），結論就建立在一次失敗的讀上——回覆可能正躺在帳本里。
  // 這時判死的話：用戶看到「生成失敗」重發一遍（再燒一輪），下一跳補收又把原回覆放
  // 出來，聊天流裡失敗說明後面跟著兩條几乎一樣的回覆。
  it('雲端那行已經沒了、但帳本讀失敗 → 這一跳不下結論，等下一跳', async () => {
    const charId = 'char-instant-gone-unreadable';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-gone-unreadable', Date.now());
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockRejectedValue(new Error('worker 500'));
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    const timers = captureStatusPollTimers();
    await runInstantChatStatusCheck();
    timers.restore();

    expect(getInstantChatPending(charId)?.uuid, '帳本沒讀成就不許判死').toBe('uuid-gone-unreadable');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system'), '一次失敗的讀不構成「生成失敗」').toBe(false);
    expect(timers.delays, '下一跳還得排上').toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  }, 20000);

  it('狀態查不到（網絡斷了）→ 什麼都不做，等下一跳', async () => {
    const charId = 'char-instant-offline';
    await DB.saveCharacter({ id: charId, name: '即時角色' } as any);
    setInstantChatPending(charId, 'uuid-offline', Date.now() - 30 * 60_000);
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('網絡斷了'));

    const timers = captureStatusPollTimers();
    await runInstantChatStatusCheck();
    timers.restore();

    expect(getInstantChatPending(charId)?.uuid, '問不到就什麼都不結論').toBe('uuid-offline');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system')).toBe(false);
    expect(timers.delays, '下一跳還得排上，不然這條待收就沒人管了').toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  }, 20000);

  // 後台每分鐘醒一次去打網絡毫無意義：用戶看不見結果，移動端還會被系統掐。週期由
  // 回前台那次點名接上，所以不可見時連下一跳都不排。
  it('頁面不可見 → 一個請求都不發，也不排下一跳', async () => {
    const charId = 'char-instant-hidden';
    setInstantChatPending(charId, 'uuid-hidden', Date.now() - 30 * 60_000);
    const read = vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    const status = vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    (globalThis as any).document = { visibilityState: 'hidden' };
    const timers = captureStatusPollTimers();
    try {
      await runInstantChatStatusCheck();
    } finally {
      timers.restore();
      delete (globalThis as any).document;
    }

    expect(read).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(getInstantChatPending(charId)?.uuid).toBe('uuid-hidden');
    expect(timers.delays, '後台不排下一跳，等回前台那次點名把週期接上').not.toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  });
});

// 攔住「處理失敗後排的那次重試」，別讓它在用例之間真的跑起來。
//
// 按 resolveInboxRetryDelay 的檔位認，跟著實現走：寫死某個毫秒數的話，延遲一改這裡就
// 悄悄失效，重試漏到後面的用例裡，症狀是別處莫名其妙地飄。
// 前提是用它的用例都走補收口徑（跳過擬人慢放）——慢放那條路自己也排 0.5~2 秒的
// setTimeout，撞上檔位就會被一起攔掉。
const captureInboxRetryTimer = () => {
  const retryDelays = new Set([1, 2, 3].map(resolveInboxRetryDelay));
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: any, ms?: number, ...rest: any[]
  ) => (ms != null && retryDelays.has(ms) ? (0 as any) : realSetTimeout(fn, ms, ...rest))) as any);
  return { restore: () => spy.mockRestore() };
};

// ─── 收件箱「先 ack 後處理」的兜底 ───
// consumeInboxMessages 把整批消息原子取空之後才開始逐條處理，這中間任何一步拋出去的
// 異常都會穿過 for 循環：剩下的消息既不在聊天記錄裡、也不在收件箱裡、還不彈任何提示，
// 用戶那邊只看到「正在輸入…」亮到 60s 點名判失敗。所以每條消息都得整段包住。
describe('收件箱處理途中拋錯不許吞掉整批（走真庫）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** 30s 的自動重試定時器只記下來、不真掛在測試進程上（其餘 setTimeout 照常走真的）。 */
  // 接線守衛：排重試用的必須是 resolveInboxRetryDelay 算出來的檔位，不是寫死的常量。
  //
  // 這條的存在意義是「用戶看到的等待時長」：推送通知已經把整句話顯示過了，聊天界面
  // 卻要等重試才追上。延遲被改回半分鐘的話，症狀是「通知都看到了，App 裡還是三個點」，
  // 而所有功能測試照樣全綠——消息一條不丟，只是晚了三十秒。沒人會當回事。
  it('瞬態失敗後排的重試是秒級的，不讓用戶對著「正在輸入」乾等', async () => {
    const charId = 'char-retry-delay';
    await DB.saveCharacter({ id: charId, name: '重試延遲角色' } as any);

    const base = Date.now() - 8 * 60_000; // 補收口徑，跳過擬人慢放
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-retry-delay',
      charId,
      charName: '重試延遲角色',
      body: '在的，剛看到',
      messageType: 'text',
      receivedAt: base,
      sentAt: base,
      metadata: { charId },
    } as any);

    // 去重那步讀近史時炸一次 = 最常見的那種瞬態存儲故障。
    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 連接被佔'));

    // 記下排了哪些延遲；重試那個不能真的跑起來，否則會漏到後面的用例裡。
    const scheduled: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: any, ms?: number, ...rest: any[]
    ) => {
      scheduled.push(ms ?? 0);
      return ms != null && ms >= 1_000 ? (0 as any) : realSetTimeout(fn, ms, ...rest);
    }) as any);
    try {
      await flushInboxToChat('SW通知');
    } finally {
      spy.mockRestore();
    }

    expect(scheduled, '第一次失敗該按第一檔排重試').toContain(resolveInboxRetryDelay(1));

    await ActiveMsgStore.consumeInboxMessages(); // 別把這條留給後面的用例
  }, 20000);

  // 「重試中」這個代號有三個發射點（收發環節兜底 / 防穿幫閘 / 後處理），共用一個事件。
  // 不分段的話面板上只看得到「有多少次重試」，看不出是哪一段在掛——線上那 293 次就是
  // 這麼變成一筆糊塗帳的：查根因時只能靠讀代碼猜，而猜的結論沒法驗證。
  it('上報失敗時帶上是哪一段掛的，三條路不能混成一個數', async () => {
    const charId = 'char-retry-stage';
    await DB.saveCharacter({ id: charId, name: '分段上報角色' } as any);

    const base = Date.now() - 8 * 60_000; // 補收口徑，跳過擬人慢放
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-retry-stage',
      charId,
      charName: '分段上報角色',
      body: '在的，剛看到',
      messageType: 'text',
      receivedAt: base,
      sentAt: base,
      metadata: { charId },
    } as any);

    // 去重那步讀近史時炸一次 = 收發環節的兜底 catch，不是後處理。
    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 連接被佔'));

    const track = vi.spyOn(Analytics, 'trackEvent').mockImplementation(() => {});
    const timers = captureInboxRetryTimer();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
    }

    expect(track).toHaveBeenCalledWith('主动消息送达失败', { kind: '重试中', stage: '收发' });

    await ActiveMsgStore.consumeInboxMessages(); // 別把這條留給後面的用例
  }, 20000);

  it('查近史去重時本地存儲拋錯 → 這條壓回收件箱重試，同批後面那條照常落庫', async () => {
    const failCharId = 'char-stage-throw';
    const okCharId = 'char-stage-ok';
    await DB.saveCharacter({ id: failCharId, name: '拋錯角色' } as any);
    await DB.saveCharacter({ id: okCharId, name: '同批後一條的角色' } as any);

    const base = Date.now() - 8 * 60_000; // 補收口徑，跳過擬人慢放
    const inbox = (charId: string, messageId: string, sentAt: number) => ({
      messageId,
      charId,
      charName: '測試角色',
      body: '在的，剛看到',
      messageType: 'text',
      receivedAt: sentAt,
      sentAt,
      metadata: { charId },
    }) as any;
    await ActiveMsgStore.saveInboxMessage(inbox(failCharId, 'msg-stage-throw', base));
    await ActiveMsgStore.saveInboxMessage(inbox(okCharId, 'msg-stage-ok', base + 1_000));

    // 第一次讀近史（去重那一步）炸掉，之後照常。這一步在後處理那圈 try/catch 之外，
    // 舊行為下異常會一路冒到 flushInboxToChat 的包裝層被 console.warn 掉，兩條一起蒸發。
    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 連接被佔'));

    const seen: string[] = [];
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
      seen.push(event?.type);
      return true;
    });

    const timers = captureInboxRetryTimer();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
      dispatch.mockRestore();
    }

    const requeued = (await ActiveMsgStore.listInboxMessages())
      .find((m) => m.messageId === 'msg-stage-throw');
    expect(requeued, '拋錯那條必須回到收件箱，不能憑空蒸發').toBeTruthy();
    expect(requeued?.processAttempts, '失敗次數要記上，才有重試上限可言').toBe(1);
    expect(seen, '還要告訴用戶有條消息沒能正常顯示').toContain('active-msg-process-failed');
    expect(
      (await DB.getRecentMessagesByCharId(okCharId, 50)).some((m) => m.role === 'assistant'),
      '同一批裡後面那條不該被連累',
    ).toBe(true);

    await ActiveMsgStore.consumeInboxMessages(); // 別把這條留給後面的用例
  }, 20000);

  // 銷帳即失憶：雲端帳本一銷，那條就再也拉不回來了。壓回收件箱的消息還沒處理完，
  // 這一趟把它一起銷掉的話，進程正好在重試前被殺就是**永久丟一條消息**——而這恰恰是
  // 這次接帳本要修的那個病。所以「有著落」的口徑必須是「不會再回收件箱」，不是「處理過了」。
  it('壓回收件箱重試的那條不許銷帳，同批走完的照常銷', async () => {
    const failCharId = 'char-ack-requeue';
    const okCharId = 'char-ack-settled';
    await DB.saveCharacter({ id: failCharId, name: '拋錯角色' } as any);
    await DB.saveCharacter({ id: okCharId, name: '正常角色' } as any);

    const base = Date.now() - 8 * 60_000; // 補收口徑，跳過擬人慢放
    const inbox = (charId: string, messageId: string, sentAt: number) => ({
      messageId,
      charId,
      charName: '測試角色',
      body: '在的，剛看到',
      messageType: 'text',
      receivedAt: sentAt,
      sentAt,
      metadata: { charId },
    }) as any;
    await ActiveMsgStore.saveInboxMessage(inbox(failCharId, 'msg-ack-requeue', base));
    await ActiveMsgStore.saveInboxMessage(inbox(okCharId, 'msg-ack-settled', base + 1_000));

    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 連接被佔'));
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const timers = captureInboxRetryTimer();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
    }

    const acked = ack.mock.calls.flatMap(([ids]) => ids ?? []);
    expect(acked, '壓回收件箱的那條銷了帳就再也補不回來了').not.toContain('msg-ack-requeue');
    expect(acked, '走完流程的那條要銷帳，不然每趟都被重新撈回來').toContain('msg-ack-settled');

    await ActiveMsgStore.consumeInboxMessages(); // 別把這條留給後面的用例
  }, 20000);
});

// ─── 雲端旁路副本的刪除時機 ───
// 回覆太長時 worker 會把思考鏈 / 小紅書會話數據挪進 client_state，push 裡只留一個引用鍵。
// 客戶端取回來就刪的話，落庫半路失敗把消息壓回收件箱之後，重試那一趟讀到的是空——
// 心象卡片這一輪就永久沒了，而且不報任何錯（回覆照常上屏，只是少了張卡）。
describe('雲端旁路副本等這條消息處理成功了再刪（走真庫）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('後處理半路掛了 → 雲端那幾份一個都不刪，重試那趟心象卡片還在', async () => {
    const charId = 'char-offload-defer';
    await DB.saveCharacter({ id: charId, name: '心象角色', showThinkingChain: true } as any);
    const reasoningRef = 'reasoning:client-task-defer';
    const xhsRef = 'xhs_session:client-task-defer';

    // 一份會真被刪掉的雲端存儲：刪了之後再讀就是 null，跟線上一樣。
    const cloud = new Map<string, string>([
      [reasoningRef, '這句話我想了很久才說出口。'],
      [xhsRef, JSON.stringify({ notes: [{ idx: 1, note: { id: 'note-1', title: '一條筆記' } }], xsecTokens: [] })],
    ]);
    vi.spyOn(ActiveMsgClient, 'readClientStateValue')
      .mockImplementation(async (_ns: string, key: string) => cloud.get(key) ?? null);
    const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue')
      .mockImplementation(async (_ns: string, key: string) => { cloud.delete(key); });

    const sentAt = Date.now() - 8 * 60_000; // 補收口徑，跳過擬人慢放
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-offload-defer',
      charId,
      charName: '心象角色',
      body: '剛看到，我在的。',
      messageType: 'text',
      receivedAt: sentAt,
      sentAt,
      metadata: {
        charId,
        sessionId: 'sess-offload-defer',
        messageIndex: 1,
        totalMessages: 1,
        amsgReasoningRef: reasoningRef,
        xhsSessionRef: xhsRef,
      },
    } as any);

    const timers = captureInboxRetryTimer();
    try {
      // 第一趟：落庫掛了（配額滿 / 連接被佔那種），這條被壓回收件箱等重試。
      const saveSpy = vi.spyOn(DB, 'saveMessage').mockRejectedValue(new Error('QuotaExceededError'));
      await flushInboxToChat('SW通知');
      saveSpy.mockRestore();

      expect(clearSpy, '這一趟沒成，雲端那幾份一個都不許刪').not.toHaveBeenCalled();
      expect(
        (await ActiveMsgStore.listInboxMessages()).some((m) => m.messageId === 'msg-offload-defer'),
        '這條該在收件箱裡等重試',
      ).toBe(true);

      // 第二趟：存儲緩過來了，重試把心象卡片補上。
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
    }

    const chains = (await DB.getRecentMessagesByCharId(charId, 50))
      .filter((m) => m.role === 'assistant')
      .map((m: any) => m.metadata?.thinkingChain)
      .filter(Boolean);
    expect(chains, '重試那趟還得讀得到思考鏈').toEqual(['這句話我想了很久才說出口。']);
    // 落定了才輪到收尾：兩份都刪掉，D1 不留垃圾。
    expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), reasoningRef);
    expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), xhsRef);
  }, 20000);
});

// worker 判死那一刻直發的 error push：SW 轉給頁面後當場收尾那一輪（落系統消息、銷帳），
// 不用乾等 60s 點名。迴歸守衛：以前 active-msg-error 在頁面被靜默丟棄。
describe('error push 到頁面 → 當場收尾（handleInstantErrorPushMessage）', () => {
  it('uuid 對得上 → 銷帳 + 落同一份翻譯的失敗說明', async () => {
    const charId = 'char-errpush-hit';
    await DB.saveCharacter({ id: charId, name: '直發角色' } as any);
    setInstantChatPending(charId, 'uuid-errpush-1');

    await handleInstantErrorPushMessage({
      metadata: { charId, taskUuid: 'uuid-errpush-1', reason: 'empty-generation' },
    });

    expect(getInstantChatPending(charId)).toBeNull();
    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    const note = msgs.find((m: any) => m.role === 'system' && String(m.content).includes('即時對話沒能完成'));
    expect(note, '要落一條失敗說明').toBeTruthy();
    // 與 60s 點名路徑同一份翻譯（describeInstantChatFailure），兩條路對用戶說同樣的話
    expect(String(note!.content)).toContain('模型這輪沒有生成內容');
  }, 20000);

  it('uuid 對不上（用戶已經重發了新一輪）→ 不動帳', async () => {
    const charId = 'char-errpush-miss';
    await DB.saveCharacter({ id: charId, name: '重發角色' } as any);
    setInstantChatPending(charId, 'uuid-new-round');

    await handleInstantErrorPushMessage({
      metadata: { charId, taskUuid: 'uuid-old-round', reason: 'stale' },
    });

    expect(getInstantChatPending(charId)?.uuid).toBe('uuid-new-round');
    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    expect(msgs.some((m: any) => String(m.content ?? '').includes('即時對話沒能完成'))).toBe(false);
  }, 20000);

  it('metadata 缺 taskUuid（不是即時對話的失敗告知）→ 靜默略過', async () => {
    const charId = 'char-errpush-no-uuid';
    setInstantChatPending(charId, 'uuid-untouched');

    await handleInstantErrorPushMessage({ metadata: { charId }, code: 'SOME_DIAG', message: 'x' });

    expect(getInstantChatPending(charId)?.uuid).toBe('uuid-untouched');
  }, 20000);

  // worker 把穩定的 errorCode 一起掛在 push 上（amsg-server 給 fire 拋的錯誤掛了 code）。
  // 不帶過去的話，秒級到達的這條直發告知只能說一句籠統的「生成失敗」，而 60s 點名那條
  // 路讀得到同一個碼、說的是「模型接口拒了，去查 Key」——同一次失敗兩種說法。
  it('push 上帶 errorCode → 用它給能照著做的話，跟點名路徑同一份翻譯', async () => {
    const charId = 'char-errpush-code';
    await DB.saveCharacter({ id: charId, name: '報錯角色' } as any);
    setInstantChatPending(charId, 'uuid-errpush-code');

    await handleInstantErrorPushMessage({
      metadata: {
        charId,
        taskUuid: 'uuid-errpush-code',
        reason: 'AI API error: 401 Unauthorized. Request URL: https://api.example.com/v1/chat/completions\n'
          + '  — Incorrect API key provided: sk-[redacted]. (provider code: invalid_api_key)',
        errorCode: 'LLM_CALL_FAILED',
      },
    });

    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    const note = msgs.find((m: any) => m.role === 'system' && String(m.content).includes('即時對話沒能完成'));
    expect(String(note!.content)).toContain('模型接口拒了這次請求');
    expect(String(note!.content)).toContain('invalid_api_key');
  }, 20000);
});

// 一條推送裝不下的內容會切成分片發出，SW 收齊還原。拼不起來的原因不都一樣：等超時
// 重開一下多半就好，而分片對不上 / 超限那幾種重開沒用。混成同一句「消息接收不完整」
// 的話，用戶對著一條永遠修不好的提示反覆重開。
describe('分片拼不起來時說的那句話（describeMultipartFailure）', () => {
  it('等超時 → 說沒等齊，建議重開', () => {
    const text = describeMultipartFailure(MULTIPART_FAILURE_REASON.TTL_EXPIRED);
    expect(text).toContain('沒在時限內到齊');
    expect(text).toContain('重開');
  });

  it('本機存儲寫不進去 → 指向存儲空間，不叫人重開', () => {
    const text = describeMultipartFailure(MULTIPART_FAILURE_REASON.STORAGE_FAILED);
    expect(text).toContain('存儲');
  });

  it('分片本身有問題的幾種 → 照實說是數據問題，別讓人以為重開能好', () => {
    for (const reason of [
      MULTIPART_FAILURE_REASON.INVALID_CHUNK,
      MULTIPART_FAILURE_REASON.CHUNK_CONFLICT,
      MULTIPART_FAILURE_REASON.SIZE_LIMIT_EXCEEDED,
      MULTIPART_FAILURE_REASON.RESTORE_FAILED,
      MULTIPART_FAILURE_REASON.DISABLED,
    ]) {
      const text = describeMultipartFailure(reason);
      expect(text, reason).toContain('分片數據有問題');
      expect(text, reason).not.toContain('重開');
    }
  });

  // 老 SW 不帶 reason（字段是 2.4.0-next.4 加的），照樣得給一句完整的話。
  it('沒有 reason → 走通用文案，不出現 undefined', () => {
    const text = describeMultipartFailure(undefined);
    expect(text).toContain('沒接收完整');
    expect(text).not.toContain('undefined');
  });
});

// 這一組釘的是一次真實事故：定時主動消息到點生成好了、帳本也記了、推送也發出去了，
// 但在網絡層丟了（代理斷流、推送服務連不上）。worker 日誌全綠、任務照常消費、訂閱
// 也沒被退回，用戶那邊就是再也收不到——而云端帳本上明明躺著那幾條。
//
// 病根不在補收本身，在**什麼時候去補**：拉帳本的時機當初只掛在「即時對話正等著回覆」
// 上，而定時主動消息由雲端到點自己發，客戶端從來不產生那個狀態，於是永遠沒人去撈。
//
// 所以這裡釘死的不變量只有一條：**一條待收記錄都沒有時，上線補收照樣要去拉帳本。**
describe('上線補收不看有沒有在等回覆（走真庫）', () => {
  const WORKER_URL = 'https://amsg-catchup.example.workers.dev';

  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });

  beforeEach(async () => {
    localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
    // 這一組測的都是「已經接上帳本之後」的常規補收；首次接管那條路（存量整批銷帳、
    // 不上屏）有自己的一組，見 amsgInstantChat.test.ts。
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
    resetOutboxCatchUpThrottleForTesting();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: WORKER_URL });
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: '' });
  });

  /** 帳本上的一條定時主動消息（`push` 就是推送信封本身，跟 SW 收到的那份逐字一致）。 */
  const scheduledEntry = (charId: string, messageId: string) => ({
    id: 1,
    messageId,
    taskUuid: 'uuid-scheduled',
    sessionId: 'sess-scheduled',
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: Date.now(),
    push: {
      messageKind: 'content',
      messageType: 'scheduled',
      source: 'scheduled',
      message: '到點啦，該睡覺了',
      contactName: '定時角色',
      messageId,
      sessionId: 'sess-scheduled',
      messageIndex: 1,
      totalMessages: 1,
      taskUuid: 'uuid-scheduled',
      timestamp: new Date().toISOString(),
      metadata: { charId, charName: '定時角色' },
    },
  });

  it('一條待收記錄都沒有，冷啟動照樣去帳本上撈', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    expect(listInstantChatPendings()).toHaveLength(0);
    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');
    expect(list).toHaveBeenCalledTimes(1);
  }, 20000);

  it('回到前台同樣不看待收記錄', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    expect(listInstantChatPendings()).toHaveLength(0);
    await expect(catchUpMissedPushes('foreground')).resolves.toBe('drained');
    expect(list).toHaveBeenCalledTimes(1);
  }, 20000);

  it('推送丟掉的那條定時主動消息，從帳本補回聊天流', async () => {
    const charId = 'char-catchup-scheduled';
    const messageId = 'msg_task_67@1786434120000_hook_0';
    await DB.saveCharacter({ id: charId, name: '定時角色' } as any);
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries')
      .mockResolvedValue([scheduledEntry(charId, messageId)] as any);

    expect(listInstantChatPendings()).toHaveLength(0);
    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');

    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    expect(msgs.some((m: any) => String(m.content ?? '').includes('到點啦，該睡覺了'))).toBe(true);
  }, 20000);

  it('不到節流窗口的第二趟不打網絡', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');
    await expect(catchUpMissedPushes('foreground')).resolves.toBe('throttled');
    expect(list).toHaveBeenCalledTimes(1);
  }, 20000);

  it('手動補收不受節流管（用戶自己知道丟了才點）', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');
    await expect(catchUpMissedPushes('manual')).resolves.toBe('drained');
    expect(list).toHaveBeenCalledTimes(2);
  }, 20000);

  it('沒配 Worker 的用戶一個請求都不發', async () => {
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: '' });
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    await expect(catchUpMissedPushes('startup')).resolves.toBe('worker-unset');
    expect(list).not.toHaveBeenCalled();
  }, 20000);

  it('帳本讀不成只是「這趟沒讀成」，不當成「帳本上沒有」', async () => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockRejectedValue(new Error('worker 500'));

    await expect(catchUpMissedPushes('startup')).resolves.toBe('failed');
  }, 20000);
});

// 手動補收那個按鈕報的「補回 N 條消息，去聊天裡看看」必須是真話。
//
// 「寫進收件箱」離「上了屏」還差一整趟沖刷：防穿幫閘會吞、落庫去重會丟、多段等齊會扣。
// 按收件箱那個數報的話，用戶點完按鈕看到「補回 2 條」，翻遍聊天記錄一條也找不到——
// 而這個按鈕存在的全部意義就是讓他確認「消息到底還在不在」。
describe('手動補收報的是真上了屏的條數（走真庫）', () => {
  const WORKER_URL = 'https://amsg-manual-catchup.example.workers.dev';

  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });

  beforeEach(async () => {
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
    resetOutboxCatchUpThrottleForTesting();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: WORKER_URL });
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    // 被吞那條會順手去雲端撤自述日誌（best-effort），別讓它真打網絡。
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: '' });
  });

  /** 帳本上的一條定時主動消息。messageType 用 'scheduled'，走原稿落庫那條最短的路。 */
  const scheduledEntry = (charId: string, messageId: string, occurrenceMs: number) => ({
    id: 1,
    messageId,
    taskUuid: null,
    sessionId: null,
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: null,
    push: {
      messageKind: 'content',
      messageType: 'scheduled',
      source: 'scheduled',
      message: `${charId} 的定時消息`,
      contactName: '定時角色',
      messageId,
      messageIndex: 1,
      totalMessages: 1,
      occurrenceMs,
      timestamp: new Date(occurrenceMs).toISOString(),
      metadata: {
        charId,
        charName: '定時角色',
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: `client-task-${charId}`,
      },
    },
  });

  it('兩條都寫進了收件箱，閘吞掉一條 → 只報 1 條', async () => {
    const swallowedChar = 'char-manual-swallowed';
    const landedChar = 'char-manual-landed';
    await DB.saveCharacter({ id: swallowedChar, name: '定時角色' } as any);
    await DB.saveCharacter({ id: landedChar, name: '定時角色' } as any);

    const occurrenceMs = Date.now();
    // 到點前一分鐘這個角色那邊用戶還在說話 → 防穿幫閘命中，這條不上屏。
    // 另一個角色沒有任何用戶消息，閘判不了、照常放行。
    await DB.saveMessage({
      charId: swallowedChar, role: 'user', type: 'text', content: '我在忙',
      timestamp: occurrenceMs - 60_000,
    } as any);

    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([
      scheduledEntry(swallowedChar, 'msg-manual-swallowed', occurrenceMs),
      scheduledEntry(landedChar, 'msg-manual-landed', occurrenceMs),
    ] as any);

    const { written, scanned, stale } = await catchUpMissedPushesManually();

    expect(scanned, '帳本上翻過兩條').toBe(2);
    expect(stale, '都是剛落帳的，沒有超窗的').toBe(0);
    expect(written, '修復前這裡會報 2 條——閘吞掉的那條也被算成「補回來了」').toBe(1);

    // 數字得跟聊天記錄對得上：被吞的那個角色一條助手消息都不該有。
    const swallowedMsgs = await DB.getRecentMessagesByCharId(swallowedChar, 20);
    expect(swallowedMsgs.some((m: any) => m.role === 'assistant')).toBe(false);
    const landedMsgs = await DB.getRecentMessagesByCharId(landedChar, 20);
    expect(landedMsgs.some((m: any) => m.role === 'assistant')).toBe(true);
  }, 20000);
});
