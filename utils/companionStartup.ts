import { loadCharacterContextMessages } from './chatContextRange';
import type {
  APIConfig,
  CharacterProfile,
  CompanionStartupSettings,
  UserProfile,
} from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { ChatPrompts } from './chatPrompts';
import { extractContent, safeFetchJson } from './safeApi';
import {
  normalizeCompanionDialogue,
  parseAvatarTouchReply,
  type AvatarTouchModelAction,
} from './avatarTouch';
import type { AvatarPerformanceDirection, AvatarPerformancePrecision } from './avatarPerformance';

export interface CompanionStartupDraft {
  line: string;
  performance: AvatarPerformanceDirection;
}

export const DEFAULT_COMPANION_STARTUP_PERFORMANCE: AvatarPerformanceDirection = {
  emotion: 'calm',
  gesture: 'talk',
  camera: 'medium',
  gaze: 'viewer',
  intensity: 0.66,
  precision: {
    lockAutonomy: true,
    lockHead: true,
    headX: 0,
    headY: 0,
    headZ: 0,
    eyeX: 0,
    eyeY: 0,
    bodyX: 0.02,
    bodyY: 0,
    bodyZ: -0.02,
    overshoot: 0.08,
    settleMs: 920,
  },
};

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export const normalizeCompanionStartupPerformance = (
  direction?: Partial<AvatarPerformanceDirection> | CompanionStartupSettings['performance'],
  rawPrecision?: Partial<AvatarPerformancePrecision>,
): AvatarPerformanceDirection => {
  const defaults = DEFAULT_COMPANION_STARTUP_PERFORMANCE;
  const sourcePrecision = rawPrecision || direction?.precision || {};
  const defaultPrecision = defaults.precision!;
  return {
    ...defaults,
    ...(direction || {}),
    gaze: 'viewer',
    intensity: clamp(direction?.intensity, defaults.intensity, 0.2, 1),
    faces: direction?.faces?.slice(0, 4),
    modelActions: direction?.modelActions?.slice(0, 2),
    precision: {
      lockAutonomy: true,
      lockHead: true,
      // Startup speech is a hard centered-head phase. Saved legacy angles and
      // shake/tilt gestures must never reintroduce movement before the line ends.
      headX: 0,
      headY: 0,
      headZ: 0,
      eyeX: clamp(sourcePrecision.eyeX, 0, -1, 1),
      eyeY: clamp(sourcePrecision.eyeY, 0, -1, 1),
      bodyX: clamp(sourcePrecision.bodyX, defaultPrecision.bodyX || 0, -1, 1),
      bodyY: clamp(sourcePrecision.bodyY, defaultPrecision.bodyY || 0, -1, 1),
      bodyZ: clamp(sourcePrecision.bodyZ, defaultPrecision.bodyZ || 0, -1, 1),
      overshoot: clamp(sourcePrecision.overshoot, defaultPrecision.overshoot || 0.08, 0, 0.2),
      settleMs: clamp(sourcePrecision.settleMs, defaultPrecision.settleMs || 920, 320, 2400),
    },
  };
};

const balancedJsonCandidates = (content: string): string[] => {
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
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
};

const unwrapRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['startup', 'result', 'data']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return record;
};

const directiveFromPerformance = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const read = (...keys: string[]) => keys.map(key => record[key]).find(item => item !== undefined && item !== null && item !== '');
  const fields: string[] = [];
  const append = (key: string, field: unknown) => {
    if (field === undefined || field === null || field === '') return;
    fields.push(`${key}=${Array.isArray(field) ? field.join(',') : String(field)}`);
  };
  append('emotion', read('emotion'));
  append('gesture', read('gesture'));
  append('camera', read('camera'));
  append('gaze', read('gaze'));
  append('intensity', read('intensity'));
  append('face', read('faces', 'face'));
  append('model_action', read('modelAction', 'model_action'));
  return fields.length ? `[[AVATAR: ${fields.join('; ')}]]` : '';
};

const parseStructuredStartup = (
  value: unknown,
  modelActions: AvatarTouchModelAction[],
): CompanionStartupDraft | null => {
  const record = unwrapRecord(value);
  if (!record) return null;
  const rawLine = ['line', 'text', 'dialogue', 'reply', 'content']
    .map(key => record[key])
    .find(item => typeof item === 'string');
  const line = normalizeCompanionDialogue(typeof rawLine === 'string' ? rawLine : '');
  if (!line) return null;
  const rawPerformance = record.performance || record.avatar || record.direction || {};
  const parsed = parseAvatarTouchReply({
    content: `${directiveFromPerformance(rawPerformance)}\n${line}`,
  }, modelActions);
  if (!parsed) return null;
  const rawPrecision = (
    rawPerformance && typeof rawPerformance === 'object'
      ? (rawPerformance as Record<string, unknown>).precision
      : undefined
  ) || record.precision;
  return {
    line: normalizeCompanionDialogue(parsed.text),
    performance: normalizeCompanionStartupPerformance(
      parsed.performance,
      rawPrecision && typeof rawPrecision === 'object' ? rawPrecision as Partial<AvatarPerformancePrecision> : undefined,
    ),
  };
};

export const parseCompanionStartupResponse = (
  raw: unknown,
  modelActions: AvatarTouchModelAction[] = [],
): CompanionStartupDraft | null => {
  const content = typeof raw === 'string' ? raw : extractContent(raw as any);
  const fenced = [...content.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)].map(match => match[1]);
  const candidates = [content.trim(), ...fenced, ...balancedJsonCandidates(content)]
    .filter(Boolean)
    .flatMap(candidate => [candidate, candidate.replace(/,\s*([}])/g, '$1')]);
  for (const candidate of candidates) {
    try {
      const parsed = parseStructuredStartup(JSON.parse(candidate), modelActions);
      if (parsed) return parsed;
    } catch {
      // Continue into the plain assistant-message fallback below.
    }
  }
  const message = (raw as any)?.choices?.[0]?.message || { content };
  const fallback = parseAvatarTouchReply(message, modelActions);
  if (!fallback) return null;
  const line = normalizeCompanionDialogue(fallback.text);
  return line ? { line, performance: normalizeCompanionStartupPerformance(fallback.performance) } : null;
};

export const buildCompanionStartupPrompt = (
  coreContext: string,
  characterName: string,
  userName: string,
  modelActions: AvatarTouchModelAction[] = [],
  hint = '',
): string => {
  const actionList = modelActions.length
    ? modelActions.slice(0, 60).map(action => `- ${action.id}: ${action.name}`).join('\n')
    : '（當前沒有模型專屬動作）';
  return `${coreContext}

### 陪伴桌面 · 開機自啟演出
${userName}正在為${characterName}設置“每次回到陪伴主界面時”的短開場。它像二次元手遊首頁的角色入場，但必須完全屬於${characterName}本人。
${hint.trim() ? `用戶給的寫作提示：${hint.trim()}` : '用戶沒有限定台詞，請從完整人設、關係、近期對話和記憶出發自行決定如何開口。'}

要求：
- 只寫角色真正會說的一至兩句短台詞；不要套用通用歡迎、早安、主人、系統上線或自我介紹模板。
- 不要替桌面主題說話，不要解釋模型、API、動作參數或提示詞。
- 眼睛默認看鏡頭。為頭部 X/Y/Z、眼睛 X/Y、身體 X/Y/Z 給出克制的細微目標；動作先略微超過目標，再輕輕回正。
- 可選擇一個主 gesture、最多四個微表情，以及最多一個白名單模型專屬動作；禁止編造動作 ID。
- 只輸出一個合法 JSON 對象，不要代碼圍欄或額外說明。

模型專屬動作白名單：
${actionList}

嚴格結構：
{
  "line": "角色台詞",
  "performance": {
    "emotion": "calm",
    "gesture": "tilt",
    "camera": "medium",
    "gaze": "viewer",
    "intensity": 0.66,
    "faces": ["smile-eyes"],
    "modelAction": "可選的白名單ID",
    "precision": {
      "headX": 0.06,
      "headY": 0.04,
      "headZ": -0.14,
      "eyeX": 0,
      "eyeY": 0,
      "bodyX": 0.02,
      "bodyY": 0,
      "bodyZ": -0.02,
      "overshoot": 0.08,
      "settleMs": 920
    }
  }
}`;
};

export const requestCompanionStartupDraft = async (options: {
  character: CharacterProfile;
  user: UserProfile;
  apiConfig: APIConfig;
  modelActions?: AvatarTouchModelAction[];
  hint?: string;
}): Promise<CompanionStartupDraft> => {
  const {
    character,
    user,
    apiConfig,
    modelActions = [],
    hint = '',
  } = options;
  const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('請先在設置中配置主聊天 API');

  const [allMessages, emojis] = await Promise.all([
    loadCharacterContextMessages(character),
    DB.getEmojis().catch(() => []),
  ]);
  const recentMessages = allMessages
    .filter(message => message.role === 'user' || message.role === 'assistant');
  const eventText = `[陪伴桌面開機演出設置] ${user.name || '用戶'}希望你為每次回到陪伴主界面準備一句符合本人性格的短開場。`;
  const coreContext = ContextBuilder.buildCoreContext(
    character,
    user,
    true,
    undefined,
    undefined,
    {
      lastInteractionTs: recentMessages[recentMessages.length - 1]?.timestamp,
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
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages: [
        { role: 'system', content: buildCompanionStartupPrompt(coreContext, character.name, user.name || '用戶', modelActions, hint) },
        ...apiMessages,
        { role: 'user', content: eventText },
      ],
      temperature: 0.86,
      max_tokens: 1400,
      stream: false,
    }),
  }, 1, 60_000, {
    appName: '觸感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '生成開機自啟台詞與演出',
  });
  const parsed = parseCompanionStartupResponse(data, modelActions);
  if (!parsed) throw new Error('主模型沒有返回可用的開機台詞；可以改短提示後再試一次');
  return parsed;
};
