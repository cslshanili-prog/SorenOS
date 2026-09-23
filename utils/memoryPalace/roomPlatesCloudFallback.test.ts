// utils/memoryPalace/roomPlatesCloudFallback.test.ts
//
// 迴歸守衛（門牌整理交雲端失敗之後往哪走）。兩件事分開釘：
//
//   1. **交不出去** → 退回本地跑，但送達保證當場併入的那些房間不能丟。丟了的話消化
//      日誌會寫「這次一塊門牌都沒動」，而門牌上明明多了幾條——本地那條路末尾的兜底
//      併入是按文本去重的，那批已經在裡面了，它一條也不會再報。
//
//   2. **沒等到答覆**（請求發出去了，答覆丟在路上）→ 任務可能已經在雲端建起來了，
//      這時候絕不能退回本地：那是拿同一份快照燒兩次 API，兩份結果還先後落地互相蓋。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plateCloudGate, submitPlateConsolidation, readPlateJobInFlight, safeFetchJson } = vi.hoisted(() => ({
  plateCloudGate: vi.fn(async () => 'submit' as string),
  submitPlateConsolidation: vi.fn(async () => ({ jobId: 'job-1', uuid: 'remote-uuid' })),
  readPlateJobInFlight: vi.fn(() => null as { jobId: string; at: number; snapshotAt: number } | null),
  // 本地那條路的 LLM 調用。回一份空列表就夠：這裡要看的是「本地這條路跑沒跑」，
  // 以及跑完之後 updated 裡有沒有把已經保底併入的房間報出來。
  safeFetchJson: vi.fn(async () => ({ choices: [{ message: { content: '[]' } }] })),
}));

vi.mock('./roomPlateCloud', () => ({ plateCloudGate, submitPlateConsolidation, readPlateJobInFlight }));
vi.mock('../safeApi', () => ({ safeFetchJson }));
// 身份上下文那段拿不到就裸跑（源碼裡是 try/catch），這裡給個空的省得去碰 IndexedDB。
vi.mock('../db', () => ({ DB: { getAllCharacters: async () => [], getUserProfile: async () => null } }));
vi.mock('../context', () => ({ ContextBuilder: { buildCoreContext: () => '' } }));

const savedPlates: Array<{ room: string; entries: Array<{ text: string }> }> = [];
/** 門牌上本來就有的條目（按房間）。默認全空，個別用例拿它模擬「候選已經在門牌上」。 */
const plateSeed: Record<string, Array<{ id: string; text: string; firstLearnedAt: number; updatedAt: number; sourceCount: number }>> = {};
vi.mock('./db', () => {
  const loadOrCreatePlate = vi.fn(async (charId: string, room: string) => ({
    id: `${charId}:${room}`, charId, room, entries: [...(plateSeed[room] ?? [])], updatedAt: 0, version: 0,
  }));
  const save = vi.fn(async (plate: any) => { savedPlates.push(plate); });
  return {
    MemoryNodeDB: { getByCharId: vi.fn(async () => []) },
    RoomPlateDB: { save },
    loadOrCreatePlate,
    // 真身按門牌排隊串行；這裡只要保住「現讀一份 → 改 → 存回去」這三步。
    mutatePlate: vi.fn(async (charId: string, room: string, change: (p: any) => any) => {
      const next = change(await loadOrCreatePlate(charId, room));
      if (!next) return null;
      await save(next);
      return next;
    }),
  };
});

import { consolidateAllPlates } from './roomPlates';

const LLM = { baseUrl: 'https://light.example.dev/v1', apiKey: 'sk-light', model: 'cheap' };
const SUBMISSIONS = { user_room: ['[居住] 小明搬去和同學合租了'] };

const run = () => consolidateAllPlates('c1', '小滿', '小明', LLM as any, SUBMISSIONS, 0);

beforeEach(() => {
  savedPlates.length = 0;
  for (const room of Object.keys(plateSeed)) delete plateSeed[room];
  plateCloudGate.mockClear().mockResolvedValue('submit');
  submitPlateConsolidation.mockClear().mockResolvedValue({ jobId: 'job-1', uuid: 'remote-uuid' });
  readPlateJobInFlight.mockClear().mockReturnValue(null);
  safeFetchJson.mockClear();
});

describe('交雲端整理之後往哪走', () => {
  it('交出去了 → 報 cloudPending（消化日誌才不會說成「一塊門牌都沒動」）', async () => {
    const result = await run();

    expect(result.cloudPending).toBe(true);
    expect(safeFetchJson, '交出去了就不該在本地再跑一次').not.toHaveBeenCalled();
    // 送達保證是**提交之前**先並進去保底的：雲端最終沒回來，這批也已經在門牌上了
    expect(result.updated).toContain('user_room');
  });

  // `cloudPending` 問的是「門牌等會兒還會不會動」，不是「這一輪交沒交」。上一份還在雲端
  // 跑著的時候，答案同樣是「會」——它幾分鐘後就落地。報 false 的話，候選恰好都已經在門牌
  // 上（送達保證按文本去重、一條都沒並進去）的那次消化，日誌上會寫成「⚠️ 本次提交的候選
  // 未合併進門牌（整理未跑成或未被採納）」，而云端正好好地替我們幹著這件事。
  it('上一份還在跑（skip）→ 只做送達保證，不重複交也不退回本地', async () => {
    plateCloudGate.mockResolvedValue('skip');

    const result = await run();

    expect(submitPlateConsolidation).not.toHaveBeenCalled();
    expect(safeFetchJson).not.toHaveBeenCalled();
    expect(result.updated).toContain('user_room');
    expect(result.cloudPending, '雲端確實有一份在跑，日誌別說成「整理未跑成」').toBe(true);
  });

  // 迴歸守衛：送達保證按文本去重，候選已經在門牌上時一條都不會並進去——`updated` 於是
  // 是空的。這正是上面那個語義唯一會露餡的場合：報 false 就會被消化日誌寫成「整理未跑成」。
  it('上一份還在跑、候選又都已經在門牌上 → 照樣報「結果在路上」', async () => {
    plateCloudGate.mockResolvedValue('skip');
    // 這條候選門牌上已經有了 → 送達保證按文本去重，一條都並不進去。
    plateSeed.user_room = [{
      id: 'pe_0', text: '小明搬去和同學合租了', firstLearnedAt: 1, updatedAt: 1, sourceCount: 1,
    }];

    const result = await run();

    expect(result.updated).toEqual([]);
    expect(result.cloudPending, '一塊門牌沒動 + 不說在路上 = 日誌報「整理未跑成」').toBe(true);
  });

  // 迴歸守衛：**沒更新 Worker 的用戶**走的就是這條。老 bundle 的 /config-check 裡沒有
  // backgroundJobs 這個字段，探測得到「不支持」→ 這一輪壓根不碰雲端，原地在本地把整理
  // 跑完，跟上雲之前一模一樣。這條斷了的話，那批用戶的門牌會徹底停止更新，而界面上
  // 一片正常——最難發現的那種壞法。副 API 沒配、沒填 Worker 地址、沒開主動消息 2.0
  // 也都落在這個出口。
  it('這台 Worker 不認識後台任務（老 bundle）→ 本地照常跑完，不建雲端任務', async () => {
    plateCloudGate.mockResolvedValue('local');

    const result = await run();

    expect(submitPlateConsolidation, '老 worker 會把它當聊天任務跑然後終態失敗').not.toHaveBeenCalled();
    expect(safeFetchJson, '不在本地跑的話，這批用戶的門牌就永遠不更新了').toHaveBeenCalled();
    expect(result.cloudPending, '雲端根本沒接手，別讓日誌說結果在路上').toBeFalsy();
    // 本地這條路的老規矩照舊：LLM 沒給出有效條目時，本輪候選機械兜底併入，不許蒸發。
    expect(result.updated).toContain('user_room');
  });

  it('服務端答覆了「不行」→ 退回本地跑，已經保底併入的房間照樣報出來', async () => {
    submitPlateConsolidation.mockRejectedValueOnce(new Error('worker 說不行'));

    const result = await run();

    expect(safeFetchJson, '交不出去就得退回本地把活兒幹了，不然門牌永遠不更新').toHaveBeenCalled();
    expect(
      result.updated,
      '丟掉的話消化日誌會說「一塊門牌都沒動」，而門牌上明明多了幾條',
    ).toContain('user_room');
    expect(result.cloudPending).toBeFalsy();
  });

  // 迴歸守衛：快照時刻原先是提交那一刻現取的。可門牌是更早讀出來的——中間還夾著拼身份
  // 上下文、過「能不能交雲端」那幾道門（其中一道要發請求）、把消化剛提交的候選先保底並
  // 進去。用戶在這一段裡改的字 LLM 根本沒看到，卻因為 updatedAt 早於提交時刻被判成
  // 「LLM 見過」，結果回來把剛敲的字原樣蓋回去。這裡拿那道門模擬這段耗時。
  it('交上去的快照時刻是「讀門牌那一刻」，不是提交那一刻', async () => {
    let gateEnteredAt = 0;
    plateCloudGate.mockImplementation(async () => {
      gateEnteredAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'submit';
    });

    await run();

    const { snapshotAt } = (submitPlateConsolidation.mock.calls[0] as unknown as [any])[0];
    expect(snapshotAt).toBeGreaterThan(0);
    expect(snapshotAt, '門牌是在過這幾道門之前就讀出來的').toBeLessThanOrEqual(gateEnteredAt);
  });

  it('沒等到答覆（記號還留著）→ 不退回本地，等它回來', async () => {
    submitPlateConsolidation.mockRejectedValueOnce(new Error('Failed to fetch'));
    readPlateJobInFlight.mockReturnValue({ jobId: 'job-1', at: Date.now(), snapshotAt: Date.now() });

    const result = await run();

    expect(
      safeFetchJson,
      '任務可能真在雲端跑著，本地再全量跑一遍就是同一份快照燒兩次 API、兩份結果互相蓋',
    ).not.toHaveBeenCalled();
    expect(result.cloudPending).toBe(true);
    expect(result.updated).toContain('user_room');
  });
});
