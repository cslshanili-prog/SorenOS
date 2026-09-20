/**
 * 生图：调用 OpenAI 兼容的 /images/generations（纯文字）或 /images/edits（带参考图）接口，
 * 产出一张图的 data URL。用于「系统设置 → 生图API」的测试生图，以及角色/用户手动触发的生图。
 */
import { CharacterProfile, ImageGenApiConfig } from '../types';
import { safeResponseJson } from './safeApi';
import { getBlobForRef } from './blobRef';

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

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 把角色专属人物特征提示词拼进正文提示词；没配置则原样返回。 */
export function buildCharacterImagePrompt(char: Pick<CharacterProfile, 'imageGenCharConfig'>, prompt: string): string {
  const characterPrompt = char.imageGenCharConfig?.characterPrompt?.trim();
  return characterPrompt ? `${prompt}\n人物特征：${characterPrompt}` : prompt;
}

/**
 * 轻量启发式：中文描述里出现强烈暗示"这张图不是角色本人独照"的关键词（合照/风景/物件……），
 * 判定为非自拍。只服务于「非自拍照不使用参考图」这个开关，不追求精确——猜错了顶多是该带参考图
 * 没带（退化成纯文字生成）或不该带带了（生图引擎会自己按提示词忽略不合理的参考细节），
 * 不是错误行为。FaceCropModal 等场景生成的英文 imagePrompt（OOTD/Moments）不吃这个关键词表，
 * 调用方应该改传 forceSelfie，见 resolveCharacterReferenceImage。
 */
const NON_SELFIE_KEYWORDS = [
  '合照', '一起', '风景', '夜景', '天空', '街景', '街道', '建筑', '美食', '食物', '菜', '咖啡',
  '书桌', '窗外', '背影', '宠物', '猫', '狗', '手机', '电脑', '物件', '静物', '花', '植物', '风光',
];
export function looksLikeSelfieDescription(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return !NON_SELFIE_KEYWORDS.some(kw => trimmed.includes(kw));
}

/**
 * 纯逻辑：这次生成要不要带参考图（不碰网络/Blob，方便单测）。
 * - 总开关没开 / 没上传参考图：不带。
 * - 「非自拍照不使用参考图」开着时，非自拍场景不带；forceSelfie 短路这条判断（OOTD/Moments
 *   这类"画的就是角色本人"的场景，不需要也不该套中文关键词表）。
 */
export function shouldUseCharacterReference(
  cfg: CharacterProfile['imageGenCharConfig'] | undefined,
  options: { description?: string; forceSelfie?: boolean } = {},
): boolean {
  if (!cfg?.referenceEnabled || !cfg.referenceImage) return false;
  const skipsNonSelfie = cfg.nonSelfieSkipsReference ?? true;
  if (!skipsNonSelfie) return true;
  if (options.forceSelfie || options.description === undefined) return true;
  return looksLikeSelfieDescription(options.description);
}

/**
 * 按 FaceCropModal 选的脸部选区裁参考图。选区坐标是相对「参考图先按 object-fit: cover
 * 裁成正方形」之后的比例（跟弹窗预览的换算口径一致），所以这里先算出那个正方形裁切区，
 * 再在其中取 faceBox 那一块——两步都不做会跟用户在弹窗里拖框看到的位置对不上。
 * 没传 faceBox（用户没特意选过脸部）就只做居中方形裁切，原图全貌送出去。
 */
export async function cropReferenceImage(
  sourceBlob: Blob,
  faceBox?: { x: number; y: number; size: number },
  outputSize = 640,
): Promise<Blob> {
  const dataUrl = await blobToDataUrl(sourceBlob);
  const img = await loadImageElement(dataUrl);
  const side = Math.min(img.width, img.height);
  const squareX = (img.width - side) / 2;
  const squareY = (img.height - side) / 2;
  const sx = faceBox ? squareX + faceBox.x * side : squareX;
  const sy = faceBox ? squareY + faceBox.y * side : squareY;
  const sSize = faceBox ? faceBox.size * side : side;

  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context error');
  ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, outputSize, outputSize);

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('参考图裁剪失败')), 'image/png');
  });
}

/**
 * 生成前解析出这次要不要带参考图、带哪一份（已按脸部选区裁好）。
 * - options.description：AI 自主发图那种自由文本场景描述（角色自己写的"我要发张xx照片"），
 *   拿去跑 looksLikeSelfieDescription 关键词判断。
 * - options.forceSelfie：调用方已经确定这次画的就是角色本人（OOTD 穿搭、Moments 动态配图），
 *   跳过关键词判断直接当自拍处理。
 * 解析失败（参考图 blob 丢失、裁剪出错等）静默返回 null，退化成纯文字生成，不阻断生图流程。
 */
export async function resolveCharacterReferenceImage(
  char: Pick<CharacterProfile, 'imageGenCharConfig'>,
  options: { description?: string; forceSelfie?: boolean } = {},
): Promise<Blob | null> {
  const cfg = char.imageGenCharConfig;
  if (!shouldUseCharacterReference(cfg, options)) return null;
  try {
    const sourceBlob = await getBlobForRef(cfg!.referenceImage!);
    if (!sourceBlob) return null;
    return await cropReferenceImage(sourceBlob, cfg!.referenceFaceBox);
  } catch (e) {
    console.warn('[ImageGeneration] 参考图解析失败，退化成纯文字生成:', e);
    return null;
  }
}

async function parseImageResponse(response: Response): Promise<GeneratedImage> {
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

/**
 * 调用生图 API。config 需要 baseUrl / apiKey / model 都已经填好——
 * 调用方（设置面板 / 生成入口）负责校验必填项和拼补充提示词。
 *
 * referenceImageBlob 传了的话走 /images/edits（图生图，OpenAI 兼容协议的"编辑"端点，
 * 不是所有生图引擎都支持）；那条路失败（引擎不支持 / 网络错误都算）会自动退回纯文字的
 * /images/generations 重试一次，不让「引擎不支持参考图」变成整次生成直接失败。
 */
export async function generateImage(
  config: Pick<ImageGenApiConfig, 'baseUrl' | 'apiKey' | 'model' | 'size' | 'quality' | 'extraPrompt'>,
  prompt: string,
  referenceImageBlob?: Blob,
): Promise<GeneratedImage> {
  const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !config.model) throw new Error('生图 API 未配置完整（URL / Model 缺失）');

  const fullPrompt = config.extraPrompt?.trim() ? `${prompt}\n${config.extraPrompt.trim()}` : prompt;

  const generateTextOnly = async (): Promise<GeneratedImage> => {
    const body: Record<string, any> = { model: config.model, prompt: fullPrompt, n: 1 };
    if (config.size) body.size = config.size;
    if (config.quality) body.quality = config.quality;
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey || 'sk-none'}` },
      body: JSON.stringify(body),
    });
    return parseImageResponse(response);
  };

  if (!referenceImageBlob) return generateTextOnly();

  // 光传参考图很多生图引擎只当成弱风格参考，脸型/五官比例照样会飘；显式用文字提要求
  // 「照着参考图的脸」，实测能明显收紧一致性。只加在带参考图这条路，不影响纯文字生成。
  const referencePrompt = `${fullPrompt}\n\n[参考图约束] 人物的脸型、五官比例、肤色、发型需与所附参考图保持高度一致，不要更改容貌特征；只按提示词调整场景、姿势、服装、表情等其余部分。`;

  try {
    const form = new FormData();
    form.append('model', config.model);
    form.append('prompt', referencePrompt);
    form.append('n', '1');
    if (config.size) form.append('size', config.size);
    form.append('image', referenceImageBlob, 'reference.png');
    const response = await fetch(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey || 'sk-none'}` },
      body: form,
    });
    return await parseImageResponse(response);
  } catch (e) {
    console.warn('[ImageGeneration] 带参考图的 /images/edits 失败，退回纯文字生成:', e);
    return generateTextOnly();
  }
}
