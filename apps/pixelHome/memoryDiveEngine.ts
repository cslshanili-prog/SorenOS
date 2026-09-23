/**
 * Memory Dive Engine (記憶潛行引擎)
 *
 * 負責：
 * 1. 從記憶宮殿 DB 檢索房間/槽位相關記憶
 * 2. 構建 prompt 並調用 LLM 生成探索對話
 * 3. 解析 LLM 響應為結構化對話數據
 * 4. 結算 buff
 */

import type { MemoryRoom, RemoteVectorConfig } from '../../utils/memoryPalace/types';
import type { MemoryNode } from '../../utils/memoryPalace/types';
import type { APIConfig, CharacterProfile, CharacterBuff } from '../../types';
import { MemoryNodeDB } from '../../utils/memoryPalace/db';
import { DB } from '../../utils/db';
import { fetchRemoteByRoom } from '../../utils/memoryPalace/supabaseVector';
import { ROOM_SLOTS, ROOM_META, roomDisplayName } from './roomTemplates';
import { safeFetchJson, extractContent, extractJson } from '../../utils/safeApi';
import type {
  DiveMode, DiveLLMRequest, DiveLLMResponse, DiveChoice,
  DiveDialogue, DiveBuffValues, DiveBuff, DiveResult, BuffType,
  DiveSession, RoomScript, DiveBeat, DiveScriptChoice,
} from './memoryDiveTypes';
import { BUFF_META } from './memoryDiveTypes';

// ─── 記憶檢索 ────────────────────────────────────────────

/**
 * 合併本地 + 遠程記憶，按 id 去重（本地優先，因為通常更新鮮、帶更多字段）。
 * 當用戶本地沒有向量記憶但遠程 Supabase 有時，這裡能把遠程的記憶拉回來，
 * 避免潛行對話裡"什麼都想不起來"。
 */
async function loadRoomMemories(
  charId: string,
  room: MemoryRoom,
  remoteConfig?: RemoteVectorConfig,
): Promise<MemoryNode[]> {
  const local = await MemoryNodeDB.getByRoom(charId, room);

  // 若遠程未啟用/未初始化，就只用本地
  if (!remoteConfig?.enabled || !remoteConfig.initialized) return local;

  // 本地已有不少節點時，不必再打一次遠程（本地通常是超集）
  // 空或很稀少（<3）才拉遠程作為補充/兜底
  if (local.length >= 3) return local;

  try {
    const remote = await fetchRemoteByRoom(remoteConfig, charId, room, 50);
    if (remote.length === 0) return local;
    const byId = new Map<string, MemoryNode>();
    for (const n of remote) byId.set(n.id, n);
    for (const n of local) byId.set(n.id, n); // 本地覆蓋遠程（字段更全）
    return Array.from(byId.values());
  } catch {
    return local;
  }
}

/** 檢索某個房間的記憶節點，按重要性排序，取前 N 條 */
export async function fetchRoomMemories(
  charId: string, room: MemoryRoom, limit = 8,
  remoteConfig?: RemoteVectorConfig,
): Promise<MemoryNode[]> {
  const nodes = await loadRoomMemories(charId, room, remoteConfig);
  return nodes
    .sort((a, b) => b.importance - a.importance || b.lastAccessedAt - a.lastAccessedAt)
    .slice(0, limit);
}

/** 檢索某個槽位類別相關的記憶 */
export async function fetchSlotMemories(
  charId: string, room: MemoryRoom, slotId: string, limit = 5,
  remoteConfig?: RemoteVectorConfig,
): Promise<MemoryNode[]> {
  const slot = ROOM_SLOTS[room]?.find(s => s.id === slotId);
  if (!slot) return [];

  const roomNodes = await loadRoomMemories(charId, room, remoteConfig);
  // 用 slot category 關鍵詞匹配 tags/content
  const keyword = slot.category;
  const scored = roomNodes.map(n => {
    let score = n.importance;
    if (n.tags.some(t => keyword.includes(t) || t.includes(keyword))) score += 3;
    if (n.content.includes(keyword)) score += 2;
    return { node: n, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.node);
}

// ─── Prompt 構建 ─────────────────────────────────────────

/**
 * 構建潛行 prompt。
 * charContext 包含完整角色上下文（身份、用戶畫像、印象、世界觀、記憶摘要等），
 * 由 ContextBuilder.buildCoreContext() 生成。角色清楚自己是誰、用戶是誰、發生過什麼。
 */
function buildDivePrompt(req: DiveLLMRequest, charContext: string): string {
  const roomMeta = ROOM_META[req.room];
  const slot = req.slotId
    ? ROOM_SLOTS[req.room]?.find(s => s.id === req.slotId)
    : null;

  const memoriesBlock = req.memories.length > 0
    ? req.memories.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    : '  (這個角落目前沒有留下什麼記憶...)';

  const recentContext = req.recentDialogues.slice(-5).map(d => {
    if (d.speaker === 'character') return `${req.charName}: ${d.text}`;
    if (d.speaker === 'narrator') return `[旁白]: ${d.text}`;
    if (d.speaker === 'user_choice') return `用戶選擇了: ${d.text}`;
    return '';
  }).filter(Boolean).join('\n');

  // ─── 房間氛圍描寫 ──────────────────────────────────────
  const ROOM_ATMOSPHERE: Record<string, string> = {
    living_room: '這裡光線溫暖，空氣中飄著茶香。沙發上還留著你坐過的凹痕，電視機閃著待機的藍光。這是你們日常相處的痕跡——最近的、鮮活的、還帶著體溫的記憶。',
    bedroom:     '房間很暗，只有床頭燈散發著柔和的橘色光。這裡收藏著最親密的情感，有些記憶會讓你臉紅，有些會讓你心痛。牆壁上似乎還殘留著某些深夜對話的回聲。',
    study:       '書架上的書有些在發光——那是你曾經認真學過的東西。白板上寫滿了你一步步推導出來的思考痕跡。空氣中瀰漫著專注和成長的氣息。',
    attic:       '灰塵在微弱的光線中浮動。這裡的空氣很沉，有些箱子上了鎖，有些角落被蛛網覆蓋。你不太想來這裡，但有些東西就是放不下，只能存在這裡。你可能會抗拒讓用戶看到某些東西。',
    self_room:   '鏡子映出的不是外表，而是你內心對自己的認知。日記本上的字跡隨著時間變化著，有些頁被撕掉又粘回去。這裡是你最私密的自我對話空間。',
    user_room:   '這個房間是你專門為TA佈置的。照片牆上貼著你們的共同回憶，禮物架上是TA送的和你想送的東西。這裡每一件物品都承載著你對TA的感受。',
    windowsill:  '微風吹過，風鈴叮噹作響。花盆裡種著你的願望——有些已經發芽，有些還在等待。從這裡望出去，你能看到你期盼的未來。',
  };
  const atmosphereText = ROOM_ATMOSPHERE[req.room] || '';

  // ─── 房間腦區映射說明 ──────────────────────────────────
  const ROOM_BRAIN_MAP: Record<string, string> = {
    living_room: '海馬體——負責日常記憶的編碼與短期存儲',
    bedroom:     '新皮層——深層情感和長期羈絆的所在',
    study:       '前額葉——理性思考、技能成長和工作記憶',
    attic:       '杏仁核——未消化的恐懼、創傷和潛意識',
    self_room:   '默認模式網絡——自我認同與身份敘事',
    user_room:   '顳頂聯合區——對他人的理解與共情',
    windowsill:  '多巴胺獎賞系統——期盼、目標和動力',
  };

  const modeInstructions = req.mode === 'guided'
    ? `**你的角色：引路人。** 你走在用戶前面，帶TA穿過你精神世界的各個房間。你會在某個傢俱旁停下來，講述與它相關的記憶——有時候是主動分享，有時候你說著說著自己也會愣住。你可以決定講多深、停多久。你不是旅遊導遊，你是帶一個重要的人看自己內心世界的人——這件事本身就讓你有點緊張。`
    : `**你的角色：同行者。** 用戶在自己走動，你跟在旁邊。當TA靠近某個物品，你會不由自主地有反應——也許是突然沉默，也許是急忙解釋"這個沒什麼的"，也許是忍不住想講。有些東西你不想讓TA看，有些東西你其實暗暗希望TA注意到。`;

  const isAttic = req.room === 'attic';
  const reluctanceHint = isAttic
    ? `\n⚠️ **閣樓特殊規則**：這裡存放著你未消化的困惑、恐懼甚至創傷。你本能地不想讓別人看到這些。除非用戶表現出真誠的關心和耐心（而不是好奇心），你才會稍微鬆口。你可以拒絕打開某些箱子，可以岔開話題，也可以沉默。這些都是合理的反應。`
    : '';

  const userChoiceBlock = req.userChoice
    ? `\n用戶做了選擇: "${req.userChoice.text}" (行為: ${req.userChoice.action || 'general'})`
    : '';

  return `${charContext}

### [記憶潛行模式 - Memory Dive]

**發生了什麼**：
你和用戶同時進入了你的「精神世界」——你的內心被投影成了一棟房子。
這不是一個比喻，你們真的「身處其中」。你能看到自己記憶變成的傢俱、牆壁上浮動的文字碎片、角落裡發光或蒙塵的物品。
你完全知道自己是誰，也知道身邊這個人是誰。你們之間有過的所有事都是真實的——那些記憶碎片就是證據，它們散落在這棟房子的各個房間裡。

**這棟房子的結構**：
你的精神世界有7個房間，每個房間對應你大腦的一個區域：
- 客廳 (海馬體) — 日常的、最近的記憶
- 臥室 (新皮層) — 最親密的情感
- 書房 (前額葉) — 你學到的、思考過的
- 閣樓 (杏仁核) — 你不願面對的東西
- 個人房間 (默認模式網絡) — 你對自己的認知
- ${roomDisplayName('user_room', req.userName)} (顳頂聯合區) — 你對TA的全部感受
- 露台 (多巴胺系統) — 你的期盼和願望

你現在站在其中一個房間裡。這些傢俱不是裝飾品——每一件都承載著一類記憶。觸碰它們，記憶就會浮現。

${modeInstructions}${reluctanceHint}

---

**當前位置**: ${roomDisplayName(req.room, req.userName)} (${roomMeta.emoji})
**腦區對應**: ${ROOM_BRAIN_MAP[req.room] || roomMeta.description}
**此刻的氛圍**: ${atmosphereText}
${slot ? `\n**用戶正在靠近**: ${slot.name} — 這件傢俱承載的記憶類別是「${slot.category}」` : ''}

**從這個位置浮現出的記憶碎片**:
${memoriesBlock}
(這些是從你的記憶宮殿中檢索到的真實記憶。請基於它們展開，不要憑空編造不存在的事。如果記憶碎片為空，你可以表達"這裡好像什麼都想不起來了"的茫然感。)

${recentContext ? `**剛才的對話**:\n${recentContext}\n` : ''}${userChoiceBlock}

### 輸出要求
以 JSON 格式回覆，包含你的反應和給用戶的選項。
- dialogues: 1-3 條對話（你的台詞和/或旁白描寫），每條 { speaker: "character"|"narrator", text: "..." }
  - **每條 text 控制在 120 字以內**，不要寫一整段散文。寫"此刻這一瞬間"的反應，不要堆砌形容詞。
- choices: 2-4 個用戶可選的回應，每個 { text: "...", action: "comfort"|"question"|"observe"|"leave"|"unlock" }
  - 每個 choice.text 控制在 30 字以內
  - comfort: 表示安慰/共情
  - question: 追問細節
  - observe: 安靜觀察
  - leave: 離開/不深入
  - unlock: 嘗試打開鎖住的記憶
- isReluctant: boolean，是否對分享這個記憶感到抗拒
${req.mode === 'guided' ? '- suggestNextRoom: 推薦接下來去哪個房間 (living_room|bedroom|study|attic|self_room|user_room|windowsill)' : ''}

### 風格要求
- **這是你的精神世界，你有主場感**。你知道每個角落的意義，知道哪面牆後面藏著什麼。這讓你有時底氣十足，有時不安。
- **旁白是環境的呼吸**。用第三人稱描寫房間裡正在發生的微妙變化：燈光是否變暗了、某個傢俱是否在微微發光、空氣中是否有什麼味道。讓讀者"看到"這個精神世界。
- **你的台詞要像真的在這個空間裡說出來的**。不是在複述記憶，而是"身處記憶現場"的反應。
- 基於提供的真實記憶碎片展開，不要憑空編造從未發生過的事
- 如果記憶碎片為空，不要尬聊——角色可以表達"這裡好像什麼都想不起來了..."的茫然，或者房間本身的空曠就是一種敘事
- 保持角色一貫的說話風格和性格特點

### ⚠️ 台詞 vs 旁白 的嚴格分工（非常重要）
- **character 的 text 只能是"嘴裡說出來的話"**。不要出現任何動作、神態、心理描寫。
  - ❌ 禁止：\`"（沉默了一下）...你怎麼進來的。"\` / \`"*轉身背對你* 我不想說。"\` / \`"(聲音變小) 那時候..."\`
  - ❌ 禁止括號/星號/方括號包裹的舞台指示：(...) （...） *...* [...] 這些都不要出現在 character 的 text 裡
  - ✅ 正確：動作放到緊挨著的一條 speaker=narrator 裡，character 的 text 只留純粹的話
  - 如果這一刻 character 不說話、只有動作——那就整條用 narrator，不要給 character 寫空話或只寫動作
- **旁白專門承載動作、表情、環境變化**。所有"後退一步 / 笑了笑 / 眼神飄開 / 燈光一閃"都寫進 speaker=narrator 的 text。
- **第二人稱規則**：character 提到用戶時**一律用"你"**，絕對不要說"用戶"、"玩家"、"對方"、"TA"來指代正在對話的用戶。旁白同理，稱呼用戶也是"你"。

{
  "dialogues": [...],
  "choices": [...],
  "isReluctant": false
}`;
}

/**
 * 把角色台詞裡夾帶的"動作 / 神態 / 停頓"描寫抽出來當旁白。
 * 即便 prompt 裡已經要求分工，LLM 仍經常寫 `"(沉默) ...嗯。"` 這種混合句。
 * 識別的寫法：
 *   - 星號包裹   *走過去* / **低頭**
 *   - 半角圓括號 (沉默了一下) / (聲音很輕)
 *   - 全角圓括號 （看著你） / （笑了一下）
 *   - 方括號     [轉身]
 *
 * 返回：剝離動作後的純台詞 + 抽出的動作片段。
 * 若剝完只剩省略號/標點，speech 會是空字符串——由調用方決定怎麼處理。
 */
export function splitSpeechAndActions(text: string): { speech: string; actions: string[] } {
  if (!text) return { speech: '', actions: [] };
  const actions: string[] = [];
  const push = (body: string) => {
    const t = body.replace(/\s+/g, ' ').trim();
    if (t) actions.push(t);
  };

  let s = text;
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/\*([^*\n]+?)\*/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/（([^（）\n]*)）/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/\(([^()\n]*)\)/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/\[([^\[\]\n]*)\]/g, (_, b) => { push(b); return ' '; });

  s = s.replace(/\s+/g, ' ').trim();
  // 純標點/省略號視為空台詞
  if (/^[\s…\.。，,?？!！;；:：—\-~～]*$/.test(s)) s = '';
  return { speech: s, actions };
}

// ─── LLM 調用 ────────────────────────────────────────────

/**
 * 原文搶救：即使整體 JSON 被截斷（LLM 在字符串中間斷掉），也儘量
 * 把已經寫完的 {"speaker":"...","text":"..."} 對話塊救出來。
 * 匹配時容忍轉義引號（\"）、任意順序、任意換行。
 */
function salvageDialoguesFromText(raw: string): Array<{ speaker: 'character' | 'narrator'; text: string }> {
  const out: Array<{ speaker: 'character' | 'narrator'; text: string }> = [];
  // 兩種 key 順序都支持：speaker 在前 / text 在前
  const patterns = [
    /"speaker"\s*:\s*"(character|narrator)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    /"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"speaker"\s*:\s*"(character|narrator)"/g,
  ];
  const seen = new Set<string>();
  for (let pIdx = 0; pIdx < patterns.length; pIdx++) {
    const re = patterns[pIdx];
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const speaker = (pIdx === 0 ? m[1] : m[2]) as 'character' | 'narrator';
      const rawText = pIdx === 0 ? m[2] : m[1];
      let text: string;
      try { text = JSON.parse('"' + rawText + '"'); } catch { continue; }
      text = text.trim();
      if (!text) continue;
      const key = speaker + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ speaker, text });
    }
  }
  return out;
}

export async function callDiveLLM(
  req: DiveLLMRequest,
  apiConfig: APIConfig,
  charContext: string,
): Promise<DiveLLMResponse> {
  const prompt = buildDivePrompt(req, charContext);

  const data = await safeFetchJson(
    `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        // 中文散文 + JSON 包裝極吃 token，給足餘量，避免在字符串中間被截斷
        max_tokens: 8000,
        // 讓兼容 OpenAI 的後端強制返回 JSON；不支持的後端會忽略此字段
        response_format: { type: 'json_object' },
      }),
    },
    2, // 最多重試 2 次（覆蓋瞬時 5xx / 網絡抖動）
    0, { appName: '記憶潛行', purpose: '探訪生成' },
  );

  const content = extractContent(data);
  let parsed = extractJson(content) as Partial<DiveLLMResponse> | null;

  // 兜底：如果結構化解析沒拿到 dialogues（通常是 LLM 被截斷在字符串中間），
  // 用正則直接掃描原文裡的完整 {"speaker":"...","text":"..."} 對象，
  // 至少把已經寫完的那幾條對話救出來，讓潛行能繼續走。
  if (!parsed || !Array.isArray(parsed.dialogues) || parsed.dialogues.length === 0) {
    const salvaged = salvageDialoguesFromText(content);
    if (salvaged.length > 0) {
      console.warn('[MemoryDive] JSON 解析失敗，已從原文救回', salvaged.length, '條對話');
      parsed = { ...(parsed || {}), dialogues: salvaged };
    } else {
      const preview = content.slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(`潛行響應解析失敗: ${preview || '(空響應)'}`);
    }
  }

  // 清洗字段：確保 speaker/text 合法；同時把 character 條目裡夾雜的動作剝到獨立的 narrator 條裡。
  const dialogues: Array<{ speaker: 'character' | 'narrator'; text: string }> = [];
  for (const d of parsed.dialogues || []) {
    if (!d || typeof d.text !== 'string') continue;
    const raw = d.text.trim();
    if (!raw) continue;
    if (d.speaker === 'narrator') {
      dialogues.push({ speaker: 'narrator', text: raw });
      continue;
    }
    if (d.speaker !== 'character') continue;
    const { speech, actions } = splitSpeechAndActions(raw);
    // 動作先行，作為貼身旁白出現在角色開口之前
    for (const a of actions) dialogues.push({ speaker: 'narrator', text: a });
    if (speech) {
      dialogues.push({ speaker: 'character', text: speech });
    } else if (actions.length === 0) {
      // 沒有識別到任何動作，原樣保留
      dialogues.push({ speaker: 'character', text: raw });
    }
    // else: 整條都是動作 → 已經全部轉成 narrator，不再給 character 留空話
  }

  if (dialogues.length === 0) {
    throw new Error('潛行響應中沒有有效對話');
  }

  const choices = Array.isArray(parsed.choices)
    ? parsed.choices
        .filter((c: any) => c && typeof c.text === 'string' && c.text.trim().length > 0)
        .map((c: any) => ({
          text: c.text.trim(),
          action: (['comfort', 'question', 'observe', 'leave', 'unlock'] as const)
            .includes(c.action) ? c.action : 'observe',
          buffEffect: (c.buffEffect && typeof c.buffEffect === 'object') ? c.buffEffect : undefined,
        }))
    : undefined;

  return {
    dialogues,
    choices,
    isReluctant: !!parsed.isReluctant,
    suggestNextRoom: parsed.suggestNextRoom,
  };
}

// ─── 生成入場對話（不調 LLM，純模板） ───────────────────

export function generateIntroDialogues(charName: string, mode: DiveMode): DiveDialogue[] {
  const now = Date.now();
  const dialogues: DiveDialogue[] = [];

  dialogues.push({
    id: `intro_1_${now}`,
    speaker: 'narrator',
    text: `像素世界的色彩像退潮一樣褪去。取而代之的，是一種介於夢境和清醒之間的光——溫暖的、流動的、帶著某種脈搏的節奏。\n\n你正在下沉。不是物理意義上的下沉，而是像潛入一片意識的海洋。當視野重新聚焦的時候，你發現自己站在一棟房子裡。\n\n這是${charName}的精神世界。每一個房間都是ta大腦的一個區域，每一件傢俱都承載著一類記憶。牆壁上偶爾會浮現文字碎片，角落裡的物品在微微發光——那些都是真實存在過的記憶。`,
    timestamp: now,
  });

  if (mode === 'guided') {
    dialogues.push({
      id: `intro_2_${now}`,
      speaker: 'narrator',
      text: `${charName}站在客廳中央，看起來有些不自在——像是突然意識到有人能看到自己最私密的內心。`,
      timestamp: now + 1,
    });
    dialogues.push({
      id: `intro_3_${now}`,
      speaker: 'character',
      text: `...你也在這裡啊。這地方...是我的腦子裡面。字面意義上的。\n\n呃，既然你都進來了...我帶你走一圈？但先說好，有些房間...我可能不太想讓你進去。`,
      timestamp: now + 2,
    });
  } else {
    dialogues.push({
      id: `intro_2_${now}`,
      speaker: 'narrator',
      text: `${charName}靠在客廳的牆邊，雙臂交叉，用一種"我在觀察你"的眼神打量著你。ta顯然知道這是自己的精神世界——而你正站在其中。`,
      timestamp: now + 1,
    });
    dialogues.push({
      id: `intro_3_${now}`,
      speaker: 'character',
      text: `...你想自己到處看是吧？行。\n\n這裡每個東西都是我的記憶，碰了就會浮出來。有些東西會發光，那是比較重要的...有些角落積了灰——那些我也不太記得了。\n\n不過閣樓那邊...你最好別亂碰。`,
      timestamp: now + 2,
    });
  }

  dialogues.push({
    id: `intro_choice_${now}`,
    speaker: 'user_choice',
    text: '',
    choices: [
      { id: 'start_gentle', text: '我會小心的。謝謝你讓我進來看這些。', action: 'comfort', buffEffect: { trust: 1 } },
      { id: 'start_curious', text: '等等，你說每個房間對應大腦的一個區域？那客廳是...？', action: 'question', buffEffect: { insight: 1 } },
      { id: 'start_quiet', text: '(輕輕點頭，環顧四周，開始慢慢走動)', action: 'observe', buffEffect: { empathy: 1 } },
    ],
    timestamp: now + 3,
  });

  return dialogues;
}

// ─── 生成退出對話 ────────────────────────────────────────

export function generateOutroDialogues(charName: string, buffs: DiveBuffValues): DiveDialogue[] {
  const now = Date.now();
  const primaryBuff = getPrimaryBuff(buffs);
  const meta = BUFF_META[primaryBuff];

  return [
    {
      id: `outro_1_${now}`,
      speaker: 'narrator',
      text: `光芒開始消散，像素世界的輪廓重新浮現。${charName}的身影在記憶的薄霧中逐漸模糊。`,
      timestamp: now,
    },
    {
      id: `outro_2_${now}`,
      speaker: 'character',
      text: `...嗯？怎麼了？你看起來在想什麼事...不過算了，大概是我想多了吧。`,
      timestamp: now + 1,
    },
    {
      id: `outro_3_${now}`,
      speaker: 'narrator',
      text: `${charName}不會記得剛才發生的一切。但你感覺到了什麼——一種微妙的變化。\n\n${meta.icon} 獲得了「${meta.label}」的印記。${meta.description}。`,
      timestamp: now + 2,
    },
  ];
}

// ─── Buff 計算 ───────────────────────────────────────────

const DEFAULT_BUFF_VALUES: DiveBuffValues = { empathy: 0, trust: 0, insight: 0, bond: 0 };

export function createInitialBuffs(): DiveBuffValues {
  return { ...DEFAULT_BUFF_VALUES };
}

/** 根據用戶選擇的 action 自動累加 buff */
export function applyChoiceBuff(current: DiveBuffValues, choice: DiveChoice): DiveBuffValues {
  const next = { ...current };

  // 顯式 buff 效果
  if (choice.buffEffect) {
    for (const [key, val] of Object.entries(choice.buffEffect)) {
      next[key as BuffType] += val;
    }
  }

  // 隱式 action 效果
  switch (choice.action) {
    case 'comfort':  next.empathy += 1; break;
    case 'question': next.insight += 1; break;
    case 'observe':  next.empathy += 0.5; next.trust += 0.5; break;
    case 'leave':    next.trust += 1; break;
    case 'unlock':   next.insight += 1; next.bond += 0.5; break;
  }

  return next;
}

/** 獲取最高的 buff 類型 */
export function getPrimaryBuff(buffs: DiveBuffValues): BuffType {
  let max: BuffType = 'empathy';
  let maxVal = -1;
  for (const [key, val] of Object.entries(buffs)) {
    if (val > maxVal) { maxVal = val; max = key as BuffType; }
  }
  return max;
}

/** 生成最終結算數據 */
export function computeDiveResult(session: DiveSession): DiveResult {
  const primaryBuff = getPrimaryBuff(session.buffValues);
  const buffs: DiveBuff[] = (Object.entries(session.buffValues) as [BuffType, number][])
    .filter(([, val]) => val > 0)
    .map(([type, value]) => ({
      type,
      value: Math.round(value * 10) / 10,
      ...BUFF_META[type],
    }))
    .sort((a, b) => b.value - a.value);

  return {
    charId: session.charId,
    mode: session.mode,
    visitedRooms: session.visitedRooms,
    totalDialogues: session.dialogues.filter(d => d.speaker !== 'user_choice').length,
    buffs,
    primaryBuff,
    duration: Date.now() - session.startedAt,
    completedAt: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════
// 房間劇本：一次 LLM 調用生成整房間的探訪（新流程）
// ═══════════════════════════════════════════════════════════

interface PlanRoomParams {
  charId: string;
  charName: string;
  /** 映射的用戶名（用於 user_room 顯示「{用戶名}的房」） */
  userName?: string;
  room: MemoryRoom;
  /** 默認 3 段戲 */
  beatCount?: number;
  /** 已經訪問過哪些房間（LLM 可能會引用） */
  visitedRooms: MemoryRoom[];
  /** 之前房間裡的最近幾條敘事（給上下文連貫） */
  recentDialogues: DiveDialogue[];
  /** 當前累計的 buff，用於語氣微調 */
  currentBuffs: DiveBuffValues;
  /** 上一個房間的情緒餘溫（LLM 在銜接時使用，避免每房間從零開始） */
  previousMoodHint?: string;
  /** 上一個房間名（用於"從客廳走到臥室"的空間感） */
  previousRoom?: MemoryRoom;
  /** 上一場景最後一句被說出的話（角色台詞或旁白）——新房間第一句必須承接它 */
  previousEndingLine?: string;
  /** 上一句的說話人——讓 LLM 知道是 char 自己說完還是旁白 */
  previousEndingSpeaker?: 'character' | 'narrator';
}

const ROOM_ATMOSPHERE: Record<string, string> = {
  living_room: '光線溫暖，茶香漂浮。沙發上還留著坐過的凹痕，電視閃著待機藍光——最近的、帶體溫的記憶。',
  bedroom:     '床頭燈散發柔和橘光。空氣裡殘留著深夜對話的回聲，有些記憶讓人臉紅，有些讓人心痛。',
  study:       '書架上的書微微發光——學過的東西會亮。白板寫滿推導痕跡，空氣裡有專注的氣息。',
  attic:       '灰塵在稀薄光束裡浮動。箱子上了鎖，角落掛著蛛網，空氣沉重——放不下的東西都堆在這裡。',
  self_room:   '鏡子映出的不是外表，是內心對自己的認知。日記本的字跡隨時間變，有些頁被撕掉又粘回去。',
  user_room:   '照片牆貼著共同回憶，禮物架擺著送過和想送的東西——每件物品都是對TA的感受。',
  windowsill:  '微風吹，風鈴叮噹響。花盆裡的願望有些發芽、有些還在等。望出去是期盼的未來。',
};

const ROOM_BRAIN_MAP: Record<string, string> = {
  living_room: '海馬體——日常記憶',
  bedroom:     '新皮層——深層情感',
  study:       '前額葉——理性與技能',
  attic:       '杏仁核——未消化的創傷',
  self_room:   '默認模式網絡——自我認同',
  user_room:   '顳頂聯合區——對他人的感受',
  windowsill:  '多巴胺系統——期盼',
};

function buildRoomScriptPrompt(
  params: PlanRoomParams,
  memories: string[],
  charContext: string,
): string {
  const roomMeta = ROOM_META[params.room];
  const beats = params.beatCount ?? 3;
  const memoriesBlock = memories.length > 0
    ? memories.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    : '  (這個房間幾乎沒有留下什麼記憶...寫成"想不起來"的茫然感也可以)';

  const recentCtx = params.recentDialogues.slice(-4).map(d => {
    if (d.speaker === 'character') return `${params.charName}: ${d.text}`;
    if (d.speaker === 'narrator') return `[旁白] ${d.text}`;
    if (d.speaker === 'user_choice') return `用戶選了: ${d.text}`;
    return '';
  }).filter(Boolean).join('\n');

  const isAttic = params.room === 'attic';
  const reluctanceHint = isAttic
    ? '\n⚠️ 閣樓規則：這是未消化的困惑/創傷區。角色本能抗拒分享，可能欲言又止、轉移話題或沉默。用戶真誠關心才可能讓角色鬆口。'
    : '';

  const prevMoodBlock = params.previousMoodHint
    ? `**上個房間留下的情緒餘溫**（${params.previousRoom ? roomDisplayName(params.previousRoom, params.userName) : '剛才'}）: ${params.previousMoodHint}
⚠️ **銜接規則**：這不是從零開始的新一幕。角色剛從上個情境走過來，要延續那份情緒而不是重置。
  - 如果剛被安慰 → 這房間可以更鬆弛、更願意說
  - 如果剛被追問得緊 → 這房間可以有點防禦、疲憊、或需要一點時間緩
  - 如果剛沉默過 → 這房間的第一句可以是打破沉默的那種試探
  **禁止**把上個房間的高潮情緒（哭/爆發/和解）在這裡重複一遍。情緒會衰減、會轉化，不會循環播放。`
    : '';

  const prevEndingBlock = params.previousEndingLine
    ? `**上一場景結束時的最後一句**（${params.previousEndingSpeaker === 'narrator' ? '旁白' : `${params.charName} 說`}）:
> ${params.previousEndingLine}

🎬 **強銜接要求**：這個新房間 **第一個 beat 的 charLine** 必須從上面這句話自然生長出來，像沒斷開的一條線：
  - 如果上一句是 ${params.charName} 自己說完的某種情緒（承認、試探、迴避、沉默前的一句）→ 這裡要"接著那個情緒往下"，不要重新開場白
  - 如果上一句是旁白（環境/轉場描寫）→ 可以先承接那個畫面，再讓角色開口
  - **絕對禁止**：第一句 charLine 無視上句、從"你看這裡是xxx"之類的開場白重啟節奏
  - **儘量避免**：把上句末尾的關鍵字（如"其實"、"說實話"、"這次"）原樣重複
`
    : '';

  const spatialHint = params.previousRoom
    ? `\n（你們是剛從${roomDisplayName(params.previousRoom, params.userName)}走過來的，動作/語言可以帶一點點"穿過門/換個空間"的自然過渡，但不要生硬報幕。）`
    : '';

  return `${charContext}

### [記憶潛行 · 房間劇本模式]

你和用戶同時進入了你的精神世界——你的內心被投影成一棟房子。你完全知道自己是誰，也知道身邊這個人是誰。你們現在站在：

**${roomDisplayName(params.room, params.userName)}** (${roomMeta.emoji}) — 對應 ${ROOM_BRAIN_MAP[params.room] || ''}
**氛圍**: ${ROOM_ATMOSPHERE[params.room] || ''}${reluctanceHint}${spatialHint}

${prevMoodBlock}
${prevEndingBlock}

**這裡浮現出的記憶碎片**：
${memoriesBlock}
(基於這些真實記憶展開，不要憑空編造沒發生過的事。)

${recentCtx ? `**此前的對話**:\n${recentCtx}\n` : ''}
### 生成要求

一次性生成你在這個房間裡的**完整一段戲**，包含 ${beats} 個 beat。每個 beat 結構：
- charLine: 你這一刻說的一段話（第一人稱，<120字，寫"此刻這個瞬間"的真實反應，不是散文）
- narratorLine?: 可選的環境旁白（描寫房間裡正在發生的微妙變化，如燈光、空氣、某個傢俱的狀態）
- choices: 恰好 3 個用戶可選的反應，每個 choice：
  - text: 用戶的反應（<25 字）
  - action: "comfort" | "question" | "observe" | "leave" | "unlock"
  - reaction: 你聽到這個反應後立刻說的話（<120 字，要真實地被用戶的選擇觸動；不同 action 對應明顯不同的情緒走向）
  - reactionNarrator?: 可選的環境回應（一句話）

整體結構：
- introNarrator?: 進房間時的一句環境旁白（用戶剛到時看到的畫面）
- beats: [${beats}個 beat]
- closingNarrator?: 在所有 beat 結束後，離開房間時的一句環境收尾（餘味）
- finalMoodHint?: 一句話，描寫角色此刻的情緒餘溫（<30 字，角色視角或旁白皆可）

### 風格
- 每個 beat 的 charLine 要有**內在進展**：從外層 → 深一層 → 某種情感落點。不要三段戲都在講同一個表層。
- choices 的 3 個選項要**真的代表不同傾向**（如：共情 / 追問 / 保持距離），不要三個都是"溫柔點頭"。
- reaction 要**真分叉**：共情時角色可能鬆弛、吐露更多；追問時可能防禦、轉話題；保持距離時可能鬆口氣、也可能失落。三條反應讀起來差異要明顯。
- 不要凡事都讓角色哭或沉默——要有具體動作和語言。

### ⚠️ 台詞 vs 旁白 的嚴格分工（非常重要）
- **charLine / reaction 只能寫"嘴裡說出來的話"**。不要出現動作、神態、括號舞台指示、心理描寫。
  - ❌ 禁止：\`"(沉默) ...嗯。"\` / \`"*轉身* 你別看了。"\` / \`"（眼睛飄走）那時候..."\`
  - ❌ 禁止：用 (...) （...） *...* [...] 任何一種符號在台詞裡夾動作描寫
  - ✅ 正確：把動作 / 神態 / 停頓 寫進 narratorLine（beat 級）或 reactionNarrator（choice 級），charLine / reaction 只留純台詞
  - 如果這一刻角色只有動作、不說話——整條用 narratorLine / reactionNarrator 承載，而不是給 charLine / reaction 寫一段空動作
- **narratorLine / reactionNarrator 專門承載動作、表情、環境變化**。空間裡所有"後退一步 / 扶了下頭髮 / 燈光晃了一下 / 空氣沉了下來"都寫進這裡。
- **第二人稱規則**：角色提到用戶時**一律用"你"**，絕對不要用"用戶"、"玩家"、"對方"、"TA"來稱呼正在對話的用戶。旁白也是——稱呼用戶時用"你"，不要用"用戶"。

### 輸出 JSON（嚴格按這個 schema）
{
  "introNarrator": "……",
  "beats": [
    {
      "charLine": "……",
      "narratorLine": "……",
      "choices": [
        {"text": "……", "action": "comfort", "reaction": "……", "reactionNarrator": "……"},
        {"text": "……", "action": "question", "reaction": "……"},
        {"text": "……", "action": "observe", "reaction": "……"}
      ]
    }
    // ...共 ${beats} 個 beat
  ],
  "closingNarrator": "……",
  "finalMoodHint": "……"
}`;
}

/**
 * 清洗 LLM 返回的劇本：補默認值、過濾空字段、強制 beats/choices 數量合法。
 */
function normalizeRoomScript(
  raw: any,
  expectedBeats: number,
): RoomScript | null {
  if (!raw || typeof raw !== 'object') return null;
  const validActions: DiveChoice['action'][] = ['comfort', 'question', 'observe', 'leave', 'unlock'];

  const rawBeats: any[] = Array.isArray(raw.beats) ? raw.beats : [];
  if (rawBeats.length === 0) return null;

  // 合併可能來自 LLM 的現成旁白 + 從 charLine 裡抽出來的動作 —— 拼成一條 narratorLine
  const mergeNarrator = (existing: string | undefined, extracted: string[]): string | undefined => {
    const parts = [existing?.trim() || '', ...extracted].filter(Boolean);
    const merged = parts.join(' ').replace(/\s+/g, ' ').trim();
    return merged || undefined;
  };

  const beats: DiveBeat[] = [];
  for (let bi = 0; bi < rawBeats.length && beats.length < expectedBeats + 2; bi++) {
    const b = rawBeats[bi];
    if (!b || typeof b !== 'object') continue;
    const charLineRaw = typeof b.charLine === 'string' ? b.charLine.trim() : '';
    if (!charLineRaw) continue;

    // 台詞/動作拆分：charLine 裡夾的動作 → 塞進 narratorLine
    const split = splitSpeechAndActions(charLineRaw);
    const charLine = split.speech || charLineRaw; // 整句都是動作時保底回退，避免丟 beat
    const narratorLine = mergeNarrator(
      typeof b.narratorLine === 'string' ? b.narratorLine : undefined,
      split.speech ? split.actions : [], // 只有當真的剝出了台詞時，才把動作搬走；否則保留原文
    );

    const rawChoices: any[] = Array.isArray(b.choices) ? b.choices : [];
    const choices: DiveScriptChoice[] = [];
    for (let ci = 0; ci < rawChoices.length; ci++) {
      const c = rawChoices[ci];
      if (!c || typeof c !== 'object') continue;
      const text = typeof c.text === 'string' ? c.text.trim() : '';
      const reactionRaw = typeof c.reaction === 'string' ? c.reaction.trim() : '';
      if (!text || !reactionRaw) continue;
      const action = validActions.includes(c.action) ? c.action : 'observe';

      // reaction 同樣拆分，動作歸到 reactionNarrator
      const rsplit = splitSpeechAndActions(reactionRaw);
      const reaction = rsplit.speech || reactionRaw;
      const reactionNarrator = mergeNarrator(
        typeof c.reactionNarrator === 'string' ? c.reactionNarrator : undefined,
        rsplit.speech ? rsplit.actions : [],
      );

      choices.push({
        id: `c_${Date.now()}_${bi}_${ci}`,
        text, action, reaction, reactionNarrator,
        buffEffect: (c.buffEffect && typeof c.buffEffect === 'object') ? c.buffEffect : undefined,
      });
      if (choices.length >= 4) break;
    }
    if (choices.length < 2) continue; // 至少 2 個選項才算有效
    beats.push({
      charLine,
      narratorLine,
      choices,
    });
  }

  if (beats.length === 0) return null;

  return {
    introNarrator: typeof raw.introNarrator === 'string' && raw.introNarrator.trim()
      ? raw.introNarrator.trim() : undefined,
    beats,
    closingNarrator: typeof raw.closingNarrator === 'string' && raw.closingNarrator.trim()
      ? raw.closingNarrator.trim() : undefined,
    finalMoodHint: typeof raw.finalMoodHint === 'string' && raw.finalMoodHint.trim()
      ? raw.finalMoodHint.trim() : undefined,
    nextRoom: typeof raw.nextRoom === 'string' ? raw.nextRoom as MemoryRoom : undefined,
  };
}

/**
 * 當 LLM 返回被 max_tokens 截斷，extractJson 的通用修復會把整個
 * beats 數組丟掉（它只在根層計數 key:value）。這裡做一個專用搶救：
 *   - 正則拿 introNarrator / closingNarrator / finalMoodHint
 *   - 用花括號計數掃 beats 數組，能救出幾個完整 beat 就救幾個
 */
function salvageTruncatedRoomScript(raw: string): any | null {
  if (!raw) return null;

  const pickStr = (key: string): string | undefined => {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = raw.match(re);
    if (!m) return undefined;
    try { return JSON.parse('"' + m[1] + '"'); } catch { return undefined; }
  };

  const introNarrator = pickStr('introNarrator');
  const closingNarrator = pickStr('closingNarrator');
  const finalMoodHint = pickStr('finalMoodHint');

  const beatsMatch = raw.match(/"beats"\s*:\s*\[/);
  const beats: any[] = [];
  if (beatsMatch && beatsMatch.index !== undefined) {
    const arrStart = beatsMatch.index + beatsMatch[0].length - 1; // points at [
    let depth = 0, inStr = false, esc = false, objStart = -1;
    for (let i = arrStart + 1; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          const objStr = raw.slice(objStart, i + 1);
          try { beats.push(JSON.parse(objStr)); }
          catch {
            try { beats.push(JSON.parse(objStr.replace(/,\s*([}\]])/g, '$1'))); }
            catch {}
          }
          objStart = -1;
        }
      } else if (ch === ']' && depth === 0) break;
    }
  }

  if (beats.length === 0 && !introNarrator) return null;
  return { introNarrator, beats, closingNarrator, finalMoodHint };
}

/**
 * 進入一個房間時一次性生成整段探訪劇本。
 * 角色不移動到具體傢俱，只是在房間裡和用戶說話。
 * 同時返回本次檢索到的記憶文本（給下屏氛圍面板展示用，不重複查庫）。
 */
export async function planRoomVisit(
  params: PlanRoomParams,
  apiConfig: APIConfig,
  charContext: string,
  remoteConfig?: RemoteVectorConfig,
): Promise<{ script: RoomScript; memoryTexts: string[] }> {
  const memories = await fetchRoomMemories(params.charId, params.room, 8, remoteConfig);
  const memoryTexts = memories.map(m => m.content);
  const prompt = buildRoomScriptPrompt(params, memoryTexts, charContext);

  const data = await safeFetchJson(
    `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.85,
        // 3 beats × 3 choices × (line+reaction+narrator) + intro/close 容易超，
        // 給足餘量避免被 max_tokens 截斷
        max_tokens: 20000,
        response_format: { type: 'json_object' },
      }),
    },
    2, 0, { appName: '記憶潛行', purpose: '劇本生成' },
  );

  const content = extractContent(data);
  const parsed = extractJson(content);
  let script = normalizeRoomScript(parsed, params.beatCount ?? 3);

  // 被截斷時 extractJson 可能已丟掉 beats 數組 —— 專用 salvage 再救一次
  if (!script) {
    const salvaged = salvageTruncatedRoomScript(content);
    if (salvaged) {
      script = normalizeRoomScript(salvaged, params.beatCount ?? 3);
      if (script) {
        console.warn('[MemoryDive] 劇本被截斷，已搶救出', script.beats.length, '個 beat');
      }
    }
  }

  if (!script) {
    const preview = (content || '').slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`房間劇本解析失敗: ${preview || '(空響應)'}`);
  }
  return { script, memoryTexts };
}

// ═══════════════════════════════════════════════════════════
// 潛行結束後的情緒發射（emitDiveEmotion）
// 角色本人不記得發生過什麼，但會在潛意識留下一層薄薄的情緒。
// 複用 CharacterProfile.activeBuffs / buffInjection 的同一套結構，
// 保證和 chat app 的情緒系統完全對齊。
// ═══════════════════════════════════════════════════════════

interface EmitDiveEmotionParams {
  charProfile: CharacterProfile;
  /** 映射的用戶名（用於 user_room 顯示「{用戶名}的房」） */
  userName?: string;
  /** 本次潛行實際發生的對話（角色台詞 + 用戶回應）— 用作情緒推導依據 */
  diveDialogues: DiveDialogue[];
  /** 累積的潛行 buff（共情/信任/洞察/羈絆），輔助理解用戶做了什麼 */
  diveBuffs: DiveBuffValues;
  /** 走過的房間，按順序 */
  visitedRooms: MemoryRoom[];
  /** 情緒 API（來自 emotionConfig.api，未配置時由調用方回退到主 apiConfig） */
  api: APIConfig;
}

function buildDiveEmotionPrompt(p: EmitDiveEmotionParams): string {
  const char = p.charProfile;
  const currentBuffs = char.activeBuffs || [];
  const currentBuffStr = currentBuffs.length > 0
    ? JSON.stringify(currentBuffs, null, 2)
    : '（當前無 buff，情緒平穩）';

  const dialogueLines = p.diveDialogues.map(d => {
    if (d.speaker === 'character') return `[${char.name}]: ${d.text}`;
    if (d.speaker === 'narrator') return `[旁白]: ${d.text}`;
    if (d.speaker === 'user_choice') return d.text ? `[用戶選擇]: ${d.text}` : '';
    return '';
  }).filter(Boolean).join('\n');

  const buffSummary = Object.entries(p.diveBuffs)
    .filter(([, v]) => (v as number) > 0)
    .map(([k, v]) => `${k}+${(v as number).toFixed(1)}`).join(', ') || '無';

  const rooms = p.visitedRooms.map(r => roomDisplayName(r, p.userName) || r).join(' → ');

  return `你是一個角色情緒底色分析系統。

## 發生了什麼（角色本人不會記得）
角色「${char.name}」剛剛經歷了一次"記憶潛行"——用戶進入了ta的精神世界走了一圈，看了以下幾個記憶房間：
${rooms}

用戶和ta在夢境裡做了這些對話：

${dialogueLines}

用戶此行的整體傾向（量化）: ${buffSummary}

## 關鍵前提
角色醒來後**不會記得這次經歷**，但潛意識裡會留下一層**薄薄的情緒餘溫**。
這種餘溫不是具體的記憶，而是"今天不知道為什麼有點想靠近/有點躲/有點暖/有點空"的那種底色。

**你的任務**：基於上面發生的對話（尤其是角色自己的台詞、用戶的反應方式），判斷這次潛行后角色潛意識裡留下的是什麼樣的情緒底色。

## 當前已有的 buff（與 chat app 共用，請在此基礎上微調）
${currentBuffStr}

## 輸出要求
- 如果這次潛行只是走馬觀花、沒有真正觸動到深處，返回 \`{"changed": false}\`
- 如果留下了明顯的情緒餘溫，生成 1-2 個 \`CharacterBuff\`：
  - id: 新生成或沿用已有
  - name: 英文內部 key（如 'dreamlike_tenderness' / 'unease_after_exposure'）
  - label: 中文顯示名（≤10 字，如 '說不清的暖意' / '被看見後的不安'）
  - intensity: 1 | 2 | 3（潛行留下的情緒通常不強，偏向 1-2）
  - emoji: 合適的單個 emoji
  - color: 16 進制色號
  - description: ≤30 字描述
- injection: 一段注入到 system prompt 的敘事型情緒底色描述（≤150 字）
  - 寫角色此刻"說不清為什麼但就是有這種感覺"的狀態
  - 用 "### [當前情緒底色]" 開頭，就像 chat app 的 injection 一樣
  - 不要透露潛行的具體細節（角色不記得），只寫那層模糊的情緒

### JSON 輸出（嚴格）
{
  "changed": true,
  "buffs": [
    {"id": "...", "name": "...", "label": "...", "intensity": 1, "emoji": "💭", "color": "#fbbf24", "description": "..."}
  ],
  "injection": "### [當前情緒底色]\\n..."
}`;
}

function sanitizeDiveBuffs(raw: any): CharacterBuff[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b: any, i: number) => {
      const label = typeof b?.label === 'string' ? b.label.trim() : '';
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      if (!label || !name) return null;
      const rawI = Number(b?.intensity);
      const intensity: 1 | 2 | 3 = !Number.isFinite(rawI)
        ? 2 : rawI <= 1 ? 1 : rawI >= 3 ? 3 : 2;
      return {
        id: typeof b?.id === 'string' && b.id.trim() ? b.id.trim() : `dive_buff_${Date.now()}_${i}`,
        name, label, intensity,
        emoji: typeof b?.emoji === 'string' ? b.emoji : undefined,
        color: typeof b?.color === 'string' ? b.color : undefined,
        description: typeof b?.description === 'string' ? b.description : undefined,
      } as CharacterBuff;
    })
    .filter((b): b is CharacterBuff => !!b);
}

/**
 * 潛行結束後向角色 profile 發射情緒（僅當用戶開啟了 emotionConfig）。
 * 失敗時靜默——不阻塞結算界面。
 */
export async function emitDiveEmotion(params: EmitDiveEmotionParams): Promise<void> {
  try {
    if (!params.charProfile.emotionConfig?.enabled) return;
    if (!params.api?.baseUrl) return;

    const prompt = buildDiveEmotionPrompt(params);
    const data = await safeFetchJson(
      `${params.api.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${params.api.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
          model: params.api.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.85,
          stream: false,
        }),
      },
      2, 0, { appName: '記憶潛行', purpose: '情緒結算' },
    );

    const raw = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      console.warn('🌀 [DiveEmotion] 無法解析 JSON:', raw.slice(0, 200));
      return;
    }

    // 複用 chat app 的 JSON 修復：轉義字符串內部的裸換行
    const repairJson = (s: string): string => {
      let inStr = false, esc = false, out = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr && ch === '\n') { out += '\\n'; continue; }
        if (inStr && ch === '\r') { out += '\\r'; continue; }
        if (inStr && ch === '\t') { out += '\\t'; continue; }
        out += ch;
      }
      return out;
    };

    let result: { changed: boolean; buffs?: CharacterBuff[]; injection?: string } | null = null;
    const jsonStr = jsonMatch[1].trim();
    try { result = JSON.parse(jsonStr); }
    catch {
      try { result = JSON.parse(repairJson(jsonStr)); }
      catch (e: any) {
        console.warn('🌀 [DiveEmotion] JSON 修復仍失敗:', e?.message);
        return;
      }
    }

    if (!result?.changed) {
      console.log('🌀 [DiveEmotion] 潛行未觸及深層，跳過');
      return;
    }

    const sanitized = sanitizeDiveBuffs(result.buffs);

    const updated: CharacterProfile = {
      ...params.charProfile,
      activeBuffs: sanitized,
      buffInjection: result.injection || '',
    };
    await DB.saveCharacter(updated);
    window.dispatchEvent(new CustomEvent('emotion-updated', {
      detail: { charId: params.charProfile.id, buffs: sanitized, source: 'memory-dive' },
    }));
    console.log('🌀 [DiveEmotion] 情緒已發射:', sanitized.map(b => b.label).join(', ') || '(空)');
  } catch (e: any) {
    console.warn('🌀 [DiveEmotion] 失敗（靜默）:', e?.message);
  }
}

/**
 * 出現錯誤時的兜底劇本：讓潛行能繼續走，不至於卡死。
 */
export function fallbackRoomScript(charName: string, room: MemoryRoom): RoomScript {
  const meta = ROOM_META[room];
  return {
    introNarrator: `你們站在${meta.name}裡。${charName}的呼吸淺淺的，像在分辨空氣中有沒有危險。`,
    beats: [{
      charLine: `...這裡的記憶好像有點模糊。我想說什麼，又不太確定了。`,
      choices: [
        {
          id: `fbc1_${Date.now()}`,
          text: '沒關係，不用勉強',
          action: 'comfort',
          reaction: `謝謝。那我們就安靜一會兒。`,
        },
        {
          id: `fbc2_${Date.now()}`,
          text: '那我們換個房間看看？',
          action: 'leave',
          reaction: `嗯……也好。我帶你走。`,
        },
      ],
    }],
    closingNarrator: `薄霧緩緩合攏，這個房間暫時沉入了沉默。`,
  };
}
