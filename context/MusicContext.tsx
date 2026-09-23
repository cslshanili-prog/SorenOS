/**
 * 全局音樂播放上下文
 *
 * 讓音樂在 App 間切換、鎖屏、甚至後台退出時都能繼續播放：
 *   1. <audio> 元素掛在 Provider 上，不隨 MusicApp 卸載銷毀。
 *   2. 播放隊列、進度、用戶 cookie/配置 全部在 Context 中。
 *   3. localStorage 持久化 cookie/工作台地址/隊列，刷新後可恢復。
 *   4. Media Session API 暴露鎖屏控件 (Android/iOS 原生通知欄也能控制)。
 */
import React, {
  createContext, useCallback, useContext, useEffect,
  useMemo, useRef, useState,
} from 'react';
import { cachedCall as _cachedCall, invalidate as _invalidateCache, clearAll as _clearAllCache } from '../utils/musicCache';
import { DB } from '../utils/db';
import { getProxyWorkerUrl, DEFAULT_PROXY_WORKER, PROXY_WORKER_CHANGED_EVENT } from '../utils/proxyWorker';
import type { PostProcessMusicHooks } from '../utils/applyAssistantPostProcessing';
import { resolveRefToDataUrl } from '../utils/blobRef';

/* ───────────── 類型 ───────────── */
export type MusicQuality = 'standard' | 'higher' | 'exhigh' | 'lossless' | 'hires';

export interface MusicCfg {
  workerUrl: string;
  cookie: string;
  quality: MusicQuality;
}

export interface Song {
  id: number;
  name: string;
  artists: string;
  album: string;
  albumPic: string;
  duration: number;
  fee: number;
  // ── Local-source extensions (used for AI-generated songs from 寫歌 App) ──
  /** True for songs not from netease — play them via blob from IndexedDB. */
  local?: boolean;
  /** IndexedDB key (under DB.assets) where the audio Blob lives. */
  localAssetKey?: string;
  /** Optional MIME type — used to set <audio> source correctly. */
  localMimeType?: string;
  /** Cover gradient/color for songs without album art. */
  localCoverStyle?: string;
  /** Char ID(s) credited as co-author. */
  customAuthorCharIds?: string[];
  /** Raw lyric text (with [Verse]/[Chorus] markers OK) — for synced display. */
  localLyrics?: string;
  /** Manual timestamps (seconds) per visible lyric line — overrides auto distribution. */
  lyricLineTimings?: number[];
}

export interface LyricLine { t: number; text: string; }

export interface NeteaseProfile {
  userId: number;
  nickname: string;
  avatarUrl: string;
  signature?: string;
  backgroundUrl?: string;
  vipType?: number;
  province?: number;
  gender?: number;
  followeds?: number;
  follows?: number;
  eventCount?: number;
  playlistCount?: number;
}

/* ───────────── 默認 / 常量 ───────────── */
const LS_CFG_KEY = 'sully_music_cfg_v1';
const LS_STATE_KEY = 'sully_music_state_v1';
const LS_LOCAL_ALBUM_KEY = 'sully_music_local_album_v1';

const loadLocalAlbum = (): Song[] => {
  try {
    const raw = localStorage.getItem(LS_LOCAL_ALBUM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};
const saveLocalAlbum = (songs: Song[]) => {
  try { localStorage.setItem(LS_LOCAL_ALBUM_KEY, JSON.stringify(songs)); } catch {}
};
// workerUrl 空串 = 跟隨「設置 → 網絡代理」的中心地址；非空 = 用戶在播放器裡手填的，
// 只在音樂這一處生效。存的是"跟不跟隨"這個意圖，不是當時中心地址的一份快照——
// 存快照的話事後分不清"用戶敲的"和"當時抄的"，中心一改就留下打不通的幽靈地址。
export const MUSIC_DEFAULT_CFG: MusicCfg = {
  workerUrl: '',
  cookie: '',
  quality: 'exhigh',
};

/* ───────────── 工具 ───────────── */
const normalizeHost = (u: string): string => (u || '').trim().replace(/\/+$/, '');

/**
 * 音樂請求實際要打的地址。每次發請求現算，中心地址改了立刻生效。
 * @param central 只有 MusicProvider 傳：它把中心地址放進了 state，好讓界面在中心
 *                地址變化時重渲染；其餘調用方省略，直接現讀中心配置。
 */
export const resolveMusicWorkerUrl = (
  cfg?: Pick<MusicCfg, 'workerUrl'> | null,
  central?: string,
): string => normalizeHost(cfg?.workerUrl || '') || normalizeHost(central || '') || getProxyWorkerUrl();

// 存量遷移：把"其實是跟著中心走"的地址收斂成空串（= 跟隨）。命中三種：
//   1. 已死的兩個歷史公共實例（sully-n.qegj567.workers.dev 國內超時、
//      sullymeow.ccwu213.cc 域名註冊過期，2026-07 起 DNS 都解析不到）；
//   2. 當前的公共默認實例；
//   3. 跟當前中心地址一模一樣的——老版本會把中心地址抄一份存進音樂配置。
// 只有跟以上都不同的地址才原樣保留。讀到需要改寫時落盤一次。
const FOLLOW_CENTRAL_HOSTS = [/sully-n\.qegj567\.workers\.dev/i, /sullymeow\.ccwu213\.cc/i];
const migrateWorkerUrl = (url: string | undefined): string => {
  const own = normalizeHost(url || '');
  if (!own) return '';
  const lower = own.toLowerCase();
  if (lower === normalizeHost(DEFAULT_PROXY_WORKER).toLowerCase()) return '';
  if (lower === normalizeHost(getProxyWorkerUrl()).toLowerCase()) return '';
  if (FOLLOW_CENTRAL_HOSTS.some((re) => re.test(lower))) return '';
  return own;
};

const loadCfg = (): MusicCfg => {
  try {
    const raw = localStorage.getItem(LS_CFG_KEY);
    if (!raw) return { ...MUSIC_DEFAULT_CFG };
    const cfg = { ...MUSIC_DEFAULT_CFG, ...JSON.parse(raw) };
    const migrated = migrateWorkerUrl(cfg.workerUrl);
    if (migrated !== cfg.workerUrl) {
      cfg.workerUrl = migrated;
      try { localStorage.setItem(LS_CFG_KEY, JSON.stringify(cfg)); } catch {}
    }
    return cfg;
  } catch { return { ...MUSIC_DEFAULT_CFG }; }
};

/**
 * 非 React 調用者（Proactive / activeMsgClient / prompt 構造層）讀取當前 user 的
 * MusicCfg。走 localStorage 持久化層，不掛 Context。
 */
export const loadMusicCfgStandalone = (): MusicCfg => loadCfg();

/**
 * 實時播放快照 — 給 OSContext 主動消息流程讀，避免 OSProvider 在 MusicProvider
 * 外層導致拿不到 useMusic()。MusicProvider mount 後會持續把當前播放狀態寫到這裡。
 */
/**
 * 最近一次「一起聽途中換歌」的記錄 — 切歌本身不觸發任何主動消息，
 * 只把信息留在這裡，等 char 下一輪正常回復時經 prompt 注入"察覺"到換歌。
 */
export interface RecentTrackChange {
  previousSong: { id: number; name: string; artists: string };
  /** 換歌那一刻正在"一起聽"的 char（只有這些 char 需要被提示） */
  charIds: string[];
  at: number;
}

export interface MusicPlaybackSnapshot {
  current: Song | null;
  playing: boolean;
  lyric: LyricLine[];
  activeLyricIdx: number;
  listeningTogetherWith: string[];
  cfg: MusicCfg;
  recentTrackChange?: RecentTrackChange | null;
}
let __musicPlaybackSnapshot: MusicPlaybackSnapshot | null = null;
export const loadMusicPlaybackSnapshot = (): MusicPlaybackSnapshot | null => __musicPlaybackSnapshot;

/**
 * 模塊級 musicHooks 出口 — 給 ChatParser.MUSIC_ACTION 用的三個鉤子打包成一個對象, 由
 * MusicProvider mount 後持續寫入最新閉包. 讓 useChatAI (本地 fetch 路徑) 和
 * activeMsgRuntime (雲端回覆的沖刷) 都從這裡取, 避免邏輯雙份維護 / push 路徑漏注入.
 * 行為細節見 chatParser.ts 的 MUSIC_ACTION 分支.
 */
let __musicHooks: PostProcessMusicHooks | null = null;
export const loadMusicHooks = (): PostProcessMusicHooks | null => __musicHooks;

const saveCfg = (cfg: MusicCfg) => {
  try { localStorage.setItem(LS_CFG_KEY, JSON.stringify(cfg)); } catch {}
};

const loadState = (): { queue: Song[]; idx: number } => {
  try {
    const raw = localStorage.getItem(LS_STATE_KEY);
    if (!raw) return { queue: [], idx: -1 };
    const s = JSON.parse(raw);
    return { queue: Array.isArray(s.queue) ? s.queue : [], idx: typeof s.idx === 'number' ? s.idx : -1 };
  } catch { return { queue: [], idx: -1 }; }
};

const saveState = (queue: Song[], idx: number) => {
  try { localStorage.setItem(LS_STATE_KEY, JSON.stringify({ queue, idx })); } catch {}
};

export const parseLyric = (txt: string): LyricLine[] => {
  if (!txt) return [];
  const out: LyricLine[] = [];
  const re = /\[(\d+):(\d+)(?:\.(\d+))?\](.*)/;
  for (const line of txt.split(/\r?\n/)) {
    const m = re.exec(line); if (!m) continue;
    const mm = parseInt(m[1], 10), ss = parseInt(m[2], 10);
    const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
    const text = m[4].trim(); if (!text) continue;
    out.push({ t: mm * 60 + ss + ms / 1000, text });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
};

export const normalizeCookie = (raw: string): string => {
  const s = (raw || '').trim(); if (!s) return '';
  if (s.toUpperCase().startsWith('MUSIC_U=')) return s;
  return `MUSIC_U=${s}`;
};

/**
 * 把網易雲返回的 http:// 資源 URL 升級成 https://
 * 瀏覽器在 HTTPS 頁面里加載 http:// 圖片會拋 Mixed Content 警告、並強制升級請求，
 * 我們直接在映射層就升級，避免控制台噪音。
 * - 只處理明文 http:// 開頭的；https / data / 相對路徑保持原樣
 * - 空/非字符串直接返回原值
 */
export const toHttps = (url: string): string => {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('http://')) return 'https://' + url.slice('http://'.length);
  return url;
};

/* ───────────── API ───────────── */
export const musicApi = {
  // 內部：真正打網絡（不走緩存）
  async _raw(cfg: MusicCfg, path: string, body: any = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const cookie = normalizeCookie(cfg.cookie);
    if (cookie) headers['X-Netease-Cookie'] = cookie;
    const url = `${resolveMusicWorkerUrl(cfg)}/netease${path.startsWith('/') ? path : '/' + path}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || j?.message || `HTTP ${res.status}`);
    return j;
  },
  // 對外：默認走 TTL 緩存 + in-flight 去重；無匹配規則的 path 會透傳
  async call(cfg: MusicCfg, path: string, body: any = {}) {
    return _cachedCall(path, body, cfg.cookie, () => musicApi._raw(cfg, path, body));
  },
  search(cfg: MusicCfg, keyword: string, offset = 0) {
    return musicApi.call(cfg, '/search', { keyword, limit: 30, offset, type: 1 });
  },
  songUrl(cfg: MusicCfg, id: number) {
    return musicApi.call(cfg, '/song/url', { ids: [id], level: cfg.quality });
  },
  lyric(cfg: MusicCfg, id: number) {
    return musicApi.call(cfg, '/lyric', { id });
  },
  loginStatus(cfg: MusicCfg) {
    return musicApi.call(cfg, '/login/status', {});
  },
  userDetail(cfg: MusicCfg, uid: number) {
    return musicApi.call(cfg, '/user/detail', { uid });
  },
  userPlaylist(cfg: MusicCfg, uid: number) {
    return musicApi.call(cfg, '/user/playlist', { uid, limit: 60 });
  },
  userRecord(cfg: MusicCfg, uid: number, type = 1) {
    return musicApi.call(cfg, '/user/record', { uid, type });
  },
  userCloud(cfg: MusicCfg) {
    return musicApi.call(cfg, '/user/cloud', {});
  },
  userSubcount(cfg: MusicCfg) {
    return musicApi.call(cfg, '/user/subcount', {});
  },
  playlistDetail(cfg: MusicCfg, id: number) {
    return musicApi.call(cfg, '/playlist/detail', { id });
  },
  playlistTrackAll(cfg: MusicCfg, id: number, limit = 50, offset = 0) {
    return musicApi.call(cfg, '/playlist/track/all', { id, limit, offset });
  },
  recommendSongs(cfg: MusicCfg) {
    return musicApi.call(cfg, '/recommend/songs', {});
  },
  personalFm(cfg: MusicCfg) {
    return musicApi.call(cfg, '/personal_fm', {});
  },
  dailySignin(cfg: MusicCfg, type = 1) {
    return musicApi.call(cfg, '/daily_signin', { type });
  },
  toplist(cfg: MusicCfg) {
    return musicApi.call(cfg, '/toplist', {});
  },
  loginQrKey(cfg: MusicCfg) {
    return musicApi.call(cfg, '/login/qr/key', {});
  },
  loginQrCreate(cfg: MusicCfg, key: string) {
    return musicApi.call(cfg, '/login/qr/create', { key, qrimg: true });
  },
  loginQrCheck(cfg: MusicCfg, key: string) {
    return musicApi.call(cfg, '/login/qr/check', { key });
  },
  loginCellphone(cfg: MusicCfg, phone: string, captcha: string) {
    return musicApi.call(cfg, '/login/cellphone', { phone, captcha });
  },
  captchaSent(cfg: MusicCfg, phone: string) {
    return musicApi.call(cfg, '/captcha/sent', { phone });
  },
  logout(cfg: MusicCfg) {
    return musicApi.call(cfg, '/logout', {});
  },
};

/* ───────────── Context 定義 ───────────── */
type PlayMode = 'loop' | 'shuffle' | 'single';

interface MusicContextType {
  cfg: MusicCfg;
  setCfg: (next: MusicCfg) => void;
  /** 當前真正在用的服務地址：cfg.workerUrl 留空時 = 中心代理地址 */
  effectiveWorkerUrl: string;

  // 播放隊列 / 當前曲
  queue: Song[];
  setQueue: (next: Song[]) => void;
  idx: number;
  current: Song | null;

  // 播放狀態
  playing: boolean;
  progress: number;
  duration: number;
  loadingSong: boolean;

  // 歌詞
  lyric: LyricLine[];
  tlyric: LyricLine[];
  activeLyricIdx: number;

  // 用戶
  profile: NeteaseProfile | null;
  refreshProfile: () => Promise<void>;

  // 操作
  playSong: (song: Song, opts?: { alsoSetQueue?: boolean; replaceQueue?: Song[]; startIdx?: number }) => Promise<void>;
  togglePlay: () => void;
  nextSong: () => void;
  prevSong: () => void;
  seek: (pct: number) => void;

  // 播放模式 & 喜歡
  playMode: PlayMode;
  setPlayMode: (m: PlayMode) => void;
  liked: boolean;
  toggleLike: () => Promise<void>;

  // 一起聽 — 當前哪些 char 和 user 一起聽（僅視覺狀態，不影響播放）
  // 歌曲切換 / 結束時自動清空
  listeningTogetherWith: string[];
  addListeningPartner: (charId: string) => void;
  removeListeningPartner: (charId: string) => void;
  clearListeningPartners: () => void;
  /** 最近一次一起聽途中換歌的記錄（供 prompt 注入"察覺換歌"，不觸發主動消息） */
  recentTrackChange: RecentTrackChange | null;

  // toast 轉發 (解耦)
  toast: (msg: string, type?: 'info' | 'success' | 'error') => void;
  setToastHandler: (h: (msg: string, type?: 'info' | 'success' | 'error') => void) => void;

  // 「一起寫的歌」專輯 — 從 寫歌 App 同步過來的本地生成歌
  localAlbumSongs: Song[];
  addLocalSong: (song: Song) => void;
  removeLocalSong: (songId: number) => void;
  // 實時重錄狀態 — 讓音樂 App 即使在切到其他界面也能看到"正在重錄"提示
  regeneratingId: number | null;
  regeneratingStatus: string;
  markRegenerating: (id: number | null, status?: string) => void;
}

const MusicContext = createContext<MusicContextType | undefined>(undefined);

/* ───────────── Provider ───────────── */
export const MusicProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [cfg, setCfgState] = useState<MusicCfg>(loadCfg);
  const setCfg = useCallback((next: MusicCfg) => {
    setCfgState(prev => {
      // 換帳號 → 上一個帳號的緩存全部失效，避免看到舊帳號數據。
      // 換地址那一半由下面 effectiveWorkerUrl 的 effect 統一管（中心地址變化也走那條）。
      if (prev.cookie !== next.cookie) _clearAllCache();
      return next;
    });
    saveCfg(next);
  }, []);

  // 中心地址（設置 → 網絡代理）。cfg.workerUrl 留空時用的就是它，進 state 是為了讓
  // 設置頁顯示的"當前生效地址"能跟著變——請求那邊不看這份，每次現讀中心配置。
  const [centralWorkerUrl, setCentralWorkerUrl] = useState<string>(getProxyWorkerUrl);
  useEffect(() => {
    const onProxyChanged = () => {
      setCentralWorkerUrl(getProxyWorkerUrl());
      // 中心變了會帶動存量遷移（存的地址正好等於新中心 → 收斂成"跟隨"），重讀一次。
      setCfgState(prev => {
        const next = loadCfg();
        return next.workerUrl === prev.workerUrl ? prev : next;
      });
    };
    window.addEventListener(PROXY_WORKER_CHANGED_EVENT, onProxyChanged);
    return () => window.removeEventListener(PROXY_WORKER_CHANGED_EVENT, onProxyChanged);
  }, []);

  const effectiveWorkerUrl = resolveMusicWorkerUrl(cfg, centralWorkerUrl);
  // 生效地址真的變了 → 上一個地址拉回來的東西全部作廢（首次掛載不算變）
  const lastWorkerUrlRef = useRef(effectiveWorkerUrl);
  useEffect(() => {
    if (lastWorkerUrlRef.current === effectiveWorkerUrl) return;
    lastWorkerUrlRef.current = effectiveWorkerUrl;
    _clearAllCache();
  }, [effectiveWorkerUrl]);

  const initialState = useMemo(loadState, []);
  const [queue, setQueueState] = useState<Song[]>(initialState.queue);
  const [idx, setIdx] = useState<number>(initialState.idx);
  const current = idx >= 0 && idx < queue.length ? queue[idx] : null;

  // 「一起寫的歌」本地專輯 — 由寫歌 App 同步過來的 ACE-Step / MiniMax 出歌
  const [localAlbumSongs, setLocalAlbumSongs] = useState<Song[]>(loadLocalAlbum);
  const addLocalSong = useCallback((song: Song) => {
    setLocalAlbumSongs(prev => {
      // 同 id 去重，新版本覆蓋
      const filtered = prev.filter(s => s.id !== song.id);
      const next = [song, ...filtered];
      saveLocalAlbum(next);
      return next;
    });
    // Keep the queue object in sync too. MusicApp downloads from `current`,
    // so a stale queue entry would otherwise keep the pre-regeneration asset key.
    setQueueState(prev => prev.map(item => item.id === song.id ? song : item));
  }, []);
  const removeLocalSong = useCallback((songId: number) => {
    setLocalAlbumSongs(prev => {
      const next = prev.filter(s => s.id !== songId);
      saveLocalAlbum(next);
      return next;
    });
  }, []);

  // 重錄狀態 — 單個 id + 狀態文案，跨 App 可見
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);
  const [regeneratingStatus, setRegeneratingStatus] = useState<string>('');
  const markRegenerating = useCallback((id: number | null, status: string = '') => {
    setRegeneratingId(id);
    setRegeneratingStatus(status);
  }, []);

  const setQueue = useCallback((next: Song[]) => {
    setQueueState(next);
  }, []);

  // 隊列持久化
  useEffect(() => { saveState(queue, idx); }, [queue, idx]);

  // 播放
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadingSong, setLoadingSong] = useState(false);

  // 歌詞
  const [lyric, setLyric] = useState<LyricLine[]>([]);
  const [tlyric, setTlyric] = useState<LyricLine[]>([]);
  const activeLyricIdx = useMemo(() => {
    if (!lyric.length) return -1;
    let i = 0;
    for (let k = 0; k < lyric.length; k++) if (lyric[k].t <= progress) i = k; else break;
    return i;
  }, [lyric, progress]);

  // toast 轉發
  const toastHandlerRef = useRef<(msg: string, type?: 'info' | 'success' | 'error') => void>(() => {});
  const toast = useCallback((msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    try { toastHandlerRef.current(msg, type); } catch {}
  }, []);
  const setToastHandler = useCallback((h: (msg: string, type?: 'info' | 'success' | 'error') => void) => {
    toastHandlerRef.current = h;
  }, []);

  // 用戶信息
  const [profile, setProfile] = useState<NeteaseProfile | null>(null);
  const refreshProfile = useCallback(async () => {
    if (!cfg.cookie) { setProfile(null); return; }
    try {
      const r = await musicApi.loginStatus(cfg);
      const p = r?.data?.profile || r?.profile;
      if (!p) { setProfile(null); return; }
      setProfile({
        userId: p.userId,
        nickname: p.nickname || '',
        avatarUrl: toHttps(p.avatarUrl || ''),
        signature: p.signature || '',
        backgroundUrl: toHttps(p.backgroundUrl || ''),
        vipType: p.vipType ?? 0,
        province: p.province,
        gender: p.gender,
        followeds: p.followeds,
        follows: p.follows,
        eventCount: p.eventCount,
        playlistCount: p.playlistCount,
      });
    } catch { setProfile(null); }
  }, [cfg]);

  useEffect(() => { refreshProfile(); }, [refreshProfile]);

  // 喜歡列表
  const [likedSet, setLikedSet] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!cfg.cookie) { setLikedSet(new Set()); return; }
    musicApi.call(cfg, '/likelist', {}).then(r => {
      const ids: number[] = r?.ids || r?.data?.ids || [];
      setLikedSet(new Set(ids));
    }).catch(() => {});
  }, [cfg]);

  // 「喜歡」邏輯分兩條路:
  //   - 網易雲歌 → 走 likelist API
  //   - 本地歌 → 在 localAlbum 裡就算喜歡，不在就不喜歡；toggle = add/remove
  const liked = !!current && (
    current.local
      ? localAlbumSongs.some(s => s.id === current.id)
      : likedSet.has(current.id)
  );
  const toggleLike = useCallback(async () => {
    if (!current) return;
    // ── 本地歌：toggle from album ──
    if (current.local) {
      const inAlbum = localAlbumSongs.some(s => s.id === current.id);
      if (inAlbum) {
        removeLocalSong(current.id);
        toast('已從「一起寫的歌」移除', 'info');
      } else {
        addLocalSong(current);
        toast('已加入「一起寫的歌」', 'success');
      }
      return;
    }
    // ── 網易雲歌 ──
    if (!cfg.cookie) { toast('需要登錄網易雲帳號', 'error'); return; }
    const willLike = !likedSet.has(current.id);
    try {
      await musicApi.call(cfg, '/like', { id: current.id, like: willLike });
      _invalidateCache('/likelist', cfg.cookie);
      setLikedSet(prev => {
        const next = new Set(prev);
        if (willLike) next.add(current.id); else next.delete(current.id);
        return next;
      });
      toast(willLike ? '已添加到喜歡' : '已取消喜歡', 'success');
    } catch (e: any) {
      toast(`喜歡失敗: ${e.message}`, 'error');
    }
  }, [current, cfg, likedSet, localAlbumSongs, addLocalSong, removeLocalSong, toast]);

  // 播放模式
  const [playMode, setPlayMode] = useState<PlayMode>('loop');

  // 一起聽 - char 加入後在 miniPlayer / 播放頁顯示徽標；切歌 / 結束自動清空
  const [listeningTogetherWith, setListeningTogetherWith] = useState<string[]>([]);
  const addListeningPartner = useCallback((charId: string) => {
    setListeningTogetherWith(prev => prev.includes(charId) ? prev : [...prev, charId]);
  }, []);
  const removeListeningPartner = useCallback((charId: string) => {
    setListeningTogetherWith(prev => prev.filter(id => id !== charId));
  }, []);
  const clearListeningPartners = useCallback(() => {
    setListeningTogetherWith(prev => prev.length ? [] : prev);
  }, []);

  // 切歌后清空上一首的"一起聽"。只結束狀態，不觸發主動消息 ——
  // 換歌信息記進 recentTrackChange，char 下一輪正常回復時經 prompt 注入察覺，
  // 自行決定是否重新加入。
  const previousSongRef = useRef<Song | null>(null);
  const listeningTogetherRef = useRef(listeningTogetherWith);
  listeningTogetherRef.current = listeningTogetherWith;
  const [recentTrackChange, setRecentTrackChange] = useState<RecentTrackChange | null>(null);
  useEffect(() => {
    const previousSong = previousSongRef.current;
    if (previousSong && previousSong.id !== current?.id) {
      const wasListening = listeningTogetherRef.current;
      if (wasListening.length > 0) {
        setRecentTrackChange({
          previousSong: { id: previousSong.id, name: previousSong.name, artists: previousSong.artists },
          charIds: [...wasListening],
          at: Date.now(),
        });
      }
      setListeningTogetherWith([]);
    }
    previousSongRef.current = current;
  }, [current]);

  // 前進/後退 refs (避免循環依賴 & audio 事件閉包陷阱)
  const queueRef = useRef(queue); queueRef.current = queue;
  const idxRef = useRef(idx); idxRef.current = idx;
  const modeRef = useRef(playMode); modeRef.current = playMode;
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const endedHandlerRef = useRef<() => void>(() => {});

  // 初始化 audio（僅 Provider 生命週期創建一次）
  useEffect(() => {
    const a = new Audio();
    a.preload = 'metadata';
    // 注意: 不要設置 crossOrigin — NetEase CDN 沒有 CORS 頭，會變成靜默加載失敗
    audioRef.current = a;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setProgress(a.currentTime);
    const onMeta = () => setDuration(a.duration || 0);
    // 播放出錯 → 清掉 playing 狀態 + 清掉"一起聽"夥伴（防止 UI 卡在殘留狀態）
    const onErr = () => { setPlaying(false); setListeningTogetherWith([]); toast('播放失敗', 'error'); };
    const onEnd = () => { endedHandlerRef.current(); };

    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('error', onErr);
    a.addEventListener('ended', onEnd);

    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('error', onErr);
      a.removeEventListener('ended', onEnd);
      try { a.pause(); a.src = ''; } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 播放單曲
  const playSong = useCallback(async (song: Song, opts: { alsoSetQueue?: boolean; replaceQueue?: Song[]; startIdx?: number } = {}) => {
    const { alsoSetQueue = true, replaceQueue, startIdx } = opts;

    if (replaceQueue) {
      setQueueState(replaceQueue);
      setIdx(typeof startIdx === 'number' ? startIdx : replaceQueue.findIndex(s => s.id === song.id));
    } else if (alsoSetQueue) {
      const qnow = queueRef.current;
      const existing = qnow.findIndex(s => s.id === song.id);
      if (existing >= 0) {
        setIdx(existing);
      } else {
        setQueueState(q => [...q, song]);
        setIdx(qnow.length);
      }
    }

    setLoadingSong(true); setLyric([]); setTlyric([]); setProgress(0); setDuration(0);
    try {
      // ── Local-source branch ── 本地生成的歌（寫歌 App 出歌）從 IndexedDB 取 blob
      if (song.local && song.localAssetKey) {
        const a = audioRef.current!;
        const entry = await DB.getAssetRaw(song.localAssetKey).catch(() => null) as
          | { blob?: Blob; mimeType?: string }
          | Blob
          | null;
        const blob: Blob | null = entry instanceof Blob ? entry : (entry?.blob instanceof Blob ? entry.blob : null);
        if (!blob) {
          toast('本地歌曲文件丟失', 'error');
          setLoadingSong(false);
          return;
        }
        const prevSrc = a.src;
        if (prevSrc.startsWith('blob:')) URL.revokeObjectURL(prevSrc);
        a.src = URL.createObjectURL(blob);
        a.play().catch(() => {});

        // ── 本地歌詞時間分佈 ──
        // MiniMax / ACE-Step 不返回帶時間戳的歌詞，但我們寫歌時就有原文。
        // 等 metadata 加載完拿到 duration → 把每行歌詞均勻鋪到時長上，
        // 實現「跟著歌詞滾動」的網易雲播放器體驗。
        if (song.localLyrics) {
          const distribute = () => {
            const dur = a.duration;
            if (!isFinite(dur) || dur <= 0) return;
            const lines = song.localLyrics!
              .split(/\r?\n/)
              .map(l => l.trim())
              // 跳過 [Verse]/[Chorus]/[Bridge] 等章節標記（純時間標，不顯示）
              // 也跳過空行
              .filter(l => l && !/^\[[^\]]+\]$/i.test(l));
            if (lines.length === 0) {
              setLyric([]);
              setTlyric([]);
              return;
            }
            // 用戶手動對軸的優先用，沒對過用平均分佈兜底
            let synced: LyricLine[];
            if (song.lyricLineTimings && song.lyricLineTimings.length === lines.length) {
              synced = lines.map((text, i) => ({
                t: song.lyricLineTimings![i] ?? 0,
                text,
              }));
            } else {
              const intro = Math.min(2, dur * 0.05);
              const outro = Math.min(3, dur * 0.05);
              const usable = Math.max(dur - intro - outro, dur * 0.6);
              const step = usable / lines.length;
              synced = lines.map((text, i) => ({
                t: intro + i * step,
                text,
              }));
            }
            setLyric(synced);
            setTlyric([]);
          };
          if (a.readyState >= 1 && isFinite(a.duration) && a.duration > 0) {
            distribute();
          } else {
            const onMeta = () => { distribute(); a.removeEventListener('loadedmetadata', onMeta); };
            a.addEventListener('loadedmetadata', onMeta);
          }
        } else {
          setLyric([]);
          setTlyric([]);
        }

        if ('mediaSession' in navigator) {
          try {
            (navigator as any).mediaSession.metadata = new (window as any).MediaMetadata({
              title: song.name,
              artist: song.artists,
              album: song.album,
            });
          } catch {}
        }
        setLoadingSong(false);
        return;
      }

      const [urlRes, lyricRes] = await Promise.all([
        musicApi.songUrl(cfgRef.current, song.id),
        musicApi.lyric(cfgRef.current, song.id).catch(() => null),
      ]);
      const url: string | null = urlRes?.data?.[0]?.url || null;
      if (!url) {
        toast(urlRes?.data?.[0]?.fee && !cfgRef.current.cookie ? '需要會員 cookie' : '暫無播放地址', 'error');
        setLoadingSong(false);
        return;
      }
      const a = audioRef.current!;
      a.src = url.replace(/^http:\/\//i, 'https://');
      a.play().catch(() => {});
      if (lyricRes) {
        setLyric(parseLyric(lyricRes?.lrc?.lyric || ''));
        setTlyric(parseLyric(lyricRes?.tlyric?.lyric || ''));
      }
      // 媒體會話（鎖屏 / 通知欄）
      if ('mediaSession' in navigator) {
        try {
          // 鎖屏/通知欄的封面不是 DOM，喂不了 blobref 令牌——那邊只認能直接加載的地址。
          // 用戶自己上傳的歌曲封面存的就是令牌，不解析的話鎖屏上是空白（而且不報錯）。
          // resolveRefToDataUrl 對非令牌原樣返回，所以可以無條件走。
          const artworkSrc = song.albumPic ? await resolveRefToDataUrl(song.albumPic) : '';
          (navigator as any).mediaSession.metadata = new (window as any).MediaMetadata({
            title: song.name,
            artist: song.artists,
            album: song.album,
            artwork: artworkSrc ? [
              { src: artworkSrc, sizes: '300x300', type: 'image/jpeg' },
              { src: artworkSrc, sizes: '512x512', type: 'image/jpeg' },
            ] : [],
          });
        } catch {}
      }
    } catch (e: any) {
      toast(`播放失敗：${e.message}`, 'error');
    } finally {
      setLoadingSong(false);
    }
  }, [toast]);

  // 下一首 / 上一首
  const nextSong = useCallback(() => {
    const q = queueRef.current; if (!q.length) return;
    const cur = idxRef.current; if (cur < 0) return;
    let n: number;
    if (modeRef.current === 'shuffle' && q.length > 1) {
      do { n = Math.floor(Math.random() * q.length); } while (n === cur);
    } else if (modeRef.current === 'single') {
      n = cur;
    } else {
      n = (cur + 1) % q.length;
    }
    setIdx(n); playSong(q[n], { alsoSetQueue: false });
  }, [playSong]);

  const prevSong = useCallback(() => {
    const q = queueRef.current; if (!q.length) return;
    const cur = idxRef.current; if (cur < 0) return;
    const n = (cur - 1 + q.length) % q.length;
    setIdx(n); playSong(q[n], { alsoSetQueue: false });
  }, [playSong]);

  // 自動下一首（end 事件）— 通過 ref 轉發，以免 useEffect([], []) 閉包陷阱
  useEffect(() => {
    endedHandlerRef.current = () => {
      if (modeRef.current === 'single') {
        const a = audioRef.current; if (a) { a.currentTime = 0; a.play().catch(() => {}); }
        return;
      }
      nextSong();
    };
  }, [nextSong]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current; if (!a) return;
    // 刷新後 audio 元素是新創建的、尚未設置 src；此時按播放鍵應根據持久化的隊列按需加載當前曲目
    if (!a.src) {
      const q = queueRef.current; const i = idxRef.current;
      const cur = i >= 0 && i < q.length ? q[i] : null;
      if (cur) playSong(cur, { alsoSetQueue: false });
      return;
    }
    if (a.paused) a.play().catch(() => {}); else a.pause();
  }, [playSong]);

  const seek = useCallback((pct: number) => {
    const a = audioRef.current; if (!a || !duration) return;
    a.currentTime = Math.max(0, Math.min(duration, duration * pct));
  }, [duration]);

  // Media Session handlers (鎖屏播放/暫停/上下首)
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = (navigator as any).mediaSession;
    try {
      ms.setActionHandler('play', () => {
        const a = audioRef.current; if (!a) return;
        if (!a.src) {
          const q = queueRef.current; const i = idxRef.current;
          const cur = i >= 0 && i < q.length ? q[i] : null;
          if (cur) playSong(cur, { alsoSetQueue: false });
          return;
        }
        if (a.paused) a.play().catch(() => {});
      });
      ms.setActionHandler('pause', () => {
        const a = audioRef.current; if (a && !a.paused) a.pause();
      });
      ms.setActionHandler('nexttrack', () => nextSong());
      ms.setActionHandler('previoustrack', () => prevSong());
      ms.setActionHandler('seekto', (details: any) => {
        const a = audioRef.current; if (!a) return;
        if (typeof details.seekTime === 'number') a.currentTime = details.seekTime;
      });
    } catch { /* ignore */ }
  }, [nextSong, prevSong, playSong]);

  // 播放狀態同步到 mediaSession
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try { (navigator as any).mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch {}
  }, [playing]);

  // 把當前播放狀態寫到模塊級快照，供非 React 調用者（OSContext.runProactive
  // 等位於 MusicProvider 上層的代碼）讀取。useMusic() 在那一層用不了。
  useEffect(() => {
    __musicPlaybackSnapshot = {
      current,
      playing,
      lyric,
      activeLyricIdx,
      listeningTogetherWith,
      cfg,
      recentTrackChange,
    };
  }, [current, playing, lyric, activeLyricIdx, listeningTogetherWith, cfg, recentTrackChange]);

  // 把整組 musicHooks 寫到模塊級 slot — useChatAI 和 activeMsgRuntime 都從這裡取.
  // current / addListeningPartner 變化時刷新閉包, 保證讀到的是最新 React state.
  // addSongToCharPlaylist 直接落 DB, 落完廣播 'char-music-profile-updated' 讓 OSContext
  // 把新歌單同步回內存裡的角色 (順帶刷主動消息 2.0 的雲端快照).
  useEffect(() => {
    __musicHooks = {
      getListeningSnapshot: () => {
        if (!current) return null;
        return {
          songId: current.id,
          name: current.name,
          artists: current.artists,
          album: current.album,
          albumPic: current.albumPic,
          duration: current.duration,
          fee: current.fee,
        };
      },
      joinListeningTogether: (cid: string) => {
        addListeningPartner(cid);
      },
      addSongToCharPlaylist: async (cid, song, target) => {
        try {
          const all = await DB.getAllCharacters();
          const targetChar = all.find(c => c.id === cid);
          if (!targetChar) return null;
          const profile = targetChar.musicProfile;
          if (!profile) return null;

          const now = Date.now();
          let playlists = profile.playlists.slice();
          let chosenIdx = -1;
          let created = false;

          if (target?.kind === 'new') {
            // 新建歌單 — 標題去重（已存在同名就當成 existing 處理）
            const dup = playlists.findIndex(p =>
              p.title.trim().toLowerCase() === target.title.trim().toLowerCase());
            if (dup >= 0) {
              chosenIdx = dup;
            } else {
              playlists.push({
                id: `pl-${now}-${playlists.length}`,
                title: target.title.trim(),
                description: (target.description || '').trim(),
                coverStyle: `gradient-0${(playlists.length % 6) + 1}`,
                songs: [],
                createdAt: now,
                updatedAt: now,
              });
              chosenIdx = playlists.length - 1;
              created = true;
            }
          } else if (target?.kind === 'existing') {
            const t = target.title.trim().toLowerCase();
            chosenIdx = playlists.findIndex(p => p.title.trim().toLowerCase() === t);
            if (chosenIdx < 0) chosenIdx = playlists.findIndex(p =>
              p.title.trim().toLowerCase().includes(t) || t.includes(p.title.trim().toLowerCase()));
            if (chosenIdx < 0 && playlists.length > 0) chosenIdx = 0;
          } else {
            if (playlists.length > 0) chosenIdx = 0;
          }

          if (chosenIdx < 0) {
            playlists.push({
              id: `pl-${now}-0`,
              title: '我喜歡的音樂',
              description: '',
              coverStyle: 'gradient-01',
              songs: [],
              createdAt: now,
              updatedAt: now,
            });
            chosenIdx = 0;
            created = true;
          }

          const pl = playlists[chosenIdx];
          if (pl.songs.find(s => s.id === song.id)) {
            return { playlistTitle: pl.title, created: false };
          }
          const updatedPl = { ...pl, songs: [...pl.songs, song], updatedAt: now };
          playlists[chosenIdx] = updatedPl;

          const updatedProfile = { ...profile, playlists, updatedAt: now };
          await DB.saveCharacter({ ...targetChar, musicProfile: updatedProfile });
          // 只落 DB 的話內存裡那份角色還是舊歌單: 之後隨便哪個 updateCharacter 都會拿舊內存
          // 合併寫回, 把剛加的歌反向抹掉 (情緒 buff 踩過同一個坑); 主動消息 2.0 的雲端快照
          // 也會停在加歌之前, 角色到點還當這首歌沒收藏過。交給 OSContext 的監聽補這兩件事。
          window.dispatchEvent(new CustomEvent('char-music-profile-updated', {
            detail: { charId: cid, musicProfile: updatedProfile },
          }));
          return { playlistTitle: pl.title, created };
        } catch {
          return null;
        }
      },
    };
  }, [current, addListeningPartner]);

  const value: MusicContextType = {
    cfg, setCfg, effectiveWorkerUrl,
    queue, setQueue, idx, current,
    playing, progress, duration, loadingSong,
    lyric, tlyric, activeLyricIdx,
    profile, refreshProfile,
    playSong, togglePlay, nextSong, prevSong, seek,
    playMode, setPlayMode,
    liked, toggleLike,
    listeningTogetherWith, addListeningPartner, removeListeningPartner, clearListeningPartners,
    recentTrackChange,
    toast, setToastHandler,
    localAlbumSongs, addLocalSong, removeLocalSong,
    regeneratingId, regeneratingStatus, markRegenerating,
  };

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
};

export const useMusic = (): MusicContextType => {
  const ctx = useContext(MusicContext);
  if (!ctx) throw new Error('useMusic must be used within MusicProvider');
  return ctx;
};
