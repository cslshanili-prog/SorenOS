/**
 * Group Memory Palace — 群聊記憶提取（第三人稱版本，獨立於私聊）
 *
 * 與 extraction.ts 的區別：
 * - 視角是"群聊觀察者"而非角色本人 → 第三人稱敘事，主語是具體的角色名
 * - 內容前綴統一為 "在【XXX群】裡，..."，便於該記憶後續平等地分發給每個成員
 * - 不參與便利貼系統（pinDays），不參與 relatedTo / EventBox 跨時間鏈接（v1 簡化）
 *
 * 私聊路徑完全不感知本文件存在。
 */
import type { Message } from '../../types';
import type { MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';

/** 群記憶草稿——尚未指派 charId（一份記憶稍後會複製給每個成員持久化） */
export interface GroupMemoryDraft {
    content: string;
    room: MemoryRoom;
    tags: string[];
    importance: number;
    mood: string;
    valence?: number;
    arousal?: number;
    /** 這批草稿對應的群消息時間窗中點（用於 createdAt） */
    createdAt: number;
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

function buildGroupRulesBlock(groupName: string, memberNames: string[], userLabel: string): string {
    const memberList = memberNames.join('、');
    return `## 規則

1. **第三人稱敘事**：你是【${groupName}】的群聊觀察者，記錄"群裡發生了什麼"。
   - 用戶稱呼為"${userLabel}"，群成員名字直接用：${memberList}
   - **絕對不要用"我"** —— 這條記憶會平等地發給群裡每個成員，所以不能站在某一個人的視角
   - 內容前綴統一為："在【${groupName}】裡，..."
   例：
   - "在【${groupName}】裡，${memberNames[0] || 'A'} 提起了最近在追的劇，${memberNames[1] || 'B'} 跟著安利，${userLabel} 表示已經被種草了。"
   - "在【${groupName}】裡，${memberNames[0] || 'A'} 抱怨了週末加班的事，大家分別支了一招，${memberNames[1] || 'B'} 讓 ta 直接拒絕，${memberNames[2] || 'C'} 讓 ta 先觀望。"

2. **重要性分級控制文字長度**：
   - 重要性 1–5：20–60字，事實為主
   - 重要性 6–7：60–140字，包含群裡的氛圍描寫
   - 重要性 8–10：120–220字，完整敘事（起因→經過→群裡的反應）

3. **房間分配**（注意視角是群整體）：
   - living_room：群裡的日常閒聊、玩梗、復讀、無關緊要的活躍氣氛
   - bedroom：群裡的暖心瞬間、深度互動、彼此關心或起鬨逗 ${userLabel} 的時刻
   - study：群裡討論工作 / 學習 / 興趣 / 技能 / 新聞話題
   - user_room：群裡發生的、關於 ${userLabel} 的事——${userLabel} 在群裡的狀態、情緒、提到的家人朋友、被起鬨等
   - self_room：群成員之間的關係演變、群整體氛圍的變化、誰和誰關係變好/變差
   - attic：群裡沒解決的矛盾、尷尬冷場、被擱置的話題、暗流湧動的修羅場
   - windowsill：群裡立下的約定、共同期盼、群體目標（線下聚會、集體計劃等）

4. **情緒標籤**（mood）：happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral
5. **情感座標**（valence, arousal）：
   - valence：-1（極痛苦）→ +1（極愉悅）
   - arousal：-1（極平靜）→ +1（極激烈）
6. **標籤**（tags）：提取 2-5 個關鍵詞標籤，最好包含涉及的角色名
7. **不要遺漏值得記的事，但也不要把每句話都變成記憶**。一段群聊通常提取 1–5 條記憶。
8. **不需要 pinDays / relatedTo / sameAs / eventName / eventTags** —— 群記憶 v1 不參與便利貼和事件盒系統。`;
}

function buildGroupConversationText(messages: Message[], speakerNameOf: (m: Message) => string): string {
    return messages.map(m => {
        const name = speakerNameOf(m);
        const time = new Date(m.timestamp).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        let content: string;
        if (m.type === 'image') content = '[圖片]';
        else if (m.type === 'emoji') content = `[表情包]`;
        else if (m.type === 'transfer') content = `[紅包: ${m.metadata?.amount ?? ''}]`;
        else content = (m.content || '').slice(0, 600);
        return `[${time}] ${name}: ${content}`;
    }).join('\n');
}

export interface GroupExtractionResult {
    drafts: GroupMemoryDraft[];
}

/**
 * 從群消息緩衝區提取記憶草稿。caller 拿到 drafts 後再為每個成員各持久化一份。
 *
 * 任何 LLM / 網絡異常都吞掉，返回空 drafts 供 caller 跳過本輪——絕不拋到上層。
 */
export async function extractGroupMemoriesFromBuffer(
    messages: Message[],
    groupName: string,
    memberNames: string[],
    userLabel: string,
    speakerNameOf: (m: Message) => string,
    llmConfig: LightLLMConfig,
): Promise<GroupExtractionResult> {
    if (messages.length === 0) return { drafts: [] };

    const conversationText = buildGroupConversationText(messages, speakerNameOf);
    const memberList = memberNames.join('、');

    const systemPrompt = `你是【${groupName}】的群聊觀察者，請從以下群聊記錄中提取值得記住的群聊記憶。
群成員：${memberList}
用戶：${userLabel}

${buildGroupRulesBlock(groupName, memberNames, userLabel)}

## 輸出格式

嚴格 JSON 數組，不要 markdown 包裹：
[
  {
    "content": "在【${groupName}】裡，...",
    "room": "living_room",
    "importance": 5,
    "mood": "neutral",
    "valence": 0,
    "arousal": 0,
    "tags": ["標籤1", "標籤2"]
  }
]

如果群聊過於瑣碎無值得記憶的內容，返回空數組 []。`;

    try {
        const data = await safeFetchJson(
            `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: llmConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `群聊記錄：\n${conversationText}` },
                    ],
                    temperature: 0.4,
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            2, 180_000, { appName: '記憶宮殿', purpose: '群記憶提取' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (parsed.length === 0 && reply.trim().length > 0) {
            console.warn(`🏰 [GroupExtraction] LLM 返回了內容但 JSON 解析為空數組。原始回覆前200字: ${reply.slice(0, 200)}`);
        }

        const msgTimestamps = messages.map(m => m.timestamp).filter(t => t > 0);
        const midTime = msgTimestamps.length > 0
            ? Math.round((msgTimestamps[0] + msgTimestamps[msgTimestamps.length - 1]) / 2)
            : Date.now();

        const drafts: GroupMemoryDraft[] = parsed
            .filter((item: any) => item && typeof item.content === 'string' && item.content.trim() && item.room)
            .map((item: any): GroupMemoryDraft => ({
                content: item.content,
                room: (VALID_ROOMS.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: typeof item.mood === 'string' ? item.mood : 'neutral',
                valence: typeof item.valence === 'number' ? clampVA(item.valence) : undefined,
                arousal: typeof item.arousal === 'number' ? clampVA(item.arousal) : undefined,
                createdAt: midTime,
            }));

        console.log(`🏰 [GroupExtraction] 從 ${messages.length} 條群消息提取 ${drafts.length} 條群記憶草稿`);
        return { drafts };
    } catch (err: any) {
        console.warn(`❌ [GroupExtraction] 群記憶提取失敗 (${messages.length} 條消息): ${err.message}`);
        return { drafts: [] };
    }
}
