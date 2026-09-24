// utils/amsgStateSync.test.ts
// 編排層守衛：打髒 → 立即批量沖刷 → 失敗退避重傳，以及活躍會話租約的起停。
// 關鍵取捨：雲端那份 fire_pack 是角色到點時唯一的上下文來源，傳不上去就意味著它帶著
// 舊上下文發消息，所以失敗的快照必須留在隊列裡等重傳（早期實現發請求前就清空隊列，
// 一次網絡抖動那份快照就永遠沒了）。同時也不能變成無限重排，兩頭都釘住。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    syncCharFirePacks: vi.fn().mockResolvedValue(undefined),
    syncChatPresence: vi.fn().mockResolvedValue(undefined),
    syncToolConfig: vi.fn().mockResolvedValue(undefined),
    listAllTasks: vi.fn().mockResolvedValue([]),
    cancelTask: vi.fn().mockResolvedValue({ uuid: '', alreadyGone: false }),
    clearClientState: vi.fn().mockResolvedValue({ deleted: 0, toolConfigRestored: true }),
    registerPushSubscription: vi.fn().mockResolvedValue(undefined),
    deleteRemotePushSubscription: vi.fn().mockResolvedValue(undefined),
    putLlmCredentials: vi.fn().mockResolvedValue(0),
    deleteLlmCredentials: vi.fn().mockResolvedValue(0),
  },
  // 憑據引用那條路的版本門檻。默認關著，只有專門測它的用例才打開。
  isLlmCredentialsReady: vi.fn().mockResolvedValue(false),
  // 「欠著即時對話回覆」的判定本體住在 activeMsgClient（排程那條路寫 fire_pack 前問的
  // 是同一個）。整個 client 在這兒被換成了假的，所以照它的定義把兩個原始信號接回來，
  // 用例照舊拿 setInstantChatPending 驅動。判定本身怎麼寫由 activeMsgClient.test.ts 釘，
  // 這裡釘的是「沖刷之前會去問它」。
  // 工廠比 import 先跑，這兩個 binding 那會兒還沒初始化——所以只能在調用時才解引用。
  owesInstantChatReply: (charId: string) =>
    !!getInstantChatPending(charId) || isInstantChatSendInFlight(charId),
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import {
  FLUSH_DEBOUNCE_MS,
  AMSG2_PENDING_SYNC_LS_KEY,
  AMSG2_PENDING_CRED_SYNC_LS_KEY,
  AMSG2_PENDING_TOOL_CONFIG_LS_KEY,
  cancelAllRemoteAmsgTasks,
  wipeAmsgCloudData,
  wipeAmsgCloudDataForReset,
  flushAmsgState,
  isWorkerUrlCleared,
  markAmsgStateDirty,
  resumePendingAmsgStateSync,
  startAmsgChatPresence,
  stopAmsgChatPresence,
  syncAmsgLlmCredentials,
  syncAmsgToolConfig,
} from './amsgStateSync';
import {
  buildCharChatCredRow,
  forgetAllCredIds,
  rememberCredRows,
} from './amsgLlmCredentials';
import { DB } from './db';
import { ActiveMsgClient, isLlmCredentialsReady } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  clearInstantChatPending,
  getInstantChatPending,
  isInstantChatSendInFlight,
  setInstantChatPending,
} from './amsgInstantChat';
import type { CharacterProfile } from '../types';

const H = 3600_000;
/**
 * 「一個請求都不該發出」那類用例的觀察窗。
 * 特意開到一級退避（30s）之外：不光要看當場沒發，連「過一會兒才冒出來」的延遲請求
 * 也一併算漏。假時鐘推的，等多久都不花真時間。
 */
const IDLE_WINDOW_MS = 31_000;

/** 帶一個「待觸發的 auto 任務」的角色 —— 過同步門的最小形態。 */
const charWithAiTask = (id: string): CharacterProfile => ({
  id, name: id,
  activeMsg2Config: {
    enabled: true,
    tasks: [{
      taskUuid: `${id}-uuid`, mode: 'auto',
      firstSendTime: new Date(Date.now() + H).toISOString(),
      recurrenceType: 'none', source: 'character', status: 'scheduled', createdAt: Date.now(),
    }],
  },
} as unknown as CharacterProfile);

const snapshotOf = (char: CharacterProfile) => ({
  char, userProfile: {} as any, groups: [], realtimeConfig: undefined,
});

let charSeq = 0;
/** 每個用例用獨立 charId：模塊級 dirty Map 跨用例存活，同 id 會互相干擾。 */
const nextCharId = () => `char-${++charSeq}`;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.removeItem(AMSG2_PENDING_SYNC_LS_KEY);
  localStorage.removeItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  localStorage.removeItem(AMSG2_PENDING_CRED_SYNC_LS_KEY);
  localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
  forgetAllCredIds();
  (ActiveMsgClient.syncCharFirePacks as any).mockClear();
  (ActiveMsgClient.syncChatPresence as any).mockClear();
  (ActiveMsgClient.syncToolConfig as any).mockReset();
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  (ActiveMsgClient.listAllTasks as any).mockReset();
  (ActiveMsgClient.listAllTasks as any).mockResolvedValue([]);
  (ActiveMsgClient.cancelTask as any).mockReset();
  (ActiveMsgClient.cancelTask as any).mockResolvedValue({ uuid: '', alreadyGone: false });
  (ActiveMsgClient.clearClientState as any).mockReset();
  (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 0, toolConfigRestored: true });
  (ActiveMsgClient.registerPushSubscription as any).mockReset();
  (ActiveMsgClient.registerPushSubscription as any).mockResolvedValue(undefined);
  (ActiveMsgClient.deleteRemotePushSubscription as any).mockReset();
  (ActiveMsgClient.deleteRemotePushSubscription as any).mockResolvedValue(undefined);
  (ActiveMsgClient.putLlmCredentials as any).mockReset();
  (ActiveMsgClient.putLlmCredentials as any).mockResolvedValue(0);
  (ActiveMsgClient.deleteLlmCredentials as any).mockReset();
  (ActiveMsgClient.deleteLlmCredentials as any).mockResolvedValue(0);
  (isLlmCredentialsReady as any).mockReset();
  (isLlmCredentialsReady as any).mockResolvedValue(false);
  (ActiveMsgStore.getGlobalConfig as any).mockReset();
  (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: 'https://amsg.example.dev' });
});
afterEach(async () => {
  // 待傳隊列和退避計數都是模塊級的：失敗用例會留下快照 + 一個重排 timer，
  // 不清乾淨會串進下一個用例的批次裡（batch 長度、退避時長都會對不上）。
  // tool_config 的欠帳同理，沖刷會順手把它帶走。
  // 先 mockReset 再給默認實現：用例裡排的 xxxOnce 如果沒被消費掉（比如那幾個手動
  // release 的掛起 Promise 碰上用例中途失敗），會被下面這次收尾沖刷領走然後一直掛著。
  // 現有用例都自己消費乾淨了，這行是給以後寫的人留的保險。
  (ActiveMsgClient.syncCharFirePacks as any).mockReset();
  (ActiveMsgClient.syncCharFirePacks as any).mockResolvedValue(undefined);
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  // 跑兩輪：第一輪沖刷可能觸發補跑（flushing 期間又打髒那條路），第二輪把補跑落下的收乾淨。
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('markAmsgStateDirty 同步門', () => {
  it('沒有待觸發 AI 任務的角色直接忽略（零成本，不排 timer 不發請求）', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('只有 fixed 任務也忽略（fixed 不需要 fire_pack）', async () => {
    const id = nextCharId();
    const fixedOnly = {
      id, name: id,
      activeMsg2Config: {
        enabled: true,
        tasks: [{
          taskUuid: `${id}-uuid`, mode: 'fixed',
          firstSendTime: new Date(Date.now() + H).toISOString(),
          recurrenceType: 'none', source: 'user', status: 'scheduled', createdAt: Date.now(),
        }],
      },
    } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(fixedOnly));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('enabled=false 忽略', async () => {
    const char = charWithAiTask(nextCharId());
    (char.activeMsg2Config as any).enabled = false;
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('沒配 workerUrl → 清空髒標記且不發請求', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    // 沒有去處不算「欠著」：底帳也一起清，別讓下次啟動為它白跑一趟補傳。
    expect(JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]')).not.toContain(char.id);
  });

  it('沖刷失敗 → 快照留在隊列裡，下次沖刷把同一個角色重傳', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await flushAmsgState('test-retry');
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried.map((i: any) => i.char.id)).toEqual([char.id]);
  });

  it('失敗後自動退避重排（30s），不用乾等下一輪聊天', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
  });

  it('重排期間又聊了一輪 → 傳新快照，別被回隊的舊快照蓋回去', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const id = nextCharId();
    const stale = charWithAiTask(id);
    stale.name = '舊快照';
    markAmsgStateDirty(snapshotOf(stale));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    const fresh = charWithAiTask(id);
    fresh.name = '新快照';
    markAmsgStateDirty(snapshotOf(fresh));
    await flushAmsgState('test-retry');

    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried).toHaveLength(1);
    expect(retried[0].char.name).toBe('新快照');
  });

  it('連續失敗到上限後停止重排（離線時不無限排 timer）', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValue(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    // 30s → 60s → 120s 三次重排後放手（快照仍留在隊列裡等下一輪打髒）
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);
  });
});

// 打髒合併窗口迴歸守衛：一輪聊天的多次打髒（收尾 / 情緒落庫 / 記憶寫入）不在同一個
// tick，各自觸發完整沖刷太貴（重讀近史 + 重建提示詞 + 加密 + PUT ~40KB）。第一次打髒起
// FLUSH_DEBOUNCE_MS 內的合併成一次上傳；固定窗口不順延，持續打髒也保證窗口到點必衝。
// 數據丟失窗口沒有回退：底帳在打髒那一刻就寫、切後台立即沖刷、啟動有補傳。
describe('打髒合併窗口', () => {
  it('窗口內不發請求，窗口到點沖刷一次', async () => {
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS - 1);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
  });

  it('窗口內的連環打髒（隔幾個 tick 也算）只合併成一次上傳', async () => {
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    // 情緒 buff 落庫這類晚半秒才來的打髒，也該並進同一次上傳
    await vi.advanceTimersByTimeAsync(500);
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0]).toHaveLength(2);
  });

  it('同一個角色窗口內打兩次髒只傳最新那份', async () => {
    const id = nextCharId();
    const stale = charWithAiTask(id);
    stale.name = '舊快照';
    const fresh = charWithAiTask(id);
    fresh.name = '新快照';

    markAmsgStateDirty(snapshotOf(stale));
    markAmsgStateDirty(snapshotOf(fresh));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    const batch = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].char.name).toBe('新快照');
  });

  it('沖刷進行中再打髒，沖刷完成後自動補跑一次（不擱淺）', async () => {
    // 舊的丟棄式防重入（if (flushing) return）下這條會掛：第二份快照
    // 會一直躺在隊列裡，等不到任何人來傳。
    let release!: () => void;
    (ActiveMsgClient.syncCharFirePacks as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);   // 第一次沖刷掛起中

    const later = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(later));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);   // 撞上 flushing
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0].map((s: any) => s.char.id))
      .toEqual([later.id]);
  });

  it('這次沖刷失敗時不立刻補跑，交給退避重傳（補跑不許白吃退避額度）', async () => {
    let fail!: () => void;
    (ActiveMsgClient.syncCharFirePacks as any).mockImplementationOnce(
      () => new Promise<void>((_, reject) => { fail = () => reject(new Error('worker down')); }),
    );
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));  // 在飛期間又打髒
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    fail();
    await vi.advanceTimersByTimeAsync(0);
    // 立刻補跑只會當場重蹈覆轍；退避重傳本來就會帶上隊列裡的全部快照（含剛打髒那份）
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0]).toHaveLength(2);
  });

  it('退避打光那次沖刷裡打的髒，當場補跑並重開一輪退避', async () => {
    const mock = ActiveMsgClient.syncCharFirePacks as any;
    // 前三次直接失敗，把 30 / 60 / 120 三級退避走完；第四次（額度已經用光那次）掛在
    // 半空，好在它還在飛的時候打一次髒；第五次是補跑，也讓它失敗，用來驗退避從頭重開。
    mock.mockRejectedValueOnce(new Error('offline'));
    mock.mockRejectedValueOnce(new Error('offline'));
    mock.mockRejectedValueOnce(new Error('offline'));
    let failLast!: () => void;
    mock.mockImplementationOnce(
      () => new Promise<void>((_, reject) => { failLast = () => reject(new Error('offline')); }),
    );
    mock.mockRejectedValueOnce(new Error('offline'));

    const doomed = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(doomed));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(mock).toHaveBeenCalledTimes(4);           // 第四次掛在半空

    const later = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(later));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(mock).toHaveBeenCalledTimes(4);           // 撞上 flushing，先記帳

    failLast();
    await vi.advanceTimersByTimeAsync(0);
    // 退避打光那條路不留 timer，沒有別人會來接手 → 這次必須當場補跑，
    // 並把欠著的兩份（回隊的舊帳 + 剛打的新髒）一起帶上。
    expect(mock).toHaveBeenCalledTimes(5);
    expect(mock.mock.calls[4][0].map((s: any) => s.char.id).sort())
      .toEqual([doomed.id, later.id].sort());

    // 補跑再失敗的話退避從 30s 重新起步：既不是接著上一輪的 120s，也不是從此沒人再試。
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mock).toHaveBeenCalledTimes(6);
  });
});

// 欠著即時對話回覆的角色，fire_pack 掛起不傳：那一輪的包是 POST /instant-chat 帶上去
// 的、多一段 chat（worker 到點全靠它），常規重建的包沒有 chat 段，覆蓋上去 worker 到點
// 只會硬失敗。迴歸守衛：沒有這層掛起時，等回覆期間任何一次打髒（改人設 / 群聊 / 表情庫
// 變更）都會把用戶正等著的那條回覆變成「fire_pack 裡沒有 chat 段」。
describe('即時對話掛起（chat 段不許被常規沖刷覆蓋）', () => {
  it('欠著回覆的角色這次不傳；銷帳後回看那一跳把欠的傳掉', async () => {
    const char = charWithAiTask(nextCharId());
    setInstantChatPending(char.id, 'uuid-instant-defer');
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks, '等回覆期間一個包都不許傳').not.toHaveBeenCalled();

    clearInstantChatPending(char.id);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0].map((s: any) => s.char.id))
      .toEqual([char.id]);
  });

  it('同批裡沒欠著的照傳，欠著的不搭車', async () => {
    const owing = charWithAiTask(nextCharId());
    const free = charWithAiTask(nextCharId());
    setInstantChatPending(owing.id, 'uuid-instant-owing');
    markAmsgStateDirty(snapshotOf(owing));
    markAmsgStateDirty(snapshotOf(free));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    const mock = ActiveMsgClient.syncCharFirePacks as any;
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].map((s: any) => s.char.id)).toEqual([free.id]);

    // 收尾：銷帳並讓回看把欠的傳掉，別把掛起的快照留給下一個用例。
    clearInstantChatPending(owing.id);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0].map((s: any) => s.char.id)).toEqual([owing.id]);
  });
});

// 髒標記輕量持久化：localStorage 只存 charId 底帳（快照本體啟動時從 DB 重建）。
// 迴歸守衛：沒有這層持久化時，「打髒 → 請求還沒落地就被殺進程」那份快照就永遠丟了。
describe('髒標記持久化與啟動補傳', () => {
  const readMarks = (): string[] =>
    JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]');

  it('打髒寫入底帳，上傳成功後移除', async () => {
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    expect(readMarks()).toContain(char.id);

    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).not.toContain(char.id);
  });

  it('過不了同步門的角色不寫底帳', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    expect(readMarks()).not.toContain(plain.id);
  });

  it('上傳失敗底帳保留，等重試 / 下次啟動補傳', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });

  it('殺進程模擬：直接構造底帳殘留 → 啟動補傳立即重建上傳並清底帳', async () => {
    // 上次會話只留下 charId（內存隊列已隨進程蒸發），啟動時用 DB 讀回的角色重建快照。
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1); // 補傳當場發，advance 只為讓異步體落地

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    const batch = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0];
    expect(batch.map((i: any) => i.char.id)).toEqual([char.id]);
    expect(readMarks()).not.toContain(char.id);
  });

  it('殘留角色已刪除 / 已關 2.0 → 靜默清除底帳，不發請求', async () => {
    const disabled = charWithAiTask(nextCharId());
    (disabled.activeMsg2Config as any).enabled = false;
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify(['ghost-已刪除', disabled.id]));

    resumePendingAmsgStateSync({ characters: [disabled], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);

    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    expect(readMarks()).toEqual([]);
  });

  it('補傳失敗底帳不丟：留給退避重試 / 再下次啟動', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });
});

// 迴歸守衛：tool_config（搜索/Notion/飛書/MCP 憑據、代理地址）以前是「單發即忘」——
// 一句 `.catch(() => {})` 就沒了，也沒有底帳。它又不像 fire_pack 那樣每輪聊天重傳，
// 傳丟一次雲端就永遠是舊的：用戶刪掉的 MCP 服務器，worker 半夜照舊帶著舊 token 直連。
describe('工具憑據（tool_config）的重試與底帳', () => {
  const readMark = () => localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  const config = { weatherEnabled: true } as any;

  it('傳成功 → 只發一次請求，底帳清空', async () => {
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config);
    expect(readMark()).toBeNull();
  });

  it('傳失敗 → 底帳留存，退避 30s 後自動重傳，成功即清帳', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValueOnce(new Error('worker down'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(readMark()).toBe('1');

    await vi.advanceTimersByTimeAsync(30_000 + 100);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(2);
    expect(readMark()).toBeNull();
  });

  it('退避打光仍失敗 → 底帳不丟，下次沖刷接著補', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValue(new Error('offline'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(4);
    expect(readMark()).toBe('1');

    // 網絡回來了：下一次 fire_pack 沖刷順手把它帶上去
    (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
    await flushAmsgState('test');
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(5);
    expect(readMark()).toBeNull();
  });

  it('沒配 workerUrl → 不發請求，底帳也不留（沒有去處不算欠著）', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).not.toHaveBeenCalled();
    expect(readMark()).toBeNull();
  });

  it('殺進程模擬：底帳殘留 → 啟動補傳用當前配置傳一次並清帳', async () => {
    localStorage.setItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY, '1');
    resumePendingAmsgStateSync({
      characters: [], userProfile: {} as any, groups: [], realtimeConfig: config,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config);
    expect(readMark()).toBeNull();
  });

  it('上傳期間配置又改了 → 不拿舊那份的成功去清新的欠帳', async () => {
    let release: () => void = () => {};
    (ActiveMsgClient.syncToolConfig as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    const newer = { weatherEnabled: false } as any;
    syncAmsgToolConfig(newer);          // 上一次還沒回來
    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(readMark()).toBe('1');       // 新的那份還欠著
    await flushAmsgState('test');
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenLastCalledWith(newer);
    expect(readMark()).toBeNull();
  });
});

// 迴歸守衛：清空 Worker 地址以前是靜默存盤。前端這邊一切同步停擺，D1 裡的任務卻一條
// 沒少——cron 每分鐘照常消費、照燒 LLM 照推送，用戶以為自己關掉了一切。
describe('清空 Worker 地址前的收尾', () => {
  it('只有「從非空變空」才觸發取消流程', () => {
    expect(isWorkerUrlCleared('https://amsg.example.dev', '')).toBe(true);
    expect(isWorkerUrlCleared('https://amsg.example.dev', '   ')).toBe(true);
    // 換地址、首次填寫、本來就空：都不是「關掉」
    expect(isWorkerUrlCleared('https://a.dev', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', '')).toBe(false);
    expect(isWorkerUrlCleared(undefined, undefined)).toBe(false);
  });

  it('逐個取消遠端任務，單條失敗不拖累其餘', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([
      { uuid: 'u1' }, { uuid: 'u2' }, { uuid: 'u3' }, { notAUuid: true },
    ]);
    (ActiveMsgClient.cancelTask as any).mockImplementation(async (uuid: string) => {
      if (uuid === 'u2') throw new Error('worker 503');
      return { uuid, alreadyGone: false };
    });

    const result = await cancelAllRemoteAmsgTasks();

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ total: 3, failed: 1, listed: true });
  });

  it('清單都讀不到 → listed:false，交給界面提示「遠端可能還掛著」', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('unauthorized'));

    const result = await cancelAllRemoteAmsgTasks();

    expect(result.listed).toBe(false);
    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
  });

  // 這一條刻意跟角色級的 ActiveMsgClient.cancelAllTasksForChar 反著來：那邊放過即時對話的
  // 行（關掉角色的 2.0 開關不該掐掉用戶正等著的那輪聊天），這邊兩個調用方要的都是
  // 「我不跟這台 worker 來往了」——地址一清，回覆推回來這邊也接不住；雲端數據一清，
  // 角色上下文沒了，那一跳到點也只會硬失敗，留著只是多一條要等 7 天才自動消失的失敗行。
  it('正在跑的即時對話也一併取消（這裡的「全部」是字面意思）', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([
      { uuid: 'u-scheduled', messageSubtype: 'chat' },
      { uuid: 'u-instant', messageSubtype: 'instant-chat' },
    ]);

    const result = await cancelAllRemoteAmsgTasks();

    expect((ActiveMsgClient.cancelTask as any).mock.calls.map((call: unknown[]) => call[0]))
      .toEqual(['u-scheduled', 'u-instant']);
    expect(result).toEqual({ total: 2, failed: 0, listed: true });
  });
});

describe('清空雲端數據', () => {
  // 這一組守的是同一條：四樣各清各的，誰失敗都不許短路後面幾樣。
  // 換過 AMSG_MASTER_KEY 之後舊密文全解不開，而「列任務」要逐條解密、必然最先炸，
  // 偏偏這時候最需要被清掉的是 client_state —— 串行短路的話用戶一樣都清不成。
  it('任務清單讀不出來時，角色上下文 / 憑據行 / 推送訂閱照樣收拾乾淨', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('decryption failed'));
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 7, toolConfigRestored: true });
    (ActiveMsgClient.deleteLlmCredentials as any).mockResolvedValue(5);

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks.listed).toBe(false);
    expect(ActiveMsgClient.clearClientState).toHaveBeenCalledTimes(1);
    expect(result.stateDeleted).toBe(7);
    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({ all: true });
    expect(result.llmCredentialsDeleted).toBe(5);
    expect(ActiveMsgClient.registerPushSubscription).toHaveBeenCalledTimes(1);
    expect(result.push).toBe('reregistered');
  });

  it('憑據行刪不掉時，前後幾樣照樣各清各的', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }]);
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 2, toolConfigRestored: true });
    // 老 worker 上根本沒有這張表，這一步註定失敗——它一個人失敗不能把別的三樣拖下水。
    (ActiveMsgClient.deleteLlmCredentials as any).mockRejectedValue(new Error('NOT_FOUND'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks).toEqual({ total: 1, failed: 0, listed: true });
    expect(result.stateDeleted).toBe(2);
    expect(result.llmCredentialsDeleted).toBeNull();
    expect(result.push).toBe('reregistered');
  });

  it('角色上下文清不掉時，憑據行照樣刪（這一步排在它後面，不能被短路）', async () => {
    (ActiveMsgClient.clearClientState as any).mockRejectedValue(new Error('boom'));
    (ActiveMsgClient.deleteLlmCredentials as any).mockResolvedValue(3);

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: false });

    expect(result.stateDeleted).toBeNull();
    expect(result.llmCredentialsDeleted).toBe(3);
  });

  it('角色上下文清不掉時，任務照樣取消、推送訂閱照樣收拾', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }, { uuid: 'u-2' }]);
    (ActiveMsgClient.clearClientState as any).mockRejectedValue(new Error('boom'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledTimes(2);
    expect(result.tasks).toEqual({ total: 2, failed: 0, listed: true });
    expect(result.stateDeleted).toBeNull();
    expect(result.toolConfigRestored).toBe(false);
    expect(result.push).toBe('reregistered');
  });

  it('推送訂閱收拾不了也不影響前兩樣的結果', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }]);
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 3, toolConfigRestored: true });
    (ActiveMsgClient.registerPushSubscription as any).mockRejectedValue(new Error('no permission'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks).toEqual({ total: 1, failed: 0, listed: true });
    expect(result.stateDeleted).toBe(3);
    expect(result.push).toBe('failed');
  });

  // 本機沒訂閱還去 registerPushSubscription 的話，會當場向用戶要通知權限——
  // 「清空數據」不該順手彈權限框，刪掉雲端那行留白就是對的。
  it('本機沒有推送訂閱時只刪雲端那行，不去重新登記', async () => {
    const result = await wipeAmsgCloudData(undefined, { pushRegistered: false });

    expect(ActiveMsgClient.deleteRemotePushSubscription).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.registerPushSubscription).not.toHaveBeenCalled();
    expect(result.push).toBe('deleted');
  });
});

describe('重置全部數據的雲端收尾', () => {
  // 這一組守的是「重置之後雲端不會繼續跑」。刪庫把 worker 地址一起帶走了，本地再沒有
  // 任何東西夠得著那台 worker，所以雲端這一步必須排在刪庫之前、而且結果要如實回報。
  it('沒配過 worker 時一個請求都不發', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });

    const result = await wipeAmsgCloudDataForReset();

    expect(result).toEqual({ status: 'skipped' });
    expect(ActiveMsgClient.listAllTasks).not.toHaveBeenCalled();
    expect(ActiveMsgClient.clearClientState).not.toHaveBeenCalled();
  });

  it('清乾淨了回 cleared，而且不補傳工具憑據、不重新登記推送', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }]);
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 4, toolConfigRestored: false });

    const result = await wipeAmsgCloudDataForReset();

    expect(result).toEqual({ status: 'cleared' });
    // 本地緊接著就要刪庫，補上去的憑據誰也不會再讀，登記的推送也沒人接得住。
    expect(ActiveMsgClient.clearClientState).toHaveBeenCalledWith(undefined, { restoreToolConfig: false });
    expect(ActiveMsgClient.registerPushSubscription).not.toHaveBeenCalled();
    expect(ActiveMsgClient.deleteRemotePushSubscription).toHaveBeenCalledTimes(1);
  });

  it('任務清單讀不出來算沒清乾淨，把 worker 地址帶回去給用戶', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('decryption failed'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.workerUrl).toBe('https://amsg.example.dev');
    expect(result.detail).toContain('任務清單');
  });

  it('有任務取消失敗也算沒清乾淨（它們會繼續到點燒 API 額度）', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }, { uuid: 'u-2' }]);
    (ActiveMsgClient.cancelTask as any)
      .mockResolvedValueOnce({ uuid: 'u-1', alreadyGone: false })
      .mockRejectedValueOnce(new Error('offline'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.detail).toContain('1 個定時任務');
  });

  it('角色上下文清不掉算沒清乾淨（那是聊天原文）', async () => {
    (ActiveMsgClient.clearClientState as any).mockRejectedValue(new Error('boom'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.detail).toContain('角色上下文');
  });

  // 老 worker 上壓根沒有憑據表，這一步註定失敗。拿它當判據會把一批根本沒東西可清的人
  // 堵在重置門口，所以它只記一筆、不攔著重置。
  it('憑據行刪不掉不算沒清乾淨', async () => {
    (ActiveMsgClient.deleteLlmCredentials as any).mockRejectedValue(new Error('NOT_FOUND'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result).toEqual({ status: 'cleared' });
  });
});

// 雲端那張憑據表和 tool_config 處境一樣：只在保存配置那一刻傳一次，丟了沒人補。
// 而它丟了的後果更硬——已排程的任務到點還在用舊 Key，用戶只看到「主動消息不來了」。
describe('LLM 憑據行的後台重傳', () => {
  const API = { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-new', model: 'gpt-x' } as any;
  const CHAR = {
    id: 'char-cred-sync',
    name: '小滿',
    activeMsg2Config: { enabled: true, tasks: [] },
  } as any as CharacterProfile;

  const primeLedgerWithOldKey = () => {
    // 底帳裡記著這一行「傳過了」，但記的是舊 Key 的指紋 → 現在算出來就是「變了」。
    rememberCredRows([buildCharChatCredRow(
      CHAR as any, CHAR.activeMsg2Config as any, { baseUrl: API.baseUrl, apiKey: 'sk-old', model: API.model } as any,
    )!]);
  };

  beforeEach(() => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([CHAR] as any);
  });

  it('worker 不支持憑據表 → 一個請求都不發，也不留欠帳', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(false);
    primeLedgerWithOldKey();

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);

    expect(ActiveMsgClient.putLlmCredentials).not.toHaveBeenCalled();
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBeNull();
  });

  it('換了 Key → 把底帳裡那幾行按新配置重算後傳上去', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    primeLedgerWithOldKey();

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);

    const rows = (ActiveMsgClient.putLlmCredentials as any).mock.calls[0][0];
    expect(rows).toEqual([{
      credId: 'char:char-cred-sync/chat',
      value: {
        apiUrl: 'https://api.example.dev/v1/chat/completions',
        apiKey: 'sk-new',
        primaryModel: 'gpt-x',
      },
    }]);
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY), '傳上去了就該銷帳').toBeNull();
  });

  it('這次保存沒動 API → 值沒變，不白發一次請求', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    rememberCredRows([buildCharChatCredRow(CHAR as any, CHAR.activeMsg2Config as any, API)!]);

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);

    expect(ActiveMsgClient.putLlmCredentials).not.toHaveBeenCalled();
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBeNull();
  });

  it('傳失敗 → 退避重傳，欠帳留在 localStorage 等啟動補', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    primeLedgerWithOldKey();
    (ActiveMsgClient.putLlmCredentials as any).mockRejectedValue(new Error('offline'));

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBe('1');

    await vi.advanceTimersByTimeAsync(30_000 + 10);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledTimes(2);
  });

  it('啟動補傳：上次沒傳成的按底帳重來一次（沒給 apiConfig 就跳過這一項）', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    primeLedgerWithOldKey();
    localStorage.setItem(AMSG2_PENDING_CRED_SYNC_LS_KEY, '1');

    resumePendingAmsgStateSync({ characters: [], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).not.toHaveBeenCalled();

    resumePendingAmsgStateSync({ characters: [], userProfile: {} as any, groups: [], apiConfig: API });
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledTimes(1);
  });
});

describe('活躍會話租約', () => {
  it('啟動立即寫一次，之後按心跳間隔續租；stop 後不再續', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);

    stopAmsgChatPresence(charId);
    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS * 3);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);
  });

  it('同角色重入只刷新時間戳，不疊第二個心跳', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2); // 兩次立即寫

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    // 只有一個 timer 在跑 → 只多一次，而不是兩次
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(3);
    stopAmsgChatPresence(charId);
  });
});
