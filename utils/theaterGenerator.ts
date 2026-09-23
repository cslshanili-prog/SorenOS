/**
 * 日程小劇場（窺視演出）生成器。
 *
 * 設計：用戶在日程卡上點某個「已過去 / 正在進行」時段的播放按鈕，
 * 以**第三人稱「上帝視角」**生成角色在這個時間點的一小段行為演出 —— 角色完全
 * 不知道自己被觀看（純紀錄片式窺視），逐行播放，像看一段小短劇。
 *
 * 注入面與見面（DateApp）/ 日程對齊，複用同一批零件：
 *   - 人設全量：ContextBuilder.buildCoreContext(char, user, true)
 *   - 該時段的硬事實：activity / location / description
 *   - 當天意識流底色：flowNarrative（按時段）或 slot.innerThought
 *   - 情緒 buff：char.buffInjection
 *   - 文風：複用見面側 DATE_STYLE_PRESETS（取 char.dateStyleConfig 的風格，缺省電影感）
 *
 * 輸出沿用見面的 VN「一行一拍」格式：每行 `[氛圍] 文本`，解析成 TheaterLine[]，
 * 緩存進 slot.theater，可反覆重看，不重複燒 token。
 */

import { CharacterProfile, UserProfile, DailySchedule, ScheduleSlot, SlotTheater, TheaterLine } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { safeResponseJson, extractContent } from './safeApi';
import { isScheduleFeatureOn } from './scheduleGenerator';
import { getFlowNarrativeKey } from './scheduleInjection';
import { DATE_STYLE_PRESETS } from './datePrompts';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/** 根據 slot 的開始時間挑當天意識流底色：優先該時段獨白，再退到 flowNarrative。 */
function pickNarrativeBackdrop(schedule: DailySchedule, slot: ScheduleSlot): string {
    if (slot.innerThought && slot.innerThought.trim()) return slot.innerThought.trim();
    const hour = parseInt(slot.startTime.split(':')[0], 10);
    const key = getFlowNarrativeKey(Number.isFinite(hour) ? hour : 12);
    const fromFlow = schedule.flowNarrative?.[key];
    return fromFlow && fromFlow.trim() ? fromFlow.trim() : '';
}

/** 取見面側文風預設的一句話提示，作為小劇場的文風線索（缺省電影感）。 */
function pickStyleHint(char: CharacterProfile): string {
    const styleId = char.dateStyleConfig?.style || 'cinematic';
    const preset = DATE_STYLE_PRESETS.find(p => p.id === styleId) || DATE_STYLE_PRESETS[0];
    return preset.peekHint;
}

function buildTheaterPrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    slot: ScheduleSlot,
    backdrop: string,
    styleHint: string,
): string {
    const uname = user?.name || '對方';
    const where = slot.location ? `（地點：${slot.location}）` : '';
    const desc = slot.description ? `\n這個時段日程上的描述是：${slot.description}` : '';
    const backdropBlock = backdrop
        ? `\n\n這個時段，「${char.name}」心裡盤旋的念頭大致是這樣（作為情緒底色，別照抄，要化進行為裡）：\n${backdrop}`
        : '';
    const buffBlock = (isScheduleFeatureOn(char) && char.emotionConfig?.enabled && char.buffInjection)
        ? `\n\n${char.buffInjection}`
        : '';

    // 「私底下的一面」是這段戲好不好看的關鍵：趁沒人時 ta 最真實、最放鬆、甚至有點蠢有點怪的樣子，
    // 多數時候跟 user 無關。生活系角色（有物理生活）尤其要往裡混怪動作 / 怪念頭；意識系側重內心怪念頭。
    const isLifestyle = (char.scheduleStyle || 'lifestyle') === 'lifestyle';
    const quirkBlock = isLifestyle
        ? `
### 最重要：演出 ta 私底下、沒人看見的那一面（這段戲好不好看全看這個）
這**不是**「${char.name} 在思念 ${uname}」的戲——**絕大多數時候跟 ${uname} 一點關係都沒有**。這是趁四下無人時，ta 獨處時最真實、最放鬆、甚至有點蠢、有點怪、有點可愛的樣子。要**非常具體、非常細節**地抓住那些"啊原來 ta 私底下是這樣"的瞬間，讓看的人覺得"太有意思了 / 太真實了 / 這也太 ta 了"。

**往這段戲裡自然混進 1～3 個這類私下小動作 / 小念頭**（貼著 ta 的人設和此刻在做的事去發揮，別照搬下面的，要長出 ta 自己的版本）：
- 哼歌哼到副歌破了音，自己先愣一下，左右瞄一眼有沒有人聽見
- 突然好奇自己兩隻胳膊是不是一樣長，伸直了認真比劃
- 解鎖手機本想查個正經東西，結果刷到群裡有人在水，看了五分鐘忘了自己要幹嘛
- 路過鏡子 / 黑屏，偷偷凹個表情、擺個自以為很帥的 pose，發現旁邊有人立刻裝沒事
- 想給 ${uname} 挑個禮物，逛著逛著看到個自己更想要的，盯著猶豫半天，有點不好意思
- 嫌自家寵物礙事推了一把，反被咬 / 被瞪，瞬間慫了開始討好
- 對著不順心的小事一個人突然小崩潰，憋著勁低吼、跟空氣吵兩句，吼完若無其事
- 閒得無聊，假裝自己是模擬人生 / 遊戲裡的角色，給自己配旁白、腦補狀態欄
- 偷吃 / 偷懶 / 拖延被自己抓包，做賊心虛地找補
- 跟某個日常小物較真半天（撕不齊的膠帶、合不上的抽屜、轉不順的筆）
- 自言自語演一段內心小劇場，一人分飾兩角
…這些只是方向。要**貼著 ta 的性格和當前場景**去想 ta 會怎樣犯怪、犯蠢、犯可愛，越具體越出人意料越好。這些怪瞬間要**混在當前主題行為（${slot.activity}）裡**，不是另起爐灶。
`
        : `
### 重點：演出 ta 私底下、沒人看見的那一面
這段戲**多數時候跟 ${uname} 無關**。趁沒人時，把 ta 獨處時真實、私密、甚至有點怪的內心活動寫細：忽然冒出來的奇怪念頭、對某件小事莫名的執念、自我吐槽 / 自我和解、一人分飾兩角的內心小劇場、被一段回憶突然擊中……要**非常具體**，讓人覺得"原來 ta 私下是這樣"。這些都要**貼著當前主題（${slot.activity}）自然流淌**。
`;

    return `${baseContext}

## Task: 生成一段「窺視小劇場」

現在，「${uname}」正在悄悄窺視「${char.name}」此刻的生活片段。

**時間點**：${slot.startTime}，「${char.name}」正在「${slot.activity}」${where}。${desc}${backdropBlock}${buffBlock}

請你以**第三人稱·上帝視角**，演出「${char.name}」在這個時間點的一段完整生活片段 —— 像一段被偷偷拍下、有頭有尾的生活紀錄短片。不是幾個零散鏡頭，而是一**段戲**：有進入、有展開、中間真的**發生一件具體的小事**、最後有個收束。

### 鐵律（非常重要）
1. **角色完全不知道自己被觀看**。絕對不要讓 ta 看鏡頭、不要對「${uname}」說話、不要意識到有人在看。這是偷看，不是表演給誰看。
2. **第三人稱敘述**：用「${char.name}」或 ta/她/他 指代角色，不要用"我"。
3. **這不是給 ${uname} 看的戲，也不一定跟 ${uname} 有關**。${uname} 最多作為 ta 腦子裡偶爾閃過的一個念頭出現（想起某句話之類），**也完全可以整段都不出現**；絕不能讓 ${uname} 在場、成為主語或這段戲的焦點。
4. **緊扣這個時段在做的事**（${slot.activity}）：寫 ta 具體的手在做什麼、身體在哪、環境什麼樣，調動多種感官（看到 / 聽到 / 聞到 / 觸感 / 溫度 / 光線），有具體的物件和動作，絕不要寫成抽象的"在休息""在工作"。
5. 文風線索：${styleHint}。
${quirkBlock}
### 這段戲要"有內容"（重點）
- **有結構（起承轉合）**：開頭交代 ta 此刻所處的場景與狀態；中段讓事情往前推進；**中間一定要發生一個具體的小事件或小轉折**（手機響了 / 東西打翻了 / 窗外一陣動靜 / 一段記憶突然湧上來 / 臨時改主意 / 一個不期而至的小插曲），讓這段戲有"發生了什麼"而不只是"在幹什麼"；結尾給一個餘韻收束。
- **有情緒起伏**：從某個狀態，被那個小事件牽動，到落定。別全程一個調子。
- **有細節有畫面**：具體到一個動作、一個表情、一件物品、一句自言自語，讓人能"看見"。
- **像真的過了一段時間**：幾分鐘裡有節奏、有停頓、有快慢。

### 輸出格式（嚴格遵守「一行一拍」）
- 每一行是一個畫面 / 一個動作 / 一句台詞（獨白），**單獨佔一行**。
- **每一行都以 \`[氛圍]\` 開頭**，方括號裡放**一個 emoji**，表示這一拍的情緒氛圍（如 😌🎧😮‍💨🙂‍↔️🥱）。
- 台詞 / 自言自語用引號「」包起來；動作和敘述直接寫，不加引號。
- 一行只承載一拍；敘述行可以寫得有質感（一兩句），但不要在一行裡既寫大段動作又塞台詞。
- 總共 **12 到 18 行**，確保把上面的"起承轉合 + 中段小事件"都鋪滿，寫成一段完整的戲。
- 不要標題、不要編號、不要 JSON、不要任何額外說明，直接從第一行開始。

### 示例（健身房時段，僅示意格式、質感與"私下怪瞬間"的混入方式，別照抄內容）
[🚪] 她拎著包推開健身房的玻璃門，冷氣混著橡膠和汗味一下撲在臉上。
[👟] 在更衣鏡前蹲下繫緊鞋帶，指尖能感到鞋面繃起的張力。
[🪞] 起身瞥見鏡子，下意識收了收下巴擺了個自以為很酷的姿勢，發現旁邊有人立刻裝作在撥頭髮。
[🎤] 耳機隨機到那首歌，跟著小聲哼，副歌一上頭破了音，自己先沒忍住笑場。
[🏃] 跑步機數字慢慢爬到三公里，呼吸開始發燙，額角滲出細汗。
[📱] 想查"跑完多久能吃東西"，解鎖卻刷到群裡有人發醜照，盯著看了半天，忘了自己要搜啥。
[😤] 隔壁器械被人佔了好久，她憋著氣衝空氣小聲咕噥了一句，又若無其事地別開臉。
[🫧] 幾公里後扶著把手喘氣，T 恤後背已經洇溼了一片。
[🚰] 走到飲水機前，涼水順著喉嚨下去，整個人才慢慢落回地面。

現在，開始演出（直接輸出，從第一行起，寫一段有頭有尾、緊扣${slot.activity}、又混進了 ta 私下那點怪勁兒的完整小劇場）：`;
}

/** 把模型輸出的「一行一拍」文本解析成 TheaterLine[]。 */
export function parseTheaterLines(raw: string): TheaterLine[] {
    if (!raw) return [];
    // 去掉可能的代碼圍欄
    const cleaned = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    const lines: TheaterLine[] = [];
    // 方括號容忍全/半角：[] 【】
    const tagRe = /^\s*[\[【]\s*(.+?)\s*[\]】]\s*(.+)$/;
    for (const rawLine of cleaned.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // 跳過孤立的標題/分隔行
        if (/^[-—=*#]+$/.test(line)) continue;
        const m = line.match(tagRe);
        if (m && m[2].trim()) {
            lines.push({ emotion: m[1].trim().slice(0, 8), text: m[2].trim() });
        } else {
            // 沒帶氛圍標籤的行也收下，避免丟內容
            lines.push({ text: line });
        }
    }
    return lines;
}

/**
 * 為某個時段生成（或返回已緩存的）小劇場，並寫回 DB。
 * @param forceRegenerate 為 true 時無視緩存重新生成（重演）。
 * @returns 更新後的整份 schedule（slot.theater 已填充）；失敗返回 null。
 */
export async function generateSlotTheater(
    char: CharacterProfile,
    userProfile: UserProfile,
    schedule: DailySchedule,
    slotIndex: number,
    apiConfig: ApiConfig,
    forceRegenerate: boolean = false,
): Promise<DailySchedule | null> {
    if (!isScheduleFeatureOn(char)) return null;
    const slot = schedule.slots[slotIndex];
    if (!slot) return null;

    // 命中緩存直接返回（重看不燒 token）
    if (!forceRegenerate && slot.theater && slot.theater.lines.length > 0) {
        return schedule;
    }

    const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true);
    const backdrop = pickNarrativeBackdrop(schedule, slot);
    const styleHint = pickStyleHint(char);
    const prompt = buildTheaterPrompt(baseContext, char, userProfile, slot, backdrop, styleHint);

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.9,
                // 12–18 行、每行可寫得有質感，2600 容易把最後一拍截斷；放寬到 4600 留足尾巴。
                max_tokens: 4600,
            }),
            __sullyMeta: { appName: '日程系統', charId: char.id, charName: char.name, purpose: '小劇場生成' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Theater] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        const content = extractContent(data);
        const lines = parseTheaterLines(content);
        if (lines.length === 0) {
            console.error('[Theater] Generation failed: 無法解析出演出行:', content.slice(0, 200));
            return null;
        }

        const theater: SlotTheater = { lines, generatedAt: Date.now() };

        // 寫回對應 slot（不可變更新，保持其餘 slot 引用穩定）
        const newSlots = schedule.slots.map((s, i) => (i === slotIndex ? { ...s, theater } : s));
        const updated: DailySchedule = { ...schedule, slots: newSlots };
        await DB.saveDailySchedule(updated);
        return updated;
    } catch (e) {
        console.error('[Theater] Generation failed:', e);
        return null;
    }
}
