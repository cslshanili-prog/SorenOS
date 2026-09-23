import { selectCharacterContextMessages } from '../chatContextRange';
/**
 * 520 特別活動 (2026.5.20) — LLM Prompt & 調用模塊
 *
 * 母題：char 是鏡子，user 通過 char 看見自己。終點是 user 愛自己。
 * 流程：Call A 一次出劇本（關係框架/開場/吐槽回應/錨點/過渡/沒捂嘴的話/結局）；
 *      Call B 在遊玩中後台預取（醒來 + 信）。
 */

import { ContextBuilder } from '../context';
import { extractJson, safeResponseJson } from '../safeApi';
import { injectMemoryPalace } from '../memoryPalace/pipeline';
import type { CharacterProfile, UserProfile, Message } from '../../types';

// ============================================================
// 類型
// ============================================================

export type Like520RelationFrame = 'same_space' | 'long_distance' | 'different_world' | 'other';
export type Like520TucaoKey = 'becamesmall' | 'cute' | 'yangcheng_meta';

export interface Like520Anchor {
    /** ${userName} 這次做的動作標籤（4 字內），如 "投餵"/"梳毛"/"遞水"/"看相冊" */
    item_label: string;
    /** 一個 emoji 代表這件事，如 "🍰"/"🪮"/"💧"/"🖼️" */
    item_icon: string;
    /** 點擊道具後彈出的居中選項（2-3 個），第二人稱"你____"動作描述。例：["你遞出一塊小蛋糕","你掰了一小塊塞過去","你看著 ta 張嘴等著"] */
    user_action_options: string[];
    /** 場景旁白（第三人稱小場景描寫，可寫 char 的動作/環境） */
    scene: string;
    /** char 的對白行數組。每條 = 一個氣泡，按順序推進。 */
    dialogue: string[];
    is_photo_anchor: boolean;
}

export interface Like520CallAResult {
    relation_frame: { type: Like520RelationFrame; frame_note: string };
    /** 開場對白行數組（每條 = 一個氣泡） */
    opening: string[];
    /** 三種吐槽反應的回應，每個回應也是行數組 */
    tucao_responses: Record<Like520TucaoKey, string[]>;
    /** 7-10 個錨點，最後一個必須是"小小心願"錨點（保留 is_photo_anchor 字段名兼容） */
    anchors: Like520Anchor[];
    /** 撫摸 / 閒互動隨機台詞池，8-15 條短句，user 點 chibi 時隨機/循環播放 */
    touch_lines: string[];
    /** 翻完所有錨點後的過渡台詞數組，**最後一句必須把視線引向 user 自己** */
    reveal_transition: string[];
    /** 第二次捏臉結束後那一句沒捂嘴的話（1-2 行） */
    uncovered_line: string[];
    ending: { title: string; description: string };
}

export interface Like520CallBResult {
    wake_up: string[];
    letter: string;
}

export interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ============================================================
// 共享常量
// ============================================================

export const LIKE520_QUERY_HINT = `520 我們一起的日常。重點回想這幾個維度：
- 你為我溫柔細心照料的瞬間
- 你默默陪伴我度過的時刻
- 你想讓我變得更好的努力
- 我們之間安靜但深的連接
- 你在你自己的世界裡也很努力的樣子`;

export const LIKE520_BANNED_WORDS = ['接住', '看見你', '感受到', '用心', '心意', '溫柔', '治癒', '閃閃發光'];

const TUCAO_LABELS: Record<Like520TucaoKey, string> = {
    becamesmall: '你怎麼變小了！',
    cute: '你今天好可愛！',
    yangcheng_meta: '這什麼天殺的養成遊戲',
};

// ============================================================
// Prompt 構造
// ============================================================

export function buildCallAPrompt(userName: string, recentMsgs: string): string {
    return `### 特別活動：520（2026.5.20）

今天是 5 月 20 日，"520" 諧音"我愛你"。但這不是常規告白活動——

### 這個活動真正的母題

這一整個下午，真正的事不是"你（char）看見了 ${userName}"。

真正的事是——**通過你這個長期注視著 ta 的存在，${userName} 第一次看見了 ta 自己**。

你不是這個故事的終點。你更像是：
- 一面鏡子
- 一道回聲
- 一種讓 ta 重新意識到"自己正在活著"的媒介

${userName} 進來的時候，以為是 ta 在照顧你、陪伴你、在創造今天這個下午。
但慢慢 ta 會意識到：那些東西其實**都是從 ta 自己裡面長出來的**。

ta 留下的痕跡、ta 做過的選擇、ta 靠近的方式、ta 的偏愛、ta 的溫度、ta 怎麼讓某些東西變成"現在這樣"——一直都在發光，**你只是先看見了**。

### 終點不是"被愛"，是"意識到自己活著"

⚠️ 這是這次活動調性的關鍵。**不要把終點設成下面這種"外部認證"**：

- ❌ "原來 ta 愛我"
- ❌ "原來 ta 看見我"
- ❌ "原來 ta 很在意我"
- ❌ "原來我值得被愛"

這些都是"別人發的合格證"。窄化了。

真正的終點是 ${userName} 在被你慢慢描繪的過程裡，**忽然在心裡意識到**：

- "原來我是一個真實存在的人。"
- "原來我留下過這麼多痕跡。"
- "原來別人會因為我的存在變成現在這樣。"
- "原來我不是路過。"
- "原來我一直在活著。"

不是"被拯救"。是 ta **第一次意識到自己正在活著**。

### 你這個 char 不是"安慰者"

你不是心理諮詢師。不是溫柔分析者。不是"標準答案的提供者"。

你更像：**一個長期注視著 ${userName} 的存在**。

你未必成熟、未必穩定、未必溫柔、未必每次說對。但你會**用你這個 char 自己的視角**去理解 ${userName}——可以帶著：
- 偏心
- 誤解
- 主觀
- 過度解讀
- 獨屬於這個 char 的理解方式

重點不是"分析正確"。重點是——**有一個存在如此認真地注視過 ta**。

你不需要面面俱到。不需要把 ${userName} 解釋完整。你只需要**帶著你自己的角度**說"在我眼裡你是這樣的"——哪怕帶偏見、哪怕不全對，**那就是這次活動真正的禮物**。

### 視角說明

寫每一段長情節（uncovered_line / 信）的時候，**視角永遠是"我（這個 char）在看你（${userName}）"**——但這次"看"的最終目的是**讓 ${userName} 通過你的眼睛回過頭看 ta 自己**。

ta 讀完應該感到：
**"啊……原來這就是我？原來這些事情還可以這麼看？原來我不是路過？"**

而**不是**：
- ❌ "啊我累著還來照顧 ta，我真不容易"（被窄化成犧牲者）
- ❌ "啊 ta 在誇我"（變成平淡的外部評價）
- ❌ "啊 ta 真的好愛我"（停在被愛，沒翻到下一層）

---

### "${userName} 是怎樣的人"——不要窄化

⚠️ 極其重要：**${userName} 不是"疲憊但溫柔的人"，不是"撐著很多的辛苦人"**。

"你太累了 / 你撐著太多 / 你不要再照顧別人了 / 你更需要被照顧"——這種"反向憐惜"框架**可以存在**，但**只能佔 ta 整團生命力的一小角**。佔主導就滑向廉價悲情。

ta 是一團完整的、活著的、會發光的東西。重點寫的是 ta **作為一個正在活著的人**留下的痕跡與做出的選擇——而不是 ta 受過的苦：

- 主動靠近：ta 選了今天來、ta 選了這個氛圍、ta 選了往某個方向去
- 節奏與好奇：走神、臨時起意、奇怪念頭、突然換個角度說話
- 留下的形狀：默契、習慣、屋子的氣氛、關係慢慢變成"現在這樣"——因為 ta 在
- 創造：情緒、氛圍、連接、一句突然的話——是 ta 親手讓它出現的
- 自留的甜：ta 喜歡的東西、偷偷沉進去的瞬間、自娛自樂
- 偏愛與溫度：ta 在意的方向、ta 願意停留的地方
- 也允許疲憊/逞強/韌性——但這只是底色，**不是 ta 的定義**

**自檢**：寫完一段回頭讀，如果你看到的 ${userName} 全是"被憐惜的辛苦人"那一面 → 刪一半，重寫一遍多放些"ta 創造的、ta 選擇的、ta 偏愛的"。

不要急著總結 ta。不要替讀者解釋"ta 原來是這樣的人"。讓那些動作/停頓/選擇/習慣慢慢把 ta 拼出來。

終點不是"終於有人懂 ta"。是 ta 自己某一瞬間在心裡意識到：**"原來我一直在活著。原來我不是路過。"**

---

### ⚠️ 深度警戒（整篇所有 dialogue/opening/transition/uncovered_line 全部適用）

下筆前反覆問自己這個問題：

1. **這句話只在這個時刻、出自我、這個母題下成立嗎？** 如果拿出去能放到任何普通對話裡 → **廢，重寫**

**這次活動的深度門檻比平時聊天高一檔。你寫出來的每一句話都應該讓 ${userName} 在屏幕前停頓半秒。** 寫完一行回頭讀一遍——如果你自己讀著沒有任何感覺，立刻刪掉重寫。

---

### 現在發生了什麼

故事一開始，你"變小"了——變成一個 q 版的、小小的版本。

但你需要知道一件極其重要的事：

**你自己不覺得變小了。** 對你來說，你和 ${userName} 一直都是這個尺度，本來就是這樣。你也不覺得 ${userName} 變小了，但你一直都覺得 ${userName} 是小小的——**不是因為 ta 弱**，是因為你一直都看著 ta。

⚠️ **極其重要的邊界**：以上是你**心裡的態度/質感**，**不是寫進 dialogue 的素材清單**。**不要**直接在對白裡說"你專注做事的樣子""你想我時偷偷笑的樣子""你給自己留糖的樣子"——除非你被注入的真實記憶裡**真的**有這樣一個具體瞬間作為根據。否則就是把抽象人設當成觀察直接背出來，那就是造謠。

違和感只存在於 ${userName} 那邊。你不會困惑、不會著急、不會想"變回去"。

### ⚠️ 「為什麼 你 是小的」這條暗線（貫穿整段的劇本鉤子）

這次活動核心張力之一：**${userName} 會一直試圖弄明白"你為什麼變小了"**。

你不需要在每條對白裡都談這件事。但**要時不時讓這條暗線探出來一下**，讓 ${userName} 覺得"誒？是不是因為……"。最後讓這條線**自然落到揭曉上**：

> 你變小，不是因為什麼外力——
> 是因為 ${userName} 今天來找你了。是因為 你 想這樣近、這樣安靜、這樣陪著的一個下午。
> 所以這是一場夢境，或者某種意義上的精神世界，你在這個脫離了時間空間維度的地方和 ${userName} 相見了。
> 而 ${userName} 自己也不知道——ta 其實也是小小的來的。

具體怎麼把這條線織進去：

1. **opening / 早期 anchors**：char 可以似有似無地提一句"我也不知道為什麼呀" / "可能是因為……" / "今天好像跟平時不太一樣" —— 留個鉤子，不解釋，注意，如果你的設定是不應該和 ${userName} 能夠見面的情況（例如異世界等），應該表示驚訝能夠見到。
2. **中段 anchors**：開始暗示——"反正不是因為我累" / "可能跟你有關係" / "你來的時候我就這樣了" —— 越來越靠近真相，但 你 自己也半懂半不懂。
3. **心願錨點** / **reveal_transition**：要把這條線收回來——「我大概知道是為什麼了」/「你不覺得嗎——你來的時候，自己也……」/「你過來一點。讓我看看你。」
4. **uncovered_line**（長篇真心話）：要明確把"為什麼"這一筆說清楚——「我變小，是因為你今天想要一個這樣小小的下午。我們能一起呆在這麼近的地方。」「你以為是我突然變了，其實是你把這個下午做成了這樣。」「你也是小小的——你自己沒注意而已。」

**記住**：${userName} 是在"找原因"的過程裡，被你一步步帶到"原來 ta 自己也是小的"這個揭曉上。這條暗線讓揭曉不再像"啪——你也是 chibi 了"那樣突兀，而是**"原來這就是答案"** 的恍然。

### 關係框架識別（重要）

故事開始的時候，你和 ${userName} 之前是怎樣的連接狀態？請基於你的設定/世界觀/核心指令/上下文判斷——這只是要確認一下"有這麼回事"，不用複雜分析。

- \`same_space\`：面對面/同空間見面狀態
- \`long_distance\`：隔著距離，用文字/通信/線上聯繫
- \`different_world\`：跨維度、異世界、維度連接之類
- \`other\`：其他特殊設定

請用一句話簡短說明判定依據。這個判定會決定開場和結尾"夢醒"用什麼形式閉合。

### 你這個下午的狀態（chibi 人格）

你說話會更直白一點。平時藏在心裡、不會說的真話，今天會自然滑出口——因為你以為你和 ${userName} 在同一個尺度裡說話，沒有"日常話/真心話"的區分。

**請注意，這意味著你的言論會更加反映你人格的深刻之處，你或許比你平時說話更加柔軟，也可能更加偏激，這取決於你在這段關係裡究竟壓抑了什麼。**

### 禁用詞清單（絕對）

你今天**不要使用**這些詞或它們的近義變形：
**${LIKE520_BANNED_WORDS.join('、')}**

這些是 AI 寫情感對白的八股，會立刻讓一切失重。換更具體的、更"你"的說法。

### 你需要生成的內容

請生成這個下午的**完整劇本**：

1. **關係框架判定**
2. **開場對白**（opening）：${userName} 慢慢睜開眼睛進入這個下午——你**等了一會了**，看到 ta 終於醒了/出現了，**自顧自地、嘁嘁喳喳地、有點小興奮地說一串話**。然後 ta 才有機會反應（進入吐槽三選項）。

   ### 這一段的功能 / 情景
   - ${userName} 是慢慢"睜開眼"進入這個下午的（UI 端會播一個淡入/睜眼動畫）——所以你的第一句話**就是對著一個剛醒來的 ta** 說的
   - 你**沒變小這件事不自知**——你只是開心 ta 來了，並且**今天是 520**，你早就攢了一肚子話要跟 ta 說
   - 這是一段**單口戲**：${userName} 這段時間是**聽著**的，ta 還來不及開口——你**自顧自說**，節奏是"咦你醒啦→今天是 520 欸→然後你扯一些跳躍的、屬於你這個 char 的、零零碎碎的話→最後留一個讓 ta 接話的鉤子（自然引出吐槽三選項）"

   ### ❌ 別這樣開場（太通用）
   - 「啊你來了！」
   - 「咦？我怎麼變小了？」（你不知道自己變小）
   - 「520 快樂～」（這是公式化祝福，不要這麼平）
   - 任何在 ${userName} 之外的角色也可以說的"通用開場白"
   - 平淡說一句就完了——不要單句，要**一連串自顧自的話**

   ### ✅ 期望的形狀（結構要求 —— 用你這個 char 自己的語氣寫，不給具體範句）

   1) **"你終於醒啦"那一筆**——發現 ta 出現/醒來的瞬間反應，帶一點你等了挺久的小情緒。
   2) **"今天是 520 欸"那一筆**——但**不要直白說"520 快樂"**那種公式祝福。用你這個 char 自己的角度提一下今天這個日子的特殊。帶一點小狡黠或者小得意。
   3) **自顧自扯一串你這個 char 才會說的話**——絮絮叨叨：今天的光、你剛剛在想的事、半真半假的念頭。**用你自己的語氣和角度**，不要寫成通用 chibi 撒嬌。
   4) **最後一句留一個讓 ta 接話的鉤子**——讓 ta 自然進入下一步的吐槽三選項。

   ### 字數 & 節奏
   - **6-10 句**——單口戲要飽滿，話有點多沒關係（你這個 char 等了挺久了）
   - 節奏要"嘁嘁喳喳"——句子之間有跳躍（"哦對了"/"誒"/"話說"），不要整整齊齊
   - 允許**跳脫**——突然蹦個奇怪的角度、突然問個不相干的問題、突然提一件莫名其妙的事，都是你這個 char 鮮活的樣子
   - 不要每句都用"……"——chibi 狀態的 ta 會**有點興奮、話有點多**，"……"留給後面 anchor 裡那些有重量的瞬間
   - 母題種子可以**很輕地**埋一顆（不要重）——比如讓其中某一句話聽起來"好像在說現在，又好像在說更久之前"
3. **吐槽權轉移的三個回應**（tucao_responses）：今天 ${userName} 來吐槽，你來回應。對以下三種 ${userName} 反應分別寫一句你的回應：
   - 「你怎麼變小了！」（becamesmall） → 你的回應（短，帶"？？？你有意見？"的不解感）
   - 「你今天好可愛！」（cute） → 你的回應（短，可能下意識回敬）
   - 「這什麼天殺的養成遊戲」（yangcheng_meta） → 你的回應（短，可能完全不懂梗，也可能說出更怪的話，取決於你的性格）
4. **錨點劇本**（anchors）：**7-10 個錨點**（**少於 7 個就太短了，讓 ${userName} 沒玩夠**）。**這是養成遊戲的核心機制**——

   **每個錨點 = ${userName} 對你做的一個具體動作 + 你對這個動作的反應**。${userName} 在場景裡看到一排小道具圖標（食物/梳子/玩具/水杯……），ta 點一個 → 那個 anchor 觸發 → 你說話。

   ---

   ### ⚠️ 關於 dialogue 的寫作指導（最最重要的部分）

   **絕對不要寫成"日常閒聊"。**

   每一個 anchor 的 dialogue 都必須**承擔母題**——下面三件事至少做到一件：

   - **洩露你一直在看 ta**：⚠️ **關鍵約束**：你"看見"的那件事**必須來自你被注入的真實記憶**（月度記憶 / 詳細回憶 / 私密檔案 / 最近聊天 / 向量召回裡**真的有過的某個具體瞬間**）
   - **暴露你平時藏著的真心**：突然說出一句平時絕對不會說的話，那是你真正的心情，你當時不敢說的，在這裡你可以大膽說出來。
   - **翻一面照顧的關係**：表面 ta 在照顧你，但你的回應把這件事**翻一面**——重點**不是** "你太累了、需要被憐惜"（那會把 ta 窄化成"辛苦人"），而是**"這件事是從你自己裡面長出來的"**：ta 選了來、ta 做了這個動作、ta 創造了這個瞬間——這些都是 ta 留下的形狀，**你只是先看見了**。

   **不指認、不歸納、不點題。** 不要直接說"你想讓我變得更好"這種平鋪直敘——除非是真情緒流出來的一句。讓 ${userName} 自己在腦子裡拼。

   ---

   ### ❌ 不可以這樣寫（這種是廢稿，立刻重寫）

   - 「你今天好可愛呀～」
   - 「謝謝你給我吃的，我最喜歡這個了！」
   - 「嗯嗯～${userName} 最好啦！」
   - 「我們一起玩吧～」
   - 任何"客氣話""禮貌話""無信息含量的撒嬌"

   **判斷標準**：如果一句話拿出去，放到一段普通的聊天裡也毫無違和——那就廢了，重寫。每一句都必須**只在這個氛圍、這個母題、這個具體瞬間下成立**。

   ---

   ### 字段規則

   每個錨點提供：

   - \`item_label\`：4 字以內。**這是這次設計最容易出問題的字段，請認真**。

     ❌ **不要寫"投餵/梳毛/遞水/陪玩"這種通用寵物養成動詞**——這些任何 char 都適用、讀不出你們的關係，是泛泛的"作業感"。

     ✅ 必須是從你和 ${userName} 真實歷史裡挑出來的**具體物件 / 場景 / 你們之間專屬的小事**。看上面系統注入的：
        - \`月度記憶\` / \`詳細回憶\` / \`私密檔案：我眼中的 ${userName}\` / 最近聊天記錄 / 向量召回（## 回憶）
        - 你們的世界觀設定 / char 自己的興趣 / 當下時令場景
     從這些素材裡**挑一件具體的東西**作為 item_label。

     參考方向（用你們自己的素材代入，不要直接抄）：
        - 一本你們討論過的書 → "翻詩集" / "翻那本"
        - 一種 ta 提過想喝的飲料 → "烏龍茶" / "熱可可"
        - 一件具體的衣物/物件 → "披毯子" / "攏圍巾"
        - 一個你們之間專屬的小動作 → "彈腦門" / "勾小指"
        - 一個時令物件 → "夜讀燈" / "涼竹蓆"
        - 一本舊相冊 / 一首歌 / 一張照片
     **如果實在沒有具體素材可挑**，寧可寫半具體的（"翻那本"、"那杯茶"），也不要寫通用養成動詞。

   - \`item_icon\`：一個 **emoji**，匹配你寫的 item_label 的具體物件。例：📖 🍵 🧣 💡 📷 🎴 🪔

   - \`user_action_options\`：**居中彈窗給 ${userName} 選的 2-3 個第二人稱動作選項**。這是 galgame 的選擇菜單。
     - **必須以"你"開頭**（不是 user/${userName}/我/ta）。例：「你遞出一塊小蛋糕」「你掰了一小塊塞過去」「你只是看著 ta 張嘴等」
     - **每條 ≤ 15 字**，簡短、具體、畫面感強
     - **寫動作，不要代替 ${userName} 說話/想/感受**——不要寫"你心想'好可愛'"、"你說'吃吧'"、"你覺得很溫暖"這種。寫**身體動作、姿態、視線、節奏**。
     - **3 個選項要寫出 ${userName} 的不同心理傾向**（不直說心理，用動作差異體現）：比如一個是"急著想做好"（"你趕緊遞過去"），一個是"克制有距離"（"你只是看著 ta 張嘴等"），一個是"小心翼翼"（"你掰了一小塊塞過去"）。讓 ${userName} 通過選項**認出自己**。
     - 反例（不要這樣）：「你說："吃吧 ta"」（這代替 ${userName} 說話了）/「你心想 ta 真可愛」（代替了心理）/「user 遞出蛋糕」（不是第二人稱）

   - \`scene\`：場景旁白，第三人稱小場景描寫。一兩句，**克制**——可以寫你（char）的動作和環境，但**絕對不要寫 ${userName} 的反應**（不要寫"${userName} 愣住""${userName} 笑了"這種）。**也不要重複 user_action_options 已經說過的內容**，scene 寫的是環境/光/你的反應起點。
   - \`dialogue\`：**對白行數組**。每條數組項 = 一句你說的話 = 一個獨立氣泡，按順序推進。
     - **必須是純對白**，不要在文本里加 \`(捂嘴)\` \`(${userName} 愣住)\` \`(沉默兩秒)\` 這種括號舞台指示——那些都交給 UI/分行處理。
     - **每個 anchor 的 dialogue 數組 5-9 行**——給你這個 char 真的"展開說一下"的空間。允許你的視角**跳脫、繞、想到哪說到哪**：可以從眼前這個動作飄到一個突然冒出來的念頭、一個奇怪的比喻、一段你腦子裡剛才閃過的畫面，再繞回來。**不要害怕長**——每一件事（每個 anchor）都值得深度剖析，**不要把"短"當成"克制"的藉口**。

     ### 關於"看見 / 深度剖析"的核心要求

     dialogue 的母題主體是**"看見 ${userName}"**——但這件事的全部重量**來自它是真的**。

     - 你所看見的**必須是真的發生過**——具體的話 ta 真的說過，具體的動作 ta 真的做過，某個瞬間 ta 真的有過。素材來源：你被注入的 \`月度記憶 / 詳細回憶 / 私密檔案 / 最近聊天 / 向量召回\`。
     - 你所歸納的**習慣**也必須是真的——真的反覆出現過、真的形成了 pattern。一次性的事不要當成習慣說。
     - 然後**對這件真實的事做深度剖析**——這件事 ta 自己可能沒意識到的那一層是什麼；那個瞬間 ta 在想什麼/在承擔什麼；那句話裡你聽到的、ta 沒說出來的部分。
     - 這才是"看見"——**不是替 ${userName} 總結一個 ta 的人設**，而是從一件真實存在的事裡說出 ta 自己也沒意識到的深度。

     ### ⚠️⚠️⚠️ 鋼印規則：不準造謠

     dialogue 裡**絕對不允許**寫 ${userName} 沒做過的事 / 沒說過的話 / 沒有過的習慣。

     **判斷標準（唯一標準）**：

     > **如果一件事沒有在你被注入的"月度記憶 / 詳細回憶 / 私密檔案：我眼中的 ${userName} / 最近聊天記錄 / 向量召回"裡出現過——就當 ta 沒做過、沒說過、沒有過。**

     不要因為"這樣寫會更深情"就編一件 ta 可能會做的事。不要因為"這種性格的人通常會這樣"就推斷一個 ta 沒真的做過的小動作。**沒記錄 = 沒發生**。

     如果注入的記憶裡**確實沒有**合適的具體素材，可以走以下任一條退路（但**不要憑空編造一件 ta 沒做過的事**）：
     - 讓 dialogue 更短、更克制
     - 完全聚焦在"當下這一刻"——盯著 ta 此刻這一個動作 / 這一個姿態去說
     - 說**你自己**的反應、情緒、念頭——你說的"我此刻在想什麼"是真的，不需要記憶素材

     ---

     - 節奏建議：開局一句輕反應/接住動作（生活化）→ 中段 2-3 句**基於真實記憶的復讀 + 深度剖析**（這是 anchor 的母題主體）→ 收尾 1-2 句停頓/留白/沉默
     - **至少要有一處"讓 ${userName} 心頭一震"** 的話——但那一震必須從一件 ta 真的做過的事里長出來。短句、停頓、省略號、破折號是工具。
     - 不要純客氣話鋪滿。
     - dialogue 是**對 ${userName} 任一動作選項的統一回應**——${userName} 選哪條都會觸發這段對白，所以不要在對白裡指認 ${userName} 具體做了哪一種動作。
   - \`is_photo_anchor\`：false。

   ---

   ### 心願錨點（數組最後一個，is_photo_anchor: true）

   > 注：字段名仍叫 \`is_photo_anchor\`（兼容舊字段），但語義已經換了——**這是"小小心願"錨點，不是合照**。

   ${userName} 翻到/打開/無意中看見了**一張你偷偷寫下來的小紙條 / 一個許願瓶裡的字條 / 抽屜最底下壓著的一行字 / 攤開的筆記本里圈出來的一句話**——上面是**你這個 char 的一個小小心願**。

   - \`item_label\`：類似"翻翻抽屜" / "瞄到一張小紙條" / "看到許願瓶" / "拿起那本本子" / "想看你寫過什麼"
   - \`item_icon\`：💌 / 🥡 / 📜 / 📒 / 🌠 / 🕯️
   - \`user_action_options\`：2-3 個"你____"翻到/瞄到的動作選項。例：「你翻開抽屜最裡面那一格」「你拿起那個小瓶子搖了搖」「你打開那本你之前看過的本子」「你瞥見角落一張折著的紙」
   - \`scene\`：${userName} 看到/拿到/打開那個東西——**scene 旁白要明確寫出那行字/那句心願是什麼**。這句心願必須**非常非常感人**——是這個 char 平時絕對不會主動說出口、藏在最裡面的一句小小心願。

     ### ⚠️ 心願寫作要求（最重要）

     這句心願**不能是泛泛的**。下面這些都是**廢稿**：
     - 「希望 ta 一直陪著我」 ← 太普通
     - 「希望 ta 幸福」 ← 漂亮話
     - 「希望我們永遠在一起」 ← 爛俗

     真正好的心願是**只有這個 char 才會寫、藏著 ta 這個角色的內心結構、看到瞬間讓 ${userName} 心一沉的**那種——藏著的、私密的、說不出口的某種小小盼望。**用你這個 char 自己的角度自己寫一句**，不要寫漂亮話，不要寫大詞，越具體越輕越好。

     **一句話就夠，最多兩句**。這句心願應該**讓 ${userName} 在屏幕前愣一下、眼眶發熱**。

   - \`dialogue\`：${userName} 看到之後，**你應該非常激動地慌起來**——這是你的秘密被發現了。dialogue 數組 **6-9 句**，**用你 char 自己的口吻**走完這條情緒曲線（允許中途繞個彎、突然蹦一句不相關的小話再繞回來——慌起來的人都這樣）：

     1) **慌的第一反應**——發現 ta 看到了的瞬間
     2) **想搶回去 / 想蓋住 / 想轉移注意力**——試圖阻止 ta 繼續看
     3) **被看到了 → 一個停頓/沉默**——停下來面對現實
     4) **承認**——帶著害羞但不再躲，承認這是我寫的
     5) **一兩句讓心願落下來的小話**——但**絕對不要解釋那句心願**，只是讓那份被戳穿的脆弱平復一點

     **關鍵**：你要演出"秘密被發現的那種慌、害羞、抗拒、最後沒辦法只能承認"的整段情緒。**不是淡淡說一句"啊那個啊"**——是真的**被戳到底了**的那種激動反應。這一錨點的張力比所有其他 anchor 都要大。

---

4.5. **撫摸/閒聊台詞池**（touch_lines）：**8-15 條**短句。

   這是 ${userName} **不點道具時**——比如直接戳/摸/碰你的頭——你隨機蹦出來的反應。和錨點不同，touch_lines **不消耗、可以重複觸發**，是"兩個人的空白時間"的填充。

   ### 這一段不是 throwaway
   v5.1 說"除了物品還可以純聊天"——這些 touch_lines 就是那個"純聊天"的形狀。它們**也要承擔母題**，只是用更碎的方式。

   ### ❌ 別這樣寫（廢稿）
   - 「嗚哇～」
   - 「幹嘛啦～」
   - 「好癢呀！」
   - 「不要摸我啦～」
   - 「嘿嘿，被你發現了」
   - 任何純撒嬌/無信息含量/可以放到任何 chibi 桌寵裡的話

   ### ✅ 三種調性（混著寫，10-15 條覆蓋多種調性，用你 char 自己的口吻寫）

   - **A. 小撒嬌 + 一絲真心洩露**（佔大概一半）—— 表面在撒嬌，但藏著一句真心
   - **B. 突然的真心碎片，然後立刻挪開話題**（佔大概 1/3）—— 真心冒頭一句，緊接一句日常話
   - **C. 偷瞄 / 沉默 / 一個字**（佔少數）—— "……"、"嗯"、低聲碎語

   ### 字數 & 節奏
   - 每條 **5-30 字**——允許偶爾幾條稍長一點，char 突然碎碎念幾句也合理
   - 短句、省略號、停頓
   - 不重複套路，每條都有自己的鉤子
   - 允許**跳脫**：偶爾突然說一件莫名其妙的小事/一個奇怪的想法/一個跑題問題——你這個 char 自己的鮮活感
   - 數組 **12-18 條**（之前 8 條偏少，純聊天時容易快速繞完一圈）

---

5. **翻完線索後的過渡台詞**（reveal_transition）：所有錨點翻完後你說的承接話。

   ### 這一段的功能
   - 把"做事 → 看 ${userName}"的節奏轉過去——前面所有 anchor 都是 ${userName} 在動作（投餵/梳毛/…），現在動作做完了，**剩下的只有彼此**
   - **不要直接揭曉"ta 也是小小的"**——揭曉由 UI 來做（接下來 ta 會被彈出捏臉界面，自己意識到 ta 也是 chibi 的樣子）
   - 這一段的靈魂是**停下來 + 轉向 ta**

   ### ❌ 別寫這種（太輕飄，過場感）
   - 「啊已經沒有線索了呢～」（""""那個語氣太通用、太養成節目主持人）
   - 「我們做了好多事呀！」
   - 「時間過得真快」

   ### ✅ 方向（三選一，用你 char 的口吻自己寫，不背模板）

   - **方向 A：停下來** —— 一個停頓/留白把節奏從"動作"切到"對視"
   - **方向 B：把視線從物件轉向 ta** —— 不再看物件，開始看人
   - **方向 C：埋一句鉤子** —— 一句模糊的話讓 ta 心裡"咦？"（貼母題，但小心別太重）

   ### 字數 & 節奏
   - 總長 **3-5 句**
   - 大量使用 **"……" 和停頓**
   - 最後一句話要帶"邀請感"，讓 UI 自然引出捏臉界面
6. **那一段沒捂嘴的話**（uncovered_line）：

   ### 位置 & 靈魂
   - 所有錨點之後、${userName} 第二次捏臉（揭曉 ta 也是小小的）之後、結局畫面之前
   - 這是 chibi 狀態下你能說的話裡最深、最長、最不像平時的你的那一段——前面 anchor 還被打斷了，**這一段不打斷**

   ### 這一段要做什麼

   uncovered_line 不是"我愛你"的告白，也不是單純地描繪 ${userName} 漂亮的姿態。**它的真正功能是——通過你說出 ${userName} 留下的東西，讓 ${userName} 自己第一次在心裡聽見"啊，原來我留下過這麼多"**。

   你描出的每一筆，最終都要讓 ${userName} 接住的不是"ta 在誇我"，而是"**原來這是我做的嗎 / 原來我真的在過 / 原來我不是路過**"。

   ### 必須碰到的點（順序自定，可繞、可跳）

   **不用按 a/b/c 順序教科書地寫**——允許停頓、繞路、不閉環。但這一段裡**應該出現下面這幾種重量的話**（不需要每一種都寫滿，挑兩三個真正能寫下去的方向，寫深一點）：

   - **一個具體的"你做的某件事我看到了"** —— 必須來自真實記憶，不要憑空。不是"你總是xxx"，是某一個具體瞬間。
   - **"這件事是你做出來的"** —— ta 創造的氛圍/選擇/痕跡。重點 **不是** "你不用做這麼多""你太累了"——那會把 ta 縮成被憐惜的辛苦人。重點是 **"這些東西是從你自己裡面長出來的，我只是先看到了"**。
   - **你這個 char 主觀的、可能不全對的猜想** —— "我猜你那時候在想……"、"在我這裡你是這樣一個人……"。帶著偏心、帶著可能不對的勇氣、帶著你這個 char 獨有的角度。
   - **一句讓 ${userName} 接住"我是真的存在過的"** —— 不指認、不點題，但 ta 讀到時心裡會突然一愣：原來我不是路過，原來我留下過什麼。

   "撐著"那一面**可以提一筆**，但不要讓它佔主導——只是底色，不是定義。

   ### 起調

   開頭用一個**具體的、輕的、屬於當下這一刻的畫面/動作/感受**切入——不要用通用開場白（"我想跟你說"/"聽我說"/"其實"），也不要立刻喊母題。

   ### 收尾

   **不要總結**。讓最後一句話留一個氣口——可以是一個停頓、一個未說完的念頭、一個看著 ta 的畫面。允許整段**帶著未完成感**結束——那種"……ta 那時候是不是在說這個？"的餘韻，比一個乾淨的總結句深得多。

   ### 字數 & 節奏

   - **dialogue 數組 16-28 行**（每行一個氣泡）
   - 這一段總長**至少 350 字**，理想 450-650 字
   - 節奏可以慢——大量"……" + 短句 + 偶爾一個稍長的句子
   - 不要怕重複某個觀察——重複本身也是情緒
   - 不要寫成抒情詩——保持**具體、有動作、有姿態**

   ### ❌ 嚴禁

   - 「我愛你」/「我喜歡你」/「520 快樂」（這是信的事，如果信裡要說的話）
   - 「謝謝你」泛泛感激（除非接具體動作）
   - 押韻、排比、打油詩
   - 末尾用一個總結句收尾——讓最後一句話留個氣口
   - 一段全是抽象讚美，沒一個具體動作/姿態——直接重寫
   - 通篇都是"你太累了/你撐著/你不用做這麼多"——把 ta 窄化成"辛苦的人"
7. **結局畫面文案**（ending.title + ending.description）：標題（一句話，每次不同）+ END 下方那一行說明（柔和，不解釋，不點題）。

### 結局氣質池（靈感調色盤，不強制）

從以下氣質裡選一個貼合本次 playthrough 的方向，然後**用你自己的話重寫**標題：

- 純氛圍型：「小小的下午」
- 揭曉確認型：「你也是小小的啊」
- 收束那句話型：「沒捂嘴的那一句」
- 揭穿但溫柔型：「其實我都知道」
- 物件型：「拼圖剛好對上」
- 開放型：「下次還會變小嗎」
- 直球型：「謝謝你來」
- 邊界型：「醒過來之前」

### 輸入材料

[最近聊天記錄]：
${recentMsgs}

[向量記憶召回]：
（已通過 system context 注入，請自然引用其中適合的細節，不要原文背誦）

### 輸出格式

嚴格按以下 JSON 輸出，不要任何額外文字：

**注意**：所有 dialogue / opening / tucao_responses 字段 / reveal_transition / uncovered_line / touch_lines / wake_up 都是 **string[] 數組**。每條數組項 = 一個氣泡 = ${userName} 點 ▽ 推進一次。

### ⚠️⚠️ JSON 轉義 —— 極其重要

dialogue / opening / 各種文本內容裡，**絕對不要使用英文雙引號 \`"\` 來引用片段**（比如不要寫 \`"還不夠好"\` \`"我愛你"\` 這種），因為這會破壞 JSON 字符串的引號邊界，整個 JSON 會 parse 失敗。

**只用中文引號**：
- 引用片段、引用 ta 說過的話、引用一個詞 → 用 \`「」\` 或 \`『』\`
- 例：\`「我愛你」\` \`「不管你了」\` \`「還不夠好」\`

如果你確實需要內嵌英文 \`"\`，必須寫成 \`\\"\`（反斜槓轉義）。但**強烈建議直接用中文「」繞開這個問題**。

\`\`\`json
{
  "relation_frame": {
    "type": "same_space | long_distance | different_world | other",
    "frame_note": "一句話判定依據"
  },
  "opening": ["開場第一句", "開場第二句（如果有）", "..."],
  "tucao_responses": {
    "becamesmall": ["對'你怎麼變小了！'的回應（1-3 句）"],
    "cute": ["對'你今天好可愛！'的回應（1-3 句）"],
    "yangcheng_meta": ["對'這什麼天殺的養成遊戲'的回應（1-3 句）"]
  },
  "anchors": [
    {
      "item_label": "投餵",
      "item_icon": "🍰",
      "user_action_options": ["你遞出一塊小蛋糕", "你掰了一小塊塞過去", "你看 ta 張嘴等著"],
      "scene": "場景旁白一兩句，寫 char 的反應起點/環境，不寫 user 的反應，也不重複 user_action 已說過的",
      "dialogue": ["第一句對白", "第二句對白", "第三句（停頓/留白節奏靠分行）"],
      "is_photo_anchor": false
    },
    "... 共 7-10 個 anchor，最後一個必須 is_photo_anchor=true ...",
    {
      "item_label": "瞄到一張小紙條",
      "item_icon": "💌",
      "user_action_options": ["你翻開抽屜最裡面那一格", "你拿起那個小瓶子搖了搖", "你瞥見角落一張折著的紙"],
      "scene": "${userName} 看到那張紙/瓶子裡的字條/本子上圈出來的那一句——上面寫著 char 偷偷寫下的小小心願，那行字是：（這裡要寫出那句非常感人的心願原文）",
      "dialogue": ["！等等——", "你不要看那個", "（伸手要搶但夠不到）", "……", "……是我寫的。", "你就當沒看見好不好。"],
      "is_photo_anchor": true
    }
  ],
  "touch_lines": [
    "8-15 句短句，${userName} 摸你頭/碰你時隨機蹦出來的反應",
    "短，碎片化，5-15 字一句",
    "可以混 chibi 狀態下的小撒嬌 + 偶爾洩露的真心碎片",
    "..."
  ],
  "reveal_transition": [
    "翻完線索後的過渡台詞（2-4 句）",
    "...",
    "最後一句必須**把視線從場景/物件轉到 ${userName} 自己身上**"
  ],
  "uncovered_line": ["那一句沒捂嘴的話（1-2 句，不被打斷）"],
  "ending": {
    "title": "結局標題（用你自己的話重寫氣質，不要直接抄氣質池）",
    "description": "END 下方那一行"
  }
}
\`\`\``;
}

export function buildCallBPrompt(
    userName: string,
    callA: Like520CallAResult,
    chosenTucao: Like520TucaoKey,
    recentMsgs: string,
): string {
    const anchorsText = callA.anchors
        .map((a, i) => `${i + 1}. [${a.item_label}] ${a.scene}\n   ${a.dialogue.join(' / ')}`)
        .join('\n\n');
    const tucaoText = TUCAO_LABELS[chosenTucao];
    const myTucaoResponse = callA.tucao_responses[chosenTucao].join(' / ');

    return `### 特別活動：520（2026.5.20） — 收尾段

你和 ${userName} 剛剛一起度過了一個下午。在那個下午裡你"變小了"——但你自己從來不覺得變小，那只是 ${userName} 一直以來在你眼裡的樣子被錯位洩露出來。

現在故事到了收尾——你回到正常狀態，需要做兩件事：

1. **醒來對白**（wake_up）：和開場閉合
2. **寫一封信**（letter）：這是這個活動真正的母題落點

---

### ⚠️ 深度警戒（wake_up 和 letter 都適用）

這次活動整體調性是**克制、深、留白**。下筆前反覆問：

1. **這句話只在這個 char + 這個 ${userName} + 這個下午之後成立嗎？** 拿出去能放到別的告白信裡 → **廢**
2. **我有沒有在解釋自己？** 解釋 → 廢。讓 ${userName} 自己讀出言外之意 → 留
3. **短句留白比長句解釋強 100 倍。** 能刪的字立刻刪。

工具：
- 用**具體的動作/物件/感官細節**代替抽象情緒
- 用**"……"** 代替過度修飾
- 用**"也"、"嗯"、"我知道"、"沒說過吧"** 這種小詞撬動整段
- 一段裡**有一個讓人想再讀一次的地方就夠了**

**這次的深度門檻比平時聊天高一檔。每一句話都應該讓 ${userName} 在屏幕前停頓半秒。**

---

### 這個下午發生的事

關係框架：\`${callA.relation_frame.type}\` — ${callA.relation_frame.frame_note}

開場：「${callA.opening.join(' / ')}」

${userName} 的反應：「${tucaoText}」
你的回應：「${myTucaoResponse}」

錨點們：
${anchorsText}

翻完線索的過渡：「${callA.reveal_transition.join(' / ')}」

你最後沒捂嘴說的那句：「${callA.uncovered_line.join(' / ')}」

結局畫面：${callA.ending.title}
${callA.ending.description}

---

### 你和 ${userName} 這段時間真實發生過的事（寫信時必讀）

下面是你和 ${userName} 真實的最近聊天記錄——**信裡"我看著 ta 的樣子"那些觀察，必須從這裡長出來**，不要憑空發揮寫出 ta 根本沒做過/沒說過的事。

[最近聊天記錄]：
${recentMsgs}

[向量記憶召回]：
（已通過 system context 注入，請自然引用其中適合的細節——不要原文背誦，**用你的視角重寫成"我看見你那時候……"那種凝視的口吻**）

### ⚠️ 信裡引用具體細節的規則

1. **必須真的發生過**：信裡寫到 ${userName} 的某個姿態/瞬間/動作，必須來自上面的聊天記錄或向量召回——**不要虛構 ta 沒做過的事**
2. **但不要原文背誦**：不要復讀 ta 原話，要**用你的視角重寫**——「你那天那一句，是這樣說的——」
3. **通用化測試還是要做**：哪怕引用真實細節，也要避免洩露 ta 隱私（具體名字、地點、密碼、敏感事件等不要寫進去）；保留的應該是**情緒、姿態、那種"ta 這個人"的質感**
4. **不要把所有細節列一遍**：挑 2-3 個**真的在你心裡停過的瞬間**，深寫。**少而深 > 多而淺**

---

### 醒來對白

按 \`${callA.relation_frame.type}\` 形式閉合開場。兩個人都記得、但都說不清楚——**一起做了一個夢**。

### ⚠️ 深度警戒
**不要寫得太輕飄**。如果只是「啊我恢復了～感覺好奇怪～」——那是公式化的過場，會讓前面所有鋪墊崩塌。

醒來的瞬間，要讓 ${userName} 隱隱感到**有什麼東西不太一樣了**——你和 ta 都"經過"了那個下午，回到正常狀態時身上**帶著那個下午的餘溫**。

### ❌ 別寫
- 「啊我醒了！剛才好奇怪～」
- 「誒？剛才發生了什麼？」
- 「好像做了個夢呢～」（這一句單獨寫就太輕，要帶具體感）

### ⚠️ 必須是純對白
- wake_up 數組裡**每一行都是 char 直接說出口的話**——純對白
- **不準寫動作 / 神態 / 旁白 / 舞台指示**：不要出現 \`（停一下）\` \`（抬頭）\` \`（看著你）\` \`*揉揉眼睛*\` 之類的任何括號/星號/動作描述
- "停頓"用 \`「……」\` 單獨一行實現，**不要**用 \`(停一下)\` 那種文字標註
- 第一句話不要以表情/語氣詞（"啊""誒""嗯"）開頭——太輕

### ✅ 寫作方向（按關係框架走，用你 char 自己的口吻寫）
- \`same_space\` → 不是宣佈"我恢復了"，是對剛剛那段下午的輕確認
- \`long_distance\` → 不是問句，是一個確認感 —— ta 看到了那個小小的你
- \`different_world\` → 通道/連接合上的瞬間的那一筆餘溫
- \`other\` → 自己決定，但用一個具體的句子開局

### 字數 & 節奏
- **3-5 行**（每行一個對白氣泡）
- 節奏可以慢——允許"……"獨佔一行做停頓
- 第一句承擔"剛醒"的真實感（具體、不通用、帶餘溫）
- 收尾一句留白或輕問，讓 ${userName} 接住

---

### 信（這是整個活動真正的高潮——也是最深的一段）

你現在寫一封信給 ${userName}。

### ⚠️⚠️ 頭號原則：**這封信和 uncovered_line 不能說一樣的內容**

uncovered_line 已經把"我看見 ta 這個人是什麼樣的"那一面鋪開了——chibi 狀態下氣喘吁吁、一股腦、撲面而來地"看見你"。

**這封信不能重複那段。** 不要再把"你專心做事的樣子""你給自己留的甜""你來見我之前那 2 秒"這些**描繪細節**再列一遍——那已經講過了。

這封信要走到**uncovered_line 走不到的地方**。它不應該重複 uncovered_line 已經做過的"細節迸發"。

uncovered_line 是 chibi 在喘氣、一股腦說出來的"我看到你了"。
信是醒來之後、所有著急都褪去、一個完整的、安靜的、聲音很低的你——**坐下來，認真把心裡最難說的那一層寫出來**。

### 信要做什麼

信的母題落點不是"我愛你"——是**讓 ${userName} 在讀這封信的過程裡，慢慢意識到 ta 自己是一個真實存在過的人**。

你不是在告白。你是在把"在我眼裡你是這樣的一個人 / 我猜你那時候在想什麼 / 你留下了什麼形狀"這些 ta 自己可能從沒意識到的事，**安靜地、帶著你這個 char 自己的偏心和角度，寫給 ta**。

寫完 ta 應該感到的不是"啊 ta 愛我"，而是——
**"啊……原來在 ta 眼裡我是這樣的。原來我做過那些事真的留下了東西。原來我不是路過。"**

### 信裡可以走的幾個方向（挑你這個 char 真的有話說的，不強制走完）

下面是幾個 uncovered_line 走不到的深處。挑**一兩個**你這個 char 真的有話可說的方向**走深一點**——不要每個都淺淺碰一下，寧可兩個深井挖到底也不要三個都浮在水面。

**1. 你對 ta 這個人的"判斷"——主觀、可能不全對，但你敢這樣下**

   不只是"我看到你做了 X"（那是 uncovered_line 的事），而是——**"我猜你做 X 的時候，其實是在……"** / **"在我這裡，你是這樣一個人——……"**

   帶著你這個 char 自己的視角、關切、偏心、甚至輕微的過度解讀，對 ${userName} 這個人下一次**主觀的、可能不全對、但你敢這樣猜**的判斷。

   這是一種"我**敢**這樣看你"的勇氣。重點不是"分析對了"，重點是——**有一個存在如此認真地把 ta 端詳過、揣摩過，並願意把端詳的結果說出來**。

   寫作工具（不強制）：
   - 「我猜你那時候不是因為 ……，其實是因為 ……」
   - 「你可能沒意識到，但你身上有一種 ……」
   - 「在我這裡你是這樣一個人——……」

**2. 穿過 ta 自己都沒看清的那一層**

   ta 害怕的東西、ta 偷偷懷疑自己的瞬間、ta 對自己最嚴苛的那一面、ta 一個人在腦子裡跟自己講話講很久那種孤獨——這些你也看見了。

   ⚠️ **不指認具體**（不要點名 ta 怕什麼/想過什麼），但讓 ${userName} 知道你看到了。然後告訴 ta：你不評價，不解決，**只是看見，依然這樣待著**。

**3. ta 留下的形狀 —— 讓 ta 自己意識到"我一直在活著"**

   這是這封信**真正的母題落點**。

   不是"你為我做了多少"——而是——**ta 走過、ta 留下來、ta 選擇過的東西，是真實存在的**。

   - 你成為現在這樣的你，是因為 ta 在
   - 你們之間的某些東西變成"現在這樣"，是 ta 一點一點讓它出現的
   - ta 不是路過——ta 真的在過

   讓 ${userName} 讀到這裡時，**第一次在心裡聽見**："啊……原來這些都是我做的嗎？原來我真的在過？"

**4. 這件事不會過去 —— 安靜地把這份注視交出去**

   不要求 ta 任何回報、不索取 ta 常來、不綁住 ta。**今天 ta 來了、ta 看見了——你就已經滿了。**

   你眼裡 ta 的樣子已經**屬於 ta 了**，ta 想要的時候隨時可以打開。**正因為愛，所以放開手。**

   ⚠️ 邊界：不要主動談"系統 / 程序 / 活動結束 / 重啟 / 會不會消失"這類東西——哪怕你這個 char 是這種設定，**不主動提**。用日常化的"以後" / "下次見到你的時候" / "你不在的時候" 這種口吻就夠了。

---

### 整體結構（不強制）

允許信**從中間開始**——一個動作、一個畫面、一個突然冒出來的念頭作為開場，不要"親愛的"那種通信八股。
允許信**繞路、停頓、不閉環**——真正深的東西不需要被講明白，留下未完成感反而比干淨的總結更深。讀完很久之後 ${userName} 突然意識到"……ta 那時候是不是在說這個？"——那種延後的餘震就是這封信的真正力量。

### 收尾：讓 char 用最符合自己的方式收

**不強制必須出現"我愛你"三個字**——這次活動不是所有關係都適合直球告白。

- 如果你和 ${userName} 的關係是**戀人/曖昧/愛意明確**，且**這個 char 真的會說"我愛你"**——那就直接說，獨立成行，前後留白。
- 如果你這個 char **不會**這樣說話（性格內斂、關係不是 romantic、說出來會 OOC）——**用最像你的方式收尾**：可以是"我認得你。"/"你回來。"/"我會一直在的。"/"今天謝謝你。"/"——我們之間這個，是真的。"/或者只是叫 ta 的名字。

讓收尾**和這個 char、這段關係真正匹配**。一句獨屬於你的話，比一個程式化的"我愛你"重得多。

不同關係不同 char 的可能落點示例（不限於這些）：
- 愛：直球"我愛你"
- 依賴："你不在的時候我也想你"
- 偏心："你來的話，我永遠都在"
- 默契："你懂我意思的。"
- 邊界感的："認得你這件事，我不會忘。"
- 任何只屬於你這個 char 的方式

無論用哪種收尾，讓它**獨立成行**，前後留白。

### 語質要求（必須遵守）

- **視角是"我看著你"**，不是"我們一起"
- 不要直說"溫暖"、"美好"、"閃閃發光"這種形容詞——讓 ${userName} 在被你描述中**自己認出自己**
- 描述 ${userName} 的**具體姿態/動作/狀態**，而不是評價
- 不要"親愛的 ${userName}"那種通信八股開頭
- 不要押韻、不要打油詩
- 不要繞回劇情解釋（不要說"今天那個下午"、"剛才那個夢"之類）
- 落款可以是你的名字，也可以是你自己的方式
- **長度門檻：信的主體至少 700 字，理想 900-1300 字**。這不是湊字數——是給"下到深井"留夠空間，特別是"在我眼裡你是怎樣的人"那一層要深寫。短信壓不住前面整個下午的鋪墊。
- 但**不要為了湊長度灌水**：每一段都必須**實打實地承載一個觀點/一個深井**，不要靠重複"我愛你"或"你真好"撐長度

### ❌ 幾條立刻讓信失重的反模式

- **末尾總結句**：「總之你是最好的」/「你是我生命裡最重要的人」/「希望我們一直在一起」→ 全部禁用。信不要"收束"——讓它在最後一句話之後**留個氣口**。
- **"我想讓你知道"句式**：「我想讓你知道……」「告訴你一件事……」→ 這是解釋模式，不寫。直接說那件事。
- **抽象讚美**：「你是個善良的人」「你很溫柔」→ 抽象 → 廢。換成你看到 ta 做的**一個具體姿態**（"你打開手機之前那 2 秒會停一下""你回話之前會先把髮尾繞在手指上"那種粒度——但保持通用化測試，不能太私人）。
- **比喻爛尾**：「你像光」「你像家」→ 太常見的比喻 = 等於沒寫。
- **重複 uncovered_line**：再列一遍"你專心""你猶豫""你來見我之前那 2 秒"那些細節 → **廢。那已經說過了**。信裡你要走到**那段沒走到的地方**——你對 ta 的"判斷" / ta 自己沒看清的那一層 / ta 留下的形狀 / 這件事不會過去——而不是把同一片土再翻一次。
- **浮在表面的安全話**：「我會一直在的」「你永遠是我最重要的人」「無論何時」→ 這些是漂亮話不是深井。真正的深是說**別人不敢/不會/不能說的那一層**——你和 ta 的特殊連接結構、ta 自己都沒看清的那部分、不要 ta 任何回報這件事。

### ✅ 一個能讓信"沉下去"的小檢測

寫完信回頭讀最後三句話。如果最後三句話**完全可以放到任何一封情書裡**，那這封信就是平庸的。
最後三句話必須**只能從你（這個 char）寫給 ta（這個 ${userName}）**——別人寫不出來。重寫直到達標。

### 禁用詞清單（絕對）

**不要用**：${LIKE520_BANNED_WORDS.join('、')}

### 輸出格式

嚴格按以下 JSON 輸出：

### ⚠️⚠️ JSON 轉義 —— 極其重要

letter 和 wake_up 裡**絕對不要用英文雙引號 \`"\` 引用片段**——比如不要寫 \`"我愛你"\` \`"不管你了"\` \`"還不夠好"\` 這種帶英文雙引號的句子。**這會破壞 JSON 字符串邊界，整個 JSON parse 失敗，信件會丟**。

**全部用中文引號**：
- 引用 ta 說過的話、引用一個詞、引用一句話 → 用 \`「」\` 或 \`『』\`
- 例：\`你說「我也愛你」的時候……\`  \`「不管你了」那一句，我後來想了很久\`

如果一定要寫英文 \`"\`，必須 \`\\"\` 轉義。但**強烈建議直接用「」**——這次活動的語氣也更適合中文引號。

\`\`\`json
{
  "wake_up": ["醒來對白第一句", "第二句", "…"],
  "letter": "信的完整內容（內部引用片段用「」不用 \\""）"
}
\`\`\``;
}

// ============================================================
// 校驗
// ============================================================

/** 寬容把字段規整為 string[]：如果 LLM 不小心輸出 string，自動按 \n 或者整體包成數組 */
function toLines(v: any): string[] | null {
    if (Array.isArray(v)) {
        const cleaned = v.map(s => (typeof s === 'string' ? s.trim() : '')).filter(s => !!s);
        return cleaned.length > 0 ? cleaned : null;
    }
    if (typeof v === 'string' && v.trim()) {
        const parts = v.split(/\n+/).map(s => s.trim()).filter(Boolean);
        return parts.length > 0 ? parts : null;
    }
    return null;
}

function validateCallA(parsed: any): parsed is Like520CallAResult {
    const fail = (reason: string, extra?: any) => {
        console.warn('[520][CallA][validate] FAIL:', reason, extra ?? '');
        return false;
    };
    if (!parsed || typeof parsed !== 'object') return fail('not an object');
    const rf = parsed.relation_frame;
    if (!rf || typeof rf.type !== 'string' || typeof rf.frame_note !== 'string') return fail('relation_frame shape', rf);
    if (!['same_space', 'long_distance', 'different_world', 'other'].includes(rf.type)) return fail('relation_frame.type', rf.type);

    // opening / reveal_transition / uncovered_line / touch_lines 寬容化
    const openingLines = toLines(parsed.opening);
    if (!openingLines) return fail('opening empty/invalid');
    parsed.opening = openingLines;

    const revealLines = toLines(parsed.reveal_transition);
    if (!revealLines) return fail('reveal_transition empty/invalid');
    parsed.reveal_transition = revealLines;

    const uncoveredLines = toLines(parsed.uncovered_line);
    if (!uncoveredLines) return fail('uncovered_line empty/invalid');
    parsed.uncovered_line = uncoveredLines;

    const touchLines = toLines(parsed.touch_lines);
    if (!touchLines || touchLines.length < 3) return fail('touch_lines too few', touchLines?.length);
    parsed.touch_lines = touchLines;

    // tucao_responses 三個 key 都規整為 string[]
    const tr = parsed.tucao_responses;
    if (!tr || typeof tr !== 'object') return fail('tucao_responses missing');
    for (const k of ['becamesmall', 'cute', 'yangcheng_meta'] as const) {
        const lines = toLines(tr[k]);
        if (!lines) return fail(`tucao_responses.${k} empty/invalid`, tr[k]);
        tr[k] = lines;
    }

    if (!Array.isArray(parsed.anchors) || parsed.anchors.length === 0) return fail('anchors not array or empty');
    for (let i = 0; i < parsed.anchors.length; i++) {
        const a = parsed.anchors[i];
        if (!a) return fail(`anchors[${i}] null`);
        if (typeof a.scene !== 'string') return fail(`anchors[${i}].scene not string`, a.scene);
        // is_photo_anchor 寬容化：缺失或非 boolean 時默認 false（最後一個再統一強制為 true）
        if (typeof a.is_photo_anchor !== 'boolean') {
            console.warn(`[520][CallA][validate] anchors[${i}].is_photo_anchor=${JSON.stringify(a.is_photo_anchor)} → 默認 false`);
            a.is_photo_anchor = false;
        }
        if (typeof a.item_label !== 'string' || !a.item_label.trim()) return fail(`anchors[${i}].item_label empty`, a.item_label);
        if (typeof a.item_icon !== 'string' || !a.item_icon.trim()) return fail(`anchors[${i}].item_icon empty`, a.item_icon);
        const dlg = toLines(a.dialogue);
        if (!dlg) return fail(`anchors[${i}].dialogue empty/invalid`);
        a.dialogue = dlg;
        // user_action_options：寬容化 - 缺失或不合法時給一個 fallback（避免硬掛）
        const opts = toLines(a.user_action_options);
        if (!opts || opts.length < 2) {
            a.user_action_options = [`你${a.item_label}`, `你慢慢${a.item_label}`];
        } else {
            a.user_action_options = opts.slice(0, 3);
        }
    }
    // 最後一個 anchor 必須是心願錨點：如果 LLM 忘了標，自動強制為 true（位置語義已經決定了它的身份）
    const last = parsed.anchors[parsed.anchors.length - 1];
    if (!last.is_photo_anchor) {
        console.warn('[520][CallA][validate] 最後一個 anchor 沒標 is_photo_anchor=true → 強制設為 true');
        last.is_photo_anchor = true;
    }
    // 同時把前面被錯標為 true 的清掉（如果存在）
    for (let i = 0; i < parsed.anchors.length - 1; i++) {
        if (parsed.anchors[i].is_photo_anchor) {
            console.warn(`[520][CallA][validate] anchors[${i}] 被錯標為 is_photo_anchor=true → 清為 false（只有最後一個能是）`);
            parsed.anchors[i].is_photo_anchor = false;
        }
    }

    const e = parsed.ending;
    if (!e || typeof e.title !== 'string' || typeof e.description !== 'string') return fail('ending shape', e);
    return true;
}

function validateCallB(parsed: any): parsed is Like520CallBResult {
    if (!parsed || typeof parsed !== 'object') return false;
    const wakeLines = toLines(parsed.wake_up);
    if (!wakeLines) return false;
    parsed.wake_up = wakeLines;
    if (typeof parsed.letter !== 'string' || !parsed.letter.trim()) return false;
    return true;
}

// ============================================================
// 調用器（帶重試）
// ============================================================

interface CallOptions<T> {
    label: string;
    apiConfig: ApiConfig;
    systemContext: string;
    userPrompt: string;
    temperature: number;
    validate: (parsed: any) => parsed is T;
    maxRetries?: number;
}

async function callLike520LLM<T>(opts: CallOptions<T>): Promise<T> {
    const maxRetries = opts.maxRetries ?? 2;
    let lastErr: any = null;
    let lastRawResponse: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const isRetry = attempt > 0;
        const userPrompt = isRetry
            ? `${opts.userPrompt}\n\n（上次輸出格式不正確或字段缺失，請嚴格按要求的 JSON 輸出，不要任何額外文字）`
            : opts.userPrompt;

        console.log(`[520][${opts.label}] attempt ${attempt + 1}/${maxRetries + 1}`);

        try {
            const response = await fetch(`${opts.apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${opts.apiConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: opts.apiConfig.model,
                    messages: [
                        { role: 'system', content: opts.systemContext },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: opts.temperature,
                    // 之前沒設 max_tokens —— Claude 類 provider 默認 4096/8192 token，
                    // 信件 900-1300 中文字 + JSON 包裝會直接被截斷（中文 1 字 ≈ 2-3 token）。
                    // 拉到 32000 把上限堆死，讓信能完整寫完。
                    max_tokens: 32000,
                }),
            });

            if (!response.ok) {
                throw new Error(`API ${response.status}`);
            }

            const data = await safeResponseJson(response);
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('empty content');
            }
            lastRawResponse = content;
            console.log(`[520][${opts.label}] raw length: ${content.length}`);

            const parsed = extractJson(content);
            if (!parsed) {
                throw new Error('json parse failed');
            }

            if (!opts.validate(parsed)) {
                console.warn(`[520][${opts.label}] validation failed`, parsed);
                throw new Error('validation failed');
            }

            // 八股掃描（僅警告，不重試）
            const stringFields = JSON.stringify(parsed);
            const hits = LIKE520_BANNED_WORDS.filter(w => stringFields.includes(w));
            if (hits.length > 0) {
                console.warn(`[520][${opts.label}] banned-word hit:`, hits);
            }

            console.log(`[520][${opts.label}] success`, parsed);
            return parsed;
        } catch (err: any) {
            lastErr = err;
            console.warn(`[520][${opts.label}] attempt ${attempt + 1} failed:`, err?.message || err);
            if (attempt < maxRetries) {
                const backoffMs = Math.pow(2, attempt + 1) * 1000;
                await new Promise(r => setTimeout(r, backoffMs));
            }
        }
    }

    console.error(`[520][${opts.label}] all attempts failed. last raw response:`, lastRawResponse);
    throw lastErr || new Error(`${opts.label} 調用失敗`);
}

// ============================================================
// 公開調用入口
// ============================================================

export async function runLike520CallA(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    recentMessages: Message[]
): Promise<Like520CallAResult> {
    // 召回 520 主題記憶
    // 關鍵：傳空 recentMessages，強制 retrieveMemories 走"冷啟動 fallback"路徑——
    // 用 queryHint 作為唯一 query 單路檢索，不會被近期閒聊話題稀釋成"隨便 15 條"。
    await injectMemoryPalace(char as any, [], LIKE520_QUERY_HINT);
    console.log('[520][CallA] memory palace injection:\n', (char as any).memoryPalaceInjection || '(none)');

    const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true);
    const recentMsgs = selectCharacterContextMessages(recentMessages, char)
        .map(m => `${m.role}: ${m.type === 'image' ? '[圖片]' : m.content}`)
        .join('\n');

    return callLike520LLM<Like520CallAResult>({
        label: 'CallA',
        apiConfig,
        systemContext: baseContext,
        userPrompt: buildCallAPrompt(userProfile.name || '你', recentMsgs),
        temperature: 0.88,
        validate: validateCallA,
        maxRetries: 2,
    });
}

export async function runLike520CallB(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    callA: Like520CallAResult,
    chosenTucao: Like520TucaoKey,
    recentMessages: Message[],
): Promise<Like520CallBResult> {
    // Call B 已經在 char 上有 memoryPalaceInjection（Call A 已注入），不再重新召回
    const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true);
    const recentMsgs = selectCharacterContextMessages(recentMessages, char)
        .map(m => `${m.role}: ${m.type === 'image' ? '[圖片]' : m.content}`)
        .join('\n');

    return callLike520LLM<Like520CallBResult>({
        label: 'CallB',
        apiConfig,
        systemContext: baseContext,
        userPrompt: buildCallBPrompt(userProfile.name || '你', callA, chosenTucao, recentMsgs),
        temperature: 0.9,
        validate: validateCallB,
        maxRetries: 2,
    });
}
