// 視頻鏈接解析 — 抖音 / B站 / 快手等視頻平台的分享鏈接，Jina Reader 基本抓不到東西
// （SPA + 登錄牆），走 apizero 的 video-parse API 拿結構化元數據（標題/作者/封面/熱度），
// 映射成 ExtractedWebpage 複用現有 webpage_card 管線（卡片渲染 + messageFormat 喂 LLM）。
//
// 接入方式：瀏覽器直連（該 API CORS 全開），不走 sfworker —— 匿名配額按調用方 IP 計，
// 經 worker 轉發會讓所有用戶擠同一個出口 IP 的每日配額。API Key 可選（apizero.cn 註冊，
// 會員配額更高），存 localStorage，設置頁「視頻鏈接解析」裡填。
//
// 失敗（配額耗盡 / 平台不支持 / 服務掛了）由調用方降級到 extractWebpageContent。

import type { ExtractedWebpage, VideoShareInfo } from './webpageExtractor';

const API_ENDPOINT = 'https://v1.apizero.cn/api/video-parse';
const LS_KEY = 'sully_video_parse_key_v1';
const REQUEST_TIMEOUT_MS = 20000;

// 項目方共享 Key：按產品選擇隨公開前端一同分發，所有用戶共用其額度。
// 用戶仍可在 localStorage 寫入自己的 Key 覆蓋；清空自定義值後回落到此共享 Key。
const DEFAULT_VIDEO_PARSE_KEY = 'sk_live_4f53ade361c6c8cbead4395e858c1052e4ea1fc5e49a1a16';

/** 讀取生效的 apizero API Key：localStorage 用戶自填 > 內置默認 > 匿名（空串）。 */
export const getVideoParseKey = (): string => {
  try {
    return (localStorage.getItem(LS_KEY) || '').trim() || DEFAULT_VIDEO_PARSE_KEY;
  } catch {
    return DEFAULT_VIDEO_PARSE_KEY;
  }
};

/** 寫入 API Key。傳空 → 清掉（回落內置默認 key，沒有內置則匿名）。 */
export const setVideoParseKey = (key: string): void => {
  try {
    const trimmed = (key || '').trim();
    if (!trimmed) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, trimmed);
  } catch { /* localStorage 不可用就當匿名 */ }
};

// video-parse 支持的平台域名。判斷按 hostname 後綴匹配（含子域）。
// 寬進嚴出：命中了但解析失敗會降級回通用網頁抓取，所以像 weibo/x.com 這種
// 「不一定是視頻」的域名也放進來——視頻頁解析成功賺到，文字帖失敗就走老路。
// 小紅書不在列：已有專門的 xhs_card 路徑（apps/Chat.tsx）。
const VIDEO_SHARE_HOSTS: RegExp[] = [
  /(?:^|\.)douyin\.com$/i, /(?:^|\.)iesdouyin\.com$/i,
  /(?:^|\.)tiktok\.com$/i,
  /(?:^|\.)bilibili\.com$/i, /^b23\.tv$/i,
  /(?:^|\.)kuaishou\.com$/i, /(?:^|\.)chenzhongtech\.com$/i, // chenzhongtech: 快手分享短鏈域
  /(?:^|\.)weibo\.com$/i, /(?:^|\.)weibo\.cn$/i,
  /(?:^|\.)pipix\.com$/i, /(?:^|\.)izuiyou\.com$/i,
  /(?:^|\.)youtube\.com$/i, /^youtu\.be$/i,
  /(?:^|\.)vimeo\.com$/i,
  /(?:^|\.)twitter\.com$/i, /(?:^|\.)x\.com$/i, /^t\.co$/i,
  /(?:^|\.)jianying\.com$/i, /(?:^|\.)klingai\.com$/i, // 即夢 / 可靈 AI 生成內容分享
];

/** 這個鏈接是否該優先走視頻解析（而不是通用網頁抓取）。 */
export function isVideoShareUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return VIDEO_SHARE_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

// API 業務錯誤碼 → 用戶能看懂的話（HTTP 狀態不可靠，以 body.code 為準）。
const ERROR_MESSAGES: Record<number, string> = {
  4000: '鏈接格式不對或平台不支持',
  4015: '今日免費解析次數已用完（可在設置裡填 API Key 提額）',
  4029: '解析請求太頻繁，稍等幾秒再試',
  4030: '今日解析配額已耗盡',
  5020: '解析服務連不上源平台',
  5021: '源平台內容解析失敗（可能已刪除或需要登錄）',
};

/** 大數字轉「1.2萬 / 3.4億」，卡片和喂 LLM 的熱度行共用。0 / 無效返回空串。 */
export function formatStatCount(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')}億`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}萬`;
  return String(n);
}

const toCount = (v: any): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * 調 apizero video-parse 解析一個視頻平台分享鏈接，返回可直接存進
 * webpage_card metadata 的 ExtractedWebpage（帶 video 附加字段）。
 * 失敗拋錯，調用方負責降級到 extractWebpageContent。
 */
export async function parseVideoShareUrl(url: string): Promise<ExtractedWebpage> {
  const params = new URLSearchParams({ url, flat: '1' });
  const key = getVideoParseKey();
  if (key) params.set('key', key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let parsed: any = null;
  try {
    const res = await fetch(`${API_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
    const text = await res.text().catch(() => '');
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!parsed) throw new Error(`視頻解析服務無響應 (HTTP ${res.status})`);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('視頻解析超時');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const code = Number(parsed.code);
  if (code !== 0) {
    throw new Error(ERROR_MESSAGES[code] || String(parsed.msg || `視頻解析失敗 (code ${code})`));
  }

  // flat=1：字段直接在 data 頂層。兼容 flat=0 的兩層 data 以防 API 行為變化。
  const d: any = parsed.data?.data && !parsed.data.title ? parsed.data.data : (parsed.data || {});
  const source: any = d.source || {};
  const stats: any = d.stats || {};
  const imagelist: string[] = Array.isArray(d.imagelist) ? d.imagelist.filter((u: any) => typeof u === 'string' && u) : [];
  const isImagePost = d.type === '图片' || d.type === '圖片' || (!d.video_url && imagelist.length > 0);

  const title = String(d.title || '').trim();
  if (!title && !d.video_url && !imagelist.length) {
    throw new Error('解析結果為空'); // 空殼結果不建卡，降級走通用抓取
  }

  const video: VideoShareInfo = {
    platform: String(d.platform || source.platform || ''),
    platformLabel: String(source.platform_label || '') || undefined,
    contentType: isImagePost ? 'image' : 'video',
    authorName: String(stats.author_name || source.author_name || '') || undefined,
    authorAvatar: String(stats.author_avatar || '') || undefined,
    playCount: toCount(stats.play_count),
    likeCount: toCount(stats.like_count),
    commentCount: toCount(stats.comment_count),
    shareCount: toCount(stats.share_count),
    collectCount: toCount(stats.collect_count),
    publishTime: String(stats.publish_time || '') || undefined,
    imageCount: isImagePost ? imagelist.length : undefined,
  };

  const finalUrl = String(source.original_url || '') || undefined;
  return {
    url,
    finalUrl,
    title: title || `${video.platformLabel || video.platform}${isImagePost ? '圖文' : '視頻'}`,
    siteName: video.platformLabel || video.platform || undefined,
    content: '', // 視頻沒有可讀正文；messageFormat 的 video 分支會生成專門的描述文本
    excerpt: video.authorName ? `@${video.authorName}` : '',
    image: String(d.cover_url || '').trim() || imagelist[0] || undefined,
    truncated: false,
    fetchedAt: Date.now(),
    video,
    provider: 'apizero-video',
  };
}
