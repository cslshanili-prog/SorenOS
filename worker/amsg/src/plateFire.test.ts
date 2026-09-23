// worker/amsg/src/plateFire.test.ts
// 後台任務（`metadata.amsgKind`）這條路的迴歸守衛。
//
// 這條路存在的意義就是「繞開聊天那一整套」，所以最該釘住的不是它做了什麼，而是它
// **沒被什麼擋住**：聊天那四道門（活躍會話租約 / fire_pack 必須在場 / 防穿幫閘 /
// 任務指令必填）一道都不該攔它，onLLMOutput 的 stash 斷言也不該攔它。分派點往後挪
// 一行，這些用例就會掛。
import { describe, it, expect, vi } from 'vitest';

import { amsgHooks } from './index';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { packStateValue } from '../../../utils/amsgFirePack';
import {
  PLATE_CONSOLIDATE_KIND,
  PLATE_CONSOLIDATE_RESULT_KIND,
  buildPlateJobInput,
  plateJobKey,
} from '../../../utils/amsgPlateJob';
import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE, AMSG_TASK_KIND_KEY } from '../../../utils/amsgTaskKinds';
import { PLATE_LLM_TIMEOUT_MS } from '../../../utils/memoryPalace/roomPlateCore';

const CHAR_ID = 'preset-nyah';
const JOB_ID = 'job-0001';
const NOW = new Date('2026-08-15T12:00:00.000Z');

const jobInput = (overrides: Record<string, unknown> = {}) => buildPlateJobInput({
  charId: CHAR_ID,
  charName: 'Nyah',
  userName: '小明',
  identityContext: '（身份上下文）',
  rooms: [
    { room: 'user_room', entries: ['小明在讀研'], entryIds: ['pe_a'] },
    { room: 'bedroom', entries: [], entryIds: [] },
  ],
  materials: [{ room: 'user_room', lines: ['小明這週搬去和同學合租了'] }],
  ...overrides,
} as any);

/**
 * 造一份跑門牌任務用的 ctx。
 * charRows 默認是**空的**——後台任務不傳 fire_pack / tool_pack，這正是要釘的點。
 */
const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  jobValue?: string | null;
  charRows?: Array<{ key: string; value: string }>;
} = {}) => {
  const jobRows = opts.jobValue === null
    ? []
    : [{ key: plateJobKey(JOB_ID), value: opts.jobValue! }];
  const readState = vi.fn(async (namespace: string) => {
    if (namespace === AMSG_JOB_NAMESPACE) return jobRows;
    if (namespace.startsWith('amsg:char:')) return opts.charRows ?? [];
    return [];
  });
  const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 1 }));
  const scratch: Record<string, unknown> = {};
  return {
    ctx: {
      task: {
        id: 7,
        uuid: 'task-uuid-plate',
        contactName: 'Nyah',
        recurrenceType: 'none',
        nextSendAt: NOW.toISOString(),
        metadata: {
          charId: CHAR_ID,
          [AMSG_TASK_KIND_KEY]: PLATE_CONSOLIDATE_KIND,
          [AMSG_JOB_ID_KEY]: JOB_ID,
          ...opts.metadata,
        },
      },
      userId: 'u1',
      readState,
      writeState,
      now: NOW,
      scratch,
    } as any,
    scratch,
    readState,
    writeState,
  };
};

const makeSessionCtx = (scratch: Record<string, unknown>, llmOutputText: string) => {
  const emitResult = vi.fn(async () => ({ messageId: 'm1', pushed: false }));
  const writeState = vi.fn(async () => ({ upserted: 0, skipped: 0, deleted: 1 }));
  return {
    ctx: {
      sessionId: 'sess-1',
      llmResponse: {},
      llmOutputText,
      contactName: 'Nyah',
      metadata: {},
      scratch,
      writeState,
      emitResult,
      taskId: 7,
      taskUuid: 'task-uuid-plate',
      occurrenceMs: NOW.getTime(),
    } as any,
    emitResult,
    writeState,
  };
};

const REPLY = JSON.stringify([
  { room: 'user_room', text: '小明在讀研，最近搬去和同學合租', basedOn: 'U0', tag: '居住' },
]);

describe('後台任務分派：聊天那幾道門一道都不該攔它', () => {
  it('沒有 fire_pack 也照跑（聊天那條路在這兒是硬失敗）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    const result = await amsgHooks.onBeforeFire(ctx) as { messages: Array<{ role: string; content: string }> };

    expect(result).toHaveProperty('messages');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    // 提示詞確實是門牌那份（現有條目帶標籤、新材料在裡面）
    expect(result.messages[0].content).toContain('[U0] 小明在讀研');
    expect(result.messages[0].content).toContain('小明這週搬去和同學合租');
  });

  it('用戶正在聊天（活躍會話租約新鮮）也照跑——後台整理不發消息，不用讓路', async () => {
    const presence = JSON.stringify({
      v: 1, charId: CHAR_ID, activeAt: NOW.getTime(), lastUserMessageAt: NOW.getTime(),
    });
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      charRows: [{ key: AMSG_CHAT_PRESENCE_KEY, value: presence }],
      metadata: { amsgExpirePolicy: 'expire' },
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(result).toHaveProperty('messages');
  });

  it('沒有 amsgTaskInstruction 也照跑（那是主動消息才要的東西）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    expect(ctx.task.metadata.amsgTaskInstruction).toBeUndefined();
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toHaveProperty('messages');
  });

  it('不認識的 kind 硬失敗，報錯裡說得出該幹什麼', async () => {
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      metadata: { [AMSG_TASK_KIND_KEY]: 'something-new' },
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/不[认認][识識]的任[务務][种種][类類].*重新部署/s);
  });

  it('沒標 kind 的任務照舊走聊天主幹（存量任務一條都不受影響）', async () => {
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      metadata: { [AMSG_TASK_KIND_KEY]: undefined },
    });
    // 走聊天主幹 → 撞上「雲端沒有這個角色的 fire_pack」那道門
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/fire_pack/);
  });
});

describe('門牌整理 handler', () => {
  it('輸入過期（job 行不在了）→ 安靜跳過，不算失敗', async () => {
    const { ctx } = makeCtx({ jobValue: null });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('輸入形狀壞了 → 硬失敗（別拿半份材料整理出缺東西的門牌）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue('{"v":99}') });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解析失[败敗]/);
  });

  it('這次 fire 的超時跟瀏覽器那條路對齊', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    const result = await amsgHooks.onBeforeFire(ctx) as { totalTimeoutMs?: number };

    expect(result.totalTimeoutMs, '不交上去就落到庫自己的四分鐘默認值，改那個常量對雲端毫無影響')
      .toBe(PLATE_LLM_TIMEOUT_MS);
  });

  // 迴歸守衛：beforeFire 認定「這份輸入壞了」時原先只拋錯，行留著。那幾種失敗是確定性的
  // （解壓不出來、形狀對不上、charId 對不上號），重試梯子再跑兩遍還是同一份壞數據——行就
  // 這麼在共用命名空間裡躺滿三天 TTL。而每一行都是一個角色的整塊門牌原文 + 蒸餾材料 +
  // 身份上下文，且每次後台 fire 都要把整個命名空間讀出來解密才能挑出自己那一行。
  describe('確定性的壞輸入，認定的同時就把那行刪掉', () => {
    const discarded = (writeState: ReturnType<typeof vi.fn>) =>
      expect(writeState).toHaveBeenCalledWith(
        AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
      );

    it('解壓不出來（數據損壞）', async () => {
      const { ctx, writeState } = makeCtx({ jobValue: 'gz1:這不是合法的壓縮數據' });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解[压壓]失[败敗]/);
      discarded(writeState);
    });

    it('形狀對不上', async () => {
      const { ctx, writeState } = makeCtx({ jobValue: await packStateValue('{"v":99}') });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解析失[败敗]/);
      discarded(writeState);
    });

    it('charId 跟任務對不上', async () => {
      const { ctx, writeState } = makeCtx({
        jobValue: await packStateValue(JSON.stringify(jobInput({ charId: 'someone-else' }))),
      });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/charId [与與]任[务務][对對]不上/);
      discarded(writeState);
    });

    it('一個要整理的房間都沒有', async () => {
      const { ctx, writeState } = makeCtx({
        jobValue: await packStateValue(JSON.stringify(jobInput({ rooms: [] }))),
      });
      await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
      discarded(writeState);
    });
  });

  it('跑完把結果送進收件箱、不彈通知，並刪掉一次性輸入', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, REPLY);
    const decision = await amsgHooks.onLLMOutput(ctx);

    expect(decision).toEqual({ decision: 'skip-push', reason: 'plate-result-emitted' });
    expect(emitResult).toHaveBeenCalledTimes(1);
    const payload = (emitResult.mock.calls[0] as unknown as [any])[0];
    expect(payload.resultKind).toBe(PLATE_CONSOLIDATE_RESULT_KIND);
    expect(payload.charId).toBe(CHAR_ID);
    expect(payload.items).toHaveLength(1);
    // 背景工作不該把人叫回來看；show:false 時上游只落收件箱、不發推送。
    expect(payload.notification).toEqual({ show: false });
    // 提交時的條目 id 快照原樣回傳——客戶端靠它把 basedOn 重新對準當前條目。
    expect(payload.rooms).toEqual([
      { room: 'user_room', entryIds: ['pe_a'] },
      { room: 'bedroom', entryIds: [] },
    ]);
    // 一次性輸入跑完就刪
    expect(writeState).toHaveBeenCalledWith(
      AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
    );
  });

  it('LLM 一條都沒吐出來 → 不送空結果（空列表會被客戶端當成「清空門牌」）', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, '模型今天不想說話');
    const decision = await amsgHooks.onLLMOutput(ctx);

    expect(decision).toEqual({ decision: 'skip-push', reason: 'plate-empty-generation' });
    expect(emitResult).not.toHaveBeenCalled();
    // 一次性輸入照樣得刪：上游把 skip-push 當辦完了（status: 'skipped'），這條
    // recurrenceType: 'none' 的任務再沒有第二次機會來讀它。留著就是一行沒人認領的
    // 孤兒，裝著整塊門牌原文 + 材料 + 身份上下文，一直佔到 TTL。
    expect(writeState, '不刪的話每次失敗留一行，而 beforeFire 每跳都要把這個命名空間整個讀出來解密')
      .toHaveBeenCalledWith(AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }]);
  });

  // 模型回了東西卻一條都解析不出來時，日誌裡得看得出它回了個什麼（被截斷？空的？格式跑偏？）。
  it('一條都沒解析出來 → 記一行跳過診斷，reason 是 plate-empty-generation', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = makeSessionCtx(scratch, '模型今天不想說話');
    ctx.llmResponse = { choices: [{ finish_reason: 'length', message: { content: '模型今天不想說話' } }] };
    await amsgHooks.onLLMOutput(ctx);

    const diag = warn.mock.calls.find(([tag]) => tag === '[amsg:skip-diag]')?.[1];
    warn.mockRestore();
    expect(diag, '門牌整理空跑時也該留一行診斷').toMatchObject({
      reason: 'plate-empty-generation', finishReason: 'length', contentChars: 8,
    });
  });

  // 迴歸守衛：kind 是從任務 metadata 上讀出來的字符串。handler 表要是普通對象字面量，
  // `constructor` / `toString` 這些原型鏈上的鍵會解析成一個真值，繞過「表裡沒有這個
  // kind」那道判斷，最後炸在 `handler.beforeFire is not a function` 上——那句報錯跟真正
  // 的原因（這台 worker 不認識這種任務）毫無關係，排障要多繞一大圈。
  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'kind=%s 走「不認識的任務種類」，不是一句無關的報錯',
    async (kind) => {
      const { ctx } = makeCtx({ metadata: { [AMSG_TASK_KIND_KEY]: kind } });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/不[认認][识識]的任[务務][种種][类類]/);
    },
  );

  // 刪角色時客戶端會把這份輸入寫成空殼（HTTP 的 PUT /client-state 沒有刪除語義）。
  // 空殼解析不出來，當「數據損壞」硬失敗的話，一個已經被刪掉的角色還要把重試梯子走完。
  it('輸入被撤銷（行還在但值是空的）→ 跟過期一樣安靜跳過', async () => {
    const { ctx } = makeCtx({ jobValue: '' });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('老 worker 沒有 emitResult → 說清楚原因，不靜默', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, writeState } = makeSessionCtx(scratch, REPLY);
    delete (ctx as any).emitResult;
    await expect(amsgHooks.onLLMOutput(ctx)).resolves.toEqual({
      decision: 'skip-push', reason: 'plate-emit-result-unsupported',
    });
    // 這台 worker 永遠送不回結果，留著那行也沒人會來讀
    expect(writeState).toHaveBeenCalledWith(
      AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
    );
  });

  // 迴歸守衛：方法在、調用炸了（收件箱表缺列——升級 worker 不跑 init-tenant 就這樣）。
  // 拋出去的話這一輪算失敗，重試梯子會**再跑兩次完整生成**：LLM 已經燒過一次，後兩次
  // 註定同樣送不回來。就地收成跳過，只白跑一次。
  it('emitResult 調用拋錯 → 就地收成跳過，不把整輪判失敗去重試', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, REPLY);
    emitResult.mockRejectedValueOnce(new Error('no such column: push_payload'));

    await expect(amsgHooks.onLLMOutput(ctx)).resolves.toEqual({
      decision: 'skip-push', reason: 'plate-emit-result-failed',
    });
    // 結果雖然沒送出去，一次性輸入照樣得刪：這一輪已經被上游當辦完了，沒人會再讀它
    expect(writeState).toHaveBeenCalledWith(
      AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
    );
  });
});

describe('worker config', () => {
  it('一次性輸入那個命名空間配了 TTL，角色狀態那個沒配', async () => {
    const { buildWorkerConfig } = await import('./index');
    const config = buildWorkerConfig({
      DB: { prepare: () => {} },
      AMSG_MASTER_KEY: 'k'.repeat(64),
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    } as any) as any;

    expect(config.clientStateTtl).toEqual({ [AMSG_JOB_NAMESPACE]: 3 });
    // 角色狀態（fire_pack / tool_pack）絕不能配 TTL——配了就是定時把角色的雲端狀態抹掉
    expect(Object.keys(config.clientStateTtl)).not.toContain('amsg:char:');
  });
});
