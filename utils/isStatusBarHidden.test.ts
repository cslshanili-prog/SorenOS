import { describe, it, expect } from 'vitest';
import { isStatusBarHidden, resolveStatusBarMode } from './iosStandalone';

// 頂部時鐘/電量條顯隱的取值邏輯：外觀開關顯式值優先，沒設過時跟隨平台默認。
// 平台默認作為第二參注入，讓用例不依賴運行環境（jsdom 非 standalone）。
describe('isStatusBarHidden', () => {
  // 迴歸守衛：必須用 ?? 而非 ||。顯式 false（用戶主動要顯示）絕不能被平台默認 true 蓋掉，
  // 否則 iOS 用戶在外觀裡關掉開關想看 SullyOS 時鐘，卻仍被強制隱藏。舊的錯誤行為（||）會讓本用例掛。
  it('顯式 false 壓過平台默認 true', () => {
    expect(isStatusBarHidden(false, true)).toBe(false);
  });

  it('顯式 true 隱藏，與平台默認無關', () => {
    expect(isStatusBarHidden(true, false)).toBe(true);
  });

  it('沒設過(undefined) 跟隨平台默認', () => {
    expect(isStatusBarHidden(undefined, true)).toBe(true);
    expect(isStatusBarHidden(undefined, false)).toBe(false);
  });
});

describe('resolveStatusBarMode', () => {
  it('新三檔設置優先於舊開關', () => {
    expect(resolveStatusBarMode('compact', true, true)).toBe('compact');
    expect(resolveStatusBarMode('standard', true, true)).toBe('standard');
    expect(resolveStatusBarMode('hidden', false, false)).toBe('hidden');
  });

  it('舊存檔繼續讀取 hideStatusBar', () => {
    expect(resolveStatusBarMode(undefined, true, false)).toBe('hidden');
    expect(resolveStatusBarMode(undefined, false, true)).toBe('standard');
  });

  it('從未設置時沿用平台默認', () => {
    expect(resolveStatusBarMode(undefined, undefined, true)).toBe('hidden');
    expect(resolveStatusBarMode(undefined, undefined, false)).toBe('standard');
  });
});
