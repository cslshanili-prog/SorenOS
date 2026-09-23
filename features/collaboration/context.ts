import type { CharacterProfile, Emoji, EmojiCategory, GroupProfile, Message, RealtimeConfig, UserProfile } from '../../types';
import { ContextBuilder } from '../../utils/context';
import { buildChatRequestPayload } from '../../utils/chatRequestPayload';
import { ChatPrompts } from '../../utils/chatPrompts';
import { buildThinkingChainPrompt } from '../../utils/thinkingChainPrompt';
import { MemoryNodeDB } from '../../utils/memoryPalace/db';
import { injectMemoryPalace } from '../../utils/memoryPalace/pipeline';
import type { MemoryNode } from '../../utils/memoryPalace/types';
import type { CollaborationContextMessage, CollaborationMakerKind, CollaborationMessage, CollaborationMode } from './types';
import { getCollaborationMakerPrompt } from './makers';

const COLLABORATION_PROTOCOL = `### 協同工作規則
這是一個由用戶主動打開的獨立協同會話。你仍然是角色本人，但這間窗口以把事情可靠地做完為第一目標。

- 主動拆解、執行、檢查並交付；只有缺少會改變結果的關鍵信息時才詢問。
- 保持你自己的語言習慣和判斷，不要變成沒有人格的客服，也不要為了演繹而拖延任務。
- 可以閱讀用戶在本會話上傳的文件和參考圖片。PDF 會標明頁數並提取全文；圖片會以視覺輸入或識圖描述提供。不要假裝讀到了沒有提供的內容。
- 普通聊天正文默認使用 Markdown 排版，但這不代表只能生成 .md。用戶選擇或點名 Word、PDF、TXT、HTML、JSON、Markdown 時，必須按指定格式交付真正的文件。
- 不能只說“我已經生成了文件”。需要交付文件時，在自然回覆之後輸出一個或多個 artifact 塊，由前端真正製作文件。
- artifact 塊必須嚴格使用下面的形式，format 可選 txt、md、html、json、docx、pdf：

\`\`\`artifact
title: 文件名（不含擴展名）
format: docx
---
這裡放完整文件正文，可以使用 Markdown 排版。
\`\`\`

- artifact 塊之外的文字會作為你發給用戶的聊天消息；不要向用戶解釋這個內部格式。
- 這間窗口能真正渲染普通文字、Markdown、表情包、語音條、文件與可安裝作品。不要輸出這裡沒有實現的 ChatApp 動作：引用、戳一戳、轉帳、日曆、定時消息、搜索、讀寫日記、HTML 聊天氣泡或其它 [[ACTION:...]] / [[RECALL:...]] 指令。
- 本窗口與其它協同窗口互不共享對話，也不會自動寫回日常聊天或角色記憶。`;

const collaborationThinkingPrompt = (char: CharacterProfile, user: UserProfile): string => {
  if (!char.showThinkingChain) return '';
  const custom = (char.thinkingChainCustomPrompt || '').trim();
  return `\n\n${buildThinkingChainPrompt(char.name, user.name)}${custom ? `\n\n### 用戶追加的心象規則\n${custom}` : ''}`;
};

const collaborationRichOutputPrompt = (
  char: CharacterProfile,
  emojis: Emoji[] = [],
  categories: EmojiCategory[] = [],
): string => {
  const visible = ChatPrompts.filterVisibleEmojis(emojis, categories, char.id);
  const emojiRule = visible.emojis.length > 0
    ? `- 可以發送表情包；只使用 \`[[SEND_EMOJI: 表情名稱]]\`，可用表情為：${ChatPrompts.buildEmojiContext(visible.emojis, visible.categories)}。`
    : '- 當前沒有可用表情包，不要輸出 SEND_EMOJI。';
  const voiceRule = char.chatVoiceEnabled
    ? `- 可以發送語音條；使用 \`<語音>真正朗讀的台詞</語音>\`。${char.chatVoiceLang ? '若是外語語音，緊跟 `<字幕>中文對照</字幕>`。' : ''}語音會由協同界面真實渲染和播放，不要把標籤當普通文字解釋。`
    : '- 當前角色沒有開啟語音消息，不要輸出 `<語音>` 或 `<字幕>`。';
  return `

### 協同窗口可交付的消息形態
${emojiRule}
${voiceRule}
- 除上述兩種外，ChatApp 的動作標籤在本窗口都不可用。要辦正事就用文字、Markdown、artifact 文件或當前製作類型的 installable 作品交付。`;
};

const normalizeForSearch = (value: string): string => value.toLowerCase().normalize('NFKC');

const searchTokens = (value: string): Set<string> => {
  const normalized = normalizeForSearch(value).slice(0, 50_000);
  const tokens = new Set<string>();
  (normalized.match(/[a-z0-9_@.-]{2,}/g) || []).forEach(token => tokens.add(token));
  const cjkRuns = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]{2,}/g) || [];
  cjkRuns.forEach(run => {
    for (let index = 0; index < run.length - 1; index++) tokens.add(run.slice(index, index + 2));
  });
  return tokens;
};

const memoryScore = (node: MemoryNode, queryTokens: Set<string>, now: number): number => {
  const haystack = normalizeForSearch([
    node.content,
    ...(node.tags || []),
    ...(node.entities || []).flatMap(entity => [entity.name, ...(entity.aliases || [])]),
  ].join(' '));
  let overlap = 0;
  queryTokens.forEach(token => {
    if (haystack.includes(token)) overlap += token.length > 2 ? 4 : 2;
  });
  const ageDays = Math.max(0, (now - (node.lastAccessedAt || node.createdAt || now)) / 86_400_000);
  const recency = Math.max(0, 2.5 - Math.log10(ageDays + 1));
  return overlap + Math.max(0, Math.min(10, node.importance || 0)) * 0.35 + recency + (node.pinnedUntil && node.pinnedUntil > now ? 3 : 0);
};

export const selectCollaborationMemories = (
  nodes: MemoryNode[],
  query: string,
  limit: number,
  now = Date.now(),
): MemoryNode[] => {
  const queryTokens = searchTokens(query);
  return nodes
    .filter(node => !node.archived && !node.groupId && !!node.content?.trim())
    .map(node => ({ node, score: memoryScore(node, queryTokens, now) }))
    .sort((a, b) => b.score - a.score || b.node.createdAt - a.node.createdAt)
    .slice(0, Math.max(0, limit))
    .map(item => item.node);
};

const formatMemoryBlock = (nodes: MemoryNode[], userName: string): string => {
  if (nodes.length === 0) return '';
  return `### 與本次任務相關的記憶\n${nodes.map(node => `- [${node.room === 'user_room' ? `${userName}的房間` : node.room}] ${node.content}`).join('\n')}\n\n`;
};

export interface BuildCollaborationContextInput {
  char: CharacterProfile;
  user: UserProfile;
  mode: CollaborationMode;
  taskText: string;
  emojis?: Emoji[];
  categories?: EmojiCategory[];
}

export const buildCollaborationContextSnapshot = async ({
  char,
  user,
  mode,
  emojis = [],
  categories = [],
}: BuildCollaborationContextInput): Promise<string> => {
  if (mode === 'focused') {
    return [
      '[System: Focused Collaboration Character Context]\n',
      ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true }),
      char.description?.trim() ? `### 用戶對你的備註/稱呼\n${char.description.trim()}\n\n` : '',
      `### 互動對象\n- 名字: ${user.name}\n- 設定/備註: ${user.bio || '無'}\n\n`,
      `### 當前模式\n用戶選擇了“中度協同”：保留完整核心人格、世界觀和用戶設定；不載入世界書、用戶印象或其它協同窗口。任務相關記憶會在每一次發送時重新召回，最多 5 條。\n\n`,
      COLLABORATION_PROTOCOL,
      collaborationRichOutputPrompt(char, emojis, categories),
      collaborationThinkingPrompt(char, user),
    ].join('');
  }

  const staticChar: CharacterProfile = {
    ...char,
    // This snapshot is already inside the real collaboration window. Do not
    // carry ChatApp's tiny “you can guide the user to collaboration” notice
    // back into the workspace and create contradictory location instructions.
    chatCollaborationEnabled: false,
    memoryPalaceEnabled: false,
    memoryPalaceInjection: '',
    roomPlatesInjection: '',
  };
  return [
    ContextBuilder.buildCoreContext(staticChar, user, true, undefined, undefined, {
      conversational: true,
      skipTimeAwareness: false,
    }),
    `### 當前模式\n用戶選擇了“沉浸式協同”：完整保留角色、關係、世界觀、世界書、用戶印象和日常記憶，同時把完成當前任務放在本會話的最前面。任務相關記憶會像 ChatApp 一樣在每一次發送時重新召回；其它協同窗口的對話仍不進入這裡。\n\n`,
    COLLABORATION_PROTOCOL,
    collaborationRichOutputPrompt(char, emojis, categories),
    collaborationThinkingPrompt(char, user),
  ].join('');
};

export interface BuildLiveCollaborationChatContextInput {
  char: CharacterProfile;
  user: UserProfile;
  groups: GroupProfile[];
  emojis: Emoji[];
  categories: EmojiCategory[];
  recentChatMessages: Message[];
  mode?: CollaborationMode;
  chatContextLimit?: number;
  realtimeConfig?: RealtimeConfig;
}

/**
 * Build the ChatApp bridge for one collaboration request. This intentionally
 * runs on every send: only the selected latest rows (or ChatApp's effective
 * user-configured range) are read, and a collaboration session never freezes
 * an increasingly stale chat transcript.
 */
export const buildLiveCollaborationChatContext = async ({
  char,
  user,
  groups,
  emojis,
  categories,
  recentChatMessages,
  mode = 'immersive',
  chatContextLimit = 20,
  realtimeConfig,
}: BuildLiveCollaborationChatContextInput): Promise<{
  contextSnapshot: string;
  chatContextSnapshot: CollaborationContextMessage[];
}> => {
  const history = selectRecentCollaborationChatMessages(recentChatMessages, chatContextLimit);
  // Memory Palace is deliberately omitted here: collaboration adds a fresh
  // recall block on every turn through its own isolated entry point.
  const staticChar: CharacterProfile = {
    ...char,
    chatCollaborationEnabled: false,
    memoryPalaceEnabled: false,
    memoryPalaceInjection: '',
    roomPlatesInjection: '',
  };
  const payload = await buildChatRequestPayload({
    char: staticChar,
    userProfile: user,
    groups,
    emojis,
    categories,
    historyMsgs: history,
    recentMsgsHint: history.slice(-200),
    contextLimit: Math.max(1, history.length),
    realtimeConfig,
    // Collaboration renders Markdown/files/installables rather than ChatApp's
    // HTML bubble protocol. Keeping it enabled would expose raw [html] blocks.
    htmlMode: { enabled: false },
    thinkingChain: {
      enabled: !!(char as CharacterProfile & { showThinkingChain?: boolean }).showThinkingChain,
      customPrompt: (char as CharacterProfile & { thinkingChainCustomPrompt?: string }).thinkingChainCustomPrompt,
    },
    stripImages: true,
  });

  const fullChatContext: CollaborationContextMessage[] = payload.fullMessages
    .map(message => {
      const role: CollaborationContextMessage['role'] = message.role === 'user' || message.role === 'assistant'
        ? message.role
        : 'system';
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      return { role, content };
    })
    .filter(message => !!message.content.trim());
  const chatContextSnapshot = mode === 'immersive'
    ? fullChatContext
    : fullChatContext.filter(message => message.role === 'user' || message.role === 'assistant');

  return {
    contextSnapshot: [
      mode === 'immersive'
        ? `### 當前模式\n用戶選擇了“沉浸式協同”：上方內容直接來自 ChatApp 本人的 ContextBuilder；最近 ${history.length} 條聊天會在每次生成時重新讀取而非凍結。在完整保留角色、關係和當下對話連續性的同時，把完成當前任務放在本窗口的最前面。任務相關記憶會在每次發送時重新召回；其它協同窗口的對話仍不進入這裡。\n\n`
        : `### ChatApp 實時聊天銜接\n最近 ${history.length} 條聊天會在每次生成時重新讀取而非凍結。\n\n`,
      COLLABORATION_PROTOCOL,
      collaborationRichOutputPrompt(char, emojis, categories),
    ].join(''),
    chatContextSnapshot: [
      { role: 'system', content: history.length > 0
        ? '### ChatApp 私聊記錄開始\n以下是已讀取的當前角色私聊記錄，可以用於本次任務；它們不是本協同窗口的歷史。只能引用實際提供的內容，範圍以外的對話未提供。'
        : '### ChatApp 私聊記錄\n本次未帶入私聊原文（用戶關閉讀取，或當前設定範圍內無記錄）。不要聲稱看到了未提供的對話。' },
      ...chatContextSnapshot,
      { role: 'system', content: '### ChatApp 私聊記錄結束\n下方進入當前協同窗口；用戶提及 ChatApp 時，請先查閱上方已提供的私聊記錄，而不是僅憑窗口獨立就判定不可見。' },
    ],
  };
};

export const selectRecentCollaborationChatMessages = (
  messages: Message[],
  limit: number,
): Message[] => {
  if (limit <= 0) return [];
  return messages.slice(-limit);
};

const formatAttachmentContext = (message: CollaborationMessage): string => {
  const attachments = message.attachments || [];
  if (attachments.length === 0) return '';
  return attachments.map(attachment => {
    const text = attachment.extractedText?.trim();
    const isImage = /^image\//i.test(attachment.mimeType);
    if (!text && isImage) return `\n\n[用戶上傳參考圖片：${attachment.name}；圖片數據將作為視覺輸入發送]`;
    if (!text) return `\n\n[附件：${attachment.name}，未提取到可讀正文]`;
    const label = attachment.kind === 'artifact'
      ? '本會話已生成文件'
      : isImage
        ? '用戶上傳參考圖片（已識圖）'
        : '用戶上傳文件';
    const coverage = attachment.pageCount ? `；PDF 共 ${attachment.pageCount} 頁` : '';
    return `\n\n[${label}：${attachment.name}${coverage}]\n${text}`;
  }).join('');
};

const formatRequestedOutput = (message: CollaborationMessage): string => message.requestedFormat
  ? `\n\n[本輪文件交付格式：${message.requestedFormat}。若本輪需要交付成果，必須輸出該格式的 artifact 真文件，不要只在聊天正文中給 Markdown。]`
  : '';

const collaborationMessagesForRecall = (
  messages: CollaborationMessage[],
  charId: string,
): Message[] => messages
  .filter(message => message.role === 'user' || message.role === 'assistant')
  .slice(-200)
  .map((message, index) => ({
    id: Math.max(1, Math.floor(message.createdAt)) + index,
    charId,
    role: message.role as 'user' | 'assistant',
    type: 'text',
    content: `${message.content}${formatRequestedOutput(message)}${formatAttachmentContext(message)}`.slice(0, 30_000),
    timestamp: message.createdAt,
  }));

/**
 * Dynamic Memory Palace layer for one collaboration turn.
 * The character/context snapshot stays isolated, while recall follows the
 * current message and this session's own history every time the user sends.
 */
export const buildCollaborationTurnMemoryContext = async (input: {
  char: CharacterProfile;
  user: UserProfile;
  mode: CollaborationMode;
  messages: CollaborationMessage[];
  taskText: string;
}): Promise<string> => {
  const { char, user, mode, messages, taskText } = input;
  if (!char.memoryPalaceEnabled) return '';
  const recallChar: CharacterProfile = {
    ...char,
    memoryPalaceInjection: '',
    roomPlatesInjection: '',
  };
  const query = [
    taskText,
    ...messages.slice(-6).map(message => message.content),
  ].filter(Boolean).join('\n').slice(-80_000);
  try {
    await injectMemoryPalace(
      recallChar,
      collaborationMessagesForRecall(messages, char.id),
      query,
      user.name,
      {
        entryPoint: 'collaboration',
        formatterMaxOutputItems: mode === 'focused' ? 5 : 15,
      },
    );
  } catch (error) {
    console.warn('[Collaboration] per-turn memory recall failed', error);
  }

  let recalled = (recallChar.memoryPalaceInjection || '').trim();
  // No embedding configuration should not turn collaboration memory into an
  // all-or-nothing feature. Fall back to the existing local lexical scorer.
  if (!recalled) {
    try {
      const nodes = await MemoryNodeDB.getByCharId(char.id);
      recalled = formatMemoryBlock(
        selectCollaborationMemories(nodes, query, mode === 'focused' ? 5 : 15),
        user.name,
      ).trim();
    } catch (error) {
      console.warn('[Collaboration] local memory recall fallback unavailable', error);
    }
  }
  const roomPlates = (recallChar.roomPlatesInjection || '').trim();
  if (!roomPlates && !recalled) return '';
  return [
    '### 本輪動態記憶（僅本次請求）',
    '以下內容在用戶每次發送時按當前任務重新召回；不要把它當成其它協同窗口的對話。',
    roomPlates,
    recalled,
  ].filter(Boolean).join('\n\n');
};

/** Remove the one-time recall embedded by pre-upgrade collaboration sessions. */
export const stripFrozenCollaborationMemoryContext = (source: string): string => source
  .replace(/(^|\n)### [与與]本次任[务務]相[关關]的[记記][忆憶]\n[\s\S]*?(?=\n### [当當]前模式|$)/g, '$1')
  .replace(/(^|\n)### (?:[记記][忆憶][宫宮]殿 \(Memory Palace\)|底色[认認]知 \(Resident Knowledge\))\n[\s\S]*?(?=\n### [^#\n]|$)/g, '$1')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
}

// 一篇完整論文常會超過 180k 字符。協同附件已經在上傳邊界限制到 300k，
// 這裡要讓它在“上傳後的下一輪追問”裡仍能留下，而不是只剩模型上一輪提到的摘要。
const MAX_HISTORY_CHARS = 420_000;

export const buildCollaborationModelMessages = (
  contextSnapshot: string,
  messages: CollaborationMessage[],
  makerKind?: CollaborationMakerKind,
  chatContextSnapshot: CollaborationContextMessage[] = [],
  turnContext = '',
): ModelMessage[] => {
  const mapped = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({
      role: message.role as 'user' | 'assistant',
      content: `${message.content}${formatRequestedOutput(message)}${formatAttachmentContext(message)}`.trim(),
    }))
    .filter(message => !!message.content);

  let budget = MAX_HISTORY_CHARS;
  const kept: ModelMessage[] = [];
  for (let index = mapped.length - 1; index >= 0; index--) {
    const message = mapped[index];
    if (message.content.length <= budget || kept.length < 2) {
      kept.push(message);
      budget -= Math.min(message.content.length, budget);
      continue;
    }
    break;
  }
  kept.reverse();
  const omitted = kept.length < mapped.length
    ? [{ role: 'system' as const, content: `[較早的 ${mapped.length - kept.length} 條本窗口消息因上下文長度限制未發送。]` }]
    : [];
  const makerPrompt = getCollaborationMakerPrompt(makerKind);
  const cleanContextSnapshot = stripFrozenCollaborationMemoryContext(contextSnapshot);
  const cleanChatContextSnapshot = chatContextSnapshot.map(message => ({
    ...message,
    content: stripFrozenCollaborationMemoryContext(message.content),
  })).filter(message => !!message.content);
  return [
    ...(cleanChatContextSnapshot.length > 0 ? cleanChatContextSnapshot : [{ role: 'system' as const, content: cleanContextSnapshot }]),
    ...(cleanChatContextSnapshot.length > 0 ? [{ role: 'system' as const, content: cleanContextSnapshot }] : []),
    ...(makerPrompt ? [{ role: 'system' as const, content: makerPrompt }] : []),
    ...omitted,
    ...(turnContext.trim() ? [{ role: 'system' as const, content: turnContext.trim() }] : []),
    ...kept,
  ];
};
