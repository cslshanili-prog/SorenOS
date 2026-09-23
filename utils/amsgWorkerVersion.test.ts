import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareAmsgServerVersions, isAmsgServerVersionAtLeast } from './amsgWorkerVersion';

// 比較邏輯本身用固定樣本測，跟設置頁當前門檻值無關。
const FLOOR = '2.6.0-next.5';

describe('isAmsgServerVersionAtLeast（重新部署門檻）', () => {
  it('等於門檻 → 達標', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-next.5', FLOOR)).toBe(true);
  });

  it('next.4 舊部署（features 與 next.5 相同、無法靠 flag 區分）→ 不達標', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-next.4', FLOOR)).toBe(false);
  });

  it('prerelease 段按數字比較：next.10 > next.5（不是字符串序）', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-next.10', FLOOR)).toBe(true);
  });

  it('同主版本的正式版高於任何 prerelease：2.6.0 達標', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0', FLOOR)).toBe(true);
  });

  it('更高主/次/補丁版本達標（含帶 prerelease 的）', () => {
    expect(isAmsgServerVersionAtLeast('2.6.1-next.1', FLOOR)).toBe(true);
    expect(isAmsgServerVersionAtLeast('2.7.0', FLOOR)).toBe(true);
    expect(isAmsgServerVersionAtLeast('3.0.0-next.1', FLOOR)).toBe(true);
  });

  it('更低版本不達標', () => {
    expect(isAmsgServerVersionAtLeast('2.5.9', FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast('2.6.0-next.1', FLOOR)).toBe(false);
  });

  it('字母段排序：alpha < next（semver 字符串序）', () => {
    expect(isAmsgServerVersionAtLeast('2.6.0-alpha.9', FLOOR)).toBe(false);
  });

  it('解析不了 / 空值 → 不達標（寧亮牌不靜默降級）', () => {
    expect(isAmsgServerVersionAtLeast('', FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast(undefined, FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast('dev', FLOOR)).toBe(false);
    expect(isAmsgServerVersionAtLeast('2.6', FLOOR)).toBe(false);
  });

  it('容忍 v 前綴與首尾空白', () => {
    expect(isAmsgServerVersionAtLeast(' v2.6.0-next.5 ', FLOOR)).toBe(true);
  });
});

describe('compareAmsgServerVersions', () => {
  it('相等 → 0', () => {
    expect(compareAmsgServerVersions('2.6.0-next.5', '2.6.0-next.5')).toBe(0);
    expect(compareAmsgServerVersions('2.6.0', '2.6.0')).toBe(0);
  });

  it('prerelease 段數少的更低（2.6.0-next < 2.6.0-next.1）', () => {
    expect(compareAmsgServerVersions('2.6.0-next', '2.6.0-next.1')).toBe(-1);
  });

  it('數字段低於字母段（2.6.0-1 < 2.6.0-next）', () => {
    expect(compareAmsgServerVersions('2.6.0-1', '2.6.0-next')).toBe(-1);
  });

  it('任一側壞串 → null', () => {
    expect(compareAmsgServerVersions('oops', '2.6.0')).toBeNull();
    expect(compareAmsgServerVersions('2.6.0', '')).toBeNull();
  });
});

// 迴歸守衛：門檻值與打 bundle 用的 amsg-server 版本要一起動。
// 門檻高於依賴 → 自己發的 bundle 都過不了門檻，用戶重貼多少次都亮「重新粘貼部署」；
// 門檻低於依賴 → 新版帶的能力（這一波是 next.5 的投影/skip、next.6 的佔位租約，都沒發
// feature flag）在舊部署上靜默缺席，正是這個探測要防的事。真要讓門檻落後於依賴（比如
// 新版只修了無關的 bug、不想逼所有人重貼），改這裡並在註釋裡寫明理由。
describe('設置頁門檻值', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('與 package.json 聲明的 amsg-server 版本一致', () => {
    const floor = /REQUIRED_WORKER_VERSION = '([^']+)'/
      .exec(read('../components/settings/ActiveMsgGlobalSettingsModal.tsx'))?.[1];
    const declared = JSON.parse(read('../package.json'))
      .devDependencies['@rei-standard/amsg-server'];
    expect(floor).toBe(declared);
  });
});
