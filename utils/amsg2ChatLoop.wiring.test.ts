// 聊天工具循環裡「角色看得到什麼排程」的接線守衛。
//
// 倉庫的 vitest 是純 Node 環境（沒裝 jsdom），useChatAI 是個綁死 React 的大 hook，
// 跑不起來測行為，所以沿用 activeMsgClient.wiring.test.ts 的做法做**源碼級**斷言。
// 它驗證不了運行時時序，只防「接線被誤刪/改回去」這一種迴歸。
//
// 釘的是同一件事的兩半：
//   1. 工具循環的第二輪起，請求體不能從「加排程塊之前」的那份消息重新起步；
//   2. 排程塊要每輪現算貼末尾，而不是把首輪那份舊快照一路帶下去。
// 兩半都塌的時候，角色剛排完任務、下一輪看到的清單卻是空的，於是把同一條再排一遍
// ——現場表現就是一句「等會找我」排出 5 條一模一樣的任務。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)),
  'utf8',
);

describe('排程現狀塊每輪現算', () => {
  it('有一個統一的貼塊入口，而不是散在各處手拼', () => {
    expect(src).toContain('const withAmsg2TaskContext =');
  });

  it('首輪請求也走這個入口（不再把塊寫死進 baseReqBody.messages）', () => {
    // 寫死進 baseReqBody.messages 的話，工具循環裡那份就永遠是排程前的舊清單。
    expect(src).not.toMatch(/baseReqBody\.messages\s*=\s*\[\s*\n?\s*\.\.\.baseReqBody\.messages,\s*\n?\s*\{\s*role:\s*'system',\s*content:\s*taskContext\.text/);
    expect(src).toMatch(/messages:\s*withAmsg2TaskContext\(baseReqBody\.messages\)/);
  });

  it('工具循環的後續請求也現算一次（本輪剛排的任務立刻進清單）', () => {
    // 收尾路徑還要往這份消息裡追加「停止調用工具」，所以先落局部變量再放進 body；
    // 仍必須保證局部變量來自每輪現算，而不是複用首輪舊快照。
    expect(src).toMatch(/const followMessages = withAmsg2TaskContext\(loopMessages\)/);
    expect(src).toMatch(/messages:\s*followMessages/);
  });

  it('本輪新建的任務會被點名，傳進渲染函數', () => {
    expect(src).toContain('amsg2CreatedThisTurn');
    expect(src).toMatch(/buildAmsg2TaskContextText\([\s\S]{0,200}amsg2CreatedThisTurn/);
  });
});

describe('工具循環的消息起點', () => {
  // 三個循環（麥當勞 / 瑞幸 / 通用）都可能執行主動消息 2.0 的排程工具——代碼註釋裡
  // 明寫了「排程工具與點單工具會在同一批 tool_calls 裡出現」，所以三處得一致。
  it('三處 loopMessages 都從 baseReqBody.messages 起步', () => {
    const starts = src.match(/let loopMessages = \[\.\.\.[A-Za-z.]+\]/g) ?? [];
    expect(starts.length).toBe(3);
    for (const line of starts) {
      expect(line).toContain('baseReqBody.messages');
    }
  });

  it('MCP 正文兜底那條也一樣', () => {
    expect(src).toMatch(/textLoopMessages = \[\.\.\.baseReqBody\.messages\]/);
  });
});
