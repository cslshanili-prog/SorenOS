// utils/memoryPalace/roomPlateCloud.test.ts
//
// 迴歸守衛（交雲端整理時帶了什麼）。本地端到端跑出來的坑：worker 那邊發給模型的請求體
// 裡只有 model 和 messages，溫度和輸出上限全沒了——本地那條路是 0.3 / 8000，雲端落到
// 供應商默認值。同一批材料兩條路整理出不一樣的門牌，而界面上完全看不出來。
//
// 門牌整理的提示詞、解析、合併已經收在 roomPlateCore 這個葉子裡兩邊共用，採樣參數
// 也是「同一件活兒的一部分」，同樣要從葉子裡取、同樣要送到雲端那條路上。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { scheduleBackgroundJob, probeBackgroundJobSupportDetailed, plateStore, charStore } = vi.hoisted(() => ({
  scheduleBackgroundJob: vi.fn(async () => ({ uuid: 'remote-uuid' })),
  probeBackgroundJobSupportDetailed: vi.fn(async () => 'supported' as string),
  /** 假門牌庫：落地那半截要讀要寫，node 上沒有 IndexedDB。 */
  plateStore: { plates: new Map<string, any>(), saveError: null as Error | null },
  /** 假角色庫：落地前要確認這個角色還在。 */
  charStore: { chars: [{ id: 'c1', name: '小滿' }] as Array<{ id: string; name: string }> },
}));
/** 「這條任務可能已經在遠端建起來了」的標記，跟真身同款（見 activeMsgClient）。 */
const MAYBE_CREATED = '__amsgBackgroundJobMaybeCreated';
vi.mock('../activeMsgClient', () => ({
  ActiveMsgClient: { scheduleBackgroundJob, probeBackgroundJobSupportDetailed },
  mayHaveCreatedBackgroundJob: (error: unknown) =>
    (error as Record<string, unknown> | null)?.['__amsgBackgroundJobMaybeCreated'] === true,
}));
vi.mock('../amsg2ToolBridge', () => ({ isAmsg2GlobalReady: vi.fn(async () => true) }));
// 提交要記一筆「API 調用記錄」，那份最終寫 IndexedDB。這裡只關心提交本身。
vi.mock('../apiCallLog', () => ({
  cloudApiCallLogId: (id: string) => `cloud-${id}`,
  recordCloudApiCall: vi.fn(),
  settleCloudApiCall: vi.fn(),
}));
vi.mock('./db', () => {
  const loadOrCreatePlate = vi.fn(async (charId: string, room: string) =>
    plateStore.plates.get(room) ?? { id: `${charId}:${room}`, charId, room, entries: [], updatedAt: 0, version: 0 });
  const save = vi.fn(async (p: any) => {
    if (plateStore.saveError) throw plateStore.saveError;
    plateStore.plates.set(p.room, p);
  });
  return {
    ROOM_PLATES_UPDATED_EVENT: 'room-plates-updated',
    RoomPlateDB: { get: vi.fn(), save },
    loadOrCreatePlate,
    // 真身按門牌排隊串行，這裡只要保住「現讀一份 → 改 → 存回去」這三步的語義
    // （落庫失敗照拋，閘和冪等那幾條斷言都壓在它上面）。
    mutatePlate: vi.fn(async (charId: string, room: string, change: (p: any) => any) => {
      const next = change(await loadOrCreatePlate(charId, room));
      if (!next) return null;
      await save(next);
      return next;
    }),
    plateId: (charId: string, room: string) => `${charId}:${room}`,
  };
});
// 結果落地前要確認角色還在（刪掉的角色不許被一份遲到的結果重新長出四塊門牌）。
vi.mock('../db', () => ({
  DB: { getAllCharacters: vi.fn(async () => charStore.chars) },
}));
// 落地成功要廣播一條「門牌更新了」，node 上沒有 window。
vi.stubGlobal('window', { dispatchEvent: vi.fn() });

import { PLATE_CONSOLIDATE_KIND, PLATE_CONSOLIDATE_RESULT_KIND } from '../amsgPlateJob';
import { PLATE_LLM_MAX_TOKENS, PLATE_LLM_TEMPERATURE } from './roomPlateCore';
import { recordCloudApiCall, settleCloudApiCall } from '../apiCallLog';
import { RoomPlateDB } from './db';
import {
  applyPlateConsolidateResult,
  clearPlateJobDone,
  clearPlateJobInFlight,
  plateCloudGate,
  readPlateJobInFlightRaw,
  submitPlateConsolidation,
} from './roomPlateCloud';
import type { RoomPlate } from './types';

const LIGHT_LLM = { baseUrl: 'https://light.example.dev/v1', apiKey: 'sk-light', model: 'cheap' };

const plate = (room: RoomPlate['room'], texts: string[]): RoomPlate => ({
  id: `c1:${room}`,
  charId: 'c1',
  room,
  entries: texts.map((text, i) => ({
    id: `pe_${room}_${i}`, text, firstLearnedAt: 1, updatedAt: 1, sourceCount: 1,
  })),
  updatedAt: 1,
  version: 1,
});

const submit = (over: Record<string, unknown> = {}) => submitPlateConsolidation({
  charId: 'c1',
  charName: '小滿',
  userName: '小明',
  identityContext: '（身份上下文）',
  plates: [plate('user_room', ['小明在讀研'])],
  materials: [{ room: 'user_room', lines: ['小明搬去和同學合租了'] }],
  lightLLM: LIGHT_LLM,
  snapshotAt: 1,
  ...over,
} as any);

beforeEach(() => {
  scheduleBackgroundJob.mockClear().mockResolvedValue({ uuid: 'remote-uuid' });
  probeBackgroundJobSupportDetailed.mockClear().mockResolvedValue('supported');
  vi.mocked(settleCloudApiCall).mockClear();
  vi.mocked(recordCloudApiCall).mockClear();
  vi.mocked(RoomPlateDB.save).mockClear();
  plateStore.plates.clear();
  plateStore.saveError = null;
  charStore.chars = [{ id: 'c1', name: '小滿' }];
  clearPlateJobInFlight('c1');
  clearPlateJobDone('c1');
});

/** 本輪提交拿到的 job 編號（提交側自己生成，只能從調用參數裡取）。 */
const lastJobId = (): string => (scheduleBackgroundJob.mock.calls.at(-1) as unknown as [any])[0].jobId;

/** 一份空結果：閘和調用記錄那半截照常走，落庫那半截直接短路（用不著 IDB）。 */
const emptyResult = (jobId: string) => ({
  resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
  v: 1,
  jobId,
  charId: 'c1',
  items: [],
  rooms: [],
});

/** 一份真會落庫的結果：兩塊門牌，各一條。 */
const twoRoomResult = (jobId: string) => ({
  resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
  v: 1,
  jobId,
  charId: 'c1',
  items: [
    { room: 'user_room', text: '小明搬去和同學合租了' },
    { room: 'study', text: '在學做菜' },
  ],
  rooms: [
    { room: 'user_room', entryIds: [] },
    { room: 'study', entryIds: [] },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('交雲端整理', () => {
  it('採樣參數用葉子裡那兩個常量（本地那條路用的是同一份）', async () => {
    await submit();

    const [params] = scheduleBackgroundJob.mock.calls[0] as unknown as [any];
    expect(params.temperature).toBe(PLATE_LLM_TEMPERATURE);
    expect(params.maxTokens).toBe(PLATE_LLM_MAX_TOKENS);
  });

  it('帶上 kind、每塊門牌的條目 id 快照，和記憶宮殿副 API 那行憑據', async () => {
    await submit();

    const [params] = scheduleBackgroundJob.mock.calls[0] as unknown as [any];
    expect(params.kind).toBe(PLATE_CONSOLIDATE_KIND);
    expect(params.credRow.credId).toBe('char:c1/memory');
    expect(params.jobInput.rooms).toEqual([
      { room: 'user_room', entries: ['小明在讀研'], entryIds: ['pe_user_room_0'] },
    ]);
  });

  it('記憶宮殿副 API 沒配齊就不交（不拿主 API 悄悄跑後台活兒）', async () => {
    await expect(submit({ lightLLM: { baseUrl: '', apiKey: '', model: '' } })).rejects.toThrow(/副 API/);
    expect(scheduleBackgroundJob).not.toHaveBeenCalled();
  });
});

// 迴歸守衛：兩次消化捱得近（手動連點、或者一輪聊得快）會先後交兩份 job，而它們拿的是
// 同一份或相鄰的舊快照。後回來那份按自己那份快照做合併，先回來那份的整理成果被整塊蓋掉，
// 還白燒一次 API。
describe('同一角色同時只許一份整理在飛', () => {
  const gate = () => plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM });

  it('交出去之後這個角色的門就關上，而且不是「退回本地跑」', async () => {
    expect(await gate()).toBe('submit');
    await submit();

    expect(await gate(), '退回本地會白燒一次 API，結果還跟在飛那份互相蓋').toBe('skip');
  });

  it('結果回來（記號清掉）之後照常放行', async () => {
    await submit();
    clearPlateJobInFlight('c1');

    expect(await gate()).toBe('submit');
  });

  it('交不出去（worker 認不得後台任務）是 local，不是 skip', async () => {
    probeBackgroundJobSupportDetailed.mockResolvedValue('unsupported');

    expect(await gate()).toBe('local');
  });

  it('服務端答覆了「不行」→ 不留記號（確定沒建成，下一輪還能再試）', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(new Error('worker 說不行'));
    await expect(submit()).rejects.toThrow();

    expect(await gate()).toBe('submit');
    expect(settleCloudApiCall, '這一筆確定沒燒，調用記錄別一直掛著「雲端生成中」')
      .toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  // 迴歸守衛：請求到了服務端、答覆丟在路上。事後才打記號的話這種情形一點痕跡都不留，
  // 任務照跑照扣費，本地卻當它沒交出去——這一輪退回本地再全量跑一遍（同一份快照燒兩次
  // API、兩份結果先後落地互相蓋），那筆燒掉的副 API 調用也進不了「API 調用記錄」。
  it('沒等到答覆 → 記號留著擋住下一輪，那筆調用記錄也不收', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(
      Object.assign(new Error('Failed to fetch'), { [MAYBE_CREATED]: true }),
    );
    await expect(submit()).rejects.toThrow();

    expect(readPlateJobInFlightRaw('c1'), '當成「沒交出去」的話，這一輪會在本地再全量跑一遍').not.toBeNull();
    expect(await gate()).toBe('skip');
    expect(settleCloudApiCall, '任務可能真在跑，別急著把這筆記成失敗').not.toHaveBeenCalled();
  });

  it('那筆調用記錄在發請求之前就落下（答覆丟了也查得到是誰在燒 Key）', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(
      Object.assign(new Error('Failed to fetch'), { [MAYBE_CREATED]: true }),
    );
    await expect(submit()).rejects.toThrow();

    expect(recordCloudApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'cloud-plate-consolidate' }),
    );
  });

  // 結果永遠沒回來（worker 掛了 / 任務被清了）：閘不能一直關著，那筆「雲端生成中」
  // 的調用記錄也不能一直轉圈。
  it('超時之後放行，並把那筆掛著的調用記錄收成失敗', async () => {
    await submit();
    expect(await gate()).toBe('skip');

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);

    expect(await gate()).toBe('submit');
    expect(settleCloudApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
  });

  // 迴歸守衛：在飛那道門原先排在「這條路還通不通」前面，於是一份交出去再沒回來的任務
  // 會讓接下來半小時既不走雲端、也不退回本地——整理一次都不做，而 skip 的語義本來是
  // 「雲端正在替我們幹這件事」。
  it('雲端這條路斷了（worker 認不得後台任務）→ 就算有一份在飛也退回本地', async () => {
    await submit();
    expect(await gate()).toBe('skip');

    probeBackgroundJobSupportDetailed.mockResolvedValue('unsupported');

    expect(await gate(), '路都斷了還 skip 的話，這半小時門牌一次都不整理').toBe('local');
  });

  // 迴歸守衛：探測原先把「問不到」和「問到了、答案是不行」混成同一個 false，而它排在
  // 在飛那道門前面。於是一次代理切換、一次 CF 邊緣抖動、一次 D1 冷啟動超時，就能在任務
  // 還在雲端跑著的時候把這一輪踢回本地——同一份快照燒兩次副 API，兩份結果先後落地互相蓋。
  it('探測這次問不到、但手上有一份在飛 → 不許退回本地', async () => {
    await submit();
    probeBackgroundJobSupportDetailed.mockResolvedValue('unknown');

    expect(await gate(), '任務多半好好地在雲端跑著，這時候退本地就是撞車').toBe('skip');
  });

  it('探測這次問不到、手上也沒有在飛的 → 照常退回本地（別乾等著）', async () => {
    probeBackgroundJobSupportDetailed.mockResolvedValue('unknown');

    expect(await gate()).toBe('local');
  });
});

// 迴歸守衛：一條遲到的（上一份超時之後才姍姍來遲）或者被重放的（銷帳失敗，下次上線又
// 拉回來一遍）結果，會把另一份**真正還在跑**的任務的閘打開——下一輪又交一份上去，兩份
// 帶著各自的舊快照先後落地互相蓋，正是這道閘要防的那種重疊。
describe('結果落地時只認自己那一份在飛記號', () => {
  const gate = () => plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM });

  it('編號對不上的結果不動閘', async () => {
    await submit();
    const jobA = lastJobId();
    clearPlateJobInFlight('c1');   // A 超時被判死
    await submit();                // 換 B 上去，記號 = B
    const jobB = lastJobId();

    await applyPlateConsolidateResult(emptyResult(jobA));

    expect(await gate(), 'B 還在跑，閘被 A 的結果打開就會再交一份 C 上去').toBe('skip');
    expect(readPlateJobInFlightRaw('c1')?.jobId).toBe(jobB);
  });

  it('編號對得上就照常放行', async () => {
    await submit();

    await applyPlateConsolidateResult(emptyResult(lastJobId()));

    expect(await gate()).toBe('submit');
  });

  // 迴歸守衛：閘原先在落庫循環**之前**就放開了。中途某一塊存不進去（IDB 配額、事務被
  // 中斷）這份結果不銷帳、下次上線還會重放，而閘已經開著——期間的消化又交了一份新的
  // 上去，兩份帶著不同的舊快照先後落地互相蓋，正是這道閘要防的那種重疊。
  it('落庫中途炸了 → 閘不放開（這份結果還要重放）', async () => {
    await submit();
    const jobId = lastJobId();
    plateStore.saveError = new Error('IDB 配額滿了');

    await expect(applyPlateConsolidateResult(twoRoomResult(jobId))).rejects.toThrow();

    expect(readPlateJobInFlightRaw('c1')?.jobId, '閘開著的話下一輪又會交一份上去').toBe(jobId);
    expect(await gate()).toBe('skip');
  });

  it('落庫全部走完才放閘', async () => {
    await submit();

    await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(RoomPlateDB.save).toHaveBeenCalledTimes(2);
    expect(readPlateJobInFlightRaw('c1')).toBeNull();
  });
});

// 迴歸守衛：結果那一支刻意跳過了補收那兩天的時效窗（結果晚到本來就是常態），但跳過之後
// 沒換上任何上限。服務端帳本留 28 天——換設備 / 重裝 PWA / 清過 localStorage 的用戶第一次
// 接上帳本時會把這些老結果一次性拉回來，拿一份月前的快照去改寫一塊早被翻過幾十輪的門牌。
describe('躺太久的結果不再落地', () => {
  const daysAgo = (n: number) => Date.now() - n * 24 * 60 * 60 * 1000;

  it('超過一週的直接銷帳丟掉，一塊門牌都不動', async () => {
    await submit();

    const acked = await applyPlateConsolidateResult(twoRoomResult(lastJobId()), { createdAt: daysAgo(8) });

    expect(acked, '留著不銷的話每次上線都拉回來看一眼').toBe(true);
    expect(RoomPlateDB.save).not.toHaveBeenCalled();
  });

  it('一週之內的照常落地（關掉筆記本過個週末不算太久）', async () => {
    await submit();

    await applyPlateConsolidateResult(twoRoomResult(lastJobId()), { createdAt: daysAgo(2) });

    expect(RoomPlateDB.save).toHaveBeenCalled();
  });

  it('不帶時間的（推送直達那條腿）照常落地', async () => {
    await submit();

    await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(RoomPlateDB.save).toHaveBeenCalled();
  });
});

// 迴歸守衛：同一份結果會被送到兩次以上——銷帳那一步失敗（斷網）下次上線還會拉回來，
// 推送直達那條腿收下之後壓根不銷帳、補收時又來一遍。而落地不是冪等的：合併對每條保留
// 下來的條目 sourceCount + 1，那個數字就是門牌面板上的「印證 N 次」。
describe('同一份結果落地一次就夠了', () => {
  it('重放不再動門牌（「印證 N 次」不會跟著重放虛增）', async () => {
    await submit();
    const jobId = lastJobId();

    await applyPlateConsolidateResult(twoRoomResult(jobId));
    const afterFirst = plateStore.plates.get('user_room');
    vi.mocked(RoomPlateDB.save).mockClear();

    const acked = await applyPlateConsolidateResult(twoRoomResult(jobId));

    expect(acked, '留著不銷的話每次上線都重放一遍').toBe(true);
    expect(RoomPlateDB.save, '再合併一遍就是給每條 sourceCount 白加一次').not.toHaveBeenCalled();
    expect(plateStore.plates.get('user_room')).toBe(afterFirst);
  });

  // 落庫中途炸掉的那一次不能記成「落過地了」：帳沒銷、下次上線還會重放，而重放會被冪等
  // 閘擋在門外，剩下那幾塊門牌就再也補不上了。
  it('落庫中途炸了 → 不記帳，重放照樣從頭落一遍', async () => {
    await submit();
    const jobId = lastJobId();
    plateStore.saveError = new Error('IDB 配額滿了');
    await expect(applyPlateConsolidateResult(twoRoomResult(jobId))).rejects.toThrow();

    plateStore.saveError = null;
    vi.mocked(RoomPlateDB.save).mockClear();
    await applyPlateConsolidateResult(twoRoomResult(jobId));

    expect(RoomPlateDB.save).toHaveBeenCalledTimes(2);
  });
});

// 迴歸守衛：刪角色時清的是雲端那份**輸入**，而結果回來說明 LLM 早跑完了、輸入那會兒已經
// 被 worker 自己刪掉。不攔的話，下次上線補收會拿這份結果給一個已經不存在的角色重新建出
// 四塊門牌（loadOrCreatePlate 沒有就現造），裡面裝著那個角色蒸餾出來的全部認知——而刪除
// 確認框跟用戶說的是「記憶將被清空」。
describe('角色已經刪掉的結果不落地', () => {
  it('角色不在了 → 銷帳丟掉，一塊門牌都不新建', async () => {
    await submit();
    const jobId = lastJobId();
    charStore.chars = [];

    const acked = await applyPlateConsolidateResult(twoRoomResult(jobId));

    expect(acked, '留著不銷的話每次上線都來試一遍').toBe(true);
    expect(RoomPlateDB.save, '存進去就是把刪掉的角色的認知又長回來').not.toHaveBeenCalled();
  });

  it('角色庫讀不出來 → 不結論也不落地，帳留著下次再來', async () => {
    await submit();
    const { DB } = await import('../db');
    vi.mocked(DB.getAllCharacters).mockRejectedValueOnce(new Error('IDB 打不開'));

    const acked = await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(acked, '不知道角色還在不在的時候，寧可晚幾分鐘也別往庫裡寫').toBe(false);
    expect(RoomPlateDB.save).not.toHaveBeenCalled();
  });
});

// 迴歸守衛：這一筆原先在落庫**之前**就收成 ok 了。被丟掉的結果（太舊、內容空）在「設置
// → API 調用記錄」裡寫著成功，而它其實白燒了一次副 API；落庫中途炸掉的那次也寫著成功，
// 可一條門牌都沒寫進去。
describe('雲端那筆調用記錄說的是實話', () => {
  const settledOk = () => vi.mocked(settleCloudApiCall).mock.calls.map(([c]) => c.ok);

  it('落庫真的走完了才記成功', async () => {
    await submit();
    await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(settledOk()).toEqual([true]);
  });

  it('躺太久被丟掉的記成失敗（這一筆白燒了）', async () => {
    await submit();
    await applyPlateConsolidateResult(twoRoomResult(lastJobId()), {
      createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });

    expect(settledOk()).toEqual([false]);
  });

  it('落庫中途炸了 → 這一筆先不收（帳沒銷，重放時再照實收）', async () => {
    await submit();
    plateStore.saveError = new Error('IDB 配額滿了');

    await expect(applyPlateConsolidateResult(twoRoomResult(lastJobId()))).rejects.toThrow();

    expect(settledOk(), '記成功的話，用戶會以為門牌已經更新了').toEqual([]);
  });
});

// 迴歸守衛：遠端任務編號原先被 submitPlateConsolidation 返回之後就丟掉了，本地沒有任何
// 地方記著它——刪角色時想撤那條任務都找不到它是哪一行。
describe('遠端任務編號要記在在飛記號上', () => {
  it('交出去之後記號上帶著那條任務的 uuid', async () => {
    scheduleBackgroundJob.mockResolvedValueOnce({ uuid: 'task-uuid-7' });

    await submit();

    expect(readPlateJobInFlightRaw('c1')?.uuid).toBe('task-uuid-7');
  });

  it('沒等到答覆（拿不到 uuid）→ 記號照留，只是沒有編號', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(
      Object.assign(new Error('Failed to fetch'), { [MAYBE_CREATED]: true }),
    );
    await expect(submit()).rejects.toThrow();

    const mark = readPlateJobInFlightRaw('c1');
    expect(mark, '記號是這種情形下唯一的痕跡').not.toBeNull();
    expect(mark?.uuid).toBeUndefined();
  });
});

// 迴歸守衛：「還在飛嗎」原先是個**會改狀態**的判斷——它順手清記號、把那筆調用記錄記成
// 失敗。而它在一輪整理裡會被問到兩次（決定交不交雲端時一次、提交拋錯後判斷「是不是已經
// 建起來了」時一次），TTL 邊界正好落在兩次之間的話，第二次問會就地把閘刪掉，而第一次的
// 決定是照著相反的答案做的。
describe('問「還在飛嗎」不該動任何狀態', () => {
  it('連問兩次答案一樣，也不會順手把記號清掉', async () => {
    await submit();
    const jobId = lastJobId();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);

    const { readPlateJobInFlight } = await import('./roomPlateCloud');
    expect(readPlateJobInFlight('c1')).toBeNull();
    expect(readPlateJobInFlight('c1')).toBeNull();

    expect(readPlateJobInFlightRaw('c1')?.jobId, '判斷本身不該收尾').toBe(jobId);
    expect(settleCloudApiCall).not.toHaveBeenCalled();
  });

  it('收尾是每輪開頭顯式跑一次（plateCloudGate）', async () => {
    await submit();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);

    expect(await plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM })).toBe('submit');
    expect(readPlateJobInFlightRaw('c1')).toBeNull();
    expect(settleCloudApiCall).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});
