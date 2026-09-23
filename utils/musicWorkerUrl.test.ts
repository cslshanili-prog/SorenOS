/**
 * 音樂服務地址跟隨中心代理 —— 迴歸守衛
 *
 * 音樂 App 的服務地址是獨立持久化的（`sully_music_cfg_v1`），跟「設置 → 網絡代理」
 * 那個中心地址不是同一份存儲。這裡釘住兩件事，別再退化：
 *   1. 沒在播放器裡單獨填過地址的，永遠跟著中心走 —— 中心改了、改回默認了，都立刻跟上；
 *   2. 在播放器裡手填過地址的，中心怎麼改都不動它。
 *
 * 「跟隨」現在存成空串（一個意圖），不是把當時的中心地址抄一份存下來（一個快照）。
 * 快照的問題是事後分不清「用戶敲的」和「當時抄的」，中心一改就留下打不通的幽靈地址。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MusicCfg,
  loadMusicCfgStandalone,
  musicApi,
  resolveMusicWorkerUrl,
} from '../context/MusicContext';
import { DEFAULT_PROXY_WORKER, setProxyWorkerUrl } from './proxyWorker';

const LS_CFG_KEY = 'sully_music_cfg_v1';

/** 直接往 localStorage 裡塞一份音樂配置（模擬存量數據） */
const seedMusicCfg = (workerUrl: string) => {
  localStorage.setItem(LS_CFG_KEY, JSON.stringify({ workerUrl, cookie: '', quality: 'exhigh' }));
};

const storedWorkerUrl = (): string => JSON.parse(localStorage.getItem(LS_CFG_KEY) || '{}').workerUrl;

describe('音樂服務地址：跟隨中心代理', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('沒單獨設過 → 用中心地址，中心改了立刻跟上', () => {
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe(DEFAULT_PROXY_WORKER);

    setProxyWorkerUrl('https://my-proxy.example.com');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe('https://my-proxy.example.com');

    setProxyWorkerUrl('');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe(DEFAULT_PROXY_WORKER);
  });

  it('存量地址跟當前中心一樣 → 收斂成「跟隨」，中心改回默認後跟著回默認', () => {
    // 老版本會把當時的中心地址抄進音樂配置。之後中心改回默認，那份快照紋絲不動，
    // 請求繼續打已經不用了的地址 —— 正是這條測試要擋住的退化。
    setProxyWorkerUrl('https://old-proxy.example.com');
    seedMusicCfg('https://old-proxy.example.com');

    expect(loadMusicCfgStandalone().workerUrl).toBe('');

    setProxyWorkerUrl('');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe(DEFAULT_PROXY_WORKER);
  });

  it('存量地址是公共默認實例 / 已死的歷史實例 → 都當成跟隨中心', () => {
    for (const stale of [
      DEFAULT_PROXY_WORKER,
      'https://sully-n.qegj567.workers.dev',
      'https://sullymeow.ccwu213.cc',
    ]) {
      seedMusicCfg(stale);
      expect(loadMusicCfgStandalone().workerUrl).toBe('');
    }
  });

  it('遷移結果落盤，不是每次讀都現算', () => {
    seedMusicCfg('https://sully-n.qegj567.workers.dev');
    loadMusicCfgStandalone();
    expect(storedWorkerUrl()).toBe('');
  });

  it('在播放器裡手填過的地址 → 中心怎麼改都不動', () => {
    seedMusicCfg('https://my-own-music.example.com');
    expect(loadMusicCfgStandalone().workerUrl).toBe('https://my-own-music.example.com');

    setProxyWorkerUrl('https://another-proxy.example.com');
    expect(resolveMusicWorkerUrl(loadMusicCfgStandalone())).toBe('https://my-own-music.example.com');
  });

  it('地址結尾的斜槓和空格不影響拼出來的 URL', () => {
    const cfg = { workerUrl: '  https://my-own-music.example.com//  ', cookie: '', quality: 'exhigh' } as MusicCfg;
    expect(resolveMusicWorkerUrl(cfg)).toBe('https://my-own-music.example.com');
  });

  it('發請求時才解析地址 —— 同一份 cfg，中心改了就打到新地址', async () => {
    const hit: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      hit.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    // 組件掛載時快照進 state 的那份 cfg（跟隨中心），中途不會重新構造
    const cfg = loadMusicCfgStandalone();
    await musicApi._raw(cfg, '/login/qr/key');

    setProxyWorkerUrl('https://my-proxy.example.com');
    await musicApi._raw(cfg, '/login/qr/key');

    expect(hit).toEqual([
      `${DEFAULT_PROXY_WORKER}/netease/login/qr/key`,
      'https://my-proxy.example.com/netease/login/qr/key',
    ]);
  });
});
