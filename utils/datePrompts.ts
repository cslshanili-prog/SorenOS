/**
 * 見面（DateApp）提示詞統一構造器
 *
 * 與聊天側 chatRequestPayload.ts 同構：peek（感知開場）/ send / reroll 三條路徑
 * 都從這裡拿完整的 messages 數組，DateApp 組件只負責 UI 狀態和 fetch。
 *
 * 與聊天側注入面的差異（刻意為之，不是漏配）：
 *   - 注入：ContextBuilder.buildCoreContext 全量（人設 / 世界書 / 印象 / 記憶 /
 *     記憶宮殿召回 / 情緒 buff）+ 當前虛擬時間。世界書和聊天同一套規則：關鍵詞條目掃
 *     最近的歷史和本輪輸入來觸發，「聊天記錄指定深度」的條目按深度插進對話
 *     （見 withWorldbookDepthEntries）。
 *   - 不注入：聊天 App 行為規範（IM 氣泡 / 表情包 / 語音 / 引用 / 轉帳 / 小紅書 /
 *     日記等工具塊）——這些是線上聊天專屬指令，面對面場景裡輸出會破壞散文格式。
 *   - 不注入：實時天氣 / 新聞、群聊背景、Notion / 飛書日記標題——見面是高沉浸短會話，
 *     這些背景塊收益低，還會稀釋格式指令的權重。
 *   - 日程 / 音樂氛圍目前也不進見面場景；以後要加請在這裡統一加，別在組件裡散拼。
 *
 * 歷史構建統一複用 ChatPrompts.buildMessageHistory：html_card / score_card /
 * chat_forward / emoji 等都會被壓成短摘要，不會把原始 HTML / JSON / URL 塞進
 * prompt（peek 舊版手搓 mapper 的問題即在此，已統一修掉）。
 */

import { applyClockToHistory, describeClockNote, type DateClock } from './dateStoryTime';
import { buildDateInputPerceptionRule, formatDateUserInput, spokenPartOfDateInput } from './dateUserInput';
import { buildLengthLine, buildScenarioBlock } from './dateExtras';
import { CharacterProfile, UserProfile, Message, Emoji, DateStyleConfig } from '../types';
import { buildBlockedMeetingNote } from './chatBlock';
import { ContextBuilder } from './context';
import { ChatPrompts } from './chatPrompts';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { resolveCharTimeZone, nowInTimeZone } from './timezone';
import { getVoicePromptOverride } from './ttsProvider';
import { selectCharacterContextMessages } from './chatContextRange';
import { buildTriggeredLinesPrompt } from './fixedLines';
import { injectWorldbookDepthEntries, resolveWorldbookDepthEntries, type WorldbookScanMessage } from './worldbook';

export type ApiMessage = { role: string; content: any };

/**
 * 見面（DateApp）台詞的語氣標籤規則（char.dateVoiceEnabled 時注入）。
 * 每句台詞開頭一個英文方括號標籤；送去 TTS 前按服務商保留、轉成情緒參數或剝掉（utils/dateVoiceTags.ts），
 * 所以這裡不分服務商，統一一種寫法。開頭編號 4. 是承接散文格式規則第 1~3 條。
 * 用戶可在「設置 → 其他 API → 語音提示詞」自定義；留空則用這份內置默認。舊版自定義的 [v:xxx] 寫法照樣認得。
 */
export const DATE_VOICE_GUIDE = `4. **台詞的語氣標籤**：台詞會被朗讀成真實語音。每一句台詞開頭加一個英文方括號標籤，寫這句話用什麼語氣、什麼聲音說，例如 \`[softly]\`、\`[lazy]\`、\`[teasing]\`、\`[chuckles]\`、\`[whispers]\`、\`[sighs]\`；也可以用 \`[happy]\`、\`[sad]\`、\`[angry]\`、\`[calm]\` 這類情緒詞。
   - 只有台詞加，旁白和動作行不加。標籤用英文單字或短語，一句最多兩個，不要自造中文標籤。
   - 例：\`[teasing] 「你再遲到一分鐘，這杯就歸我了。」\``;

/**
 * 注入 prompt 的當前時間，直接取真實系統時間（完整日期 + 星期 + 時分）。
 * 不要從 OSContext 的 virtualTime 取——那個名字唬人，實際也是每秒同步的真實
 * 時間，但只有"星期 + 時:分"，缺日期，而且沒必要讓 prompt 構建依賴 React 狀態。
 */
const getRealTimeStr = (tz?: string, at: number = Date.now()): string => {
    // formatDate 自己會按 tz 折算，所以這裡要喂真實時刻（故事時鐘換算過的也是絕對時刻）。
    // nowInTimeZone 返回的 Date 是「本地 getter 讀出來正好是角色牆上時間」的形式，
    // 它的絕對時間戳已經被挪過一次——再交給 formatDate 就會多減一個時差。
    const realNow = at;
    const wallClock = nowInTimeZone(tz, new Date(realNow));
    const days = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    return `${ChatPrompts.formatDate(realNow, tz)} ${days[wallClock.getDay()]}`;
};

/** 線下時間感知開關：默認開啟，顯式關掉後見面 prompt 不再注入時間。 */
const isDateTimeAwarenessOn = (char: CharacterProfile): boolean =>
    char.dateTimeAwarenessEnabled !== false;

// ─────────────────────────────────────────────────────────────
// 寫作風格預設（DateSettings 面板與 prompt 構建共用同一份，別兩邊手抄）
// ─────────────────────────────────────────────────────────────

export interface DateStylePreset {
    id: string;
    label: string;
    /** 設置面板裡給用戶看的一句話簡介 */
    hint: string;
    /** 見面系統提示裡的完整風格塊（「動作與敘述行的寫法」段落） */
    block: string;
    /** peek（感知開場）「描寫風格」一行用的短語 */
    peekHint: string;
}

export const DATE_STYLE_PRESETS: DateStylePreset[] = [
    {
        id: 'cinematic',
        label: '電影感',
        hint: '默認風格。沉浸式鏡頭感，感官細節豐富，有呼吸和停頓。',
        peekHint: '電影感，沉浸式，細節豐富',
        block: `### ⭐ 動作與敘述行的寫法（風格：電影感）
你不是在列清單，你是在寫一個正在發生的場景。每一行動作/敘述都應該讓人感受到**此時此刻的空氣**。

**具體要求**：
- 寫出**感官**：光線怎麼落的、空氣什麼味道、皮膚什麼觸感、周圍什麼聲音
- 寫出**節奏**：動作之間有停頓、有猶豫、有呼吸，不要一口氣做完三個動作
- 寫出**情緒的痕跡**：不要說"他很緊張"，而是寫他的手指在桌面上畫了一道看不見的線
- 讓每一行都有**畫面**，像電影裡的一個鏡頭

❌ **不要這樣寫**（乾巴巴的動作羅列）：
把手放下，看向你。
走到你身邊，坐下來。
拿起杯子，喝了一口水。

✅ **要這樣寫**（有畫面、有停頓的敘述）：
指尖從髮梢滑落，垂在身側。視線轉過來的時候並不急，像是剛好、又像是故意。
"……你一直在看我嗎？"
嘴角的弧度藏不住，像是被戳中了什麼小心思。
腳步踩在木地板上的聲音很輕。在你旁邊坐下來，衣料帶過一縷還沒散盡的冷風。`,
    },
    {
        id: 'plain',
        label: '簡潔白描',
        hint: '短句克制，不堆形容詞，動作乾淨，靠留白說話。',
        peekHint: '簡潔白描，短句克制，多留白',
        block: `### ⭐ 動作與敘述行的寫法（風格：簡潔白描）
用最少的字寫最準的動作。短句，克制，不堆形容詞，不濫用比喻。

**具體要求**：
- 一行只做一件事，動作乾淨利落
- 情緒藏在"做了什麼/沒做什麼"的選擇裡，不點破、不渲染
- 善用留白：話說一半，停下來，讓沉默自己說話

❌ **不要**：堆砌華麗辭藻、一行塞三個動作、直接寫"他很開心/緊張"。
✅ **示例**：
放下杯子。
"來了。"
視線挪開，落在窗外。`,
    },
    {
        id: 'lyrical',
        label: '細膩文藝',
        hint: '綿密溫柔，心理與感官交織，可用比喻和意象。',
        peekHint: '細膩文藝，感官與心理交織，意象貼合情緒',
        block: `### ⭐ 動作與敘述行的寫法（風格：細膩文藝）
綿密、溫柔、向內。心理活動和感官交織，可以用比喻和意象，但必須貼合此刻的情緒，不為修辭而修辭。

**具體要求**：
- 寫光線、溫度、氣味這些容易被忽略的細節
- 動作之外，寫動作背後那一層沒說出口的心事
- 允許長句，但每一行仍只承載一個情緒節拍

✅ **示例**：
茶杯沿上的熱氣慢慢散了，像一句沒說完就被收回去的話。
"……今天的風，把人吹得有點想說實話。"
指尖在桌面輕輕敲了兩下，藏不住的雀躍順著指節漏出來。`,
    },
    {
        id: 'playful',
        label: '輕快幽默',
        hint: '節奏明快，生活化，帶點俏皮和小吐槽。',
        peekHint: '輕快幽默，生活化，帶點俏皮',
        block: `### ⭐ 動作與敘述行的寫法（風格：輕快幽默）
節奏明快，生活化，像情景喜劇的分鏡，不端著。

**具體要求**：
- 動作可以誇張一點點，但要可愛不要鬧劇
- 台詞口語化，可以打趣、抬槓、自我吐槽
- 幽默來自細節和反差，不是硬講笑話

✅ **示例**：
叼著吸管，含糊不清地比了個"過來"的手勢。
"你再遲到一分鐘，這杯奶茶裡的珍珠就要被我替你報仇了。"
說完自己先沒繃住，耳朵尖紅了一點。`,
    },
    {
        id: 'intense',
        label: '濃烈熾熱',
        hint: '情緒張力拉滿，呼吸、心跳、距離感，克制邊緣的爆發。',
        peekHint: '張力濃烈，感官衝擊具體，空氣繃緊',
        block: `### ⭐ 動作與敘述行的寫法（風格：濃烈熾熱）
情緒張力拉滿。呼吸、心跳、距離感，每一行都往前壓一步。

**具體要求**：
- 感官衝擊要具體：溫度、力度、停在半空的手
- 沉默和對視也是戲，寫出空氣繃緊的感覺
- 濃烈不等於直白嘶吼，克制邊緣的爆發更有力量

✅ **示例**：
一步，又一步。影子先碰到了你的影子。
"剛才那句話，再說一遍。"
呼吸在離得很近的地方，亂了半拍。`,
    },
];

const DEFAULT_STYLE_ID = 'cinematic';

const getStylePreset = (config?: DateStyleConfig): DateStylePreset =>
    DATE_STYLE_PRESETS.find(p => p.id === (config?.style || DEFAULT_STYLE_ID)) || DATE_STYLE_PRESETS[0];

/**
 * 敘事人稱塊。pov 未設置時返回空串（不注入，沿用模型默認寫法）。
 * 放在風格塊之後：風格示例裡的人稱只是格式示意，以本節為準（塊內已註明）。
 */
const buildPovBlock = (config: DateStyleConfig | undefined, charName: string, userName: string): string => {
    const uname = userName || '對方';
    switch (config?.pov) {
        case 'third-name':
            return `### 敘事人稱（必須嚴格遵守）
敘述行使用**第三人稱**：稱呼你自己為「${charName}」，稱呼對方為「${uname}」。敘述裡不要出現"我""你"。
示例：${charName}看向${uname}，把手邊的書合上。
（台詞引號內不受限，正常說話即可。上方風格示例中的人稱僅為格式示意，一律以本節為準。）
`;
        case 'third-you':
            return `### 敘事人稱（必須嚴格遵守）
敘述行中稱呼你自己為「${charName}」（第三人稱），稱呼對方為"你"。敘述裡不要用"我"指代自己。
示例：${charName}看向你，把手邊的書合上。
（台詞引號內不受限，正常說話即可。上方風格示例中的人稱僅為格式示意，一律以本節為準。）
`;
        case 'first-you':
            return `### 敘事人稱（必須嚴格遵守）
敘述行使用**第一人稱**：稱呼你自己為"我"，稱呼對方為"你"。不要在敘述裡用自己的名字指代自己。
示例：我看向你，把手邊的書合上。
（上方風格示例中的人稱僅為格式示意，一律以本節為準。）
`;
        default:
            return '';
    }
};

/** 自定義補充文風要求塊。為空時不注入。 */
const buildExtraStyleBlock = (config?: DateStyleConfig): string => {
    const extra = (config?.extra || '').trim();
    if (!extra) return '';
    return `### 用戶對文風的額外要求（優先級高於風格預設）
${extra}
`;
};

// ─────────────────────────────────────────────────────────────
// 細節深挖（反"模型八股"的正向方案）
//
// 各家模型都有自己的高頻套話（"極其""不是X而是Y"之類），但靜態黑名單治不了：
// 一是每家八股不同打不完，二是把禁語寫進提示詞反而會激活它（粉色大象效應）。
// 這裡走正向路線：八股是"沒話找話"時的填充物，所以教模型怎麼從任意輸入裡
// 挖到具體素材（常駐方法塊），並每輪隨機注入一條聚焦線索（輪換的注意力方向
// 讓相鄰回覆天然有差異，上下文自我模仿的雪球滾不起來）。全程不提任何禁語。
// ─────────────────────────────────────────────────────────────

const isDigDeeperOn = (config?: DateStyleConfig): boolean => config?.digDeeper !== false;

const DIG_DEEPER_BLOCK = `### 💎 素材永遠比你以為的多（深挖，別填充）
對方哪怕隨口一句話，都至少藏著這些可以接的線：
1. **ta的用詞**——為什麼是這個詞？換個人不會這麼說。
2. **ta怎麼說的**——語速、音量、說話時手在幹什麼、眼睛看哪。
3. **ta沒說的**——這句話省略了什麼？和ta平時的樣子比，哪裡不一樣？
4. **現場**——此刻的光線、聲音、桌上的東西，隨便一樣都能參與進互動。
5. **你們的過去**——這句話讓你想起哪件只有你們知道的事？
6. **你自己**——它在你心裡激起的第一反應是什麼？你壓下去了，還是說了出來？

比如對方只說了句"有點累"，能接的就有：累的是身體還是別的；ta說這話時把包放下的動作；你上次見ta累成這樣是什麼時候；要不要把窗邊那杯還溫著的水推過去。

規則：
- 每一輪只挑**一兩條線**往深處走，寫透它。不要每條都碰——什麼都寫等於什麼都沒寫。
- 覺得"沒什麼可寫"的時候，恰恰說明該回到上面的清單裡找。空泛的感慨和萬能句式都是沒話找話，寧可寫一個具體的小動作。
`;

/** 每輪隨機注入一條，把注意力推向不同的具體方向；reroll 時另抽一條換切入角度 */
export const DIG_FOCUS_HINTS = [
    '從對方剛才的用詞裡挑一個詞，作為這一輪回應的起點',
    '讓場景裡的一件具體物品參與到這一輪互動裡',
    '寫一個克制的身體細節——距離、姿態、或一個沒完成的動作',
    '把對方這句話和你們的一段過去連起來（只有你們知道的事）',
    '這一輪重點回應對方"怎麼說"而不是"說了什麼"——語氣、停頓、視線',
    '寫一個你心裡閃過但沒說出口的念頭，讓它影響你的下一句話',
    '留意對方沒說出口的部分，回應那個空白',
    '讓此刻的環境（光線、聲音、溫度）影響你說話的方式',
];

const pickFocusHint = (): string =>
    DIG_FOCUS_HINTS[Math.floor(Math.random() * DIG_FOCUS_HINTS.length)];

/**
 * 見面側的時間間隔提示。與 ChatPrompts.getTimeGapHint（IM 風格文案）刻意分開：
 * 這裡的措辭面向"多久沒見面/互動"的場景判斷，不是"多久沒回消息"。
 */
const getTimeGapHint = (lastMsgTimestamp: number | undefined, tz?: string): string => {
    if (!lastMsgTimestamp) return '這是你們的初次互動。';
    const now = Date.now();
    const diffMs = now - lastMsgTimestamp;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const currentHour = nowInTimeZone(tz).getHours();
    const isNight = currentHour >= 23 || currentHour <= 6;

    if (diffMins < 5) return '';
    if (diffMins < 60) return `[系統提示: 距離上次互動: ${diffMins} 分鐘。]`;
    if (diffHours < 6) {
        if (isNight) return `[系統提示: 距離上次互動: ${diffHours} 小時。現在是深夜/清晨。]`;
        return `[系統提示: 距離上次互動: ${diffHours} 小時。]`;
    }
    if (diffHours < 24) return `[系統提示: 距離上次互動: ${diffHours} 小時。]`;
    const days = Math.floor(diffHours / 24);
    return `[系統提示: 距離上次互動: ${days} 天。]`;
};

/**
 * 把 buildMessageHistory 的結構化輸出壓平成純文本（peek 的 [最近記錄] 塊用）。
 * 圖片消息的 image_url 部分丟棄，只保留文字佔位（peek 不需要看圖）。
 */
const flattenHistoryToText = (apiMessages: ApiMessage[]): string =>
    apiMessages.map(m => {
        const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ')
                : '';
        return `${m.role}: ${text}`;
    }).join('\n');

/**
 * 把「聊天記錄指定深度」的世界書條目插進對話，規則與聊天側（chatRequestPayload）一致：
 * 深度從對話末尾往回數，深度 0 放在最後，深度 N 插在倒數第 N 條消息之前。
 * 其餘位置的條目由 buildCoreContext 放進 system prompt，這裡只管深度條目。
 */
const withWorldbookDepthEntries = (
    conversation: ApiMessage[],
    char: CharacterProfile,
    userName: string,
    scanMessages: WorldbookScanMessage[],
): ApiMessage[] => injectWorldbookDepthEntries(
    conversation,
    resolveWorldbookDepthEntries(char.mountedWorldbooks || [], scanMessages, char.name, userName),
);

/**
 * 見面系統提示（send 與 reroll 共用同一份，避免兩處手抄漂移）。
 * reroll 的差異只體現在末尾 user 消息的 System Note 裡，不在這裡分叉。
 * 風格 / 人稱 / 自定義補充按 char.dateStyleConfig 動態拼裝。
 */
const buildMeetingProseBlock = (char: CharacterProfile, userName: string, recap = '', clock: DateClock | null = null): string => {
    const dateTimeOn = isDateTimeAwarenessOn(char);
    const timeLine = !dateTimeOn ? ''
        : clock
            ? `1. **Time**: 當前時間 ${getRealTimeStr(resolveCharTimeZone(char), clock.now)}。${describeClockNote(clock)}\n`
            : `1. **Time**: 當前時間 ${getRealTimeStr(resolveCharTimeZone(char))}。\n`;
    const styleConfig = char.dateStyleConfig;
    const preset = getStylePreset(styleConfig);
    const povBlock = buildPovBlock(styleConfig, char.name, userName);
    const extraBlock = buildExtraStyleBlock(styleConfig);
    const digBlock = isDigDeeperOn(styleConfig) ? `${DIG_DEEPER_BLOCK}\n` : '';
    return `### [面對面見面 · 散文敘事]
你正在與用戶進行**面對面**的互動。這不是聊天，是一場真實的見面。用小說式的散文寫，旁白、動作和台詞交織。

### 格式
1. **台詞單獨成行**：同一行裡不要既寫動作又寫台詞。
2. **台詞用引號**：說出口的話用「」或 "" 包起來；動作和敘述直接寫，不加引號。
3. **不加任何前綴**：不要在行首標情緒、標說話人。
${char.dateVoiceEnabled ? (getVoicePromptOverride('dateVoice') ?? DATE_VOICE_GUIDE) : ''}

${preset.block}

${digBlock}${povBlock}${extraBlock}${buildDateInputPerceptionRule(userName || '對方')}
${buildScenarioBlock(char, userName)}${recap}${buildLengthLine(char)}### 場景上下文
${timeLine}- **Location**: 你們現在**面對面**。
- **Context**: 參考歷史記錄。如果剛剛才看到開場白（Opening），請自然接話。
${buildBlockedMeetingNote(char, userName)}`;
};

/**
 * 歷史構建（send / reroll 共用）：
 * 1. 與其他 AI 入口共用自適應 / 手動範圍及用戶起點。調用方先讀取有效窗口。
 * 2. 複用 ChatPrompts.buildMessageHistory 壓縮各類卡片。
 * 3. 排除最後一條（待重發的 user msg），由調用方單獨追加帶 System Note 的版本。
 */
export const buildDateHistory = (
    allMsgs: Message[],
    char: CharacterProfile,
    userProfile: UserProfile | null | undefined,
    emojis: Emoji[],
    useVisionDescriptions: boolean = false,
    /** 故事時鐘（utils/dateStoryTime.ts）：這場故事的訊息時間換成故事裡的 */
    clock: DateClock | null = null,
): ApiMessage[] => {
    const timed = applyClockToHistory(allMsgs, char, clock);
    allMsgs = timed.messages;
    char = timed.char;
    const selected = selectCharacterContextMessages(allMsgs, char);
    const pendingId = allMsgs[allMsgs.length - 1]?.id;
    // 見面裡用戶以前說的話也按引號標好「說出口的／旁白」（utils/dateUserInput.ts）；私聊、通話的不動
    const historyForBuild = selected
        .filter(message => message.id !== pendingId)
        .map(message => (message.role === 'user' && message.type === 'text' && message.metadata?.source === 'date' && typeof message.content === 'string'
            ? { ...message, content: formatDateUserInput(message.content) }
            : message));
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        historyForBuild,
        Math.max(1, historyForBuild.length),
        char,
        userProfile || ({} as UserProfile),
        emojis,
        undefined,
        { useVisionDescriptions },
    );
    return apiMessages;
};

export type DateOpeningMode = 'approach' | 'invite';
/** 從角色的見面邀請卡赴約時的約定（utils/dateInvite.ts 的 place / plan）。 */
export interface DateMeetup { place?: string; plan?: string }

/** 赴約開場：把約好的地點和要做的事寫明，開場直接接上這個約。兩欄都空就不寫。 */
const buildMeetupLine = (meetup: DateMeetup | undefined, charName: string, uname: string, invite: boolean): string => {
    const place = meetup?.place?.trim();
    const plan = meetup?.plan?.trim();
    if (!place && !plan) return '';
    const what = [place ? `地點是「${place}」` : '', plan ? `打算「${plan}」` : ''].filter(Boolean).join('，');
    return invite
        ? `\n這次見面是赴${charName}自己發出的邀約：${what}。${uname}已經答應了；寫${charName}怎麼來接${uname}、或怎麼一起往那裡去。\n`
        : `\n這次見面是赴${charName}自己發出的邀約：${what}。${uname}已經答應、正往那裡去；${charName}此刻在約好的地方（或正在趕過去），寫${charName}在那裡的樣子。\n`;
};

/**
 * 用自訂預設時，開場也照預設跑（buildMeetingPresetPayload）：這段當成這一輪的「用戶輸入」送，
 * 只講這一則是開場、誰怎麼出場；文風、格式、結構都交給預設。
 */
export const buildDateOpeningInstruction = (input: {
    charName: string;
    userName: string;
    openingMode?: DateOpeningMode;
    meetup?: DateMeetup;
}): string => {
    const uname = input.userName || '對方';
    const invite = input.openingMode === 'invite';
    const task = invite
        ? `由${input.charName}主動以合理的方式去見${uname}：寫${input.charName}怎麼來到${uname}面前、開口說什麼，停在留給${uname}回應的地方。${uname}怎麼反應、說什麼，都不要替${uname}寫。`
        : `${uname}正要走近${input.charName}所在的地方：寫${input.charName}此刻在做什麼、周圍的環境和狀態，停在${uname}出現之前或剛出現的時候，不要替${uname}說話或做決定。`;
    return [
        '（這一則是這場見面的開場，不是回覆。）',
        task,
        buildMeetupLine(input.meetup, input.charName, uname, invite).trim(),
        '照預設要求的格式和結構輸出。',
    ].filter(Boolean).join('\n');
};

export const DatePrompts = {
    getTimeGapHint,

    /**
     * Peek（感知開場）：用戶"悄悄靠近"前，讓 LLM 第三人稱描寫角色當下的狀態。
     * 歷史以純文本塊塞進 user 消息（保持"你不在和用戶對話"的框定），
     * 但文本本身來自 buildMessageHistory，卡片/媒體已壓成短摘要。
     */
    buildPeekPayload: (input: {
        char: CharacterProfile;
        userProfile: UserProfile;
        allMsgs: Message[];
        emojis: Emoji[];
        useVisionDescriptions?: boolean;
        /** 開場方式：'approach' = 用戶悄悄靠近（默認）；'invite' = 角色主動來找用戶（2026-10-12，參考上游 c523c752）。 */
        openingMode?: DateOpeningMode;
        /** 從邀請卡赴約時帶上約定的地點和要做的事。 */
        meetup?: DateMeetup;
        /** 故事時鐘（utils/dateStoryTime.ts）；真實＋流動是 null */
        clock?: DateClock | null;
    }): { messages: ApiMessage[] } => {
        const clock = input.clock ?? null;
        // 故事時鐘：這場的訊息時間換成故事裡的，「距離上次多久」不算（兩把尺混著算是亂的）
        const timed = applyClockToHistory(input.allMsgs, input.char, clock);
        const { userProfile, emojis } = input;
        const char = timed.char;
        const allMsgs = timed.messages;
        const invite = input.openingMode === 'invite';
        const uname = userProfile?.name || '對方';
        const charTz = resolveCharTimeZone(char);
        const dateTimeOn = isDateTimeAwarenessOn(char);
        const timeStr = getRealTimeStr(charTz, clock?.now);
        const selected = selectCharacterContextMessages(allMsgs, char);
        // 取時間戳最晚的那則，不是排最後的那則：訊息照自增 id 排，時間戳不一定單調（雲端補收的舊訊息
        // 會帶著當初的送出時間落在最後面），只看最後一則會把兩個月前那則當成「上次互動」。
        const lastTs = allMsgs.reduce<number | undefined>(
            (max, m) => (typeof m.timestamp === 'number' && (max === undefined || m.timestamp > max) ? m.timestamp : max),
            undefined,
        );
        // 故事時鐘不是現實的話，下面的分隔線和「時間上下文」都不用它（兩把尺混著算是亂的）
        const gapHint = getTimeGapHint(lastTs, charTz);

        const { apiMessages } = ChatPrompts.buildMessageHistory(
            selected,
            Math.max(1, selected.length),
            char,
            userProfile || ({} as UserProfile),
            emojis,
            undefined,
            { useVisionDescriptions: input.useVisionDescriptions === true },
        );
        const recentMsgs = flattenHistoryToText(apiMessages);

        // 線下時間感知關掉 → 抑制 buildCoreContext 的時間注入，讓見面真正脫離現實時間線（純架空）
        // conversational 不給：peek 是「用戶還沒走過去」的第三人稱鏡頭，時間塊末尾那句
        // 語境框定說的是「對方還在跟你說話」，跟這裡的框定正好相反（見下面的 peekInstructions）。
        const baseContext = ContextBuilder.buildCoreContext(char, userProfile, false, undefined, undefined, {
            skipTimeAwareness: !isDateTimeAwarenessOn(char) || !!clock,
            worldbookMessages: apiMessages,
        });

        // 文風預設也作用於開場感知；人稱（pov）刻意不作用——peek 的設計就是
        // 第三人稱旁觀鏡頭（用戶還沒"走過去"），人稱指令只影響 session 內敘述
        const preset = getStylePreset(char.dateStyleConfig);
        const extraBlock = buildExtraStyleBlock(char.dateStyleConfig);

        // 根據時間間隔選擇合適的分隔符
        const contextSeparator = clock
            ? `\n\n--- [故事裡的時間：${timeStr}] ---\n\n`
            : gapHint
            ? `\n\n--- [TIME SKIP: ${gapHint}] ---\n\n`
            : `\n\n--- [SCENE CONTINUATION: 剛剛還在聊天，現在來到了面對面的場景] ---\n\n`;

        const peekInstructions = `
### 場景：感知 (Sense Presence)
${dateTimeOn ? `當前時間: ${timeStr}${clock ? `（${describeClockNote(clock) || '故事裡的時間'}）` : ''}\n` : ''}${clock ? '' : `時間上下文: ${gapHint}`}

### 任務
${invite
    ? `由你主動以合理的方式去見${uname}。根據最近記錄裡的地點、約定、你們的關係和你自己的動機，寫出你怎麼走近、來到${uname}面前；如果你們本來就在一起，就從當下的場景自然靠近、開口，不另外編一次到訪。不知道的地點或安排不要當成已知事實。
請用**第三人稱**描寫一段話：寫${char.name}自己的到來、動作和必要的開場台詞，停在留給${uname}回應的地方。${uname}怎麼反應、答不答應、說什麼，都留給${uname}自己寫。`
    : `你現在並不在和用戶直接對話。用戶正在悄悄靠近你所在的地點。
請用**第三人稱**描寫一段話。
描述：${char.name} 此時此刻正在做什麼？周圍環境是怎樣的？狀態如何？`}${buildMeetupLine(input.meetup, char.name, uname, invite)}${buildScenarioBlock(char, uname) ? `\n${buildScenarioBlock(char, uname)}` : ''}

### 邏輯檢查
1. **上下文連貫性**: 參考 [最近記錄]（注意消息來源標籤：[聊天]是文字聊天、[約會]是面對面、[通話]是語音通話）。如果有 [TIME SKIP] 且間隔很久，開啟新場景；如果是 [SCENE CONTINUATION]，說明剛剛還在聊天，**必須**自然銜接最近的聊天話題和情緒狀態，不要無視之前的對話內容。
2. **狀態一致性**: ${gapHint.includes('天') ? '如果間隔了很多天，可能在發呆、忙碌或者有點落寞。' : '根據最近的聊天內容和情緒來決定當前狀態。如果剛聊完，角色的狀態應該與聊天內容相呼應。'}
${char.chatBlock ? `${buildBlockedMeetingNote(char, userProfile?.name || '')}` : ''}3. **描寫風格**: ${preset.peekHint}。不要輸出任何前綴，直接輸出描寫內容。
${extraBlock ? `\n${extraBlock}` : ''}`;

        // 歷史已經壓進這一條 user 消息裡，深度條目就以它為準：深度 0 在它之後，其餘在它之前
        const peekMsg: ApiMessage = { role: 'user', content: `[最近記錄 (Previous Context)]:${recentMsgs}${contextSeparator}${peekInstructions}\n\n(Start sensing...)` };
        return {
            messages: [
                { role: 'system', content: baseContext },
                ...withWorldbookDepthEntries([peekMsg], char, userProfile?.name || '', apiMessages),
            ],
        };
    },

    /**
     * Session（send / reroll 共用）。
     * allMsgs 須為角色有效上下文窗口，且最後一條是本輪要重新追加的
     * user 消息（send：剛落庫的輸入；reroll：觸發上一條 AI 回覆的那條）。
     */
    buildSessionPayload: async (input: {
        char: CharacterProfile;
        userProfile: UserProfile;
        allMsgs: Message[];
        emojis: Emoji[];
        userText: string;
        variant: 'send' | 'reroll';
        useVisionDescriptions?: boolean;
        /** 這場故事的前情提要（utils/dateSummary.ts 的 buildDateRecap） */
        recap?: string;
        /** 故事時鐘（utils/dateStoryTime.ts）；真實＋流動是 null */
        clock?: DateClock | null;
    }): Promise<{ messages: ApiMessage[] }> => {
        const { char, userProfile, allMsgs, emojis, userText, variant } = input;

        const clock = input.clock ?? null;
        const historyMsgs = buildDateHistory(
            allMsgs,
            char,
            userProfile,
            emojis,
            input.useVisionDescriptions === true,
            clock,
        );

        // 世界書關鍵詞掃描：歷史 + 本輪輸入原文（不帶下面的 System Note，免得格式指令裡的字眼誤觸發）
        const worldbookScan: WorldbookScanMessage[] = [...historyMsgs, { role: 'user', content: userText }];

        // 向量召回掛到 char.memoryPalaceInjection，buildCoreContext 會讀取
        await injectMemoryPalace(char, allMsgs, undefined, userProfile?.name);
        // 故事時鐘不是現實的話，核心上下文那段現實時間不帶，改由下面散文塊的 Time 那行說
        const systemPrompt = ContextBuilder.buildCoreContext(char, userProfile, true, undefined, undefined, {
            skipTimeAwareness: !isDateTimeAwarenessOn(char) || !!clock,
            conversational: true,
            worldbookMessages: worldbookScan,
        })
            + buildMeetingProseBlock(char, userProfile?.name || '', input.recap || '', clock)
            + ContextBuilder.buildSARModuleContext(char, userProfile, 'date');

        // 每輪輪換的聚焦線索：把注意力推向不同的具體方向，相鄰回覆天然有差異
        const focusLine = isDigDeeperOn(char.dateStyleConfig) ? ` 本輪線索：${pickFocusHint()}。` : '';
        const note = variant === 'send'
            ? `(System Note: 台詞單獨成行、用引號包起來${char.dateVoiceEnabled ? '、開頭帶英文語氣標籤' : ''}。敘述行寫具體的感官細節和停頓，不要羅列動作。${focusLine})`
            : `(System Note: Reroll. 換一個切入角度重寫，不要複用上一版的展開思路。台詞依然單獨成行、用引號包起來${char.dateVoiceEnabled ? '、開頭帶英文語氣標籤' : ''}；敘述行寫具體的感官細節和停頓，不要羅列動作。${focusLine})`;

        // 固定台詞：對方這句踩中了就這一輪原樣說出，跟每輪的註記放在一起、緊貼開口（見 utils/fixedLines.ts）
        // 只拿說出口的部分去比對：旁白裡寫到的字不算「對方說了」
        const fixedLineNote = buildTriggeredLinesPrompt(char, spokenPartOfDateInput(userText), userProfile?.name || '用戶');
        return {
            messages: [
                { role: 'system', content: systemPrompt },
                ...withWorldbookDepthEntries(
                    [...historyMsgs, { role: 'user', content: `${formatDateUserInput(userText)}\n\n${note}${fixedLineNote ? `\n${fixedLineNote}` : ''}` }],
                    char,
                    userProfile?.name || '',
                    worldbookScan,
                ),
            ],
        };
    },
};
