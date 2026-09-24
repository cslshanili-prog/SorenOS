// utils/amsg2CharCleanup.test.ts
// 迴歸守衛：刪角色時那份雲端 client_state 必須跟著清掉。
//
// 實測漏過一次：刪掉一個測試角色之後，D1 裡仍然留著 `amsg:char:<id>/fire_pack`（32KB）
// 和 `tool_pack`。fire_pack 裡是完整角色系統提示詞 + 最近 30 條對話原文，而刪除確認框
// 跟用戶說的是「記憶將被清空」——留著就是把聊天記錄晾在雲端。
//
// 同時釘住幾條邊界，別為了清得乾淨把刪角色搞壞：
//   1. 從沒打開過 2.0 面板的角色（activeMsg2Config 缺失）也要清——全局即時對話開著時
//      它每輪聊天都在往雲端寫完整對話，按「配沒配過」猜就是把聊天原文永久留在 D1 裡；
//   2. 壓根沒填 worker 地址時不發（雲端從來沒寫過東西，報「清理失敗」是嚇唬人）；
//   3. 清不掉（斷網 / worker 掛了）只回報結果，絕不拋錯阻塞刪除。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    clearCharClientState: vi.fn(),
    deleteLlmCredentials: vi.fn(async () => undefined),
    clearClientStateValue: vi.fn(async () => undefined),
    cancelTask: vi.fn(async (uuid: string) => ({ uuid, alreadyGone: false })),
  },
}));

let workerUrl = 'https://amsg.example.workers.dev';
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: async () => ({ workerUrl }) },
}));

const { inFlight } = vi.hoisted(() => ({
  inFlight: { current: null as { jobId: string; at: number; snapshotAt: number; uuid?: string } | null },
}));
vi.mock('./memoryPalace/roomPlateCloud', () => ({
  readPlateJobInFlightRaw: vi.fn(() => inFlight.current),
  clearPlateJobInFlight: vi.fn(),
  clearPlateJobDone: vi.fn(),
}));
vi.mock('./apiCallLog', () => ({
  cloudApiCallLogId: (id: string) => `cloud-${id}`,
  settleCloudApiCall: vi.fn(),
}));

import { charMayHaveCloudState, disableScheduleCharPurge, purgeCharCloudState } from './amsg2CharCleanup';
import { ActiveMsgClient } from './activeMsgClient';
import { settleCloudApiCall } from './apiCallLog';
import type { CharacterProfile } from '../types';

const charWith = (
  config: CharacterProfile['activeMsg2Config'],
): CharacterProfile => ({ id: 'char-1', name: '測試角色', activeMsg2Config: config } as CharacterProfile);

const clearMock = () => ActiveMsgClient.clearCharClientState as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  workerUrl = 'https://amsg.example.workers.dev';
  inFlight.current = null;
  vi.mocked(settleCloudApiCall).mockClear();
  vi.mocked(ActiveMsgClient.cancelTask).mockClear();
  vi.mocked(ActiveMsgClient.clearClientStateValue).mockClear();
  vi.mocked(ActiveMsgClient.deleteLlmCredentials).mockClear();
  clearMock().mockReset();
  clearMock().mockResolvedValue(['fire_pack', 'tool_pack']);
});

describe('purgeCharCloudState', () => {
  it('配過 amsg2 的角色 → 按角色 id 清雲端', async () => {
    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(clearMock()).toHaveBeenCalledWith('char-1');
    expect(result).toEqual({ status: 'cleared', keys: ['fire_pack', 'tool_pack'] });
  });

  it('沒有待觸發任務了也照清（fire_pack 按角色存，任務發完它還在雲端）', async () => {
    await purgeCharCloudState(charWith({ enabled: true }));
    expect(clearMock()).toHaveBeenCalledTimes(1);
  });

  it('用戶關掉了 2.0 也照清（關閉只取消任務，不清雲端那份上下文）', async () => {
    await purgeCharCloudState(charWith({ enabled: false }));
    expect(clearMock()).toHaveBeenCalledTimes(1);
  });

  // Bug 迴歸守衛：全局即時對話開著時，從沒打開過 2.0 面板的角色（activeMsg2Config
  // 缺失、跟隨全局默認開）每輪聊天都會經 POST /instant-chat 把完整對話寫進雲端
  // client_state。以前這裡看「配沒配過」直接 skip，一個清理請求都不發——該角色的
  // 聊天原文（含圖片 base64）就永久留在 D1 裡，刪除確認框「記憶將被清空」落空。
  it('從沒配過 amsg2 的角色 → 只要 worker 配置在就照清（即時對話可能寫過雲端）', async () => {
    const result = await purgeCharCloudState({ id: 'char-2', name: '路人' } as CharacterProfile);
    expect(clearMock()).toHaveBeenCalledWith('char-2');
    expect(result).toEqual({ status: 'cleared', keys: ['fire_pack', 'tool_pack'] });
  });

  it('角色本身找不到（併發刪兩次）→ 同樣不發請求', async () => {
    const result = await purgeCharCloudState(undefined);
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  // 「壓根沒配 worker 連接」是唯一的 skip 理由：沒有地址就沒有云端，一個字節都沒寫過。
  it('沒填 worker 地址 → 跳過，不發請求也不報失敗（雲端壓根沒寫過東西）', async () => {
    workerUrl = '';
    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  it('worker 地址只有空白字符 → 同樣跳過', async () => {
    workerUrl = '   ';
    await expect(purgeCharCloudState(charWith({ enabled: true })))
      .resolves.toEqual({ status: 'skipped' });
    expect(clearMock()).not.toHaveBeenCalled();
  });

  it('沒配過 2.0 的角色 + 全局也沒配 worker → 才是真的沒雲端，跳過', async () => {
    workerUrl = '';
    const result = await purgeCharCloudState({ id: 'char-3', name: '路人乙' } as CharacterProfile);
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  it('清不掉（斷網 / worker 掛了）→ 不拋錯，把失敗交給調用方提示', async () => {
    const boom = new Error('worker down');
    clearMock().mockRejectedValue(boom);

    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(result).toEqual({ status: 'failed', error: boom });
  });

  // 迴歸守衛：刪角色會把在飛記號清掉，而那個記號是本地唯一記著 job 編號的地方。清完就
  // 沒人再去收「設置 → API 調用記錄」裡那筆「雲端生成中」——它會一直轉圈到 5 天后被裁掉，
  // 用戶分不清是還在跑還是早就沒了。在飛記號超時那條路特意繞開的就是這個坑。
  it('刪角色時把那筆掛著的「雲端生成中」收成失敗', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1 };

    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(settleCloudApiCall).toHaveBeenCalledWith({ id: 'cloud-job-9', ok: false });
  });

  it('沒有在飛的整理就不多收一筆', async () => {
    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(settleCloudApiCall).not.toHaveBeenCalled();
  });

  // 迴歸守衛：原先只撤輸入、不動任務行。任務到點照樣起跑、照著重試梯子重來幾輪（讀到
  // 空值會安靜跳過，但每一輪都是一次調度），而它已經沒有任何落腳點了。遠端任務編號原先
  // 壓根沒往本地記，所以想撤也撤不了。
  it('在飛那份的遠端任務要真的取消掉，不只是撤輸入', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1, uuid: 'task-uuid-9' };

    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith('task-uuid-9');
    expect(ActiveMsgClient.clearClientStateValue).toHaveBeenCalled();
  });

  it('取消任務失敗（遠端掛了）→ 輸入照撤，也不攔著角色刪掉', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1, uuid: 'task-uuid-9' };
    vi.mocked(ActiveMsgClient.cancelTask).mockRejectedValueOnce(new Error('worker down'));

    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(ActiveMsgClient.clearClientStateValue).toHaveBeenCalled();
    expect(result.status).toBe('cleared');
  });

  // 提交的答覆丟在路上時拿不到遠端編號（任務可能建了、編號卻沒回來）。那種只能等它自己
  // 跑完——讀到空輸入會安靜跳過。別為了取消它去猜一個 uuid。
  it('沒記下遠端編號的（答覆丟了）→ 不取消，輸入照撤', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1 };

    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
    expect(ActiveMsgClient.clearClientStateValue).toHaveBeenCalled();
  });

  it('雲端本來就是空的 → cleared + 空清單（不是失敗）', async () => {
    clearMock().mockResolvedValue([]);
    await expect(purgeCharCloudState(charWith({ enabled: true })))
      .resolves.toEqual({ status: 'cleared', keys: [] });
  });

  it('默認走全量清單：四行憑據全刪、在飛的門牌整理也撤', async () => {
    inFlight.current = { jobId: 'job-1', at: Date.now(), snapshotAt: Date.now(), uuid: 'u-plate' };
    await purgeCharCloudState(charWith({ enabled: true }));

    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({
      credIds: ['char:char-1/chat', 'char:char-1/instant', 'char:char-1/emotion', 'char:char-1/memory'],
    });
    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith('u-plate');
  });
});

// 關掉定時主動消息 ≠ 刪角色：即時對話和記憶宮殿的後台活兒可能還活著，照刪角色那套
// 清一遍，清掉的是別人正在用的東西。這一組釘的就是兩份清單的分界。
describe('關掉定時主動消息時的清單', () => {
  it('即時對話已經不生效：連上下文一起清，但記憶宮殿那行憑據和在飛的後台活兒不碰', async () => {
    inFlight.current = { jobId: 'job-1', at: Date.now(), snapshotAt: Date.now(), uuid: 'u-plate' };

    const result = await purgeCharCloudState(
      charWith({ enabled: false }),
      disableScheduleCharPurge(false),
    );

    expect(clearMock()).toHaveBeenCalledWith('char-1');
    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({
      credIds: ['char:char-1/chat', 'char:char-1/instant', 'char:char-1/emotion'],
    });
    // 門牌整理跟主動消息是兩條獨立的路，關掉這個不該把那個也弄停。
    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
    expect(result.status).toBe('cleared');
  });

  it('即時對話還開著：上下文是活的（每輪聊天都會重寫），只收掉定時任務那行憑據', async () => {
    await purgeCharCloudState(charWith({ enabled: false }), disableScheduleCharPurge(true));

    expect(clearMock()).not.toHaveBeenCalled();
    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({
      credIds: ['char:char-1/chat'],
    });
  });

  it('沒填 worker 地址時照樣一個請求都不發', async () => {
    workerUrl = '';
    const result = await purgeCharCloudState(charWith({ enabled: false }), disableScheduleCharPurge(false));

    expect(result).toEqual({ status: 'skipped' });
    expect(ActiveMsgClient.deleteLlmCredentials).not.toHaveBeenCalled();
  });
});

describe('charMayHaveCloudState', () => {
  // 不做按角色的 capability 預檢：即時對話會替「從沒配過 2.0」的角色寫雲端，
  // 猜漏一條寫入路就是漏清。角色在就當可能有，真正的門是「配沒配 worker 連接」。
  it('角色存在就當可能有云端數據（不看 activeMsg2Config）', () => {
    expect(charMayHaveCloudState(charWith({ enabled: true }))).toBe(true);
    expect(charMayHaveCloudState(charWith({ enabled: false }))).toBe(true);
    expect(charMayHaveCloudState({ id: 'x', name: 'x' } as CharacterProfile)).toBe(true);
    expect(charMayHaveCloudState(undefined)).toBe(false);
  });
});
