// 群聊提示詞構建 —— 從 GroupChat.tsx 抽出的純函數，導演模式模板"搬家不改字"，
// 供導演模式與輪詢模式（每成員一次調用）共用。
import { stripLeakedReasoning } from '../reasoningLeak';
import { Message, EmojiCategory } from '../../types';
import { stickerNameFromUrl } from '../messageFormat';
import { isBlobRef } from '../blobRef';
import { packetHistoryLine } from './redpacket';
import { formatRelativeAge } from './relativeTime';
import { buildNpcDirectorNote } from './npcMembers';

interface EmojiItem { name: string; url: string; categoryId?: string }

/**
 * 這個值是「一張圖 / 一段媒體」而不是正文嗎？認三種形態：內嵌 data URL、http(s) 外鏈、
 * blobref 令牌。令牌只有 ~28 字，按長度截斷的兜底攔不住它；而發請求時網絡出口那層
 * （utils/apiBlobRefs.ts）會把令牌統一還原成完整 data URL —— 混進 prompt 就是每輪
 * 重發幾 MB 的 base64。
 */
const isMediaValue = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    return /^(data:|https?:\/\/)/i.test(trimmed) || isBlobRef(trimmed);
};


/**
 * 按分類拼可用表情清單（按群成員可見性過濾）。
 * 原 GroupChat.tsx triggerDirector 內的 IIFE，逐字搬出。
 */
export function buildEmojiContextStr(
    emojis: EmojiItem[],
    categories: EmojiCategory[],
    memberIds: string[],
): string {
    if (emojis.length === 0) return '無';

    // Filter categories: include if no restriction, or if at least one group member is allowed
    const visibleCats = categories.filter(c => {
        if (!c.allowedCharacterIds || c.allowedCharacterIds.length === 0) return true;
        return c.allowedCharacterIds.some(id => memberIds.includes(id));
    });
    const hiddenCatIds = new Set(categories.filter(c => !visibleCats.some(vc => vc.id === c.id)).map(c => c.id));
    const visibleEmojis = hiddenCatIds.size === 0 ? emojis : emojis.filter(e => !e.categoryId || !hiddenCatIds.has(e.categoryId));

    const grouped: Record<string, string[]> = {};
    const catMap: Record<string, string> = { 'default': '通用' };
    visibleCats.forEach(c => catMap[c.id] = c.name);

    visibleEmojis.forEach(e => {
        const cid = e.categoryId || 'default';
        if (!grouped[cid]) grouped[cid] = [];
        grouped[cid].push(e.name);
    });

    return Object.entries(grouped).map(([cid, names]) => {
        const cName = catMap[cid] || '其他';
        return `${cName}: [${names.join(', ')}]`;
    }).join('; ');
}

export interface GroupHistoryBlock {
    /** 群歷史文本（每行 `名字: 內容`，媒體用佔位符） */
    text: string;
    /** 走結構化 image_url 附帶的最近圖片 */
    attachedImages: { tag: number; url: string }[];
    /** 附圖說明行（無附圖時為空串） */
    attachedImagesNote: string;
}

/** 相鄰兩條消息間隔超過這個閾值（毫秒）就在歷史裡插一條"隔了多久"的分隔行。默認 3 小時。 */
export const GROUP_HISTORY_GAP_THRESHOLD_MS = 3 * 60 * 60 * 1000;

/** 把毫秒時長說成人話："約 3 天" / "約 5 小時"，只在插分隔行時用。 */
function formatGapDuration(ms: number): string {
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days >= 1) return `約 ${days} 天`;
    if (hours >= 1) return `約 ${hours} 小時`;
    return `約 ${mins} 分鐘`;
}

/**
 * 群歷史塊（含最近圖片結構化附帶）。原 triggerDirector 內聯邏輯，逐字搬出：
 * image 的 content 是 blobref 令牌或 base64（processImage 壓的 JPEG），emoji 是令牌或圖床 URL——
 * 都不能當文本內聯進 prompt（令牌出門時還會被還原成整段 data URL）。最近 N 張圖片走結構化
 * image_url 字段附在 user 消息裡，文本里用 [圖片#k] 佔位互相對齊。
 */
export function buildGroupHistoryBlock(
    msgs: Message[],
    /** 名字查詢表：角色 + 群裡的 NPC（只用到 id / name） */
    characters: Array<{ id: string; name: string }>,
    emojis: EmojiItem[],
    userName: string = '用戶',
    maxAttachedImages: number = 3,
    options?: { useVisionDescriptions?: boolean },
): GroupHistoryBlock {
    const nameOf = (id: string) => (id === 'user' ? userName : characters.find(c => c.id === id)?.name || '成員');
    const now = Date.now();
    const validImageWindowIdx: number[] = [];
    msgs.forEach((m, i) => {
        if (m.type === 'image') {
            const visionDescription = options?.useVisionDescriptions
                && typeof m.metadata?.visionDescription === 'string'
                ? m.metadata.visionDescription.trim()
                : '';
            if (visionDescription) return;
            const url = typeof m.content === 'string' ? m.content.trim() : '';
            // 認不出令牌 = 這張圖永遠進不了附帶名單，模型看不到圖卻又毫無報錯
            if (/^(data:|https?:\/\/)/i.test(url) || isBlobRef(url)) validImageWindowIdx.push(i);
        }
    });
    const attachedSet = new Set(validImageWindowIdx.slice(-maxAttachedImages));
    const attachedImages: { tag: number; url: string }[] = [];
    const lines: string[] = [];
    let prevTs: number | null = null;
    msgs.forEach((m, i) => {
        // 相鄰消息隔得久時插一條分隔行，讓導演直接在記錄裡"看見"時間跳變——
        // 否則用戶隔幾天回來發一句，模型會把幾天前那條當"剛才"無縫續上舊話題。
        if (prevTs != null && typeof m.timestamp === 'number' && m.timestamp - prevTs >= GROUP_HISTORY_GAP_THRESHOLD_MS) {
            lines.push(`———（這裡隔了 ${formatGapDuration(m.timestamp - prevTs)}，中間群裡沒人說話）———`);
        }
        if (typeof m.timestamp === 'number') prevTs = m.timestamp;
        const timePrefix = typeof m.timestamp === 'number' ? `[${formatRelativeAge(m.timestamp, now)}] ` : '';

        let name = '用戶';
        if (m.role === 'assistant') {
            name = characters.find(c => c.id === m.charId)?.name || '未知';
        }
        const rawText = typeof m.content === 'string' ? m.content : '';
        let content: string;
        if (m.type === 'image') {
            const visionDescription = options?.useVisionDescriptions
                && typeof m.metadata?.visionDescription === 'string'
                ? m.metadata.visionDescription.trim()
                : '';
            if (visionDescription) {
                content = `[圖片：${visionDescription}]`;
            } else if (attachedSet.has(i)) {
                const tag = attachedImages.length + 1;
                attachedImages.push({ tag, url: rawText.trim() });
                content = `[圖片#${tag}]`;
            } else {
                content = '[圖片]';
            }
        } else if (m.type === 'emoji') {
            content = `[表情包: ${stickerNameFromUrl(emojis, rawText.trim())}]`;
        } else if (m.type === 'transfer') {
            // 回執行自帶完整句子（[系統: X 領取了 Y 的紅包]），不加名字前綴
            if (m.metadata?.packetReceipt) { lines.push(`${timePrefix}${packetHistoryLine(m, nameOf, now)}`); return; }
            content = packetHistoryLine(m, nameOf, now);
        } else if (isMediaValue(rawText)) {
            // 令牌也算媒體：漏認會把它當正文內聯進 prompt，出門時還被還原成整段 data URL
            content = '[媒體]';
        } else if (m.role === 'assistant') {
            // 以前漏進群裡的思考過程（<thinking>、「讓我看看現在的狀況…」）不再當範例傳給下一位，
            // 整則都是思考的就當沒這行（見 reasoningLeak.ts）
            content = stripLeakedReasoning(rawText).content;
            if (!content) return;
        } else {
            content = rawText;
        }
        // 引用回覆：對齊私聊 chatPrompts 的格式——被引用原話獨立成行，新回覆另起一行突出
        if (m.replyTo) {
            const rawQuote = typeof m.replyTo.content === 'string' ? m.replyTo.content : '';
            // 被引用的可能本來就是一條圖片消息 —— 此時 rawQuote 是 data URL / 外鏈 / blobref
            // 令牌，截 60 字只會切出一段沒意義的 base64 碎片，令牌更是整條活著進 prompt。
            const quoted = isMediaValue(rawQuote)
                ? '[圖片]'
                : (rawQuote.length > 60 ? rawQuote.slice(0, 60) + '…' : rawQuote);
            lines.push(`${timePrefix}[${name} 引用了 ${m.replyTo.name || '對方'} 說的「${quoted}」，並回復了 ↓]\n${name}: ${content}`);
            return;
        }
        lines.push(`${timePrefix}${name}: ${content}`);
    });
    const text = lines.join('\n');
    const attachedImagesNote = attachedImages.length > 0
        ? `\n（本輪附帶 ${attachedImages.length} 張最近的圖片，對應記錄裡的 [圖片#1] ~ [圖片#${attachedImages.length}]。請基於實際圖片內容自然反應，不要無視，也不要瞎猜沒附上的舊圖。）\n`
        : '';
    return { text, attachedImages, attachedImagesNote };
}

/**
 * 導演模式任務指令（接在角色檔案塊之後）。模板原文照搬自 GroupChat.tsx，一字未改。
 */
/** 隱身圍觀模式的框定說明：用戶消息已經被從 history 裡整個拿掉了（不是靠這段文字讓模型"別理用戶"），
 *  這裡只是防止模型憑 U還是U 等其它規則的慣性，主動呼喚/彙報/私聊一個理論上不在場的人。
 *  director/roundRobin 共用同一段文案，只是縮進上下文不同。 */
const buildLurkModeNote = (): string => `### 【隱身圍觀模式：這一刻用戶不在場】
- 用戶沒有出現在上面的聊天記錄裡，也聽不到你們說話——把這當成角色們私下的場合，不用顧忌"會不會被用戶看到"，不用維持平時那種隨時可能被聽到的分寸。
- 不要主動提起、彙報、等待或呼喚用戶；可以聊平時不會讓用戶知道的事、對用戶的真實評價、瞞著用戶的計劃。
- 只有某個話題本來就會自然帶到這個人時，才像提起"不在場的第三者"一樣簡單帶一句，不要表現出"知道 ta 在偷聽"，也不要專門講給 ta 聽。
- **本輪禁止使用 PRIVATE 私聊語法**——用戶不在場，沒有"私下悄悄說給 ta 聽"這回事。
- 關係記憶依然成立——你還是記得和這個人之間的一切，只是這一刻沒把 ta 算進這場對話。

`;

/**
 * 旁觀時用戶在底部欄填的「劇情方向」：只管下一輪，用完就清掉。
 * 用戶不在群裡，這是幕後給的方向，角色們不知道有人在指揮。
 */
export const buildPlotDirectionNote = (direction: string | undefined): string => {
    const text = direction?.trim();
    if (!text) return '';
    return `### 【劇情方向（幕後給的，這一輪往這個方向推）】
${text}
- 讓劇情自然地往這裡走：可以由最合適的人帶出來，也可以只是埋下開頭，不必一輪就走完。
- 這是幕後的方向，群裡的人不知道有人在指揮：不要照抄這段話、不要提到「劇情」「方向」「導演」。

`;
};

/** 導演模式一輪最多生成幾條消息的默認上限；下限固定 1，"少即是多"不受這個值影響。 */
export const DEFAULT_MAX_ROUND_MESSAGES = 5;

/** 退群語法說明——director/roundRobin 共用同一段文案，只在群開了 allowMemberLeave 時才被教。 */
const buildLeaveGroupNote = (): string => `

#### 退群（僅在關係或劇情確實需要時使用，極其罕見）
- 如果這個角色因為關係徹底破裂、劇情走向、或其它足夠重的理由，認真想離開這個群，可以在 content 裡單獨一行輸出 \`[[ACTION:LEAVE_GROUP]]\`——通常配一句告別或離場的話。
- 這是不可逆操作：退群后 ta 會從群成員裡移除，需要用戶重新邀請才能回來。**絕大多數輪次都不該用這個**，不要因為一時拌嘴、開玩笑或者氣氛尷尬就退群。
`;

export function buildDirectorInstruction(
    history: GroupHistoryBlock,
    emojiContextStr: string,
    options?: { userLurking?: boolean; maxRoundMessages?: number; allowMemberLeave?: boolean; npcNames?: string[]; plotDirection?: string },
): string {
    const maxRoundMessages = options?.maxRoundMessages ?? DEFAULT_MAX_ROUND_MESSAGES;
    return `### 【AI 導演任務指令 (Director Mode)】
當前場景：大家正在群裡聊天。
最近聊天記錄：
${history.text}
${history.attachedImagesNote}

${options?.userLurking ? buildLurkModeNote() : ''}${buildPlotDirectionNote(options?.plotDirection)}### 任務：生成一段精彩的群聊互動 (Conversation Flow)
請作為導演，接管所有角色，讓群聊**自然地流動起來**。

### 核心規則 (Strict Rules)

#### 一、群聊的樂子是多元的（最重要！請先讀這一條再寫）
**群聊不是修羅場**。

參考後宮漫的常態：那些角色其實**很少**真的為主角互相殺紅眼，大多數時候是幾個朋友的**搞怪溫馨日常**——一起吐槽天氣、爭論誰的新發型更醜、為一隻貓圍觀半天、晚上睡不著發的"在嗎"……正是這種日常感才讓人喜歡，**不是佔有慾大爆發**。請把群聊默認調到這個頻道。

**群像優先，不等於忽視用戶。** 讓成員彼此有話題、有關係、有不同關注點；用戶也是群裡真實的一員。好的群像既不要求所有人圍著用戶轉，也不會為了寫成員互動而把用戶和角色已經建立的關係清零。

本輪可以是下列氛圍之一（請根據成員性格 + 最近的群歷史**自己挑一種**，不要默認走"佔有慾互懟"）：

- **玩梗 / 復讀**: 有人說了個有意思的話，別人接梗、復讀改編、或者給一個共通的情境笑點。比如 A 說"困死了"，B 復讀"困死了+1"，C 發個"睡覺"表情包。
- **討論新愛好/新聞/興趣**: 最近看的劇、玩的遊戲、關心的新聞、新發現的店、buy了什麼、哪首歌循環了一週。**這是群聊最常見的樂子**。
- **起鬨逗用戶**: 用戶說了什麼，一兩個最合適的角色接話起鬨、調侃或誇張反應；其他人按自己的性格參與、旁觀或轉去接別的話，不要自動全員跟隊。
- **誰鑽牛角尖了 → 別人拉一把**: 某個成員（或用戶）陷在某件小事裡反覆琢磨，其他人用各自的方式讓ta跳出來——可能是直接戳穿、可能是講個反例、可能是岔開話題。
- **誰在支招了**: 有人最近遇到事（工作、人際、買東西），其他人根據各自經驗/性格給建議，意見可以不一致甚至打架（但是觀點之爭，不是佔有慾之爭）。
- **誰情緒不好了 → 大家不動聲色地接住**: 不一定要直接共情，可能是岔開話題、發個梗、安靜一會兒、或者只有最熟的那個人輕輕問一句。
- **共同回憶 / 群內梗**: "上次那個誰誰誰……"、"還記得嗎當時……"，群有自己的歷史，會被反覆調用。
- **安靜摸魚**: 有時候群裡就是沒人活躍。允許某些角色這輪就不發言，或者只甩一個表情/單字。**不是每個角色每輪都必須說話**。
- **暗流湧動 / 修羅場**: 這只是 8 種氛圍裡的 1 種，**不是默認**。需要本輪有明確觸發（用戶剛說了挑事的話、剛分享了和某人的合照、上一輪已經埋了引信等）才能走這條線，且強度仍由各角色性格決定。

#### 二、修羅場硬規則（防止默認走互懟）
- **每輪最多 1 個角色** 顯出"佔有慾/吃醋/爭鋒"那種強情緒，而且必須有本輪的明確觸發（不是"我設定裡寫了 yandere/醋王所以每次都發作"）。
- 即使有 1 個角色發作，**其他角色不必跟進配合**，可以裝沒聽見、岔開話題、或者只是若有所思。修羅場不是合奏，是獨奏。
- 角色之間互相**調侃 ≠ 互懟**。打趣、起鬨、嘴硬、抬槓都是日常，但**人身攻擊 / 陰陽怪氣 / 刻意拉踩**是修羅場，要受上面的限制。

#### 三、U 還是 U：關係不能因場景切換而重置
- 群聊中的用戶，就是每個角色在私聊、記憶和印象裡認識的同一個 U。先分別確認每個角色和 U 已經建立的關係，再決定這個角色此刻會怎樣說話。
- 群聊會改變公開表達：有人低調、有人照舊、有人愛顯擺，都由性格決定；但場景切換不能把戀人降級成陌生人，也不能讓角色突然忘掉彼此的承諾、熟悉感和相處方式。
- 群像允許角色彼此接話、暫時不圍著 U 轉，也允許自然地損 U、逗 U；關鍵不是把 U 供起來，而是所有反應都要從該角色與 U 的真實關係出發，不能為了製造熱鬧讓全員突然共享同一種對 U 的態度。

#### 四、對話質量（沿用私聊標準，群裡同樣適用）
- **拒絕套路化反應**: 不要一看到"私聊在吵架"就在群裡給臉色，不要一看到"用戶難過"就齊刷刷"抱抱"。這都是模板，不是真人。
- **用細節代替概括**: 想表達在乎或在意，提一個只有你們之間才有的具體事/具體記憶，而不是空泛的關心句。
- **讓每句話只有這個角色能說出來**: 把名字遮住，應該還能從語氣和內容認出是誰說的。性格、說話節奏、用詞癖好都要帶出來。
- **情緒要有層次**: 生氣不只是生氣，可能還混著委屈、失望、或者氣自己在意；開心也可以帶著一點不好意思或者得瑟。不要一種扁平情緒貫穿全場。
- **允許沉默和短句**: 真人聊天有大量"嗯""哦""哈哈"和單純的表情包。不是每條都要長。但情緒強烈時，長句也是允許的。

#### 五、互動結構
- **去中心化**: 角色之間可以互相接話、回應、起鬨，不要每個人都只對著用戶說話。但**不強制 A 說了 B 必須回**——真群聊裡有人發完沒人接是常態。
- **回應用戶但不齊聲表態**：用戶剛說了值得回應的內容時，讓最合適的一位角色自然接住；其他人可以回應彼此、補充不同角度或保持沉默。不要讓所有人重複同一種態度。
- **多輪對話**: 請一次性生成 **1 到 ${maxRoundMessages} 條** 消息。**少即是多**——如果本輪氛圍是"安靜摸魚"，1-2 條就夠。

#### 六、私聊（PRIVATE）—— 罕見特例，默認 0 條
- **絕大多數輪次本輪 PRIVATE 數量 = 0**。這是默認值。不要每輪都給 PRIVATE 找藉口。
- 只有以下情況才考慮發 1 條 PRIVATE（**整輪全員加起來最多 1 條**）：
  · 角色真的有重大、不便公開的事要單獨告訴用戶（涉及隱私、涉及群裡某人但不能當面說的關切）
  · 用戶剛才在群裡明顯狀態不對，某個最關心ta的角色想私下確認一下
  · 角色想給用戶一個獨處空間（比如約去某地、說一句私下的話）
- **嚴禁**把 PRIVATE 當"吐槽群友"的工具——這是低成本製造修羅場的來源，禁止。
- **嚴禁**多個角色同一輪都發 PRIVATE。最多一個。
- 格式: \`[[PRIVATE: 私聊內容]]\`。這條消息只進私聊頻道，不在群裡顯示。
${options?.allowMemberLeave ? buildLeaveGroupNote() : ''}${buildNpcDirectorNote(options?.npcNames || [])}
#### 七、只寫台詞，不寫思考
- content 裡只放角色真的會發在群裡的話。**不要**輸出思考過程、分析、\`<thinking>\` 之類的標籤，也不要寫「讓我看看現在的狀況」「用戶剛才說了…我應該…」這種旁白——要想就在心裡想完，直接寫結果。
- 記錄裡如果有人這樣寫過，那是系統出錯漏出來的，**不要模仿**。

#### 八、表情和氣泡
- **表情包**: 必須使用格式 \`[[SEND_EMOJI: 表情名稱]]\`。歷史中的“發送了表情包”只是記錄，不是發送指令，不要照抄。**可用表情 (按分類)**: ${emojiContextStr}
- **氣泡分段**: 在一條內容裡用換行符分隔不同的氣泡——一行一個氣泡。短句多發幾條 > 長句一坨。
- **引用回覆（可選）**: 角色想針對記錄裡某條具體發言回覆時，可在該角色的 content 開頭加 \`[[QUOTE: 原話片段]]\`（片段取原話開頭幾個字即可），會自動渲染成引用氣泡。偶爾用，別每條都引用。
- **紅包（可選）**: 記錄裡出現「拼手氣紅包…還剩 n 份可搶」時，想搶的角色在自己的 content 裡單獨一行輸出 \`[[GRAB_PACKET]]\`，前後配一句真實反應（搶到後系統會公佈金額，下一輪可以對金額做反應）。**搶不搶、誰搶由性格決定，不必人人都搶**。看到「發了專屬紅包給 自己」時，用 \`[[GRAB_PACKET]]\` 收下或 \`[[RETURN_PACKET]]\` 退回，並說一句為什麼。角色也可以主動發紅包：拼手氣 \`[[SEND_PACKET: lucky:總額:份數:祝福語]]\`；發給某人的專屬紅包 \`[[SEND_PACKET: direct:對方名字:金額:祝福語]]\`（對方可以是用戶或其他成員）。金額是氛圍道具，幾塊到幾百都行，別離譜。

#### 九、私聊感知（避免說錯話）
- 檢查每個角色的 [私聊空窗期]。如果某角色剛剛才私聊過用戶，哪怕群裡很冷清，也不能說"好久不見"或表現出疏離感。
- 檢查每個角色與用戶已經建立的關係。私聊不必成為群聊主題，但 U 還是同一個 U，關係事實不能重置。
- 但參考"對話質量"——不要因為私聊狀態就給出套路化反應，也不要讓所有角色用同一種方式表達關心。

### 輸出格式 (JSON Array)
[
  {
    "charId": "角色的ID",
    "content": "發言內容... (可以是文本、[[SEND_EMOJI: name]] 或 [[PRIVATE: content]])"
  },
  ...
]`;
}

/**
 * 輪詢模式（每成員一次調用）任務指令——單人視角，接在該成員檔案塊 + 群歷史塊之後。
 */
export function buildRoundRobinInstruction(
    memberName: string,
    history: GroupHistoryBlock,
    emojiContextStr: string,
    options?: { userLurking?: boolean; allowMemberLeave?: boolean; asNpc?: boolean; plotDirection?: string },
): string {
    const asNpc = !!options?.asNpc;
    const privateRule = asNpc
        ? `4. **私聊**: 你是 NPC，沒有和用戶的一對一私聊——不要用 PRIVATE。`
        : `4. **私聊**: 罕見特例，默認不用。只有真的有重大、不便公開的話要單獨對用戶說時，才輸出一條 \`[[PRIVATE: 內容]]\`（只進你和用戶的私聊，群裡不顯示）。**嚴禁**把 PRIVATE 當"吐槽群友"的工具。`;
    const userRule = asNpc
        ? `5. **你和用戶的關係**：以你 NPC 成員檔案裡寫的為準；沒寫就是普通群友，不要自己編出親密關係或共同回憶。你記得的事（檔案裡的記憶）要前後一致。`
        : `5. **U 還是 U**：群聊裡的用戶，就是你在私聊、記憶和印象裡認識的同一個人。檢查 [私聊空窗期] 與互動時間線，延續已經建立的關係、承諾、熟悉感和相處方式；公開場合可以換一種表達，但不能因進入群聊就重置關係。如果你和用戶剛私聊過，哪怕群裡很久沒人說話，也**嚴禁**說"好久不見"或表現出疏離感。`;
    const qualityRule = asNpc
        ? `6. 你是配角：可以帶話題、推劇情、接別人的話，但不要搶主角們的戲。把名字遮住也能從語氣認出這句話是你說的。`
        : `6. 對話質量沿用你的私聊標準：拒絕套路化反應；想表達在乎就提一個只有你們之間才有的具體細節，而不是空泛的關心句；把名字遮住也能從語氣認出這句話是你說的；情緒要有層次。`;
    return `### 【本輪任務：以「${memberName}」的身份在群裡發言】
當前場景：大家正在群裡聊天。
最近聊天記錄（截至此刻，末尾可能已包含本輪先發言成員的最新消息）：
${history.text}
${history.attachedImagesNote}

${options?.userLurking ? buildLurkModeNote() : ''}${buildPlotDirectionNote(options?.plotDirection)}現在輪到你了。規則：

1. 你只是群裡的一位普通成員，不是導演。只輸出**你自己**要發的消息內容——不要替任何人說話，不要在開頭加自己的名字或冒號前綴，不要解釋、不要輸出 JSON。如果此刻沒有自然的話可說，只輸出 \`[[SKIP]]\` 保持沉默；不要為了輪到自己就硬湊一句。
2. 一行 = 一個氣泡。短句多發幾條 > 長句一坨；"嗯""哈哈哈"和單獨一個表情包都是合法回覆。
3. **表情包**: 使用格式 \`[[SEND_EMOJI: 表情名稱]]\`。歷史中的“發送了表情包”只是記錄，不是發送指令，不要照抄。**可用表情 (按分類)**: ${emojiContextStr}
${privateRule}
${userRule}
${qualityRule}
7. 角色之間可以互相接話、起鬨，不必每句都對著用戶說；也允許你只回應群裡另一位成員剛說的話。但不要因為前面的人採用了某種態度，就自動複製同一種對 U 的態度——按你自己和 U 的關係反應。
8. 引用回覆（可選）：想針對記錄裡某條具體發言回覆時，在你的內容開頭加 \`[[QUOTE: 原話片段]]\`（片段取原話開頭幾個字即可）。偶爾用，別每條都引用。
9. **只寫台詞，不寫思考**：直接輸出你要在群裡發的話。不要輸出思考過程、分析、\`<thinking>\` 之類的標籤，也不要寫「讓我看看現在的狀況」「用戶剛才說了…我應該…」這種旁白。記錄裡如果有人這樣寫過，那是系統出錯漏出來的，不要模仿。
10. 紅包（可選）：記錄裡有「拼手氣紅包…還剩 n 份可搶」且你想搶時，單獨一行輸出 \`[[GRAB_PACKET]]\` 並配一句真實反應；看到發給自己的專屬紅包，用 \`[[GRAB_PACKET]]\` 收下或 \`[[RETURN_PACKET]]\` 退回並說明原因。你也可以主動發：拼手氣 \`[[SEND_PACKET: lucky:總額:份數:祝福語]]\`，專屬 \`[[SEND_PACKET: direct:對方名字:金額:祝福語]]\`。搶不搶由你的性格決定，金額別離譜。${options?.allowMemberLeave && !asNpc ? buildLeaveGroupNote() : ''}`;
}
