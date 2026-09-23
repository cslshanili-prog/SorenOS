import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendInstantTraceEntry,
  formatInstantTraceLog,
  readAllInstantTraces,
  readRecentInstantTraces,
} from './instantTraceLog';

// 這個緩衝存在的意義是「隔著屏幕把現場交出來」：遠端用戶手上沒有 DevTools（iOS 裝成
// PWA 更是一點轍都沒有），出事之後唯一能拿到的證據就是它。面板上只顯示得下最近幾條，
// 所以下面釘的兩件事都是導出這條路的命門：
//   1. 全量讀到的必須比面板顯示的多——否則「複製全部」複製的還是屏幕上那幾行；
//   2. 一條都沒有時返回空串——調用方據此不動作，不能讓用戶複製到一份空殼還以為成了。

const TRACE_LOG_KEY = 'instant_push_trace_log_v1';

describe('instantTraceLog 導出', () => {
  beforeEach(() => {
    localStorage.removeItem(TRACE_LOG_KEY);
  });

  it('全量讀拿得到面板顯示不下的那些（導出的是現場，不是屏幕上那幾行）', () => {
    for (let i = 0; i < 20; i++) {
      appendInstantTraceEntry({ ts: new Date(i).toISOString(), event: `e${i}` });
    }

    expect(readRecentInstantTraces(5)).toHaveLength(5);
    expect(readAllInstantTraces()).toHaveLength(20);
    // 最新的排最前，兩個讀口同一個順序口徑。
    expect(readAllInstantTraces()[0].event).toBe('e19');
  });

  it('導出文本能解析回來，帶著構建版本和全部條目', () => {
    appendInstantTraceEntry({ ts: '2026-08-20T01:32:00.000Z', event: 'runtime-expire-decision-swallow', anchorMs: 1 });
    appendInstantTraceEntry({ ts: '2026-08-20T01:33:00.000Z', event: 'runtime-flush-start' });

    const parsed = JSON.parse(formatInstantTraceLog());
    expect(parsed.count).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    // 同一段 trace 在新舊構建上含義可能不同，不知道是哪個構建打的就只能靠猜。
    expect(typeof parsed.build).toBe('string');
    expect(parsed.build.length).toBeGreaterThan(0);
    expect(typeof parsed.appVersion).toBe('string');
    expect(parsed.entries[0].event).toBe('runtime-flush-start');
  });

  it('一條都沒有時返回空串（調用方據此不動作，不給用戶一份空殼）', () => {
    expect(formatInstantTraceLog()).toBe('');
  });
});
