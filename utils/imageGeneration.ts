/**
 * 生圖：調用 OpenAI 兼容的 /images/generations（純文字）或 /images/edits（帶參考圖）接口，
 * 產出一張圖的 data URL。用於「系統設置 → 生圖API」的測試生圖，以及角色/用戶手動觸發的生圖。
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
    reader.onerror = () => reject(reader.error || new Error('讀取圖片失敗'));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片加載失敗'));
    img.src = src;
  });
}

/** 把角色專屬人物特徵提示詞拼進正文提示詞；沒配置則原樣返回。 */
export function buildCharacterImagePrompt(char: Pick<CharacterProfile, 'imageGenCharConfig'>, prompt: string): string {
  const characterPrompt = char.imageGenCharConfig?.characterPrompt?.trim();
  return characterPrompt ? `${prompt}\n人物特徵：${characterPrompt}` : prompt;
}

/**
 * 輕量啟發式：中文描述裡出現強烈暗示"這張圖不是角色本人獨照"的關鍵詞（合照/風景/物件……），
 * 判定為非自拍。只服務於「非自拍照不使用參考圖」這個開關，不追求精確——猜錯了頂多是該帶參考圖
 * 沒帶（退化成純文字生成）或不該帶帶了（生圖引擎會自己按提示詞忽略不合理的參考細節），
 * 不是錯誤行為。FaceCropModal 等場景生成的英文 imagePrompt（OOTD/Moments）不吃這個關鍵詞表，
 * 調用方應該改傳 forceSelfie，見 resolveCharacterReferenceImage。
 */
const NON_SELFIE_KEYWORDS = [
  '合照', '一起', '風景', '夜景', '天空', '街景', '街道', '建築', '美食', '食物', '菜', '咖啡',
  '書桌', '窗外', '背影', '寵物', '貓', '狗', '手機', '電腦', '物件', '靜物', '花', '植物', '風光',
];
export function looksLikeSelfieDescription(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return !NON_SELFIE_KEYWORDS.some(kw => trimmed.includes(kw));
}

/**
 * 純邏輯：這次生成要不要帶參考圖（不碰網絡/Blob，方便單測）。
 * - 總開關沒開 / 沒上傳參考圖：不帶。
 * - 「非自拍照不使用參考圖」開著時，非自拍場景不帶；forceSelfie 短路這條判斷（OOTD/Moments
 *   這類"畫的就是角色本人"的場景，不需要也不該套中文關鍵詞表）。
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
 * 按 FaceCropModal 選的臉部選區裁參考圖。選區座標是相對「參考圖先按 object-fit: cover
 * 裁成正方形」之後的比例（跟彈窗預覽的換算口徑一致），所以這裡先算出那個正方形裁切區，
 * 再在其中取 faceBox 那一塊——兩步都不做會跟用戶在彈窗裡拖框看到的位置對不上。
 * 沒傳 faceBox（用戶沒特意選過臉部）就只做居中方形裁切，原圖全貌送出去。
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
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('參考圖裁剪失敗')), 'image/png');
  });
}

/**
 * 生成前解析出這次要不要帶參考圖、帶哪一份（已按臉部選區裁好）。
 * - options.description：AI 自主發圖那種自由文本場景描述（角色自己寫的"我要發張xx照片"），
 *   拿去跑 looksLikeSelfieDescription 關鍵詞判斷。
 * - options.forceSelfie：調用方已經確定這次畫的就是角色本人（OOTD 穿搭、Moments 動態配圖），
 *   跳過關鍵詞判斷直接當自拍處理。
 * 解析失敗（參考圖 blob 丟失、裁剪出錯等）靜默返回 null，退化成純文字生成，不阻斷生圖流程。
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
    console.warn('[ImageGeneration] 參考圖解析失敗，退化成純文字生成:', e);
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
  if (!item) throw new Error('響應裡沒有圖片數據');

  if (item.b64_json) {
    return { dataUrl: `data:image/png;base64,${item.b64_json}` };
  }
  if (item.url) {
    const imgResponse = await fetch(item.url);
    if (!imgResponse.ok) throw new Error(`圖片地址請求失敗：HTTP ${imgResponse.status}`);
    const blob = await imgResponse.blob();
    return { dataUrl: await blobToDataUrl(blob) };
  }
  throw new Error('響應格式不支持（既沒有 b64_json 也沒有 url）');
}

/**
 * 調用生圖 API。config 需要 baseUrl / apiKey / model 都已經填好——
 * 調用方（設置面板 / 生成入口）負責校驗必填項和拼補充提示詞。
 *
 * referenceImageBlob 傳了的話走 /images/edits（圖生圖，OpenAI 兼容協議的"編輯"端點，
 * 不是所有生圖引擎都支持）；那條路失敗（引擎不支持 / 網絡錯誤都算）會自動退回純文字的
 * /images/generations 重試一次，不讓「引擎不支持參考圖」變成整次生成直接失敗。
 */
export async function generateImage(
  config: Pick<ImageGenApiConfig, 'baseUrl' | 'apiKey' | 'model' | 'size' | 'quality' | 'extraPrompt'>,
  prompt: string,
  referenceImageBlob?: Blob,
): Promise<GeneratedImage> {
  const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !config.model) throw new Error('生圖 API 未配置完整（URL / Model 缺失）');

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

  // 光傳參考圖很多生圖引擎只當成弱風格參考，臉型/五官比例照樣會飄；顯式用文字提要求
  // 「照著參考圖的臉」，實測能明顯收緊一致性。只加在帶參考圖這條路，不影響純文字生成。
  const referencePrompt = `${fullPrompt}\n\n[參考圖約束] 人物的臉型、五官比例、膚色、髮型需與所附參考圖保持高度一致，不要更改容貌特徵；只按提示詞調整場景、姿勢、服裝、表情等其餘部分。`;

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
    console.warn('[ImageGeneration] 帶參考圖的 /images/edits 失敗，退回純文字生成:', e);
    return generateTextOnly();
  }
}
