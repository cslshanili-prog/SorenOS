/**
 * 見面（DateApp）提示詞統一構造器
 *
 * 與聊天側 chatRequestPayload.ts 同構：peek（感知開場）/ send / reroll 三條路徑
 * 都從這裡拿完整的 messages 數組，DateApp 組件只負責 UI 狀態和 fetch。
 *
 * 與聊天側注入面的差異（刻意為之，不是漏配）：
 *   - 注入：ContextBuilder.buildCoreContext 全量（人設 / 世界書 / 印象 / 記憶 /
 *     記憶宮殿召回 / 情緒 buff）+ 當前虛擬時間。
 *   - 不注入：聊天 App 行為規範（IM 氣泡 / 表情包 / 語音 / 引用 / 轉帳 / 小紅書 /
 *     日記等工具塊）——這些是線上聊天專屬指令，面對面場景裡輸出會破壞 VN 格式。
 *   - 不注入：實時天氣 / 新聞、群聊背景、Notion / 飛書日記標題——見面是高沉浸短會話，
 *     這些背景塊收益低，還會稀釋 VN 格式指令的權重。
 *   - 日程 / 音樂氛圍目前也不進見面場景；以後要加請在這裡統一加，別在組件裡散拼。
 *
 * 歷史構建統一複用 ChatPrompts.buildMessageHistory：html_card / score_card /
 * chat_forward / emoji 等都會被壓成短摘要，不會把原始 HTML / JSON / URL 塞進
 * prompt（peek 舊版手搓 mapper 的問題即在此，已統一修掉）。
 */

import { CharacterProfile, UserProfile, Message, Emoji, DateStyleConfig, DateObservation, DateObserveConfig, DateObserveCustomField } from '../types';
import { buildBlockedMeetingNote } from './chatBlock';
import { ContextBuilder } from './context';
import { ChatPrompts } from './chatPrompts';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { resolveCharTimeZone, nowInTimeZone } from './timezone';
import { getVoicePromptOverride } from './ttsProvider';
import { selectCharacterContextMessages } from './chatContextRange';

export type ApiMessage = { role: string; content: any };

/**
 * 見面（DateApp）專用的「語音情緒」格式規則（VN 模式下、char.dateVoiceEnabled 時注入）。
 * 與聊天/電話的 VOICE_ACTING_GUIDE 不同：見面台詞走 VN 散文，只在台詞行末用 [v:xxx] 單獨標語音情緒，
 * 與立繪 [emotion] 解耦、不引入 <#秒#> 停頓/語氣聲標籤。開頭編號 4. 是承接 VN 規則列表第 1~3 條。
 * 用戶可在「設置 → 其他 API → 語音提示詞」自定義；留空則用這份內置默認。
 */
export const DATE_VOICE_GUIDE = `4. **語音情緒（跟立繪分開）**: \`[emotion]\` 只管**立繪表情**。台詞會被朗讀成真實語音，而立繪的誇張表情 ≠ 語音裡的情緒——立繪 happy 是個燦爛笑臉，語音 happy 卻會變成過度上揚的腔調，常常不對味。所以**語音情緒要單獨標**：在台詞行末尾加 \`[v:xxx]\`，xxx 僅限 happy/sad/angry/fearful/disgusted/surprised/calm。
   - 不是每句都要標——情緒平淡、自然說話時**不標**（默認更真實），只在台詞確實有明顯情緒、且和立繪強度不一致時才標。
   - 立繪可以誇張、語音要克制。例：\`[happy] "……真的嗎？我等這句話好久了。" [v:calm]\`（臉上是驚喜，聲音是壓著的溫柔）。
   - \`[v:xxx]\` 只寫在帶引號的台詞行，動作/敘述行不用標。`;

/**
 * 注入 prompt 的當前時間，直接取真實系統時間（完整日期 + 星期 + 時分）。
 * 不要從 OSContext 的 virtualTime 取——那個名字唬人，實際也是每秒同步的真實
 * 時間，但只有"星期 + 時:分"，缺日期，而且沒必要讓 prompt 構建依賴 React 狀態。
 */
const getRealTimeStr = (tz?: string): string => {
    // formatDate 自己會按 tz 折算，所以這裡要喂真實時刻。
    // nowInTimeZone 返回的 Date 是「本地 getter 讀出來正好是角色牆上時間」的形式，
    // 它的絕對時間戳已經被挪過一次——再交給 formatDate 就會多減一個時差。
    const realNow = Date.now();
    const wallClock = nowInTimeZone(tz, new Date(realNow));
    const days = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    return `${ChatPrompts.formatDate(realNow, tz)} ${days[wallClock.getDay()]}`;
};

/** 線下時間感知開關：默認開啟，顯式關掉後見面 prompt 不再注入時間。 */
const isDateTimeAwarenessOn = (char: CharacterProfile): boolean =>
    char.dateTimeAwarenessEnabled !== false;

/** 立繪系統要求必備的五種基礎情緒；角色自定義立繪在此之上疊加 */
export const REQUIRED_DATE_EMOTIONS = ['normal', 'happy', 'angry', 'sad', 'shy'];

// ─────────────────────────────────────────────────────────────
// 寫作風格預設（DateSettings 面板與 prompt 構建共用同一份，別兩邊手抄）
// ─────────────────────────────────────────────────────────────

export interface DateStylePreset {
    id: string;
    label: string;
    /** 設置面板裡給用戶看的一句話簡介 */
    hint: string;
    /** VN 系統提示裡的完整風格塊（替換「動作與敘述行的寫法」段落） */
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

❌ **不要這樣寫**（只用一個情緒 + 乾巴巴的動作羅列）：
[normal] 把手放下，看向你。
走到你身邊，坐下來。
拿起杯子，喝了一口水。

✅ **要這樣寫**（每行標註情緒 + 有畫面、有停頓的敘述）：
[normal] 指尖從髮梢滑落，垂在身側。視線轉過來的時候並不急，像是剛好、又像是故意。
[shy] "……你一直在看我嗎？"
[happy] 嘴角的弧度藏不住，像是被戳中了什麼小心思。
[normal] 腳步踩在木地板上的聲音很輕。在你旁邊坐下來，衣料帶過一縷還沒散盡的冷風。`,
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
[normal] 放下杯子。
[normal] "來了。"
[shy] 視線挪開，落在窗外。`,
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
[normal] 茶杯沿上的熱氣慢慢散了，像一句沒說完就被收回去的話。
[shy] "……今天的風，把人吹得有點想說實話。"
[happy] 指尖在桌面輕輕敲了兩下，藏不住的雀躍順著指節漏出來。`,
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
[happy] 叼著吸管，含糊不清地比了個"過來"的手勢。
[normal] "你再遲到一分鐘，這杯奶茶裡的珍珠就要被我替你報仇了。"
[shy] 說完自己先沒繃住，耳朵尖紅了一點。`,
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
[normal] 一步，又一步。影子先碰到了你的影子。
[angry] "剛才那句話，再說一遍。"
[shy] 呼吸在離得很近的地方，亂了半拍。`,
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
示例：${charName}看向${uname}，伸手替${uname}攏了攏被風吹亂的頭髮。
（台詞引號內不受限，正常說話即可。上方風格示例中的人稱僅為格式示意，一律以本節為準。）
`;
        case 'third-you':
            return `### 敘事人稱（必須嚴格遵守）
敘述行中稱呼你自己為「${charName}」（第三人稱），稱呼對方為"你"。敘述裡不要用"我"指代自己。
示例：${charName}看向你，伸手替你攏了攏被風吹亂的頭髮。
（台詞引號內不受限，正常說話即可。上方風格示例中的人稱僅為格式示意，一律以本節為準。）
`;
        case 'first-you':
            return `### 敘事人稱（必須嚴格遵守）
敘述行使用**第一人稱**：稱呼你自己為"我"，稱呼對方為"你"。不要在敘述裡用自己的名字指代自己。
示例：我看向你，伸手替你攏了攏被風吹亂的頭髮。
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

// ─────────────────────────────────────────────────────────────
// 觀測協議 OBSERVE（全方位觀察 char：時間 / 地點 / 狀態 / 細節）
//
// 開啟後，讓模型在「正文最前面」吐一段定界的結構化觀測塊，前端 extractObservation
// 把它從正文裡剝出來渲染成全息 HUD（獨立查看），剩餘文本照常走 VN 解析。
// 定界符用不常見的 ⟦⟧，避免和 [emotion] 立繪標籤 / 台詞引號撞車。
// 字段標籤固定中文 + 全角豎線，解析時對中英 key、半角豎線、冒號都容錯。
// ─────────────────────────────────────────────────────────────

export const OBSERVE_OPEN = '⟦OBSERVE⟧';
export const OBSERVE_CLOSE = '⟦/OBSERVE⟧';

// ── 容錯正則：模型掉格式時儘量還原，分兩層（嚴格定界 + 寬鬆回退）─────────
// 各種括號風格：⟦⟧ 【】〔〕「」『』 [] () <> ，都收。關鍵字接受 OBSERVE / 觀測 / 觀測協議。
const BRA = '[\\[\\(<⟦【〔「『]';
const KET = '[\\]\\)>⟧】〕」』]';
const OBSERVE_KW = '(?:OBSERVE|觀測協議|觀測)';

/** 嚴格：成對定界塊（含 ⟦OBSERVE⟧ … ⟦/OBSERVE⟧，容忍括號風格/空格/大小寫）。有定界符即視為明確意圖。 */
const OBSERVE_BLOCK_RE = new RegExp(`${BRA}\\s*${OBSERVE_KW}\\s*${KET}([\\s\\S]*?)${BRA}\\s*/\\s*${OBSERVE_KW}\\s*${KET}`, 'i');

/** 整行只是一個定界標記（開/閉都算）——回退掃描時用來跳過孤立的標記行 */
const OBSERVE_MARKER_LINE_RE = new RegExp(`^\\s*${BRA}?\\s*/?\\s*${OBSERVE_KW}\\s*/?\\s*${KET}?\\s*$`, 'i');
const isObserveMarkerLine = (line: string): boolean => OBSERVE_MARKER_LINE_RE.test(line.trim());

/** 單條字段行：容忍 markdown 列表符 / 加粗 / 中英 key / 全半角豎線 / 中英冒號 */
const OBSERVE_FIELD_RE = /^\s*(?:[-*>•·]\s*)?\*{0,2}\s*([时時][间間]|地[点點]|地[区區]|[场場]所|位置|[状狀][态態]|心境|情[绪緒]|[细細][节節]|[动動]作|[举舉][动動]|time|place|location|site|position|status|state|mood|detail|trace|action)\s*\*{0,2}\s*[｜|:：]\s*(.+?)\s*$/i;

/** 默認四維的 key（不含 extra） */
type ObserveDefaultKey = 'time' | 'place' | 'state' | 'detail';

/** 把 key 歸一到四個維度之一 */
const mapObserveKey = (key: string): ObserveDefaultKey | null => {
    const k = key.toLowerCase();
    if (/[时時][间間]|time/.test(k)) return 'time';
    if (/地[点點]|地[区區]|[场場]所|位置|place|location|site|position/.test(k)) return 'place';
    if (/[状狀][态態]|心境|情[绪緒]|status|state|mood/.test(k)) return 'state';
    if (/[细細][节節]|[动動]作|[举舉][动動]|detail|trace|action/.test(k)) return 'detail';
    return null;
};

/** 清洗字段值：去掉殘留的定界標記、外層括號、加粗星號 */
const cleanObserveValue = (raw: string): string => {
    let v = raw.trim();
    v = v.replace(new RegExp(`${BRA}\\s*/?\\s*${OBSERVE_KW}\\s*/?\\s*${KET}`, 'gi'), ''); // 內聯殘留標記
    v = v.replace(/^\*{1,2}|\*{1,2}$/g, '').trim();   // 外層加粗
    v = v.replace(/^（\s*|\s*）$/g, '').trim();        // 全角括號包裹
    v = v.replace(/^\(\s*|\s*\)$/g, '').trim();        // 半角括號包裹
    return v.trim();
};

const isObserveOn = (char: CharacterProfile): boolean => char.dateObserve?.enabled === true;

/**
 * 觀測協議四個默認維度。`label` 是注入提示詞時的**固定線格式字段名**（解析靠它，
 * 不隨用戶自定義改動），`en`/`glyph` 給 HUD 用，`hint` 是默認生成提示（可被
 * char.dateObserve.fields[key].hint 覆蓋；`{name}` 會替換成角色名）。
 */
export interface ObserveDimension {
    key: keyof DateObservation;
    label: string;   // 線格式字段名（時間/地點/狀態/細節），解析依賴，勿改
    en: string;      // HUD 上的英文小標
    glyph: string;   // HUD 上的字形符號
    hint: string;    // 默認生成提示
}

export const OBSERVE_DIMENSIONS: ObserveDimension[] = [
    { key: 'time',   label: '時間', en: 'TIME',  glyph: '◷', hint: '結合場景的當下時刻，可比系統時間更具體，如"傍晚六點過，天剛擦黑"' },
    { key: 'place',  label: '地點', en: 'SITE',  glyph: '⌖', hint: '{name}此刻所在的具體地點與環境' },
    { key: 'state',  label: '狀態', en: 'STATE', glyph: '❖', hint: '{name}的身心狀態：情緒、體感、正在經歷的內在波動' },
    { key: 'detail', label: '細節', en: 'TRACE', glyph: '✶', hint: '此刻最值得被注意的一個動作 / 微小細節' },
];

/** 自定義維度在 HUD 上輪換用的字形 */
const CUSTOM_GLYPHS = ['✦', '◆', '❂', '✺', '⬡', '◈'];

/** HUD / 設置面板 / 提示詞共用：合併默認四維 + 用戶自定義維度，過濾禁用 / 空標籤的。 */
export interface ResolvedObserveField {
    key: string;       // 默認維度的 key（time/place/...）或自定義維度的 id
    label: string;     // 線格式字段名（默認維度用固定中文 key；自定義用其 label）
    display: string;   // HUD 展示標籤（默認維度可自定義；自定義維度即 label）
    en: string;
    glyph: string;
    hint: string;
    isCustom: boolean;
}
export const resolveObserveFields = (config?: DateObserveConfig, charName = ''): ResolvedObserveField[] => {
    const cfg = config?.fields || {};
    const base: ResolvedObserveField[] = OBSERVE_DIMENSIONS
        .filter(d => cfg[d.key]?.enabled !== false)
        .map(d => ({
            key: d.key,
            label: d.label,
            display: (cfg[d.key]?.label || '').trim() || d.label,
            en: d.en,
            glyph: d.glyph,
            hint: ((cfg[d.key]?.hint || '').trim() || d.hint).replace(/\{name\}/g, charName),
            isCustom: false,
        }));
    const custom: ResolvedObserveField[] = (config?.custom || [])
        .filter(c => c.enabled !== false && (c.label || '').trim())
        .map((c, i) => ({
            key: c.id,
            label: c.label.trim(),
            display: c.label.trim(),
            en: 'NOTE',
            glyph: CUSTOM_GLYPHS[i % CUSTOM_GLYPHS.length],
            hint: ((c.hint || '').trim() || `觀察並描寫「${c.label.trim()}」`).replace(/\{name\}/g, charName),
            isCustom: true,
        }));
    return [...base, ...custom];
};

/**
 * 觀測塊提示詞。僅在開關打開時注入；放在 VN 塊末尾（場景上下文之後）。
 * 線格式字段名固定用默認 label（保證解析穩定），但每項「生成什麼」用角色自定義 hint。
 * 全部維度被用戶關掉時返回空串（等於不注入觀測塊）。
 */
const buildObserveBlock = (char: CharacterProfile): string => {
    const fields = resolveObserveFields(char.dateObserve, char.name);
    if (fields.length === 0) return '';
    const lines = fields.map(f => `${f.label}｜（${f.hint}）`).join('\n');
    return `
### 👁 觀測協議（OBSERVE，必須嚴格執行）
在你**整段回覆的最前面**，先輸出一段「觀測塊」，用來讓用戶全方位觀察${char.name}此刻的狀態。
觀測塊**不受**上面「一行一念 / 每行 [emotion] 開頭」規則約束——它是獨立的元信息，緊接著才是正常的 VN 正文。

格式**必須**逐字如下（每個字段都要給，每項一句話、簡潔有畫面，別寫成大段）：
${OBSERVE_OPEN}
${lines}
${OBSERVE_CLOSE}

硬性要求：
- 開頭那行 \`${OBSERVE_OPEN}\` 和結尾那行 \`${OBSERVE_CLOSE}\` **兩行定界符都必須原樣保留**，各自單獨佔一行，哪怕你不確定也別省略。
- 每個字段各佔一行，用全角豎線 \`｜\` 分隔標籤和內容；標籤必須原樣用 ${fields.map(f => `「${f.label}」`).join('、')}，不要加序號、不要用 markdown 加粗。
- 觀測塊只在整段回覆的最開頭出現一次，輸出完**另起一行**再寫 VN 正文（每行 [emotion] 開頭）。`;
};

/**
 * 從模型輸出裡剝出觀測塊。返回結構化數據 + 去掉觀測塊後的正文。
 *
 * 魯棒性分兩層（針對模型掉格式）：
 *  1) 嚴格層：成對定界塊（含各種括號風格 / OBSERVE|觀測 關鍵字）。有定界符 = 明確意圖，
 *     哪怕只有一個字段也認。這一層永遠開，不會誤傷普通正文。
 *  2) 回退層（lenient）：模型丟了閉合標記、換了標記、甚至完全沒標記，只在開頭堆了
 *     "時間｜… 地點｜…" 這種字段行——就從開頭連續掃字段行，**至少命中 2 個不同維度**
 *     才認（避免把正文裡偶發的"狀態：…"誤當觀測）。僅在開關打開時傳 lenient=true。
 */
export const extractObservation = (
    text: string,
    opts: { lenient?: boolean; custom?: DateObserveCustomField[] } = {},
): { observation: DateObservation | null; rest: string } => {
    if (!text) return { observation: null, rest: text };

    const customFields = (opts.custom || []).filter(c => c.enabled !== false && (c.label || '').trim());

    // ── 嚴格層：成對定界塊 ──
    const m = text.match(OBSERVE_BLOCK_RE);
    if (m && m.index !== undefined) {
        const observation = parseObserveBody(m[1], customFields);
        if (hasObservation(observation)) {
            const rest = stripStrayMarkers(text.slice(0, m.index) + text.slice(m.index + m[0].length));
            return { observation, rest };
        }
    }

    // ── 回退層：僅在開關開時啟用，掃開頭的連續字段行 ──
    if (opts.lenient) {
        const fallback = scanLeadingFields(text, customFields);
        if (fallback) return fallback;
    }

    return { observation: null, rest: text };
};

/** 通用字段行（任意短 key｜value），用於匹配自定義維度的 label */
const OBSERVE_ANYLINE_RE = /^\s*(?:[-*>•·]\s*)?\*{0,2}\s*([^｜|:：*\n]{1,16}?)\s*\*{0,2}\s*[｜|:：]\s*(.+?)\s*$/;

/** 試著把一行匹配成某個自定義維度（按 label 精確匹配，大小寫/空格不敏感） */
const matchCustomField = (line: string, customFields: DateObserveCustomField[]): { id: string; value: string } | null => {
    if (!customFields.length) return null;
    const mm = line.match(OBSERVE_ANYLINE_RE);
    if (!mm) return null;
    const k = mm[1].trim().toLowerCase();
    const cf = customFields.find(c => c.label.trim().toLowerCase() === k);
    if (!cf) return null;
    return { id: cf.id, value: cleanObserveValue(mm[2]) };
};

const setCustomValue = (obs: DateObservation, id: string, val: string): void => {
    if (!val) return;
    obs.extra = obs.extra || {};
    if (!obs.extra[id]) obs.extra[id] = val;
};

/** 統計觀測命中了幾個不同維度（默認四維 + 自定義），回退層用於 ≥2 門檻 */
const countObserveDims = (obs: DateObservation): number =>
    (obs.time ? 1 : 0) + (obs.place ? 1 : 0) + (obs.state ? 1 : 0) + (obs.detail ? 1 : 0) + Object.keys(obs.extra || {}).length;

/** 塊體逐行解析（嚴格層用，塊內字段無歧義，不設 2 個門檻） */
const parseObserveBody = (body: string, customFields: DateObserveCustomField[] = []): DateObservation => {
    const obs: DateObservation = {};
    for (const raw of body.split('\n')) {
        const mm = raw.match(OBSERVE_FIELD_RE);
        if (mm) {
            const key = mapObserveKey(mm[1]);
            const val = cleanObserveValue(mm[2]);
            if (key && val && !obs[key]) obs[key] = val;
            continue;
        }
        const cf = matchCustomField(raw, customFields);
        if (cf) setCustomValue(obs, cf.id, cf.value);
    }
    return obs;
};

/**
 * 回退掃描：跳過開頭的空行/孤立標記行，連續吃字段行，遇到第一行"非字段非標記非空"的
 * 內容（正文/台詞/[emotion] 行）即停。命中 ≥2 個不同維度才算數。
 */
const scanLeadingFields = (text: string, customFields: DateObserveCustomField[] = []): { observation: DateObservation; rest: string } | null => {
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;          // 跳開頭空行
    if (i < lines.length && isObserveMarkerLine(lines[i])) i++; // 跳一行孤立開標記
    const obs: DateObservation = {};
    let lastConsumed = i - 1;
    const maxScan = i + 12; // 只看開頭一小段，絕不深入正文
    for (let j = i; j < lines.length && j < maxScan; j++) {
        const t = lines[j].trim();
        if (!t) { continue; }                       // 字段間空行：跳過但不推進 lastConsumed
        if (isObserveMarkerLine(lines[j])) { lastConsumed = j; continue; } // 閉合/重複標記
        const mm = t.match(OBSERVE_FIELD_RE);
        if (mm) {
            const key = mapObserveKey(mm[1]);
            const val = cleanObserveValue(mm[2]);
            if (key && val && !obs[key]) obs[key] = val;
            lastConsumed = j;
            continue;
        }
        const cf = matchCustomField(t, customFields);
        if (!cf) break;                             // 正文開始
        setCustomValue(obs, cf.id, cf.value);
        lastConsumed = j;
    }
    if (countObserveDims(obs) < 2) return null;
    const rest = lines.slice(lastConsumed + 1).join('\n').trim();
    return { observation: obs, rest };
};

/** 去掉正文裡殘留的孤立定界標記行（嚴格層剝塊後可能留下空標記/代碼圍欄） */
const stripStrayMarkers = (text: string): string =>
    text
        .split('\n')
        .filter(line => !isObserveMarkerLine(line) && !/^\s*```/.test(line))
        .join('\n')
        .trim();

/** 只去觀測塊、不要結構化數據時用（novel 模式渲染歷史正文） */
export const stripObservation = (text: string, opts?: { lenient?: boolean }): string =>
    extractObservation(text, opts).rest || (text || '');

/** HUD / 持久化判定：任一默認維度或自定義維度非空才算有效觀測 */
export const hasObservation = (obs: DateObservation | null | undefined): obs is DateObservation =>
    !!obs && !!(obs.time || obs.place || obs.state || obs.detail || (obs.extra && Object.keys(obs.extra).length > 0));

const getDateEmotions = (char: CharacterProfile): string[] =>
    [...REQUIRED_DATE_EMOTIONS, ...(char.customDateSprites || [])];

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
 * VN 模式系統提示（send 與 reroll 共用同一份，避免兩處手抄漂移）。
 * reroll 的差異只體現在末尾 user 消息的 System Note 裡，不在這裡分叉。
 * 風格 / 人稱 / 自定義補充按 char.dateStyleConfig 動態拼裝。
 */
const buildVNModeBlock = (char: CharacterProfile, userName: string): string => {
    const dateTimeOn = isDateTimeAwarenessOn(char);
    const timeLine = dateTimeOn ? `1. **Time**: 當前時間 ${getRealTimeStr(resolveCharTimeZone(char))}。\n` : '';
    const dateEmotions = getDateEmotions(char);
    const styleConfig = char.dateStyleConfig;
    const preset = getStylePreset(styleConfig);
    const povBlock = buildPovBlock(styleConfig, char.name, userName);
    const extraBlock = buildExtraStyleBlock(styleConfig);
    const digBlock = isDigDeeperOn(styleConfig) ? `${DIG_DEEPER_BLOCK}\n` : '';
    const observeBlock = isObserveOn(char) ? buildObserveBlock(char) : '';
    return `### [Visual Novel Mode: 視覺小說腳本模式]
你正在與用戶進行**面對面**的互動。這不是聊天，是一場真實的見面。

### 核心規則：一行一念 (One Line per Beat)
前端解析器基於**換行符**來分割氣泡。
1. **禁止混寫**: 嚴禁在同一行裡既寫動作又寫帶引號的台詞。
2. **情緒標籤**: **每一行都必須以** \`[emotion]\` **開頭**，表示該行的表情立繪。情緒隨內容變化——台詞溫柔就用 [happy]，動作緊張就用 [shy]，語氣衝就用 [angry]。**不要整段只用一個情緒，要逐行根據語境切換。** 僅限使用以下情緒: ${dateEmotions.join(', ')}。不要使用任何不在此列表中的標籤。
3. **格式**: 台詞用雙引號 **"..."**，動作/敘述直接寫（不加引號）。
${char.dateVoiceEnabled ? (getVoicePromptOverride('dateVoice') ?? DATE_VOICE_GUIDE) : ''}

${preset.block}

${digBlock}${povBlock}${extraBlock}### 場景上下文
${timeLine}- **Location**: 你們現在**面對面**。
- **Context**: 參考歷史記錄。如果剛剛才看到開場白（Opening），請自然接話。
${buildBlockedMeetingNote(char, userName)}${observeBlock}`;
};

/**
 * 歷史構建（send / reroll 共用）：
 * 1. 與其他 AI 入口共用自適應 / 手動範圍及用戶起點。調用方先讀取有效窗口。
 * 2. 複用 ChatPrompts.buildMessageHistory 壓縮各類卡片。
 * 3. 排除最後一條（待重發的 user msg），由調用方單獨追加帶 System Note 的版本。
 */
const buildDateHistory = (
    allMsgs: Message[],
    char: CharacterProfile,
    userProfile: UserProfile | null | undefined,
    emojis: Emoji[],
    useVisionDescriptions: boolean = false,
): ApiMessage[] => {
    const selected = selectCharacterContextMessages(allMsgs, char);
    const pendingId = allMsgs[allMsgs.length - 1]?.id;
    const historyForBuild = selected.filter(message => message.id !== pendingId);
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
    }): { messages: ApiMessage[] } => {
        const { char, userProfile, allMsgs, emojis } = input;
        const charTz = resolveCharTimeZone(char);
        const dateTimeOn = isDateTimeAwarenessOn(char);
        const timeStr = getRealTimeStr(charTz);
        const selected = selectCharacterContextMessages(allMsgs, char);
        const lastMsg = allMsgs[allMsgs.length - 1];
        const gapHint = getTimeGapHint(lastMsg?.timestamp, charTz);

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
        const baseContext = ContextBuilder.buildCoreContext(char, userProfile, false, undefined, undefined, { skipTimeAwareness: !isDateTimeAwarenessOn(char) });

        // 文風預設也作用於開場感知；人稱（pov）刻意不作用——peek 的設計就是
        // 第三人稱旁觀鏡頭（用戶還沒"走過去"），人稱指令只影響 session 內敘述
        const preset = getStylePreset(char.dateStyleConfig);
        const extraBlock = buildExtraStyleBlock(char.dateStyleConfig);

        // 根據時間間隔選擇合適的分隔符
        const contextSeparator = gapHint
            ? `\n\n--- [TIME SKIP: ${gapHint}] ---\n\n`
            : `\n\n--- [SCENE CONTINUATION: 剛剛還在聊天，現在來到了面對面的場景] ---\n\n`;

        const peekInstructions = `
### 場景：感知 (Sense Presence)
${dateTimeOn ? `當前時間: ${timeStr}\n` : ''}時間上下文: ${gapHint}

### 任務
你現在並不在和用戶直接對話。用戶正在悄悄靠近你所在的地點。
請用**第三人稱**描寫一段話。
描述：${char.name} 此時此刻正在做什麼？周圍環境是怎樣的？狀態如何？

### 邏輯檢查
1. **上下文連貫性**: 參考 [最近記錄]（注意消息來源標籤：[聊天]是文字聊天、[約會]是面對面、[通話]是語音通話）。如果有 [TIME SKIP] 且間隔很久，開啟新場景；如果是 [SCENE CONTINUATION]，說明剛剛還在聊天，**必須**自然銜接最近的聊天話題和情緒狀態，不要無視之前的對話內容。
2. **狀態一致性**: ${gapHint.includes('天') ? '如果間隔了很多天，可能在發呆、忙碌或者有點落寞。' : '根據最近的聊天內容和情緒來決定當前狀態。如果剛聊完，角色的狀態應該與聊天內容相呼應。'}
${char.chatBlock ? `${buildBlockedMeetingNote(char, userProfile?.name || '')}` : ''}3. **描寫風格**: ${preset.peekHint}。${isObserveOn(char) ? '先按下方「觀測協議」輸出觀測塊，再開始描寫內容（描寫本身不要加任何前綴）。' : '不要輸出任何前綴，直接輸出描寫內容。'}
${extraBlock ? `\n${extraBlock}` : ''}${isObserveOn(char) ? `\n${buildObserveBlock(char)}` : ''}`;

        return {
            messages: [
                { role: 'system', content: baseContext },
                { role: 'user', content: `[最近記錄 (Previous Context)]:${recentMsgs}${contextSeparator}${peekInstructions}\n\n(Start sensing...)` },
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
    }): Promise<{ messages: ApiMessage[] }> => {
        const { char, userProfile, allMsgs, emojis, userText, variant } = input;

        const historyMsgs = buildDateHistory(
            allMsgs,
            char,
            userProfile,
            emojis,
            input.useVisionDescriptions === true,
        );

        // 向量召回掛到 char.memoryPalaceInjection，buildCoreContext 會讀取
        await injectMemoryPalace(char, allMsgs, undefined, userProfile?.name);
        const systemPrompt = ContextBuilder.buildCoreContext(char, userProfile, true, undefined, undefined, { skipTimeAwareness: !isDateTimeAwarenessOn(char), conversational: true })
            + buildVNModeBlock(char, userProfile?.name || '')
            + ContextBuilder.buildSARModuleContext(char, userProfile, 'date');

        // 每輪輪換的聚焦線索：把注意力推向不同的具體方向，相鄰回覆天然有差異
        const focusLine = isDigDeeperOn(char.dateStyleConfig) ? ` 本輪線索：${pickFocusHint()}。` : '';
        const note = variant === 'send'
            ? `(System Note: 嚴格遵守 VN 格式。每一行都要以 [emotion] 開頭，根據內容逐行切換情緒標籤，不要整段只用同一個。敘述行寫具體的感官細節和停頓，不要羅列動作。${focusLine})`
            : `(System Note: Reroll. 換一個切入角度重寫，不要複用上一版的展開思路。依然嚴格遵守 VN 格式：每一行以 [emotion] 開頭並逐行切換情緒，敘述行寫具體的感官細節和停頓，不要羅列動作。${focusLine})`;

        return {
            messages: [
                { role: 'system', content: systemPrompt },
                ...historyMsgs,
                { role: 'user', content: `${userText}\n\n${note}` },
            ],
        };
    },
};
