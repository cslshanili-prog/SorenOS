// 角色級開關「面板顯示的」和「實際生效的」必須是同一個答案的接線守衛。
//
// 倉庫的 vitest 是純 Node 環境（沒裝 jsdom），設置面板是 React 組件跑不起來測行為，
// 所以沿用 amsg2ChatLoop.wiring.test.ts 的做法做**源碼級**斷言。它驗證不了運行時時序，
// 只防「兩處各寫各的三元」這一種迴歸。
//
// 為什麼值得釘：這兩處一旦分家，症狀是純界面的、不報錯也不崩——面板顯示「關」、
// 任務列表和新建表單整塊藏起來，角色卻在聊天裡照樣拿得到 schedule_active_message
// 並真的排出任務來。用戶看到的是「我沒開過它怎麼給我發消息」，翻代碼前根本對不上。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const modal = read('../components/chat/ActiveMsg2SettingsModal.tsx');
const chatAI = read('../hooks/useChatAI.ts');
const tasks = read('./amsg2Tasks.ts');

describe('角色級開關只有一處判定', () => {
  it('判定本身是「面板裡開過才算開」', () => {
    // 默認值的方向寫在這裡：config 缺失 = 用戶沒表過態 = 關。
    expect(tasks).toMatch(/isAmsg2EnabledForChar[\s\S]{0,120}activeMsg2Config\?\.enabled === true/);
  });

  it('面板的開關初值走這個判定', () => {
    expect(modal).toMatch(/useState\(\(\) => isAmsg2EnabledForChar\(char\)\)/);
  });

  it('面板打開時的表單重置也走這個判定，不自己寫三元', () => {
    // 這一條是真出過問題的那處：useState 的初值是對的，重置 effect 卻用
    // `config?.enabled ?? false` 把它蓋掉，於是初值永遠活不過一幀。
    expect(modal).toMatch(/setEnabled\(isAmsg2EnabledForChar\(char\)\)/);
    expect(modal).not.toMatch(/setEnabled\((?!isAmsg2EnabledForChar|!enabled)/);
  });

  it('面板裡沒有繞開判定的裸比較', () => {
    expect(modal).not.toMatch(/enabled\s*(!==|===)\s*false/);
    expect(modal).not.toMatch(/enabled\s*\?\?\s*(true|false)/);
  });

  it('工具注入門走同一個判定', () => {
    expect(chatAI).toMatch(/amsg2ToolsInjected = isAmsg2EnabledForChar\(char\)/);
  });
});
