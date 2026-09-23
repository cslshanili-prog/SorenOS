import type { ApiPreset, Message, VisionApiConfig } from '../types';
import { DB } from './db';
import { extractContent, safeFetchJson } from './safeApi';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';
import { isBlobRef } from './blobRef';

export const VISION_DESCRIPTION_METADATA_KEY = 'visionDescription';

/** 設置頁測試識圖能力時發送的 48×48 白底紫色圓點 PNG。 */
export const VISION_API_TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADKSURBVGhD7Y+5DQMxDASvLtfmll2DDQYHHDYwfxGCdoBJFGg513dzLnzYDQZMw4BpGDANA568Xx+zVZQE4HEes6QC8JiMUcIBeECFEUIBOFypF3cADnbowRWAQ51aOScAB1Zo4YwA/HilGgzoVoMB3WqoAfjhajXUAAE/XakGA7rVYEC3GqYAAT9eoYVzAgQc6NTKWQECDnXowR0g4GClXkIBAg5XGCEcIOABGaOkAm7wGI9ZSgJu8Lh/VlEaMAEDpmHANAyYZvuAH2hIrK7auxVfAAAAAElFTkSuQmCC';

const VISION_PROMPT = `請準確、具體地描述圖片中實際可見的內容，供另一個無法看圖的對話模型理解。
請覆蓋主體、動作、場景、重要物品、畫面中的文字或界面信息；不要猜測畫面外的信息，不要寒暄，只輸出描述正文。`;

/**
 * 這個值還能拿去識圖嗎。三種形態都算數：內嵌的 data URL、網絡地址，以及本機存的
 * 圖片令牌（`blobref:`，二進制在 blob_assets 裡，見 utils/blobRef.ts）——令牌發出去
 * 之前會由網絡出口統一還原成 data URL（utils/apiBlobRefs.ts），這裡只負責別把它
 * 誤判成「圖沒了」。
 *
 * 判漏的後果是靜默的：圖明明在，識圖這步卻直接跳過或報「圖片數據不可用」，
 * 界面上一點徵兆都沒有。
 */
const canDescribeImage = (value: unknown): value is string =>
  typeof value === 'string' && (/^(data:image\/|https?:\/\/)/i.test(value) || isBlobRef(value));

const inFlightDescriptions = new Map<string, Promise<string>>();

/** 把一份通用模型預設填入獨立識圖配置，不改變主 API 當前選擇。 */
export const visionApiConfigFromPreset = (preset: ApiPreset, enabled = true): VisionApiConfig => ({
  enabled,
  baseUrl: normalizeApiBaseUrl(preset.config.baseUrl),
  apiKey: normalizeApiCredential(preset.config.apiKey),
  model: normalizeApiModel(preset.config.model),
});

export const isVisionApiReady = (config?: VisionApiConfig | null): config is VisionApiConfig =>
  config?.enabled === true
  && !!config.baseUrl?.trim()
  && !!config.apiKey?.trim()
  && !!config.model?.trim();

export const readVisionDescription = (message: Message): string => {
  const value = message.metadata?.[VISION_DESCRIPTION_METADATA_KEY];
  return typeof value === 'string' ? value.trim() : '';
};

const cleanDescription = (value: string): string => value
  .replace(/^\s*\[?[图圖]片\s*[：:]\s*/i, '')
  .replace(/\]\s*$/i, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 4000);

/** 調用 OpenAI 兼容視覺端點，把一張圖片變成可交給純文本模型的描述。 */
export async function describeImageWithVisionApi(
  imageUrl: string,
  config: VisionApiConfig,
): Promise<string> {
  if (!isVisionApiReady(config)) {
    throw new Error('識圖 API 已開啟，但 URL、Key 或 Model 尚未填寫完整');
  }
  if (!canDescribeImage(imageUrl)) {
    throw new Error('圖片數據不可用，無法調用識圖 API');
  }

  const existing = inFlightDescriptions.get(imageUrl);
  if (existing) return existing;

  const request = (async () => {
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
    const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model.trim(),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        temperature: 0,
        max_tokens: 1200,
        stream: false,
      }),
    }, 1, 60_000, { appName: '消息', purpose: '識圖' });

    const description = cleanDescription(extractContent(data));
    if (!description) throw new Error('識圖 API 沒有返回圖片描述');
    return description;
  })();

  inFlightDescriptions.set(imageUrl, request);
  try {
    return await request;
  } finally {
    inFlightDescriptions.delete(imageUrl);
  }
}

/**
 * 為聊天歷史裡的圖片補齊識圖描述。
 *
 * 描述寫回消息 metadata，因此同一條圖片消息後續聊天、重 roll、主動消息都只識別一次；
 * 同一批裡內容完全相同的圖片也會複用第一次結果。
 */
export async function materializeVisionDescriptions(
  messages: Message[],
  config?: VisionApiConfig | null,
): Promise<Message[]> {
  if (config?.enabled !== true) return messages;
  if (!isVisionApiReady(config)) {
    throw new Error('識圖 API 已開啟，但 URL、Key 或 Model 尚未填寫完整');
  }

  const descriptionByImage = new Map<string, string>();
  const prepared: Message[] = [];

  for (const message of messages) {
    if (message.type !== 'image') {
      prepared.push(message);
      continue;
    }

    const cached = readVisionDescription(message);
    if (cached) {
      descriptionByImage.set(message.content, cached);
      prepared.push(message);
      continue;
    }

    const imageUrl = typeof message.content === 'string' ? message.content : '';
    // 純文字備份會保留 image 消息但移除原圖數據；這種歷史沿用“圖片已不可用”佔位，
    // 不能因為新開了識圖 API 就讓整輪聊天失敗。
    if (!canDescribeImage(imageUrl)) {
      prepared.push(message);
      continue;
    }
    const description = descriptionByImage.get(imageUrl)
      || await describeImageWithVisionApi(imageUrl, config);
    descriptionByImage.set(imageUrl, description);

    const metadata = {
      ...(message.metadata || {}),
      [VISION_DESCRIPTION_METADATA_KEY]: description,
      visionRecognizedAt: Date.now(),
      visionModel: config.model.trim(),
    };
    // 先寫回 DB 再調用主模型：下一輪與刷新頁面後都會直接命中，不重複扣識圖額度。
    await DB.updateMessageMetadata(message.id, prev => ({ ...(prev || {}), ...metadata }));
    prepared.push({ ...message, metadata });
  }

  return prepared;
}
