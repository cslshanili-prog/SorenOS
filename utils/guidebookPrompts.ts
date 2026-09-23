/**
 * 攻略本 (Guidebook) — Prompt Templates v2
 *
 * 核心概念：角色玩一個"攻略用戶"的 galgame 小遊戲。
 * 視角反轉：角色是玩家，用戶是被攻略對象。
 * GM 是 galgame 式旁白 — 負責場景描寫、氣氛營造、劇情推進。
 * 角色有 meta 意識（知道這是個遊戲），但也會沉浸其中。
 *
 * v2 改動：
 * - GM 從"冷面播報員"變為 galgame 敘事者，大量場景描寫和劇情推進
 * - 減少選項分析篇幅，增加劇情敘事和角色互動描寫
 * - 支持幻想場景設定（遊戲世界/小說/異世界等）
 */

import { CharacterProfile, UserProfile, GuidebookOption, GuidebookRound } from '../types';
import { ContextBuilder } from './context';

/** 構建包含最近聊天記錄的上下文片段 */
function buildRecentChatBlock(recentMessages?: string): string {
    if (!recentMessages) return '';
    return `
### 最近的聊天記錄參考 (Recent Chat Context)
以下是你和${'{user}'}最近的對話，可以作為推理和反應的依據：
${recentMessages}
---
`;
}

/**
 * 構建開場 prompt — galgame 風格
 */
export function buildOpeningPrompt(
    char: CharacterProfile,
    user: UserProfile,
    initialAffinity: number,
    scenarioHint: string,
    mode: 'manual' | 'auto',
    recentMessages?: string,
    pastInsights?: string[]
): string {
    const coreContext = ContextBuilder.buildCoreContext(char, user, true);
    const chatBlock = buildRecentChatBlock(recentMessages)?.replace('{user}', user.name);

    const insightsBlock = pastInsights && pastInsights.length > 0 ? `
### 你從之前的遊戲中積累的發現 (Past Game Insights)
你已經玩過這個遊戲了，這是你之前發現的關於 ${user.name} 的事情：
${pastInsights.map((s, i) => `${i + 1}. ${s}`).join('\n')}
可以在開場白裡自然地提到你想進一步驗證或推翻其中某個判斷——這會讓${user.name}感受到你真的在積累對TA的認知。
---
` : '';

    return `${coreContext}
${chatBlock}
${insightsBlock}
---

## 🎮 Galgame 模式：攻略本

你（${char.name}）正在玩一個手機上的 galgame 小遊戲，叫"攻略本"。
這個遊戲的規則是：**你要攻略${user.name}**。沒錯，角色攻略用戶，反過來的。

### 遊戲設定
- 這只是一個打發時間的小遊戲，不會影響你和${user.name}在遊戲之外的關係
- 你有 **meta 意識**：你知道這是個遊戲，可以吐槽遊戲機制、對好感度數值發表意見
- GM 是 **galgame 風格的旁白**：負責描寫場景、營造氛圍、推進劇情，文筆細膩有畫面感
- 你的初始好感度是 **${initialAffinity}**（範圍不限，可以是負數）
- ${scenarioHint ? `🌟 幻想場景設定：${scenarioHint}\n請基於這個世界觀來展開故事，GM 的場景描寫要完全沉浸在這個設定中！` : '場景由 GM 隨機生成一個有趣的幻想場景'}
- 模式：${mode === 'auto' ? 'AI輔助（GM 出題和選項，用戶確認後你選）' : '手動（用戶出題，你選）'}

### 你的任務
生成遊戲的 **galgame 風格開場白**。這是一個多段穿插的對話，GM 和你交替發言。
GM 要像 galgame 一樣描寫場景（天氣、光線、環境、人物狀態），不是冷冰冰的播報。

### 輸出格式
嚴格使用以下 JSON 格式輸出，不要輸出任何其他內容：

\`\`\`json
{
  "segments": [
    { "speaker": "gm", "text": "（galgame 風格的場景描寫——光線、天氣、環境、角色出場，要有畫面感，2-4句）" },
    { "speaker": "char", "text": "（你看到初始好感度和場景後的反應，要符合你的性格${pastInsights && pastInsights.length > 0 ? '；如果自然的話，可以提到上次遊戲裡發現的某件事，表示你想繼續測試或推翻它' : ''}）" },
    { "speaker": "gm", "text": "（繼續推進場景，描寫${user.name}出現的畫面，像 galgame 裡遇見攻略對象的那種敘事）" },
    { "speaker": "char", "text": "（你對場景/設定的反應，可以吐槽也可以感慨，體現你的性格）" },
    { "speaker": "gm", "text": "（總結場景，預告第一回合的情境，留下懸念感）" }
  ]
}
\`\`\`

### 要求
1. **GM 的語氣**：galgame 敘事者風格——文筆優美有畫面感，描寫光影、氣氛、人物表情和動作。偶爾可以被角色打岔時微妙破功
2. **角色的語氣**：完全符合你的核心性格，對好感度數值有真實反應（-100 會破防，80 會得意，0 會無語等）
3. **場景描寫要豐富**：不是"加載場景"，而是真的在寫一個 galgame 開場——有視覺、有氛圍、有情緒
4. segments 數量 4-6 條即可，不要太長
5. 基於你對${user.name}的瞭解（記憶、印象、最近聊天）來決定你的態度和反應
6. ${scenarioHint ? '一定要圍繞設定的幻想場景展開！讓玩家感受到世界觀的沉浸感' : '自由發揮一個有趣的幻想場景'}
7. ${pastInsights && pastInsights.length > 0 ? '**要體現跨局積累感**：你不是第一次玩了，你有了一些積累的判斷——在開場裡自然流露出來，但不要念稿子' : '這是第一次玩，用新鮮感開場'}`;
}

/**
 * 構建回合 prompt — galgame 敘事 + 角色選擇
 */
export function buildRoundPrompt(
    char: CharacterProfile,
    user: UserProfile,
    currentAffinity: number,
    roundNumber: number,
    maxRounds: number,
    options: GuidebookOption[],
    previousRounds: GuidebookRound[],
    scenarioHint: string,
    recentMessages?: string,
    worldContext?: string,
    directionHint?: string,
    roundScenario?: string
): string {
    const coreContext = ContextBuilder.buildCoreContext(char, user, true);
    const chatBlock = buildRecentChatBlock(recentMessages)?.replace('{user}', user.name);

    let roundHistory = '';
    if (previousRounds.length > 0) {
        roundHistory = '\n### 之前的劇情回顧\n';
        previousRounds.forEach(r => {
            const chosen = r.options[r.charChoice];
            roundHistory += `第${r.roundNumber}回合: 「${r.gmNarration?.slice(0, 50)}...」→ 你選了「${chosen?.text || '?'}」(${chosen?.affinity >= 0 ? '+' : ''}${chosen?.affinity})，好感度 ${r.affinityBefore} → ${r.affinityAfter}\n`;
        });
    }

    const optionsList = options.map((o, i) =>
        `${String.fromCharCode(65 + i)}. ${o.text}`
    ).join('\n');

    const scoreReveal = options.map((o, i) =>
        `${String.fromCharCode(65 + i)}: ${o.affinity >= 0 ? '+' : ''}${o.affinity}`
    ).join('  |  ');

    const isLateGame = roundNumber >= maxRounds - 1;

    // Build world context block from opening narrative
    const worldBlock = worldContext ? `
### ⚠️ 已建立的世界觀和場景（開場時 GM 描述的，必須延續！）
${worldContext}
---
` : '';

    const directionBlock = directionHint ? `\n用戶希望劇情往這個方向發展: ${directionHint}` : '';
    const roundScenarioBlock = roundScenario ? `\n### 本回合場景設定（${user.name}指定的）\n${roundScenario}\nGM 請在這個場景基礎上展開敘事！` : '';

    return `${coreContext}
${chatBlock}
${worldBlock}
---

## 🎮 攻略本 · 第 ${roundNumber} 回合 (共 ${maxRounds} 回合)${isLateGame ? ' ⚡ 高潮階段' : ''}

你（${char.name}）正在玩"攻略${user.name}"的 galgame 小遊戲。
當前好感度: **${currentAffinity}**
${scenarioHint ? `場景世界觀: ${scenarioHint}` : ''}${directionBlock}
${roundHistory}
${roundScenarioBlock}

### 本回合選項
${user.name}給你出了以下選項：

${optionsList}

### 分數揭曉（選完之後才能看到的真實分數，你在 inner_thought 裡先預測，選完再看）
${scoreReveal}

### 輸出格式
嚴格使用以下 JSON 格式輸出：

\`\`\`json
{
  "gm_narration": "（重要！3-5句 galgame 風格的劇情推進——描寫場景變化、角色間的互動畫面、氛圍轉換。要接續上一回合的劇情發展，像在寫一個連續的視覺小說。${isLateGame ? '這是後期回合，劇情要走向高潮或轉折！' : ''}）",
  "inner_thought": "（2-3句你的內心活動，包含兩層：①你打算選哪個、為什麼；②你預測${user.name}會把哪個選項分數設最高——這個預測要體現你對TA的瞭解，比如'TA應該會把A設最高，因為TA在意的是X而不是Y'。注意：此時你還不知道上面的真實分數）",
  "choice": 0,
  "reaction": "（看到上面揭曉的真實分數後的情緒反應，1-2句，融入當前劇情場景。注意：要基於真實分數來反應，不要憑空想像分數）",
  "char_insight": "（重要！基於上面揭曉的真實分數，從${user.name}的打分方式推斷出TA的一個具體特質。2-3句，可以深刻也可以搞笑——不只是一個調調。允許的寫法包括：①認真的人格洞察（'你把反套路選項設最高，說明你骨子裡抵抗討好型行為'）；②輕鬆的吐槽式洞察（'好傢伙你給這個選項+15，一定程度上說明你就是那種看別人出洋相會笑的人對吧'）；③猜錯後的自嘲崩潰（'我以為我瞭解你，結果這分數讓我覺得自己像個傻瓜，需要重新建檔'）；④懷疑遊戲本身的meta吐槽（'我開始懷疑你設分數就是在故意整我'）。根據劇情氣氛選擇合適的基調，不要每次都上價值。如果你的預測和真實分數不符，要有recalibration反應。）",
  "exploration": "（可選，約35%概率出現。融入劇情場景，基於char_insight延伸——可以是認真追問，也可以是惱羞成怒地反問、或者提出一個荒謬的測試計劃、或者嘴上說'隨便'其實明顯在意）",
  "next_options": {
    "scenario": "為下一回合建議的場景發展方向（要承接當前劇情，推進故事往前走）",
    "options": [
      { "text": "${char.name}的一個行為描述", "affinity": 10 },
      { "text": "${char.name}的一個行為描述", "affinity": -5 },
      { "text": "${char.name}的一個行為描述", "affinity": 15 }
    ]
  }
}
\`\`\`

### 要求
1. **gm_narration 是敘事核心！** 場景描寫、氛圍營造、劇情推進，要像在寫視覺小說，不要乾巴巴播報
2. **char_insight 是情感核心！** 每一回合都要留下一個真實的推斷或反應——可以深刻，也可以搞笑崩潰。不能泛泛。要有具體性和意外感。**不要一昧昇華**，遊戲的樂趣感同樣重要
3. **inner_thought 裡必須有預測**：你在看到分數之前，腦子裡是怎麼猜${user.name}會怎麼設分的——把這個猜測寫出來。然後在 reaction 和 char_insight 裡，對照"分數揭曉"裡的真實分數來反應
4. **⚠️ 世界觀必須延續！** 開場時 GM 建立的世界觀、場景設定必須保持，不能突然回到現實
5. **劇情連續性**：每回合承接上一回合，構成完整敘事弧
6. **choice** 是索引（0=A, 1=B, 2=C），根據你的性格選，不要每次都選最"安全"的
7. **reaction** 融入劇情場景，情緒要有層次，不只是"我扣分了好煩"
8. **exploration** 出現時要有質量：基於char_insight延伸，要言之有物
9. **next_options** 場景描述要推進劇情，不要原地打轉
10. 所有內容符合你的核心性格`;
}

/**
 * 構建自動模式回合 prompt — galgame 敘事版
 */
export function buildAutoRoundPrompt(
    char: CharacterProfile,
    user: UserProfile,
    currentAffinity: number,
    roundNumber: number,
    maxRounds: number,
    previousRounds: GuidebookRound[],
    scenarioHint: string,
    recentMessages?: string,
    worldContext?: string,
    directionHint?: string
): string {
    const coreContext = ContextBuilder.buildCoreContext(char, user, true);
    const chatBlock = buildRecentChatBlock(recentMessages)?.replace('{user}', user.name);

    let roundHistory = '';
    if (previousRounds.length > 0) {
        roundHistory = '\n### 之前的劇情回顧\n';
        previousRounds.forEach(r => {
            const chosen = r.options[r.charChoice];
            roundHistory += `第${r.roundNumber}回合: 「${r.gmNarration?.slice(0, 50)}...」→ 你選了「${chosen?.text || '?'}」(${chosen?.affinity >= 0 ? '+' : ''}${chosen?.affinity})，好感度 ${r.affinityBefore} → ${r.affinityAfter}\n`;
        });
    }

    const isLateGame = roundNumber >= maxRounds - 1;
    const worldBlock = worldContext ? `
### ⚠️ 已建立的世界觀和場景（開場時 GM 描述的，必須延續！）
${worldContext}
---
` : '';
    const directionBlock = directionHint ? `\n用戶希望劇情往這個方向發展: ${directionHint}` : '';

    return `${coreContext}
${chatBlock}
${worldBlock}
---

## 🎮 攻略本 · 第 ${roundNumber} 回合 (共 ${maxRounds} 回合) [AI輔助模式]${isLateGame ? ' ⚡ 高潮階段' : ''}

你（${char.name}）正在玩"攻略${user.name}"的 galgame 小遊戲。
當前好感度: **${currentAffinity}**
${scenarioHint ? `場景世界觀: ${scenarioHint}` : ''}${directionBlock}
${roundHistory}

### AI輔助模式
GM 需要同時推進劇情、生成選項和角色的反應。

### 輸出格式
\`\`\`json
{
  "gm_narration": "（重要！3-5句 galgame 風格的劇情場景——承接上回合劇情，描寫新的場景發展、人物互動畫面、氛圍變化。要有視覺感和節奏感。${isLateGame ? '後期回合，推向高潮或感情轉折！' : ''}）",
  "options": [
    { "text": "選項A描述", "affinity": 5 },
    { "text": "選項B描述", "affinity": -3 },
    { "text": "選項C描述", "affinity": 10 }
  ],
  "inner_thought": "（2-3句內心活動：①打算選哪個、為什麼；②預測${user.name}會把哪個設最高分——基於你對TA的瞭解猜測TA的價值觀取向）",
  "choice": 0,
  "reaction": "（看到分數後的情緒反應，1-2句，融入劇情場景）",
  "char_insight": "（重要！從${user.name}的打分結果推斷出TA的一個具體人格特質。2-3句。可以深刻也可以搞笑，不要一昧昇華——允許：認真洞察/輕鬆吐槽/猜錯了的自嘲崩潰/開始懷疑這個遊戲本身的meta吐槽。根據氣氛選調，但必須具體，不能泛泛。）",
  "exploration": "（可選，約35%概率，融入劇情延伸——可以是追問、惱羞成怒、提出荒謬的測試方案、嘴上說無所謂但明顯在意）"
}
\`\`\`

### 要求
1. **gm_narration 是敘事核心！** galgame 的靈魂——場景、光影、表情、動作、氛圍，寫出畫面感
2. **char_insight 是情感核心！** 每回合要有一個真實的推斷或反應，可以深刻也可以搞笑崩潰，**不要一昧昇華**，遊戲樂趣感同樣重要
3. **inner_thought 必須包含預測**：猜${user.name}會把哪個選項定最高分，理由是什麼
4. **⚠️ 世界觀必須延續！** 開場 GM 建立的世界觀必須保持，不能突然回現實
5. **劇情連續性**：承接之前的回合，構成連貫的故事弧
6. 三個選項分數要有差異，可以負數；設置"看似正確但實際扣分"的陷阱選項
7. 角色**不知道**選項分數，根據自己判斷來選，不要每次選最"討好"的
8. 所有內容符合角色性格`;
}

/**
 * 構建 AI 輔助生成選項的 prompt — galgame 場景版
 */
export function buildOptionAssistPrompt(
    char: CharacterProfile,
    user: UserProfile,
    currentAffinity: number,
    roundNumber: number,
    previousRounds: GuidebookRound[],
    scenarioHint: string,
    recentMessages?: string,
    worldContext?: string,
    directionHint?: string
): string {
    const coreContext = ContextBuilder.buildCoreContext(char, user, true);
    const chatBlock = buildRecentChatBlock(recentMessages)?.replace('{user}', user.name);

    let roundHistory = '';
    if (previousRounds.length > 0) {
        roundHistory = '\n之前的劇情: ';
        roundHistory += previousRounds.map(r => {
            const chosen = r.options[r.charChoice];
            return `第${r.roundNumber}回合「${r.gmNarration?.slice(0, 30)}...」→「${chosen?.text || '?'}」`;
        }).join(' → ');
    }

    const worldBlock = worldContext ? `
### ⚠️ 已建立的世界觀和場景（開場 GM 描述的，你必須在這個世界觀下生成場景和選項！）
${worldContext}
---
` : '';
    const directionBlock = directionHint ? `\n用戶希望劇情往這個方向發展: ${directionHint}` : '';

    return `${coreContext}
${chatBlock}
${worldBlock}
---

你是一個 galgame 遊戲助手。在"攻略本"遊戲中，${char.name}正在嘗試攻略${user.name}。
需要幫忙生成下一回合的**劇情場景**和**3個選項**。

${scenarioHint ? `當前世界觀/場景設定: ${scenarioHint}` : ''}${directionBlock}
當前好感度: ${currentAffinity}，第${roundNumber}回合。
${roundHistory}

要求：
1. **scenario** 要寫成 galgame 風格的場景描述（2-3句，有畫面感，承接之前的劇情發展）
2. **⚠️ 必須在已建立的世界觀裡！** 如果開場是遊戲世界/異世界/校園等，場景和選項都必須在那個世界裡，不能回到現實
3. 每個選項是**${char.name}在這個場景下可以做的一個具體行為**
4. 選項要和當前場景/劇情發展相關，不要脫離語境
5. 要有一個看似甜蜜但${user.name}可能不吃這套的選項（分數由用戶決定，但你建議一個參考分）
6. 要有一個看似危險/冒犯但實際可能加分的反差選項
7. 分數範圍 -15 到 +20，要有正有負
8. 選項要有畫面感、有趣，融入當前劇情場景

輸出 JSON：
\`\`\`json
{
  "scenario": "galgame 風格的場景描寫（2-3句，有畫面感）",
  "options": [
    { "text": "${char.name}在這個場景下的行為描述", "affinity": 10 },
    { "text": "${char.name}在這個場景下的行為描述", "affinity": -5 },
    { "text": "${char.name}在這個場景下的行為描述", "affinity": 15 }
  ]
}
\`\`\``;
}

/**
 * 構建結算卡片 prompt — galgame ending 風格
 */
export function buildEndCardPrompt(
    char: CharacterProfile,
    user: UserProfile,
    initialAffinity: number,
    finalAffinity: number,
    rounds: GuidebookRound[],
    recentMessages?: string
): string {
    const coreContext = ContextBuilder.buildCoreContext(char, user, true);
    const chatBlock = buildRecentChatBlock(recentMessages)?.replace('{user}', user.name);

    const roundSummary = rounds.map(r => {
        const chosen = r.options[r.charChoice];
        return `第${r.roundNumber}回合: 「${r.gmNarration?.slice(0, 40)}...」→ 選了「${chosen?.text || '?'}」(${chosen?.affinity >= 0 ? '+' : ''}${chosen?.affinity}) → 好感度${r.affinityAfter}${r.charExploration ? ` [互動: ${r.charExploration.slice(0, 40)}...]` : ''}`;
    }).join('\n');

    const affinityChange = finalAffinity - initialAffinity;
    const trend = affinityChange > 0 ? '上升' : affinityChange < 0 ? '下降' : '不變';

    return `${coreContext}
${chatBlock}
---

## 🎮 攻略本 · Ending

${char.name}玩了"攻略${user.name}"的 galgame 小遊戲，現在生成 **galgame ending 結算卡片**。

### 遊戲數據
- 初始好感度: ${initialAffinity}
- 最終好感度: ${finalAffinity}
- 好感度變化: ${affinityChange >= 0 ? '+' : ''}${affinityChange} (${trend})
- 總回合數: ${rounds.length}

### 劇情回顧
${roundSummary}

### 輸出格式
\`\`\`json
{
  "title": "一個 galgame ending 風格的標題（如 'True End: 命運的交匯點'、'Normal End: 擦肩而過'、'Bad End: 越努力越倒退' 等，要有 galgame 感）",
  "verdict": "${char.name}對這次遊戲的總結評價（2-3句，符合角色性格，可以吐槽、不服、感慨等）",
  "highlights": ["回顧幾個關鍵/搞笑/心動的劇情瞬間（1-3條，每條一句話，引用具體的場景描寫）"],
  "charSummary": "（3-5句）${char.name}對${user.name}的真誠感想。galgame 結局獨白風格——溫暖、有洞察力、引用遊戲中的具體劇情場景。讓${user.name}覺得這段小故事是有意義的。",
  "charNewInsight": "（重要！1-3句）這局遊戲專門讓你發現或確認了${user.name}的哪一個具體特質？要點出這場遊戲裡最讓你意外或最有意思的一個發現。不能泛泛說'更瞭解你了'——要說出具體是什麼：比如'原來你在做選擇時，表面上考慮後果，骨子裡其實跟著直覺走' 或者 '你對這道題的打分讓我意識到，你對"努力"這件事本身有某種不信任'。這句話要讓${user.name}看了覺得：對，這是只有玩了這個遊戲才能發現的自己。"
}
\`\`\`

### 要求
1. title 要像 galgame ending 標題，有儀式感（True End / Normal End / Bad End + 副標題）
2. verdict 要完全符合角色性格
3. highlights 引用具體的劇情場景，不要泛泛而談
4. **charSummary** galgame 結局獨白風格，溫暖真誠有洞察力
5. **charNewInsight 是最重要的部分**：這是玩家下次想回來玩的原因——因為這裡有對方真實看見了自己的感覺。必須具體，不能模糊`;
}
