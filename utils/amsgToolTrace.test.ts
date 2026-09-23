// utils/amsgToolTrace.test.ts
// 雲端工具痕跡 → 氣泡底下那行灰字。worker 傳回來的是原始工具名 + 次數，翻譯成人話
// 全在這一份裡做，所以這裡釘的都是「用戶最後讀到的是什麼」。
import { describe, it, expect } from 'vitest';

import { formatAmsgToolTrace } from './amsgToolTrace';

describe('formatAmsgToolTrace', () => {
  it('內置工具說人話，不是把 web_search 這種內部名字甩給用戶', () => {
    expect(formatAmsgToolTrace([{ name: 'web_search', count: 1 }])).toBe('搜索網頁');
    expect(formatAmsgToolTrace([{ name: 'recall', count: 1 }])).toBe('讀取記憶');
  });

  it('跑了幾次就寫幾次，跑一次的不寫 ×1', () => {
    expect(formatAmsgToolTrace([
      { name: 'web_search', count: 2 },
      { name: 'recall', count: 1 },
    ])).toBe('搜索網頁 ×2 · 讀取記憶');
  });

  // 小紅書那幾個工具（搜索 / 刷首頁 / 點開一條）在用戶眼裡是同一件事。分開寫就成了
  // 「讀取小紅書 · 讀取小紅書」，像是渲染出了 bug。
  it('說法一樣的幾個工具合併計次', () => {
    expect(formatAmsgToolTrace([
      { name: 'xhs_search', count: 1 },
      { name: 'xhs_detail', count: 2 },
    ])).toBe('讀取小紅書 ×3');
  });

  // MCP 工具是用戶自己接進來的，只有他知道那是幹嘛的，不編說法。前綴是內部拿來分流的，
  // 露給用戶看就跟他在設置裡填的名字對不上號了。
  it('MCP 工具剝掉內部前綴，用用戶自己配的那個名字', () => {
    expect(formatAmsgToolTrace([{ name: 'mcp__get_weather', count: 1 }]))
      .toBe('get_weather');
  });

  it('沒見過的工具名原樣顯示（寧可露個英文名，也別編一個說法）', () => {
    expect(formatAmsgToolTrace([{ name: 'brand_new_tool', count: 1 }]))
      .toBe('brand_new_tool');
  });

  // 這份數據是 worker 隨推送捎回來的，老版本 worker 壓根不帶、字段也可能是別的形狀。
  // 寧可這一行不畫，也別在氣泡底下渲染出 [object Object]。
  it.each([
    ['不是數組', 'web_search'],
    ['沒有這個字段', undefined],
    ['空數組', []],
    ['條目沒名字', [{ count: 3 }]],
    ['名字不是字符串', [{ name: 42, count: 1 }]],
    ['名字是空白', [{ name: '   ', count: 1 }]],
  ])('形狀不對就整行不畫：%s', (_label, raw) => {
    expect(formatAmsgToolTrace(raw)).toBe('');
  });

  it('次數缺了 / 是垃圾值時按跑過一次算，不寫 ×NaN', () => {
    expect(formatAmsgToolTrace([{ name: 'recall' }])).toBe('讀取記憶');
    expect(formatAmsgToolTrace([{ name: 'recall', count: 'abc' }])).toBe('讀取記憶');
    expect(formatAmsgToolTrace([{ name: 'recall', count: -3 }])).toBe('讀取記憶');
  });

  it('好條目和壞條目混在一起時，壞的丟掉、好的照畫', () => {
    expect(formatAmsgToolTrace([
      { name: 'web_search', count: 2 },
      { name: '', count: 9 },
      null,
      { name: 'recall', count: 1 },
    ])).toBe('搜索網頁 ×2 · 讀取記憶');
  });
});
