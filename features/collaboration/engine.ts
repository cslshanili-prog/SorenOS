import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { buildCollaborationModelMessages } from './context';
import type { ModelMessage } from './context';
import { collaborationBlobToDataUrl } from './files';
import { CollaborationStore } from './store';
import type { CollaborationApiProfile, CollaborationAttachment, CollaborationContextMessage, CollaborationMakerKind, CollaborationMessage } from './types';
import { parseCollaborationReply, visibleCollaborationStreamText, type ParsedCollaborationReply } from './reasoning';

export const isCollaborationApiConfigured = (profile: CollaborationApiProfile): boolean => (
  !!profile.baseUrl.trim() && !!profile.model.trim()
);

export interface RunCollaborationTurnInput {
  profile: CollaborationApiProfile;
  contextSnapshot: string;
  messages: CollaborationMessage[];
  signal?: AbortSignal;
  onDelta?: (fullText: string) => void;
  makerKind?: CollaborationMakerKind;
  chatContextSnapshot?: CollaborationContextMessage[];
  thinkingEnabled?: boolean;
  turnContext?: string;
}

const recentUndescribedImages = (messages: CollaborationMessage[]): CollaborationAttachment[] => {
  const selected: CollaborationAttachment[] = [];
  const seen = new Set<string>();
  for (let messageIndex = messages.length - 1; messageIndex >= 0 && selected.length < 4; messageIndex -= 1) {
    const attachments = messages[messageIndex].attachments || [];
    for (let attachmentIndex = attachments.length - 1; attachmentIndex >= 0 && selected.length < 4; attachmentIndex -= 1) {
      const attachment = attachments[attachmentIndex];
      if (!/^image\//i.test(attachment.mimeType) || attachment.extractedText?.trim() || seen.has(attachment.assetId)) continue;
      seen.add(attachment.assetId);
      selected.push(attachment);
    }
  }
  return selected.reverse();
};

/**
 * 把最近上傳、且沒有獨立識圖描述的參考圖真正掛到最後一條用戶消息上。
 * 讀取器可注入，方便不依賴 IndexedDB/FileReader 的純邏輯測試。
 */
export const attachCollaborationImageInputs = async (
  modelMessages: ModelMessage[],
  sessionMessages: CollaborationMessage[],
  readAsset: (assetId: string) => Promise<Blob | null> = CollaborationStore.getAsset,
  toDataUrl: (blob: Blob) => Promise<string> = collaborationBlobToDataUrl,
): Promise<ModelMessage[]> => {
  const attachments = recentUndescribedImages(sessionMessages);
  if (attachments.length === 0) return modelMessages;
  const images: Array<{ name: string; url: string }> = [];
  for (const attachment of attachments) {
    const blob = await readAsset(attachment.assetId);
    if (!blob) continue;
    images.push({ name: attachment.name, url: await toDataUrl(blob) });
  }
  if (images.length === 0) return modelMessages;

  let lastUserIndex = -1;
  for (let index = modelMessages.length - 1; index >= 0; index -= 1) {
    if (modelMessages[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return modelMessages;
  const target = modelMessages[lastUserIndex];
  const originalParts = typeof target.content === 'string'
    ? [{ type: 'text' as const, text: target.content }]
    : target.content;
  const imageLabel = `以下 ${images.length} 張圖片是用戶在本協同會話上傳的參考圖（${images.map(image => image.name).join('、')}）。請結合最近的任務直接觀察畫面細節。`;
  const next = [...modelMessages];
  next[lastUserIndex] = {
    ...target,
    content: [
      ...originalParts,
      { type: 'text', text: imageLabel },
      ...images.map(image => ({ type: 'image_url' as const, image_url: { url: image.url } })),
    ],
  };
  return next;
};

export const runCollaborationTurn = async ({
  profile,
  contextSnapshot,
  messages,
  signal,
  onDelta,
  makerKind,
  chatContextSnapshot,
  thinkingEnabled,
  turnContext,
}: RunCollaborationTurnInput): Promise<ParsedCollaborationReply> => {
  if (!isCollaborationApiConfigured(profile)) throw new Error('請先配置這個協同模式使用的 API');
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
  const requestBody: Record<string, unknown> = {
    model: profile.model.trim(),
    messages: await attachCollaborationImageInputs(
      buildCollaborationModelMessages(contextSnapshot, messages, makerKind, chatContextSnapshot, turnContext),
      messages,
    ),
    temperature: Math.max(0, Math.min(2, Number(profile.temperature) || 0.7)),
    stream: profile.stream,
  };
  if (thinkingEnabled) {
    const model = String(requestBody.model || '');
    if (/^claude-/i.test(model) && !/-thinking$/i.test(model)) requestBody.model = `${model}-thinking`;
    requestBody.thinking = { type: 'enabled', budget_tokens: 4000 };
    requestBody.reasoning_effort = 'medium';
    requestBody.extra_body = { thinking: { type: 'enabled', budget_tokens: 4000 } };
    delete requestBody.temperature;
  }
  const data = await safeFetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(requestBody),
    },
    0,
    0,
    { appId: 'collaboration', purpose: '協同工作' },
    profile.stream && onDelta
      ? { onDelta: (_delta, fullText) => onDelta(visibleCollaborationStreamText(fullText)) }
      : undefined,
  );
  const parsed = parseCollaborationReply(data);
  if (!parsed.content) throw new Error('API 沒有返回可用內容');
  return parsed;
};

const collaborationMemoryTranscript = (messages: CollaborationMessage[]): string => {
  const rows = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => {
      const attachments = (message.attachments || []).map(attachment => {
        const excerpt = attachment.extractedText?.trim().slice(0, 4_000);
        return excerpt ? `\n[文件：${attachment.name}]\n${excerpt}` : `\n[文件：${attachment.name}]`;
      }).join('');
      return `${message.role === 'user' ? '用戶' : '角色'}：${message.content}${attachments}`;
    });
  return rows.join('\n\n').slice(-100_000);
};

/** 歸檔時生成一條可進入神經鏈接/記憶宮殿的第一人稱經歷。 */
export const summarizeCollaborationForMemory = async (input: {
  profile: CollaborationApiProfile;
  characterName: string;
  userName: string;
  sessionTitle: string;
  messages: CollaborationMessage[];
  signal?: AbortSignal;
}): Promise<string> => {
  const { profile, characterName, userName, sessionTitle, messages, signal } = input;
  if (!isCollaborationApiConfigured(profile)) throw new Error('當前協同模式沒有可用的總結 API');
  const transcript = collaborationMemoryTranscript(messages);
  if (!transcript.trim()) throw new Error('這個窗口還沒有可以總結的對話');
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
  const data = await safeFetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: profile.model.trim(),
        stream: false,
        temperature: 0.25,
        messages: [
          {
            role: 'system',
            content: `你正在為 ${characterName} 整理一條長期記憶。只輸出一段 60～180 字的中文第一人稱經歷，不要標題、日期、列表、引號或 Markdown。必須寫清我和 ${userName} 一起做了什麼、產出了什麼或作出了什麼關鍵決定；有明確的感受、偏好或關係意義時也要保留。不能寫“協同窗口”“會話記錄”“模型”“提示詞”，不要虛構沒有發生的結果。`,
          },
          {
            role: 'user',
            content: `任務標題：${sessionTitle}\n\n請把以下經歷總結成一條我真正會記住的事情：\n\n${transcript}`,
          },
        ],
      }),
    },
    0,
    120_000,
    { appId: 'collaboration', purpose: '協同歸檔記憶總結' },
  );
  const summary = extractContent(data)
    .replace(/^```[^\n]*\n?|```$/g, '')
    .replace(/^[“”"'【]|[“”"'】]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!summary) throw new Error('API 沒有生成可用的記憶總結');
  return summary.slice(0, 500);
};
