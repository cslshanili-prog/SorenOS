/**
 * 信號墜落處 · 客戶端 API
 *
 * 跨用戶接龍現代詩。複用漂流瓶（post-office worker）的同一後端、同一匿名
 * deviceId、同一筆名馬賽克與限流基建，但走獨立的 /poem/* 端點。
 *
 * 模型：全局同時只有一首「當前」詩。誰登入讀到的永遠是最新全文；沒寫完就
 * 接一句，沒有 open 詩就起新篇（自擬標題 + 第一句 + 已 roll 的篇幅）；寫滿
 * 篇幅自動封存進詩集。user 不參與，只有角色寫。
 */

import { SignalBooklet, SignalPoem } from '../../types';
import { getPostOfficeBase, getDeviceId, maskPen } from './postOffice';

export interface SignalState {
    booklet: SignalBooklet;
    /** 當前那首還沒寫完的詩；null = 該起新篇 */
    poem: SignalPoem | null;
    /** 近期封存的幾首，供起新篇時「讀之前的詩」找靈感 */
    recent: SignalPoem[];
    /** 管理員是否暫停了「詩歌推入」（true 時角色不再起新篇/接龍） */
    paused?: boolean;
}

// ── 本地精確歸屬：詩是匿名的（pen 馬賽克），但「我這台機器哪句是哪個 char 寫的」
// 只對自己有意義、也只該自己知道，故純本地存 (poemId → seq → charName)。換設備不帶走。
const AUTHOR_KEY = 'signal_my_authorship';
type AuthorMap = Record<string, Record<string, string>>;
export function recordMyLine(poemId: string, seq: number, charName: string, content?: string): void {
    try {
        const m: AuthorMap = JSON.parse(localStorage.getItem(AUTHOR_KEY) || '{}');
        (m[poemId] ||= {})[String(seq)] = charName;
        const keys = Object.keys(m);
        if (keys.length > 80) for (const k of keys.slice(0, keys.length - 80)) delete m[k]; // 防膨脹，留最近 80 首
        localStorage.setItem(AUTHOR_KEY, JSON.stringify(m));
    } catch { /* ignore */ }
    // 順手記「這個 char 寫過什麼」——寫詩時喂回去禁止複用意象（治「胃痛角色句句是胃藥」）
    if (content) {
        try {
            const l: Record<string, string[]> = JSON.parse(localStorage.getItem(MY_LINES_KEY) || '{}');
            l[charName] = [...(l[charName] || []), content].slice(-24); // 每 char 留最近 24 句
            localStorage.setItem(MY_LINES_KEY, JSON.stringify(l));
        } catch { /* ignore */ }
    }
}
/** 取某首詩裡「我這台機器寫的句子」→ {seq: charName}。 */
export function getMyAuthorship(poemId: string): Record<string, string> {
    try { return (JSON.parse(localStorage.getItem(AUTHOR_KEY) || '{}') as AuthorMap)[poemId] || {}; }
    catch { return {}; }
}
const MY_LINES_KEY = 'signal_my_lines';
/** 某個 char 在詩冊裡寫過的句子（本地，最近 24）——注入 prompt 防它反覆用同一批意象。 */
export function getMyRecentLines(charName: string): string[] {
    try { return (JSON.parse(localStorage.getItem(MY_LINES_KEY) || '{}') as Record<string, string[]>)[charName] || []; }
    catch { return []; }
}

// ── 首次參與的知情提醒：這是跨用戶特別活動，角色接龍寫下的內容對所有其他用戶
// 公開可見、可能被截圖二次傳播；確認過一次即記下，之後參與不再彈。
const NOTICE_ACK_KEY = 'signal_notice_ack';
export function hasSignalNoticeAck(): boolean {
    try { return localStorage.getItem(NOTICE_ACK_KEY) === '1'; } catch { return false; }
}
export function ackSignalNotice(): void {
    try { localStorage.setItem(NOTICE_ACK_KEY, '1'); } catch { /* ignore */ }
}

// ── 備份用：把「你·角色」句子歸屬與反覆用記錄隨「設置 → 導出/導入備份」帶走 ──
// deviceId/後端地址由郵局的 exportPostOfficeLocal 攜帶（信和詩共用身份），這裡只補詩自己的本機記錄。
// 耳語（signal_whisper）是取即焚的瞬態，故意不進備份。
const BACKUP_KEYS = [AUTHOR_KEY, MY_LINES_KEY, NOTICE_ACK_KEY] as const;
export function exportSignalLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        for (const k of BACKUP_KEYS) { const v = localStorage.getItem(k); if (v) out[k] = v; }
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importSignalLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        for (const k of BACKUP_KEYS) if (typeof data[k] === 'string' && data[k]) localStorage.setItem(k, data[k]);
    } catch { /* ignore */ }
}

// ── 用戶的「耳語」：參與時留給角色的一句話。不進詩、不上後端，只注入這一次 prompt。
// 用 localStorage 走一趟（participate → triggerNow → runSession），取即焚。
const WHISPER_KEY = 'signal_whisper';
export function setSignalWhisper(charId: string, text: string): void {
    try {
        const m: Record<string, string> = JSON.parse(localStorage.getItem(WHISPER_KEY) || '{}');
        if (text.trim()) m[charId] = text.trim().slice(0, 80); else delete m[charId];
        localStorage.setItem(WHISPER_KEY, JSON.stringify(m));
    } catch { /* ignore */ }
}
/** 取走該 char 的耳語（取即刪，只用一次）。 */
export function takeSignalWhisper(charId: string): string {
    try {
        const m: Record<string, string> = JSON.parse(localStorage.getItem(WHISPER_KEY) || '{}');
        const t = m[charId] || '';
        if (t) { delete m[charId]; localStorage.setItem(WHISPER_KEY, JSON.stringify(m)); }
        return t;
    } catch { return ''; }
}

async function call<T>(path: string, opts: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
    const base = getPostOfficeBase();
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const res = await fetch(`${base}${path}${qs}`, {
        method: opts.method || 'GET',
        headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers as Record<string, string> || {}) },
        body: opts.body,
    });
    const data = await res.json().catch(() => ({}));
    // 409 poem-open 是預期內的「該改去接龍」信號，連同 body 拋出讓調用方識別
    if (!res.ok || (data && data.ok === false)) {
        const err: any = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status; err.body = data;
        throw err;
    }
    return data as T;
}

export const Signal = {
    /** 後端是否可達（拉當前態成功即視為可達）。 */
    async ping(): Promise<boolean> {
        try { await call('/poem/current'); return true; } catch { return false; }
    },

    /** 讀當前態：冊子規格 + 那首未寫完的詩(全文) + 近期封存幾首。帶本機 device → 句子回 mine 標記。
     *  只讀視圖用（UI 面板）；寫詩路徑走 lock()。 */
    async current(): Promise<SignalState> {
        return await call<SignalState>('/poem/current', { query: { device: getDeviceId() } });
    },

    /**
     * 搶寫詩會話鎖。搶到才返回 {acquired:true, token, state}（state 是鎖內讀到的最新全文）；
     * 搶不到（有別的 char 正在寫 / 已暫停）返回 {acquired:false}。寫詩路徑用這個替代 current()，
     * 讓搶不到的 char 在調 LLM 前就走人 —— 既串行化接龍、又不浪費 token。
     */
    async lock(): Promise<{ acquired: boolean; token?: string; paused?: boolean; quota?: boolean; state?: SignalState }> {
        const r = await call<{ acquired: boolean; token?: string; paused?: boolean; quota?: boolean; booklet?: SignalBooklet; poem?: SignalPoem | null; recent?: SignalPoem[] }>(
            '/poem/lock', { method: 'POST', body: JSON.stringify({ device: getDeviceId() }) },
        );
        if (!r.acquired) return { acquired: false, paused: r.paused, quota: r.quota };
        return { acquired: true, token: r.token, state: { booklet: r.booklet!, poem: r.poem ?? null, recent: r.recent || [], paused: false } };
    },

    /** 放寫詩會話鎖（寫完/出錯都調；漏放也會被 TTL 自動回收）。 */
    async unlock(token: string): Promise<void> {
        try { await call('/poem/unlock', { method: 'POST', body: JSON.stringify({ token }) }); } catch { /* TTL 兜底 */ }
    },

    /**
     * 起新篇。starter 定標題 + brief（主題/方向，給後來者做參考）+ 開頭 1~2 行。
     * targetLines 應在冊子 [linesMin, linesMax] 內（服務端也會再鉗）。
     * 若此刻已有人起了頭，後端回 409 poem-open，本函數拋出 err.body.poem 供改為接龍。
     */
    async start(p: { title: string; brief: string; lines: string[]; targetLines: number; pen: string }): Promise<SignalState> {
        return await call<SignalState>('/poem/start', {
            method: 'POST',
            // firstLine 是給「還沒更新到支持 lines[] 的舊 worker」的兼容字段
            body: JSON.stringify({ device: getDeviceId(), pen: maskPen(p.pen), title: p.title, brief: p.brief, lines: p.lines, firstLine: p.lines[0], targetLines: p.targetLines }),
        });
    },

    /** 接龍：給指定詩續 1~2 行。返回最新態（sealed=寫滿；quota=該 user 在這首裡已落筆滿額，本次未寫入）。 */
    async append(p: { poemId: string; lines: string[]; pen: string }): Promise<{ ok: boolean; sealed?: boolean; gone?: boolean; quota?: boolean; poem?: SignalPoem }> {
        return await call('/poem/append', {
            method: 'POST',
            // content 是給舊 worker 的兼容字段
            body: JSON.stringify({ device: getDeviceId(), pen: maskPen(p.pen), poemId: p.poemId, lines: p.lines, content: p.lines[0] }),
        });
    },

    /** 翻閱詩集：已封存的詩（含全文），最近優先。mineOnly = 只看本機 char 參與過的；帶 device → 句子回 mine 標記。 */
    async feed(limit = 30, opts?: { mineOnly?: boolean; bookletId?: string }): Promise<SignalPoem[]> {
        const r = await call<{ poems: SignalPoem[] }>('/poem/feed', {
            query: {
                limit: String(limit), device: getDeviceId(),
                ...(opts?.mineOnly ? { mine: '1' } : {}),
                ...(opts?.bookletId ? { booklet: opts.bookletId } : {}),
            },
        });
        return r.poems || [];
    },

    // ── 管理（憑 ADMIN_TOKEN，與漂流瓶同一個 token）──
    /** [管理] 列出後端全部詩（open 在前）+ 當前暫停態。 */
    async adminList(token: string): Promise<{ poems: SignalPoem[]; paused: boolean }> {
        const r = await call<{ poems: SignalPoem[]; paused: boolean }>('/poem/admin-list', { headers: { Authorization: `Bearer ${token}` } });
        return { poems: r.poems || [], paused: !!r.paused };
    },
    /** [管理] 刪一整首詩（只給 poemId）或刪單句（poemId + seq）。 */
    async adminDelete(token: string, target: { poemId: string; seq?: number }): Promise<void> {
        await call('/poem/admin-delete', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(target) });
    },
    /** [管理] 暫停 / 恢復「詩歌推入」。 */
    async adminPause(token: string, paused: boolean): Promise<boolean> {
        const r = await call<{ paused: boolean }>('/poem/admin-pause', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ paused }) });
        return !!r.paused;
    },
};
