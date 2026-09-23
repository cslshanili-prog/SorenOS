const MODEL_ID_KEYS = ['id', 'model', 'name', 'model_name', 'slug'] as const;

/**
 * 把第三方 /models 的鬆散返回值收斂成 UI 可以安全處理的字符串列表。
 * 有些兼容站會把整個模型對象（甚至 null、數字）塞進數組；這些值若直接
 * 進入選擇器，公共前綴計算裡的 slice/toLowerCase 會讓整頁崩潰。
 */
export function normalizeModelIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of value) {
        let candidate: unknown = item;
        if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            candidate = MODEL_ID_KEYS.map(key => record[key]).find(entry => typeof entry === 'string');
        }
        if (typeof candidate !== 'string') continue;
        const id = candidate.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }

    return result;
}

/**
 * 生圖相關模型的名稱啟發式判斷——/models 接口通常不會標註「這個模型能不能生圖」，
 * 只能靠模型 id 裡常見的關鍵詞猜。猜不中的話調用方應該留一個「顯示全部模型」的退路，
 * 不能讓這個函數變成唯一入口。
 */
const IMAGE_MODEL_HINT = /image|imagen|dall-?e|stable-?diffusion|\bsdxl\b|\bsd3\b|flux|midjourney|kolors|cogview|wanx|[万萬]相|seedream|ideogram|recraft|playground-v|firefly|hunyuan.*(image|dit)|qwen.*image|grok.*image/i;

export function isLikelyImageModel(modelId: string): boolean {
    return IMAGE_MODEL_HINT.test(modelId);
}

/** Extract common OpenAI-compatible and nested model-list response shapes. */
export function extractModelIds(data: unknown): string[] {
    if (Array.isArray(data)) return normalizeModelIds(data);
    if (!data || typeof data !== 'object') return [];

    const root = data as Record<string, unknown>;
    const nestedData = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
        ? root.data as Record<string, unknown>
        : undefined;
    const candidates = [root.data, root.models, nestedData?.models, nestedData?.data];
    for (const candidate of candidates) {
        const models = normalizeModelIds(candidate);
        if (models.length > 0) return models;
    }
    return [];
}
