import { describe, it, expect } from 'vitest';
import {
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_SCENE,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG_SLOT_TIME_SINCE_USER,
  AMSG_SLOT_USER_CLOCK,
  AmsgFirePack,
  AmsgSelfLog,
  FIRE_PACK_VERSION,
  describeFirePackVersion,
  SELF_LOG_MAX_ENTRIES,
  SELF_LOG_TEXT_MAX,
  appendSelfLogEntry,
  buildAwayHint,
  buildUserClockHint,
  countUnansweredSends,
  createSelfLog,
  DEFAULT_MAX_UNANSWERED_SENDS,
  describeLastSkip,
  formatFireTimeFull,
  formatFireTimeShort,
  formatTimeSinceUser,
  parseFirePack,
  parseLastSkip,
  parseSelfLog,
  packStateValue,
  reconcileSelfLogWithPack,
  renderFirePack,
  renderSelfLogBlock,
  resolveMaxUnansweredSends,
  unpackStateValue,
} from './amsgFirePack';

// 迴歸守衛：這些期望值抄的是 activeMsgClient 拆槽位前（buildTimeGapHint /
// buildLegacyStyleProactiveHint 內聯時代）的舊文案。模板在前端維護、填槽在 worker 裡跑，
// 改文案時這份測試會擋住手滑——期望值和文案要一起改。

describe('formatTimeSinceUser', () => {
  it('沒有聊天記錄（null）', () => {
    expect(formatTimeSinceUser(null)).toBe('你們最近沒有新的聊天記錄。');
  });

  it('小於 1 小時按分鐘', () => {
    expect(formatTimeSinceUser(0)).toBe('距離用戶上次主動發消息大約 0 分鐘。');
    expect(formatTimeSinceUser(59)).toBe('距離用戶上次主動發消息大約 59 分鐘。');
  });

  it('小於 1 天按小時（整點不帶分鐘尾巴）', () => {
    expect(formatTimeSinceUser(60)).toBe('距離用戶上次主動發消息大約 1 小時。');
    expect(formatTimeSinceUser(90)).toBe('距離用戶上次主動發消息大約 1 小時 30 分鐘。');
    expect(formatTimeSinceUser(1439)).toBe('距離用戶上次主動發消息大約 23 小時 59 分鐘。');
  });

  it('超過 1 天按天（整天不帶小時尾巴）', () => {
    expect(formatTimeSinceUser(1440)).toBe('距離用戶上次主動發消息大約 1 天。');
    expect(formatTimeSinceUser(1440 + 300)).toBe('距離用戶上次主動發消息大約 1 天 5 小時。');
  });

  it('負數鉗到 0（時鐘回撥防線）', () => {
    expect(formatTimeSinceUser(-5)).toBe('距離用戶上次主動發消息大約 0 分鐘。');
  });
});

describe('buildAwayHint', () => {
  it('無記錄 → 「最近沒有主動來找你說話」', () => {
    expect(buildAwayHint('小明同學', '你們最近沒有新的聊天記錄。'))
      .toBe('小明同學最近沒有主動來找你說話。');
  });

  it('有記錄 → 只借時長、句子重拼', () => {
    expect(buildAwayHint('小明', '距離用戶上次主動發消息大約 3 小時。'))
      .toBe('小明已經大約 3 小時 沒主動來找你了。');
    expect(buildAwayHint('小明', '距離用戶上次主動發消息大約 1 天 5 小時。'))
      .toBe('小明已經大約 1 天 5 小時 沒主動來找你了。');
  });

  it('時長取不出來時退回「最近沒來找你」，不吐半截句子', () => {
    expect(buildAwayHint('小明', '格式變了的一句話')).toBe('小明最近沒有主動來找你說話。');
  });

  it('空名字回退「對方」', () => {
    expect(buildAwayHint('', '你們最近沒有新的聊天記錄。'))
      .toBe('對方最近沒有主動來找你說話。');
  });
});

describe('formatFireTimeFull / formatFireTimeShort（角色參照系的自然中文時間）', () => {
  const noonZ = Date.UTC(2026, 6, 17, 12, 0);   // 2026-07-17（週五）12:00Z

  it('tzId 走 Intl（夏令時交給 ICU）', () => {
    // 紐約 7 月是 EDT(-4)：12:00Z → 08:00 早晨。固定偏移算法（EST -5）會給 07:00。
    expect(formatFireTimeFull(noonZ, { tzId: 'America/New_York' }))
      .toBe('2026年7月17日 週五 早晨 08:00');
    expect(formatFireTimeShort(noonZ, { tzId: 'America/New_York' })).toBe('7月17日 08:00');
  });

  it('tzId 非法直接拋錯（數據壞了走 fire 失敗路徑，不靜默給一個錯的時間）', () => {
    expect(() => formatFireTimeFull(noonZ, { tzId: 'Not/AZone' })).toThrow();
  });

  it('時段詞分桶與 buildCoreContext 一致（抽查邊界）', () => {
    const at = (h: number) => Date.UTC(2026, 6, 17, h, 0);
    const word = (h: number) => formatFireTimeFull(at(h), { tzId: 'UTC' }).split(' ')[2];
    expect(word(4)).toBe('凌晨');
    expect(word(5)).toBe('早晨');
    expect(word(9)).toBe('上午');
    expect(word(13)).toBe('中午');
    expect(word(16)).toBe('下午');
    expect(word(18)).toBe('傍晚');
    expect(word(21)).toBe('晚上');
    expect(word(23)).toBe('深夜');
  });
});

describe('renderFirePack', () => {
  const basePack: AmsgFirePack = {
    v: FIRE_PACK_VERSION, builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
    template: [
      `當前本地時間：${AMSG_SLOT_CURRENT_TIME}`,
      AMSG_SLOT_TIME_SINCE_USER,
      `現在是 ${AMSG_SLOT_CURRENT_TIME}。`,
      AMSG_SLOT_AWAY_HINT,
      AMSG_SLOT_TASK_INSTRUCTION,
    ].join('\n'),
    lastUserMessageAt: null,
    tzId: 'UTC',
    userTzId: 'UTC',
    targetName: '小明同學',
  };

  it('填滿全部槽位，currentTime 出現多次也全部替換（自然中文格式，與 buildCoreContext 同款）', () => {
    const now = Date.UTC(2026, 6, 17, 8, 30);
    const rendered = renderFirePack(basePack, now, '本次任務指令');
    expect(rendered).toBe([
      '當前本地時間：2026年7月17日 週五 早晨 08:30',
      '你們最近沒有新的聊天記錄。',
      '現在是 2026年7月17日 週五 早晨 08:30。',
      '小明同學最近沒有主動來找你說話。',
      '本次任務指令',
    ].join('\n'));
    expect(rendered).not.toContain('{{');
  });

  it('按 pack.tzId 的 IANA 時區渲染（Intl 處理，不吃運行時本地時區）', () => {
    // 2026-08-01T00:00Z 在 Asia/Shanghai 是週六早上 8 點。
    const now = Date.UTC(2026, 7, 1, 0, 0);
    const rendered = renderFirePack({ ...basePack, tzId: 'Asia/Shanghai' }, now, '指令');
    expect(rendered).toContain('當前本地時間：2026年8月1日 週六 早晨 08:00');
  });

  it('lastUserMessageAt 用渲染時刻現算時間差', () => {
    const now = Date.UTC(2026, 6, 17, 8, 0);
    const rendered = renderFirePack(
      { ...basePack, lastUserMessageAt: now - 90 * 60_000 },
      now,
      '本次任務指令',
    );
    expect(rendered).toContain('距離用戶上次主動發消息大約 1 小時 30 分鐘。');
    expect(rendered).toContain('小明同學已經大約 1 小時 30 分鐘 沒主動來找你了。');
  });
});

// 迴歸守衛：用戶那邊的鐘以前完全沒上雲——角色只看得到自己那邊的時間，
// 「晚上九點跟他說一聲」在異國戀角色手裡就是排到用戶的凌晨三點，而且它沒有任何線索
// 能察覺這件事。現在隨包帶 userTzId，到點渲染成一行參考。
//
// 另一半同樣重要：這一行是**第二個鍾**，措辭必須釘死主語，否則一份 prompt 裡兩個時間
// 在打架，模型只會隨便挑一個信。
describe('對方那邊現在幾點（AMSG_SLOT_USER_CLOCK）', () => {
  // 紐約角色 / 上海用戶：2026-08-02T13:00Z = 紐約 09:00、上海 21:00。
  const AT = Date.UTC(2026, 7, 2, 13, 0);
  const nyChar: AmsgFirePack = {
    v: FIRE_PACK_VERSION, builtAt: 1, pendingTasks: [], scene: null, selfScheduleEnabled: true, lastUserMessageAt: null,
    template: `當前本地時間（你所在地）：${AMSG_SLOT_CURRENT_TIME}${AMSG_SLOT_USER_CLOCK}`,
    tzId: 'America/New_York',
    userTzId: 'Asia/Shanghai',
    targetName: '小明同學',
  };

  it('兩個鍾各寫各的主語：角色的是「當前本地時間」，用戶的點名是「對方所在時區」', () => {
    const out = renderFirePack(nyChar, AT, '指令');
    expect(out).toContain('當前本地時間（你所在地）：2026年8月2日 週日 上午 09:00');
    expect(out).toContain('對方所在時區參考：小明同學那邊現在是 8月2日 晚上 21:00');
    expect(out).not.toContain('{{');
  });

  it('同一個時區 → 整行消失（同一個鍾報兩遍就成了兩個打架的時間）', () => {
    const out = renderFirePack({ ...nyChar, userTzId: 'America/New_York' }, AT, '指令');
    expect(out).toBe('當前本地時間（你所在地）：2026年8月2日 週日 上午 09:00');
  });

  it('buildUserClockHint 只認 userTz，不吃運行時本地時區', () => {
    expect(buildUserClockHint(AT, { tzId: 'UTC' }, { tzId: 'Asia/Tokyo' }, '小明同學'))
      .toContain('小明同學那邊現在是 8月2日 深夜 22:00');
    // 空 tz（理論上 parseFirePack 已經擋住）→ 不硬編一個時間出來
    expect(buildUserClockHint(AT, { tzId: 'UTC' }, { tzId: '' }, '小明同學')).toBe('');
  });

  it('沒名字回退「對方」', () => {
    expect(buildUserClockHint(AT, { tzId: 'UTC' }, { tzId: 'Asia/Shanghai' }, ''))
      .toContain('對方那邊現在是');
  });
});

describe('parseFirePack', () => {
  const valid: AmsgFirePack = {
    v: FIRE_PACK_VERSION, template: 'x', lastUserMessageAt: null, tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: 'A',
    builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };

  it('合法 JSON 原樣返回', () => {
    expect(parseFirePack(JSON.stringify(valid))).toEqual(valid);
  });

  it('builtAt / pendingTasks 缺一不可（self_log 對齊與排程清單都靠它們）', () => {
    const { builtAt: _b, ...noBuiltAt } = valid;
    const { pendingTasks: _t, ...noTasks } = valid;
    expect(parseFirePack(JSON.stringify(noBuiltAt))).toBeNull();
    expect(parseFirePack(JSON.stringify(noTasks))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, builtAt: 'x' }))).toBeNull();
  });

  it('lastUserMessageAt 數字也合法', () => {
    expect(parseFirePack(JSON.stringify({ ...valid, lastUserMessageAt: 123 }))?.lastUserMessageAt).toBe(123);
  });

  it('maxUnansweredSends 可選：缺省合法、非負數字透傳、壞值整包打回', () => {
    expect(parseFirePack(JSON.stringify(valid))?.maxUnansweredSends).toBeUndefined();
    expect(parseFirePack(JSON.stringify({ ...valid, maxUnansweredSends: 5 }))?.maxUnansweredSends).toBe(5);
    expect(parseFirePack(JSON.stringify({ ...valid, maxUnansweredSends: 0 }))?.maxUnansweredSends).toBe(0);
    expect(parseFirePack(JSON.stringify({ ...valid, maxUnansweredSends: '5' }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, maxUnansweredSends: -1 }))).toBeNull();
  });

  it('tzId 必填：缺失 / 空串 / 非字符串整包打回（渲染時間沒有第二套算法可退）', () => {
    expect(parseFirePack(JSON.stringify({ ...valid, tzId: 'Asia/Tokyo' }))?.tzId).toBe('Asia/Tokyo');
    const { tzId: _tz, ...noTzId } = valid;
    expect(parseFirePack(JSON.stringify(noTzId))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, tzId: '' }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, tzId: 42 }))).toBeNull();
  });

  it('userTzId 同樣必填（缺了就沒法說「對方那邊現在幾點」）', () => {
    const { userTzId: _u, ...noUserTz } = valid;
    expect(parseFirePack(JSON.stringify(noUserTz))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, userTzId: '' }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, userTzId: 'America/New_York' }))?.userTzId)
      .toBe('America/New_York');
  });

  it('壞形狀 → null（worker 藉此拋 fire-state 錯）', () => {
    expect(parseFirePack('not json')).toBeNull();
    expect(parseFirePack('{}')).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, v: 1 }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, template: '' }))).toBeNull();
  });
});

// 迴歸守衛：主動消息的多輪連續性全靠這份自述日誌。它一旦失效，用戶離線期間連著觸發兩次，
// 角色第二次看到的上下文跟第一次逐字一樣，只會把同一句話換個說法再發一遍——而且沒有任何
// 報錯，靜默退化成「單輪」。下面每條都對著一種具體的退化方式。
describe('self_log', () => {
  const packAt = 1_700_000_000_000;
  const pack: AmsgFirePack = {
    v: FIRE_PACK_VERSION, template: 'x', lastUserMessageAt: null, tzId: 'UTC', userTzId: 'UTC', targetName: '小明同學',
    builtAt: packAt, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };
  const entry = (id: string, text: string, at = packAt) => ({ id, at, text });

  describe('appendSelfLogEntry', () => {
    it('同 id 覆蓋，fire 重跑不會把一條消息記成好幾條', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@100', '在幹嘛呢'));
      log = appendSelfLogEntry(log, entry('t1@100', '在幹嘛呢'));
      expect(log.entries).toHaveLength(1);
    });

    it('不同觸發各記一條，按追加順序排', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@100', '第一條'));
      log = appendSelfLogEntry(log, entry('t1@200', '第二條'));
      expect(log.entries.map((e) => e.text)).toEqual(['第一條', '第二條']);
    });

    it('只留最近 SELF_LOG_MAX_ENTRIES 條，老的擠掉', () => {
      let log = createSelfLog(packAt);
      for (let i = 0; i < SELF_LOG_MAX_ENTRIES + 3; i += 1) {
        log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i} 條`));
      }
      expect(log.entries).toHaveLength(SELF_LOG_MAX_ENTRIES);
      expect(log.entries[0].text).toBe('第 3 條');
    });

    it('超長正文截斷', () => {
      const log = appendSelfLogEntry(createSelfLog(packAt), entry('t1@1', 'あ'.repeat(500)));
      expect(log.entries[0].text).toHaveLength(SELF_LOG_TEXT_MAX);
    });

    it('空正文原樣返回（調用方據此跳過一次寫庫）', () => {
      const before = createSelfLog(packAt);
      expect(appendSelfLogEntry(before, entry('t1@1', '   \n '))).toBe(before);
    });
  });

  // 迴歸守衛（炸屏事故的根）：連發計數以前掛在 basePackAt 上，客戶端每認領一條推送就
  // 重傳一次 fire_pack，計數被自己發的消息洗回零——在線時連排提醒永遠不出現。
  // 現在兩段各管各的生死：entries 只認「用戶開口了」，tasks 只認「fire_pack 換代了」。
  describe('reconcileSelfLogWithPack', () => {
    const task = (uuid: string) => ({
      taskUuid: uuid, clientTaskId: `${uuid}-c`, mode: 'auto', firstSendTime: '2026-08-07T09:00:00.000Z',
      recurrenceType: 'none', expirePolicy: 'expire', source: 'character', status: 'scheduled', createdAt: packAt,
    } as AmsgSelfLog['tasks'][number]);

    const seeded = (): AmsgSelfLog => {
      let log = createSelfLog(packAt, 500);
      log = appendSelfLogEntry(log, entry('t1@1', '第一條'));
      log = appendSelfLogEntry(log, entry('t1@2', '第二條'));
      return { ...log, tasks: [task('u1')] };
    };

    it('沒有日誌 → 從空的建一份，錨定當前的 lastUserMessageAt', () => {
      const log = reconcileSelfLogWithPack(null, pack, 500);
      expect(log.entries).toHaveLength(0);
      expect(log.tasks).toHaveLength(0);
      expect(log.basePackAt).toBe(packAt);
      expect(log.anchorUserMsgAt).toBe(500);
    });

    it('fire_pack 換代（builtAt 變了）→ 只丟 tasks（已隨 pendingTasks 回來），entries 原樣保留', () => {
      const log = reconcileSelfLogWithPack(seeded(), { ...pack, builtAt: packAt + 1 }, 500);
      expect(log.entries.map((e) => e.text)).toEqual(['第一條', '第二條']);
      expect(log.tasks).toHaveLength(0);
      expect(log.basePackAt).toBe(packAt + 1);
    });

    it('用戶開口了（lastUserMessageAt 比錨新）→ 清 entries、錨前進，tasks 不動', () => {
      const log = reconcileSelfLogWithPack(seeded(), pack, 900);
      expect(log.entries).toHaveLength(0);
      expect(log.anchorUserMsgAt).toBe(900);
      expect(log.tasks).toHaveLength(1);
    });

    it('用戶沒有新發言（同錨 / 更舊 / null）→ entries 原樣保留', () => {
      expect(reconcileSelfLogWithPack(seeded(), pack, 500).entries).toHaveLength(2);
      expect(reconcileSelfLogWithPack(seeded(), pack, 400).entries).toHaveLength(2);
      expect(reconcileSelfLogWithPack(seeded(), pack, null).entries).toHaveLength(2);
    });

    it('換代與用戶開口同時發生 → entries、tasks 都清', () => {
      const log = reconcileSelfLogWithPack(seeded(), { ...pack, builtAt: packAt + 1 }, 900);
      expect(log.entries).toHaveLength(0);
      expect(log.tasks).toHaveLength(0);
    });
  });

  describe('countUnansweredSends（連發上限的計數口徑）', () => {
    it('只數主動發出的條目，即時對話的回覆（reply 標記）不算連發', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, { id: 'r@1', at: packAt, text: '嗯嗯我在', reply: true });
      log = appendSelfLogEntry(log, entry('t1@2', '主動第一條'));
      log = appendSelfLogEntry(log, entry('t1@3', '主動第二條'));
      expect(countUnansweredSends(log)).toBe(2);
      expect(countUnansweredSends(createSelfLog(packAt))).toBe(0);
      expect(countUnansweredSends(null)).toBe(0);
    });

    // 迴歸守衛：計數以前是數 entries 數出來的，而 entries 只留最近 SELF_LOG_MAX_ENTRIES
    // （8）條——計數因此永遠不會超過 8，用戶把連發上限設成 9 或 10 時，到點兜底閘的
    // 「計數 >= 上限」恆為 false，那道閘整個失效（等於「不限」）。
    it('連發條數不被 entries 上限壓平：發 10 條就數到 10（上限設 9 / 10 時閘才攔得住）', () => {
      let log = createSelfLog(packAt);
      for (let i = 0; i < 10; i += 1) {
        log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i + 1} 條`));
      }
      expect(log.entries).toHaveLength(SELF_LOG_MAX_ENTRIES);   // 前提：entries 確實被削過
      expect(countUnansweredSends(log)).toBe(10);
    });

    it('同一次觸發重跑（同 id 再追加一次）不多記一條連發', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@100', '在幹嘛呢'));
      log = appendSelfLogEntry(log, entry('t1@100', '在幹嘛呢'));
      expect(countUnansweredSends(log)).toBe(1);
    });

    it('用戶開口 → 連發條數跟 entries 一起歸零', () => {
      let log = createSelfLog(packAt, 500);
      for (let i = 0; i < 10; i += 1) log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i} 條`));
      const after = reconcileSelfLogWithPack(log, pack, 900);
      expect(after.entries).toHaveLength(0);
      expect(countUnansweredSends(after)).toBe(0);
    });

    it('fire_pack 換代（客戶端認領重傳）不清連發條數', () => {
      let log = createSelfLog(packAt, 500);
      for (let i = 0; i < 10; i += 1) log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i} 條`));
      expect(countUnansweredSends(reconcileSelfLogWithPack(log, { ...pack, builtAt: packAt + 1 }, 500)))
        .toBe(10);
    });
  });

  describe('resolveMaxUnansweredSends（用戶設置的連發上限）', () => {
    it('沒設 → 默認值；0 → 不限（Infinity）；正整數原樣；壞值回默認', () => {
      expect(resolveMaxUnansweredSends(undefined)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
      expect(resolveMaxUnansweredSends(0)).toBe(Infinity);
      expect(resolveMaxUnansweredSends(5)).toBe(5);
      expect(resolveMaxUnansweredSends(-2)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
      expect(resolveMaxUnansweredSends(Number.NaN)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
      expect(resolveMaxUnansweredSends('3' as unknown)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
    });
  });

  describe('parseSelfLog', () => {
    it('合法 JSON 原樣返回（含 reply 標記與錨）', () => {
      let log = createSelfLog(packAt, 500);
      log = appendSelfLogEntry(log, entry('t1@1', '喂'));
      log = appendSelfLogEntry(log, { id: 'r@2', at: packAt, text: '在的', reply: true });
      const parsed = parseSelfLog(JSON.stringify(log));
      expect(parsed).toEqual(log);
      expect(parsed?.anchorUserMsgAt).toBe(500);
      expect(parsed?.entries[1].reply).toBe(true);
    });

    it('壞形狀 / 舊版本 → null（調用方當沒有、從空的重新攢）', () => {
      expect(parseSelfLog('')).toBeNull();
      expect(parseSelfLog('not json')).toBeNull();
      expect(parseSelfLog(JSON.stringify({ v: 2, basePackAt: packAt, entries: [], tasks: [] }))).toBeNull();
      expect(parseSelfLog(JSON.stringify({ v: 1, basePackAt: packAt }))).toBeNull();
      // v3（連發條數還數在 entries 裡的那版）不認：讀出來的計數會是錯的，寧可從空的重攢
      expect(parseSelfLog(JSON.stringify({ v: 3, basePackAt: packAt, anchorUserMsgAt: null, entries: [], tasks: [] }))).toBeNull();
      // 缺連發計數字段的一樣不認（少了它計數會靜默從 0 開始，閘又白裝了）
      expect(parseSelfLog(JSON.stringify({ v: 4, basePackAt: packAt, anchorUserMsgAt: null, entries: [], tasks: [] }))).toBeNull();
      expect(parseSelfLog(JSON.stringify({ v: 4, basePackAt: packAt, anchorUserMsgAt: null, entries: [{ id: 'a' }], unansweredSends: 0, tasks: [] }))).toBeNull();
    });
  });

  describe('renderFirePack 注入', () => {
    const slotted: AmsgFirePack = {
      ...pack,
      template: `【最近對話上下文】\n用戶：在嗎${AMSG_SLOT_SELF_LOG}\n\n【本次任務】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    };

    it('有自述時接在對話上下文後面，正文原樣出現、時間用相對口徑', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@1', '剛看到樓下那隻貓又來了', Date.UTC(2026, 6, 30, 21, 30)));
      const rendered = renderFirePack(slotted, Date.UTC(2026, 6, 30, 23, 0), '本次任務指令', { selfLog: log });

      expect(rendered).toContain('剛看到樓下那隻貓又來了');
      expect(rendered).toContain('1小時前');
      // 位置：夾在對話上下文和本次任務之間，不能跑到任務指令後面去當新指令讀。
      expect(rendered.indexOf('剛看到樓下那隻貓又來了')).toBeGreaterThan(rendered.indexOf('用戶：在嗎'));
      expect(rendered.indexOf('剛看到樓下那隻貓又來了')).toBeLessThan(rendered.indexOf('本次任務指令'));
      expect(rendered).not.toContain('{{');
    });

    it('沒有自述時槽位被抹平，輸出與沒有這回事時一致', () => {
      const now = Date.UTC(2026, 6, 30, 23, 0);
      const plain: AmsgFirePack = {
        ...pack,
        template: '【最近對話上下文】\n用戶：在嗎\n\n【本次任務】\n' + AMSG_SLOT_TASK_INSTRUCTION,
      };
      expect(renderFirePack(slotted, now, '本次任務指令', { selfLog: createSelfLog(packAt) }))
        .toBe(renderFirePack(plain, now, '本次任務指令'));
      expect(renderFirePack(slotted, now, '本次任務指令')).not.toContain('{{');
    });

    it('模板裡沒有這個槽位時不報錯（只是那段無處可去）', () => {
      const legacy: AmsgFirePack = { ...pack, template: `頭部\n${AMSG_SLOT_TASK_INSTRUCTION}` };
      const log = appendSelfLogEntry(createSelfLog(packAt), entry('t1@1', '喂'));
      expect(renderFirePack(legacy, Date.UTC(2026, 6, 30), '指令', { selfLog: log })).toBe('頭部\n指令');
    });
  });

  it('renderSelfLogBlock 空日誌返回空串', () => {
    const now = Date.UTC(2026, 6, 30, 23, 0);
    expect(renderSelfLogBlock(null, now, { tzId: 'UTC' })).toBe('');
    expect(renderSelfLogBlock(createSelfLog(packAt), now, { tzId: 'UTC' })).toBe('');
  });

  it('renderSelfLogBlock 時間口徑：一天內相對（分鐘/小時前），更久回絕對時刻並按 pack 時區換算', () => {
    const now = Date.UTC(2026, 6, 31, 14, 0);
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, entry('t1@1', '前天說的', Date.UTC(2026, 6, 29, 14, 0)));
    log = appendSelfLogEntry(log, entry('t1@2', '三分鐘前說的', now - 3 * 60_000));

    const sh = renderSelfLogBlock(log, now, { tzId: 'Asia/Shanghai' });
    expect(sh).toContain('3分鐘前');
    expect(sh).toContain('7月29日 22:00');   // UTC+8 的絕對時刻
    expect(renderSelfLogBlock(log, now, { tzId: 'UTC' })).toContain('7月29日 14:00');
  });

  // ② 的迴歸守衛：同一個 pack 渲染出來的當前時間 / 自述絕對時間戳必須落在同一參照系。
  // 舊實現裡當前時間和別處各寫各的換算，參照系一混角色就會算錯「幾小時前」。
  // 一天內的條目現在渲染相對時間（與參照系無關），所以拿一條超過一天的老條目守這條線。
  it('同一個 pack 裡當前時間與自述絕對時間戳同參照系（tzId 一把尺）', () => {
    const slotted: AmsgFirePack = {
      ...pack,
      tzId: 'Asia/Tokyo',
      template: `當前 ${AMSG_SLOT_CURRENT_TIME}${AMSG_SLOT_SELF_LOG}\n【本次任務】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    };
    const at = Date.UTC(2026, 6, 28, 13, 0);       // 東京 7月28日 22:00
    const now = Date.UTC(2026, 6, 30, 14, 0);      // 東京 7月30日 23:00
    const log = appendSelfLogEntry(createSelfLog(packAt), entry('t1@1', '睡了', at));
    const rendered = renderFirePack(slotted, now, '指令', { selfLog: log });
    expect(rendered).toContain('2026年7月30日 週四 深夜 23:00');
    expect(rendered).toContain('7月28日 22:00');
  });
});

// ④ 連發提醒：計數/上限就長在自述塊裡——模型看到的是「幾分鐘前發過什麼」這個頻率本身，
// 而不是一句抽象的「第 x 條」。計數隨 reconcileSelfLogWithPack 只在用戶開口時清零，
// 在線認領推送不再衝掉它（炸屏事故里提醒正是被這條迴路洗沒的）。
describe('連發提醒（自述塊內的計數與上限）', () => {
  const packAt = 1_700_000_000_000;
  const slotted: AmsgFirePack = {
    v: FIRE_PACK_VERSION, lastUserMessageAt: null, tzId: 'UTC', userTzId: 'UTC', targetName: '小明同學',
    builtAt: packAt, pendingTasks: [], scene: null, selfScheduleEnabled: true,
    template: `【最近對話上下文】\n用戶：在嗎${AMSG_SLOT_SELF_LOG}\n\n【本次任務】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
  };
  const entry = (id: string, text: string) => ({ id, at: packAt, text });

  it('有未回應連發時，塊裡寫明已連發幾條、上限幾條（默認上限）', () => {
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, entry('t1@1', '第一條'));
    log = appendSelfLogEntry(log, entry('t1@2', '第二條'));
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).toContain('你已連發 2 條');
    expect(rendered).toContain(`上限 ${DEFAULT_MAX_UNANSWERED_SENDS} 條`);
  });

  it('pack 帶用戶自設上限時按用戶的來；0（不限）不渲染上限半句', () => {
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, entry('t1@1', '第一條'));
    const custom = renderFirePack(
      { ...slotted, maxUnansweredSends: 8 }, packAt + 60_000, '指令', { selfLog: log },
    );
    expect(custom).toContain('上限 8 條');
    const unlimited = renderFirePack(
      { ...slotted, maxUnansweredSends: 0 }, packAt + 60_000, '指令', { selfLog: log },
    );
    expect(unlimited).toContain('你已連發 1 條');
    expect(unlimited).not.toContain('上限');
  });

  it('只有即時回覆（reply 條目）→ 列出但不算連發，不出現計數行', () => {
    const log = appendSelfLogEntry(createSelfLog(packAt), { id: 'r@1', at: packAt + 1000, text: '嗯我在', reply: true });
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).toContain('嗯我在');
    expect(rendered).not.toContain('你已連發');
  });

  it('已進轉寫的條目（at ≤ basePackAt）不再重複渲染正文，但計數保留', () => {
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, { id: 's@1', at: packAt - 1000, text: '已在轉寫裡的那條' });
    log = appendSelfLogEntry(log, { id: 's@2', at: packAt + 1000, text: '轉寫之後新發的' });
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).not.toContain('已在轉寫裡的那條');
    expect(rendered).toContain('轉寫之後新發的');
    expect(rendered).toContain('你已連發 2 條');
  });

  it('不再往【本次任務】前面插舊版 streak 提醒行', () => {
    let log = createSelfLog(packAt);
    for (let i = 0; i < 4; i += 1) log = appendSelfLogEntry(log, entry(`t1@${i}`, `第${i}條`));
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).not.toContain('條主動消息。請注意邊界');
    expect(rendered).toContain('指令');
  });
});

// ⑤⑥ 的 last_skip 新原因：空生成 / 過期不補發。parse 認、describe 有對應人話。
describe('last_skip 新原因', () => {
  const base = { v: 1 as const, taskUuid: null, occurrenceMs: 1_700_000_000_000, skippedAt: 1_700_000_100_000 };
  const fmt = (ms: number) => `T${ms}`;

  it('parseLastSkip 認 empty-generation / stale / unanswered-limit', () => {
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'empty-generation' }))?.reason).toBe('empty-generation');
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'stale' }))?.reason).toBe('stale');
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'unanswered-limit' }))?.reason).toBe('unanswered-limit');
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'nonsense' }))).toBeNull();
  });

  it('describeLastSkip 對每個原因都有人話（面板一行說明）', () => {
    expect(describeLastSkip({ ...base, reason: 'empty-generation' }, fmt)).toContain('沒寫出要說的話');
    expect(describeLastSkip({ ...base, reason: 'stale' }, fmt)).toContain('過去太久');
    expect(describeLastSkip({ ...base, reason: 'active-chat-presence' }, fmt)).toContain('讓路');
    expect(describeLastSkip({ ...base, reason: 'conversation-moved-on' }, fmt)).toContain('過時');
    expect(describeLastSkip({ ...base, reason: 'unanswered-limit' }, fmt)).toContain('連發上限');
  });

  // 被連發上限攔下的那一次是**真的跳過了**：上游把 { skip: true } 當成功消費，一次性
  // 任務的行當場就刪了，循環任務也只是快進到下一次，都不會把這一條補回來。文案要是說
  // 「等你回覆後恢復」，用戶就會一直等一條永遠不會來的消息（角色在正文裡承諾過的
  // 「等下再來找你」也跟著蒸發）。
  it('連發上限那次說清「不會補發」，不許承諾恢復', () => {
    const text = describeLastSkip({ ...base, reason: 'unanswered-limit' }, fmt);
    expect(text).toContain('不會補發');
    expect(text).not.toContain('等你回覆後恢復');
  });
});

describe('fire_pack 任務指令槽', () => {
  const pack: AmsgFirePack = {
    v: FIRE_PACK_VERSION,
    template: `頭部\n${AMSG_SLOT_TASK_INSTRUCTION}\n尾部 ${AMSG_SLOT_CURRENT_TIME}`,
    lastUserMessageAt: null, tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: '小明同學',
    builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };

  it('renderFirePack 用傳入的任務指令填槽', () => {
    const out = renderFirePack(pack, Date.UTC(2026, 6, 21, 1, 0), '圍繞"問考試"發起私聊');
    expect(out).toContain('圍繞"問考試"發起私聊');
    expect(out).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
  });

  it('只認當前版本號，對不上的整包 parse 失敗（worker 拋 fire-state 錯）', () => {
    expect(parseFirePack(JSON.stringify(pack))).not.toBeNull();
    expect(parseFirePack(JSON.stringify({ ...pack, v: 3 }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...pack, v: 1 }))).toBeNull();
  });
});

describe('client_state 值壓縮', () => {
  // fire_pack 有幾萬字，隨手編一小段壓不出效果也測不出真問題，拿重複的中文段落湊量。
  const bigJson = JSON.stringify({
    v: FIRE_PACK_VERSION,
    template: '【角色系統設定】你是一個會在深夜突然想起對方的人。\n'.repeat(400),
    lastUserMessageAt: 1_700_000_000_000,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    builtAt: 1_700_000_000_000,
    pendingTasks: [],
    scene: null,
    selfScheduleEnabled: true,
  });

  it('壓完再解回來，一個字都不差', async () => {
    const packed = await packStateValue(bigJson);
    expect(packed.startsWith('gz1:')).toBe(true);
    expect(await unpackStateValue(packed)).toBe(bigJson);
  });

  it('壓完確實變小了（不然這整套機制沒有意義）', async () => {
    const packed = await packStateValue(bigJson);
    expect(packed.length).toBeLessThan(bigJson.length / 2);
  });

  // 內容太短時 packStateValue 會原樣返回（壓完更大），讀側必須認得這種沒前綴的值。
  it('壓完反而更大的短內容保持原樣，讀回來也認', async () => {
    const tiny = '{"v":2}';
    expect(await packStateValue(tiny)).toBe(tiny);
    expect(await unpackStateValue(tiny)).toBe(tiny);
  });

  // 迴歸守衛：上面那份 repeat 出來的樣本壓縮率 20 倍以上，怎麼比都划算，測不出口徑錯誤。
  // 真實 fire_pack 是中文散文，壓縮率只有 2~3 倍，恰好落在「按字符數比不划算、按字節比
  // 划算」的缺口裡——線上就是這麼一份都沒壓成的：13977 字節的提示詞壓完 base64 約 7000
  // 字符，拿它跟原文 5849 個**字符**比，7000 > 5849 判定「壓完更大」直接放棄，而實際
  // 字節數是 7000 < 13977，省了一半。
  //
  // 下面這段用固定序列從常用字裡取，壓縮率 2.8 倍，跟真實提示詞一個量級。
  it('中文按字節算划算就要壓（不能拿字符數比）', async () => {
    const CHARS = '的一是了我不人在他有這個上們來到時大地為子中你說生國年著就那和要她出也得裡後自以會家可下而過天去能對小多然於心學麼之都好看起發當沒成只如事把還用第樣道想作種開美總從無情己面最女但現前些所同日手又行意動方期它頭經長兒回位分愛老因很給名法間斯知世什兩次使身者被高已親其進此話常與活正感';
    const prose = Array.from(
      { length: 400 },
      (_, i) => CHARS[(i * 37 + (i >> 4) * 11) % CHARS.length],
    ).join('');
    const rawBytes = new TextEncoder().encode(prose).length;
    // 前提：這段內容按字符數比是「不划算」的，正是舊口徑會放棄的那一類。
    expect(rawBytes).toBeGreaterThan(prose.length * 2);

    const packed = await packStateValue(prose);
    expect(packed.startsWith('gz1:'), '按字節算划算就該壓').toBe(true);
    expect(packed.length).toBeLessThan(rawBytes);
    expect(packed.length).toBeGreaterThan(prose.length); // 按字符數比反而更長
    expect(await unpackStateValue(packed)).toBe(prose);
  });

  it('壓過的值解出來還能正常 parse 成 fire_pack', async () => {
    const packed = await packStateValue(bigJson);
    const pack = parseFirePack(await unpackStateValue(packed));
    expect(pack?.targetName).toBe('小明');
    expect(pack?.tzId).toBe('Asia/Shanghai');
  });

  it('數據損壞時解壓拋錯，不會把半截內容當正常值放過去', async () => {
    await expect(unpackStateValue('gz1:bm90LWd6aXAtYXQtYWxs')).rejects.toThrow();
  });
});

// 迴歸守衛：升 fire_pack 版本要 worker bundle 和前端一起動，而設置頁的版本門檻讀的是
// **上游 amsg-server 庫**的版本號——只改 SullyOS 自己那份 worker 代碼時那個號不動，門檻不亮。
// 用戶忘了重貼 bundle 時，唯一能看到的線索就是面板上的 lastError，所以這句話得說清該做什麼。
// 注意這裡釘的是「說明白」，不是「兼容」：版本對不上照樣整包打回。
describe('fire_pack 版本對不上時說清該做什麼', () => {
  const pack = (v: unknown) => JSON.stringify({
    v, template: 'x', lastUserMessageAt: null, tzId: 'UTC', userTzId: 'UTC', targetName: 'A',
    builtAt: 1, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  });

  it('舊包（worker 新、前端舊）→ 讓用戶打開一次網頁重傳', () => {
    expect(parseFirePack(pack(FIRE_PACK_VERSION - 1))).toBeNull();
    expect(describeFirePackVersion(pack(FIRE_PACK_VERSION - 1))).toContain('前端比 worker 舊');
  });

  it('新包（前端新、worker 舊）→ 讓用戶去重新粘貼部署', () => {
    expect(parseFirePack(pack(FIRE_PACK_VERSION + 1))).toBeNull();
    expect(describeFirePackVersion(pack(FIRE_PACK_VERSION + 1))).toContain('重新粘貼部署');
  });

  it('版本號對得上但別的字段壞了 → 不甩鍋給部署', () => {
    const reason = describeFirePackVersion(pack(FIRE_PACK_VERSION));
    expect(reason).toContain('數據損壞');
    expect(reason).not.toContain('粘貼');
  });

  it('壓根不是 JSON / 沒版本號', () => {
    expect(describeFirePackVersion('not json')).toContain('不是合法 JSON');
    expect(describeFirePackVersion('{}')).toContain('沒有版本號');
  });
});

// ─── v7：即時對話的 chat 段 ───
//
// 開發期規矩：版本對不上整包打回，不做任何形狀兼容。v6 的包被放行的話，標了即時對話
// 的任務會拿不到 chat 段——而那時 worker 已經走過版本門，只能一路跑到「用主動消息模板
// 答用戶剛說的話」，出來的東西驢唇不對馬嘴且沒有報錯。
describe('fire_pack v7 的 chat 段', () => {
  const base: AmsgFirePack = {
    v: FIRE_PACK_VERSION, template: 'x', lastUserMessageAt: null,
    tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: '小明',
    builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };
  const chat = { messages: [{ role: 'user', content: '在嗎' }], builtAt: 1_700_000_000_000 };

  it('當前版本號是 7（升版要前端和 worker 一起動）', () => {
    expect(FIRE_PACK_VERSION).toBe(7);
  });

  it('v6 的包直接拒（不做舊格式兼容）', () => {
    expect(parseFirePack(JSON.stringify({ ...base, v: 6 }))).toBeNull();
    expect(describeFirePackVersion(JSON.stringify({ ...base, v: 6 })))
      .toContain('前端比 worker 舊');
  });

  it('不帶 chat 段照樣合法（沒開即時對話的角色就是這樣）', () => {
    expect(parseFirePack(JSON.stringify(base))).toEqual(base);
  });

  it('帶了 chat 段就原樣返回', () => {
    const withChat = { ...base, chat };
    expect(parseFirePack(JSON.stringify(withChat))).toEqual(withChat);
  });

  it('chat 段形狀不對 → 整包打回（半份對話消息比沒有更糟）', () => {
    const bad = (value: unknown) => parseFirePack(JSON.stringify({ ...base, chat: value }));
    expect(bad(null)).toBeNull();
    expect(bad({ messages: [], builtAt: 1 })).toBeNull();                     // 空數組
    expect(bad({ messages: [{ role: 'user' }], builtAt: 1 })).toBeNull();     // 缺 content
    expect(bad({ messages: [{ content: '在嗎' }], builtAt: 1 })).toBeNull();  // 缺 role
    expect(bad({ messages: chat.messages })).toBeNull();                      // 缺 builtAt
    expect(bad({ messages: chat.messages, builtAt: 'x' })).toBeNull();
  });

  // 帶圖片的消息本地就是結構化分段，雲端這條路要原樣送到模型面前——parse 認不了
  // 這種形狀的話，整包被打回、fire 硬失敗，用戶看到的是「一直在輸入」。
  it('結構化分段的 content 照收（圖片消息本地就長這樣）', () => {
    const structured = {
      ...base,
      chat: {
        builtAt: 1_700_000_000_000,
        messages: [
          { role: 'user', content: [
            { type: 'text', text: '08:00 [User sent an image]' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ] },
          { role: 'assistant', content: '好可愛' },   // 同一串裡混著純文本也行
        ],
      },
    };
    expect(parseFirePack(JSON.stringify(structured))).toEqual(structured);
  });

  it('分段只查到 type 為止（圖片那套方言歸 chat API 管，這層只負責搬）', () => {
    const withOddPart = {
      ...base,
      chat: {
        builtAt: 1,
        messages: [{ role: 'user', content: [{ type: '將來才有的新分段', 隨便什麼字段: 1 }] }],
      },
    };
    expect(parseFirePack(JSON.stringify(withOddPart))).toEqual(withOddPart);
  });

  it('分段數組本身不合格 → 整包打回', () => {
    const bad = (content: unknown) => parseFirePack(JSON.stringify({
      ...base, chat: { builtAt: 1, messages: [{ role: 'user', content }] },
    }));
    expect(bad([])).toBeNull();                          // 空數組 = 沒內容
    expect(bad([{ text: '缺 type' }])).toBeNull();
    expect(bad([{ type: 123 }])).toBeNull();             // type 不是字符串
    expect(bad(['純字符串分段'])).toBeNull();
    expect(bad([null])).toBeNull();
    expect(bad([[{ type: 'text' }]])).toBeNull();        // 嵌套數組不算分段對象
    expect(bad(42)).toBeNull();
  });
});

// 「此刻在做什麼」那一段的鐘點跟著角色的「時間感知」開關走。開關的值 worker 從
// tool_pack.timeAwarenessEnabled 讀（與今日節日同源），經 renderFirePack 透傳到
// renderFireSceneBlock。斷的是「透傳」這一環：渲染本身在 amsgFireScene.test.ts 裡釘過。
describe('renderFirePack — 把 includeClock 透傳給場景塊', () => {
  const scenePack: AmsgFirePack = {
    v: FIRE_PACK_VERSION,
    builtAt: 1_700_000_000_000,
    pendingTasks: [],
    selfScheduleEnabled: true,
    template: AMSG_SLOT_SCENE,
    lastUserMessageAt: null,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明同學',
    scene: {
      charId: 'char-clock',
      dateKey: '2026-08-02',
      schedule: {
        slots: [
          { startTime: '08:00', activity: '起床做早飯' },
          { startTime: '22:00', activity: '睡覺' },
        ],
      },
      songPool: [],
    },
  } as AmsgFirePack;

  /** 2026-08-02 上海 23:10。 */
  const at = Date.UTC(2026, 7, 2, 23 - 8, 10);

  it('不傳時照常報鐘點（老行為）', () => {
    expect(renderFirePack(scenePack, at, '指令')).toContain('當前時段：22:00 你正在睡覺');
  });

  it('includeClock=false 時鐘點消失，活動還在', () => {
    const out = renderFirePack(scenePack, at, '指令', { includeClock: false });
    expect(out).toContain('你正在睡覺');
    expect(out).not.toContain('22:00');
  });
});
