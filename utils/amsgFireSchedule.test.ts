import { describe, it, expect } from 'vitest';
import {
  AMSG_FIRE_SCHEDULE_TOOL,
  EXPIRE_POLICY_DESCRIPTION,
  MIN_SCHEDULE_LEAD_MS,
  buildFireScheduleBlock,
  buildFireScheduleTool,
  buildSelfScheduleUuid,
  buildSendAtExample,
  buildTaskInstruction,
  extractFireScheduleTextCalls,
  parseFireScheduleArgs,
  resolveFireTargetTask,
} from './amsgFireSchedule';
import { shortTaskId } from './amsg2Tasks';

const NOW = Date.UTC(2026, 6, 30, 12, 0);
const inMinutes = (n: number) => new Date(NOW + n * 60_000).toISOString();
/** 角色的時間參照系是必填的（fire_pack 的 tzId）；與時區無關的用例統一給 UTC。 */
const TZ = { tzId: 'UTC' };

// 參數是模型現寫的，寫歪是常態。這裡每一條打回都必須是「能照著改」的一句話——
// 回一個裸錯誤碼的話，模型下一輪多半原樣再試一次，白燒一輪預算。
describe('parseFireScheduleArgs', () => {
  it('只給 send_at 時其餘走默認（auto / 一次性 / 遇忙作廢）', () => {
    const out = parseFireScheduleArgs({ send_at: inMinutes(90) }, NOW, TZ);
    expect(out).toEqual({
      sendAt: new Date(NOW + 90 * 60_000).toISOString(),
      mode: 'auto',
      recurrence: 'none',
      expirePolicy: 'expire',
    });
  });

  it('默認是 expire 而不是 force——大多數「接著說」用戶回來了就該讓路', () => {
    const out = parseFireScheduleArgs({ send_at: inMinutes(90) }, NOW, TZ) as any;
    expect(out.expirePolicy).toBe('expire');
  });

  it('force 是合法選擇（角色自己許下的具體承諾該照發）', () => {
    const out = parseFireScheduleArgs(
      { send_at: inMinutes(120), expire_policy: 'force', mode: 'prompted', prompt_hint: '湯燉好了叫他' },
      NOW,
      TZ,
    ) as any;
    expect(out.expirePolicy).toBe('force');
    expect(out.promptHint).toBe('湯燉好了叫他');
  });

  it('太近的時間打回：cron 一分鐘一跳，排得更近等於讓下一跳立刻撿走', () => {
    const justUnder = parseFireScheduleArgs({ send_at: inMinutes(0.5) }, NOW, TZ) as any;
    expect(justUnder.ok).toBe(false);
    expect(justUnder.reason).toBe('send_at_too_soon');
    // 邊界：正好卡在最小提前量上要放行
    expect(parseFireScheduleArgs(
      { send_at: new Date(NOW + MIN_SCHEDULE_LEAD_MS).toISOString() },
      NOW,
      TZ,
    )).not.toHaveProperty('ok');
  });

  it('過去的時間打回', () => {
    expect((parseFireScheduleArgs({ send_at: inMinutes(-60) }, NOW, TZ) as any).ok).toBe(false);
  });

  it('send_at 缺失 / 不是時間 → 打回並給一個能照抄的裸牆鍾示例（不再教 offset）', () => {
    // 文案改版理由（③）：以前教「ISO 8601（如 …+08:00）」，現在統一教裸牆鍾——
    // 模型看到的鐘就是角色本地的，讓它別再自己猜 offset。
    const missing = (parseFireScheduleArgs({}, NOW, TZ) as any).message;
    expect(missing).toContain('牆鍾');
    expect(missing).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(missing).not.toContain('+08:00');
    expect((parseFireScheduleArgs({ send_at: '明天晚上' }, NOW, TZ) as any).reason).toBe('invalid_send_at');
  });

  it('prompted 缺方向 → 打回（不然到點那條不知道該說什麼）', () => {
    const out = parseFireScheduleArgs({ send_at: inMinutes(90), mode: 'prompted' }, NOW, TZ) as any;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('missing_prompt_hint');
  });

  it('枚舉寫錯都各自打回', () => {
    expect((parseFireScheduleArgs({ send_at: inMinutes(90), mode: 'fixed' }, NOW, TZ) as any).reason).toBe('invalid_mode');
    expect((parseFireScheduleArgs({ send_at: inMinutes(90), recurrence: 'hourly' }, NOW, TZ) as any).reason).toBe('invalid_recurrence');
    expect((parseFireScheduleArgs({ send_at: inMinutes(90), expire_policy: 'maybe' }, NOW, TZ) as any).reason).toBe('invalid_expire_policy');
  });
});

// ③ 的核心迴歸守衛：worker 跑在 UTC，裸 send_at 必須按角色的時區（tzId）解析。
// 舊實現 new Date('2026-08-01T09:00:00') 在 UTC 運行時會當成 09:00Z——「明早 9 點」
// 整整差一個時差。斷言用與運行機器無關的 epoch 差值釘死。
describe('parseFireScheduleArgs 的時間參照系', () => {
  it('裸 datetime 按 tzId 的牆鍾解析（非 UTC 時區斷 epoch）', () => {
    // 2026-08-01 紐約在夏令時（EDT，-4）：09:00 牆鍾 = 13:00Z。
    const out = parseFireScheduleArgs(
      { send_at: '2026-08-01T09:00:00' },
      Date.UTC(2026, 7, 1, 1, 0),
      { tzId: 'America/New_York' },
    ) as any;
    expect(out.sendAt).toBe('2026-08-01T13:00:00.000Z');
  });

  it('帶 Z / offset 的照舊按標註解析，不被 tz 改寫', () => {
    const withZ = parseFireScheduleArgs(
      { send_at: '2026-08-01T09:00:00Z' }, Date.UTC(2026, 7, 1, 1, 0), { tzId: 'America/New_York' },
    ) as any;
    expect(withZ.sendAt).toBe('2026-08-01T09:00:00.000Z');
    const withOffset = parseFireScheduleArgs(
      { send_at: '2026-08-01T09:00:00+08:00' }, Date.UTC(2026, 7, 1, 0, 0), { tzId: 'America/New_York' },
    ) as any;
    expect(withOffset.sendAt).toBe('2026-08-01T01:00:00.000Z');
  });

  it('too_soon 判定吃解析後的真實時刻（牆鍾看著在未來、真實時刻已過 → 打回）', () => {
    // 紐約牆鍾 09:00 = 13:00Z；now 已是 14:00Z → 其實是過去。
    const out = parseFireScheduleArgs(
      { send_at: '2026-08-01T09:00:00' },
      Date.UTC(2026, 7, 1, 14, 0),
      { tzId: 'America/New_York' },
    ) as any;
    expect(out.reason).toBe('send_at_too_soon');
  });

  it('打回文案裡的「現在」說角色時區的人話，不再甩 UTC ISO', () => {
    const out = parseFireScheduleArgs(
      { send_at: '2026-08-01T09:00:00' },
      Date.UTC(2026, 7, 1, 14, 0),          // 紐約 10:00
      { tzId: 'America/New_York' },
    ) as any;
    expect(out.message).toContain('8月1日 10:00');
    expect(out.message).not.toContain('Z）');
  });
});

// 用戶的中轉拒 tools 時走這層。認得太寬會把「我等下用 schedule_active_message 提醒你」
// 這種敘述當成真調用，直接排出一條任務。
describe('extractFireScheduleTextCalls', () => {
  it('認括號帶 JSON 的寫法', () => {
    const calls = extractFireScheduleTextCalls(
      `好，我等下再找你\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"2026-07-30T23:30:00Z","prompt_hint":"接著說貓"})`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ send_at: '2026-07-30T23:30:00Z', prompt_hint: '接著說貓' });
  });

  it('敘述裡提到工具名但沒有括號調用 → 不算', () => {
    expect(extractFireScheduleTextCalls(`我等下用 ${AMSG_FIRE_SCHEDULE_TOOL} 提醒你`)).toHaveLength(0);
    expect(extractFireScheduleTextCalls(`${AMSG_FIRE_SCHEDULE_TOOL}: 兩小時後`)).toHaveLength(0);
  });

  it('參數寫壞了仍算一次調用（交給 parse 回一句該怎麼寫，別把語法漏進正文）', () => {
    const calls = extractFireScheduleTextCalls(`${AMSG_FIRE_SCHEDULE_TOOL}({送兩小時後})`);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({});
  });

  it('matched 是原始串，剝語法時靠它', () => {
    const text = `晚安\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"x"})`;
    const [call] = extractFireScheduleTextCalls(text);
    expect(text.split(call.matched).join('').trim()).toBe('晚安');
  });
});

describe('工具與說明塊', () => {
  const allAbilities = { allowRecurring: true, allowForce: true };
  const timeOpts = { nowMs: NOW, tz: TZ, abilities: allAbilities };

  it('工具名與前台一致（角色不用學第二套）', () => {
    expect(buildFireScheduleTool(timeOpts).function.name).toBe('schedule_active_message');
  });

  // 用戶沒放開的能力，參數乾脆不出現：擺在簽名裡等於邀請模型去選，選了再被打回白費一輪。
  it('用戶沒放開「重複」「到點必發」時，簽名裡沒有這兩個參數', () => {
    const locked = buildFireScheduleTool({ ...timeOpts, abilities: { allowRecurring: false, allowForce: false } });
    const props = (locked.function.parameters as any).properties;
    expect(props).not.toHaveProperty('recurrence');
    expect(props).not.toHaveProperty('expire_policy');
    expect(props).toHaveProperty('send_at');
    const open = (buildFireScheduleTool(timeOpts).function.parameters as any).properties;
    expect(open).toHaveProperty('recurrence');
    expect(open).toHaveProperty('expire_policy');
  });

  it('規矩那一段接在說明塊尾巴上', () => {
    expect(buildFireScheduleBlock('native', { ...timeOpts, limitsBrief: '用戶給你定的規矩：X' }))
      .toMatch(/用戶給你定的規矩：X$/);
  });

  it('native 模式不教正文語法，text 模式才教', () => {
    expect(buildFireScheduleBlock('native', timeOpts)).not.toContain('({"send_at"');
    expect(buildFireScheduleBlock('text', timeOpts)).toContain('({"send_at"');
  });

  it('expire_policy 描述把「角色自己許下的承諾」算進 force', () => {
    expect(EXPIRE_POLICY_DESCRIPTION).toContain('你自己許下的');
    expect(buildFireScheduleTool(timeOpts).function.parameters).toMatchObject({
      properties: { expire_policy: { description: EXPIRE_POLICY_DESCRIPTION } },
    });
  });

  // ③：示例從寫死的 `2026-07-30T23:30:00+08:00` 改成按 nowMs+tz 現算的「明天這個點」
  // 裸牆鍾——教模型寫 offset 的話，它寫的 offset 和角色時區對不上時又是一筆糊塗帳。
  it('send_at 示例是「明天這個點」的裸牆鍾，隨 tz 走、不帶 offset', () => {
    const tool = buildFireScheduleTool({ nowMs: NOW, tz: { tzId: 'Asia/Tokyo' }, abilities: allAbilities });
    const desc = (tool.function.parameters as any).properties.send_at.description as string;
    // NOW = 2026-07-30T12:00Z → 東京 21:00，明天這個點 = 07-31T21:00:00
    expect(desc).toContain('2026-07-31T21:00:00');
    expect(desc).not.toContain('+08:00');
    expect(desc).not.toContain('+09:00');
    expect(buildSendAtExample(NOW, { tzId: 'Asia/Tokyo' })).toBe('2026-07-31T21:00:00');
  });

  it('text 模式說明塊裡的示例同樣是裸牆鍾', () => {
    const block = buildFireScheduleBlock('text', { nowMs: NOW, tz: { tzId: 'Asia/Shanghai' } });
    expect(block).toContain('"send_at":"2026-07-31T20:00:00"');
    expect(block).not.toContain('+08:00');
  });
});

// 排程有三個入口（面板 / 前台工具 / fire 裡的工具），指令必須一模一樣，
// 否則同一個 mode 在不同入口生成出來的消息方向會不一樣。
describe('buildTaskInstruction', () => {
  it('prompted 帶上方向', () => {
    expect(buildTaskInstruction('prompted', '問問吃了沒')).toContain('額外提示：問問吃了沒');
  });

  it('auto 無靈感時寫「無」，不留空', () => {
    expect(buildTaskInstruction('auto')).toContain('可選靈感補充：無');
  });
});

// 排程清單裡印給角色看的短 id 取的是 uuid 前 8 個字符（amsg2Tasks.shortTaskId）。
// 自排任務的 uuid 要是以固定字樣開頭，同一次 fire 排下的兩條就印成一模一樣的短 id，
// 角色說「取消晚上那條」時隨便命中一條 —— 刪掉的很可能是早上那條，而且兩邊都回 ok。
describe('buildSelfScheduleUuid（自排任務的 uuid）', () => {
  it('同一次 fire 的兩條，前 8 個字符不一樣（清單裡印出來的短 id 不撞車）', () => {
    const a = buildSelfScheduleUuid('preset-nyah', 1_785_000_000_000, 0);
    const b = buildSelfScheduleUuid('preset-nyah', 1_785_000_000_000, 1);
    expect(shortTaskId(a)).not.toBe(shortTaskId(b));
  });

  it('不同角色 / 不同觸發時刻同樣分得開', () => {
    const base = buildSelfScheduleUuid('preset-nyah', 1_785_000_000_000, 0);
    expect(shortTaskId(buildSelfScheduleUuid('preset-other', 1_785_000_000_000, 0)))
      .not.toBe(shortTaskId(base));
    expect(shortTaskId(buildSelfScheduleUuid('preset-nyah', 1_785_000_060_000, 0)))
      .not.toBe(shortTaskId(base));
  });

  // 冪等的根：fire 拋錯整條重跑時算出同一個 uuid，上游才認得出撞車、不會每重試一次多排一條。
  it('同樣的入參永遠算出同一個 uuid（重跑對得上號）', () => {
    expect(buildSelfScheduleUuid('preset-nyah', 1_785_000_000_000, 0))
      .toBe(buildSelfScheduleUuid('preset-nyah', 1_785_000_000_000, 0));
  });

  it('uuid 裡仍看得出是自排的那一族（排障時一眼認出來）', () => {
    expect(buildSelfScheduleUuid('preset-nyah', 1_785_000_000_000, 0)).toContain('amsgself');
  });
});

// 取消 / 改期會真的動 D1 行。短 id 撞車時靜默取第一條 = 刪掉另一條任務，而角色和用戶
// 都只看到一句 ok —— 說好的那條到點照響，被刪的那條無聲無息地沒了。
describe('resolveFireTargetTask 的短 id 撞車', () => {
  const NOW_MS = Date.UTC(2026, 6, 30, 12, 0);
  const task = (uuid: string, hoursFromNow: number) => ({
    taskUuid: uuid,
    clientTaskId: `${uuid}-c`,
    mode: 'auto',
    firstSendTime: new Date(NOW_MS + hoursFromNow * 3600_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'character',
    status: 'scheduled',
    createdAt: NOW_MS,
  }) as any;

  const morning = task('amsgself-c1-1000-0', 1);
  const evening = task('amsgself-c1-1000-1', 9);

  it('一個短 id 命中兩條 → 打回 ambiguous_task，不靜默挑第一條', () => {
    const out = resolveFireTargetTask([morning, evening], 'amsgself', NOW_MS, TZ) as any;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('ambiguous_task');
  });

  it('打回的話裡帶得走：兩條各自的觸發時間 + 完整 task_id', () => {
    const out = resolveFireTargetTask([morning, evening], 'amsgself', NOW_MS, TZ) as any;
    expect(out.message).toContain(morning.taskUuid);
    expect(out.message).toContain(evening.taskUuid);
    expect(out.message).toContain('7月30日 13:00');
    expect(out.message).toContain('7月30日 21:00');
  });

  it('帶完整 uuid 重來一次就指得準', () => {
    const out = resolveFireTargetTask([morning, evening], evening.taskUuid, NOW_MS, TZ) as any;
    expect(out.task).toBe(evening);
  });

  it('短 id 只命中一條時照常選它，沒命中還是 task_not_found', () => {
    expect((resolveFireTargetTask([morning], 'amsgself', NOW_MS, TZ) as any).task).toBe(morning);
    expect((resolveFireTargetTask([morning], 'nothere1', NOW_MS, TZ) as any).reason)
      .toBe('task_not_found');
  });
});
