import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROXY_WORKER,
  getProxyWorkerUrl,
  setProxyWorkerUrl,
  isCustomProxyWorker,
  rewriteStaleWorkerUrl,
  requestProxyWorkerSettingsFocus,
  consumeProxyWorkerSettingsFocus,
} from './proxyWorker';

const LS_KEY = 'sully_proxy_worker_url_v1';

describe('proxyWorker 中心配置', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('沒設過時返回默認地址', () => {
    expect(getProxyWorkerUrl()).toBe(DEFAULT_PROXY_WORKER);
    expect(isCustomProxyWorker()).toBe(false);
  });

  it('設了自定義地址後讀得到，且標記為自定義', () => {
    setProxyWorkerUrl('https://my-worker.example.com');
    expect(getProxyWorkerUrl()).toBe('https://my-worker.example.com');
    expect(isCustomProxyWorker()).toBe(true);
  });

  it('去掉首尾空格和結尾斜槓', () => {
    setProxyWorkerUrl('  https://my-worker.example.com///  ');
    expect(getProxyWorkerUrl()).toBe('https://my-worker.example.com');
  });

  it('填的就是默認地址 → 清空存儲，回落默認', () => {
    setProxyWorkerUrl('https://my-worker.example.com');
    expect(isCustomProxyWorker()).toBe(true);
    setProxyWorkerUrl(DEFAULT_PROXY_WORKER);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    expect(getProxyWorkerUrl()).toBe(DEFAULT_PROXY_WORKER);
  });

  it('傳空字符串 → 清空存儲，回落默認', () => {
    setProxyWorkerUrl('https://my-worker.example.com');
    setProxyWorkerUrl('');
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    expect(getProxyWorkerUrl()).toBe(DEFAULT_PROXY_WORKER);
  });

  it('非法地址（不帶 http/https）→ 不寫入', () => {
    setProxyWorkerUrl('my-worker.example.com'); // 缺協議
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    expect(getProxyWorkerUrl()).toBe(DEFAULT_PROXY_WORKER);
  });

  it('存量裡如果是髒數據（非 http）→ 讀取時回落默認', () => {
    localStorage.setItem(LS_KEY, 'javascript:alert(1)');
    expect(getProxyWorkerUrl()).toBe(DEFAULT_PROXY_WORKER);
  });

  it('舊的 *.workers.dev 默認域名 → 讀取時遷移回默認', () => {
    localStorage.setItem(LS_KEY, 'https://sully-n.qegj567.workers.dev');
    expect(getProxyWorkerUrl()).toBe(DEFAULT_PROXY_WORKER);
  });

  it('http（非 https）的自定義地址也接受', () => {
    setProxyWorkerUrl('http://localhost:8787');
    expect(getProxyWorkerUrl()).toBe('http://localhost:8787');
  });

  it('已過期的 sullymeow.ccwu213.cc → 讀取時遷移回默認', () => {
    localStorage.setItem(LS_KEY, 'https://sullymeow.ccwu213.cc');
    expect(getProxyWorkerUrl()).toBe(DEFAULT_PROXY_WORKER);
  });
});

describe('網絡代理設置定位', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('公告發出的定位請求只消費一次', () => {
    expect(consumeProxyWorkerSettingsFocus()).toBe(false);
    requestProxyWorkerSettingsFocus();
    expect(consumeProxyWorkerSettingsFocus()).toBe(true);
    expect(consumeProxyWorkerSettingsFocus()).toBe(false);
  });
});

// 已死的歷史公共實例域名必須被遷到當前 worker，否則獨立持久化的存量配置
// （音樂播放器 / 小紅書 serverUrl）會一直打 DNS 解析失敗的地址
describe('rewriteStaleWorkerUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('遷移已過期的 sullymeow.ccwu213.cc，保留路徑', () => {
    expect(rewriteStaleWorkerUrl('https://sullymeow.ccwu213.cc')).toBe(DEFAULT_PROXY_WORKER);
    expect(rewriteStaleWorkerUrl('https://sullymeow.ccwu213.cc/api')).toBe(`${DEFAULT_PROXY_WORKER}/api`);
  });

  it('遷移最早的 workers.dev 默認域名', () => {
    expect(rewriteStaleWorkerUrl('https://sully-n.qegj567.workers.dev/api')).toBe(`${DEFAULT_PROXY_WORKER}/api`);
  });

  it('中心配了自部署 worker 時，死域名跟著遷到自部署地址', () => {
    setProxyWorkerUrl('https://my-own.example.com');
    expect(rewriteStaleWorkerUrl('https://sullymeow.ccwu213.cc/api')).toBe('https://my-own.example.com/api');
  });

  it('活地址 / 用戶自部署地址 / 空值原樣保留', () => {
    expect(rewriteStaleWorkerUrl(DEFAULT_PROXY_WORKER)).toBe(DEFAULT_PROXY_WORKER);
    expect(rewriteStaleWorkerUrl('https://my-own.example.com/api')).toBe('https://my-own.example.com/api');
    expect(rewriteStaleWorkerUrl('')).toBe('');
  });
});
