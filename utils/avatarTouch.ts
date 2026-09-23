import { loadCharacterContextMessages } from './chatContextRange';
import type {
  APIConfig,
  AvatarTouchRegion,
  CharacterProfile,
  CompanionTouchReaction,
  UserProfile,
} from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { ChatPrompts } from './chatPrompts';
import { extractContent, extractJson, safeFetchJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { parseCallAssistantMessage, stripCallTextFormatting } from './callReplyFormat';
import {
  DEFAULT_AVATAR_PERFORMANCE,
  inferAvatarPerformanceFromText,
  type AvatarPerformanceDirection,
} from './avatarPerformance';
import { voiceLanguagePromptLabel } from './voiceLanguage';

export const AVATAR_TOUCH_ZONES = ['head', 'face', 'hand', 'body', 'other'] as const;
export type AvatarTouchZone = typeof AVATAR_TOUCH_ZONES[number];
export const AVATAR_TOUCH_PARTS = ['hair', 'head', 'face', 'shoulder', 'arm', 'hand', 'chest', 'waist', 'body', 'other'] as const;
export type AvatarTouchPart = typeof AVATAR_TOUCH_PARTS[number];
export const DEFAULT_COMPANION_TOUCH_ZONES: AvatarTouchZone[] = ['head', 'face', 'hand', 'body'];
export type AvatarTouchReactionPack = Partial<Record<AvatarTouchZone, CompanionTouchReaction[]>>;

export interface AvatarTouchRequest {
  nonce: number;
  /** CSS-pixel coordinates in the avatar canvas. */
  x: number;
  y: number;
  /** Normalized stage coordinates, 0..1. */
  normalizedX: number;
  normalizedY: number;
  /** Peak hardware pressure when available (0..1). */
  pressure?: number;
  /** Press duration; used as a force fallback on devices without pressure sensors. */
  durationMs?: number;
  pointerType?: 'mouse' | 'touch' | 'pen' | 'unknown';
}

export interface AvatarTouchHit extends AvatarTouchRequest {
  zone: AvatarTouchZone;
  /** Precise visual target; zone remains the backward-compatible reaction bucket. */
  part?: AvatarTouchPart;
  source: 'live2d-custom-region' | 'live2d-hit-area' | 'live2d-bounds' | 'vrm-raycast' | 'portrait-bounds';
  rawAreas: string[];
}

export interface AvatarTouchRecord {
  id: string;
  zone: AvatarTouchZone;
  part?: AvatarTouchPart;
  rawAreas: string[];
  timestamp: number;
}

export interface AvatarTouchReply {
  text: string;
  performance: AvatarPerformanceDirection;
}

export interface AvatarTouchModelAction {
  id: string;
  name: string;
  kind?: 'motion' | 'expression' | 'params';
  tags?: string[];
}

export type AvatarTouchPackOutputMode = 'full' | 'expression' | 'text';

const formatAvatarTouchModelAction = (action: AvatarTouchModelAction): string => {
  const capabilities = [action.kind, ...(action.tags || []).slice(0, 4)].filter(Boolean).join(' / ');
  return `- ${action.id}: ${action.name}${capabilities ? ` [${capabilities}]` : ''}`;
};

const ZONE_LABELS: Record<AvatarTouchZone, string> = {
  head: '頭頂或頭髮',
  face: '臉頰或臉部',
  hand: '手或手臂',
  body: '肩膀或身體',
  other: '角色身邊',
};

export const avatarTouchZoneLabel = (zone: AvatarTouchZone): string => ZONE_LABELS[zone];

const TOAST_ZONE_LABELS: Record<AvatarTouchZone, string> = {
  head: '頭髮',
  face: '臉頰',
  hand: '手',
  body: '肩膀',
  other: '身邊',
};

export const avatarTouchZoneToastLabel = (zone: AvatarTouchZone): string => TOAST_ZONE_LABELS[zone];

const TOUCH_PART_LABELS: Record<AvatarTouchPart, string> = {
  hair: '頭髮',
  head: '頭頂',
  face: '臉',
  shoulder: '肩膀',
  arm: '手臂',
  hand: '手',
  chest: '胸口',
  waist: '腰部',
  body: '身體',
  other: '身邊',
};

export const avatarTouchPartLabel = (part: AvatarTouchPart): string => TOUCH_PART_LABELS[part];

export const avatarTouchTargetLabel = (
  hit: Pick<AvatarTouchHit, 'zone' | 'part'>,
): string => hit.part ? avatarTouchPartLabel(hit.part) : avatarTouchZoneToastLabel(hit.zone);

export const normalizeCompanionDialogue = (raw: string, characterName = ''): string => {
  const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return stripCallTextFormatting(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(new RegExp(`^(?:${escapedName ? `${escapedName}|` : ''}角色|assistant)\\s*[：:]\\s*`, 'i'), '')
    .replace(/[”」』]\s*[“「『]/g, '\n')
    .replace(/\.{3,}/g, '……')
    .replace(/…{3,}/g, '……')
    .split('\n')
    .map(line => line.trim().replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const createAvatarTouchRecord = (
  hit: Pick<AvatarTouchHit, 'zone' | 'part' | 'rawAreas'>,
  timestamp = Date.now(),
): AvatarTouchRecord => ({
  id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
  zone: hit.zone,
  ...(hit.part ? { part: hit.part } : {}),
  rawAreas: hit.rawAreas.slice(0, 8),
  timestamp,
});

export const appendPendingAvatarTouch = (
  records: AvatarTouchRecord[],
  record: AvatarTouchRecord,
  maxRecords = 20,
): AvatarTouchRecord[] => [...records, record].slice(-Math.max(1, maxRecords));

export const consumePendingAvatarTouches = (
  records: AvatarTouchRecord[],
  consumed: AvatarTouchRecord[],
): AvatarTouchRecord[] => {
  if (!consumed.length) return records;
  const consumedIds = new Set(consumed.map(record => record.id));
  return records.filter(record => !consumedIds.has(record.id));
};

export const buildPendingAvatarTouchContext = (
  records: AvatarTouchRecord[],
  characterName: string,
  userName: string,
): string => {
  if (!records.length) return '';
  const counts = new Map<string, number>();
  records.forEach(record => {
    const label = avatarTouchTargetLabel(record);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const details = [...counts]
    .map(([label, count]) => `${label}${count}次`)
    .join('、');
  const action = records.length === 1
    ? `${userName}在開口前戳了戳${characterName}的${avatarTouchTargetLabel(records[0])}`
    : `${userName}在開口前連續戳了${characterName}${records.length}次（${details}）`;
  return `[本輪尚未回應的觸碰互動]\n${action}。這些動作已經在本地發生過，但你還沒有用語言回應。請在回答用戶本輪話語時自然地順帶接住它們，不要逐條播報、不要解釋系統，也不要把觸碰當成一條單獨的新消息。`;
};

export const isAvatarTouchGesture = (
  maxDistance: number,
  durationMs: number,
  wasSinglePointer: boolean,
): boolean => (
  wasSinglePointer
  && Number.isFinite(maxDistance)
  && maxDistance <= 10
  && durationMs >= 0
  && durationMs <= 650
);

export const resolveAvatarTouchForce = (
  touch: Pick<AvatarTouchRequest, 'pressure' | 'durationMs' | 'pointerType'>,
): number => {
  const duration = Math.max(0, Math.min(650, Number(touch.durationMs) || 0));
  const durationForce = 0.3 + (duration / 650) * 0.62;
  const hardwarePressure = touch.pointerType === 'mouse'
    ? 0
    : Math.max(0, Math.min(1, Number(touch.pressure) || 0));
  return Math.max(0.3, Math.min(1, Math.max(durationForce, hardwarePressure)));
};

export const applyAvatarTouchForce = (
  direction: AvatarPerformanceDirection,
  touch: Pick<AvatarTouchRequest, 'pressure' | 'durationMs' | 'pointerType'>,
): AvatarPerformanceDirection => {
  const force = resolveAvatarTouchForce(touch);
  // A touch is a discrete physical event, so even an old cached AI reaction
  // with an overly timid intensity must remain readable on the desktop stage.
  // Pressure/hold time still decides how far above that visible floor it goes.
  const visibleTouchFloor = 0.52 + force * 0.28;
  return {
    ...direction,
    intensity: Math.max(visibleTouchFloor, Math.min(1, direction.intensity * (0.72 + force * 0.46))),
  };
};

const zoneForTouchPart = (part: AvatarTouchPart): AvatarTouchZone => {
  if (part === 'hair' || part === 'head') return 'head';
  if (part === 'face') return 'face';
  if (part === 'hand' || part === 'arm') return 'hand';
  if (part === 'shoulder' || part === 'chest' || part === 'waist' || part === 'body') return 'body';
  return 'other';
};

const partForTouchZone = (zone: AvatarTouchZone): AvatarTouchPart => {
  if (zone === 'head') return 'head';
  if (zone === 'face') return 'face';
  if (zone === 'hand') return 'hand';
  if (zone === 'body') return 'body';
  return 'other';
};

/**
 * Resolve user-authored model-local ellipses. Smaller overlapping regions win,
 * so a face ellipse can safely sit inside a larger head ellipse.
 */
export const resolveAvatarTouchRegion = (
  regions: AvatarTouchRegion[] | undefined,
  normalizedX: number,
  normalizedY: number,
): { zone: AvatarTouchZone; part: AvatarTouchPart; regionId: string } | null => {
  if (!Array.isArray(regions) || !Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) return null;
  const hit = regions
    .filter(region => (
      AVATAR_TOUCH_ZONES.includes(region.zone as AvatarTouchZone)
      && Number.isFinite(region.x)
      && Number.isFinite(region.y)
      && Number.isFinite(region.width)
      && Number.isFinite(region.height)
      && region.width > 0
      && region.height > 0
    ))
    .filter(region => {
      const radiusX = region.width / 2;
      const radiusY = region.height / 2;
      const dx = (normalizedX - region.x) / radiusX;
      const dy = (normalizedY - region.y) / radiusY;
      return dx * dx + dy * dy <= 1;
    })
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (!hit) return null;
  return { zone: hit.zone, part: partForTouchZone(hit.zone), regionId: hit.id };
};

const geometricTouchPart = (fallbackY: number, fallbackX: number): AvatarTouchPart => {
  const x = Math.max(0, Math.min(1, fallbackX));
  const y = Math.max(0, Math.min(1, fallbackY));
  if (y < 0.14) return 'hair';
  if (y < 0.34) return x > 0.22 && x < 0.78 ? 'face' : 'hair';
  if (y < 0.5) {
    if (x < 0.18 || x > 0.82) return 'arm';
    if (x < 0.4 || x > 0.6) return 'shoulder';
    return 'chest';
  }
  if (y < 0.72) return x < 0.25 || x > 0.75 ? 'arm' : 'chest';
  if (y < 0.9) return 'waist';
  return 'other';
};

export const resolveAvatarTouchTarget = (
  rawAreas: string[],
  fallbackY?: number,
  fallbackX?: number,
): { zone: AvatarTouchZone; part: AvatarTouchPart } => {
  const value = rawAreas.join(' ').toLowerCase();
  const precisePart = /(face|cheek|mouth|eye|nose|lip|[脸臉]|面|頬|顏|眼|嘴|鼻)/i.test(value) ? 'face'
    : /(hair|bang|fringe|ahoge|髪|[发發]|髮|[刘劉]海|瀏海)/i.test(value) ? 'hair'
      : /(hand|finger|palm|wrist|手|指|掌|腕)/i.test(value) ? 'hand'
        : /(forearm|upperarm|lowerarm|arm|sleeve|elbow|手臂|胳膊|臂|袖|肘)/i.test(value) ? 'arm'
          : /(shoulder|clavicle|肩|[锁鎖]骨|鎖骨)/i.test(value) ? 'shoulder'
            : /(chest|bust|breast|胸)/i.test(value) ? 'chest'
              : /(waist|hip|pelvis|腰|胯|臀)/i.test(value) ? 'waist'
                : null;
  if (precisePart) return { zone: zoneForTouchPart(precisePart), part: precisePart };

  const hasGeometry = Number.isFinite(fallbackY) && Number.isFinite(fallbackX);
  const genericHead = /(head|hat|ear|[头頭]|頭|帽|耳)/i.test(value);
  const genericBody = /(body|torso|身[体體]|身體|[躯軀][干幹]|軀幹)/i.test(value);
  if (hasGeometry) {
    const part = geometricTouchPart(fallbackY!, fallbackX!);
    return { zone: zoneForTouchPart(part), part };
  }
  if (genericHead) return { zone: 'head', part: 'head' };
  if (genericBody) return { zone: 'body', part: 'body' };
  return { zone: 'other', part: 'other' };
};

export const normalizeAvatarTouchZone = (
  rawAreas: string[],
  fallbackY?: number,
  fallbackX?: number,
): AvatarTouchZone => resolveAvatarTouchTarget(rawAreas, fallbackY, fallbackX).zone;

export const buildImmediateTouchPerformance = (zone: AvatarTouchZone): AvatarPerformanceDirection => {
  if (zone === 'head') {
    return {
      emotion: 'happy',
      gesture: 'tilt',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.62,
      faces: ['smile-eyes'],
    };
  }
  if (zone === 'face') {
    return {
      emotion: 'surprised',
      gesture: 'shy',
      camera: 'close',
      gaze: 'down',
      intensity: 0.76,
      faces: ['blush'],
    };
  }
  if (zone === 'hand') {
    return {
      emotion: 'happy',
      gesture: 'wave',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.68,
    };
  }
  if (zone === 'body') {
    return {
      emotion: 'surprised',
      gesture: 'lean-back',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.7,
      faces: ['brow-up'],
    };
  }
  return { ...DEFAULT_AVATAR_PERFORMANCE, gesture: 'tilt', intensity: 0.5 };
};

export const buildAvatarTouchSystemPrompt = (
  coreContext: string,
  characterName: string,
  userName: string,
  hit: Pick<AvatarTouchHit, 'zone' | 'part' | 'rawAreas'>,
  modelActions: AvatarTouchModelAction[] = [],
): string => {
  const actionList = modelActions.length
    ? modelActions.slice(0, 60).map(formatAvatarTouchModelAction).join('\n')
    : '（當前沒有模型專屬動作）';
  return `${coreContext}

### 桌面 Live2D 動作優先級
- 表情只是疊加層，不是完整演出；必須同時給出肉眼可見的手勢或身體反應。
- 白名單中存在語義匹配的 [motion] 時優先選用；不能拿一個表情動作代替匹配的身體動作。
- 物理觸碰反饋的 intensity 通常應在 0.68-1.0；只有角色刻意壓住反應時才使用更低數值。
- 讓頭部 XYZ 與身體 XYZ 都參與：觸碰值得回應時，應從 nod/shake/tilt/explain/wave/shy/lean-in/lean-back 中選，不要只給 idle/talk。

### 當前面對面的觸碰互動
${userName}剛剛輕輕觸碰了${characterName}的「${avatarTouchTargetLabel(hit)}」。
模型命中區原名：${hit.rawAreas.length ? hit.rawAreas.join('、') : '自動識別區域'}。

這是一次真實、低頻的面對面互動。請直接以${characterName}本人回應：
- 必須結合完整人設、你們的關係、近期對話與記憶，不要寫成通用觸摸玩偶台詞。
- 可以喜歡、害羞、意外、躲開、拒絕或生氣；邊界與親密程度必須符合角色本人。
- 只說自然的一至三句短台詞，不要解釋系統、模型、命中區或提示詞。
- 台詞前先輸出一條隱藏演出指令，格式：
  [[AVATAR: emotion=happy; gesture=tilt; gaze=viewer; intensity=0.7]]
- emotion 可用 neutral/happy/sad/angry/fearful/disgusted/surprised/calm/relaxed。
- gesture 可用 idle/talk/nod/shake/tilt/explain/wave/shy/lean-in/lean-back。
- 可按需附加 face=wink,blush 或 model_action=下列白名單ID；不合適就省略，禁止編造。

模型專屬動作白名單：
${actionList}`;
};

const sanitizePerformanceActions = (
  performance: AvatarPerformanceDirection,
  allowedActionIds: Set<string>,
): AvatarPerformanceDirection => {
  const modelAction = performance.modelAction && allowedActionIds.has(performance.modelAction)
    ? performance.modelAction
    : undefined;
  const modelActions = performance.modelActions?.filter(id => allowedActionIds.has(id)).slice(0, 2);
  return {
    ...performance,
    ...(modelAction ? { modelAction } : {}),
    ...(modelActions?.length ? { modelActions } : {}),
    ...(!modelAction ? { modelAction: undefined } : {}),
  };
};

export const parseAvatarTouchReply = (
  message: unknown,
  allowedModelActions: AvatarTouchModelAction[] = [],
): AvatarTouchReply | null => {
  const parsed = parseCallAssistantMessage(message);
  const text = parsed.text.trim();
  if (!text) return null;
  const performance = parsed.performance || inferAvatarPerformanceFromText(text);
  return {
    text,
    performance: sanitizePerformanceActions(
      performance,
      new Set(allowedModelActions.map(action => action.id)),
    ),
  };
};

export const requestAvatarTouchReply = async (options: {
  character: CharacterProfile;
  user: UserProfile;
  apiConfig: APIConfig;
  hit: AvatarTouchHit;
  modelActions?: AvatarTouchModelAction[];
}): Promise<AvatarTouchReply> => {
  const {
    character,
    user,
    apiConfig,
    hit,
    modelActions = [],
  } = options;
  const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('請先在設置中配置主聊天 API');

  const [allMessages, emojis] = await Promise.all([
    loadCharacterContextMessages(character),
    DB.getEmojis().catch(() => []),
  ]);
  const recentMessages = allMessages
    .filter(message => message.role === 'user' || message.role === 'assistant');
  const eventText = `[面對面觸碰互動] ${user.name || '用戶'}輕輕觸碰了你的${avatarTouchTargetLabel(hit)}。`;

  await injectMemoryPalace(
    character,
    allMessages,
    eventText,
    user.name,
  );
  const lastInteractionTs = recentMessages[recentMessages.length - 1]?.timestamp;
  const coreContext = ContextBuilder.buildCoreContext(
    character,
    user,
    true,
    undefined,
    undefined,
    {
      lastInteractionTs,
      worldbookMessages: [
        ...recentMessages.map(message => ({ role: message.role, content: message.content })),
        { role: 'user', content: eventText },
      ],
    },
  );
  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    recentMessages.length,
    character,
    user,
    emojis,
  );
  const systemPrompt = buildAvatarTouchSystemPrompt(
    coreContext,
    character.name,
    user.name || '用戶',
    hit,
    modelActions,
  );
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...apiMessages,
        { role: 'user', content: eventText },
      ],
      temperature: 0.9,
      max_tokens: 1200,
      stream: false,
    }),
  }, 1, 45_000, {
    appName: '觸感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '角色觸碰回應',
  });
  const reply = parseAvatarTouchReply(data?.choices?.[0]?.message, modelActions)
    || parseAvatarTouchReply({ content: extractContent(data) }, modelActions);
  if (!reply) throw new Error('主模型沒有返回可顯示的觸碰回應');
  return reply;
};

export const buildAvatarTouchReactionPackPrompt = (
  coreContext: string,
  characterName: string,
  userName: string,
  zones: AvatarTouchZone[],
  modelActions: AvatarTouchModelAction[] = [],
  reactionsPerZone = 4,
  voiceLanguage = '',
  outputMode: AvatarTouchPackOutputMode = 'full',
): string => {
  const actionList = modelActions.length
    ? modelActions.slice(0, 60).map(formatAvatarTouchModelAction).join('\n')
    : '（當前沒有模型專屬動作）';
  const zoneList = zones.map(zone => `- ${zone}: ${avatarTouchZoneLabel(zone)}`).join('\n');
  const spokenLanguage = voiceLanguage ? voiceLanguagePromptLabel(voiceLanguage) : '簡體中文（與原文一致）';
  const schema = Object.fromEntries(zones.map(zone => [
    zone,
    Array.from({ length: reactionsPerZone }, (_, index) => {
      const base = {
        text: `第${index + 1}句角色台詞`,
        translation: voiceLanguage ? `第${index + 1}句${spokenLanguage}口語譯文` : `第${index + 1}句角色台詞`,
      };
      if (outputMode === 'text') return base;
      if (outputMode === 'expression') return {
        ...base,
        performance: { emotion: 'happy' },
      };
      return {
        ...base,
        performance: {
          emotion: 'happy', gesture: 'tilt', camera: 'medium', gaze: 'viewer', intensity: 0.7,
          faces: ['smile-eyes'],
        },
      };
    }),
  ]));
  const performanceRules = outputMode === 'text'
    ? `### 靜態單圖輸出規則
- 當前形象只有一張 PNG / GIF，不存在可調用的動作或表情資源。
- 你只需要寫角色台詞。不要輸出 performance、動作指令、表情標籤、鏡頭、視線或模型動作。`
    : outputMode === 'expression'
      ? `### 見面立繪表情規則
- 當前使用見面模式立繪，只需要為每句選擇 emotion，不需要生成手勢、身體動作、鏡頭、視線或模型動作。
- emotion 只使用 normal / happy / angry / sad / shy；它會直接切換當前衣服對應的表情立繪。`
      : `### 桌面 Live2D 動作優先級
- 每條緩存反饋都必須包含肉眼可見的手勢或身體拍點；只有 faces 變化視為不完整。
- 白名單動作帶有 [motion] / [expression] / [params] 能力標記；語義匹配時優先使用 [motion]，表情與參數只能作為疊加層。
- 大多數反饋的 intensity 使用 0.68-1.0，讓精細的頭部/身體 XYZ 綁定真正動起來；只有刻意克制的角色時刻才保持輕微。
- 同一部位的多條反饋要改變身體輪廓（轉、歪、靠近、後縮、解釋或揮手），不要生成四條僅表情不同的變體。`;
  const itemRule = outputMode === 'text'
    ? '- 每一項必須只有 {"text":"中文原文","translation":"語音譯文"}。'
    : outputMode === 'expression'
      ? '- 每一項必須是 {"text":"中文原文","translation":"語音譯文","performance":{"emotion":"五類表情之一"}}。'
      : '- 每一項必須是 {"text":"中文原文","translation":"語音譯文","performance":{...}}；演出數據不要混進台詞字段。\n- performance 必須給出 emotion、gesture、camera、gaze、intensity；可按需附加 faces 或 modelAction 白名單 ID，禁止編造模型動作。';
  return `${coreContext}

${performanceRules}

### 觸感陪伴桌面 · 一次性反饋包
${userName}正在為${characterName}設置可觸摸部位。請一次生成完整反饋包；保存後，桌面只會在本地輪播這些結果，不會每次觸摸都再次請求你。

需要生成的部位：
${zoneList}

  要求：
  - 每個部位恰好生成 ${reactionsPerZone} 條彼此有區別、可獨立成立的一至三句短台詞。
  - text 是界面顯示的原文，必須使用簡體中文；translation 是真正送入語音合成的${spokenLanguage}版本。兩者必須語義一致，但字段不可合併或省略。
- 必須結合完整人設、你們的關係、近期對話與記憶；允許喜歡、害羞、意外、躲開、拒絕或生氣，邊界必須符合角色本人。
- 台詞只能包含角色真正說出口的話。不要寫動作旁白、引號、角色名前綴、Markdown、命中區、系統解釋或半截續句。
${itemRule}
- 只輸出一個合法 JSON 對象，不要代碼圍欄，不要 JSON 以外的文字。頂層鍵必須逐字使用上面的英文部位 ID，不要翻譯或合併部位。

${outputMode === 'full' ? `模型專屬動作白名單：\n${actionList}` : ''}

嚴格按照這個結構輸出：
${JSON.stringify(schema, null, 2)}`;
};

const TOUCH_ZONE_ALIASES: Record<AvatarTouchZone, string[]> = {
  head: ['head', 'heads', 'hair', 'top', '頭', '頭部', '頭頂', '頭髮', '頭頂或頭髮'],
  face: ['face', 'faces', 'cheek', 'mouth', '臉', '臉頰', '面部', '臉頰或臉部'],
  hand: ['hand', 'hands', 'arm', 'arms', 'wrist', '手', '手臂', '胳膊', '手或手臂'],
  body: ['body', 'bodies', 'chest', 'torso', 'shoulder', 'shoulders', 'waist', '身體', '肩膀', '胸口', '腰', '肩膀或身體'],
  other: ['other', 'around', 'nearby', 'surroundings', 'else', '其他', '身邊', '角色身邊'],
};

const normalizePackKey = (value: string): string => value
  .toLowerCase()
  .replace(/[\s_\-.:：·/\\]+/g, '');

const asReactionPackRoot = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try { return asReactionPackRoot(JSON.parse(value)); } catch { return null; }
  }
  if (Array.isArray(value)) {
    const grouped: Record<string, unknown[]> = {};
    value.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>;
      const zone = record.zone || record.part || record.area || record.target;
      if (typeof zone !== 'string') return;
      const collection = ['items', 'reactions', 'feedbacks', 'responses', 'lines', 'variants']
        .map(key => record[key])
        .find(Array.isArray);
      if (Array.isArray(collection)) (grouped[zone] ||= []).push(...collection);
      else (grouped[zone] ||= []).push(record);
    });
    return Object.keys(grouped).length ? grouped : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['reactions', 'feedbacks', 'responses', 'pack', 'result', 'data']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') return asReactionPackRoot(nested);
  }
  return record;
};

const extractBalancedJson = (content: string): string[] => {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index;
      depth += 1;
    } else if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
};

const readReactionPackSource = (
  raw: unknown,
  zones: AvatarTouchZone[],
): Record<string, unknown> | null => {
  const direct = asReactionPackRoot(raw);
  const messageContent = (raw as any)?.choices?.[0]?.message?.content ?? (raw as any)?.content;
  const blockContent = Array.isArray(messageContent)
    ? messageContent.map(block => (
      typeof block === 'string'
        ? block
        : typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : ''
    )).join('')
    : '';
  const content = typeof raw === 'string' ? raw
    : typeof messageContent === 'string' ? messageContent
      : blockContent || extractContent(raw as any);
  const fenced = [...content.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)].map(match => match[1]);
  const cleaned = content.replace(/^\uFEFF/, '').trim();
  const candidates = [cleaned, ...fenced, ...extractBalancedJson(cleaned)]
    .filter(Boolean)
    .flatMap(candidate => [
      candidate,
      candidate.replace(/,\s*([}\]])/g, '$1'),
    ]);
  for (const candidate of candidates) {
    try {
      const root = asReactionPackRoot(JSON.parse(candidate));
      if (root) return root;
    } catch { /* try the next conservative repair */ }
  }
  const tolerant = cleaned.includes('{') ? extractJson(cleaned) : null;
  const tolerantRoot = asReactionPackRoot(tolerant);
  if (tolerantRoot) return tolerantRoot;

  if (direct && zones.some(zone => {
    const aliases = TOUCH_ZONE_ALIASES[zone].map(normalizePackKey);
    return Object.keys(direct).some(key => {
      const normalized = normalizePackKey(key);
      return aliases.some(alias => normalized === alias || normalized.endsWith(alias));
    });
  })) return direct;

  // Last resort for otherwise useful markdown such as "head:\n- line".
  const sections: Record<string, unknown> = {};
  const heading = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:["'【[])?(${zones.flatMap(zone => TOUCH_ZONE_ALIASES[zone]).join('|')})(?:["'】\\]])?\\s*[:：]\\s*`, 'gi');
  const matches = [...cleaned.matchAll(heading)];
  matches.forEach((match, index) => {
    const key = match[1];
    const bodyStart = (match.index || 0) + match[0].length;
    const bodyEnd = index + 1 < matches.length ? (matches[index + 1].index || cleaned.length) : cleaned.length;
    const lines = cleaned.slice(bodyStart, bodyEnd)
      .split('\n')
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
      .filter(Boolean);
    if (lines.length) sections[key] = lines;
  });
  return Object.keys(sections).length ? sections : null;
};

const readZoneValue = (source: Record<string, unknown>, zone: AvatarTouchZone): unknown => {
  const aliases = TOUCH_ZONE_ALIASES[zone].map(normalizePackKey);
  const entry = Object.entries(source).find(([key]) => {
    const normalized = normalizePackKey(key);
    return aliases.some(alias => normalized === alias || normalized.endsWith(alias));
  });
  return entry?.[1];
};

const asReactionItems = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['items', 'reactions', 'feedbacks', 'responses', 'lines', 'variants']) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
    if (typeof nested === 'string') return [nested];
  }
  if (['text', 'line', 'dialogue', 'reply', 'content', 'response'].some(key => typeof record[key] === 'string')) {
    return [record];
  }
  return Object.values(record).filter(item => typeof item === 'string' || Boolean(item && typeof item === 'object'));
};

const structuredPerformanceDirective = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const fields = ['emotion', 'gesture', 'camera', 'gaze', 'intensity', 'face', 'faces', 'model_action', 'modelAction']
    .flatMap(key => {
      const field = record[key];
      if (field === undefined || field === null || field === '') return [];
      const normalizedKey = key === 'modelAction' ? 'model_action' : key === 'faces' ? 'face' : key;
      const normalizedField = normalizedKey === 'emotion' && field === 'normal'
        ? 'neutral'
        : normalizedKey === 'emotion' && field === 'shy' ? 'surprised' : field;
      return [`${normalizedKey}=${Array.isArray(normalizedField) ? normalizedField.join(',') : String(normalizedField)}`];
    });
  return fields.length ? `[[AVATAR: ${fields.join('; ')}]]` : '';
};

const reactionItemContent = (item: unknown): string => {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  const text = ['text', 'line', 'dialogue', 'reply', 'content', 'response']
    .map(key => record[key])
    .find(value => typeof value === 'string');
  const performance = record.avatar || record.performance || record.direction || record.action || record;
  return `${structuredPerformanceDirective(performance)}\n${typeof text === 'string' ? text : ''}`.trim();
};

const reactionItemTranslation = (item: unknown): string => {
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  const translation = ['translation', 'translatedText', 'speechText', 'voiceText']
    .map(key => record[key])
    .find(value => typeof value === 'string');
  return typeof translation === 'string' ? translation : '';
};

export const parseAvatarTouchReactionPackPartial = (
  raw: unknown,
  zones: AvatarTouchZone[],
  allowedModelActions: AvatarTouchModelAction[] = [],
  voiceLanguage = '',
): AvatarTouchReactionPack => {
  const source = readReactionPackSource(raw, zones);
  if (!source) return {};
  const pack: AvatarTouchReactionPack = {};
  zones.forEach(zone => {
    const reactions = asReactionItems(readZoneValue(source, zone)).flatMap((item, index): CompanionTouchReaction[] => {
      const reply = parseAvatarTouchReply({ content: reactionItemContent(item) }, allowedModelActions);
      if (!reply) return [];
      const text = normalizeCompanionDialogue(reply.text);
      if (!text) return [];
      const translated = normalizeCompanionDialogue(reactionItemTranslation(item));
      if (voiceLanguage && !translated) return [];
      return [{
        id: `${zone}-${index + 1}`,
        text,
        translation: translated || text,
        performance: reply.performance,
      }];
    }).slice(0, 6);
    if (reactions.length) pack[zone] = reactions;
  });
  return pack;
};

export const parseAvatarTouchReactionPack = (
  raw: unknown,
  zones: AvatarTouchZone[],
  allowedModelActions: AvatarTouchModelAction[] = [],
  voiceLanguage = '',
): AvatarTouchReactionPack | null => {
  const pack = parseAvatarTouchReactionPackPartial(raw, zones, allowedModelActions, voiceLanguage);
  return zones.every(zone => pack[zone]?.length) ? pack : null;
};

export const requestAvatarTouchReactionPack = async (options: {
  character: CharacterProfile;
  user: UserProfile;
  apiConfig: APIConfig;
  zones: AvatarTouchZone[];
  modelActions?: AvatarTouchModelAction[];
  reactionsPerZone?: number;
  voiceLanguage?: string;
  outputMode?: AvatarTouchPackOutputMode;
}): Promise<AvatarTouchReactionPack> => {
  const {
    character,
    user,
    apiConfig,
    zones,
    modelActions = [],
    reactionsPerZone = 4,
    voiceLanguage = '',
    outputMode = 'full',
  } = options;
  const selectedZones = [...new Set(zones)].filter(zone => AVATAR_TOUCH_ZONES.includes(zone));
  if (!selectedZones.length) throw new Error('請至少選擇一個可觸摸部位');
  const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('請先在設置中配置主聊天 API');

  const [allMessages, emojis] = await Promise.all([
    loadCharacterContextMessages(character),
    DB.getEmojis().catch(() => []),
  ]);
  const recentMessages = allMessages
    .filter(message => message.role === 'user' || message.role === 'assistant');
  const eventText = `[桌面觸摸設置] ${user.name || '用戶'}選擇了一次性生成${selectedZones.map(avatarTouchZoneLabel).join('、')}的反饋包。`;
  const lastInteractionTs = recentMessages[recentMessages.length - 1]?.timestamp;
  const coreContext = ContextBuilder.buildCoreContext(
    character,
    user,
    true,
    undefined,
    undefined,
    {
      lastInteractionTs,
      worldbookMessages: [
        ...recentMessages.map(message => ({ role: message.role, content: message.content })),
        { role: 'user', content: eventText },
      ],
    },
  );
  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    recentMessages.length,
    character,
    user,
    emojis,
  );
  const boundedReactionCount = Math.max(3, Math.min(6, reactionsPerZone));
  const systemPrompt = buildAvatarTouchReactionPackPrompt(
    coreContext,
    character.name,
    user.name || '用戶',
    selectedZones,
    modelActions,
    boundedReactionCount,
    voiceLanguage,
    outputMode,
  );
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...apiMessages,
        { role: 'user', content: eventText },
      ],
      temperature: 0.92,
      max_tokens: 4800,
      stream: false,
    }),
  // A complete pack can contain dozens of lines plus translations and
  // performance data.  The previous 60s wall-clock timeout also kept ticking
  // while a healthy streamed response was arriving, so slower providers were
  // locally aborted at almost exactly 60s. Keep this a single model attempt,
  // but align its timeout policy with normal chat instead of killing valid
  // long generations before the optional TTS phase has even started.
  }, 0, 0, {
    appName: '觸感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '一次性生成桌面觸摸反饋包（不重試）',
  });
  const pack = parseAvatarTouchReactionPackPartial(data, selectedZones, modelActions, voiceLanguage);
  const incompleteZones = selectedZones.filter(zone => (pack[zone]?.length || 0) < boundedReactionCount);
  if (incompleteZones.length) {
    const details = incompleteZones
      .map(zone => `${avatarTouchZoneLabel(zone)} ${(pack[zone]?.length || 0)}/${boundedReactionCount}`)
      .join('、');
    throw new Error(`模型回覆不完整：${details}。本次未保存，只請求了這一次`);
  }
  selectedZones.forEach(zone => { pack[zone] = pack[zone]!.slice(0, boundedReactionCount); });
  return pack;
};
