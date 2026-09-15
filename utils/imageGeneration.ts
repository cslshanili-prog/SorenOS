/**
 * 生图：调用 OpenAI 兼容的 /images/generations 接口，产出一张图的 data URL。
 * 用于「系统设置 → 生图API」的测试生图，以及角色/用户手动触发的生图。
 */
import { CharacterProfile, ImageGenApiConfig } from '../types';
import { safeResponseJson } from './safeApi';

export interface GeneratedImage {
  dataUrl: string;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

/** 把角色专属人物特征提示词拼进正文提示词；没配置则原样返回。 */
export function buildCharacterImagePrompt(char: Pick<CharacterProfile, 'imageGenCharConfig'>, prompt: string): string {
  const characterPrompt = char.imageGenCharConfig?.characterPrompt?.trim();
  return characterPrompt ? `${prompt}\n人物特征：${characterPrompt}` : prompt;
}

/**
 * 调用生图 API。config 需要 baseUrl / apiKey / model 都已经填好——
 * 调用方（设置面板 / 生成入口）负责校验必填项和拼补充提示词。
 */
export async function generateImage(
  config: Pick<ImageGenApiConfig, 'baseUrl' | 'apiKey' | 'model' | 'size' | 'quality' | 'extraPrompt'>,
  prompt: string,
): Promise<GeneratedImage> {
  const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !config.model) throw new Error('生图 API 未配置完整（URL / Model 缺失）');

  const fullPrompt = config.extraPrompt?.trim() ? `${prompt}\n${config.extraPrompt.trim()}` : prompt;
  const body: Record<string, any> = { model: config.model, prompt: fullPrompt, n: 1 };
  if (config.size) body.size = config.size;
  if (config.quality) body.quality = config.quality;

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey || 'sk-none'}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`);
  }

  const data = await safeResponseJson(response);
  const item = data?.data?.[0];
  if (!item) throw new Error('响应里没有图片数据');

  if (item.b64_json) {
    return { dataUrl: `data:image/png;base64,${item.b64_json}` };
  }
  if (item.url) {
    const imgResponse = await fetch(item.url);
    if (!imgResponse.ok) throw new Error(`图片地址请求失败：HTTP ${imgResponse.status}`);
    const blob = await imgResponse.blob();
    return { dataUrl: await blobToDataUrl(blob) };
  }
  throw new Error('响应格式不支持（既没有 b64_json 也没有 url）');
}
