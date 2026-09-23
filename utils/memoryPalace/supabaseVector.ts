/**
 * Memory Palace — Supabase pgvector 遠程向量存儲
 *
 * 用戶在自己的 Supabase 項目裡存儲向量，本地只做緩存。
 * 使用原生 fetch 調用 PostgREST API，無需額外依賴。
 *
 * 數據歸屬：100% 在用戶自己的 Supabase 項目，我們不碰不存。
 */

import type { RemoteVectorConfig, MemoryNode } from './types';

// ─── 初始化 SQL（用戶需在 Supabase SQL Editor 運行一次） ──

export const INIT_SQL = `
-- 1. 啟用 pgvector 擴展
create extension if not exists vector;

-- 2. 創建向量表
create table if not exists memory_vectors (
  memory_id text primary key,
  char_id text not null,
  content text not null default '',
  vector vector(1024),
  dimensions int default 1024,
  model text,
  room text,
  importance int default 5,
  tags text[] default '{}',
  mood text default '',
  -- Russell 情感空間（可空；老數據由本地 MOOD_TO_VA 查表兜底）
  valence real default null,
  arousal real default null,
  created_at bigint default (extract(epoch from now()) * 1000)::bigint,
  last_accessed_at bigint default 0,
  access_count int default 0,
  -- 便利貼置頂截止（ms timestamp，null = 不置頂）
  pinned_until bigint default null,
  -- 消化衍生記憶的源 + 來源標籤
  source_id text default null,
  origin text default null,
  -- EventBox 擴展列
  archived boolean default false,       -- 被壓入 box summary 的活節點打標，搜索時過濾
  is_summary boolean default false,     -- 此行本身是 box summary（參與搜索，但展開邏輯不同）
  event_box_id text default null        -- 所屬 EventBox.id；null = 獨立記憶
);

-- 2b. 兼容升級：已有表添加新列（冪等，不影響新表）
alter table memory_vectors add column if not exists last_accessed_at bigint default 0;
alter table memory_vectors add column if not exists access_count int default 0;
alter table memory_vectors add column if not exists archived boolean default false;
alter table memory_vectors add column if not exists is_summary boolean default false;
alter table memory_vectors add column if not exists event_box_id text default null;
alter table memory_vectors add column if not exists valence real default null;
alter table memory_vectors add column if not exists arousal real default null;
alter table memory_vectors add column if not exists pinned_until bigint default null;
alter table memory_vectors add column if not exists source_id text default null;
alter table memory_vectors add column if not exists origin text default null;

-- 3. 創建索引
create index if not exists idx_mv_char_id on memory_vectors(char_id);
create index if not exists idx_mv_hnsw on memory_vectors
  using hnsw (vector vector_cosine_ops);
create index if not exists idx_mv_event_box_id on memory_vectors(event_box_id)
  where event_box_id is not null;
create index if not exists idx_mv_archived on memory_vectors(archived);

-- 4. 相似度搜索函數（先 drop 舊版，因為返回類型變更時 replace 不允許）
drop function if exists match_vectors(vector, text, float, int);
create or replace function match_vectors(
  query_embedding vector(1024),
  match_char_id text,
  match_threshold float default 0.3,
  match_count int default 20
)
returns table (
  memory_id text,
  char_id text,
  content text,
  similarity float,
  room text,
  importance int,
  tags text[],
  mood text,
  valence real,
  arousal real,
  created_at bigint,
  last_accessed_at bigint,
  access_count int,
  pinned_until bigint,
  source_id text,
  origin text,
  archived boolean,
  is_summary boolean,
  event_box_id text
)
language sql stable
as $$
  select
    mv.memory_id,
    mv.char_id,
    mv.content,
    1 - (mv.vector <=> query_embedding) as similarity,
    mv.room,
    mv.importance,
    mv.tags,
    mv.mood,
    mv.valence,
    mv.arousal,
    mv.created_at,
    mv.last_accessed_at,
    mv.access_count,
    mv.pinned_until,
    mv.source_id,
    mv.origin,
    mv.archived,
    mv.is_summary,
    mv.event_box_id
  from memory_vectors mv
  where mv.char_id = match_char_id
    and coalesce(mv.archived, false) = false  -- 過濾已歸檔節點
    and 1 - (mv.vector <=> query_embedding) > match_threshold
  order by mv.vector <=> query_embedding
  limit match_count;
$$;

-- 5. 行級安全（允許 anon key 完全訪問 — 這是用戶自己的數據庫）
alter table memory_vectors enable row level security;
drop policy if exists "Allow all access" on memory_vectors;
create policy "Allow all access" on memory_vectors
  for all using (true) with check (true);
`.trim();

// ─── Supabase REST helpers ───────────────────────────

function headers(config: RemoteVectorConfig): Record<string, string> {
    return {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${config.supabaseAnonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    };
}

function restUrl(config: RemoteVectorConfig, path: string): string {
    return `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1${path}`;
}

function rpcUrl(config: RemoteVectorConfig, fn: string): string {
    return `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`;
}

// ─── 公共 API ────────────────────────────────────────

/**
 * 測試連接 + 檢測表是否存在
 */
export async function testConnection(config: RemoteVectorConfig): Promise<{
    ok: boolean;
    tableExists: boolean;
    message: string;
}> {
    try {
        const res = await fetch(restUrl(config, '/memory_vectors?select=memory_id&limit=1'), {
            headers: headers(config),
        });

        if (res.status === 200) {
            return { ok: true, tableExists: true, message: '連接成功，表已就緒' };
        }
        if (res.status === 404 || res.status === 406) {
            // Table doesn't exist — PostgREST returns 404 or specific error
            return { ok: true, tableExists: false, message: '連接成功，但表尚未創建（請運行初始化 SQL）' };
        }
        if (res.status === 401) {
            return { ok: false, tableExists: false, message: '認證失敗：請檢查 anon key' };
        }
        const body = await res.text().catch(() => '');
        // Check for "relation does not exist" error
        if (body.includes('does not exist') || body.includes('relation')) {
            return { ok: true, tableExists: false, message: '連接成功，但表尚未創建（請運行初始化 SQL）' };
        }
        return { ok: false, tableExists: false, message: `服務器返回 ${res.status}: ${body.slice(0, 100)}` };
    } catch (e: any) {
        return { ok: false, tableExists: false, message: `連接失敗: ${e.message}` };
    }
}

/**
 * 插入或更新向量（upsert）
 */
/**
 * Decode local-vector storage forms safely for the wire format. After we
 * switched IndexedDB to Uint8Array(Float32 raw bytes), `instanceof Float32Array`
 * checks alone would silently miss Uint8Array and fall through to `.join`,
 * which would stringify the BYTES instead of the floats — corrupting every
 * remote upsert for hybrid (local+remote) users.
 */
function vectorToWireArray(vec: number[] | Float32Array | Uint8Array): number[] {
    if (vec instanceof Float32Array) return Array.from(vec);
    if (vec instanceof Uint8Array) {
        const f32 = new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength >>> 2);
        return Array.from(f32);
    }
    return vec;
}

export async function upsertVector(
    config: RemoteVectorConfig,
    memoryId: string,
    charId: string,
    vector: number[] | Float32Array | Uint8Array,
    node: MemoryNode,
    dimensions: number,
    model?: string,
): Promise<boolean> {
    try {
        const vecArray = vectorToWireArray(vector);
        const body = {
            memory_id: memoryId,
            char_id: charId,
            content: node.content,
            vector: `[${vecArray.join(',')}]`,
            dimensions,
            model: model || null,
            room: node.room,
            importance: node.importance,
            tags: node.tags,
            mood: node.mood,
            valence: typeof node.valence === 'number' ? node.valence : null,
            arousal: typeof node.arousal === 'number' ? node.arousal : null,
            created_at: node.createdAt,
            last_accessed_at: node.lastAccessedAt || node.createdAt,
            access_count: node.accessCount || 0,
            pinned_until: node.pinnedUntil ?? null,
            source_id: node.sourceId ?? null,
            origin: node.origin ?? null,
            archived: !!node.archived,
            is_summary: !!node.isBoxSummary,
            event_box_id: node.eventBoxId ?? null,
        };

        const res = await fetch(restUrl(config, '/memory_vectors'), {
            method: 'POST',
            headers: {
                ...headers(config),
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(body),
        });

        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 批量插入向量
 */
export async function upsertVectorBatch(
    config: RemoteVectorConfig,
    items: {
        memoryId: string;
        charId: string;
        vector: number[] | Float32Array | Uint8Array;
        node: MemoryNode;
        dimensions: number;
        model?: string;
    }[],
): Promise<boolean> {
    if (items.length === 0) return true;
    try {
        const body = items.map(item => {
            const vecArray = vectorToWireArray(item.vector);
            return {
                memory_id: item.memoryId,
                char_id: item.charId,
                content: item.node.content,
                vector: `[${vecArray.join(',')}]`,
                dimensions: item.dimensions,
                model: item.model || null,
                room: item.node.room,
                importance: item.node.importance,
                tags: item.node.tags,
                mood: item.node.mood,
                valence: typeof item.node.valence === 'number' ? item.node.valence : null,
                arousal: typeof item.node.arousal === 'number' ? item.node.arousal : null,
                created_at: item.node.createdAt,
                last_accessed_at: item.node.lastAccessedAt || item.node.createdAt,
                access_count: item.node.accessCount || 0,
                pinned_until: item.node.pinnedUntil ?? null,
                source_id: item.node.sourceId ?? null,
                origin: item.node.origin ?? null,
                archived: !!item.node.archived,
                is_summary: !!item.node.isBoxSummary,
                event_box_id: item.node.eventBoxId ?? null,
            };
        });

        const res = await fetch(restUrl(config, '/memory_vectors'), {
            method: 'POST',
            headers: {
                ...headers(config),
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(body),
        });

        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 向量相似度搜索（調用 match_vectors RPC 函數）
 *
 * ⚠️ 錯誤傳播：網絡錯誤（CORS / fetch 拋 TypeError）/ HTTP 非 2xx 都會向上 throw，
 * 不再靜默返回空數組。這樣上層（vectorSearch.ts）才能分辨"遠程掛了→禁用本會話遠程路徑"
 * 和"遠程正常但這次沒命中→返回空"。之前的 catch{ return [] } 導致每次查詢都
 * 踩一遍 CORS + 回退到本地 getAllByCharId，造成遷移批量查詢時 15 次重複加載全量向量。
 */
export async function searchVectors(
    config: RemoteVectorConfig,
    queryVector: number[] | Float32Array | Uint8Array,
    charId: string,
    threshold: number = 0.3,
    topK: number = 20,
): Promise<{
    memoryId: string;
    content: string;
    similarity: number;
    room: string;
    importance: number;
    tags: string[];
    mood: string;
    valence: number | null;
    arousal: number | null;
    createdAt: number;
    lastAccessedAt: number;
    accessCount: number;
    pinnedUntil: number | null;
    sourceId: string | null;
    origin: string | null;
    archived: boolean;
    isSummary: boolean;
    eventBoxId: string | null;
}[]> {
    const vecArray = vectorToWireArray(queryVector);

    const res = await fetch(rpcUrl(config, 'match_vectors'), {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({
            query_embedding: `[${vecArray.join(',')}]`,
            match_char_id: charId,
            match_threshold: threshold,
            match_count: topK,
        }),
    });

    if (!res.ok) {
        throw new Error(`match_vectors HTTP ${res.status}`);
    }

    const data = await res.json();
    return (data || []).map((row: any) => ({
        memoryId: row.memory_id,
        content: row.content,
        similarity: row.similarity,
        room: row.room,
        importance: row.importance,
        tags: row.tags || [],
        mood: row.mood || '',
        valence: typeof row.valence === 'number' ? row.valence : null,
        arousal: typeof row.arousal === 'number' ? row.arousal : null,
        createdAt: Number(row.created_at) || 0,
        lastAccessedAt: Number(row.last_accessed_at) || 0,
        accessCount: Number(row.access_count) || 0,
        pinnedUntil: row.pinned_until != null ? Number(row.pinned_until) : null,
        sourceId: row.source_id ?? null,
        origin: row.origin ?? null,
        archived: !!row.archived,
        isSummary: !!row.is_summary,
        eventBoxId: row.event_box_id ?? null,
    }));
}

/**
 * 按房間直接拉取遠程記憶（PostgREST 過濾，不跑向量相似度）。
 * 用於"本地沒有向量記憶但遠程有"的場景，比如記憶潛行要在客廳/臥室裡
 * 展示該腦區有哪些記憶時，直接按 room 列查遠端就夠了。
 *
 * 返回 MemoryNode 形狀，方便調用方與本地結果合併/去重。
 */
export async function fetchRemoteByRoom(
    config: RemoteVectorConfig,
    charId: string,
    room: string,
    limit: number = 50,
): Promise<MemoryNode[]> {
    try {
        const params = new URLSearchParams({
            select: 'memory_id,char_id,content,room,importance,tags,mood,valence,arousal,created_at,last_accessed_at,access_count,pinned_until,source_id,origin,archived,is_summary,event_box_id',
            char_id: `eq.${charId}`,
            room: `eq.${room}`,
            archived: 'eq.false',
            order: 'importance.desc,last_accessed_at.desc',
            limit: String(limit),
        });
        const res = await fetch(restUrl(config, `/memory_vectors?${params.toString()}`), {
            headers: headers(config),
        });
        if (!res.ok) return [];
        const rows = await res.json();
        return (rows || []).map((row: any): MemoryNode => ({
            id: row.memory_id,
            charId: row.char_id,
            content: row.content || '',
            room: row.room,
            tags: row.tags || [],
            importance: row.importance ?? 5,
            mood: row.mood || '',
            valence: typeof row.valence === 'number' ? row.valence : undefined,
            arousal: typeof row.arousal === 'number' ? row.arousal : undefined,
            embedded: true, // 遠程就是向量表，默認視為已 embedded
            createdAt: Number(row.created_at) || 0,
            lastAccessedAt: Number(row.last_accessed_at) || 0,
            accessCount: Number(row.access_count) || 0,
            pinnedUntil: row.pinned_until != null ? Number(row.pinned_until) : null,
            sourceId: row.source_id ?? null,
            origin: row.origin ?? undefined,
            archived: !!row.archived,
            isBoxSummary: !!row.is_summary,
            eventBoxId: row.event_box_id ?? null,
        }));
    } catch {
        return [];
    }
}

/**
 * 批量把一組向量標記為 archived（EventBox 壓縮時用）
 * 通過 PATCH 單發多 ID，避免 N 次 upsert
 */
export async function bulkSetArchived(
    config: RemoteVectorConfig,
    memoryIds: string[],
    archived: boolean,
): Promise<boolean> {
    if (memoryIds.length === 0) return true;
    try {
        // PostgREST `in.(...)` filter
        const idList = memoryIds.map(id => encodeURIComponent(id)).join(',');
        const res = await fetch(restUrl(config, `/memory_vectors?memory_id=in.(${idList})`), {
            method: 'PATCH',
            headers: {
                ...headers(config),
                'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ archived }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 批量把一組向量的 room 字段改成同一個值（consolidation 晉升/驅逐時用）
 * promotion 全部 → bedroom，eviction 全部 → attic，所以只需兩次 PATCH。
 *
 * 注意：只改 memory_vectors.room，content / importance / 向量本身都不動。
 * 所以即便 memory_id 在遠端不存在（用戶後啟用雲同步，老節點只在本地），
 * PATCH 也只是 no-op 更新 0 行，不會造成數據汙染。
 */
export async function bulkSetRoom(
    config: RemoteVectorConfig,
    memoryIds: string[],
    room: string,
): Promise<boolean> {
    if (memoryIds.length === 0) return true;
    try {
        const idList = memoryIds.map(id => encodeURIComponent(id)).join(',');
        const res = await fetch(restUrl(config, `/memory_vectors?memory_id=in.(${idList})`), {
            method: 'PATCH',
            headers: {
                ...headers(config),
                'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ room }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 刪除向量
 */
export async function deleteVector(config: RemoteVectorConfig, memoryId: string): Promise<boolean> {
    try {
        const res = await fetch(restUrl(config, `/memory_vectors?memory_id=eq.${encodeURIComponent(memoryId)}`), {
            method: 'DELETE',
            headers: headers(config),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 獲取遠程向量數量（用於 UI 顯示）
 */
export async function getVectorCount(config: RemoteVectorConfig, charId?: string): Promise<number> {
    try {
        const filter = charId ? `&char_id=eq.${encodeURIComponent(charId)}` : '';
        const res = await fetch(restUrl(config, `/memory_vectors?select=memory_id${filter}`), {
            method: 'HEAD',
            headers: {
                ...headers(config),
                'Prefer': 'count=exact',
            },
        });
        const range = res.headers.get('content-range');
        if (range) {
            const match = range.match(/\/(\d+)/);
            if (match) return parseInt(match[1], 10);
        }
        return 0;
    } catch {
        return 0;
    }
}

/**
 * 將本地向量同步到遠程（一次性遷移）
 */
export async function syncLocalToRemote(
    config: RemoteVectorConfig,
    getLocalVectors: () => Promise<{ memoryId: string; charId: string; vector: number[] | Float32Array | Uint8Array; node: MemoryNode; dimensions: number; model?: string }[]>,
    onProgress?: (done: number, total: number) => void,
): Promise<{ synced: number; failed: number }> {
    const locals = await getLocalVectors();
    if (locals.length === 0) return { synced: 0, failed: 0 };

    let synced = 0, failed = 0;
    const BATCH = 50;

    for (let i = 0; i < locals.length; i += BATCH) {
        const batch = locals.slice(i, i + BATCH);
        const ok = await upsertVectorBatch(config, batch);
        if (ok) {
            synced += batch.length;
        } else {
            failed += batch.length;
        }
        onProgress?.(Math.min(i + BATCH, locals.length), locals.length);
    }

    return { synced, failed };
}
