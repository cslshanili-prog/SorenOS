/**
 * 導出前的「明文密鑰」體檢 + 二次確認。
 *
 * 角色卡洩漏 API key 的教訓後，給所有「導出 / 分享 / 生成分享碼」的入口統一加一道閘：
 * 導出前深度掃描 payload，判斷裡面是否含明文密鑰，彈二次確認，讓用戶在點「確定」前先看清。
 *
 * 三態（與產品文案對應）：
 *  - safe             ：沒有明文密鑰 → 「該導出內容安全，可以用於分享」
 *  - contains-secret  ：**預期內**含密鑰（僅設置-數據備份這類整包備份）→ 「請不要發送給任何人」
 *  - unexpected-secret：**不該含密鑰的分享類導出**卻掃到了密鑰（說明還有漏洞）→ 「請截圖併發送給作者」
 *
 * 掃描邏輯刻意和 tools/card-inspector.html 保持一致：
 * 既看字段名（apiKey/secret/token/authorization/bearer/password/anonKey…），
 * 也看字段值（sk-…、Bearer …、JWT、32+ 位長哈希），未知/新增字段也能覆蓋。
 */

export interface SecretHit {
  /** 命中字段的點路徑，如 emotionConfig.api.apiKey */
  path: string;
  /** 打碼後的值，僅露頭尾幾位，絕不回顯完整密鑰 */
  masked: string;
  /** 命中原因 */
  reason: string;
}

export type ExportSafetyLevel = 'safe' | 'contains-secret' | 'unexpected-secret';

export interface ExportSafety {
  level: ExportSafetyLevel;
  message: string;
  hits: SecretHit[];
}

const SECRET_KEY_NAME = /(api[_-]?key|secret|token|authorization|auth|bearer|password|passwd|pwd|access[_-]?key|private[_-]?key|anon[_-]?key|credential|apikey)/i;

const STRONG_SECRET_VALUE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bsk-[A-Za-z0-9_\-]{12,}/, label: 'OpenAI 風格密鑰 sk-…' },
  { re: /\bBearer\s+[A-Za-z0-9._\-]{12,}/i, label: 'Bearer 令牌' },
  { re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{6,}/, label: 'JWT' },
];

const OPAQUE_SECRET_VALUE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b[A-Za-z0-9]{32,}\b/, label: '疑似長密鑰 / 哈希（32+ 位）' },
];

/** 這些字段名即便值很長也別誤報（正文 / 描述 / 圖片 dataURL 等） */
const VALUE_WHITELIST_KEYS = /^(id|voiceId|fishReferenceId|systemPrompt|description|worldview|content|summary|memoryText|impression|avatar|src|prompt|notes|bio|title|label|text|lyrics)$/i;

/** CSS 常含 base64 圖片/字體和內容哈希，不能用通用的“32+ 位字符串”規則判斷。 */
const CSS_VALUE_KEY = /css$/i;

function mask(v: unknown): string {
  const s = typeof v === 'string' ? v : String(v);
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}••••••${s.slice(-3)} (${s.length}字)`;
}

function stripCssDataUrls(v: string): string {
  // data URL 的 base64 主體經常超過 32 位；先剝掉資源本體，再保留其餘 CSS 做強特徵掃描。
  return v.replace(/data:[^)"'\s]+/gi, '');
}

function looksLikeSecretValue(v: string, opts: { allowOpaque?: boolean } = {}): string | null {
  if (v.length < 12) return null;
  if (v.startsWith('data:')) return null;
  if (/^https?:\/\//.test(v) && !/[?&](key|token|secret)=/i.test(v)) return null;
  for (const p of STRONG_SECRET_VALUE_PATTERNS) if (p.re.test(v)) return p.label;
  if (opts.allowOpaque !== false) {
    for (const p of OPAQUE_SECRET_VALUE_PATTERNS) if (p.re.test(v)) return p.label;
  }
  return null;
}

/** 深度遞歸掃描任意對象 / 數組，返回所有疑似明文密鑰命中項。 */
export function scanPlaintextSecrets(obj: unknown, path = '', hits: SecretHit[] = [], seen = new WeakSet<object>()): SecretHit[] {
  if (obj === null || typeof obj !== 'object') return hits;
  if (seen.has(obj as object)) return hits; // 防循環引用
  seen.add(obj as object);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    const isSecretName = SECRET_KEY_NAME.test(k);
    if (isSecretName && v != null && v !== '' && typeof v !== 'object') {
      hits.push({ path: p, masked: mask(v), reason: `字段名疑似憑據（${k}）` });
    } else if (typeof v === 'string' && !VALUE_WHITELIST_KEYS.test(k)) {
      const isCssValue = CSS_VALUE_KEY.test(k);
      const valueToScan = isCssValue ? stripCssDataUrls(v) : v;
      const lbl = looksLikeSecretValue(valueToScan, { allowOpaque: !isCssValue });
      if (lbl) hits.push({ path: p, masked: mask(v), reason: `字段值疑似${lbl}` });
    }
    if (v && typeof v === 'object') scanPlaintextSecrets(v, p, hits, seen);
  }
  return hits;
}

/**
 * 評估一次導出的安全性。
 * @param data 待導出的對象（若你手上是 JSON 字符串，先 JSON.parse 再傳進來）
 * @param opts.expectSecrets 該導出路徑是否「本就允許含密鑰」。僅設置-數據備份這類整包備份傳 true。
 */
export function assessExport(data: unknown, opts: { expectSecrets?: boolean } = {}): ExportSafety {
  const hits = scanPlaintextSecrets(data);
  if (hits.length === 0) {
    return { level: 'safe', message: '該導出內容安全，可以用於分享', hits };
  }
  if (opts.expectSecrets) {
    return { level: 'contains-secret', message: '該導出數據包含了明文密鑰，請不要發送給任何人', hits };
  }
  const paths = hits.map(h => `· ${h.path}`).join('\n');
  return {
    level: 'unexpected-secret',
    message: `該導出數據包含了明文密鑰（不應出現）。請截圖併發送給作者。\n\n檢出位置：\n${paths}`,
    hits,
  };
}

/**
 * 導出前的二次確認閘門。放在每個導出函數最前面：
 *   if (!(await confirmExportSafety(payload))) return;
 *
 * 返回 true = 用戶確認繼續；false = 用戶取消，調用方應直接 return 中止導出。
 * 默認用 window.confirm（瀏覽器 / Capacitor webview 均可用、阻塞、零依賴）。
 * 想接入自定義彈窗時，傳 opts.confirmImpl 覆蓋。
 */
export async function confirmExportSafety(
  data: unknown,
  opts: {
    expectSecrets?: boolean;
    /** 自定義確認實現：收到提示文案，返回用戶是否繼續。 */
    confirmImpl?: (assessment: ExportSafety) => boolean | Promise<boolean>;
  } = {},
): Promise<boolean> {
  const assessment = assessExport(data, { expectSecrets: opts.expectSecrets });

  if (opts.confirmImpl) return opts.confirmImpl(assessment);

  const c = (typeof window !== 'undefined' && typeof window.confirm === 'function')
    ? window.confirm.bind(window)
    : null;
  if (!c) return true; // 無 confirm 環境（如單測）默認放行，交由調用方另行處理

  // 三態都彈二次確認：安全給出「可分享」的安心提示，檢出密鑰給出對應警告。
  return c(`${assessment.message}\n\n點「確定」繼續導出，「取消」中止。`);
}
