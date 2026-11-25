/**
 * 早期備份（一整根 data.json）邊讀邊組（plans/backup-streaming.md 第 3c 批）。
 *
 * 以前是整根解壓成一條大字串再 JSON.parse，文字多的人光這一步就可能讓分頁被關。現在：
 * 位元組一段一段進來 → 邊解成文字 → 頂層拆解器一筆一筆吐（utils/jsonTopLevelStream.ts）→
 * - 一般欄位：照舊 parse 進 data
 * - 大的表（LAZY_IMPORT_FIELDS）：不 parse 進記憶體，原文湊成一片一片寫到暫存區，
 *   回一個 LazyShardArray，寫庫時才一片一片讀回來（跟 v2／v3 走同一條路，見 utils/backupFormat.ts）
 *
 * 每一片寫進暫存區之前會先 parse 一次驗證。所以這個函式回來時，整份資料都確認過讀得懂，
 * 之後才開始動資料庫。
 *
 * 不碰 React／DOM。暫存區用 ZipSink 的介面（OPFS 暫存檔或記憶體都行）。
 */
import { LAZY_SHARDS, type LazyShardArray } from './backupFormat';
import { createTopLevelJsonParser } from './jsonTopLevelStream';
import type { ZipSink } from './zipStream/writer';

export interface V1StreamOptions {
    /** 哪些頂層陣列不進記憶體 */
    lazyFields?: readonly string[];
    /** 大表的原文暫存到哪。用到才開（沒有大表就不會叫） */
    createSpill: () => Promise<ZipSink> | ZipSink;
    /** 一片最多幾個字、幾筆 */
    maxLen?: number;
    maxItems?: number;
    /** 讀了多少位元組（進度用） */
    onProgress?: (bytesRead: number) => void;
    /** 讓出主執行緒 */
    onYield?: () => Promise<void>;
}

interface SpilledField {
    count: number;
    shards: Array<{ offset: number; length: number }>;
}

const encoder = new TextEncoder();

export async function assembleV1Stream(
    chunks: AsyncIterable<Uint8Array>,
    options: V1StreamOptions,
): Promise<Record<string, any>> {
    const lazyFields = new Set(options.lazyFields || []);
    const maxLen = options.maxLen ?? 4 * 1024 * 1024;
    const maxItems = options.maxItems ?? 500;
    const data: Record<string, any> = {};
    const spilled = new Map<string, SpilledField>();

    let spill: ZipSink | null = null;
    let spillOffset = 0;
    /** 目前正在收的大表 */
    let current: { key: string; items: string[]; length: number; field: SpilledField } | null = null;
    /** 湊好、等著寫進暫存區的片（拆解器的回呼是同步的，開暫存區是非同步的，所以先排著） */
    let pending: Array<{ field: SpilledField; bytes: Uint8Array }> = [];

    const flushShard = () => {
        if (!current || current.items.length === 0) return;
        const text = `[${current.items.join(',')}]`;
        // 寫進暫存區之前先確認讀得懂：之後寫庫時再讀回來就不會中途才發現壞掉
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.length !== current.items.length) {
            throw new SyntaxError(`JSON 格式錯誤：${current.key} 的內容對不上`);
        }
        current.field.count += current.items.length;
        pending.push({ field: current.field, bytes: encoder.encode(text) });
        current.items = [];
        current.length = 0;
    };

    const parser = createTopLevelJsonParser({
        onArrayStart(key) {
            if (lazyFields.has(key)) {
                const field: SpilledField = { count: 0, shards: [] };
                spilled.set(key, field);
                current = { key, items: [], length: 0, field };
            } else {
                data[key] = [];
            }
        },
        onArrayItem(key, itemText) {
            if (current && current.key === key) {
                current.items.push(itemText);
                current.length += itemText.length;
                if (current.length >= maxLen || current.items.length >= maxItems) flushShard();
                return;
            }
            data[key].push(JSON.parse(itemText));
        },
        onArrayEnd(key) {
            if (current && current.key === key) {
                flushShard();
                current = null;
            }
        },
        onValue(key, valueText) {
            data[key] = JSON.parse(valueText);
        },
    });

    const writePending = async () => {
        if (pending.length === 0) return;
        if (!spill) spill = await options.createSpill();
        const batch = pending;
        pending = [];
        for (const { field, bytes } of batch) {
            const length = bytes.byteLength;
            spill.write(bytes, true);
            field.shards.push({ offset: spillOffset, length });
            spillOffset += length;
        }
        await spill.drain?.();
    };

    try {
        const decoder = new TextDecoder('utf-8');
        let bytesRead = 0;
        for await (const chunk of chunks) {
            bytesRead += chunk.byteLength;
            parser.push(decoder.decode(chunk, { stream: true }));
            await writePending();
            options.onProgress?.(bytesRead);
            if (options.onYield) await options.onYield();
        }
        parser.push(decoder.decode());
        parser.end();
        await writePending();

        let store: Blob | null = null;
        if (spill) store = await (spill as ZipSink).finish();

        for (const [key, field] of spilled) {
            if (field.count === 0 || !store) { data[key] = []; continue; }
            const source = store;
            const lazy: LazyShardArray = {
                [LAZY_SHARDS]: true,
                length: field.count,
                parts: field.shards.length,
                loadPart: async (index: number) => {
                    const shard = field.shards[index];
                    return JSON.parse(await source.slice(shard.offset, shard.offset + shard.length).text());
                },
            };
            data[key] = lazy;
        }
        return data;
    } catch (error) {
        if (spill) await (spill as ZipSink).abort().catch(() => undefined);
        throw error;
    }
}

/** 把一個檔案（或任何 Blob）切成一段一段的位元組：純 .json 的備份用 */
export async function* blobChunks(blob: Blob, windowBytes = 4 * 1024 * 1024): AsyncGenerator<Uint8Array, void, void> {
    for (let at = 0; at < blob.size; at += windowBytes) {
        yield new Uint8Array(await blob.slice(at, Math.min(blob.size, at + windowBytes)).arrayBuffer());
    }
}
