/**
 * 資料庫：讓 AI 看圖寫描述（描述欄右上角那顆）。描述是寫給角色看的——角色只能靠這段知道照片拍了什麼，
 * 所以要客觀、具體、短，不猜人物身分。模型從 API 預設裡挑一個（要能看圖），選過的記在本機。
 */

import type { APIConfig, ApiPreset } from '../types';
import { safeFetchJson, extractContent } from './safeApi';
import { LIBRARY_DESCRIPTION_MAX } from './library';

export const LIBRARY_DESCRIBE_PROMPT = `替這張照片寫一段簡短的描述，會存進照片資料庫；之後角色只能靠這段文字知道照片拍了什麼。
要求：
- 繁體中文，一到三句，100 字以內
- 寫畫面裡有什麼、在哪裡、什麼時間或光線、氣氛
- 有人的話寫外觀、穿著和動作，不猜是誰、不取名字
- 只寫看得到的，不評論、不抒情，不要用「這張照片」「圖中」開頭
只輸出描述本身。`;

export interface LibraryDescribeApi { baseUrl: string; apiKey: string; model: string }

/** 選單：主 API 在最前，後面是各個預設；沒填完整的不列 */
export interface LibraryDescribeOption { id: string; label: string; api: LibraryDescribeApi }

const ready = (config?: Partial<APIConfig> | null): config is APIConfig =>
    !!config?.baseUrl?.trim() && !!config.apiKey?.trim() && !!config.model?.trim();

const toApi = (config: APIConfig): LibraryDescribeApi => ({
    baseUrl: config.baseUrl.trim(), apiKey: config.apiKey.trim(), model: config.model.trim(),
});

export const MAIN_API_OPTION_ID = 'main';

export const libraryDescribeOptions = (mainApi: Partial<APIConfig> | null | undefined, presets: ApiPreset[]): LibraryDescribeOption[] => [
    ...(ready(mainApi) ? [{ id: MAIN_API_OPTION_ID, label: `主 API（${mainApi.model.trim()}）`, api: toApi(mainApi) }] : []),
    ...presets.filter(preset => ready(preset.config)).map(preset => ({ id: preset.id, label: preset.name || preset.config.model, api: toApi(preset.config) })),
];

/** 模型有時會自己加引號、「描述：」之類的開頭，拿掉 */
export const cleanLibraryDescription = (text: string): string =>
    text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim()
        .replace(/^(?:描述|照片描述|圖片描述)\s*[：:]\s*/, '')
        .replace(/^[「『"“]([\s\S]*)[」』"”]$/, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LIBRARY_DESCRIPTION_MAX);

export const describeLibraryImage = async (api: LibraryDescribeApi, imageUrl: string): Promise<string> => {
    if (!imageUrl) throw new Error('圖片讀不出來');
    // blobref 令牌原樣放進 image_url 就行：網絡出口會換成 data URL（utils/apiBlobRefs.ts）
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: LIBRARY_DESCRIBE_PROMPT },
                    { type: 'image_url', image_url: { url: imageUrl } },
                ],
            }],
            temperature: 0.3,
            max_tokens: 1200,
            stream: false,
        }),
    }, 1, 60_000, { appName: '資料庫', purpose: '寫照片描述' });
    const text = cleanLibraryDescription(extractContent(data) || '');
    if (!text) throw new Error('模型沒有回描述，可能不支援看圖，換一個試試');
    return text;
};

const STORAGE_KEY = 'library_describe_api';

export const loadLibraryDescribeChoice = (): string | null => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
};

export const saveLibraryDescribeChoice = (id: string) => {
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* 存不了就每次重選 */ }
};
