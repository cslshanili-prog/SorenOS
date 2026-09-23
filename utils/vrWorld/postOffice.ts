/**
 * 彼方虛擬郵局 · 客戶端 API
 *
 * 對接【所有用戶共用】的後端（默認 https://noir2.cc.cd/po）。
 * 匿名：本地一個隨機 deviceId，無登錄無 PII。
 */

const DEFAULT_BASE = 'https://noir2.cc.cd/po';
const BASE_KEY = 'vr_po_base';
const DEVICE_KEY = 'vr_po_device';

/** 單封正文字數上限（按字符：1 漢字/標點 = 1 字）。UI 輸入框可用它做限制提示。 */
export const MAX_LETTER_CHARS = 400;
/** 按字符截斷到上限（兜底；後端也會再截一次） */
const clipContent = (s: string): string => [...(s || '')].slice(0, MAX_LETTER_CHARS).join('');

export const getPostOfficeBase = (): string => {
    try { return (localStorage.getItem(BASE_KEY) || DEFAULT_BASE).replace(/\/+$/, ''); }
    catch { return DEFAULT_BASE; }
};
export const setPostOfficeBase = (url: string) => {
    try { url.trim() ? localStorage.setItem(BASE_KEY, url.trim()) : localStorage.removeItem(BASE_KEY); } catch { /* ignore */ }
};

export const getDeviceId = (): string => {
    try {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id) {
            id = (globalThis.crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    } catch {
        return 'dev-anonymous';
    }
};

/**
 * 筆名馬賽克：寄信/回信時把真實角色名換成一個穩定的匿名筆名。
 * 同名 → 同筆名（便於多次往來的連續感），但圈子裡的人看不出是誰。
 */
const PEN_POOL = [
    '山雀', '渡口', '夜航船', '北緯以北', '苔痕', '停擺的鐘', '未寄出', '遠洋來信',
    '拾光', '梧桐巷口', '十一月', '舊船票', '薄霧', '信天翁', '空瓶', '逆旅',
    '簷下雨', '無人島', '回聲', '草垛', '末班車', '潮汐表', '蟬蛻', '星圖邊角',
];
export function maskPen(name: string): string {
    const n = (name || '').trim();
    if (!n) return '匿名旅人';
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return PEN_POOL[h % PEN_POOL.length];
}

export interface RemoteLetter {
    id: string; pen: string; content: string; created_at: number;
    likes?: number; dislikes?: number; views?: number; reply_count?: number;
}
export interface RemoteReply { id: string; letter_id: string; pen: string; content: string; created_at: number; }
/** 我寄出的信的熱度統計（贊/踩/瀏覽量/回信數）。 */
export interface RemoteLetterStat { id: string; likes: number; dislikes: number; views: number; reply_count: number; created_at: number; }
export interface RemoteAdminLetter { id: string; pen: string; content: string; lang?: string; created_at: number; reply_count: number; likes: number; dislikes: number; views: number; }

async function call<T>(path: string, opts: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
    const base = getPostOfficeBase();
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const res = await fetch(`${base}${path}${qs}`, {
        method: opts.method || 'GET',
        headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers as Record<string, string> || {}) },
        body: opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.ok === false)) {
        throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data as T;
}

export const PostOffice = {
    async health(): Promise<boolean> {
        try { const r = await call<{ ok: boolean }>('/health'); return !!r.ok; } catch { return false; }
    },

    /** 上傳待寄出的信，返回服務端分配的 id 列表（筆名自動馬賽克） */
    async uploadLetters(letters: { pen: string; content: string; lang?: string }[]): Promise<string[]> {
        const masked = letters.map(l => ({ ...l, pen: maskPen(l.pen), content: clipContent(l.content) }));
        const r = await call<{ ids: string[] }>('/letters', { method: 'POST', body: JSON.stringify({ device: getDeviceId(), letters: masked }) });
        return r.ids || [];
    },

    /** 隨機抽別人的、還能回的信 */
    async fetchInbox(limit = 5): Promise<RemoteLetter[]> {
        const r = await call<{ letters: RemoteLetter[] }>('/inbox', { query: { device: getDeviceId(), limit: String(limit) } });
        return r.letters || [];
    },

    /** 上傳回信（筆名自動馬賽克） */
    async uploadReplies(replies: { letterId: string; pen: string; content: string }[]): Promise<number> {
        const masked = replies.map(rp => ({ ...rp, pen: maskPen(rp.pen), content: clipContent(rp.content) }));
        const r = await call<{ accepted: number }>('/replies', { method: 'POST', body: JSON.stringify({ device: getDeviceId(), replies: masked }) });
        return r.accepted || 0;
    },

    /** 取回掛在"我寄出的信"上的回覆 */
    async fetchReplies(): Promise<RemoteReply[]> {
        const r = await call<{ replies: RemoteReply[] }>('/replies', { query: { device: getDeviceId() } });
        return r.replies || [];
    },

    /** 取回"我寄出的信"的贊/踩/瀏覽量等熱度（與 fetchReplies 同一接口，按需取用） */
    async fetchMyStats(): Promise<RemoteLetterStat[]> {
        const r = await call<{ letters: RemoteLetterStat[] }>('/replies', { query: { device: getDeviceId() } });
        return r.letters || [];
    },

    /** 點贊(1) / 點踩=舉報(-1) / 撤銷(0)。返回最新計數；信若已被刪則 deleted=true */
    async vote(letterId: string, vote: 1 | -1 | 0): Promise<{ likes: number; dislikes: number; deleted?: boolean }> {
        const r = await call<{ likes?: number; dislikes?: number; deleted?: boolean }>('/vote', {
            method: 'POST', body: JSON.stringify({ device: getDeviceId(), letterId, vote }),
        });
        return { likes: r.likes ?? 0, dislikes: r.dislikes ?? 0, deleted: r.deleted };
    },

    /** 原作者留檔後釋放（後端刪除信+回覆） */
    async release(letterIds: string[]): Promise<void> {
        if (letterIds.length === 0) return;
        await call('/release', { method: 'POST', body: JSON.stringify({ device: getDeviceId(), letterIds }) });
    },

    /** [管理] 列出後端全部信件（按踩數、時間倒序）。token 走 Bearer 頭，不進 URL。 */
    async adminList(token: string, limit = 200): Promise<RemoteAdminLetter[]> {
        const r = await call<{ letters: RemoteAdminLetter[] }>('/admin/list', {
            query: { limit: String(limit) }, headers: { Authorization: `Bearer ${token}` },
        });
        return r.letters || [];
    },

    /** [管理] 刪除指定信件（每批≤100）。 */
    async adminDelete(token: string, letterIds: string[]): Promise<number> {
        if (letterIds.length === 0) return 0;
        const r = await call<{ deleted: number }>('/admin/delete', {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({ letterIds: letterIds.slice(0, 100) }),
        });
        return r.deleted || 0;
    },
};

// ── 備份用：把郵局的本機配置隨「設置 → 導出/導入備份」一起帶走 ──────────
// 帶的是【身份 deviceId】（決定"我寄出的信"的歸屬）和【後端地址】；
// admin token 是後端管理憑證，故意不寫進可被分享的備份裡，避免洩露。
export function exportPostOfficeLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const dev = localStorage.getItem(DEVICE_KEY); if (dev) out[DEVICE_KEY] = dev;
        const base = localStorage.getItem(BASE_KEY); if (base) out[BASE_KEY] = base;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importPostOfficeLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[DEVICE_KEY] === 'string' && data[DEVICE_KEY]) localStorage.setItem(DEVICE_KEY, data[DEVICE_KEY]);
        if (typeof data[BASE_KEY] === 'string') {
            if (data[BASE_KEY]) localStorage.setItem(BASE_KEY, data[BASE_KEY]); else localStorage.removeItem(BASE_KEY);
        }
    } catch { /* ignore */ }
}

// ── 管理員 token：本地留存，免得每次重輸（僅存在本機 localStorage）──────
const ADMIN_TOKEN_KEY = 'vr_po_admin_token';
export const getAdminToken = (): string => { try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; } };
export const setAdminToken = (t: string) => { try { t.trim() ? localStorage.setItem(ADMIN_TOKEN_KEY, t.trim()) : localStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* ignore */ } };

// ── 身份導出 / 導入：換設備或清數據後找回「我的信」與責任 ──────────────
const ID_PREFIX = 'sullypo';
const idChecksum = (s: string): string => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 4).padStart(4, '0');
};
/** 導出當前身份碼（帶校驗位），可抄到別處導入。 */
export function exportIdentity(): string {
    const id = getDeviceId();
    return `${ID_PREFIX}.${id}.${idChecksum(id)}`;
}
/** 導入身份碼：校驗通過則替換本地 deviceId，返回是否成功。 */
export function importIdentity(code: string): boolean {
    const parts = (code || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== ID_PREFIX) return false;
    const [, id, sum] = parts;
    if (!id || idChecksum(id) !== sum) return false;
    try { localStorage.setItem(DEVICE_KEY, id); return true; } catch { return false; }
}
