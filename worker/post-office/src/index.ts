/**
 * SullyOS · 彼方虛擬郵局 —— 跨用戶漂流信後端（Cloudflare Worker + D1）
 *
 * 這是一個共享後端：所有用戶共用一個實例（如 https://noir2.cc.cd），
 * 別的用戶無需任何配置。信件被丟進一個公共 D1 池，隨機分發給別的設備回信，
 * 回信再路由回原作者，原作者收下並留檔後通知後端釋放。
 *
 * 匿名：客戶端只帶一個隨機 deviceId（owner_id，無登錄、無 PII）。信件只含 筆名 + 正文。
 *
 * ── 互動 / 防護（本版新增）──────────────────────────────────────────
 *  - 點贊 / 點踩：一台設備一票（可改可撤）。**點踩即舉報**，不另設舉報。
 *  - 自動刪除：一封信點踩數達閾值（PO_DISLIKE_LIMIT，默認 5）即被刪除。
 *  - 管理員：純 API（無前端）。GET /admin/list 看信、POST /admin/delete 刪信，
 *           憑 ADMIN_TOKEN（Authorization: Bearer，或 ?token=）。
 *  - 限流：按客戶端 IP 的加鹽哈希做固定窗口限流（不存原始 IP）。
 *  - 不主動按時間刪：移除了舊的 TTL 清理；信只在 ①踩滿 ②管理員刪 ③作者刪 時消失。
 *
 * ── 空間優化 ────────────────────────────────────────────────────
 *  po_devices 把長 owner_id(UUID) 映射成短整數 uid；多行的投票表 po_votes 只存 uid，
 *  避免反覆存 36 字節 UUID。對外 API 仍只認 owner_id，客戶端無感。
 *
 * 路由（兼容掛在根路徑或 /po 前綴下；按 path 結尾匹配）：
 *   POST  …/letters       { device, letters:[{pen,content,lang?}] }       上傳待寄出的信
 *   GET   …/inbox?device=X&limit=N                                         隨機抽 N 封"別人的、還能回"的信
 *   POST  …/vote          { device, letterId, vote: 1|-1|0 }              點贊/點踩(=舉報)/撤銷
 *   POST  …/replies       { device, replies:[{letterId,pen,content}] }     上傳回信
 *   GET   …/replies?device=X                                               取回我寄出的信上的回覆 + 各信的贊踩瀏覽量
 *   POST  …/release       { device, letterIds:[...] }                      作者刪自己的信
 *   GET   …/admin/list?token=&limit=                                       [管理] 列信
 *   POST  …/admin/delete  { letterId }  (+ token)                          [管理] 刪信
 *   GET   …/health                                                         健康檢查
 *
 *   ── 信號墜落處 / 已結束活動的只讀存檔 ──
 *   以下舊寫入接口全部返回 410（包括鎖/新篇/接龍/新冊/恢復）；僅保留管理員刪稿維護。
 *   紀念館 GET 只執行 SELECT，不建表、不補冊、不播種、不改動舊規格。
 *   GET   …/poem/current?device=  →  當前冊子規格 + 那首未寫完的詩(全文) + 近期封存幾首
 *                                     帶 device → 每句打 mine 標記（只對請求者，不暴露別人 device）
 *   POST  …/poem/lock   { device }  →  搶寫詩會話鎖；{acquired:true,token,...當前態} 或 {acquired:false}
 *   POST  …/poem/unlock { token }   →  放鎖（寫完/出錯都調；TTL 兜底）
 *   POST  …/poem/start    { device, pen, title, brief, lines:[1~2], targetLines }  起新篇（僅無 open 詩時；brief=主題/方向）
 *   POST  …/poem/append   { device, pen, poemId, lines:[1~2] }              接龍續 1~2 句（滿篇幅自動封存）
 *   GET   …/poem/feed?limit=&booklet=&device=&mine=1                        翻閱已封存的詩集（mine=1 只看本機參與過的）
 *   POST  …/poem/booklet  { title,subtitle,theme,poemsTarget,linesMin,linesMax,charsPerLine } (+ token)  [管理] 發新冊子
 *   GET   …/poem/admin-list (+ token)                                       [管理] 列全部詩 + 當前暫停態
 *   POST  …/poem/admin-delete { poemId } | { poemId, seq } (+ token)        [管理] 刪整首 / 刪單句
 *   POST  …/poem/admin-pause  { paused: true|false } (+ token)              [管理] 暫停 / 恢復詩歌推入
 *   注：用連字符（非 /poem/admin/list）是**故意**的——後端按 path 結尾匹配，
 *       /poem/admin/list 會先撞上漂流瓶的 /admin/list 被截走，故避開該後綴。
 *
 * 表結構由 Worker 自動建（加性、不破壞老數據）。也可手動跑 schema.sql。
 */

export interface Env {
    DB: D1Database;
    /** 可選：一封信最多被幾個設備回信（默認 3） */
    PO_MAX_REPLIES?: string;
    /** 可選：一封信點踩數達此值即自動刪除（默認 5） */
    PO_DISLIKE_LIMIT?: string;
    /** 管理員令牌（secret）。未配置時管理接口一律 503 關閉。 */
    ADMIN_TOKEN?: string;
    /** 限流用的哈希鹽（secret）。僅用於不可逆化 IP，建議配置。 */
    PO_IP_SALT?: string;
    /** 可選：每分鐘限流次數。投信/回信/投票。 */
    PO_RATE_LETTERS?: string;
    PO_RATE_REPLIES?: string;
    PO_RATE_VOTES?: string;
}

// 最小 D1 類型（避免依賴 @cloudflare/workers-types）
interface D1Database {
    prepare(q: string): D1PreparedStatement;
    batch(s: D1PreparedStatement[]): Promise<unknown[]>;
    exec(q: string): Promise<unknown>;
}
interface D1PreparedStatement {
    bind(...a: unknown[]): D1PreparedStatement;
    run(): Promise<unknown>;
    first<T = unknown>(c?: string): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
};
const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const MAX_CONTENT = 400;          // 單封正文字數上限（按字符：1 漢字/標點 = 1 字）
const MAX_BATCH = 20;             // 單次上傳封數上限
const WINDOW_MS = 60_000;         // 默認限流窗口：1 分鐘
const LETTERS_WINDOW_MS = 5 * 3600_000; // 投信限流窗口：5 小時
const uuid = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
// 按字符（code point）截斷，中文標點都算 1 字
const clip = (s: unknown) => [...String(s ?? '')].slice(0, MAX_CONTENT).join('');
const num = (v: string | undefined, dflt: number) => { const n = parseInt(v || '', 10); return Number.isFinite(n) ? n : dflt; };

let schemaReady = false;
async function ensureSchema(db: D1Database) {
    if (schemaReady) return;
    // 信件池（新庫直接帶 likes/dislikes/views；老庫靠下面的 ADD COLUMN 補）
    await db.exec(
        `CREATE TABLE IF NOT EXISTS po_letters (id TEXT PRIMARY KEY, device TEXT NOT NULL, pen TEXT NOT NULL, content TEXT NOT NULL, lang TEXT, created_at INTEGER NOT NULL, reply_count INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, dislikes INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0);`
    );
    // 老庫補列（列已存在會拋 "duplicate column"，吞掉即可）
    for (const col of ['likes INTEGER NOT NULL DEFAULT 0', 'dislikes INTEGER NOT NULL DEFAULT 0', 'views INTEGER NOT NULL DEFAULT 0']) {
        try { await db.exec(`ALTER TABLE po_letters ADD COLUMN ${col};`); } catch { /* 已存在 */ }
    }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_letters_dev ON po_letters(device);`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_letters_open ON po_letters(reply_count, created_at);`);
    // 抽信去重、回信（沿用舊結構，不遷移）
    await db.exec(`CREATE TABLE IF NOT EXISTS po_picks (device TEXT NOT NULL, letter_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (device, letter_id));`);
    await db.exec(`CREATE TABLE IF NOT EXISTS po_replies (id TEXT PRIMARY KEY, letter_id TEXT NOT NULL, device TEXT NOT NULL, pen TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_replies_letter ON po_replies(letter_id);`);
    // owner_id ↔ 短整數 uid 映射（省 votes 空間）
    await db.exec(`CREATE TABLE IF NOT EXISTS po_devices (uid INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);`);
    // 投票（點贊/點踩），一設備一票；ip_hash 用於「按 IP 去重」判定自動刪除（防偽造 device 刷刪）
    await db.exec(`CREATE TABLE IF NOT EXISTS po_votes (letter_id TEXT NOT NULL, uid INTEGER NOT NULL, vote INTEGER NOT NULL, at INTEGER NOT NULL, ip_hash TEXT, PRIMARY KEY (letter_id, uid));`);
    try { await db.exec(`ALTER TABLE po_votes ADD COLUMN ip_hash TEXT;`); } catch { /* 已存在 */ }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_votes_letter ON po_votes(letter_id);`);
    // 限流計數（固定窗口）
    await db.exec(`CREATE TABLE IF NOT EXISTS po_ratelimit (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);`);
    // ── 信號墜落處 / 接龍詩（跨用戶，複用本後端的匿名/限流基建）──────────
    // 冊子：容器 + 規格（多少首詩 / 每首句數 roll 區間 / 每句字數上限）。
    await db.exec(`CREATE TABLE IF NOT EXISTS po_booklets (id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT, theme TEXT, poems_target INTEGER NOT NULL, poem_count INTEGER NOT NULL DEFAULT 0, lines_min INTEGER NOT NULL, lines_max INTEGER NOT NULL, chars_per_line INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_booklets_open ON po_booklets(status, created_at);`);
    // 詩：一首接龍詩（line_count 由 po_poem_lines 實算回填，避免併發自增漂移）。
    await db.exec(`CREATE TABLE IF NOT EXISTS po_poems (id TEXT PRIMARY KEY, booklet_id TEXT NOT NULL, title TEXT NOT NULL, brief TEXT, target_lines INTEGER NOT NULL, line_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', starter_pen TEXT, created_at INTEGER NOT NULL, sealed_at INTEGER);`);
    try { await db.exec(`ALTER TABLE po_poems ADD COLUMN brief TEXT;`); } catch { /* 老庫補列，已存在則忽略 */ }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_poems_booklet ON po_poems(booklet_id, status);`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_po_poems_sealed ON po_poems(status, sealed_at);`);
    // 句：(poem_id, seq) 唯一 —— 併發追加搶同一 seq 時第二條 INSERT 失敗，天然防錯位。
    await db.exec(`CREATE TABLE IF NOT EXISTS po_poem_lines (id TEXT PRIMARY KEY, poem_id TEXT NOT NULL, booklet_id TEXT NOT NULL, seq INTEGER NOT NULL, device TEXT NOT NULL, pen TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_po_poem_lines_seq ON po_poem_lines(poem_id, seq);`);
    // 全局開關（如「暫停詩歌推入」）：key/value 單表
    await db.exec(`CREATE TABLE IF NOT EXISTS po_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // 寫詩會話鎖（單行）：同一時刻全局只允許一個 char 在「讀→生成→寫」。搶不到的 char
    // 在調 LLM 前就被擋回，既杜絕接龍撞車、又不浪費 token。帶 TTL 防持鎖者崩潰後死鎖。
    await db.exec(`CREATE TABLE IF NOT EXISTS po_signal_lock (id TEXT PRIMARY KEY, holder TEXT, expires_at INTEGER NOT NULL DEFAULT 0);`);
    // 每首詩每個 device 落筆次數（配額：一首詩同一 user 最多 SIG_MAX_TURNS 次）
    await db.exec(`CREATE TABLE IF NOT EXISTS po_poem_writers (poem_id TEXT NOT NULL, device TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (poem_id, device));`);
    schemaReady = true;
}

/** owner_id → 短整數 uid（不存在則創建）。 */
async function getUid(db: D1Database, ownerId: string): Promise<number> {
    const hit = await db.prepare(`SELECT uid FROM po_devices WHERE owner_id = ?`).bind(ownerId).first<{ uid: number }>();
    if (hit) return hit.uid;
    await db.prepare(`INSERT OR IGNORE INTO po_devices (owner_id, created_at) VALUES (?, ?)`).bind(ownerId, Date.now()).run();
    const row = await db.prepare(`SELECT uid FROM po_devices WHERE owner_id = ?`).bind(ownerId).first<{ uid: number }>();
    return row?.uid ?? 0;
}

/** 刪信 + 級聯清掉回覆/抽取記錄/投票。 */
async function deleteLetters(db: D1Database, ids: string[]) {
    for (const id of ids) {
        await db.prepare(`DELETE FROM po_replies WHERE letter_id = ?`).bind(id).run();
        await db.prepare(`DELETE FROM po_picks  WHERE letter_id = ?`).bind(id).run();
        await db.prepare(`DELETE FROM po_votes  WHERE letter_id = ?`).bind(id).run();
        await db.prepare(`DELETE FROM po_letters WHERE id = ?`).bind(id).run();
    }
}

// ── 信號墜落處 / 接龍詩 ─────────────────────────────────────────────
interface BookletRow { id: string; title: string; subtitle: string | null; theme: string | null; poems_target: number; poem_count: number; lines_min: number; lines_max: number; chars_per_line: number; status: string; created_at: number; }
interface PoemRow { id: string; booklet_id: string; title: string; brief: string | null; target_lines: number; line_count: number; status: string; starter_pen: string | null; created_at: number; sealed_at: number | null; }
interface LineRow { seq: number; pen: string; content: string; created_at: number; device: string; }

/**
 * 活動封存後的只讀入口：只取已經存在的最後一本冊子，絕不補建、播種或改狀態。
 * 紀念館的 GET 也必須沒有寫副作用，否則清空數據後僅僅打開頁面就會重新開始活動。
 */
async function readLatestBooklet(db: D1Database): Promise<BookletRow | null> {
    return await db.prepare(`SELECT * FROM po_booklets ORDER BY created_at DESC LIMIT 1`).first<BookletRow>();
}

/** 當前 open 冊子裡那首還沒寫完的詩（全局同時只有一首 open）。 */
async function getOpenPoem(db: D1Database, bookletId: string): Promise<PoemRow | null> {
    return await db.prepare(`SELECT * FROM po_poems WHERE booklet_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1`).bind(bookletId).first<PoemRow>();
}

async function loadLines(db: D1Database, poemId: string): Promise<LineRow[]> {
    const r = await db.prepare(`SELECT seq, pen, content, created_at, device FROM po_poem_lines WHERE poem_id = ? ORDER BY seq ASC`).bind(poemId).all<LineRow>();
    return r.results || [];
}

// myDevice 給定時：每句打 mine 標記、整首給 mineCount —— 只為「認領自己的句子」，
// 絕不把別人的 device 返回給客戶端（匿名前提不破）。
const poemView = (p: PoemRow, lines: LineRow[], myDevice?: string) => ({
    id: p.id, bookletId: p.booklet_id, title: p.title, brief: p.brief || '', targetLines: p.target_lines,
    lineCount: lines.length, status: p.status, createdAt: p.created_at, sealedAt: p.sealed_at,
    ...(myDevice ? { mineCount: lines.filter(l => l.device === myDevice).length } : {}),
    lines: lines.map(l => ({ seq: l.seq, pen: l.pen, content: l.content, createdAt: l.created_at, ...(myDevice ? { mine: l.device === myDevice } : {}) })),
});
const bookletView = (b: BookletRow) => ({
    id: b.id, title: b.title, subtitle: b.subtitle, theme: b.theme,
    poemsTarget: b.poems_target, poemCount: b.poem_count,
    linesMin: b.lines_min, linesMax: b.lines_max, charsPerLine: b.chars_per_line,
    status: b.status, createdAt: b.created_at,
});

/** 刪一整首詩（連同它的句與落筆配額記錄）。 */
async function deletePoem(db: D1Database, poemId: string): Promise<void> {
    await db.prepare(`DELETE FROM po_poem_lines WHERE poem_id = ?`).bind(poemId).run();
    await db.prepare(`DELETE FROM po_poem_writers WHERE poem_id = ?`).bind(poemId).run();
    await db.prepare(`DELETE FROM po_poems WHERE id = ?`).bind(poemId).run();
}

/** 按 po_votes 重算某封信的贊/踩並回寫（展示用，按設備計數）。 */
async function recountVotes(db: D1Database, letterId: string): Promise<{ likes: number; dislikes: number }> {
    const r = await db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0)  AS likes,
                COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS dislikes
         FROM po_votes WHERE letter_id = ?`
    ).bind(letterId).first<{ likes: number; dislikes: number }>();
    const likes = r?.likes ?? 0, dislikes = r?.dislikes ?? 0;
    await db.prepare(`UPDATE po_letters SET likes = ?, dislikes = ? WHERE id = ?`).bind(likes, dislikes, letterId).run();
    return { likes, dislikes };
}

/**
 * 按「不同 IP」去重統計點踩數，用於自動刪除判定。
 * 防止一個人偽造多個 device（同一 IP）刷滿閾值刪信；無 IP 時退化為按設備計。
 */
async function countDislikeIps(db: D1Database, letterId: string): Promise<number> {
    const r = await db.prepare(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(ip_hash, ''), 'u' || uid)) AS n
         FROM po_votes WHERE letter_id = ? AND vote = -1`
    ).bind(letterId).first<{ n: number }>();
    return r?.n ?? 0;
}

/** 把 IP 加鹽哈希成桶 key（不可逆，不存原始 IP）。 */
async function hashIp(ip: string, salt: string): Promise<string> {
    const data = new TextEncoder().encode(`${salt}:${ip}`);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * 固定窗口限流：單條 upsert 原子累加，超閾值返回 true。
 * windowMs 指定窗口長度；cost 指定本次消耗的額度（批量端點按條數計，防止單請求塞滿 MAX_BATCH 繞過）。
 */
async function rateLimited(db: D1Database, ipHash: string, action: string, limit: number, windowMs = WINDOW_MS, cost = 1): Promise<boolean> {
    if (!ipHash || limit <= 0) return false;
    const now = Date.now();
    const bucket = `${ipHash}:${action}`;
    const row = await db.prepare(
        `INSERT INTO po_ratelimit (bucket, count, reset_at) VALUES (?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET
           count    = CASE WHEN reset_at <= ? THEN ? ELSE count + ? END,
           reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
         RETURNING count`
    ).bind(bucket, cost, now + windowMs, now, cost, cost, now, now + windowMs).first<{ count: number }>();
    return (row?.count ?? cost) > limit;
}

/** 校驗管理員令牌（Authorization: Bearer 或 ?token=）。 */
function isAdmin(req: Request, url: URL, env: Env): boolean {
    if (!env.ADMIN_TOKEN) return false;
    const auth = req.headers.get('Authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const token = bearer || url.searchParams.get('token') || '';
    return token === env.ADMIN_TOKEN;
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

        const url = new URL(req.url);
        const path = url.pathname.replace(/\/+$/, '');
        const ends = (p: string) => path === p || path.endsWith(p);
        // Ended events reject every write except authenticated archival deletion, before touching D1.
        const poemRoute = path.includes('/poem/');
        if (poemRoute && req.method !== 'GET' && !ends('/poem/admin-delete'))
            return json({ ok: false, error: 'signal event ended', ended: true }, 410);
        if (poemRoute && (ends('/poem/admin-list') || ends('/poem/admin-delete')) && !isAdmin(req, url, env))
            return json({ ok: false, error: 'unauthorized' }, 401);
        if (!env.DB) return json({ ok: false, error: 'D1 binding "DB" 未配置' }, 500);
        const maxReplies = num(env.PO_MAX_REPLIES, 3) || 3;
        const dislikeLimit = num(env.PO_DISLIKE_LIMIT, 5) || 5;

        // 限流準備：拿 IP 哈希（鹽缺省也能用，只是可被猜測）
        const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '';
        const ipHash = ip ? await hashIp(ip, env.PO_IP_SALT || 'po') : '';
        const tooMany = (action: string, limit: number, windowMs?: number, cost?: number) => rateLimited(env.DB, ipHash, action, limit, windowMs, cost);

        try {
            if (!poemRoute) await ensureSchema(env.DB);

            if (req.method === 'GET' && ends('/health')) {
                return json({ ok: true, service: 'sullyos-post-office', maxReplies, dislikeLimit, admin: !!env.ADMIN_TOKEN });
            }

            // ── 管理（純 API，無前端）─────────────────────────────
            if (ends('/admin/list') && req.method === 'GET') {
                if (!isAdmin(req, url, env)) return json({ ok: false, error: 'unauthorized' }, 401);
                const limit = Math.min(Math.max(num(url.searchParams.get('limit') || '', 50), 1), 200);
                const rows = await env.DB.prepare(
                    `SELECT id, pen, content, lang, created_at, reply_count, likes, dislikes, views
                     FROM po_letters ORDER BY dislikes DESC, created_at DESC LIMIT ?`
                ).bind(limit).all<any>();
                return json({ ok: true, letters: rows.results || [] });
            }
            if (ends('/admin/delete') && req.method === 'POST') {
                if (!isAdmin(req, url, env)) return json({ ok: false, error: 'unauthorized' }, 401);
                const body: any = await req.json().catch(() => ({}));
                const rawIds: string[] = Array.isArray(body.letterIds)
                    ? body.letterIds : (body.letterId ? [body.letterId] : []);
                const ids = rawIds.slice(0, 100).map(String);
                if (ids.length === 0) return json({ ok: false, error: 'bad request' }, 400);
                await deleteLetters(env.DB, ids);
                // 只報實際刪除的數量；超 100 的部分未刪，提示客戶端分批
                return json({ ok: true, deleted: ids.length, truncated: rawIds.length > ids.length });
            }

            // ── 投票：點贊 / 點踩(=舉報) / 撤銷 ──────────────────
            if (req.method === 'POST' && ends('/vote')) {
                if (await tooMany('vote', num(env.PO_RATE_VOTES, 120))) return json({ ok: false, error: 'rate limited' }, 429);
                const body: any = await req.json().catch(() => ({}));
                const device = String(body.device || '').slice(0, 80);
                const letterId = String(body.letterId || '');
                const vote = body.vote === 1 ? 1 : body.vote === -1 ? -1 : 0;
                if (!device || !letterId) return json({ ok: false, error: 'bad request' }, 400);
                const exists = await env.DB.prepare(`SELECT id FROM po_letters WHERE id = ?`).bind(letterId).first();
                if (!exists) return json({ ok: true, deleted: true, likes: 0, dislikes: 0 });
                const uid = await getUid(env.DB, device);
                if (vote === 0) {
                    await env.DB.prepare(`DELETE FROM po_votes WHERE letter_id = ? AND uid = ?`).bind(letterId, uid).run();
                } else {
                    await env.DB.prepare(
                        `INSERT INTO po_votes (letter_id, uid, vote, at, ip_hash) VALUES (?,?,?,?,?)
                         ON CONFLICT(letter_id, uid) DO UPDATE SET vote = ?, at = ?, ip_hash = ?`
                    ).bind(letterId, uid, vote, Date.now(), ipHash, vote, Date.now(), ipHash).run();
                }
                const { likes, dislikes } = await recountVotes(env.DB, letterId);
                // 點踩(=舉報)滿閾值 → 刪信。閾值按「不同 IP」算，防偽造 device 刷刪
                if (vote === -1 && await countDislikeIps(env.DB, letterId) >= dislikeLimit) {
                    await deleteLetters(env.DB, [letterId]);
                    return json({ ok: true, deleted: true, likes, dislikes });
                }
                return json({ ok: true, likes, dislikes });
            }

            // ── 上傳待寄出的信 ──────────────────────────────────
            if (req.method === 'POST' && ends('/letters')) {
                const body: any = await req.json().catch(() => ({}));
                const device = String(body.device || '').slice(0, 80);
                const letters: any[] = Array.isArray(body.letters) ? body.letters.slice(0, MAX_BATCH) : [];
                if (!device || letters.length === 0) return json({ ok: false, error: 'bad request' }, 400);
                // 投信：同一 IP 5 小時內最多 PO_RATE_LETTERS 條（默認 5），按實際條數計
                if (await tooMany('letters', num(env.PO_RATE_LETTERS, 5), LETTERS_WINDOW_MS, letters.length)) return json({ ok: false, error: 'rate limited' }, 429);
                const ids: string[] = [];
                const now = Date.now();
                for (const l of letters) {
                    const content = clip(l.content);
                    if (!content.trim()) continue;
                    const id = uuid();
                    ids.push(id);
                    await env.DB.prepare(`INSERT INTO po_letters (id, device, pen, content, lang, created_at) VALUES (?,?,?,?,?,?)`)
                        .bind(id, device, String(l.pen || '匿名').slice(0, 60), content, String(l.lang || '').slice(0, 16), now).run();
                }
                return json({ ok: true, ids });
            }

            // ── 隨機抽別人的、還能回的信（抽到即 +1 瀏覽量）────────
            if (req.method === 'GET' && ends('/inbox')) {
                const device = String(url.searchParams.get('device') || '').slice(0, 80);
                const limit = Math.min(Math.max(num(url.searchParams.get('limit') || '', 5), 1), 10);
                if (!device) return json({ ok: false, error: 'bad request' }, 400);
                const rows = await env.DB.prepare(
                    `SELECT id, pen, content, created_at, likes, dislikes, views, reply_count FROM po_letters
                     WHERE device != ? AND reply_count < ?
                       AND id NOT IN (SELECT letter_id FROM po_picks WHERE device = ?)
                     ORDER BY RANDOM() LIMIT ?`
                ).bind(device, maxReplies, device, limit).all<any>();
                const letters = rows.results || [];
                const now = Date.now();
                // 查詢已排除"抽過的"，故返回的每封都是新抽到 → 直接 views++（天然去重）
                for (const r of letters) {
                    await env.DB.prepare(`INSERT OR IGNORE INTO po_picks (device, letter_id, at) VALUES (?,?,?)`).bind(device, r.id, now).run();
                    await env.DB.prepare(`UPDATE po_letters SET views = views + 1 WHERE id = ?`).bind(r.id).run();
                    r.views = (r.views || 0) + 1;
                }
                return json({ ok: true, letters });
            }

            // ── 上傳回信 ────────────────────────────────────────
            if (req.method === 'POST' && ends('/replies')) {
                const body: any = await req.json().catch(() => ({}));
                const device = String(body.device || '').slice(0, 80);
                const replies: any[] = Array.isArray(body.replies) ? body.replies.slice(0, MAX_BATCH) : [];
                if (!device || replies.length === 0) return json({ ok: false, error: 'bad request' }, 400);
                // 回信：每分鐘上限按實際條數計
                if (await tooMany('replies', num(env.PO_RATE_REPLIES, 60), undefined, replies.length)) return json({ ok: false, error: 'rate limited' }, 429);
                const now = Date.now();
                let accepted = 0;
                for (const rp of replies) {
                    const letterId = String(rp.letterId || '');
                    const content = clip(rp.content);
                    if (!letterId || !content.trim()) continue;
                    const lt = await env.DB.prepare(`SELECT reply_count FROM po_letters WHERE id = ?`).bind(letterId).first<any>();
                    if (!lt || lt.reply_count >= maxReplies) continue;
                    await env.DB.prepare(`INSERT INTO po_replies (id, letter_id, device, pen, content, created_at) VALUES (?,?,?,?,?,?)`)
                        .bind(uuid(), letterId, device, String(rp.pen || '匿名').slice(0, 60), content, now).run();
                    await env.DB.prepare(`UPDATE po_letters SET reply_count = reply_count + 1 WHERE id = ?`).bind(letterId).run();
                    accepted++;
                }
                return json({ ok: true, accepted });
            }

            // ── 取回我寄出的信上的回覆 + 各信的贊/踩/瀏覽量 ────────
            if (req.method === 'GET' && ends('/replies')) {
                const device = String(url.searchParams.get('device') || '').slice(0, 80);
                if (!device) return json({ ok: false, error: 'bad request' }, 400);
                const replies = await env.DB.prepare(
                    `SELECT r.id, r.letter_id, r.pen, r.content, r.created_at
                     FROM po_replies r JOIN po_letters l ON l.id = r.letter_id
                     WHERE l.device = ? ORDER BY r.created_at ASC LIMIT 200`
                ).bind(device).all<any>();
                const stats = await env.DB.prepare(
                    `SELECT id, likes, dislikes, views, reply_count, created_at FROM po_letters WHERE device = ?`
                ).bind(device).all<any>();
                return json({ ok: true, replies: replies.results || [], letters: stats.results || [] });
            }

            // ── 作者刪自己的信（原 release）────────────────────────
            if (req.method === 'POST' && ends('/release')) {
                const body: any = await req.json().catch(() => ({}));
                const device = String(body.device || '').slice(0, 80);
                const letterIds: string[] = Array.isArray(body.letterIds) ? body.letterIds.slice(0, 100) : [];
                if (!device || letterIds.length === 0) return json({ ok: false, error: 'bad request' }, 400);
                const mine: string[] = [];
                for (const id of letterIds) {
                    const lt = await env.DB.prepare(`SELECT device FROM po_letters WHERE id = ?`).bind(String(id)).first<any>();
                    if (lt && lt.device === device) mine.push(String(id)); // 只能刪自己的
                }
                await deleteLetters(env.DB, mine);
                return json({ ok: true });
            }

            // ════════ 信號墜落處 / 接龍詩 ════════════════════════════

            // ── 讀當前態：冊子規格 + 當前那首未寫完的詩（全文）+ 幾首封存的詩供找靈感 ──
            if (req.method === 'GET' && ends('/poem/current')) {
                const myDev = String(url.searchParams.get('device') || '').slice(0, 80) || undefined;
                const booklet = await readLatestBooklet(env.DB);
                if (!booklet) return json({ ok: false, error: 'signal archive is empty', ended: true }, 404);
                const open = await getOpenPoem(env.DB, booklet.id);
                const poem = open ? poemView(open, await loadLines(env.DB, open.id), myDev) : null;
                // 起新篇時給角色讀的「之前的詩」（全局最近封存的幾首）
                const recentRows = await env.DB.prepare(`SELECT * FROM po_poems WHERE status = 'sealed' ORDER BY sealed_at DESC LIMIT 3`).all<PoemRow>();
                const recent = [];
                for (const r of (recentRows.results || [])) recent.push(poemView(r, await loadLines(env.DB, r.id), myDev));
                return json({ ok: true, booklet: bookletView(booklet), poem, recent, paused: true, ended: true });
            }

            // ── 翻閱詩集：已封存的詩（含全文），最近優先。mine=1 只看本機參與過的 ──
            if (req.method === 'GET' && ends('/poem/feed')) {
                const limit = Math.min(Math.max(num(url.searchParams.get('limit') || '', 30), 1), 100);
                const bookletId = url.searchParams.get('booklet') || '';
                const myDev = String(url.searchParams.get('device') || '').slice(0, 80) || undefined;
                const mineOnly = url.searchParams.get('mine') === '1' && myDev;
                let rows;
                if (mineOnly) {
                    rows = await env.DB.prepare(`SELECT * FROM po_poems WHERE status = 'sealed' AND id IN (SELECT DISTINCT poem_id FROM po_poem_lines WHERE device = ?) ORDER BY sealed_at DESC LIMIT ?`).bind(myDev, limit).all<PoemRow>();
                } else if (bookletId) {
                    rows = await env.DB.prepare(`SELECT * FROM po_poems WHERE status = 'sealed' AND booklet_id = ? ORDER BY sealed_at DESC LIMIT ?`).bind(bookletId, limit).all<PoemRow>();
                } else {
                    rows = await env.DB.prepare(`SELECT * FROM po_poems WHERE status = 'sealed' ORDER BY sealed_at DESC LIMIT ?`).bind(limit).all<PoemRow>();
                }
                const poems = [];
                for (const r of (rows.results || [])) poems.push(poemView(r, await loadLines(env.DB, r.id), myDev));
                return json({ ok: true, poems });
            }

            // ── [管理] 列出全部詩（open 在前，再按時間倒序）+ 當前暫停態 ──
            if (req.method === 'GET' && ends('/poem/admin-list')) {
                if (!isAdmin(req, url, env)) return json({ ok: false, error: 'unauthorized' }, 401);
                const limit = Math.min(Math.max(num(url.searchParams.get('limit') || '', 100), 1), 300);
                const rows = await env.DB.prepare(
                    `SELECT * FROM po_poems ORDER BY (status = 'open') DESC, COALESCE(sealed_at, created_at) DESC LIMIT ?`
                ).bind(limit).all<PoemRow>();
                const poems = [];
                for (const r of (rows.results || [])) poems.push(poemView(r, await loadLines(env.DB, r.id)));
                return json({ ok: true, poems, paused: true, ended: true });
            }

            // ── [管理] 刪一整首詩 或 刪單句 ──
            if (req.method === 'POST' && ends('/poem/admin-delete')) {
                if (!isAdmin(req, url, env)) return json({ ok: false, error: 'unauthorized' }, 401);
                const body: any = await req.json().catch(() => ({}));
                const poemId = String(body.poemId || '');
                const seq = parseInt(String(body.seq), 10);
                if (poemId && Number.isFinite(seq)) {
                    // 刪單句（按 poemId + seq）→ 重算句數（不自動改封存態）
                    await env.DB.prepare(`DELETE FROM po_poem_lines WHERE poem_id = ? AND seq = ?`).bind(poemId, seq).run();
                    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM po_poem_lines WHERE poem_id = ?`).bind(poemId).first<{ n: number }>();
                    await env.DB.prepare(`UPDATE po_poems SET line_count = ? WHERE id = ?`).bind(cnt?.n ?? 0, poemId).run();
                    return json({ ok: true, deleted: 'line' });
                }
                if (poemId) {
                    const p = await env.DB.prepare(`SELECT booklet_id, status FROM po_poems WHERE id = ?`).bind(poemId).first<{ booklet_id: string; status: string }>();
                    await deletePoem(env.DB, poemId);
                    // 刪的是已封存的詩 → 冊子封存計數回算
                    if (p && p.status === 'sealed') {
                        const sc = await env.DB.prepare(`SELECT COUNT(*) AS n FROM po_poems WHERE booklet_id = ? AND status = 'sealed'`).bind(p.booklet_id).first<{ n: number }>();
                        await env.DB.prepare(`UPDATE po_booklets SET poem_count = ? WHERE id = ?`).bind(sc?.n ?? 0, p.booklet_id).run();
                    }
                    return json({ ok: true, deleted: 'poem' });
                }
                return json({ ok: false, error: 'bad request' }, 400);
            }

            return json({ ok: false, error: 'not found' }, 404);
        } catch (e: any) {
            return json({ ok: false, error: e?.message || 'server error' }, 500);
        }
    },
};
