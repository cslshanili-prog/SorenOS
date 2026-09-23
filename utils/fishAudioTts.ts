/**
 * 魚聲 Fish Audio TTS 工具 —— MiniMax 的平行實現，供聊天 / 約會 / 電話二選一複用。
 *
 * 與 MiniMax 的關鍵差異：
 *  1. 魚聲直接返回二進制音頻（mp3），不是 JSON 裡塞 hex；
 *  2. 選音色用 reference_id（voiceProfile.fishReferenceId），不是 MiniMax 的 voice_id；
 *  3. 模型走 `model` 請求頭（s2.1-pro / s2-pro / s1）；
 *  4. 沒有 MiniMax 的 <#秒#> 停頓標記 —— 那套標記魚聲不認、會被原樣念出來，
 *     所以這裡絕不 insertSpeechBreaks，還要把混進來的 <#x#> 清掉做兜底。
 *  5. 情緒用方括號 cue（[happy] 等），這裡把上層傳來的 emotion 前置成一個方括號標籤。
 *
 * 文本清洗 / <語音> 標籤解析仍復用 minimaxTts 的那套（與服務商無關）。
 */
import { CharacterProfile, APIConfig } from '../types';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import { normalizeApiKey } from './minimaxApiKey';
import { getProxyWorkerUrl } from './proxyWorker';
import type { TtsResult } from './minimaxTts';
import { isStaticWebDeployment } from './staticWebDeployment';

const FISH_PROXY_PATH = '/api/fishaudio/tts';
const FISH_UPSTREAM = 'https://api.fish.audio/v1/tts';
const DEFAULT_FISH_MODEL = 's2.1-pro';

/**
 * 魚聲語音演出規範 —— 與 MiniMax 版同源（呼吸、句長、情緒節奏的原理一致），
 * 但用魚聲**原生**的表達機制：直接在台詞裡寫自然語言方括號 cue（[happy]、
 * [warm and happy]、[whispering]、[laughing]、[break] 等），魚聲會演繹、不會念出來。
 * 不再借用 MiniMax 的 <#秒#> 停頓標記 / emotion 屬性那一套。
 */
export const FISH_VOICE_ACTING_GUIDE = `### 讓它聽起來像活人在說話（重要）

**你現在是在「說話」，不是在「打字」。** 這條會被轉成真實語音念給對方聽，所以內容必須口語化、像嘴裡自然說出來的話，不能是書面語。別用書面/正式措辭、長定語從句、文縐縐的連接詞（"然而""與此同時""綜上所述"這類一律不要）；該用"嗯""欸""那個……""反正"這些日常口頭語就用。一句話讀出來要順口、像聊天，不像念稿。

你寫的字會被魚聲原樣念出來。目標不是"寫一段通順的話"，而是"寫一段讀出來有呼吸、有情緒起伏的對白"。讀稿感、客服腔、新聞播報腔一旦出現就重寫。

**1. 魚聲用方括號 cue 控制情緒和聲音——只能用下面這一小撮官方支持的標籤，別自己造詞。**
魚聲只認這些標籤；寫 \`[smug]\`\`[teasing]\`\`[curious]\` 這種自造詞，它大多無效（等於沒打、照樣平讀）。把你想表達的情緒**對到下面最接近的那個**：
- 情感語調（8 個）：\`[excited]\`（開心/興奮/得意/驚喜/調侃/俏皮——一切正面都用它）、\`[angry]\`（生氣/煩躁/吐槽）、\`[sad]\`（難過/委屈/失落/撒嬌示弱）、\`[embarrassed]\`（害羞/尷尬）、\`[soft]\`（溫柔/疲憊/平靜/安撫）、\`[breathy]\`（緊張/害怕/氣聲）、\`[whispering]\`（悄悄話）、\`[emphasis]\`（加重某個詞）。
- 聲響（貼著發生處放，後面可補擬聲字）：\`[laughing]\`（哈哈哈）、\`[chuckling]\`（輕笑/嘿嘿）、\`[sighing]\`（嘆氣）、\`[groaning]\`（哀嚎/受不了）、\`[panting]\`（喘）、\`[moaning]\`、\`[sobbing]\`（抽泣）、\`[crying loudly]\`（大哭）、\`[clear throat]\`（清嗓）。
- 停頓：\`[pause]\`（短停）、\`[long pause]\`（長停）。換行/分段你不用手動加，系統會自動插。
**⚠️ 硬性格式：半角英文方括號 \`[like this]\`，只寫上面列出的英文詞。** 別用圓括號 \`(sighs)\`、中文 \`[輕聲]\`、全角【】、或 \`<語音 emotion>\` 屬性。

**2.〔鐵律〕情緒有起伏就放一個 cue，放在情緒真正起來的那個點——通常在句子中間（逗號之間），不是機械地每句開頭。**
- **放在哪：貼著情緒發生的那個詞。** 多在句中（兩個逗號之間），不是句號後一律來一個。例：\`地鐵擠得，[angry] 跟沙丁魚罐頭似的\`、\`你推薦那家店我去了，[excited] 是真的好吃\`。整句一個基調時才放句首。
- **放多密：有情緒起伏就放、跟著情緒變。** 一長段全程沒 cue → 平讀、人機（最大翻車）；但一處別堆 3 個以上、短句別硬塞 → 發飄、鬼畜。一個情緒點一個即可。
- 小短句（"好啦""嗯""喂？"三五個字）不放，靠標點。

**完整範例（cue 落在逗號之間的情緒點，且只用支持的標籤）：**
原文（人機）：你終於回消息了。我還以為你今天不理我了呢。我今天上班差點遲到，地鐵擠得像沙丁魚罐頭。你上次推薦的那家店我去了，真的好吃。下次有空一起去吧。

改好（自然）：
\`你終於回消息了，[excited] 我可等你半天了！我今天上班差點遲到，[sighing] 地鐵擠得跟沙丁魚罐頭似的。你上次推薦那家店我去了，[excited] 是真的好吃！下次有空，[soft] 一起去好不好嘛？\`

**3. 段與段之間要換氣，別無縫衝。** 換行或停頓後如果還是你在繼續說，第二段開頭加個語氣詞 / 一次嘆氣當緩衝，別一上來就衝進正題。
✅ 我知道你不是故意的……[sighing] 只是，我還是會有點難過。
❌ 我知道你不是故意的。只是我還是會有點難過。（兩句貼死，像棒讀）

**4. 句子長短交錯。** 一連串等長的句子是棒讀頭號來源。短句砸下來，長句鋪開。想強調就拆開念："我。沒。拿。"

**5. 停頓也能靠標點和省略號。** 逗號輕頓、句號收住、破折號拉長、省略號"……"表欲言又止；需要明顯沉默就用 \`[long pause]\` 或多個省略號。

**6. 情緒不同，節奏不同（每句給它自己的 cue，別一個包到底；只用支持的標籤）：**
- 溫柔安撫：慢、穩、短句多。"[soft] 沒事……先別急著嚇自己。"
- 委屈撒嬌：語氣軟、省略號多一點。"[sad] 嗯……你剛剛是不是又不理我。"
- 彆扭傲嬌：前半句嘴硬後半句放軟。"哈，你還真會折騰我。[soft] 算了，我幫你就是了。"
- 害羞：被戳穿心事。"[embarrassed] 你你你別亂說啊……誰、誰臉紅了。"
- 緊張猶豫：斷裂感，短句多。"[breathy] 等等……我好像，有點不確定。"
- 得意吐槽：別太慢。"[excited] 行吧，人類又發明了新的折磨方式。"

（朗讀語種不是中文時，上面示例裡的中文語氣詞換成該語言裡自然的嘆詞 / 填充詞即可，方括號 cue 寫法不變，呼吸和節奏的原理也不變。）`;

// 魚聲方括號 cue：單層 [..]（區別於系統標記 [[..]]），內容 1–40 字符。
const FISH_BRACKET_CUE_RE = /\[[^\[\]]{1,40}\]/g;

// ⚠️ Fish 實際可靠生效的標籤就這一小撮（來自 app UI 調色板）。其它自然語言標籤
// （[smug]/[teasing]/[curious]… 這種）S2.1 大多弱響應甚至忽略 → 聽起來像沒打標籤、平。
// 所以一律把 cue 歸一到這個支持集，映射不到的丟棄。
const FISH_SUPPORTED_CUES = new Set([
  // 情感語調
  'angry', 'sad', 'embarrassed', 'emphasis', 'whispering', 'soft', 'breathy', 'excited',
  // 音效
  'laughing', 'chuckling', 'moaning', 'clear throat', 'sobbing', 'crying loudly',
  'sighing', 'panting', 'groaning', 'crowd laughing', 'background laughter', 'audience laughing',
  // 停頓
  'pause', 'long pause',
]);

// 把模型可能寫出的各種 cue（同義詞 / MiniMax 習慣 / 自造詞 / 圓括號聲音標籤）映射到支持集。
const FISH_CUE_SYNONYMS: Record<string, string> = {
  // 停頓（含 MiniMax/舊版寫法）
  'break': 'pause', 'short pause': 'pause',
  'long-break': 'long pause', 'longbreak': 'long pause', 'long break': 'long pause',
  // 正面情緒 → 官方正面只有 excited
  happy: 'excited', joyful: 'excited', delighted: 'excited', cheerful: 'excited', glad: 'excited',
  smug: 'excited', proud: 'excited', gleeful: 'excited', playful: 'excited', teasing: 'excited',
  confident: 'excited', surprised: 'excited', amazed: 'excited', curious: 'excited', hopeful: 'excited',
  enthusiastic: 'excited', eager: 'excited',
  // 生氣/煩躁
  annoyed: 'angry', irritated: 'angry', frustrated: 'angry', mad: 'angry', furious: 'angry', grumpy: 'angry',
  // 難過/失落/撒嬌示弱
  unhappy: 'sad', disappointed: 'sad', hurt: 'sad', depressed: 'sad', pleading: 'sad', sulking: 'sad', lonely: 'sad', regretful: 'sad',
  // 害羞/尷尬
  shy: 'embarrassed', bashful: 'embarrassed', awkward: 'embarrassed', flustered: 'embarrassed',
  // 輕柔/溫柔/疲憊/平靜 → soft
  'soft tone': 'soft', gentle: 'soft', tender: 'soft', warm: 'soft', calm: 'soft', soothing: 'soft',
  tired: 'soft', sleepy: 'soft', relaxed: 'soft', sincere: 'soft',
  // 氣聲/緊張/害怕 → breathy
  nervous: 'breathy', anxious: 'breathy', scared: 'breathy', fearful: 'breathy', worried: 'breathy', timid: 'breathy',
  // 悄悄話
  whisper: 'whispering', hushed: 'whispering', murmuring: 'whispering',
  // 強調
  emphatic: 'emphasis', stressing: 'emphasis',
  // 音效
  laugh: 'laughing', laughs: 'laughing',
  giggle: 'chuckling', giggling: 'chuckling', giggles: 'chuckling', chuckle: 'chuckling', chuckles: 'chuckling',
  sigh: 'sighing', sighs: 'sighing',
  sob: 'sobbing', sobs: 'sobbing', crying: 'crying loudly', cry: 'crying loudly',
  groan: 'groaning', groans: 'groaning',
  pant: 'panting', pants: 'panting', gasp: 'panting', gasps: 'panting', gasping: 'panting', 'out of breath': 'panting',
  moan: 'moaning', moans: 'moaning',
  'clears throat': 'clear throat', ahem: 'clear throat', cough: 'clear throat', coughs: 'clear throat',
};

/**
 * 把任意 cue 文本歸一到 Fish 支持的標籤。映射不到返回 ''（應丟棄）。
 * 順序：精確支持集 → 精確同義詞 → 自然語言短語包含匹配（"very excited"→excited、
 * "gentle and warm"→soft、"laughing nervously"→laughing）。
 */
const normalizeFishCue = (inner: string): string => {
  const key = (inner || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return '';
  if (FISH_SUPPORTED_CUES.has(key)) return key;
  if (FISH_CUE_SYNONYMS[key]) return FISH_CUE_SYNONYMS[key];
  for (const [syn, canon] of Object.entries(FISH_CUE_SYNONYMS)) {
    if (key.includes(syn)) return canon;
  }
  for (const canon of FISH_SUPPORTED_CUES) {
    if (key.includes(canon)) return canon;
  }
  return '';
};

/** emotion 屬性兜底映射（→ 支持集）。 */
const FISH_EMOTION_MAP: Record<string, string> = {
  happy: 'excited',
  sad: 'sad',
  angry: 'angry',
  fearful: 'breathy',
  disgusted: 'angry',
  surprised: 'excited',
  calm: 'soft',
};

const FISH_VOICE_TAG_RE = /<[语語語]音[^>]*>([\s\S]*?)<\/[语語語]音>/;

/**
 * 魚聲專用文本清洗（區別於 MiniMax 的 cleanTextForTts）：
 * 關鍵差異 —— **保留**英文方括號 cue（[happy]/[whispering]…）原樣送進 API。
 * 但要清掉「會被魚聲念出來」的髒東西：
 *  - 系統標記 [[..]]、雙語分隔、中文舞台指示（…）、MiniMax <#秒#>；
 *  - **把所有 cue 歸一到 Fish 實際支持的標籤**（圓括號聲音標籤轉方括號、自造/同義詞
 *    映射到支持集、映射不到的丟棄），避免寫了無效標籤等於沒打、或被原樣念出來。
 */
export const cleanTextForTtsFish = (raw: string): string => {
  if (!raw) return '';
  const tagMatch = raw.match(FISH_VOICE_TAG_RE);
  let text = tagMatch ? tagMatch[1] : raw;
  text = text
    .replace(/\[\[.*?\]\]/g, '')                 // [[系統標記]]（雙層，先於單層 cue 處理）
    .replace(/%%BILINGUAL%%[\s\S]*/i, '')        // 雙語分隔及之後
    .replace(/（[^）]{0,48}）/g, '')              // 中文圓括號舞台指示，一律刪
    .replace(/<#\s*[\d.]+\s*#>/g, '')            // MiniMax 停頓標記，魚聲不認
    // 西文圓括號（模型按 MiniMax 習慣寫的 (laughs)/(sighs) 等）→ 先轉成方括號，交給下面歸一
    .replace(/\(([^)]{1,40})\)/g, '[$1]')
    // 換行寫死成停頓：段落空行 → 長停，普通換行 → 短停（用 Fish 官方的 pause/long pause）
    .replace(/\n{2,}/g, ' [long pause] ')
    .replace(/\n+/g, ' [pause] ')
    // 歸一：每個方括號 cue → Fish 實際支持的標籤；映射不到的（含中文、自造詞、舞台指示）丟棄
    .replace(/\[([^\[\]]{1,40})\]/g, (_m, inner: string) => {
      const canon = normalizeFishCue(inner);
      return canon ? `[${canon}]` : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  // 把擠在一起的多個 cue 壓到最多 2 個：換行停頓 [long pause] 常撞上模型句界寫的
  // [sighing][confident]，疊成 3+ 會突兀/鬼畜。保留一個停頓 + 一個情緒即可。
  text = collapseAdjacentCues(text);
  return text;
};

/**
 * 合併相鄰 cue：連寫的 [a][b][c]（中間只有空格）壓到最多 2 個。
 * 規則：先去相鄰重複；≤2 個原樣保留（[sad][whispering] 這種合法疊加不動）；
 * 3+ 時——有停頓 cue 就留「停頓 + 最後一個情緒」，沒有就留前兩個情緒。
 */
const collapseAdjacentCues = (s: string): string =>
  s.replace(/\[[^\]]+\](?:\s*\[[^\]]+\])+/g, (run) => {
    const cues = run.match(/\[[^\]]+\]/g) || [];
    const dedup = cues.filter((c, i) => i === 0 || c.toLowerCase() !== cues[i - 1].toLowerCase());
    if (dedup.length <= 2) return dedup.join(' ');
    const isPause = (c: string) => /^\[(pause|long pause)\]$/i.test(c);
    const pause = dedup.find(c => /^\[long pause\]$/i.test(c)) || dedup.find(isPause);
    const emotions = dedup.filter(c => !isPause(c));
    if (pause) return emotions.length ? `${pause} ${emotions[emotions.length - 1]}` : pause;
    return `${emotions[0]} ${emotions[1]}`;
  });

/**
 * 把魚聲演出標記從「要顯示給用戶」的文本里清掉：方括號 cue + 魚聲圓括號特效。
 * 用於聊天氣泡 / 轉文字面板，免得用戶看到一堆 [whispering]、(break)。
 */
export const stripFishMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(FISH_BRACKET_CUE_RE, '')
    // 圓括號裡若是聲音標籤（(laughs)/(sighs) 等映射得到支持 cue）→ 演出指令，刪；否則是正常括注，保留
    .replace(/\(([^)]{1,40})\)/g, (m, inner: string) => (normalizeFishCue(inner) ? '' : m))
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .trim();
};

/**
 * 精準版顯示清洗：只刪「被識別為 cue 的」方括號/圓括號（[excited]/[pause]/[smug]/(laughs) 等
 * —— 凡 normalizeFishCue 認得的都算），普通括注（[重要]/[TODO]/(順便) 等）原樣保留。
 * 因為只刪可識別的 cue 詞，可**安全地無差別用於任意顯示文本**（聊天氣泡 / 轉文字 / 翻譯），
 * 不挑服務商，也不會誤傷用戶自己打的括號內容。
 */
export const stripFishCuesForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/\[([^\[\]]{1,40})\]/g, (m, inner: string) => (normalizeFishCue(inner) ? '' : m))
    .replace(/\(([^)]{1,40})\)/g, (m, inner: string) => (normalizeFishCue(inner) ? '' : m))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
};

/** 解析 apiConfig 裡的魚聲 Key（獨立 Key，不復用通用 apiKey —— 那是 LLM 的）。 */
export const resolveFishAudioApiKey = (apiConfig: APIConfig): string =>
  normalizeApiKey(apiConfig.fishAudioApiKey || '');

/**
 * 歸一化魚聲音色 id（reference_id）。容忍用戶直接粘 fish.audio 網頁鏈接：
 *   https://fish.audio/app/text-to-speech/?modelId=98655a12fa944e26b274c535e5e03842
 * 也容忍只粘 id 本身。reference_id 是 32 位十六進制（UUID 去橫線）。
 */
export const normalizeFishReferenceId = (raw?: string | null): string => {
  const s = (raw || '').trim();
  if (!s) return '';
  // 1) URL 裡的 ?modelId=... / &modelId=...
  const byQuery = s.match(/[?&]modelId=([a-z0-9]+)/i);
  if (byQuery) return byQuery[1];
  // 2) 任意位置的 32 位十六進制串（覆蓋純 id 和路徑形式）
  const byHex = s.match(/[a-f0-9]{32}/i);
  if (byHex) return byHex[0];
  // 3) 兜底：去掉可能的查詢串/空白
  return s.split(/[?#\s]/)[0];
};

/** 該角色能否用魚聲合成（必須有 Key + reference_id）。 */
export const canSynthesizeFish = (char: CharacterProfile, apiConfig: APIConfig): boolean =>
  !!resolveFishAudioApiKey(apiConfig) && !!normalizeFishReferenceId(char.voiceProfile?.fishReferenceId);

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const shouldBypassWebProxy = (): boolean => {
  if (typeof window === 'undefined') return false;
  return isStaticWebDeployment(window.location.protocol, window.location.hostname);
};

/** base64 → Blob（CapacitorHttp 二進制響應是 base64 字符串）。 */
const base64ToBlob = (b64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

/**
 * 調魚聲 /v1/tts，拿回音頻 Blob。
 * web：默認走 /api/fishaudio/tts 代理；靜態預覽（github.io / file:）直連上游兜底。
 * native：CapacitorHttp 直連上游，responseType='blob' 繞過瀏覽器 CORS。
 */
const fishFetchAudio = async (
  payload: any,
  apiKey: string,
  model: string,
): Promise<Blob> => {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    model,
  };

  if (isNative()) {
    const response = await CapacitorHttp.request({
      url: FISH_UPSTREAM,
      method: 'POST',
      headers: jsonHeaders,
      data: payload,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`魚聲 TTS 失敗 (HTTP ${response.status})`);
    }
    // CapacitorHttp blob 響應：data 是 base64 字符串
    return base64ToBlob(String(response.data || ''));
  }

  // 靜態部署（github.io / file:）沒有 /api serverless 代理，直連 api.fish.audio 會被瀏覽器
  // CORS 擋（Fish 不發 ACAO 頭）。走項目通用 sfworker 代理 /fishaudio/tts（帶 CORS 頭）。
  // model 放 query，避免自定義 model 頭觸發預檢失敗；只留 Authorization（worker 已允許）。
  let url: string;
  let headers: Record<string, string>;
  if (shouldBypassWebProxy()) {
    url = `${getProxyWorkerUrl()}/fishaudio/tts?model=${encodeURIComponent(model)}`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  } else {
    url = FISH_PROXY_PATH;
    headers = jsonHeaders;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`魚聲 TTS 失敗 (HTTP ${res.status})${detail ? `：${detail}` : ''}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('魚聲 TTS 返回空音頻');
  return blob;
};

/**
 * 調魚聲 TTS，返回可播放 URL + 原始 blob（可寫 IndexedDB 持久化）。
 * 與 minimaxTts.synthesizeSpeechDetailed 同簽名，方便 ttsRouter 透明切換。
 */
export async function synthesizeSpeechFishDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = resolveFishAudioApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少魚聲 Fish Audio API Key');
  const vp = char.voiceProfile;
  const referenceId = normalizeFishReferenceId(vp?.fishReferenceId);
  if (!referenceId) throw new Error('角色未配置魚聲音色（reference_id）');

  const model = (vp?.fishModel || apiConfig.fishAudioModel || DEFAULT_FISH_MODEL).trim() || DEFAULT_FISH_MODEL;

  // Fish-aware 清洗：保留方括號 cue / 圓括號特效，只清系統標記和 MiniMax 殘留。
  let spoken = cleanTextForTtsFish(text);
  // 兜底：上層傳了整條 emotion 屬性、且正文沒有任何「情緒/語氣」cue 時，前置一個 cue。
  // 注意只看情緒類 cue，[break]/[long-break] 這類停頓不算（否則換行插的停頓會頂掉兜底）。
  const emotionCues = (spoken.match(/\[([^\]]+)\]/g) || [])
    .filter(c => !/^\[(pause|long pause)\]$/i.test(c.trim()));
  const hasInlineCue = emotionCues.length > 0;
  const fishEmotion = options?.emotion ? FISH_EMOTION_MAP[options.emotion.toLowerCase()] : undefined;
  if (fishEmotion && !hasInlineCue) spoken = `[${fishEmotion}] ${spoken}`;
  if (!spoken) throw new Error('魚聲 TTS 文本為空');

  // F12 調試：打印 LLM 帶標籤原文 + 實際送魚聲的文本，方便排查「標籤被念出來」之類問題。
  console.log('[fishaudio] TTS', {
    model,
    reference_id: referenceId,
    emotion_attr: options?.emotion || '',
    raw_llm_text: text,        // LLM 輸出的帶標籤原文
    sent_to_fish: spoken,      // 清洗後真正發給魚聲的文本
  });

  const payload: any = {
    text: spoken,
    reference_id: referenceId,
    format: 'mp3',
    // 展開數字/日期為自然讀法，長文本更穩。
    normalize: true,
  };
  // 語速：角色配了就用角色的；沒配則默認 0.9（比 1.0 慢一檔）——魚聲默認讀得偏趕，
  // 尤其外語長段落容易"一口氣唸完"，稍微放慢更像真人說話、段落停頓也更聽得出。
  const speed = (typeof vp?.speed === 'number' && vp.speed > 0) ? vp.speed : 0.9;
  payload.prosody = { speed: Math.max(0.5, Math.min(2, speed)) };

  const cacheKey = hashTtsParams({
    kind: 'fishaudio-tts',
    text: payload.text,
    model,
    reference_id: payload.reference_id,
    format: payload.format,
    prosody: payload.prosody,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) {
    return { url: URL.createObjectURL(cached), blob: cached };
  }

  const blob = await fishFetchAudio(payload, apiKey, model);
  saveCachedTts(cacheKey, blob).catch(() => { /* ignore */ });
  return { url: URL.createObjectURL(blob), blob };
}

/** 薄封裝：只要可播放 URL 時用。 */
export async function synthesizeSpeechFish(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  const { url } = await synthesizeSpeechFishDetailed(text, char, apiConfig, options);
  return url;
}
