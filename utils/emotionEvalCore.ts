/**
 * 雲端情緒評估的共用內核：佔位符還原 + 副 API 請求 + 失敗文案（先打碼後截斷）。
 *
 * amsg worker 的即時對話路徑吃的是前端 `buildEmotionEvalPrompt(..., includeContext=false, ...)`
 * 生成的模板，還原與請求邏輯必須跟模板約定**逐字同款**。報錯文案裡的 apiKey 一定要先打碼
 * 再截斷，否則副 API key 會隨 push 帶出去。
 *
 * 零瀏覽器 / 零 worker 運行時依賴（會被打進 amsg worker bundle）。
 */

/** 副 API 憑據（沒單獨配就是主 API 那一份）。 */
export interface EmotionEvalApi { baseUrl: string; apiKey: string; model: string }

export const EMOTION_EVAL_SYSTEM_SLOT = '__EMOTION_EVAL_SYSTEM_PROMPT__';
export const EMOTION_EVAL_HISTORY_SLOT = '__EMOTION_EVAL_HISTORY__';

/** 單次評估請求的上限；副 API 卡住的話，主流程不該跟著一起被扣在這兒。 */
export const EMOTION_EVAL_TIMEOUT_MS = 120_000;

/**
 * 消息 content → 一行文本。結構化分段（帶圖片的消息）拍平成「文字 [圖片]」。
 * 與本地 buildEmotionEvalPrompt 的 recentLines 同款：用空格連接、空段丟掉。
 */
export const flattenEvalContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === 'text'
        ? (part.text || '')
        : (part?.type === 'image_url' ? '[圖片]' : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
};

/**
 * 把模板裡的兩個佔位符用本次請求的消息還原掉。
 *
 * - `messages[0]`（role=system）= 本地的 mainSystemPrompt
 * - `messages[1..]` = 本地的 cleanedApiMessages，拼成 `[用戶]: …` / `[角色名]: …` / `[系統]: …`
 *
 * 用函數式 replacer：system prompt 和對話裡出現 `$&`、`$1` 這類字符時，
 * String.replace 會把它們當成替換模式解析，評估看到的就不是原話了。
 */
export const restoreEvalPrompt = (
  template: string,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
): string => {
  const messages = Array.isArray(chatMessages) ? chatMessages : [];
  let systemPromptText = '';
  let conversation = messages;
  if (messages.length > 0 && messages[0]?.role === 'system') {
    systemPromptText = flattenEvalContent(messages[0].content);
    conversation = messages.slice(1);
  }
  const recentLines = conversation
    .map((m) => {
      const role = m.role === 'user' ? '用戶' : (m.role === 'assistant' ? charName : '系統');
      return `[${role}]: ${flattenEvalContent(m.content)}`;
    })
    .join('\n');
  return String(template)
    .replace(EMOTION_EVAL_SYSTEM_SLOT, () => systemPromptText)
    .replace(EMOTION_EVAL_HISTORY_SLOT, () => recentLines);
};

/** 報錯正文最多帶回這麼長——夠定位是限流還是鑑權就行，不是日誌轉發通道。 */
export const ERROR_SNIPPET_MAX = 120;

/**
 * 「先打碼、後截斷」的唯一出口：所有會隨 push 出門的失敗文案（HTTP 分支、catch 分支）
 * 都要過這裡。打碼在截斷之前——先截的話，切口正好落在 key 中間時整串就查不到 key，
 * 半截憑據原樣帶出去。個別中轉會把整個請求（含 Authorization 頭）回顯在錯誤頁裡。
 */
export const maskAndSnip = (text: string, apiKey: string): string => {
  let snippet = text.replace(/\s+/g, ' ').trim();
  if (apiKey && snippet.includes(apiKey)) snippet = snippet.split(apiKey).join('***');
  return snippet.slice(0, ERROR_SNIPPET_MAX);
};

/** 一次評估的結局：拿到原文，或者一句能給用戶看的短失敗原因。 */
export interface EmotionEvalOutcome {
  /** 評估模型的輸出原文；沒跑出來時為 null。 */
  raw: string | null;
  /** 沒跑出來的原因（人話、一句話）；成功時為 null。 */
  error: string | null;
}

/**
 * 發一次評估請求並解析輸出。promptContent 傳 restoreEvalPrompt 還原好的整段。
 * 失敗絕不拋：給一句已打碼的短原因（它最終要走 push 出門，憑據絕不進 push 是紅線）。
 */
export const requestEmotionEval = async (
  api: EmotionEvalApi,
  promptContent: string,
  timeoutMs: number = EMOTION_EVAL_TIMEOUT_MS,
): Promise<EmotionEvalOutcome> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = String(api.baseUrl).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api.apiKey || 'sk-none'}`,
      },
      body: JSON.stringify({
        model: api.model,
        messages: [{ role: 'user', content: promptContent }],
        temperature: 0.85,
        // 顯式給足輸出額度：部分中轉不傳 max_tokens 時默認很小，評估輸出很長，
        // 會被截成半截 JSON。
        max_tokens: 8000,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 正文可能是 HTML 錯誤頁，截一小段夠定位即可。
      let body = '';
      try { body = await res.text(); } catch { /* 讀不出正文就只報狀態碼 */ }
      console.warn('[emotion-eval] 副 API 拒了這次評估（主流程不受影響）', res.status);
      const snippet = maskAndSnip(body, api.apiKey);
      return { raw: null, error: `副 API HTTP ${res.status}${snippet ? `：${snippet}` : ''}` };
    }
    const data = await res.json() as any;
    // 個別中轉把全部輸出塞進 reasoning_content 而 content 留空——與客戶端
    // utils/emotionApply.ts 的 extractAssistantText 同一套兜底。
    const message = data?.choices?.[0]?.message;
    const raw = flattenEvalContent(message?.content)
      || (typeof message?.reasoning_content === 'string' ? message.reasoning_content : '');
    if (!raw.trim()) {
      return {
        raw: null,
        error: `評估模型沒有輸出內容（finish_reason: ${data?.choices?.[0]?.finish_reason ?? '?'}）`,
      };
    }
    return { raw, error: null };
  } catch (error) {
    console.warn('[emotion-eval] 評估失敗（主流程不受影響）', error);
    // 只帶異常名/消息，不帶棧：這句要走 push 出門，短一點、也別把內部路徑抖出去。
    // 異常消息同樣過打碼：fetch 異常一般不含請求頭，但 URL 解析類錯誤會回顯傳入的
    // 地址，用戶把 key 拼在 baseUrl 裡時不打碼就漏了。
    const reason = controller.signal.aborted
      ? `評估超時（${Math.round(timeoutMs / 1000)} 秒沒回來）`
      : `評估請求沒發出去：${maskAndSnip(error instanceof Error ? error.message : String(error), api.apiKey)}`;
    return { raw: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
};
