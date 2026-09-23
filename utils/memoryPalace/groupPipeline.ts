/**
 * Group Memory Palace — 群聊後台總結管線
 *
 * 與私聊管線（pipeline.ts/processNewMessages）的關係：**完全平行、互不調用**。
 * 所有共享的只是底層 IndexedDB 表（memory_nodes / memory_vectors 等通用 CRUD）和
 * embedding/向量存儲工具。私聊代碼一行不動。
 *
 * 核心數據流：
 * 1. 群聊導演響應後，GroupChat fire-and-forget 調用 processGroupNewMessages
 * 2. 檢查群聊高水位線（per-groupId localStorage key），緩衝區超 BUFFER_THRESHOLD_GROUP 才觸發
 * 3. LLM 用第三人稱提取群記憶草稿（groupExtraction.extractGroupMemoriesFromBuffer）
 * 4. 每個成員各持久化一份（同樣的草稿，charId=member.id，附 groupId/groupName 字段）
 *    → 私聊裡 retrieveMemories(member.id) 自然能召回這條群記憶，**無需額外注入路徑**
 * 5. 更新群聊高水位線
 *
 * 刪除群時，調用 deleteGroupMemoriesByGroupId 清理所有相關記憶。
 */
import type { Message, CharacterProfile, GroupProfile } from '../../types';
import type { EmbeddingConfig, MemoryNode, RemoteVectorConfig, MemoryVector } from './types';
import type { LightLLMConfig } from './pipeline';
import { DB } from '../db';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { getEmbeddings, cosineSimilarity } from './embedding';
import { extractGroupMemoriesFromBuffer } from './groupExtraction';
import { isMessageSemanticallyRelevant } from '../messageFormat';

// ─── 群聊水位線：私聊用 200/100，群聊更寬鬆 300/200 ─────────────────
const HOT_ZONE_SIZE_GROUP = 300;
// export：群設置的成員記憶狀態面板文案裡引用「滿 N 條自動觸發」，不硬編碼
export const BUFFER_THRESHOLD_GROUP = 200;
const PROCESS_RATIO = 0.85;
const DEDUP_THRESHOLD = 0.9;

const LAST_MSG_KEY_GROUP = (groupId: string) => `mp_lastMsgId_group_${groupId}`;

function getLastProcessedGroupId(groupId: string): number {
    try {
        const val = parseInt(localStorage.getItem(LAST_MSG_KEY_GROUP(groupId)) || '0', 10);
        return isNaN(val) || val < 0 ? 0 : val;
    } catch { return 0; }
}

function setLastProcessedGroupId(groupId: string, msgId: number): void {
    try { localStorage.setItem(LAST_MSG_KEY_GROUP(groupId), String(msgId)); } catch {}
}

/** 對外只讀包裝：群記憶宮殿處理到的最後一條消息 id（成員記憶狀態面板展示進度用） */
export function getGroupMemoryPalaceHighWaterMark(groupId: string): number {
    return getLastProcessedGroupId(groupId);
}

/** 全局記憶宮殿配置（自己讀 localStorage，不調 pipeline.ts 的私有 getter） */
function readGlobalMemoryPalaceConfig(): {
    embedding?: EmbeddingConfig;
    lightLLM?: LightLLMConfig;
} {
    try {
        const raw = localStorage.getItem('os_memory_palace_config');
        if (!raw) return {};
        const cfg = JSON.parse(raw);
        return {
            embedding: cfg?.embedding?.baseUrl && cfg?.embedding?.apiKey ? cfg.embedding as EmbeddingConfig : undefined,
            lightLLM: cfg?.lightLLM?.baseUrl && cfg?.lightLLM?.apiKey ? cfg.lightLLM as LightLLMConfig : undefined,
        };
    } catch {
        return {};
    }
}

function readRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

/**
 * 用成員的 embedding 配置（如果該成員有覆蓋），否則用全局配置。
 * 任何 member 沒配 → 返回 null，調用方跳過該成員。
 */
function getEmbeddingConfigForMember(member: CharacterProfile, fallbackGlobal?: EmbeddingConfig): EmbeddingConfig | null {
    const charEmb = (member as any).embeddingConfig;
    if (charEmb?.baseUrl && charEmb?.apiKey) {
        return charEmb as EmbeddingConfig;
    }
    return fallbackGlobal || null;
}

function generateGroupMemoryId(): string {
    return `mng_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把消息按 charId 映射成顯示名（用戶消息 → userName，角色消息 → 角色名） */
function makeSpeakerNameOf(members: CharacterProfile[], userName: string) {
    const charIdToName = new Map<string, string>();
    for (const m of members) charIdToName.set(m.id, m.name);
    return (msg: Message): string => {
        if (msg.role === 'user') return userName || '用戶';
        if (msg.charId) return charIdToName.get(msg.charId) || '群友';
        return '群友';
    };
}

// ─── 併發鎖：每個群同時只跑一個處理任務 ─────────────────
const processingLocks = new Set<string>();

/**
 * 刪除某個群的所有群記憶（成員各自存的副本一併清掉）
 *
 * 群被刪除時調用：掃描全表，刪除 groupId 匹配的 MemoryNode + 對應 MemoryVector。
 * 全表掃不快但刪群是低頻操作，可接受。
 */
export async function deleteGroupMemoriesByGroupId(groupId: string): Promise<{ deleted: number }> {
    if (!groupId) return { deleted: 0 };
    try {
        const all = await (async () => {
            // MemoryNodeDB 沒有 getAll；走通用 db 表名直查
            const db = await (await import('../db')).openDB();
            return new Promise<MemoryNode[]>((resolve, reject) => {
                const tx = db.transaction('memory_nodes', 'readonly');
                const req = tx.objectStore('memory_nodes').getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        })();
        const targets = all.filter(n => n.groupId === groupId);
        if (targets.length === 0) return { deleted: 0 };
        for (const node of targets) {
            try {
                await MemoryNodeDB.delete(node.id);
                // 對應向量也刪掉
                await MemoryVectorDB.delete(node.id);
            } catch (e: any) {
                console.warn(`🗑️ [GroupPalace] 刪除節點 ${node.id} 失敗: ${e.message}`);
            }
        }
        console.log(`🗑️ [GroupPalace] 刪除群 ${groupId} 的群記憶 ${targets.length} 條`);
        return { deleted: targets.length };
    } catch (e: any) {
        console.warn(`🗑️ [GroupPalace] 清理群記憶失敗: ${e.message}`);
        return { deleted: 0 };
    }
}

/**
 * 群聊後台緩衝區處理。
 *
 * - 至少需要 1 個成員開啟了記憶宮殿才跑（否則直接 return null）
 * - 全程異常吞掉，console.warn 後返回 null，絕不影響 GroupChat 主流程
 * - 寫出來的 MemoryNode 自帶 groupId/groupName，私聊代碼讀到這倆字段不感知（無副作用）
 * - onProgress 回調：每進入一個關鍵階段觸發一次（"掃描緩衝區" / "LLM 提取中" / "向量化第 X 個成員"），
 *   caller 用它做 toast/狀態條等用戶可見提示。skip 路徑（hot_zone/threshold）**不觸發** onProgress，
 *   避免水位線沒到時也彈"在整理"造成誤導。
 */
export async function processGroupNewMessages(
    group: GroupProfile,
    members: CharacterProfile[],
    userName: string,
    onProgress?: (stage: string) => void,
): Promise<{
    stored: number;
    perMemberStored: Record<string, number>;
    /** drafts 數量（即從 LLM 提取出的群記憶條數；可能 ≥ stored，因為 dedup 會扣掉一些） */
    extracted?: number;
    /** 本輪處理的群消息條數（用於 result toast 顯示信息量） */
    processedMessageCount?: number;
    reason?: 'lock' | 'hot_zone' | 'threshold' | 'no_config' | 'no_enabled_member';
} | null> {
    if (!group?.id) return null;
    const lockKey = group.id;
    if (processingLocks.has(lockKey)) {
        return { stored: 0, perMemberStored: {}, reason: 'lock' };
    }
    processingLocks.add(lockKey);

    try {
        // 1. 至少要有一個成員開啟了記憶宮殿
        const enabledMembers = members.filter(m => (m as any).memoryPalaceEnabled);
        if (enabledMembers.length === 0) {
            return { stored: 0, perMemberStored: {}, reason: 'no_enabled_member' };
        }

        // 2. 解析全局 LLM/embedding 配置（每個成員可能各自覆蓋 embedding）
        const globalCfg = readGlobalMemoryPalaceConfig();
        const lightLLM = globalCfg.lightLLM;
        const globalEmb = globalCfg.embedding;
        if (!lightLLM) {
            console.warn(`🏰 [GroupPalace] 群 ${group.name} 沒有可用的 lightLLM 配置，跳過`);
            return { stored: 0, perMemberStored: {}, reason: 'no_config' };
        }

        // 3. 加載群消息 → 計算熱區 / 緩衝區
        const allMsgs = await DB.getGroupMessages(group.id);
        const textMsgs = allMsgs
            .filter(isMessageSemanticallyRelevant)
            .sort((a, b) => a.id - b.id);

        const totalCount = textMsgs.length;
        if (totalCount <= HOT_ZONE_SIZE_GROUP) {
            console.log(`🏰 [GroupPalace] 群 ${group.name}：消息總數 ${totalCount} <= 熱區 ${HOT_ZONE_SIZE_GROUP}，無需處理`);
            return { stored: 0, perMemberStored: {}, reason: 'hot_zone' };
        }

        const hotZoneStartIdx = totalCount - HOT_ZONE_SIZE_GROUP;
        const hotZoneStartId = textMsgs[hotZoneStartIdx].id;

        const lastProcessedId = getLastProcessedGroupId(group.id);
        const buffer = textMsgs.filter(m => m.id > lastProcessedId && m.id < hotZoneStartId);

        if (buffer.length < BUFFER_THRESHOLD_GROUP) {
            console.log(`🏰 [GroupPalace] 群 ${group.name}：緩衝區 ${buffer.length} < ${BUFFER_THRESHOLD_GROUP}，跳過（hwm=${lastProcessedId}, 熱區起點 id=${hotZoneStartId}）`);
            return { stored: 0, perMemberStored: {}, reason: 'threshold' };
        }

        // 4. 取前 85%
        const processCount = Math.ceil(buffer.length * PROCESS_RATIO);
        const toProcess = buffer.slice(0, processCount);
        const keptTail = buffer.length - processCount;
        if (toProcess.length === 0) return { stored: 0, perMemberStored: {}, reason: 'threshold' };

        console.log(`🏰 [GroupPalace] 群 ${group.name}：開始處理 ${toProcess.length} 條群消息（保留尾部 ${keptTail} 條）`);
        onProgress?.(`正在整理 ${toProcess.length} 條群消息...`);

        // 5. LLM 提取（第三人稱草稿）
        const memberNames = members.map(m => m.name);
        const speakerNameOf = makeSpeakerNameOf(members, userName);
        onProgress?.(`正在提取【${group.name}】群記憶...`);
        const { drafts } = await extractGroupMemoriesFromBuffer(
            toProcess,
            group.name,
            memberNames,
            userName || '用戶',
            speakerNameOf,
            lightLLM,
        );

        if (drafts.length === 0) {
            console.warn(`🏰 [GroupPalace] 群 ${group.name}：提取 0 條群記憶，不更新水位線，下次重試`);
            return { stored: 0, perMemberStored: {}, extracted: 0, processedMessageCount: toProcess.length };
        }

        console.log(`🏰 [GroupPalace] 群 ${group.name}：提取 ${drafts.length} 條群記憶，開始為 ${enabledMembers.length} 個成員各持久化一份`);
        onProgress?.(`提取到 ${drafts.length} 條群記憶，正在向量化並存入 ${enabledMembers.length} 個成員的記憶宮殿...`);

        // 6. 為每個開啟記憶宮殿的成員各存一份
        //    每個成員用 ta 自己的 embedding 配置——這樣 retrieve 時向量空間一致
        const perMemberStored: Record<string, number> = {};
        const remoteVectorCfg = readRemoteVectorConfig();
        let totalStored = 0;

        for (const member of enabledMembers) {
            const memberEmb = getEmbeddingConfigForMember(member, globalEmb);
            if (!memberEmb) {
                console.warn(`🏰 [GroupPalace] 成員 ${member.name} 沒有 embedding 配置，跳過 ta 這一份`);
                perMemberStored[member.id] = 0;
                continue;
            }

            try {
                // 6a. 這個成員現有向量（用於本批去重）
                const existingVectors = await MemoryVectorDB.getAllByCharId(member.id);

                // 6b. 嵌入這個成員的所有 drafts
                const texts = drafts.map(d => d.content);
                const vectors = await getEmbeddings(texts, memberEmb);

                let storedForMember = 0;
                for (let i = 0; i < drafts.length; i++) {
                    const draft = drafts[i];
                    const vector = vectors[i];

                    // 與該成員已有記憶去重（同樣的群記憶草稿可能跟以前的群記憶撞）
                    // ev.vector 聲明上有 number[] / Float32Array / Uint8Array 三態，
                    // ensureFloat32 統一（DB 層已經轉好，這裡是恆等返回），別讓
                    // cosineSimilarity 把 Uint8Array 的原始字節當成分量讀。
                    const isDup = existingVectors.some(ev => cosineSimilarity(vector, ensureFloat32(ev.vector)) > DEDUP_THRESHOLD);
                    if (isDup) {
                        console.log(`♻️ [GroupPalace] ${member.name}：重複群記憶跳過 "${draft.content.slice(0, 30)}..."`);
                        continue;
                    }

                    const node: MemoryNode = {
                        id: generateGroupMemoryId(),
                        charId: member.id,
                        content: draft.content,
                        room: draft.room,
                        tags: draft.tags,
                        importance: draft.importance,
                        mood: draft.mood,
                        valence: draft.valence,
                        arousal: draft.arousal,
                        embedded: true,
                        createdAt: draft.createdAt,
                        lastAccessedAt: draft.createdAt,
                        accessCount: 0,
                        eventBoxId: null,
                        origin: 'extraction',
                        groupId: group.id,
                        groupName: group.name,
                    };
                    await MemoryNodeDB.save(node);

                    const memVec: MemoryVector = {
                        memoryId: node.id,
                        charId: member.id,
                        vector,
                        dimensions: memberEmb.dimensions,
                        model: memberEmb.model,
                    };
                    await MemoryVectorDB.save(memVec);

                    // 遠程向量異步同步（fire-and-forget）
                    if (remoteVectorCfg?.enabled && remoteVectorCfg.initialized) {
                        try {
                            const { upsertVector } = await import('./supabaseVector');
                            upsertVector(remoteVectorCfg, node.id, member.id, vector, node, memberEmb.dimensions, memberEmb.model).catch(() => {});
                        } catch { /* 忽略動態導入失敗 */ }
                    }

                    existingVectors.push(memVec);
                    storedForMember++;
                }

                perMemberStored[member.id] = storedForMember;
                totalStored += storedForMember;
                console.log(`🏰 [GroupPalace] ${member.name}：存入 ${storedForMember} 條群記憶`);
            } catch (e: any) {
                console.warn(`🏰 [GroupPalace] ${member.name} 持久化群記憶失敗: ${e.message}（其他成員繼續）`);
                perMemberStored[member.id] = 0;
            }
        }

        // 7. 更新群聊水位線（即使部分成員失敗也推進——避免重複提取）
        if (totalStored > 0) {
            const newHighWaterMark = toProcess[toProcess.length - 1].id;
            setLastProcessedGroupId(group.id, newHighWaterMark);
            console.log(`✅ [GroupPalace] 群 ${group.name}：處理完成 ${totalStored} 條總入庫, hwm ${lastProcessedId} → ${newHighWaterMark}`);
        } else {
            console.warn(`🏰 [GroupPalace] 群 ${group.name}：所有成員都沒存進 0 條，不更新水位線`);
        }

        return {
            stored: totalStored,
            perMemberStored,
            extracted: drafts.length,
            processedMessageCount: toProcess.length,
        };
    } catch (e: any) {
        console.warn(`❌ [GroupPalace] 群 ${group.name} 處理失敗: ${e.message}`);
        return null;
    } finally {
        processingLocks.delete(lockKey);
    }
}
