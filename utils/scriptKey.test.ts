import { describe, expect, it } from 'vitest';
import { anyScriptRegexSource, equalsAnyScript, includesAnyScript, scriptKey } from './scriptKey';

describe('scriptKey', () => {
  it('簡體、繁體折到同一個 key', () => {
    expect(scriptKey('轉帳')).toBe(scriptKey('转账'));
    expect(scriptKey('紀念日')).toBe(scriptKey('纪念日'));
    expect(scriptKey('週日')).toBe(scriptKey('周日'));
  });

  it('帳/賬/帐、臺/台 這幾組分岔的字收成一個', () => {
    expect(scriptKey('帳')).toBe(scriptKey('賬'));
    expect(scriptKey('帐')).toBe(scriptKey('账'));
    expect(scriptKey('臺詞')).toBe(scriptKey('台詞'));
  });

  it('非中文原樣保留', () => {
    expect(scriptKey('abc 123 😀')).toBe('abc 123 😀');
    expect(scriptKey('')).toBe('');
  });

  it('includes / equals 簡繁都認', () => {
    expect(includesAnyScript('用戶已登錄小紅書', '已登录')).toBe(true);
    expect(includesAnyScript('用户已登录', '已登錄')).toBe(true);
    expect(includesAnyScript('尚未登入', '已登录')).toBe(false);
    expect(equalsAnyScript('新的協同', '新的协同')).toBe(true);
    expect(equalsAnyScript('新的協同', '新的')).toBe(false);
  });
});

describe('anyScriptRegexSource', () => {
  it('中文標籤簡繁都能匹配，其餘字元不動', () => {
    const re = new RegExp(`<${anyScriptRegexSource('終本')}>([^<]*)</${anyScriptRegexSource('終本')}>`);
    expect(re.exec('<終本>a</終本>')?.[1]).toBe('a');
    expect(re.exec('<终本>b</终本>')?.[1]).toBe('b');
    expect(anyScriptRegexSource('abc')).toBe('abc');
  });
});
