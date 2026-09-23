// utils/amsgDiagnostics.test.ts
// 迴歸守衛：
//   1. fetch 失敗不能再把 "Failed to fetch" 原樣丟給用戶——必須說出連的是哪個域名、
//      可能的三個原因，以及「到點推送不走這條路」。社區裡排查這一句花掉過好幾天。
//   2. 各家瀏覽器報「連不上」的說法不一樣（Chrome 的 Failed to fetch、Safari 的
//      Load failed、舊 Firefox 的 NetworkError），漏認一種就有一批人只剩英文原文。
//   3. 體檢面板的紅綠判定：缺 D1 綁定、表結構是舊的、VAPID 沒配、雲端沒登記收件設備，
//      這四種都是「界面上一切正常、就是一條都不發」，必須各自單獨報出來。
//   4. 連不上 / 回執形狀不對時，其餘各項一律 unknown，不許假裝綠——那比不體檢更糟，
//      用戶會照著綠燈去別處瞎找。
//   5. 「定時任務」那一行按實際情況說話：在失敗重試、被掐掉、用戶自己暫停了、每分鐘
//      那一跳在報錯，各有各的說法，報錯原文要能看到。
import { describe, it, expect } from 'vitest';
import {
  AmsgDebugReport,
  AmsgDiagnosticsInput,
  buildAmsgDiagnosticRows,
  describeAmsgFetchFailure,
  INSTANT_CHAT_BLOCKER_HINTS,
  InstantChatBlocker,
  InstantChatGateInput,
  parseAmsgDebugReport,
  readWorkerHost,
  resolveInstantChatBlocker,
  summarizeAmsgDiagnostics,
} from './amsgDiagnostics';
import { AmsgTickReport, AmsgTickReportTask, parseAmsgTickReport } from './amsgTickReport';

const WORKER_URL = 'https://amsg.example.workers.dev';

const rowOf = (rows: ReturnType<typeof buildAmsgDiagnosticRows>, key: string) => {
  const row = rows.find((item) => item.key === key);
  if (!row) throw new Error(`體檢結果裡沒有 ${key} 這一行`);
  return row;
};

/** 一份全綠的回執，各用例只改自己要考的那一處。 */
const healthyReport = (patch: Partial<AmsgDebugReport> = {}): AmsgDebugReport => ({
  config: { ok: true, missing: [], message: 'Worker 配置齊全。', warnings: [] },
  storage: {
    reachable: true,
    schemaReady: true,
    missingTables: [],
    missingColumns: [],
    pushSubscriptionRegistered: true,
    pushDelivery: { probed: true, gone: null, registeredAtMs: Date.parse('2026-08-10T04:00:00.000Z') },
    pendingTasks: 2,
    overdueTasks: 0,
    oldestOverdueMinutes: null,
  },
  tick: 'healthy',
  server: { version: '2.6.0-next.15', featureCount: 27 },
  vapidPublicKey: 'BNPtv_1egsDlvOIk',
  ...patch,
});

describe('describeAmsgFetchFailure — 把 fetch 異常翻成人話', () => {
  it('連不上時說清域名、三個可能原因，以及推送不受影響', () => {
    const { message, kind } = describeAmsgFetchFailure(
      Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }),
      '初始化數據庫',
      WORKER_URL,
    );

    expect(kind).toBe('網絡失敗');
    // 域名：不說打的是哪兒，用戶沒法判斷是自己網絡的問題還是地址填錯了。
    expect(message).toContain('amsg.example.workers.dev');
    expect(message).toContain('連不上');
    // 三條自查線索都要在，缺一條就會有人往錯的方向翻。
    expect(message).toContain('Deno');
    expect(message).toContain('地址填錯');
    // 最要緊的一句：別讓用戶以為主動消息整個廢了。
    expect(message).toContain('推送');
    expect(message).toMatch(/不走[这這][条條]路|不受影[响響]/);
    // 光禿禿的英文原文不該是用戶看到的全部。
    expect(message).not.toBe('Failed to fetch');
  });

  it('Safari 的 Load failed 和舊 Firefox 的 NetworkError 同樣認得出來', () => {
    const safari = describeAmsgFetchFailure(new TypeError('Load failed'), '讀取任務列表', WORKER_URL);
    const firefox = describeAmsgFetchFailure(
      Object.assign(new Error('NetworkError when attempting to fetch resource.'), { name: 'NetworkError' }),
      '讀取任務列表',
      WORKER_URL,
    );

    for (const result of [safari, firefox]) {
      expect(result.kind).toBe('網絡失敗');
      expect(result.message).toContain('連不上');
    }
  });

  it('超時單獨成一句：這是「慢」不是「不通」，處理辦法不一樣', () => {
    const { message, kind } = describeAmsgFetchFailure(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
      '即時對話',
      WORKER_URL,
    );

    expect(kind).toBe('網絡失敗');
    expect(message).toContain('超時');
    expect(message).toContain('amsg.example.workers.dev');
  });

  it('打到網頁上（拿回 HTML）仍然單獨歸類，指去檢查地址', () => {
    const { message, kind } = describeAmsgFetchFailure(
      new Error(`Unexpected token '<', "<!doctype ..." is not valid JSON`),
      '配置自檢',
      WORKER_URL,
    );

    expect(kind).toBe('打到網頁了');
    expect(message).toContain('網頁');
  });

  it('沒填地址時不硬湊域名，也不把 undefined 印出來', () => {
    const { message } = describeAmsgFetchFailure(new TypeError('Failed to fetch'), '初始化數據庫', '');
    expect(message).not.toContain('undefined');
    expect(message).not.toContain('（）');
  });

  it('認不出來的異常保留原文，不吞成一句「網絡錯誤」', () => {
    const { message, kind } = describeAmsgFetchFailure(new Error('AES-GCM decrypt failed'), '讀取雲端狀態', WORKER_URL);
    expect(kind).toBe('其他');
    expect(message).toContain('AES-GCM decrypt failed');
  });
});

describe('readWorkerHost', () => {
  it('取域名，取不到就返回空串', () => {
    expect(readWorkerHost('https://amsg.example.workers.dev/')).toBe('amsg.example.workers.dev');
    expect(readWorkerHost('  ')).toBe('');
    expect(readWorkerHost('不是個地址')).toBe('');
    expect(readWorkerHost(undefined)).toBe('');
  });
});

describe('parseAmsgDebugReport — 只認形狀對得上的回執', () => {
  it('認得出正常回執', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport() });
    expect(parsed?.config.ok).toBe(true);
    expect(parsed?.tick).toBe('healthy');
    expect(parsed?.server?.version).toBe('2.6.0-next.15');
  });

  it('舊 worker 回的 404 / 代理塞回來的 HTML 一律判成「沒有這個端點」，不當成體檢結果', () => {
    expect(parseAmsgDebugReport({ success: false, error: { code: 'NOT_FOUND' } })).toBeNull();
    expect(parseAmsgDebugReport('<!doctype html><html></html>')).toBeNull();
    expect(parseAmsgDebugReport(null)).toBeNull();
    // 有 data 但缺關鍵字段的，同樣不採信。
    expect(parseAmsgDebugReport({ success: true, data: { config: {} } })).toBeNull();
  });

  // 老 bundle 的回執裡壓根沒有 pushDelivery 這一段。收斂成顯式的「沒查」而不是讓
  // undefined 一路漏到界面上——判定那側只要漏寫一個 ?. 就又是一個假綠燈。
  it('缺 pushDelivery 段（老 Worker）收斂成 probed:false / unsupported', () => {
    const { pushDelivery: _drop, ...storage } = healthyReport().storage;
    const parsed = parseAmsgDebugReport({ success: true, data: { ...healthyReport(), storage } });
    expect(parsed?.storage.pushDelivery).toEqual({ probed: false, reason: 'unsupported' });
  });

  it('worker 顯式回 null（自己查不成）收斂成 probed:false / failed', () => {
    const parsed = parseAmsgDebugReport({
      success: true,
      data: healthyReport({ storage: { ...healthyReport().storage, pushDelivery: null as any } }),
    });
    expect(parsed?.storage.pushDelivery).toEqual({ probed: false, reason: 'failed' });
  });

  it('形狀不全的 gone（缺狀態碼或時刻）當沒查到，不硬湊成一次失敗', () => {
    const parsed = parseAmsgDebugReport({
      success: true,
      data: healthyReport({
        storage: {
          ...healthyReport().storage,
          pushDelivery: { gone: { status: 410 }, registeredAtMs: 1700 } as any,
        },
      }),
    });
    expect(parsed?.storage.pushDelivery).toEqual({ probed: true, gone: null, registeredAtMs: 1700 });
  });

  it('tick 是沒見過的值時退回 unknown，不原樣透出去', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport({ tick: 'wat' as any }) });
    expect(parsed?.tick).toBe('unknown');
  });

  // 迴歸守衛：failing（在失敗重試，但沒卡住）是後加的一檔。認不出來就被壓成 unknown，
  // 那一行會變成「暫時看不出定時器在不在跑」，正在重試的任務就這麼從體檢裡消失了。
  it('認得 failing 這一檔，不壓成 unknown', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport({ tick: 'failing' }) });
    expect(parsed?.tick).toBe('failing');
  });
});

describe('buildAmsgDiagnosticRows — 紅綠判定', () => {
  it('全綠時每一行都是 ok', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport() },
      localPushSubscribed: true,
    });
    expect(rows.every((row) => row.level === 'ok')).toBe(true);
    expect(summarizeAmsgDiagnostics(rows)).toBe('ok');
  });

  it('連不上時其餘各項是 unknown，不假裝綠', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: false, reason: '連不上你的 Worker（amsg.example.workers.dev）。' },
      localPushSubscribed: true,
    });

    expect(rowOf(rows, 'reachable').level).toBe('bad');
    expect(rowOf(rows, 'reachable').detail).toContain('連不上');
    expect(rows.filter((row) => row.key !== 'reachable').every((row) => row.level === 'unknown')).toBe(true);
    expect(rows.some((row) => row.level === 'ok')).toBe(false);
  });

  it('D1 沒綁：點名是部署第一步漏點了 Add，且不再拿數據表報第二次紅', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: { ok: false, missing: ['DB'], message: 'Worker 配置不完整', warnings: [] },
          storage: { reachable: false },
        }),
      },
      localPushSubscribed: true,
    });

    const database = rowOf(rows, 'database');
    expect(database.level).toBe('bad');
    expect(database.detail).toContain('Add');
    expect(database.detail).toContain('Bindings');
    expect(database.detail).toContain('DB');
    // 庫沒綁的時候表當然是空的，這一行跟著報紅只會把人往錯的方向引。
    expect(rowOf(rows, 'schema').level).toBe('unknown');
  });

  it('主密鑰缺失時提醒類型要選 Secret（選成 Text 下次部署就沒了）', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: { ok: false, missing: ['AMSG_MASTER_KEY'], message: '', warnings: [] },
        }),
      },
      localPushSubscribed: true,
    });

    const masterKey = rowOf(rows, 'masterKey');
    expect(masterKey.level).toBe('bad');
    expect(masterKey.detail).toContain('Secret');
  });

  /**
   * 迴歸守衛：查不了 ≠ 齊了。
   *
   * 這一項存在的全部意義就是查出「升級完 Worker 沒重新連接」造成的表結構漂移——漂移時
   * cron 每分鐘靜默失敗、主動消息整個停擺，而配置自檢、任務列表、界面全都正常。查詢本身
   * 掛了卻報一句「表和列都齊了」，等於在唯一能發現這件事的地方給了假綠燈，比沒有這項檢查
   * 更糟。2026-08-09 本地實機跑到過：庫裡真缺 last_error 列和 message_outbox 表，
   * 面板照報「數據表 正常」。
   */
  it('worker 查不了表結構（schemaReady=null）→ 報未知，絕不報正常', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: null,
            missingTables: [],
            missingColumns: [],
            pushSubscriptionRegistered: true,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const schema = rowOf(rows, 'schema');
    expect(schema.level).toBe('unknown');
    expect(schema.level).not.toBe('ok');
    // 過去這一檔說的就是這句——它正是那個假綠燈。
    expect(schema.detail).not.toContain('表和列都齊了');
    // 整塊體檢的基調也不能是「一切正常」。
    expect(summarizeAmsgDiagnostics(rows)).not.toBe('ok');
  });

  /**
   * 迴歸守衛：查不成的時候要說清楚是**哪一種**查不成。
   *
   * 三檔要用戶做的事完全不同，混成一句「查不了，不知道」等於什麼都沒說——真實故障裡
   * 原因躺在 Cloudflare 日誌裡，用戶看不到，只能一路猜。2026-08-09 從零部署穩定復現的
   * 就是 denied 那檔：新建的 D1 庫自帶一張 Cloudflare 內部表，上游逐表問列時被它拒掉。
   */
  it('查不成的原因分檔說話，不再一句「不知道」打發', () => {
    const rowFor = (schemaError: 'denied' | 'unsupported' | 'timeout' | 'other' | undefined) =>
      rowOf(buildAmsgDiagnosticRows({
        probe: {
          reachable: true,
          report: healthyReport({
            storage: {
              reachable: true,
              schemaReady: null,
              schemaError,
              missingTables: [],
              missingColumns: [],
              pushSubscriptionRegistered: true,
              pendingTasks: 0,
              overdueTasks: 0,
              oldestOverdueMinutes: null,
            },
          }),
        },
        localPushSubscribed: true,
      }), 'schema');

    // 後端自己的毛病：得說明不影響收發，別讓用戶白點一通按鈕。
    expect(rowFor('denied').detail).toContain('內部表');
    expect(rowFor('denied').detail).toContain('不受影響');
    // 後端太舊：指向「更新 Worker」，不是「重新連接」。
    expect(rowFor('unsupported').detail).toContain('更新 Worker');
    // 庫剛醒：再體檢一次就好，不用改任何東西。
    expect(rowFor('timeout').detail).toContain('過一會兒');
    // 老 worker 不報這一項 → 退回原來那句籠統的，不能變成空字符串。
    expect(rowFor(undefined).detail).toContain('重新連接並驗證');
    expect(rowFor(undefined).detail.length).toBeGreaterThan(10);
    // 哪一檔都不許把這行說成綠的。
    (['denied', 'unsupported', 'timeout', 'other', undefined] as const).forEach((kind) => {
      expect(rowFor(kind).level).toBe('unknown');
    });
  });

  /**
   * 迴歸守衛：一張表都沒建的空庫不許顯示成全綠。
   *
   * 一鍵部署完還沒點「連接並驗證」時正好是這個組合：表一張沒建（主表不在 → schemaReady
   * 為 false），而自查被庫裡的內部表拒掉 → 「缺哪些表」是個空數組。界面只數這個數組的話，
   * 空庫和齊活的庫長得一模一樣。
   */
  it('庫是空的但自查也沒跑成 → 報紅說「一張表都沒有」，不報綠', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            schemaError: 'denied',
            missingTables: [],
            missingColumns: [],
            pushSubscriptionRegistered: false,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const schema = rowOf(rows, 'schema');
    expect(schema.level).toBe('bad');
    expect(schema.detail).not.toContain('表和列都齊了');
    expect(schema.detail).toContain('重新連接並驗證');
  });

  it('表結構是舊的（缺列）要單獨報紅並指向「重新連接並驗證」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            missingTables: [],
            missingColumns: ['lease_until', 'retry_after'],
            pushSubscriptionRegistered: true,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const schema = rowOf(rows, 'schema');
    expect(schema.level).toBe('bad');
    expect(schema.detail).toContain('lease_until');
    expect(schema.detail).toContain('重新連接並驗證');
  });

  it('缺表時說清點哪個按鈕能自動建好', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            missingTables: ['scheduled_messages'],
            missingColumns: [],
            pushSubscriptionRegistered: false,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    expect(rowOf(rows, 'schema').detail).toContain('scheduled_messages');
    expect(rowOf(rows, 'schema').detail).toContain('重新連接並驗證');
  });

  it('VAPID 沒配齊要報紅：任務建得成，到點一條都推不出去', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: {
            ok: true,
            missing: [],
            message: '',
            warnings: [{ code: 'VAPID_MISSING', message: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 沒配齊，到點消息不會推送出去。' }],
          },
        }),
      },
      localPushSubscribed: true,
    });

    const credential = rowOf(rows, 'pushCredential');
    expect(credential.level).toBe('bad');
    expect(credential.detail).toContain('推送');
    expect(summarizeAmsgDiagnostics(rows)).toBe('bad');
  });

  it('瀏覽器訂閱了但云端沒登記 → 報紅並指向「開啟通知與推送」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: { ...healthyReport().storage, pushSubscriptionRegistered: false },
        }),
      },
      localPushSubscribed: true,
    });

    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('bad');
    expect(device.detail).toContain('開啟通知與推送');
  });

  it('這台設備根本沒訂閱時也報紅，而不是看雲端臉色', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport() },
      localPushSubscribed: false,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('bad');
  });

  // ─── 假綠燈迴歸守衛 ───
  // 真實事故：登記狀態兩邊一致（瀏覽器有訂閱、Worker 上也有同一條 endpoint），
  // 但那條訂閱在推送服務那側早就作廢，每次投遞換回一個 410。體檢當時七項裡六項
  // 綠燈，用戶看著一排綠燈完全無從下手。事實一直都在（上游把推送服務回的狀態碼
  // 記進了任務的失敗記錄），只是沒人往界面上傳。
  const REGISTERED_AT = Date.parse('2026-08-10T04:00:00.000Z');
  const stamp = (atMs: number) => new Date(atMs).toISOString();
  const withDelivery = (pushDelivery: AmsgDebugReport['storage']['pushDelivery']) => healthyReport({
    storage: { ...healthyReport().storage, pushDelivery },
  });
  const goneAt = (at: string, status = 410) => ({
    probed: true as const,
    gone: { status, atMs: Date.parse(at) },
    registeredAtMs: REGISTERED_AT,
  });

  it('登記狀態全對，但上一次推送被判訂閱失效 → 這台設備報紅並指向「重置訂閱」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery(goneAt('2026-08-10T05:06:00.000Z')) },
      localPushSubscribed: true,
      formatTime: stamp,
    });

    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('bad');
    expect(device.detail).toContain('410');
    expect(device.detail).toContain('重置訂閱');
    expect(summarizeAmsgDiagnostics(rows)).toBe('bad');
  });

  it('404（端點根本不存在）同樣報紅', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery(goneAt('2026-08-10T05:06:00.000Z', 404)) },
      localPushSubscribed: true,
      formatTime: stamp,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('bad');
  });

  it('失敗記錄早於訂閱登記時刻 = 重置之前的舊帳，不報紅', () => {
    // 服務端只在失敗時寫失敗記錄、之後成功也不清。不比時刻的話，重置完那條紅燈
    // 會一直掛著——假紅燈和假綠燈一樣會把人帶偏。
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery(goneAt('2026-08-10T03:00:00.000Z')) },
      localPushSubscribed: true,
      formatTime: stamp,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('ok');
  });

  it('問不到訂閱登記時刻時報 warn：分不清新舊帳，但也不給綠燈', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: withDelivery({ ...goneAt('2026-08-10T05:06:00.000Z'), registeredAtMs: null }),
      },
      localPushSubscribed: true,
      formatTime: stamp,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('warn');
    expect(rowOf(rows, 'pushDevice').detail).toContain('重置訂閱');
  });

  it('Worker 太舊、根本不查這一項 → warn + 指去「更新 Worker」，不給綠燈', () => {
    // 這一檔是升級路上的常態：前端已經會讀了，用戶那台 Worker 還是老 bundle。
    // 給綠燈的話，假綠燈就原封不動地回來了。
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery({ probed: false, reason: 'unsupported' }) },
      localPushSubscribed: true,
    });
    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('warn');
    expect(device.detail).toContain('更新 Worker');
    expect(summarizeAmsgDiagnostics(rows)).toBe('warn');
  });

  it('查了但沒查成 → 同樣 warn，並說清到點收不到該點哪兒', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery({ probed: false, reason: 'failed' }) },
      localPushSubscribed: true,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('warn');
    expect(rowOf(rows, 'pushDevice').detail).toContain('重置訂閱');
  });

  it('雲端壓根沒登記收件設備時不提投遞——該修的是上一層', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            ...healthyReport().storage,
            pushSubscriptionRegistered: false,
            pushDelivery: goneAt('2026-08-10T05:06:00.000Z'),
          },
        }),
      },
      localPushSubscribed: true,
    });
    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('bad');
    expect(device.detail).toContain('開啟通知與推送');
    expect(device.detail).not.toContain('410');
  });

  // 沒有細帳（沒拉 / 老面板）時只剩 /debug 的兩個數，只能給籠統的那句。
  it('定時任務停擺、手上沒有細帳時說出積壓條數和該去哪兒看日誌', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          tick: 'stalled',
          storage: {
            ...healthyReport().storage,
            pendingTasks: 3,
            overdueTasks: 3,
            oldestOverdueMinutes: 42,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const tick = rowOf(rows, 'tick');
    expect(tick.level).toBe('bad');
    expect(tick.detail).toContain('3');
    expect(tick.detail).toContain('42');
    expect(tick.detail).toContain('Observability');
    expect(tick.items).toBeUndefined();
  });

  it('手上沒有待發任務時定時器一欄是 unknown，不冒充健康', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport({ tick: 'unknown' }) },
      localPushSubscribed: true,
    });
    expect(rowOf(rows, 'tick').level).toBe('unknown');
  });

  it('舊 worker 沒有體檢端點時算 warn 不算壞（它只是查不了）', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: false, reason: '這台 Worker 上還沒有體檢端點。', unsupported: true },
    });
    expect(rowOf(rows, 'reachable').level).toBe('warn');
    expect(summarizeAmsgDiagnostics(rows)).toBe('warn');
  });
});

// ─── 「定時任務」那一行：逐條細帳 ───
//
// 光有 /debug 的兩個數時，這一行只能籠統地說「定時觸發器可能沒在跑……去看日誌」。
// 真實情況裡最常見的是任務在失敗重試（原因明明白白記在任務上），其次是用戶自己暫停了
// 後台任務——照那句話去 Cloudflare 翻觸發器，什麼都翻不出來。
describe('buildAmsgDiagnosticRows — 定時任務的逐條細帳', () => {
  const NOW = Date.parse('2026-09-18T06:00:00.000Z');
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  /** 只留時分，斷言裡好認。 */
  const hhmm = (atMs: number) => new Date(atMs).toISOString().slice(11, 16);
  const TRIGGER_BROKEN_TEXT = '定時觸發器可能沒在跑';

  const LLM_REASON = 'AI API error: 404 Not Found. Request URL: https://api.example.com/v1/chat/completions\n'
    + '  — The model `gpt-4o-typo` does not exist. (provider code: model_not_found)';

  const reportTask = (patch: Partial<AmsgTickReportTask> = {}): AmsgTickReportTask => ({
    uuid: 'task-1',
    charId: 'char-1',
    contactName: '小明',
    kind: null,
    messageType: 'auto',
    nextSendAt: at(42),
    state: 'ready',
    stuck: false,
    retryCount: 0,
    retryAfter: null,
    lastStartedAt: null,
    unfinishedAttempt: false,
    lateStart: false,
    queuedBehind: false,
    lastError: null,
    ...patch,
  });

  const tickReport = (patch: Partial<AmsgTickReport> = {}): AmsgTickReport => ({
    now: new Date(NOW).toISOString(),
    tasks: [],
    recentFailures: [],
    tickFailure: null,
    truncated: false,
    ...patch,
  });

  const tickRow = (
    tick: AmsgDebugReport['tick'],
    extra: Partial<AmsgDiagnosticsInput> = {},
    storagePatch: Partial<AmsgDebugReport['storage']> = {},
  ) => rowOf(buildAmsgDiagnosticRows({
    probe: {
      reachable: true,
      report: healthyReport({
        tick,
        storage: { ...healthyReport().storage, pendingTasks: 1, overdueTasks: 1, oldestOverdueMinutes: 42, ...storagePatch },
      }),
    },
    localPushSubscribed: true,
    formatTime: hhmm,
    nowMs: NOW,
    ...extra,
  }), 'tick');

  it('在失敗重試的任務 → warn，逐條說清失敗幾次、幾點再試、為什麼，原文整段可看', () => {
    const task = reportTask({
      state: 'retry-wait',
      retryCount: 2,
      retryAfter: new Date(NOW + 5 * 60_000).toISOString(),
      lastError: { at: at(3), occurrence: at(42), reason: LLM_REASON, errorCode: 'LLM_CALL_FAILED', pushStatus: null },
    });
    const row = tickRow('failing', { tickReport: { ok: true, report: tickReport({ tasks: [task] }) } });

    expect(row.level).toBe('warn');
    // 在重試的任務既不能報綠，也不能說成觸發器壞了。
    expect(row.detail).not.toContain(TRIGGER_BROKEN_TEXT);
    expect(row.detail).toContain('失敗重試');
    expect(row.items?.[0].text).toContain('小明');
    expect(row.items?.[0].text).toContain('晚了 42 分鐘');
    expect(row.items?.[0].text).toContain('已經失敗 2 次');
    expect(row.items?.[0].text).toContain('06:05 再試');
    expect(row.items?.[0].text).toContain('模型接口拒了這次請求');
    expect(row.items?.[0].text).toContain('gpt-4o-typo');
    expect(row.items?.some((item) => item.text.includes(TRIGGER_BROKEN_TEXT))).toBe(false);
    // 原文一個字都不截：狀態碼和 Request URL 那半句只有在這兒才看得到。
    expect(row.items?.[0].raw).toBe(LLM_REASON);
  });

  it('後台任務被用戶暫停著 → warn 並說暫停中，不說觸發器壞了', () => {
    const row = tickRow('stalled', {
      cronPaused: true,
      tickReport: { ok: true, report: tickReport({ tasks: [reportTask({ stuck: true })] }) },
    }, { overdueTasks: 3, pendingTasks: 3 });

    expect(row.level).toBe('warn');
    expect(row.detail).toContain('暫停');
    expect(row.detail).not.toContain(TRIGGER_BROKEN_TEXT);
    expect(row.items?.[0].text).toContain('暫停');
    expect(row.items?.[0].text).not.toContain('Trigger events');
  });

  it('暫停著、也沒拿到細帳時同樣不說觸發器壞了', () => {
    const row = tickRow('stalled', { cronPaused: true }, { overdueTasks: 3, pendingTasks: 3 });
    expect(row.level).toBe('warn');
    expect(row.detail).toContain('暫停');
    expect(row.detail).toContain('3');
    expect(row.detail).not.toContain(TRIGGER_BROKEN_TEXT);
  });

  it('每分鐘那一跳正在報錯 → 報紅，原文帶上報錯名和原話；缺列的話指去「重新連接並驗證」', () => {
    const row = tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          tickFailure: {
            stage: 'tick',
            name: 'D1_ERROR',
            message: 'no such column: lease_until: SQLITE_ERROR',
            code: null,
            firstAt: at(30),
            lastAt: at(1),
            count: 30,
            ongoing: true,
          },
        }),
      },
    });

    expect(row.level).toBe('bad');
    expect(row.detail).toContain('每分鐘那一跳在報錯');
    const item = row.items?.find((entry) => entry.text.includes('每分鐘那一跳'));
    expect(item?.text).toContain('連著 30 次');
    expect(item?.text).toContain('整輪處理任務那一步');
    expect(item?.text).toContain('重新連接並驗證');
    expect(item?.raw).toContain('no such column: lease_until');
    expect(item?.raw).toContain('D1_ERROR');
  });

  it('整輪報錯認得出來的另外兩種各給一句該怎麼辦；階段代號翻成中文', () => {
    const failureRow = (patch: Record<string, unknown>) => tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          tickFailure: {
            stage: 'config', name: 'Error', message: 'boom', code: null,
            firstAt: at(2), lastAt: at(1), count: 2, ongoing: true, ...patch,
          },
        }),
      },
    });

    const vapid = failureRow({ name: 'VapidNotConfigured', message: 'VAPID keys missing' }).items?.[0];
    expect(vapid?.text).toContain('VAPID');
    expect(vapid?.text).toContain('讀配置那一步');

    const timeout = failureRow({ stage: 'claim_failed', message: 'D1 query timed out', code: 'D1_TIMEOUT' }).items?.[0];
    expect(timeout?.text).toContain('沒響應');
    expect(timeout?.text).toContain('給任務佔位寫庫那一步');
    expect(timeout?.raw).toBe('Error: D1 query timed out (D1_TIMEOUT)');

    const cleanup = failureRow({ stage: 'post_send_cleanup_failed_advance' }).items?.[0];
    expect(cleanup?.text).toContain('發完之後寫庫那一步');
  });

  it('整輪報錯已經停了：一小時內報 warn，更早的不提級', () => {
    const stopped = (lastMinutesAgo: number) => tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          tickFailure: {
            stage: 'tick', name: 'Error', message: 'boom', code: null,
            firstAt: at(lastMinutesAgo + 10), lastAt: at(lastMinutesAgo), count: 10, ongoing: false,
          },
        }),
      },
    });

    expect(stopped(20).level).toBe('warn');
    expect(stopped(20).items?.[0].text).toContain('之前報錯');
    expect(stopped(180).level).toBe('ok');
  });

  it('開跑過、沒發完、也沒留下原因 → 說多半是被 Cloudflare 掐掉了', () => {
    const row = tickRow('stalled', {
      tickReport: {
        ok: true,
        report: tickReport({
          tasks: [reportTask({ stuck: true, unfinishedAttempt: true, lastStartedAt: at(30) })],
        }),
      },
    });

    expect(row.level).toBe('bad');
    expect(row.items?.[0].text).toContain('掐掉');
    expect(row.items?.[0].text).toContain('05:30 開始發過');
    expect(row.items?.[0].text).toContain('Observability');
    expect(row.items?.[0].raw).toBeUndefined();
  });

  it('一直沒人來領、Worker 也沒留下報錯 → 指去看 Trigger events；有整輪報錯時改指那條', () => {
    const stuck = reportTask({ stuck: true });
    const noFailure = tickRow('stalled', { tickReport: { ok: true, report: tickReport({ tasks: [stuck] }) } });
    expect(noFailure.level).toBe('bad');
    expect(noFailure.detail).toContain('有 1 條任務到點還沒發出去');
    expect(noFailure.items?.[0].text).toContain('一直沒開始發');
    expect(noFailure.items?.[0].text).toContain('Trigger events');

    const withFailure = tickRow('stalled', {
      tickReport: {
        ok: true,
        report: tickReport({
          tasks: [stuck],
          tickFailure: {
            stage: 'tick', name: 'Error', message: 'boom', code: null,
            firstAt: at(40), lastAt: at(1), count: 40, ongoing: true,
          },
        }),
      },
    });
    expect(withFailure.items?.[0].text).toContain('原因見下面');
    expect(withFailure.items?.[0].text).not.toContain('Trigger events');
    // 任務在前，整輪報錯跟在後面——「見下面」才對得上。
    expect(withFailure.items?.[1].text).toContain('每分鐘那一跳');
  });

  it('排隊、正在發、開跑晚了，各說各的', () => {
    const report = tickReport({
      tasks: [
        reportTask({ uuid: 'a', state: 'sending', lastStartedAt: at(2) }),
        reportTask({ uuid: 'b', queuedBehind: true }),
        reportTask({ uuid: 'c', state: 'sending', lateStart: true, lastStartedAt: at(10), nextSendAt: at(42) }),
      ],
    });
    const row = tickRow('failing', { tickReport: { ok: true, report } });

    expect(row.items?.[0].text).toContain('正在發（2 分鐘前開始的）');
    expect(row.items?.[1].text).toContain('排隊');
    expect(row.items?.[2].text).toContain('到點 32 分鐘後才開始的');
    expect(row.detail).toContain('開始發得比平時晚');
  });

  it('稱呼：後台任務、即時回覆、拿不到名字的各有說法', () => {
    const report = tickReport({
      tasks: [
        reportTask({ uuid: 'a', kind: 'doorplate' }),
        reportTask({ uuid: 'b', messageType: 'instant' }),
        reportTask({ uuid: 'c', contactName: null }),
      ],
    });
    const texts = tickRow('failing', { tickReport: { ok: true, report } }).items?.map((item) => item.text) ?? [];
    expect(texts[0].startsWith('小明的後台任務：')).toBe(true);
    expect(texts[1].startsWith('小明的即時回覆：')).toBe(true);
    expect(texts[2].startsWith('某個角色：')).toBe(true);
  });

  it('最近一小時徹底沒發出去的 → warn 並逐條列出；過期跳過的不給原文', () => {
    const row = tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          recentFailures: [
            {
              uuid: 'f1', charId: 'char-1', contactName: '小明', kind: null, messageType: 'auto', outcome: 'failed',
              error: { at: at(10), occurrence: at(12), reason: 'CREDENTIAL_MISSING: 憑據 cred-1 不存在', errorCode: 'CREDENTIAL_MISSING', pushStatus: null },
            },
            {
              uuid: 'f2', charId: 'char-1', contactName: '小明', kind: null, messageType: 'auto', outcome: 'skipped',
              error: { at: at(20), occurrence: at(50), reason: 'stale', errorCode: null, pushStatus: null },
            },
          ],
        }),
      },
    });

    expect(row.level).toBe('warn');
    expect(row.detail).toContain('最近一小時有 2 次');
    expect(row.items?.[0].text).toContain('05:48 那次沒發出去，不會再補發了');
    expect(row.items?.[0].text).toContain('API 憑據');
    expect(row.items?.[0].raw).toBe('CREDENTIAL_MISSING: 憑據 cred-1 不存在');
    expect(row.items?.[1].text).toContain('這次跳過了，下次到點照常');
    expect(row.items?.[1].text).toContain('過期太久');
    expect(row.items?.[1].raw).toBeUndefined();
  });

  it('一小時以前的失敗不提級；這一行本來就不正常時才陪著列出來', () => {
    const oldFailure = {
      uuid: 'f1', charId: 'char-1', contactName: '小明', kind: null, messageType: 'auto', outcome: 'failed' as const,
      error: { at: at(180), occurrence: at(181), reason: 'boom', errorCode: null, pushStatus: null },
    };
    const quiet = tickRow('healthy', { tickReport: { ok: true, report: tickReport({ recentFailures: [oldFailure] }) } });
    expect(quiet.level).toBe('ok');
    expect(quiet.items).toBeUndefined();

    const busy = tickRow('stalled', {
      tickReport: { ok: true, report: tickReport({ tasks: [reportTask({ stuck: true })], recentFailures: [oldFailure] }) },
    });
    expect(busy.items?.map((item) => item.raw)).toContain('boom');

    // 一天以前的一律不提。
    const ancient = tickRow('stalled', {
      tickReport: {
        ok: true,
        report: tickReport({
          tasks: [reportTask({ stuck: true })],
          recentFailures: [{ ...oldFailure, error: { ...oldFailure.error, at: at(60 * 30), occurrence: at(60 * 30) } }],
        }),
      },
    });
    expect(ancient.items?.map((item) => item.raw)).not.toContain('boom');
  });

  it('細帳沒拉到 → 照舊給籠統的那句（帶積壓條數和 Observability），原因掛在下面', () => {
    const reason = '沒拿到每條任務的細帳（Worker 上的代碼可能還不是最新，點上面的「更新 Worker」）。';
    const row = tickRow('stalled', { tickReport: { ok: false, reason } }, { overdueTasks: 3, pendingTasks: 3 });

    expect(row.level).toBe('bad');
    expect(row.detail).toContain('3');
    expect(row.detail).toContain('42');
    expect(row.detail).toContain('Observability');
    expect(row.detail).toContain(TRIGGER_BROKEN_TEXT);
    expect(row.items).toEqual([{ text: reason }]);
  });

  it('一切正常時細帳拉沒拉到都不多說話', () => {
    const row = tickRow('healthy', { tickReport: { ok: false, reason: '連不上' } }, { overdueTasks: 0, oldestOverdueMinutes: null });
    expect(row.level).toBe('ok');
    expect(row.items).toBeUndefined();
  });
});

describe('parseAmsgTickReport — 認定時任務細帳', () => {
  it('單條任務形狀不對就跳過那一條，整輪報錯照樣認下來', () => {
    const parsed = parseAmsgTickReport({
      success: true,
      data: {
        now: '2026-09-18T06:00:00.000Z',
        tasks: [
          { uuid: 'ok', nextSendAt: '2026-09-18T05:00:00.000Z', state: 'ready', retryCount: 1 },
          { uuid: 'bad-state', nextSendAt: '2026-09-18T05:00:00.000Z', state: 'wat' },
          null,
        ],
        recentFailures: [],
        tickFailure: {
          stage: 'tick', name: 'D1_ERROR', message: 'no such column: lease_until',
          firstAt: '2026-09-18T05:00:00.000Z', lastAt: '2026-09-18T05:59:00.000Z', count: 60, ongoing: true,
        },
        truncated: false,
      },
    });

    expect(parsed?.tasks.map((task) => task.uuid)).toEqual(['ok']);
    expect(parsed?.tickFailure?.message).toBe('no such column: lease_until');
    expect(parsed?.tickFailure?.ongoing).toBe(true);
  });

  it('沒有這個端點的 Worker 回什麼都不採信', () => {
    expect(parseAmsgTickReport({ success: false, error: { code: 'NOT_FOUND' } })).toBeNull();
    expect(parseAmsgTickReport('<!doctype html>')).toBeNull();
  });
});

describe('resolveInstantChatBlocker — 即時對話卡在哪一道', () => {
  const ALL_PASS: InstantChatGateInput = {
    connected: true,
    pushSubscribed: true,
    workerSupportsInstantChat: true,
  };

  it('三道全過才返回 null', () => {
    expect(resolveInstantChatBlocker(ALL_PASS)).toBeNull();
  });

  it('按「先補哪個」的順序只報第一道：沒連上蓋過後面所有', () => {
    // 什麼都沒配的人會同時踩中三道。一次把三條都說給他，等於讓他自己排先後。
    expect(resolveInstantChatBlocker({
      connected: false,
      pushSubscribed: false,
      workerSupportsInstantChat: false,
    })).toBe('沒連上Worker');
  });

  it('連上了但沒訂閱推送 → 沒開推送（這時候開了就是發得出、收不到）', () => {
    expect(resolveInstantChatBlocker({ ...ALL_PASS, pushSubscribed: false, workerSupportsInstantChat: false }))
      .toBe('沒開推送');
  });

  it('連上了、推送也開了，只差 Worker 不認 /instant-chat → Worker太舊', () => {
    expect(resolveInstantChatBlocker({ ...ALL_PASS, workerSupportsInstantChat: false })).toBe('Worker太舊');
  });

  it('每個代號都配著一句話——設置頁的黃字和使用統計的屬性共用這份判定', () => {
    // 少一條的話界面上會出現空白提示：開關灰著、下面什麼都不說。
    const codes: InstantChatBlocker[] = ['沒連上Worker', '沒開推送', 'Worker太舊'];
    for (const code of codes) {
      expect(INSTANT_CHAT_BLOCKER_HINTS[code], `${code} 沒有對應文案`).toBeTruthy();
    }
    expect(Object.keys(INSTANT_CHAT_BLOCKER_HINTS)).toHaveLength(codes.length);
  });
});

