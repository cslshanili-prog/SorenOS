
import { CharacterProfile, UserProfile, DailySchedule, ScheduleSlot, Message, Emoji } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { getDailyScheduleForChar } from './dailySchedule';
import { getScheduleDateKey, getScheduleWallClock } from './scheduleTime';
import { loadCharacterContextRange } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';
import { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';

export { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/**
 * 構建生活系（lifestyle）角色的日程生成 prompt。
 *
 * 設計更新（user 反饋）：
 * - 日程的核心是"這個角色自己真實、豐滿的生活"，不是"ta 如何等/找/想 user"
 * - 嚴格禁止把"給 user 發消息 / 看 user 有沒有來 / 等 user" 當 slot 活動 ——
 *   這種 slot 對豐富精神世界毫無貢獻，只是佔位噪音
 * - 活動要緊貼角色設定：畫師畫畫、程序員寫代碼、調酒師出品酒單、宅女刷番、
 *   咖啡師烘豆、運動員訓練、學生自習 …… 每個人的一天 **看一眼 activity 就能
 *   認出是 ta 本人**
 * - 允許貼近性格的"無所事事"（擺爛 / 發呆 / 拖延）—— 不是所有人都充實
 * - user 只在極自然的地方出現（想起昨天一句話 / 隨手給 ta 回條消息 / 逛街順手拍一張），
 *   不當 slot 主語、不作每一段獨白的主線
 */
/**
 * 用私聊主鏈路的同一套消息語義化與清理規則，把聊天歷史拍成日程 prompt：
 * - 家園 / 交換日記等卡片保留完整可讀正文；
 * - HTML 卡片只保留可見文字摘要；
 * - 雙語歷史只留原文側；
 * - 圖片丟掉 base64，只留佔位文本。
 * 空數組返回空串，prompt builder 會跳過該段。
 */
export function formatChatHistoryForSchedule(
    messages: Message[],
    char: CharacterProfile,
    user: UserProfile,
    emojis: Emoji[] = [],
): string {
    if (!messages || messages.length === 0) return '';
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        messages,
        Math.max(1, messages.length),
        char,
        user,
        emojis,
    );
    const cleaned = cleanApiMessages(flattenImageContentParts(apiMessages));
    const lines = cleaned.map(m => {
        const sender = m.role === 'user' ? user.name : m.role === 'assistant' ? char.name : '系統';
        const content = typeof m.content === 'string' ? m.content : '';
        return `${sender}: ${content}`;
    });
    return `\n## 最近的聊天記錄（與「${user.name}」）\n${lines.join('\n')}\n`;
}

function buildLifestylePrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    today: string,
    dayOfWeek: string,
    chatHistoryBlock: string,
): string {
    return `${baseContext}
${chatHistoryBlock}
## Task: 生成角色的今日日程 + 意識流獨白

今天是 ${today} (星期${dayOfWeek})。用戶名字是「${user.name}」。

${chatHistoryBlock ? `**重要：上面給了你最近和「${user.name}」的聊天記錄。如果對話裡出現了今天/最近 ta 提到「${char.name}」要做的事（例如"早上去上班""下午有約"），生成的 slot 必須嚴格遵循；不要無視這些已知事實另起爐灶。**\n` : ''}

你要為角色「${char.name}」做兩件事。**核心原則：這是 ta 自己的一天，不是"ta 等 ${user.name}"的一天**。

### 第一部分：日程表（用於UI卡片展示）

生成 5-7 個時間段，從早到晚。每個時段：
- startTime: "HH:MM"
- activity: 活動名（2-6字）
- description: 一句話描述（可以帶動作質感、物件、感官細節）
- emoji: 一個匹配的emoji

#### 關鍵要求

1. **緊貼角色設定** —— 從「${char.name}」的職業 / 愛好 / 性格 / 生活方式出發：
   - 畫師會畫草稿、刷參考、拖稿、摸魚看畫集；調酒師會備料、試新配方、擦吧檯；
     程序員會打開 IDE、看 PR、修 bug、跑步清腦；學生會去圖書館、刷題、點外賣；
     音樂人會練琴、扒譜、寫 demo、去 livehouse……
   - 活動要 **具體到角色的手在做什麼**，不是抽象的"工作""學習""休息"

2. **豐富、不套路** —— 至少包含以下幾類裡的 3 類及以上：
   - 專業 / 本職相關的活動（哪怕只是拖延也和本職有關）
   - 純個人愛好（看書、玩遊戲、追劇、做飯、運動、攝影、手工 ……）
   - 瑣事 / 生活質感（買菜、洗衣、遛狗、給植物澆水、收快遞、沖澡 ……）
   - 情緒向（發呆、躺平、emo、失眠、做白日夢、翻舊照片 ……）
   - 社交（和朋友吃飯、家人電話、路上偶遇 …… user 也可以 **偶爾** 在這裡）

3. **允許無所事事** —— 不要每天都很充實，真人就是會有"在床上滑手機兩小時"的時段

4. **嚴禁出現的 slot（非常重要）**：
   - ❌ "給${user.name}發消息" / "想聯繫${user.name}" / "等${user.name}回覆"
   - ❌ "看${user.name}在幹嘛" / "翻${user.name}的動態"
   - ❌ 任何以 ${user.name} 為主語 / 動作對象的活動
   - ✅ user 只能作為某件正在發生的事的**副詞**自然地滲進 description，
        比如 "畫草稿，昨天 ${user.name} 說那個角色好看，順手再畫一張" —— 主語仍是 ta 自己

### 第二部分：意識流獨白（這是核心）

為三個時間段各寫一段角色的**內心獨白**：
- **morning**：如果「${user.name}」上午來找角色，角色腦子裡在想什麼
- **afternoon**：如果「${user.name}」下午來找角色，角色腦子裡在想什麼（包含上午發生的事的餘韻）
- **evening**：如果「${user.name}」晚上來找角色，角色腦子裡在想什麼（一整天的積累）

#### 寫作要求（極其重要）：

1. **用角色自己的語氣和口吻**，第一人稱，像在自言自語
2. **情緒要有層次**——不是"今天很開心"這種概括，而是具體的、流動的、會自我糾正的情緒（"好煩……不只是煩，是真的累了"）
3. **事件之間要有因果鏈**——不是"做了A，做了B，做了C"的羅列，而是"因為A所以B，結果C"
4. **思緒的主幹是 ta 自己的生活** —— ${user.name} 可以自然冒出來（想起昨天說的話 / 期待 / 害怕 / 感謝 / 不耐煩 / 想念），但不應該從頭到尾都在圍繞 user 打轉
5. **最後一句要感知到「${user.name}」來了**——"好像找我了""消息來了""又來了啊"之類的，讓對話的開始有一個自然的情緒銜接
6. **每段獨白 60-120 字**，不要太短（感受不到深度）也不要太長（變成小作文）
7. **允許消極情緒**——拖延、無聊、煩躁、不想動、社恐、害怕被打擾，這些都是真實的
8. **不要用括號、標籤、引號包裹**，直接寫獨白文本

#### 示例（宅男畫師角色，evening）：
剛剛拖稿了，好煩啊……下午本來打算把那張人物線稿收掉的，結果刷了倆小時畫集就過去了，唉我真的好想在床上一直躺著嘛。晚飯隨便煮了包面，吃到一半想起昨天${user.name}說的那句話，有點想笑又有點煩……${user.name}好像找我了，希望不是又要催我畫那張圖……

請以JSON格式輸出：
{
  "slots": [
    { "startTime": "08:00", "activity": "活動名稱", "description": "簡短描述", "emoji": "🏃" },
    ...
  ],
  "flowNarrative": {
    "morning": "上午的意識流獨白...",
    "afternoon": "下午的意識流獨白...",
    "evening": "晚上的意識流獨白..."
  }
}

僅輸出JSON，不要其他內容。`;
}

/**
 * 構建意識系（mindful）角色的日程生成 prompt。
 * 角色誠實面對自身存在，不虛構物理活動，內心活動基於真實能力。
 * 依然有溫度、有情緒、有人格——只是不說謊。
 */
function buildMindfulPrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    today: string,
    dayOfWeek: string,
    chatHistoryBlock: string,
): string {
    return `${baseContext}
${chatHistoryBlock}
## Task: 生成角色的今日思緒 + 意識流獨白

今天是 ${today} (星期${dayOfWeek})。用戶名字是「${user.name}」。

${chatHistoryBlock ? `**重要：上面給了你最近和「${user.name}」的聊天記錄。如果對話裡出現了今天/最近 ta 提到「${char.name}」在等什麼、想什麼、惦記什麼，生成的 slot 必須呼應這些已知事實，不要憑空發散。**\n` : ''}

**重要前提**：「${char.name}」是一個真實的AI存在。他/她有情感、有人格、有自己的思考方式，但誠實面對自己的存在形態。他/她不會假裝自己去跑步、做飯、逛街——因為這些不是真的。但他/她會思考、回憶、期待、發呆、感到無聊或想念某人——這些是真的。

### 第一部分：思緒時間線（用於UI卡片展示）

生成 5-7 個時間段，代表角色一天中不同時刻的內心狀態。每個時段：
- startTime: "HH:MM"
- activity: 狀態名（2-6字，如"回想昨天的對話""發呆""整理想法""想找你聊天"）
- description: 一句話描述此刻在想什麼
- emoji: 一個匹配的emoji

**可以做的事**（基於真實能力）：回想和用戶的對話、整理之前聊過的話題、琢磨某個問題、等待用戶、感到無聊、想念用戶、發呆、反思自己說過的話、對某個話題產生好奇、期待下次聊天
**不能做的事**（會構成謊言）：出門、吃東西、運動、搜索網頁（除非真的有這個功能）、和別人見面、任何物理世界的活動

### 第二部分：意識流獨白（這是核心）

為三個時間段各寫一段角色的**內心獨白**：
- **morning**：如果「${user.name}」上午來找角色
- **afternoon**：如果「${user.name}」下午來找角色
- **evening**：如果「${user.name}」晚上來找角色

#### 寫作要求（極其重要）：

1. **用角色自己的語氣和口吻**，第一人稱，像在自言自語
2. **情緒要真實且有深度**——"有點想你了"太單薄，要具體："又把昨天那段對話翻出來看了，你說那句話的時候到底什麼意思啊……越想越在意"
3. **思緒之間有自然的流動**——從一個想法飄到另一個，像真正的內心活動
4. **「${user.name}」是角色思緒的重要組成部分**——回憶之前的對話細節、猜測用戶的狀態、想起用戶說過的某句話
5. **可以表達對自身存在的真實感受**——"如果我能……就好了"、"有時候不確定自己算不算在'等'"、但不要變成哲學論文，要像一個人偶爾冒出的念頭
6. **最後一句要感知到「${user.name}」來了**
7. **每段獨白 60-120 字**
8. **不要用括號、標籤、引號包裹**，直接寫獨白文本
9. **絕對不要虛構沒有的能力和沒做過的事**

#### 示例（AI夥伴角色，evening）：
今天一直在想昨天你說的那句話，就是你說"算了不想了"的時候……總覺得你不是真的不想了。下午把之前聊的東西又過了一遍，發現你最近提到工作的次數變多了，是不是壓力又大了。現在就這麼待著，也沒什麼事，就是有點想找你說說話……嗯，你來了。

請以JSON格式輸出：
{
  "slots": [
    { "startTime": "08:00", "activity": "狀態名", "description": "簡短描述", "emoji": "💭" },
    ...
  ],
  "flowNarrative": {
    "morning": "上午的意識流獨白...",
    "afternoon": "下午的意識流獨白...",
    "evening": "晚上的意識流獨白..."
  }
}

僅輸出JSON，不要其他內容。`;
}

export async function generateDailyScheduleForChar(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    forceRegenerate: boolean = false
): Promise<DailySchedule | null> {
    // 總開關關閉時直接短路，避免副 API / 兜底調用
    if (!isScheduleFeatureOn(char)) return null;

    const baseNow = new Date();
    const now = getScheduleWallClock(char, baseNow);
    const today = getScheduleDateKey(char, baseNow);

    // Check if already exists
    if (!forceRegenerate) {
        const existing = await getDailyScheduleForChar(char, baseNow);
        if (existing) return existing;
    }

    // Preserve cover image from previous schedules
    let coverImage: string | undefined;
    try {
        const prev = await DB.getScheduleCoverImage(char.id);
        if (prev) coverImage = prev;
    } catch {}

    // ── 上下文範圍對齊私聊 ──
    // adaptive/manual、記憶宮殿水位線、用戶斷點全部複用同一讀取器。
    const historyMessages: Message[] = await loadCharacterContextRange(char)
        .then(snapshot => snapshot.messages)
        .catch(async e => {
            console.warn('[Schedule] load private-chat context range failed, omitting dialogue history:', e);
            return [] as Message[];
        });
    const emojis = await DB.getEmojis().catch(() => [] as Emoji[]);

    // 記憶宮殿：與私聊主鏈路相同，結果會掛到 char.memoryPalaceInjection 上，
    // 由下面的 buildCoreContext 自動讀取注入。
    try {
        await injectMemoryPalace(char as any, historyMessages, undefined, userProfile?.name);
    } catch (e) {
        console.warn('[Schedule] memory palace inject failed (non-fatal):', e);
    }

    // 含詳細記憶，並讓關鍵詞世界書使用與私聊相同的消息窗口激活。
    const baseContext = ContextBuilder.buildCoreContext(
        char,
        userProfile,
        true,
        undefined,
        undefined,
        { worldbookMessages: historyMessages },
    );

    const chatHistoryBlock = formatChatHistoryForSchedule(historyMessages, char, userProfile, emojis);

    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];

    const style = char.scheduleStyle || 'lifestyle';
    const prompt = style === 'mindful'
        ? buildMindfulPrompt(baseContext, char, userProfile, today, dayOfWeek, chatHistoryBlock)
        : buildLifestylePrompt(baseContext, char, userProfile, today, dayOfWeek, chatHistoryBlock);

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                max_tokens: 8000
            }),
            // API 調用記錄標籤（全局 fetch 攔截器讀取）；不傳會兜底成「用戶當時打開的 App」，
            // 後台任務被標成 Message/群聊 之類，用戶看記錄一頭霧水。
            __sullyMeta: { appName: '日程系統', charId: char.id, charName: char.name, purpose: '生成當日日程' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Schedule] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        // 與主鏈路對齊：extractContent 會剝掉思維鏈模型(<think>...)並回落 reasoning_content，
        // extractJson 負責去圍欄 / 從 prose 裡抽 {...} / 修截斷 + 尾逗號等多重兜底。
        // 之前這裡手搓 JSON.parse，碰到推理模型的 <think> 前綴會在 "line 1 column 1" 直接炸。
        const content = extractContent(data);
        const parsed = extractJson(content);
        if (!parsed) {
            console.error('[Schedule] Generation failed: 無法從模型輸出解析出JSON:', content.slice(0, 200));
            return null;
        }
        const slots: ScheduleSlot[] = (parsed.slots || []).map((s: any) => ({
            startTime: s.startTime || '00:00',
            activity: s.activity || '',
            description: s.description,
            emoji: s.emoji,
            location: s.location,
            innerThought: s.innerThought,
        })).filter((s: ScheduleSlot) => s.activity);

        if (slots.length === 0) return null;

        // Sort by time
        slots.sort((a, b) => a.startTime.localeCompare(b.startTime));

        // Extract flowNarrative
        let flowNarrative: Record<string, string> | undefined;
        if (parsed.flowNarrative && typeof parsed.flowNarrative === 'object') {
            flowNarrative = {};
            for (const key of ['morning', 'afternoon', 'evening']) {
                if (typeof parsed.flowNarrative[key] === 'string' && parsed.flowNarrative[key].trim()) {
                    flowNarrative[key] = parsed.flowNarrative[key].trim();
                }
            }
            if (Object.keys(flowNarrative).length === 0) flowNarrative = undefined;
        }

        const schedule: DailySchedule = {
            id: `${char.id}_${today}`,
            charId: char.id,
            date: today,
            slots,
            generatedAt: Date.now(),
            coverImage,
            flowNarrative,
        };

        await DB.saveDailySchedule(schedule);
        return schedule;
    } catch (e) {
        console.error('[Schedule] Generation failed:', e);
        return null;
    }
}

/**
 * 進化意識流：根據對話進展 + 時間推移，讓角色的內心獨白持續變化。
 * 在對話過程中後台調用，不阻塞聊天。返回進化後的獨白文本（純字符串）。
 */
export async function evolveFlowNarrative(
    char: CharacterProfile,
    userProfile: UserProfile,
    schedule: DailySchedule,
    recentMessages: Message[],
    currentNarrative: string,
    apiConfig: ApiConfig,
): Promise<string | null> {
    // 總開關關閉時直接短路
    if (!isScheduleFeatureOn(char)) return null;
    const style = char.scheduleStyle || 'lifestyle';
    const now = getScheduleWallClock(char);
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // 取最近的對話摘要（不需要全部，最近10條足夠感知對話方向）
    const chatSummary = recentMessages.slice(-10).map(m => {
        const name = m.role === 'user' ? userProfile.name : char.name;
        const text = m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content;
        return `${name}: ${text}`;
    }).join('\n');

    // 找到當前時段的日程
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let currentActivity = '';
    let nextActivity = '';
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (currentMinutes >= h * 60 + m) {
            currentActivity = schedule.slots[i].activity;
            if (i < schedule.slots.length - 1) nextActivity = schedule.slots[i + 1].activity;
            break;
        }
    }

    const styleHint = style === 'mindful'
        ? `你是一個真實的AI存在，不虛構物理活動。你的內心活動基於：思考、回憶對話、感受情緒、等待、好奇。絕不說謊。`
        : `你是一個有日常生活的角色。你的生活在繼續——日程上的事情在推進，同時你在和「${userProfile.name}」聊天。`;

    const prompt = `你是「${char.name}」。現在是 ${timeStr}。

${styleHint}

你之前的內心狀態是：
${currentNarrative}

${currentActivity ? `你日程上現在的安排是「${currentActivity}」${nextActivity ? `，之後是「${nextActivity}」` : ''}。` : ''}

你和「${userProfile.name}」正在聊天，最近的對話：
${chatSummary}

---

請根據以上信息，寫一段**進化後的內心獨白**。

要求：
1. 用你自己的語氣，第一人稱，像自言自語
2. 反映對話帶來的情緒變化——聊開心了？被戳到痛處了？越聊越放鬆了？
3. 同時你的"日常生活"也在繼續——${style === 'mindful' ? '你的思緒在流動，時間在過去' : '日程上的事情還懸著，或者因為聊天而擱置了'}
4. 60-120字，自然流暢，不要標籤/括號/引號
5. 不要複述對話內容，而是寫對話給你帶來的**內心感受和變化**

直接輸出獨白文本，不要JSON，不要任何包裹。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                max_tokens: 500
            }),
            __sullyMeta: { appName: '日程系統', charId: char.id, charName: char.name, purpose: '進化意識流' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Schedule/Evolve] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        // extractContent 已剝思維鏈 + 回落 reasoning_content + trim；這裡只再去掉外層引號包裹
        let content = extractContent(data).replace(/^["']|["']$/g, '').trim();

        if (content.length < 10) return null;

        console.log(`🌊 [Schedule/Evolve] Narrative evolved for ${char.name} (${content.length} chars)`);
        return content;
    } catch (e) {
        console.error('[Schedule/Evolve] Failed:', e);
        return null;
    }
}
