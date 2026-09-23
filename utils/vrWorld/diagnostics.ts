/**
 * 一鍵收集排障快照。
 *
 * 起因：彼方出過一次「界面上角色全都顯示未接入，調用記錄卻還在一條條往上漲」的故障。
 * 按代碼這兩件事不該同時成立，可手機上——尤其是裝到主屏的那種——沒有控制台，
 * 拿不到任何運行時痕跡，只能靠用戶截圖猜。
 *
 * 這個函數把判斷需要的東西一次湊齊：調度表當前長什麼樣、內存裡的角色狀態和落在庫裡的
 * 那份對不對得上、瀏覽器還剩多少存儲、最近幾十輪各自是什麼結局。用戶點一下複製走即可。
 *
 * **只收狀態，不收內容**：角色 id 截成後 6 位，名字、人設、聊天記錄、提示詞、API key
 * 一概不進快照。API 只記 host、模型名和「key 填沒填、多長」。
 */
import type { CharacterProfile, APIConfig } from '../../types';
import { DB } from '../db';
import { getVRApi, getVRApiLog } from './vrApi';
import { getVRThrottleCounts } from './runSession';
import { VRScheduler } from './scheduler';
import { readStorageOverview, formatBytes } from '../storageStats';

/** 頁面這次是什麼時候起來的——用來看「跑了多久攢出這些記錄」。 */
const PAGE_STARTED_AT = Date.now();

/** 調度相關的 localStorage 鍵，一次全撈出來（彼方 / 主動發消息 / 家園各一套）。 */
const SCHEDULE_KEYS = [
    'vr_schedules', 'vr_last_fire', 'vr_fail_streak',
    'proactive_schedules', 'proactive_last_fire',
    'world_schedules', 'world_last_fire',
];

const tail = (id?: string) => (id ? `…${id.slice(-6)}` : '—');
const at = (ts?: number) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');
const mins = (ms: number) => `${Math.round(ms / 60000)} 分鐘`;

function hostOf(url?: string): string {
    if (!url) return '—';
    try { return new URL(url).host; } catch { return url.slice(0, 40); }
}

/** API 只留「連的是哪兒、用什麼模型、key 填沒填」，key 本身絕不出現。 */
function apiSummary(label: string, cfg?: APIConfig | null): string {
    if (!cfg?.baseUrl) return `${label}：未配置`;
    const key = cfg.apiKey || '';
    const keyNote = key ? `key 已填（${key.length} 位）` : 'key 是空的';
    return `${label}：${hostOf(cfg.baseUrl)} · ${cfg.model || '未選模型'} · ${keyNote}`;
}

/** localStorage 當場寫讀刪一遍。寫不進去或讀回來不一樣，下面所有調度狀態都不可信。 */
function probeLocalStorage(): string {
    const probeKey = '__sullyos_probe__';
    const expected = String(Date.now());
    try {
        localStorage.setItem(probeKey, expected);
        const back = localStorage.getItem(probeKey);
        localStorage.removeItem(probeKey);
        if (back !== expected) return `異常：寫進去 ${expected}，讀回來是 ${back}`;
        return '正常（寫讀刪都通過）';
    } catch (e: any) {
        return `寫不進去：${e?.name || ''} ${e?.message || String(e)}`.trim();
    }
}

/**
 * 瀏覽器給了多少存儲、用了多少、有沒有拿到「別清我」的許可。
 *
 * 沒拿到持久化許可的站點，在手機存儲吃緊時會被系統連數據一起清掉——「一覺醒來設置退回
 * 昨天」多半就是這麼來的，所以這兩個數值要一起看。
 */
async function probeStorageQuota(): Promise<string> {
    const ov = await readStorageOverview();
    if (!ov.supported) return '這個瀏覽器不提供存儲用量信息';
    const pct = ov.usageBytes != null && ov.quotaBytes ? `${((ov.usageBytes / ov.quotaBytes) * 100).toFixed(1)}%` : '—';
    const persisted = ov.persisted == null
        ? '未知'
        : ov.persisted ? '已獲得（系統不會隨手清）' : '**沒有**（存儲吃緊時可能被清掉）';
    return `已用 ${formatBytes(ov.usageBytes)} / 上限 ${formatBytes(ov.quotaBytes)}（${pct}）· 持久化許可：${persisted}`;
}

/**
 * 內存裡的角色狀態 vs 落在庫裡的那份。
 *
 * 這一段是衝著那個矛盾去的：界面讀的是內存，後台調度判斷讀的也是內存，兩邊理應一致；
 * 而庫裡那份要是和內存對不上，就說明用戶改的東西壓根沒寫進去（或者被誰寫回了舊值）。
 */
async function compareMemoryAgainstDb(memChars: CharacterProfile[]): Promise<string[]> {
    const lines: string[] = [];
    let dbChars: CharacterProfile[] = [];
    try {
        dbChars = await DB.getAllCharacters();
    } catch (e: any) {
        return [`讀不出庫裡的角色：${e?.message || String(e)}`];
    }
    const dbById = new Map(dbChars.map(c => [c.id, c]));
    const related = memChars.filter(c => c.vrState || dbById.get(c.id)?.vrState);
    if (related.length === 0) return ['沒有任何角色配過彼方'];

    for (const mem of related) {
        const db = dbById.get(mem.id);
        const memOn = !!mem.vrState?.enabled;
        const dbOn = !!db?.vrState?.enabled;
        const flag = memOn === dbOn ? '' : '  ← **對不上**';
        lines.push(
            `${tail(mem.id)} 內存=${memOn ? '已接入' : '未接入'} 庫裡=${db ? (dbOn ? '已接入' : '未接入') : '庫裡沒這個角色'}`
            + ` 間隔=${mem.vrState?.intervalMinutes ?? '—'}分 上次活動=${at(mem.vrState?.lastActiveAt)}`
            + `${mem.vrState?.api?.baseUrl ? ' 角色自帶API' : ''}${flag}`
        );
    }
    return lines;
}

/** 調度表裡每一條：間隔多久、上次什麼時候觸發、按理這會兒該不該動。 */
function describeSchedules(): string[] {
    let schedules: Record<string, { charId: string; intervalMs: number }> = {};
    let lastFire: Record<string, number> = {};
    try {
        schedules = JSON.parse(localStorage.getItem('vr_schedules') || '{}');
        lastFire = JSON.parse(localStorage.getItem('vr_last_fire') || '{}');
    } catch { return ['調度表解析失敗（內容不是合法 JSON）']; }

    const ids = Object.keys(schedules);
    if (ids.length === 0) return ['調度表是空的'];
    const now = Date.now();
    return ids.map(id => {
        const s = schedules[id];
        const fired = lastFire[id] || 0;
        const since = fired ? now - fired : 0;
        const due = fired > 0 && since >= s.intervalMs;
        return `${tail(id)} 間隔=${mins(s.intervalMs)} 上次觸發=${at(fired)}`
            + `（${fired ? `${mins(since)}前` : '沒記錄'}）→ 這會兒${due ? '**判定該觸發**' : '不該觸發'}`;
    });
}

/** 最近幾十輪各自是什麼結局。診斷行（攔下 / 跳過 / 暫停）也在裡面。 */
function describeRecentLog(log: Awaited<ReturnType<typeof getVRApiLog>>): string[] {
    if (log.length === 0) return ['還沒有任何記錄'];
    return log.slice(0, 40).map(l => {
        const when = at(l.ts);
        if (l.kind) return `${when} [${l.kind}] ${tail(l.charId)} ${l.note || ''}`;
        const enabled = l.charEnabled === undefined ? '' : ` 發起時=${l.charEnabled ? '已接入' : '**未接入**'}`;
        const err = l.error ? ` err=${l.error.slice(0, 60)}` : '';
        return `${when} [調用] ${tail(l.charId)} ${l.room || '—'} ${l.ok ? '成功' : '失敗'} ${(l.ms / 1000).toFixed(1)}s${enabled}${err}`;
    });
}

/** 主動消息 2.0 排著的任務。只記類型和時刻，內容一個字都不帶。 */
function describeAmsgTasks(memChars: CharacterProfile[]): string[] {
    const lines: string[] = [];
    for (const c of memChars) {
        const tasks = c.activeMsg2Config?.tasks || [];
        if (tasks.length === 0) continue;
        lines.push(`${tail(c.id)} 共 ${tasks.length} 條：`);
        for (const t of tasks.slice(0, 8)) {
            lines.push(`  · ${t.mode}/${t.recurrenceType} ${t.status} 下次=${t.nextSendAt || t.firstSendTime || '—'}`
                + ` 來源=${t.source}${t.lastError ? ` err=${t.lastError.slice(0, 40)}` : ''}`);
        }
    }
    return lines.length ? lines : ['沒有角色排著主動消息任務'];
}

/** 收一份快照，返回可以直接粘出去的純文本。 */
export async function collectVRDiagnostics(memChars: CharacterProfile[], chatApi?: APIConfig | null): Promise<string> {
    const [vrApi, log, quota] = await Promise.all([
        getVRApi().catch(() => null),
        getVRApiLog().catch(() => []),
        probeStorageQuota(),
    ]);
    const memVsDb = await compareMemoryAgainstDb(memChars);
    const standalone = (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone) ? '是（主屏圖標打開）' : '否（瀏覽器標籤裡）';
    const throttles = getVRThrottleCounts();
    const throttleLines = Object.keys(throttles).length
        ? Object.entries(throttles).map(([id, n]) => `${tail(id)} 被攔下 ${n} 次`)
        : ['沒有被攔下過（正常）'];

    const storageDump = SCHEDULE_KEYS.map(k => {
        const v = localStorage.getItem(k);
        return `${k} = ${v === null ? '（沒有這個鍵）' : v}`;
    });

    const failStreaks = memChars
        .filter(c => VRScheduler.getFailStreak(c.id) > 0)
        .map(c => `${tail(c.id)} 連續失敗 ${VRScheduler.getFailStreak(c.id)} 次`);

    return [
        '===== Soren 彼方排障快照 =====',
        `收集時間：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `時區：${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `獨立窗口：${standalone}`,
        `本次頁面已運行：${mins(Date.now() - PAGE_STARTED_AT)}`,
        `瀏覽器：${navigator.userAgent.slice(0, 120)}`,
        '',
        '--- 存儲健康 ---',
        `localStorage 自檢：${probeLocalStorage()}`,
        `存儲用量：${quota}`,
        '',
        '--- 內存 vs 庫裡（對不上 = 改的東西沒寫進去） ---',
        ...memVsDb,
        '',
        '--- 調度表 ---',
        ...describeSchedules(),
        '',
        '--- 最小間隔閘 ---',
        ...throttleLines,
        '',
        '--- 連續失敗計數 ---',
        ...(failStreaks.length ? failStreaks : ['都是 0']),
        '',
        '--- API（不含 key 本身） ---',
        apiSummary('彼方獨立', vrApi),
        apiSummary('聊天默認', chatApi),
        `角色自帶 API 的：${memChars.filter(c => c.vrState?.api?.baseUrl).length} 個`,
        '',
        '--- 主動消息任務 ---',
        ...describeAmsgTasks(memChars),
        '',
        '--- 調度相關的本地存儲原文 ---',
        ...storageDump,
        '',
        `--- 最近 ${Math.min(log.length, 40)} 條記錄 ---`,
        ...describeRecentLog(log),
        '===== 快照結束 =====',
    ].join('\n');
}
