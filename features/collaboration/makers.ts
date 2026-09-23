import type {
  BubbleStyle,
  ChatTheme,
  CharacterProfile,
  OSTheme,
  Worldbook,
} from '../../types';
import { JOURNAL_CSS_SCOPE_HINT, JOURNAL_CSS_SCOPE_REGEX, JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS } from '../../utils/journalAppearance';
import { SCHEDULE_CSS_SCOPE_HINT, SCHEDULE_CSS_SCOPE_REGEX, SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS } from '../../utils/scheduleAppearance';
import { validateScopedCss } from '../../utils/scopedCss';
import { parseStandardWorldbook, WORLDBOOK_POSITION_LABELS } from '../../utils/worldbook';
import type {
  CollaborationAttachment,
  CollaborationInstallableArtifact,
  CollaborationMakerKind,
} from './types';
import { collaborationId } from './types';

export type CollaborationMakerTarget = 'character' | 'optional-character' | 'global' | 'new-character';

export interface CollaborationMakerDefinition {
  kind: CollaborationMakerKind;
  label: string;
  shortLabel: string;
  description: string;
  target: CollaborationMakerTarget;
  accent: string;
  prompt: string;
}

const protocol = (kind: CollaborationMakerKind, schema: string, notes: string) => `### 當前製作任務（最高優先級）
用戶選擇了「${kind}」製作。先在自然回覆中說明你的設計判斷；定稿時必須再輸出一個可安裝作品塊：

\`\`\`sully-artifact
kind: ${kind}
title: 作品名
---
${schema}
\`\`\`

橫線後必須是嚴格 JSON，不能寫註釋、不能省略雙引號。不要把內部塊格式解釋給用戶。
${notes}`;

const bubbleSchema = `{
  "name": "主題名",
  "user": { "textColor": "#ffffff", "backgroundColor": "#6366f1", "borderRadius": 20, "opacity": 1 },
  "ai": { "textColor": "#1e293b", "backgroundColor": "#ffffff", "borderRadius": 20, "opacity": 1 },
  "customCss": ".sully-bubble-user{...}"
}`;

const formatSelectorGroups = (groups: ReadonlyArray<{ label: string; selectors: readonly string[] }>): string => groups
  .map(group => `${group.label}：${group.selectors.join('、')}`)
  .join('\n');

const BUBBLE_SELECTOR_GROUPS = [
  {
    label: '兩側氣泡',
    selectors: [
      '.sully-bubble-user', '.sully-bubble-ai', '.sully-bubble-group-first',
      '.sully-bubble-group-last', '.sully-bubble-tail-visible', '.sully-bubble-tail-hidden',
    ],
  },
  {
    label: '語音條',
    selectors: [
      '.sully-voice-bar', '.sully-voice-bar-shell', '.sully-voice-bar-button',
      '.sully-voice-bar-toggle', '.sully-voice-bar-loading', '.sully-voice-bar-placeholder',
      '.sully-voice-bar-transcript', '.sully-voice-bar-wave', '.sully-voice-bar-wave-segment',
    ],
  },
] as const;

const WHITEBOX_SELECTOR_GROUPS = [
  {
    label: '整屏與頂欄',
    selectors: [
      '.sully-chat-root', '.sully-chat-header', '.sully-chat-back', '.sully-chat-avatar',
      '.sully-chat-info', '.sully-chat-name', '.sully-chat-status', '.sully-chat-buffs',
      '.sully-chat-token', '.sully-chat-trigger',
    ],
  },
  {
    label: '輸入與功能面板',
    selectors: ['.sully-chat-inputbar', '.sully-chat-panel', '.sully-chat-panel button'],
  },
  {
    label: '消息佈局',
    selectors: [
      '.sully-chat-message', '.sully-chat-message-user', '.sully-chat-message-ai',
      '.sully-chat-message-group-first', '.sully-chat-message-group-last', '.sully-chat-message-module',
      '.sully-chat-message-content', '.sully-chat-message-sender', '.sully-chat-message-avatar-slot',
      '.sully-chat-message-avatar', '.sully-chat-message-avatar-img', '.sully-chat-turn-avatar-slot',
      '.sully-chat-turn-avatar',
    ],
  },
  {
    label: '氣泡、表情與語音',
    selectors: [
      ...BUBBLE_SELECTOR_GROUPS[0].selectors, '.sully-emoji-msg', ...BUBBLE_SELECTOR_GROUPS[1].selectors,
    ],
  },
  {
    label: '正式文件附件',
    selectors: [
      '.sully-collaboration-file', '.sully-collaboration-file-icon', '.sully-collaboration-file-meta',
      '.sully-collaboration-file-name', '.sully-collaboration-file-detail', '.sully-collaboration-file-action',
    ],
  },
  {
    label: '日程修改回執',
    selectors: SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS[2].selectors,
  },
] as const;

const PSYCHE_SELECTOR_GROUPS = [{
  label: '心象卡全部結構',
  selectors: ['.sully-psyche', '.sully-psyche-card', '.sully-psyche-title', '.sully-psyche-preview', '.sully-psyche-body'],
}] as const;

const cssDesignBrief = (surface: string, selectorGroups: ReadonlyArray<{ label: string; selectors: readonly string[] }>, extra: string): string => `
你要交付的是一套完整、可直接安裝的「${surface}」視覺系統，不是只換背景色。先從用戶描述中提煉 3—5 個設計關鍵詞，在自然回覆裡簡短說明材質、層級、排版和動效判斷；隨後在作品 JSON 中給出完整 CSS。

設計質量要求：
1. 建立一致的顏色、圓角、陰影、間距和字體層級；優先在根選擇器聲明專屬 CSS 變量，後續複用。
2. 同時覆蓋默認態、分組首尾態、用戶/角色兩側以及實際存在的功能狀態；不要只做一張靜態示意圖。
3. 面向約 360—430px 的手機窄屏，長標題、長消息、劉海安全區與觸控面積都要可用；必要時補 @media，但媒體查詢中的規則仍必須從公開選擇器起筆。
4. 允許後代、子元素、屬性、偽類與 ::before/::after；裝飾偽元素必須 pointer-events:none。禁止 body、html、:root、裸標籤和通配符開頭，禁止外鏈腳本。
5. 覆蓋項目默認/內聯樣式時用 !important，但不要無差別濫用。持續動畫只允許 transform/opacity，尊重 @media (prefers-reduced-motion: reduce)。
6. 不得隱藏返回、發送、上傳、輸入、下載等關鍵操作，不得用負位移或透明度讓它們實際不可達。文字與背景要有足夠對比度。
7. 只使用下面列出的真實穩定選擇器，不得猜測類名；無需每個選擇器都強行寫規則，但設計涉及的區域必須覆蓋完整。

全部可用選擇器：
${formatSelectorGroups(selectorGroups)}

${extra}`;

const ALL_COLLABORATION_MAKERS: CollaborationMakerDefinition[] = [
  {
    kind: 'bubble-theme', label: '氣泡製作', shortLabel: '氣泡', target: 'character', accent: '#7c3aed',
    description: '角色與用戶兩側氣泡、語音條和裝飾。',
    prompt: protocol('bubble-theme', bubbleSchema, cssDesignBrief('聊天氣泡與語音條', BUBBLE_SELECTOR_GROUPS, 'user/ai 基礎字段必須與 customCss 同一套設計語言；氣泡尾巴、同一輪消息的首尾銜接、長文本和語音波形都要有明確處理。')),
  },
  {
    kind: 'whitebox-css', label: '白框製作', shortLabel: '白框', target: 'character', accent: '#ec4899',
    description: '聊天頂欄、輸入欄、消息佈局與整屏背景。',
    prompt: protocol('whitebox-css', '{ "css": ".sully-chat-root{...}" }', cssDesignBrief('聊天白框、消息佈局與整屏外殼', WHITEBOX_SELECTOR_GROUPS, '頂欄已預留安全區；需要貼頂時使用 var(--safe-top)。若做“每輪頭像在上方”，顯示 .sully-chat-turn-avatar-slot、隱藏 .sully-chat-message-avatar，並同步調整組首留白和消息列邊距。正式文件附件是獨立工作交付物，不應偽裝成普通文本氣泡。')),
  },
  {
    kind: 'appearance-preset', label: '當前界面美化', shortLabel: '整套界面', target: 'global', accent: '#2563eb',
    description: '生成一套可保存、可恢復的 SullyOS 外觀預設。',
    prompt: protocol('appearance-preset', `{
  "theme": {
    "hue": 260, "saturation": 75, "lightness": 62, "darkMode": false,
    "contentColor": "#f7f5ff", "skin": "default", "desktopVariant": "paper", "statusBarMode": "standard",
    "chatAvatarShape": "circle", "chatAvatarSize": "medium", "chatEmojiSize": "small",
    "chatAvatarMode": "grouped", "chatAvatarPlacement": "beside", "chatAvatarVisibility": "both",
    "chatAvatarAlign": "bottom", "chatAvatarOffsetY": 0, "chatBubbleFontSize": 15,
    "chatBubbleLineHeight": 1.5, "chatBubbleIndent": 48, "chatSnapToEdge": false,
    "chatModuleAlign": "center", "chatChromeStyle": "soft", "chatHeaderStyle": "gradient",
    "chatInputStyle": "rounded", "chatBackgroundStyle": "mesh", "chatBubbleStyle": "modern",
    "chatMessageSpacing": "default", "chatShowTimestamp": "always", "chatHeaderAlign": "left",
    "chatHeaderDensity": "default", "chatStatusStyle": "subtle", "chatSendButtonStyle": "circle",
    "chatHideHeaderBuffs": false
  }
}`, `這是原生字段預設，不接受自造 CSS 或不存在的鍵。要把色相、明暗、桌面皮膚、聊天頂欄/輸入欄/氣泡、頭像、間距和時間戳做成同一套視覺方向，不要逐字段隨機選擇。
可用枚舉：skin=default|animalcrossing|mobilegame|tamagotchi|companion；desktopVariant=paper|nostalgia；statusBarMode=standard|compact|hidden；chatAvatarShape=circle|rounded|square；chatAvatarSize=small|medium|large；chatEmojiSize=small|medium|large；chatAvatarMode=grouped|every_message；chatAvatarPlacement=beside|above_group；chatAvatarVisibility=both|hide_ai|hide_user|hide_both；chatAvatarAlign=bottom|top|center；chatModuleAlign=anchor|center；chatChromeStyle=soft|flat|floating|pixel；chatHeaderStyle=default|minimal|gradient|wechat|telegram|discord|pixel；chatInputStyle=default|rounded|flat|wechat|ios|telegram|discord|pixel；chatBackgroundStyle=plain|grid|paper|mesh；chatBubbleStyle=modern|flat|outline|shadow|wechat|ios；chatMessageSpacing=compact|default|spacious；chatShowTimestamp=always|hover|never；chatHeaderAlign=left|center；chatHeaderDensity=compact|default|airy；chatStatusStyle=subtle|pill|dot；chatSendButtonStyle=circle|pill|minimal。
只寫界面視覺字段，不寫 API、角色內容、記憶、壁紙數據或任何憑據。`),
  },
  {
    kind: 'journal-css', label: '日記本美化', shortLabel: '日記本', target: 'global', accent: '#db2777',
    description: '交換日記的紙張、時間線、日期與編輯頁。',
    prompt: protocol('journal-css', '{ "css": ".sully-journal-root{...}" }', cssDesignBrief('交換日記 App', JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS, '必須覆蓋日記本選擇頁、日記列表、書寫雙頁和底部工具，而不是只美化紙張。裝飾層不能遮住正文、返回鍵、美化入口、新建按鈕或輸入區。')),
  },
  {
    kind: 'schedule-css', label: '日程卡美化', shortLabel: '日程卡', target: 'global', accent: '#d97706',
    description: '桌面、房間與聊天共用的日程卡片。',
    prompt: protocol('schedule-css', '{ "css": ".sully-schedule-root{...}" }', cssDesignBrief('日程卡與修改回執', SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS, '可在 .sully-schedule-root 聲明並複用 --schedule-bg、--schedule-text、--schedule-accent、--schedule-accent-soft、--schedule-base、--schedule-line。要同時處理當前事項、普通事項、長描述、緊湊小組件和聊天內修改回執。')),
  },
  {
    kind: 'psyche-css', label: '心象卡製作', shortLabel: '心象卡', target: 'character', accent: '#0891b2',
    description: '角色思考過程的摺疊卡片外觀。',
    prompt: protocol('psyche-css', '{ "css": ".sully-psyche-card{...}" }', cssDesignBrief('心象摺疊卡', PSYCHE_SELECTOR_GROUPS, '心象卡要區分標題、摺疊速覽和展開正文；必須兼顧短念頭與長段落，並確保展開內容仍清晰可讀。')),
  },
  {
    kind: 'character-card', label: '角色卡製作', shortLabel: '角色卡', target: 'new-character', accent: '#4f46e5',
    description: '創建一位新的角色，保留項目原生字段。',
    prompt: protocol('character-card', `{
  "name": "角色名",
  "description": "給用戶看的簡短介紹",
  "systemPrompt": "完整角色核心設定",
  "worldview": "角色所在世界與共同事實"
}`, '必須把角色的動機、邊界、語言習慣和關係立場寫具體。不要輸出 API、密鑰、運行時記憶或界面美化字段。'),
  },
  {
    kind: 'worldbook', label: '世界書製作', shortLabel: '世界書', target: 'optional-character', accent: '#059669',
    description: '製作一個分類下的多條目世界書，並可整組掛載。',
    prompt: protocol('worldbook', `{
  "category": "世界書分類名",
  "entries": {
    "0": {
      "uid": 0, "comment": "條目標題", "content": "完整設定正文",
      "key": ["主要觸發詞"], "keysecondary": [],
      "constant": false, "selective": false, "selectiveLogic": 0,
      "order": 100, "position": 1, "disable": false,
      "probability": 100, "useProbability": false,
      "depth": 4, "role": null, "scanDepth": 4,
      "caseSensitive": false, "matchWholeWords": false
    }
  }
}`, '一個作品塊代表一本世界書：category 下可放多個 entries，結構對齊 SillyTavern 世界書。position：0角色設定前、1角色設定後、2作者註釋頂部、3作者註釋底部、4聊天記錄指定深度、5示例消息前、6示例消息後；只有 position=4 時 role 才使用 0/System、1/User、2/Assistant。常駐條目 constant=true 且 key=[]；關鍵詞條目 constant=false 並填寫 key。'),
  },
];

// The all-in-one appearance preset overpromises what one generated artifact can
// safely control. Keep its definition only so older saved works still preview,
// validate and install; do not expose it as a new-work maker.
export const COLLABORATION_MAKERS = ALL_COLLABORATION_MAKERS.filter(
  definition => definition.kind !== 'appearance-preset',
);

export const COLLABORATION_MAKER_MAP = Object.fromEntries(
  ALL_COLLABORATION_MAKERS.map(definition => [definition.kind, definition]),
) as Record<CollaborationMakerKind, CollaborationMakerDefinition>;

export const getCollaborationMakerPrompt = (kind?: CollaborationMakerKind): string => (
  kind ? COLLABORATION_MAKER_MAP[kind].prompt : ''
);

const INSTALLABLE_BLOCK = /```sully-artifact\s*\n([\s\S]*?)```/gi;

export const parseInstallableArtifactBlocks = (response: string): {
  visibleText: string;
  artifacts: CollaborationInstallableArtifact[];
} => {
  const artifacts: CollaborationInstallableArtifact[] = [];
  const visibleText = response.replace(INSTALLABLE_BLOCK, (raw, blockText: string) => {
    const divider = blockText.indexOf('\n---');
    if (divider < 0) return raw;
    const header = blockText.slice(0, divider).trim();
    const payloadText = blockText.slice(divider + 4).trim();
    const values = Object.fromEntries(header.split('\n').map(line => {
      const colon = line.indexOf(':');
      return colon < 0 ? ['', ''] : [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    }).filter(([key]) => key));
    const kind = values.kind as CollaborationMakerKind;
    if (!COLLABORATION_MAKER_MAP[kind]) return raw;
    try {
      const payload = JSON.parse(payloadText);
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') return raw;
      artifacts.push({ kind, title: values.title || COLLABORATION_MAKER_MAP[kind].label, payload });
      return '';
    } catch {
      return raw;
    }
  }).trim();
  return { visibleText, artifacts };
};

export const materializeInstallableArtifact = (artifact: CollaborationInstallableArtifact): {
  attachment: CollaborationAttachment;
  blob: Blob;
} => {
  const blob = new Blob([JSON.stringify(artifact)], { type: 'application/vnd.sullyos.installable+json' });
  return {
    blob,
    attachment: {
      id: collaborationId('attachment'),
      assetId: collaborationId('asset'),
      kind: 'installable',
      installableKind: artifact.kind,
      name: artifact.title,
      mimeType: blob.type,
      size: blob.size,
      createdAt: Date.now(),
    },
  };
};

const bubbleSelector = /^(?:\.sully-bubble(?:\b|-)|\.sully-voice-bar(?:\b|-))/;
const whiteboxSelector = /^(?:\.sully-chat(?:\b|-)|\.sully-bubble(?:\b|-)|\.sully-voice-bar(?:\b|-)|\.sully-emoji-msg\b|\.sully-collaboration-file(?:\b|-)|\.sully-schedule-change(?:\b|-))/;
const psycheSelector = /^\.sully-psyche\b/;

const cssOf = (artifact: CollaborationInstallableArtifact): string => (
  typeof artifact.payload.css === 'string' ? artifact.payload.css : ''
);

const worldbookEntriesOf = (payload: Record<string, unknown>): unknown[] => {
  const rawEntries = payload.entries;
  if (Array.isArray(rawEntries)) return rawEntries;
  if (rawEntries && typeof rawEntries === 'object') return Object.values(rawEntries as Record<string, unknown>);
  // Compatibility for artifacts generated before worldbooks became grouped packages.
  if (typeof payload.content === 'string') return [payload];
  return [];
};

export const validateInstallableArtifact = (artifact: CollaborationInstallableArtifact): string[] => {
  const errors: string[] = [];
  const requireCss = (regex: RegExp, hint: string) => {
    const css = cssOf(artifact);
    if (!css.trim()) errors.push('作品裡沒有可用的 CSS。');
    else errors.push(...validateScopedCss(css, regex, hint).errors);
  };
  if (artifact.kind === 'bubble-theme') {
    const css = typeof artifact.payload.customCss === 'string' ? artifact.payload.customCss : '';
    if (!artifact.payload.user || !artifact.payload.ai) errors.push('氣泡主題缺少 user 或 ai 兩側樣式。');
    if (css) errors.push(...validateScopedCss(css, bubbleSelector, '.sully-bubble-user / .sully-bubble-ai / .sully-voice-bar').errors);
  } else if (artifact.kind === 'whitebox-css') requireCss(whiteboxSelector, '.sully-chat-* / .sully-bubble-* / .sully-schedule-change*');
  else if (artifact.kind === 'journal-css') requireCss(JOURNAL_CSS_SCOPE_REGEX, JOURNAL_CSS_SCOPE_HINT);
  else if (artifact.kind === 'schedule-css') requireCss(SCHEDULE_CSS_SCOPE_REGEX, SCHEDULE_CSS_SCOPE_HINT);
  else if (artifact.kind === 'psyche-css') requireCss(psycheSelector, '.sully-psyche*');
  else if (artifact.kind === 'appearance-preset' && (!artifact.payload.theme || typeof artifact.payload.theme !== 'object')) errors.push('外觀預設缺少 theme 配置。');
  else if (artifact.kind === 'character-card') {
    if (typeof artifact.payload.name !== 'string' || !artifact.payload.name.trim()) errors.push('角色卡缺少名字。');
    if (typeof artifact.payload.systemPrompt !== 'string' || !artifact.payload.systemPrompt.trim()) errors.push('角色卡缺少核心設定。');
  } else if (artifact.kind === 'worldbook') {
    if (typeof artifact.payload.category !== 'string' || !artifact.payload.category.trim()) errors.push('世界書缺少分類名。');
    const entries = worldbookEntriesOf(artifact.payload);
    if (entries.length === 0) errors.push('世界書裡沒有條目。');
    entries.forEach((entry, index) => {
      const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const entryTitle = typeof value.comment === 'string' ? value.comment : value.title;
      if (typeof entryTitle !== 'string' || !entryTitle.trim()) errors.push(`世界書第 ${index + 1} 條缺少標題 comment。`);
      if (typeof value.content !== 'string' || !value.content.trim()) errors.push(`世界書第 ${index + 1} 條缺少正文。`);
      if (value.position !== undefined && (typeof value.position !== 'number' || value.position < 0 || value.position > 6)) errors.push(`世界書第 ${index + 1} 條的注入位置無效。`);
    });
  }
  return errors;
};

const DEFAULT_BUBBLE: BubbleStyle = {
  textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1,
};

const normalizeBubbleSide = (value: unknown): BubbleStyle => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    ...DEFAULT_BUBBLE,
    ...Object.fromEntries(Object.entries(source).filter(([, entry]) => ['string', 'number'].includes(typeof entry))),
    textColor: typeof source.textColor === 'string' ? source.textColor : DEFAULT_BUBBLE.textColor,
    backgroundColor: typeof source.backgroundColor === 'string' ? source.backgroundColor : DEFAULT_BUBBLE.backgroundColor,
    borderRadius: typeof source.borderRadius === 'number' ? source.borderRadius : DEFAULT_BUBBLE.borderRadius,
    opacity: typeof source.opacity === 'number' ? source.opacity : 1,
  } as BubbleStyle;
};

export const installableToChatTheme = (artifact: CollaborationInstallableArtifact): ChatTheme => ({
  id: collaborationId('theme'),
  name: String(artifact.payload.name || artifact.title).slice(0, 50),
  type: 'custom',
  user: normalizeBubbleSide(artifact.payload.user),
  ai: normalizeBubbleSide(artifact.payload.ai),
  customCss: typeof artifact.payload.customCss === 'string' ? artifact.payload.customCss : '',
});

const APPEARANCE_KEYS: Array<keyof OSTheme> = [
  'hue', 'saturation', 'lightness', 'darkMode', 'contentColor', 'skin', 'desktopVariant', 'statusBarMode',
  'chatAvatarShape', 'chatAvatarSize', 'chatEmojiSize', 'chatAvatarMode', 'chatAvatarPlacement',
  'chatBubbleStyle', 'chatMessageSpacing', 'chatShowTimestamp', 'chatHeaderStyle', 'chatInputStyle',
  'chatChromeStyle', 'chatBackgroundStyle', 'chatHeaderAlign', 'chatHeaderDensity', 'chatStatusStyle',
  'chatSendButtonStyle', 'chatHideHeaderBuffs',
  'chatAvatarVisibility', 'chatAvatarAlign', 'chatAvatarOffsetY', 'chatBubbleFontSize',
  'chatBubbleLineHeight', 'chatBubbleIndent', 'chatSnapToEdge', 'chatModuleAlign',
];

export const installableToThemePatch = (artifact: CollaborationInstallableArtifact): Partial<OSTheme> => {
  const source = artifact.payload.theme && typeof artifact.payload.theme === 'object'
    ? artifact.payload.theme as Record<string, unknown>
    : {};
  const patch: Partial<OSTheme> = {};
  APPEARANCE_KEYS.forEach(key => {
    if (source[key] !== undefined && ['string', 'number', 'boolean'].includes(typeof source[key])) {
      (patch as Record<string, unknown>)[key] = source[key];
    }
  });
  return patch;
};

export const installableToCharacterPatch = (artifact: CollaborationInstallableArtifact): Partial<CharacterProfile> => ({
  name: String(artifact.payload.name || artifact.title).trim().slice(0, 80),
  description: typeof artifact.payload.description === 'string' ? artifact.payload.description : '',
  systemPrompt: typeof artifact.payload.systemPrompt === 'string' ? artifact.payload.systemPrompt : '',
  worldview: typeof artifact.payload.worldview === 'string' ? artifact.payload.worldview : undefined,
});

export const installableToWorldbooks = (artifact: CollaborationInstallableArtifact): Worldbook[] => {
  const now = Date.now();
  const payload = artifact.payload;
  const entries = worldbookEntriesOf(payload);
  const normalizedEntries = entries.map((entry, index) => {
    const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    return {
      ...value,
      uid: Number.isFinite(Number(value.uid)) ? Number(value.uid) : index,
      comment: String(value.comment || value.title || `條目 ${index + 1}`).slice(0, 100),
    };
  });
  const category = typeof payload.category === 'string' && payload.category.trim()
    ? payload.category.trim().slice(0, 50)
    : artifact.title.trim().slice(0, 50) || '協同製作';
  return parseStandardWorldbook(JSON.stringify({ entries: normalizedEntries }), category, now);
};

/** @deprecated Prefer installableToWorldbooks; retained for older single-entry callers. */
export const installableToWorldbook = (artifact: CollaborationInstallableArtifact): Worldbook => (
  installableToWorldbooks(artifact)[0]
);

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const safeStyleText = (value: string): string => value.replace(/<\/style/gi, '<\\/style');

export const buildInstallablePreviewDocument = (artifact: CollaborationInstallableArtifact): string => {
  const css = artifact.kind === 'bubble-theme' ? String(artifact.payload.customCss || '') : cssOf(artifact);
  const title = escapeHtml(artifact.title);
  const common = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;min-height:100%;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#25314a}*{box-sizing:border-box}body{background:#eef1f7}.phone{width:min(100%,430px);min-height:100vh;margin:auto;background:#f7f8fc;overflow:hidden}.label{font-size:10px;letter-spacing:.16em;text-transform:uppercase;opacity:.5}</style><style>${safeStyleText(css)}</style></head><body>`;
  if (artifact.kind === 'bubble-theme' || artifact.kind === 'whitebox-css') {
    const theme = artifact.kind === 'bubble-theme' ? installableToChatTheme(artifact) : null;
    const userStyle = theme ? `background:${theme.user.backgroundColor};color:${theme.user.textColor};border-radius:${theme.user.borderRadius}px;opacity:${theme.user.opacity}` : '';
    const aiStyle = theme ? `background:${theme.ai.backgroundColor};color:${theme.ai.textColor};border-radius:${theme.ai.borderRadius}px;opacity:${theme.ai.opacity}` : '';
    return `${common}<main class="phone sully-chat-root"><header class="sully-chat-header" style="height:88px;padding:30px 16px 12px;display:flex;align-items:center;gap:10px;background:white"><button class="sully-chat-back">‹</button><div class="sully-chat-avatar" style="width:38px;height:38px;border-radius:50%;background:#c4b5fd"></div><div><b class="sully-chat-name">Noir</b><div class="sully-chat-status" style="font-size:11px;opacity:.55">沉浸式協同</div></div><span class="sully-chat-token" style="margin-left:auto;font-size:10px">WORK</span></header><section style="padding:36px 18px"><div class="sully-chat-message sully-chat-message-ai"><div class="sully-chat-message-content"><div class="sully-bubble-ai" style="${aiStyle};display:inline-block;padding:12px 15px;max-width:82%">我把細節都收好了。先看這一版。</div></div></div><div class="sully-chat-message sully-chat-message-user" style="margin-top:18px;text-align:right"><div class="sully-chat-message-content"><div class="sully-bubble-user" style="${userStyle};display:inline-block;padding:12px 15px;max-width:82%">好，我喜歡這個方向。</div></div></div></section><footer class="sully-chat-inputbar" style="position:fixed;bottom:0;width:min(100%,430px);padding:14px;background:white"><div style="height:42px;border-radius:22px;background:#f1f3f8"></div></footer></main></body></html>`;
  }
  if (artifact.kind === 'journal-css') return `${common}<main class="phone sully-journal-root" style="padding:46px 20px"><div class="label">EXCHANGE JOURNAL</div><article class="sully-journal-paper" style="margin-top:18px;padding:28px 24px;min-height:560px;background:#fffdf8;box-shadow:0 18px 50px #5b49601f"><div class="sully-journal-date">2026 · 08 · 29</div><h1 class="sully-journal-title">留給今天的一頁</h1><p class="sully-journal-body">她把沒有說完的話寫在這裡。窗外很安靜，紙頁上留下了一點柔軟的光。</p><div class="sully-journal-timeline">22:31 · Noir</div></article></main></body></html>`;
  if (artifact.kind === 'schedule-css') return `${common}<main class="phone" style="padding:70px 18px"><section class="sully-schedule-root sully-schedule-card" style="--schedule-bg:#21192b;--schedule-text:#f8f3ff;--schedule-accent:#c9a7ff;background:var(--schedule-bg);color:var(--schedule-text);border-radius:24px;padding:20px"><header class="sully-schedule-header"><div class="label">TODAY</div><h2>Noir 的日程</h2></header><div class="sully-schedule-list"><div class="sully-schedule-item sully-schedule-item-current" style="padding:14px;border-left:3px solid var(--schedule-accent)"><b class="sully-schedule-time">22:30</b><div class="sully-schedule-activity">整理協同作品</div><small class="sully-schedule-description">檢查預覽並把作品歸檔。</small></div><div class="sully-schedule-item" style="padding:14px"><b class="sully-schedule-time">23:20</b><div class="sully-schedule-activity">夜間閱讀</div></div></div></section></main></body></html>`;
  if (artifact.kind === 'psyche-css') return `${common}<main class="phone" style="padding:90px 20px"><div class="sully-psyche"><section class="sully-psyche-card" style="padding:18px;border-radius:18px;background:#211b38;color:#f5e9c9;border:1px solid #e7c27666"><div class="sully-psyche-title">心象 · ECHO</div><p class="sully-psyche-preview">她說喜歡……那就再把邊緣收得更乾淨一點。</p><div class="sully-psyche-body">先確認保存位置，再交給她使用。</div></section></div></main></body></html>`;
  if (artifact.kind === 'appearance-preset') {
    const patch = installableToThemePatch(artifact);
    const hue = typeof patch.hue === 'number' ? patch.hue : 260;
    const content = typeof patch.contentColor === 'string' ? patch.contentColor : '#f7f5ff';
    return `${common}<main class="phone" style="padding:54px 22px;background:hsl(${hue} 45% 94%)"><div class="label">${title}</div><section style="margin-top:20px;padding:22px;border-radius:28px;background:${escapeHtml(content)}"><h1 style="font-size:28px;margin:0">SullyOS</h1><p style="opacity:.58">外觀預設 · 即時預覽</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:40px">${['聊天','日記','小屋','音樂','日程','設置'].map(label => `<div style="aspect-ratio:1;border-radius:22px;background:white;display:grid;place-items:center;box-shadow:0 10px 28px #4a3d6612">${label}</div>`).join('')}</div></section></main></body></html>`;
  }
  if (artifact.kind === 'worldbook') {
    let books: Worldbook[] = [];
    try { books = installableToWorldbooks(artifact); } catch { /* validation explains malformed entries */ }
    const category = escapeHtml(String(artifact.payload.category || artifact.title));
    const rows = books.map(book => {
      const mode = book.constant ? '常駐' : `觸發：${escapeHtml((book.key || []).join('、') || '未設置')}`;
      const position = WORLDBOOK_POSITION_LABELS[book.position ?? 1];
      return `<article style="padding:18px 0;border-top:1px solid #dfe4ec"><div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">${escapeHtml(book.title)}</b><span style="font-size:10px;padding:3px 7px;border-radius:999px;background:#e8f5ee;color:#17734a">${mode}</span></div><div style="margin-top:7px;font-size:11px;color:#758096">${escapeHtml(position)} · 順序 ${book.order ?? 100}</div><p style="margin:10px 0 0;white-space:pre-wrap;font-size:13px;line-height:1.65;color:#44506a">${escapeHtml(book.content)}</p></article>`;
    }).join('');
    return `${common}<main class="phone" style="padding:46px 22px"><div class="label">SILLYTAVERN WORLDBOOK</div><h1 style="margin:9px 0 4px;font-size:25px">${category}</h1><p style="margin:0 0 24px;color:#8791a5;font-size:12px">${books.length} 個條目 · 將作為同一分類保存</p><section style="background:white;padding:0 18px;border-radius:22px">${rows || '<p style="padding:24px;color:#9aa3b3">沒有可預覽的有效條目</p>'}</section></main></body></html>`;
  }
  return `${common}<main class="phone" style="padding:54px 24px"><div class="label">${escapeHtml(COLLABORATION_MAKER_MAP[artifact.kind].label)}</div><h1>${title}</h1><pre style="white-space:pre-wrap;font:14px/1.7 system-ui;background:white;padding:20px;border-radius:20px">${escapeHtml(JSON.stringify(artifact.payload, null, 2))}</pre></main></body></html>`;
};
