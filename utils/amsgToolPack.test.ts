/**
 * amsgToolPack 迴歸測試：構建 ↔ 解析往返、壞數據回退 null（worker 端 fire 鏈
 * 依賴「parse 失敗 = 無工具數據繼續跑」這個契約，別讓它變成拋錯）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildToolConfig,
  buildToolPack,
  parseToolConfig,
  parseToolPack,
} from './amsgToolPack';
import type { CharacterProfile, RealtimeConfig } from '../types';

describe('buildToolPack / parseToolPack', () => {
  it('構建後 JSON 往返還原，memories 只留 date/summary/mood', () => {
    const char = {
      id: 'c1',
      name: '小鹿',
      xhsEnabled: true,
      activeMemoryMonths: ['2026-06'],
      memories: [
        { id: 'm1', date: '2026-06-12', summary: '一起看了落日', mood: 'happy' },
        { id: 'm2', date: '2026-05-01', summary: '吵了一小架' },
      ],
    } as unknown as CharacterProfile;

    const pack = buildToolPack(char);
    const parsed = parseToolPack(JSON.stringify(pack));

    expect(parsed).toEqual({
      v: 1,
      charName: '小鹿',
      xhsEnabled: true,
      activeMemoryMonths: ['2026-06'],
      memories: [
        { date: '2026-06-12', summary: '一起看了落日', mood: 'happy' },
        { date: '2026-05-01', summary: '吵了一小架' },
      ],
      timeAwarenessEnabled: true,
    });
    expect(JSON.stringify(pack)).not.toContain('"id"');
  });

  it('缺字段的角色（老檔案）也能出合法 pack', () => {
    const pack = buildToolPack({ id: 'c2', name: '阿綾' } as unknown as CharacterProfile);
    expect(parseToolPack(JSON.stringify(pack))).toEqual({
      v: 1,
      charName: '阿綾',
      xhsEnabled: false,
      activeMemoryMonths: [],
      memories: [],
      timeAwarenessEnabled: true,
    });
  });

  it('壞數據一律 null：非 JSON / 形狀不對 / 版本不認識', () => {
    expect(parseToolPack('not json')).toBeNull();
    expect(parseToolPack('{"v":1}')).toBeNull();
    expect(parseToolPack(JSON.stringify({ v: 2, charName: 'x', activeMemoryMonths: [], memories: [] }))).toBeNull();
  });

  it('角色關掉時間感知 → 這個開關跟著上雲（不然主動消息裡照樣過節）', () => {
    const off = buildToolPack({ id: 'c3', name: '零', timeAwarenessEnabled: false } as unknown as CharacterProfile);
    expect(off.timeAwarenessEnabled).toBe(false);
    expect(parseToolPack(JSON.stringify(off))?.timeAwarenessEnabled).toBe(false);
    // 沒這個字段的包一律打回：worker 拿不到開關就只能猜，而猜錯就是穿幫。
    const { timeAwarenessEnabled: _dropped, ...missing } = off;
    expect(parseToolPack(JSON.stringify(missing))).toBeNull();
  });
});

describe('buildToolConfig / parseToolConfig', () => {
  it('只收工具子集字段，空值不寫鍵', () => {
    const rc = {
      newsEnabled: true,
      newsApiKey: 'brave-key',
      notionEnabled: true,
      notionApiKey: 'ntn-key',
      notionDatabaseId: 'db1',
      feishuEnabled: false,
      xhsMcpConfig: { enabled: true, serverUrl: 'https://xhs.example.com/api', cookie: 'ck', platform: 'rednote' },
      // 天氣不是工具，但 worker 到點要自己拉一次填進提示詞，所以也得上雲
      weatherEnabled: true,
      weatherCity: '上海',
      newsPlatforms: ['weibo', 'zhihu'],
    } as unknown as RealtimeConfig;

    const config = buildToolConfig(rc);
    const parsed = parseToolConfig(JSON.stringify(config));

    expect(parsed?.newsApiKey).toBe('brave-key');
    expect(parsed?.notionDatabaseId).toBe('db1');
    expect(parsed?.xhsMcpConfig).toEqual({ enabled: true, serverUrl: 'https://xhs.example.com/api', cookie: 'ck', platform: 'rednote' });
    expect(typeof parsed?.proxyWorkerUrl).toBe('string');
    expect(parsed?.proxyWorkerUrl).toMatch(/^https?:\/\//);
    // 到點組提示詞要用的實時世界配置：天氣開關 + 城市 + 熱榜平台
    expect(parsed?.weatherEnabled).toBe(true);
    expect(parsed?.weatherCity).toBe('上海');
    expect(parsed?.newsPlatforms).toEqual(['weibo', 'zhihu']);
    // 未配置的可選鍵不寫（省 payload，也避免 undefined 序列化怪態）
    expect('feishuAppId' in config).toBe(false);
  });

  it('無 realtimeConfig 時出全禁用配置（而不是拋錯）', () => {
    const config = buildToolConfig(undefined);
    expect(config.newsEnabled).toBe(false);
    expect(config.weatherEnabled).toBe(false);
    expect('weatherCity' in config).toBe(false);
    expect('newsPlatforms' in config).toBe(false);
    expect(config.notionEnabled).toBe(false);
    expect(config.feishuEnabled).toBe(false);
    expect(config.xhsMcpConfig).toBeUndefined();
  });

  it('壞數據一律 null', () => {
    expect(parseToolConfig('not json')).toBeNull();
    expect(parseToolConfig('{"v":1}')).toBeNull();
  });

  it('mcp 配置隨 tool_config 往返, 壞條目被丟棄', () => {
    const servers = [{
      id: 's1', name: '探針', url: 'https://probe.example.com',
      token: 'tok', tools: [{ name: 'get_secret' }],
    }];
    const config = buildToolConfig(undefined, { servers, useNativeTools: false });
    const parsed = parseToolConfig(JSON.stringify(config));
    expect(parsed?.mcpServers).toEqual(servers);
    expect(parsed?.mcpUseNativeTools).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dirty = { ...config, mcpServers: [servers[0], { id: 'bad' }, null, { name: 'x', url: 'u' }] };
    expect(parseToolConfig(JSON.stringify(dirty))?.mcpServers).toEqual(servers);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('整份清單都壞時兩個字段一起消失, 並且留一條 warn', () => {
    const config = buildToolConfig(undefined, {
      servers: [{ id: 's1', name: '探針', url: 'https://probe.example.com', tools: [] }],
      useNativeTools: false,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseToolConfig(JSON.stringify({ ...config, mcpServers: [{ id: 'bad' }, null] }));

    expect(parsed).not.toBeNull();
    expect('mcpServers' in parsed!).toBe(false);
    expect('mcpUseNativeTools' in parsed!).toBe(false);
    // 其餘憑據字段不受牽連
    expect(typeof parsed?.proxyWorkerUrl).toBe('string');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('不傳 mcp 配置時兩個字段都不出現（老 worker 解析零影響）', () => {
    const config = buildToolConfig(undefined);
    expect('mcpServers' in config).toBe(false);
    expect('mcpUseNativeTools' in config).toBe(false);
  });
});
