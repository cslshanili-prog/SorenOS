// utils/amsg2ScheduleRestraint.test.ts
//
// 排程清單的「分寸」迴歸守衛。
//
// 病象：用戶說「今天想看書」，角色排了一條晚上問進度的任務，之後每一輪聊天結尾都補
// 一句「書看到哪了」；早上問過一次早飯沒得到回應，接著一路問喝水吃飯。根因不在人設
// 太愛操心——排程清單每輪全量注入、帶著 promptHint 原文，還貼在整段 prompt 的最後
// 一句，模型於是把一件排在今晚的事讀成了本輪就該辦的事。
//
// 同倉庫裡每輪全量注入的塊（便利貼、用藥提醒、Notion 筆記）早就各配了「不必每次都提」
// 的分寸句，排程清單是漏掉的那一個。這份文件釘三樣，任何一樣塌了都不會報錯，只會表現
// 成「角色又開始每輪催了」：
//   · 兩處清單（平時聊天那份 / 到點那份）都帶上「還沒到點就別提前開口」；
//   · 兩處說的是同一句話——各寫各的遲早漂成兩套詞，模型會當成兩回事；
//   · 清單塊插在易變尾段之前，「回到你自己」鋼印還是模型開口前的最後一眼。

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// amsg2TaskContext 頂層拉了 DB / 台帳，純 Node 環境裡跑不起來；這裡只測拼文案。
vi.mock('./db', () => ({ DB: { getRecentMessagesByCharId: vi.fn() } }));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    upsertExpiredNotices: vi.fn().mockResolvedValue([]),
    getExpiredNotices: vi.fn().mockResolvedValue([]),
  },
}));

import { AMSG2_SCHEDULE_NOT_YET_NOTE, buildFireTaskListBlock } from './amsg2Tasks';
import { buildAmsg2TaskContextText, insertAmsg2TaskContextBlock } from './amsg2TaskContext';
import type { ActiveMsg2TaskRecord } from '../types';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const H = 3600_000;
/** 就是那條惹禍的任務：今晚問問書看到哪了。 */
const bookTask = (over: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'prompted',
  firstSendTime: new Date(Date.now() + 8 * H).toISOString(),
  recurrenceType: 'none',
  promptHint: '問問書看到哪了',
  expirePolicy: 'expire',
  source: 'character',
  status: 'scheduled',
  createdAt: Date.now(),
  ...over,
});

describe('排程清單不該被當成本輪待辦', () => {
  it('平時聊天：有任務時清單帶上「還沒到點別提前開口」', () => {
    const text = buildAmsg2TaskContextText([bookTask()], [], Date.now(), undefined);
    // promptHint 照舊給全：改期、取消、判斷「已經排著相近的一條」都要靠它，
    // 藏起來是把能力和病症一起砍了。要管的是模型怎麼讀它，不是讓它看不見。
    expect(text).toContain('問問書看到哪了');
    expect(text).toContain(AMSG2_SCHEDULE_NOT_YET_NOTE);
  });

  it('一條都沒排時不提這句：沒有可催的事，白說一遍反而勾著', () => {
    const text = buildAmsg2TaskContextText([], [], Date.now(), undefined);
    expect(text).not.toContain(AMSG2_SCHEDULE_NOT_YET_NOTE);
    // 常駐簡介照舊在（角色得隨時知道自己能排），只是不該順帶提醒「催」這件事存在
    expect(text).toContain('schedule_active_message');
  });

  it('到點那份清單同樣帶這句：正在發的是這條，別順手把沒到點的幾條一起催了', () => {
    const block = buildFireTaskListBlock([bookTask()], {
      nowMs: Date.now(),
      tzId: 'Asia/Shanghai',
    });
    expect(block).toContain(AMSG2_SCHEDULE_NOT_YET_NOTE);
  });

  it('兩處引用同一個常量，不是各寫各的字面量', () => {
    const ctxSrc = read('./amsg2TaskContext.ts');
    const tasksSrc = read('./amsg2Tasks.ts');
    expect(ctxSrc).toContain('AMSG2_SCHEDULE_NOT_YET_NOTE');
    expect(tasksSrc).toContain('AMSG2_SCHEDULE_NOT_YET_NOTE');
    // 正文只該在常量定義那一處出現；哪邊現抄一份，兩處的詞遲早對不上
    const literal = '不用你現在提前替它開口';
    expect((ctxSrc.match(new RegExp(literal, 'g')) ?? []).length).toBe(0);
    expect((tasksSrc.match(new RegExp(literal, 'g')) ?? []).length).toBe(1);
  });
});

describe('排程塊的位置：鋼印要留住最後一眼', () => {
  const block = { role: 'system', content: '【你的主動消息排程·僅你可見】…' };

  it('插在易變尾段之前，「回到你自己」還是最後一條', () => {
    const messages = [
      { role: 'system', content: '穩定前綴' },
      { role: 'user', content: '在嗎' },
      { role: 'system', content: '易變尾段…### 最後，回到你自己' },
    ];
    const out = insertAmsg2TaskContextBlock(messages, block, 2);
    expect(out.map((m) => m.content)).toEqual([
      '穩定前綴',
      '在嗎',
      block.content,
      '易變尾段…### 最後，回到你自己',
    ]);
    expect(out[out.length - 1].content).toContain('回到你自己');
  });

  it('工具循環裡下標照用：前綴沒動，塊仍落在尾段之前而不是 tool 結果後面', () => {
    const loopMessages = [
      { role: 'system', content: '穩定前綴' },
      { role: 'user', content: '在嗎' },
      { role: 'system', content: '易變尾段' },
      { role: 'assistant', content: '(tool_calls)' },
      { role: 'tool', content: '已創建' },
    ];
    const out = insertAmsg2TaskContextBlock(loopMessages, block, 2);
    expect(out[2].content).toBe(block.content);
    expect(out[3].content).toBe('易變尾段');
    expect(out).toHaveLength(6);
  });

  it('拿不到尾段下標時退回貼尾：位置不理想，但塊本身不能丟', () => {
    // 丟了的話角色不知道自己名下掛著什麼，同一件事會被重複排。
    const messages = [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }];
    for (const idx of [-1, 99]) {
      const out = insertAmsg2TaskContextBlock(messages, block, idx);
      expect(out[out.length - 1].content).toBe(block.content);
      expect(out).toHaveLength(3);
    }
  });

  it('useChatAI 不再把排程塊貼在數組尾巴上', () => {
    const src = read('../hooks/useChatAI.ts');
    expect(src).toContain('insertAmsg2TaskContextBlock(messages, block, payload.volatileTailIndex)');
    // 舊寫法：return [...messages, { role: 'system', content: text }]
    expect(src).not.toMatch(/\[\s*\.\.\.messages,\s*\{\s*role:\s*'system',\s*content:\s*text\s*\}\s*\]/);
  });
});
