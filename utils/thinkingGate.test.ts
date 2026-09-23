// utils/thinkingGate.test.ts
// 「思考鏈 + 工具」能不能同時發給後端。
//
// Gemini 兼容層收到 thinking/reasoning 參數 + tools 會直接 400 INVALID_ARGUMENT，
// 所以既有的小程序/MCP 工具模式一律讓思考鏈讓步（用戶是主動進那個模式的，臨時讓步）。
// 但主動消息 2.0 的工具是「配了 worker 就常駐」的——把它也算進工具模式，等於讓所有配過
// worker 的角色永久失去思考鏈，這個代價比 400 還大。所以只對真會打回的渠道讓步。
import { describe, it, expect } from 'vitest';

import { shouldSendThinkingParams } from './thinkingGate';

const base = {
  thinkingActive: true,
  legacyToolModeActive: false,
  amsg2ToolsInjected: false,
  model: 'claude-sonnet-5',
};

describe('shouldSendThinkingParams', () => {
  it('沒開思考鏈 → 什麼都不帶', () => {
    expect(shouldSendThinkingParams({ ...base, thinkingActive: false })).toBe(false);
  });

  it('開了思考鏈、沒有任何工具 → 照常帶', () => {
    expect(shouldSendThinkingParams(base)).toBe(true);
  });

  it('小程序/MCP 工具模式 → 思考鏈讓步（既有行為不迴歸）', () => {
    expect(shouldSendThinkingParams({ ...base, legacyToolModeActive: true })).toBe(false);
  });

  it('工具模式讓步與渠道無關（Claude 也讓）', () => {
    expect(shouldSendThinkingParams({
      ...base, legacyToolModeActive: true, model: 'claude-opus-5',
    })).toBe(false);
  });

  it('amsg2 工具 + Gemini → 讓步，避免 400 INVALID_ARGUMENT', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'gemini-2.5-pro',
    })).toBe(false);
  });

  it('amsg2 工具 + Claude → 照常帶（thinking+tools 是官方支持組合，不能誤傷）', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'claude-sonnet-5',
    })).toBe(true);
  });

  it('amsg2 工具 + OpenAI 系 → 照常帶', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'o3-mini',
    })).toBe(true);
  });

  it('渠道名大小寫/前綴混寫也能認出 Gemini（中轉常帶前綴）', () => {
    expect(shouldSendThinkingParams({
      ...base, amsg2ToolsInjected: true, model: 'google/Gemini-2.0-Flash',
    })).toBe(false);
  });

  it('沒注入 amsg2 工具時，Gemini 的思考鏈不受影響', () => {
    expect(shouldSendThinkingParams({ ...base, model: 'gemini-2.5-pro' })).toBe(true);
  });
});
