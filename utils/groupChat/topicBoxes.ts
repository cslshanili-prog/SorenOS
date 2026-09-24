import type { CharacterProfile, GroupProfile, GroupTopicBox, Message } from '../../types';
import { isMessageSemanticallyRelevant } from '../messageFormat';
import { messageLogText } from './format';

export const GROUP_TOPIC_HOT_ZONE = 200;
export const GROUP_TOPIC_BUFFER_THRESHOLD = 100;
export const GROUP_TOPIC_PROCESS_RATIO = 0.85;
export const GROUP_TOPIC_MAX_BATCH = 200;

export type GroupTopicBatch = {
    messages: Message[];
    pendingCount: number;
    hotZoneCount: number;
};

/** 只規劃公共成盒範圍；最近 200 條永遠保留為原文熱區。 */
export function planGroupTopicBatch(
    allMessages: Message[],
    archivedThroughMessageId: number = 0,
    force: boolean = false,
): GroupTopicBatch | null {
    const semantic = allMessages
        .filter(isMessageSemanticallyRelevant)
        .sort((a, b) => a.id - b.id);
    if (semantic.length <= GROUP_TOPIC_HOT_ZONE) return null;
    const hotZoneStartId = semantic[semantic.length - GROUP_TOPIC_HOT_ZONE].id;
    const pending = semantic.filter(m => m.id > archivedThroughMessageId && m.id < hotZoneStartId);
    const threshold = force ? 1 : GROUP_TOPIC_BUFFER_THRESHOLD;
    if (pending.length < threshold) return null;
    const processCount = Math.min(
        force ? pending.length : Math.ceil(pending.length * GROUP_TOPIC_PROCESS_RATIO),
        GROUP_TOPIC_MAX_BATCH,
    );
    return {
        messages: pending.slice(0, processCount),
        pendingCount: pending.length,
        hotZoneCount: Math.min(GROUP_TOPIC_HOT_ZONE, semantic.length),
    };
}

export function groupTopicPendingCount(allMessages: Message[], archivedThroughMessageId: number = 0): number {
    const semantic = allMessages.filter(isMessageSemanticallyRelevant).sort((a, b) => a.id - b.id);
    if (semantic.length <= GROUP_TOPIC_HOT_ZONE) return 0;
    const hotZoneStartId = semantic[semantic.length - GROUP_TOPIC_HOT_ZONE].id;
    return semantic.filter(m => m.id > archivedThroughMessageId && m.id < hotZoneStartId).length;
}

export function buildGroupTopicPrompt(
    group: GroupProfile,
    batch: Message[],
    characters: CharacterProfile[],
    userName: string,
    /** 群裡的 NPC 成員（只要名字；NPC 說的話在記錄裡要有名字，不能變成「未知成員」） */
    npcSpeakers: Array<{ id: string; name: string }> = [],
): string {
    const nameOf = (m: Message) => m.role === 'user'
        ? userName
        : (characters.find(c => c.id === m.charId)?.name || npcSpeakers.find(n => n.id === m.charId)?.name || '未知成員');
    const participants = [
        ...group.members.map(id => characters.find(c => c.id === id)?.name),
        ...npcSpeakers.map(n => `${n.name}（NPC）`),
    ].filter(Boolean).join('、');
    // 只給總結機角色語義資料，不傳頭像/立繪/房間圖片等媒體字段，避免 base64 撐爆請求。
    const memberProfiles = group.members.map(id => characters.find(c => c.id === id)).filter(Boolean).map(char => {
        const c = char as CharacterProfile;
        return `### ${c.name}（${c.id}）\n角色簡介：${c.description || '無'}\n核心設定：${c.systemPrompt || '無'}\n世界觀：${c.worldview || '無'}\n寫作人格：${c.writerPersona || '無'}\n核心記憶：${c.refinedMemories ? JSON.stringify(c.refinedMemories) : '無'}`;
    }).join('\n\n');
    const logs = batch.map(m => {
        const time = new Date(m.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `[${time}] ${nameOf(m)}: ${messageLogText(m)}`;
    }).join('\n');
    return `你是群聊檔案整理員。請把下面一段已經離開近期上下文的群聊，整理成一張所有成員共享的“公共話題盒”。

群名：${group.name}
成員：${participants}
用戶：${userName}

## 全體成員資料
這些資料只用於準確理解每個人的身份、關係和說話含義；總結仍必須保持群體共享的客觀視角。
${memberProfiles}

要求：
1. 使用客觀第三人稱，準確區分每個發言者，不站在任何單一角色視角。
2. 保留關鍵話題、約定、衝突、共同經歷、群內梗和情緒變化；不要逐句複述。
3. 標題 6–18 字；總結 100–500 字。瑣碎內容可以簡短，但不能編造。
4. 這張盒子會同時進入本群長期上下文，並作為卡片送到每位成員私聊。
5. 嚴格只輸出 JSON：{"title":"...","summary":"..."}
群聊原文：
${logs.slice(0, 30000)}`;
}

export function buildGroupTopicContext(group: GroupProfile): string {
    const boxes = group.topicBoxes || [];
    if (boxes.length === 0) return '';
    const body = boxes.slice(-20).map(box => `- 【${box.title}】${box.summary}`).join('\n');
    return `\n### 【${group.name} · 公共話題盒】\n以下是本群已歸檔的共同經歷，所有成員都知道；需要時自然承接，不要逐條複述。\n${body}\n`;
}

export function makeGroupTopicBox(group: GroupProfile, batch: Message[], title: string, summary: string): GroupTopicBox {
    const now = Date.now();
    return {
        id: `group-topic-${now}-${Math.random().toString(36).slice(2, 7)}`,
        groupId: group.id,
        title: title.trim() || '一段群聊回憶',
        summary: summary.trim(),
        sourceStartMessageId: batch[0].id,
        sourceEndMessageId: batch[batch.length - 1].id,
        messageCount: batch.length,
        participants: Array.from(new Set(batch.map(m => m.charId).filter(Boolean))),
        deliveredMemberIds: [...group.members],
        createdAt: now,
        updatedAt: now,
    };
}
