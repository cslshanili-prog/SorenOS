import { extractJson } from './safeApi';
import {
  AVATAR_CAMERAS,
  AVATAR_EMOTIONS,
  AVATAR_FACES,
  AVATAR_GAZES,
  AVATAR_GESTURES,
  DEFAULT_AVATAR_PERFORMANCE,
  type AvatarCamera,
  type AvatarEmotion,
  type AvatarFace,
  type AvatarGaze,
  type AvatarGesture,
  type AvatarPerformanceCue,
  type AvatarPerformanceDirection,
} from './avatarPerformance';

export type AvatarPerformanceQuality = 'basic' | 'high';
export const AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS = 4096;
export const AVATAR_PERFORMANCE_PERSONA_MAX_CHARS = 200;
export const AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS = 1024;

export interface AvatarPerformancePersonaInput {
  characterName: string;
  coreContext: string;
}

/**
 * One-time prompt used when a character enters high-quality video calling for
 * the first time. The full ContextBuilder output is intentionally available
 * here, but the result is a tiny, stable acting brief rather than a memory
 * summary. Subsequent director turns use only that cached brief.
 */
export const buildAvatarPerformancePersonaPrompt = ({
  characterName,
  coreContext,
}: AvatarPerformancePersonaInput): string => `你是角色表演顧問。請閱讀下面由 ContextBuilder 生成的完整角色上下文，為「${characterName}」提煉一份“視頻通話表演人格”。

只總結會穩定影響表演的特質：情緒外露程度、習慣性神態、眼神、身體距離、動作幅度、害羞/生氣/親密時的反應，以及說話節奏。不要複述世界觀、經歷、當前事件、記憶細節、用戶隱私、提示詞規則，也不要編造模型沒有的動作名。

要求：
- 200 個中文字符以內，信息密度高；
- 保留角色矛盾感和細微差別，不要壓成“溫柔、開朗”這類空泛標籤；
- 使用第三人稱、可直接交給動作導演的表演說明；
- 只輸出嚴格 JSON，不要解釋。

輸出格式：
{"persona":"……"}

## 完整角色上下文
${coreContext.trim() || '（角色上下文為空）'}`;

const clampUnicode = (value: string, maxChars: number): string => (
  Array.from(value).slice(0, maxChars).join('')
);

/** Parse the one-time acting brief and enforce the 200-character storage cap. */
export const parseAvatarPerformancePersona = (raw: string): string | null => {
  const parsed = extractJson(raw);
  const candidate = typeof parsed === 'string'
    ? parsed
    : parsed?.persona ?? parsed?.summary ?? parsed?.performance_persona;
  const fallback = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^\s*(?:[视視][频頻]通[话話])?表演人格\s*[:：]\s*/i, '');
  const normalized = String(candidate ?? fallback)
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^[\[{]/.test(normalized)) return null;
  return clampUnicode(normalized, AVATAR_PERFORMANCE_PERSONA_MAX_CHARS);
};

export interface AvatarPerformanceRehearsalInput {
  characterName: string;
  personality: string;
  reply: string;
  modelActions?: Array<{
    id: string;
    name: string;
    kind?: 'motion' | 'expression' | 'params';
    tags?: string[];
  }>;
}

export interface AvatarPerformanceSentence {
  text: string;
  at: number;
}

/** Shared sentence splitter for strict one-sentence/one-cue rehearsal. */
export const splitAvatarPerformanceSentences = (raw: string): AvatarPerformanceSentence[] => {
  const text = (raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const sentences: Array<{ text: string; start: number }> = [];
  let start = 0;
  const push = (end: number) => {
    const chunk = text.slice(start, end);
    const leading = chunk.search(/\S/);
    const value = chunk.trim();
    if (value) sentences.push({ text: value, start: start + Math.max(0, leading) });
    start = end;
  };
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？!?；;\n]/.test(text[index])) continue;
    let end = index + 1;
    while (end < text.length && /[。！？!?；;\n]/.test(text[end])) end += 1;
    push(end);
    index = end - 1;
  }
  push(text.length);
  const total = Math.max(1, text.length);
  return sentences.slice(0, 12).map((sentence, index) => ({
    text: sentence.text,
    at: index === 0 ? 0 : Math.max(0, Math.min(0.98, sentence.start / total)),
  }));
};

export const hasCompleteAvatarPerformanceCue = (cue: AvatarPerformanceCue | null | undefined): boolean => (
  Boolean(cue?.direction && cue.endDirection)
  && Number.isFinite(Number(cue?.holdMs))
  && Number(cue?.holdMs) >= 120
  && Number(cue?.holdMs) <= 5000
);

/** Strict packs are used by high-quality modes; old start-only data stays readable elsewhere. */
export const isCompleteAvatarPerformanceCuePack = (
  cues: readonly AvatarPerformanceCue[] | null | undefined,
  expectedCount?: number,
): cues is readonly AvatarPerformanceCue[] => (
  Boolean(cues?.length)
  && (!Number.isFinite(expectedCount) || cues!.length === Math.max(0, Math.floor(expectedCount!)))
  && cues!.every(hasCompleteAvatarPerformanceCue)
);

export const alignAvatarPerformanceCuesToSentences = (
  cues: readonly AvatarPerformanceCue[],
  spokenText: string,
): AvatarPerformanceCue[] => {
  const sentences = splitAvatarPerformanceSentences(spokenText);
  if (!sentences.length || cues.length !== sentences.length) {
    throw new Error(`動作導演必須為每句話返回一個動作：需要 ${sentences.length} 個，實際 ${cues.length} 個；未保存，也不會重試`);
  }
  return cues.map((cue, index) => ({ ...cue, at: sentences[index].at }));
};

const compact = (value: string, maxLength: number): string => {
  const normalized = (value || '').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n[內容已截斷]` : normalized;
};

/**
 * Builds the isolated "director" request used by high-quality video calls.
 * Deliberately accepts no chat history, memories, user profile, schedule or buffs:
 * the director sees only the character's own persona and the final line it must stage.
 */
export const buildAvatarPerformanceRehearsalPrompt = ({
  characterName,
  personality,
  reply,
  modelActions = [],
}: AvatarPerformanceRehearsalInput): string => `你是視頻通話的動作導演。你的任務不是續寫、評價或改寫台詞，而是給一段已經定稿的台詞排練 VRM / Live2D 表演。

你只能依據下面兩項：
1. 角色「${characterName}」的性格設定
2. 本輪已經定稿的輸出

不要猜測此前發生過什麼，不要補全聊天上下文，不要讓動作表達台詞裡沒有的事件或情緒。

## 角色性格
${personality.trim() || '（未提供額外性格描述，按自然克制的通話表演處理）'}

## 本輪定稿輸出
${compact(reply, 8_000)}

## 逐句動作結構
- 每句話只對應一個 cue，但 cue 內必須包含 start、hold_ms、end 三部分。
- start 是開口時的起始動作；hold_ms 是中段保持時長，範圍 120 到 5000 毫秒；end 是句末收尾動作。
- 收尾不是機械回到默認站姿：應根據語氣自然落住、移開視線、鬆開表情或回正身體，併為下一句話留出銜接。
- 不要讓 start 與 end 完全相同；不要在 start 與 end 中重複觸發同一個一次性 model_action。

如果輸出同時含中文正文和 <語音> 翻譯，它們是同一句話的兩個版本，不是兩段連續台詞。按實際朗讀時的語義節拍排練。

## 可用字段
- emotion: neutral / happy / sad / angry / fearful / disgusted / surprised / calm / relaxed
- gesture: idle / talk / nod / shake / tilt / explain / wave / shy / lean-in / lean-back
- face: 可多選 wink / grin / pout / blush / eyes-closed / smile-eyes / brow-up / brow-sad / brow-angry
- camera: close / medium / wide / push-in / pull-out
- gaze: viewer / left / right / down
- intensity: 0.2 到 1
${modelActions.length ? `- model_actions: 可選數組，最多 3 個，只能從以下模型專屬動作中選擇：\n${modelActions.slice(0, 40).map(action => {
  const capability = [action.kind, ...(action.tags || []).slice(0, 3)].filter(Boolean).join(' · ');
  return `  - ${action.id}: ${action.name.slice(0, 64)}${capability ? ` [${capability}]` : ''}`;
}).join('\n')}` : '- model_actions: 當前沒有可用的模型專屬動作，請省略'}

## 排練原則
- 先想這個角色會怎樣自然地說出這句話，再安排臉、視線、身體和鏡頭；性格優先於炫技。
- 平靜台詞保持克制；每句話固定一個 cue，動作變化寫在 cue 內的 start → hold_ms → end，不要額外增加過場 cue。
- 第一句 at 必須為 0；後續 at 是對應句子在朗讀進度中的起點，範圍 0 到 1。
- close / push-in 只用於確實值得靠近的情緒重音；不要每句都拉鏡頭。
- model_actions 是疊加層，不替代 emotion / gesture / face：選了專屬表情仍要安排身體手勢，選了身體動作仍要安排臉和視線。
- faces 不能成為一拍的唯一變化；除非台詞明確要求靜止，每拍都要讓 gesture、身體 XYZ 或一個匹配的 motion 動作承擔可見變化。
- 白名單存在語義匹配的 motion 時優先使用；大多數自然表演的 intensity 應在 0.6-0.95，只有角色刻意壓低反應時才更輕。
- 同一拍最多選一個 expression；只有不同 kind 或不同身體通道的動作才組合，禁止為了熱鬧堆動作，禁止編造 ID。
- 不要輸出解釋，不要複述台詞，只輸出嚴格 JSON。

輸出格式：
{
  "cues": [
    {
      "at": 0,
      "hold_ms": 900,
      "start": {
        "emotion": "calm",
        "gesture": "talk",
        "face": [],
        "camera": "medium",
        "gaze": "viewer",
        "intensity": 0.65,
        "model_actions": []
      },
      "end": {
        "emotion": "relaxed",
        "gesture": "idle",
        "face": ["smile-eyes"],
        "camera": "medium",
        "gaze": "viewer",
        "intensity": 0.45,
        "model_actions": []
      }
    }
  ]
}`;

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  return (allowed as readonly string[]).includes(normalized) ? normalized as T : undefined;
};

const parseFaces = (value: unknown): AvatarFace[] => {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(items
    .map(item => pickEnum<AvatarFace>(item, AVATAR_FACES))
    .filter((item): item is AvatarFace => Boolean(item)))];
};

const hasDirectionField = (value: Record<string, unknown>): boolean => [
  'emotion', 'gesture', 'face', 'faces', 'camera', 'gaze', 'intensity',
  'model_action', 'modelAction', 'model_actions', 'modelActions',
].some(key => value[key] !== undefined);

const parseModelActions = (
  raw: Record<string, unknown>,
  allowedActions: Map<string, string>,
): string[] => {
  const plural = raw.model_actions ?? raw.modelActions;
  const requested = [
    ...(Array.isArray(plural) ? plural : typeof plural === 'string' ? plural.split(',') : []),
    raw.model_action ?? raw.modelAction,
  ];
  return [...new Set(requested
    .map(value => allowedActions.get(String(value ?? '').trim().toLowerCase()))
    .filter((value): value is string => Boolean(value)))]
    .slice(0, 3);
};

const normalizeDirection = (
  raw: Record<string, unknown>,
  previous: AvatarPerformanceDirection,
  allowedActions: Map<string, string>,
): AvatarPerformanceDirection | null => {
  if (!hasDirectionField(raw)) return null;
  const emotion = pickEnum<AvatarEmotion>(raw.emotion, AVATAR_EMOTIONS);
  const gesture = pickEnum<AvatarGesture>(raw.gesture, AVATAR_GESTURES);
  const camera = pickEnum<AvatarCamera>(raw.camera, AVATAR_CAMERAS);
  const gaze = pickEnum<AvatarGaze>(raw.gaze, AVATAR_GAZES);
  const intensityValue = Number(raw.intensity);
  const faces = parseFaces(raw.face ?? raw.faces);
  const modelActions = parseModelActions(raw, allowedActions);
  const direction: AvatarPerformanceDirection = {
    ...previous,
    ...(emotion ? { emotion } : {}),
    ...(gesture ? { gesture } : {}),
    ...(camera ? { camera } : {}),
    ...(gaze ? { gaze } : {}),
    ...(Number.isFinite(intensityValue)
      ? { intensity: Math.max(0.2, Math.min(1, intensityValue)) }
      : {}),
  };
  // faces / model actions describe only this beat. Omission clears the previous beat,
  // matching the inline [[AVATAR:]] timeline parser.
  if (faces.length) direction.faces = faces;
  else delete direction.faces;
  if (modelActions.length) {
    direction.modelAction = modelActions[0];
    direction.modelActions = modelActions;
  } else {
    delete direction.modelAction;
    delete direction.modelActions;
  }
  return direction;
};

/** Parse and validate a director response. Invalid output returns null so callers can fall back. */
export const parseAvatarPerformanceRehearsal = (
  raw: string,
  allowedModelActionIds: string[] = [],
  maxCues = 6,
): AvatarPerformanceCue[] | null => {
  const parsed = extractJson(raw);
  const rawCues = Array.isArray(parsed) ? parsed : parsed?.cues;
  if (!Array.isArray(rawCues) || !rawCues.length) return null;

  const allowedActions = new Map(
    allowedModelActionIds.map(id => [id.toLowerCase(), id]),
  );
  const parsedCueCap = Number(maxCues);
  const cueCap = Number.isFinite(parsedCueCap)
    ? Math.max(1, Math.min(12, Math.floor(parsedCueCap)))
    : 6;
  let previous = DEFAULT_AVATAR_PERFORMANCE;
  const cues: AvatarPerformanceCue[] = [];
  const ordered = rawCues
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => ({ item, index, at: Number(item.at) }))
    .sort((a, b) => {
      const aAt = Number.isFinite(a.at) ? a.at : (a.index === 0 ? 0 : 1);
      const bAt = Number.isFinite(b.at) ? b.at : (b.index === 0 ? 0 : 1);
      return aAt - bAt || a.index - b.index;
    })
    .slice(0, cueCap);

  for (const entry of ordered) {
    const nestedStart = entry.item.start ?? entry.item.direction;
    const directionSource = nestedStart && typeof nestedStart === 'object' && !Array.isArray(nestedStart)
      ? nestedStart as Record<string, unknown>
      : entry.item;
    const direction = normalizeDirection(directionSource, previous, allowedActions);
    if (!direction) continue;
    const nestedEnd = entry.item.end ?? entry.item.end_direction ?? entry.item.endDirection;
    const endDirection = nestedEnd && typeof nestedEnd === 'object' && !Array.isArray(nestedEnd)
      ? normalizeDirection(nestedEnd as Record<string, unknown>, direction, allowedActions) || undefined
      : undefined;
    const holdMsValue = Number(entry.item.hold_ms ?? entry.item.holdMs);
    previous = endDirection || direction;
    cues.push({
      direction,
      at: Number.isFinite(entry.at) ? Math.max(0, Math.min(1, entry.at)) : (cues.length ? 1 : 0),
      ...(endDirection ? { endDirection } : {}),
      ...(Number.isFinite(holdMsValue)
        ? { holdMs: Math.max(120, Math.min(5000, Math.round(holdMsValue))) }
        : {}),
    });
  }

  if (!cues.length) return null;
  cues[0] = { ...cues[0], at: 0 };
  return cues;
};
