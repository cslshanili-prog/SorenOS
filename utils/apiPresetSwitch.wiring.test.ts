// 「設置 → API 預設」這塊的接線守衛。
//
// 倉庫的 vitest 跑在純 Node 環境（組件測試沒裝 testing-library），所以沿用
// amsg2CharToggle.wiring.test.ts 的做法做**源碼級**斷言。驗證不了運行時時序，
// 只防下面這幾種迴歸——它們的共同點是全都不報錯、界面上也看不出來：
//
//   1. 草稿同步 effect 又拿整個 apiConfig 當依賴
//      → 在識圖 / 語音那塊點一下保存，主 API 這邊沒保存的輸入被悄悄衝回舊值
//   2. 保存按鈕又順手覆蓋「選中的」預設
//      → 上一條衝回來的舊值被寫進預設，那條預設從此永久壞掉，只能刪了重建
//   3. 點預設繞開 commitApiConfig 自己寫配置
//      → 聊天換了 API，後台已排程的主動消息還拿舊 Key 打請求，到點一片 401
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const settings = readFileSync(fileURLToPath(new URL('../apps/Settings.tsx', import.meta.url)), 'utf8');

/** 截出某個頂層箭頭函數的函數體（這些函數在文件裡都是兩空格縮進 + `};` 收尾）。 */
const bodyOf = (name: string): string => {
  const start = settings.indexOf(`const ${name} = `);
  expect(start, `${name} 沒找到`).toBeGreaterThan(-1);
  const end = settings.indexOf('\n  };', start);
  expect(end, `${name} 的函數體沒收尾`).toBeGreaterThan(start);
  return settings.slice(start, end);
};

describe('草稿同步不跨區塊打架', () => {
  it('同步 effect 不以整個 apiConfig 對象為依賴', () => {
    // updateApiConfig 每次都返回新對象。整個對象當依賴 = 任何一處保存都會重置所有輸入框。
    expect(settings).not.toMatch(/\}, \[apiConfig\]\);/);
  });

  it('主 API 那份只盯自己的五個字段', () => {
    expect(settings).toMatch(
      /\}, \[apiConfig\.baseUrl, apiConfig\.apiKey, apiConfig\.model, apiConfig\.stream, apiConfig\.temperature\]\);/,
    );
  });
});

describe('點預設 = 直接切過去', () => {
  it('預設名按鈕走 applyPreset，不是「載入草稿」', () => {
    expect(settings).toMatch(/onClick=\{\(\) => applyPreset\(preset\)\}/);
    expect(settings).not.toMatch(/loadPreset/);
  });

  it('切換走 commitApiConfig，不自己調 updateApiConfig（否則漏掉憑據同步）', () => {
    const applyPreset = bodyOf('applyPreset');
    expect(applyPreset).toMatch(/commitApiConfig\(configFromPreset\(preset\)\)/);
    expect(applyPreset).not.toMatch(/updateApiConfig\(/);
  });

  it('高亮的是「當前生效的那條」，按已保存配置反查', () => {
    expect(settings).toMatch(/activePresetId = useMemo\(\s*\(\) => findActivePresetId\(apiPresets, apiConfig\)/);
  });
});

describe('保存配置不反寫預設', () => {
  it('handleSaveApi 只改當前配置', () => {
    const handleSaveApi = bodyOf('handleSaveApi');
    expect(handleSaveApi).toMatch(/commitApiConfig\(nextConfig\)/);
    expect(handleSaveApi).not.toMatch(/updateApiPreset/);
  });

  it('改預設只有編輯彈窗這一個入口', () => {
    expect(settings.match(/updateApiPreset\(/g) ?? []).toHaveLength(1);
    expect(bodyOf('handleUpdatePreset')).toMatch(/updateApiPreset\(preset\.id, name, nextConfig\)/);
  });

  it('改的正好是在用的那條時，當前配置一起跟著走', () => {
    const handleUpdatePreset = bodyOf('handleUpdatePreset');
    // wasActive 必須在 updateApiPreset 之前算好：改完值就對不上了，反查會落空
    expect(handleUpdatePreset).toMatch(
      /const wasActive = activePresetId === preset\.id;[\s\S]*updateApiPreset\(/,
    );
    expect(handleUpdatePreset).toMatch(/if \(wasActive\) commitApiConfig\(/);
  });

  it('鉛筆編輯會讀取並保存每條預設自己的流式與溫度', () => {
    const openEditPreset = bodyOf('openEditPreset');
    const handleUpdatePreset = bodyOf('handleUpdatePreset');

    // 正在使用的那條優先拿主表單值：改完高級設置後，點鉛筆再保存就能真正寫回預設。
    expect(openEditPreset).toMatch(/const isActive = activePresetId === preset\.id/);
    expect(openEditPreset).toMatch(/setEditPresetStream\([\s\S]*isActive \? localStream/);
    expect(openEditPreset).toMatch(/setEditPresetTemperature\([\s\S]*isActive[\s\S]*localTemperature/);
    // 非當前預設仍讀自己的值，不能被當前 API 的高級設置覆蓋。
    expect(openEditPreset).toMatch(/typeof preset\.config\.stream === 'boolean'/);
    expect(openEditPreset).toMatch(/setEditPresetTemperature\([\s\S]*preset\.config\.temperature/);
    expect(handleUpdatePreset).toMatch(/stream:\s*editPresetStream/);
    expect(handleUpdatePreset).toMatch(/temperature:\s*editPresetTemperature/);
  });

  it('用當前配置填入時不會漏掉高級設置', () => {
    expect(settings).toMatch(/setEditPresetStream\(localStream\)/);
    expect(settings).toMatch(/setEditPresetTemperature\(localTemperature\)/);
    expect(settings).toMatch(/aria-pressed=\{editPresetStream\}/);
    expect(settings).toMatch(/value=\{editPresetTemperature\}/);
  });
});

describe('換 API 一定連著換雲端憑據', () => {
  it('commitApiConfig 裡三件事齊全', () => {
    const commitApiConfig = bodyOf('commitApiConfig');
    expect(commitApiConfig).toMatch(/updateApiConfig\(patch\)/);
    expect(commitApiConfig).toMatch(/syncAmsgLlmCredentials\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
    expect(commitApiConfig).toMatch(/refreshApiCredentialsForPendingTasks\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
  });
});
