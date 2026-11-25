/**
 * 備份跑到哪了（plans/backup-streaming.md 第 4.3、4.6 節）。兩件事：
 *
 * 1. 「備份進行中」旗標（只在記憶體）：本機會自己動的排程看到就跳過這一輪，
 *    免得資料表分批讀到一半被改。
 * 2. 字條（localStorage）：備份開始時留一張、每換階段更新、正常結束或失敗都刪。
 *    分頁被系統收掉時我們什麼都來不及做；下次開機看到字條還在，就知道上次是被關掉的、
 *    做到哪一步。
 *
 * 零依賴：不碰 React、不碰資料庫。
 */

export const BACKUP_RUN_LS_KEY = 'backup_run_v1';

/**
 * 排查用的開關：localStorage 這個鍵設成 'jszip' 就退回舊容器（全部登記、最後一次生成）。
 * 沒有介面，只給開發時對照或出事時臨時救急；不省記憶體。
 */
export const BACKUP_ZIP_WRITER_LS_KEY = 'backup_zip_writer';

export type BackupRunMode = 'text_only' | 'media_only' | 'full';
/** tables 資料表、media 圖片與附件、finalize 寫目錄收尾、upload 上傳到雲端 */
export type BackupRunPhase = 'tables' | 'media' | 'finalize' | 'upload';
/** 輸出去哪：memory 記憶體、opfs 磁碟（第 2 批）、jszip 舊容器 */
export type BackupRunSink = 'memory' | 'opfs' | 'jszip';

export interface BackupRunNote {
    mode: BackupRunMode;
    phase: BackupRunPhase;
    /** 0～100 */
    percent: number;
    sink: BackupRunSink;
    startedAt: number;
    updatedAt: number;
}

type NoteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const safeStorage = (): NoteStorage | undefined => {
    try { return typeof localStorage !== 'undefined' ? localStorage : undefined; } catch { return undefined; }
};

const MODES: readonly BackupRunMode[] = ['text_only', 'media_only', 'full'];
const PHASES: readonly BackupRunPhase[] = ['tables', 'media', 'finalize', 'upload'];
const SINKS: readonly BackupRunSink[] = ['memory', 'opfs', 'jszip'];

let running = false;
let current: BackupRunNote | null = null;

/** 本機排程（日程自動生成、記憶整理、主動消息的本機檢查）看這個決定要不要跳過這一輪 */
export const isBackupRunning = (): boolean => running;

const write = (note: BackupRunNote, storage: NoteStorage | undefined) => {
    try { storage?.setItem(BACKUP_RUN_LS_KEY, JSON.stringify(note)); } catch { /* 存不了就算了，不能擋備份 */ }
};

export const beginBackupRun = (
    start: { mode: BackupRunMode; sink: BackupRunSink; phase?: BackupRunPhase; percent?: number },
    now: number = Date.now(),
    storage: NoteStorage | undefined = safeStorage(),
): void => {
    running = true;
    current = {
        mode: start.mode,
        sink: start.sink,
        phase: start.phase || 'tables',
        percent: start.percent ?? 0,
        // 雲端備份是「打包完接著上傳」：接續同一趟時留著原本的開始時間
        startedAt: current?.startedAt ?? now,
        updatedAt: now,
    };
    write(current, storage);
};

/** 換階段或進度跳了一大段時叫；同一階段、進度沒跨過 5% 不重寫（localStorage 是同步的） */
export const updateBackupRun = (
    patch: { phase?: BackupRunPhase; percent?: number },
    now: number = Date.now(),
    storage: NoteStorage | undefined = safeStorage(),
): void => {
    if (!current) return;
    const phase = patch.phase || current.phase;
    const percent = Math.max(0, Math.min(100, Math.round(patch.percent ?? current.percent)));
    if (phase === current.phase && Math.abs(percent - current.percent) < 5) return;
    current = { ...current, phase, percent, updatedAt: now };
    write(current, storage);
};

/** 正常結束、失敗、用戶取消都叫這個 */
export const endBackupRun = (storage: NoteStorage | undefined = safeStorage()): void => {
    running = false;
    current = null;
    try { storage?.removeItem(BACKUP_RUN_LS_KEY); } catch { /* ignore */ }
};

/**
 * 開機時叫一次：字條還在＝上次備份途中分頁被關掉。讀出來就刪，同一次不會提醒兩遍。
 * 這一輪自己正在跑備份時不算（那張字條是現在這趟的）。
 */
export const takeInterruptedBackupRun = (storage: NoteStorage | undefined = safeStorage()): BackupRunNote | null => {
    if (running) return null;
    let raw: string | null = null;
    try { raw = storage?.getItem(BACKUP_RUN_LS_KEY) ?? null; } catch { return null; }
    if (!raw) return null;
    try { storage?.removeItem(BACKUP_RUN_LS_KEY); } catch { /* ignore */ }
    try {
        const parsed = JSON.parse(raw) as Partial<BackupRunNote>;
        if (!MODES.includes(parsed.mode as BackupRunMode)) return null;
        return {
            mode: parsed.mode as BackupRunMode,
            phase: PHASES.includes(parsed.phase as BackupRunPhase) ? parsed.phase as BackupRunPhase : 'tables',
            sink: SINKS.includes(parsed.sink as BackupRunSink) ? parsed.sink as BackupRunSink : 'memory',
            percent: Number.isFinite(parsed.percent) ? Math.max(0, Math.min(100, Number(parsed.percent))) : 0,
            startedAt: Number(parsed.startedAt) || 0,
            updatedAt: Number(parsed.updatedAt) || 0,
        };
    } catch {
        return null;
    }
};

const MODE_LABEL: Record<BackupRunMode, string> = { full: '整合導出', media_only: '媒體導出', text_only: '純文字導出' };
const PHASE_LABEL: Record<BackupRunPhase, string> = {
    tables: '打包資料表', media: '寫入圖片與附件', finalize: '收尾', upload: '上傳到雲端',
};

/** 給人看的說明（錯誤記錄和提醒共用） */
export const describeInterruptedBackup = (note: BackupRunNote): { message: string; detail: string } => ({
    message: `上次的備份沒做完（${MODE_LABEL[note.mode]}，做到「${PHASE_LABEL[note.phase]}」約 ${note.percent}%）`,
    detail: [
        '備份途中分頁被系統關掉了，多半是手機記憶體不夠。這不是資料壞掉，原本的資料沒有動。',
        '可以試：',
        '1. 把瀏覽器其他分頁關掉、整個瀏覽器滑掉重開，進來直接備份。',
        '2. 分開做：先「純文字」，再單獨導「媒體」。',
        '3. 改在電腦上備份。',
    ].join('\n'),
});

/** 埋點用的固定枚舉（docs/analytics.md：屬性只能是寫死的值） */
export const interruptedBackupEventProps = (note: BackupRunNote): Record<string, string> => ({
    模式: note.mode === 'full' ? '整合' : note.mode === 'media_only' ? '媒体' : '纯文字',
    阶段: note.phase === 'tables' ? '资料表' : note.phase === 'media' ? '图片与附件' : note.phase === 'finalize' ? '收尾' : '上传',
    输出: note.sink === 'opfs' ? '磁盘' : note.sink === 'jszip' ? '旧容器' : '内存',
    进度: note.percent < 25 ? '0-25' : note.percent < 50 ? '25-50' : note.percent < 75 ? '50-75' : '75-100',
});

/** 這次要用哪個容器 */
export const preferredBackupSink = (storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): BackupRunSink => {
    try { return storage?.getItem(BACKUP_ZIP_WRITER_LS_KEY) === 'jszip' ? 'jszip' : 'memory'; } catch { return 'memory'; }
};
