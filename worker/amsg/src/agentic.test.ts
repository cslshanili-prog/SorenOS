/**
 * amsg worker v2 服務端工具循環 — 決策純邏輯迴歸測試。
 *
 * 釘住的行為：
 *  1. finish 分段與客戶端氣泡同一份（sanitizeIntoSegments：按換行切，
 *     [[...]] / [html] 等標籤塊保持原子）；push 業務字段形狀與 v1 一致，另掛
 *     notification.body = 淨化文本給 OS banner；
 *  2. 數據標籤 → tool-request，旁白與旁白裡的副作用跨輪累積、finish 時一起出；
 *  3. 副作用標籤 → 結構化 directives 只掛最後一條 push（收側 isLastChunk 守衛依賴這一點）；
 *  4. 全程無正文：無副作用 → skip-push，有副作用 → 單條空正文 push 攜帶 directives。
 */

import { describe, expect, it } from 'vitest';
import {
  buildXhsSessionPayload,
  classifyNativeToolCalls,
  createFireSessionState,
  DEFAULT_TOOL_ITERATIONS,
  MCP_MAX_TOOL_ITERATIONS,
  resolveToolIterationBudget,
  processLLMRound,
  type PushBuildInput,
} from './agentic';
import { buildMcpNameMap, type McpFireServer } from '../../../utils/mcpFireCore';
import {
  AMSG_FIRE_CANCEL_TOOL,
  AMSG_FIRE_SCHEDULE_TOOL,
} from '../../../utils/amsgFireSchedule';
import type { XhsNote } from '../../../utils/realtimeContext';

const build: PushBuildInput = {
  contactName: '小鹿',
  avatarUrl: 'https://example.com/a.png',
  taskId: '42',
  messageType: 'auto',
  metadata: { charId: 'char-1', amsgMode: 'auto' },
  occurrenceMs: Date.UTC(2026, 6, 21, 1, 0),
};

describe('processLLMRound — 純文本 finish', () => {
  it('按換行分段成多條 scheduled push，業務字段形狀與 v1 一致 + notification banner', () => {
    const state = createFireSessionState();
    const decision = processLLMRound(state, '想你了。\n快回消息！', build);

    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[0]).toEqual({
      messageKind: 'content',
      messageType: 'auto',
      source: 'scheduled',
      message: '想你了。',
      title: '來自 小鹿',
      contactName: '小鹿',
      avatarUrl: 'https://example.com/a.png',
      messageSubtype: 'chat',
      taskId: '42',
      // 每條 push 都帶觸發時刻——客戶端兜底閘的循環判定與吞放緩存鍵都靠它。
      metadata: { charId: 'char-1', amsgMode: 'auto', amsgOccurrenceMs: build.occurrenceMs },
      notification: { title: '來自 小鹿', body: '想你了。' },
    });
    // 無副作用時 metadata 原樣透傳，不額外掛 directives 鍵。
    expect((decision.pushPayloads[1].metadata as any).directives).toBeUndefined();
  });

  it('同一行多句不拆 — 氣泡結構跟隨 LLM 的換行意圖（與客戶端 chunkText 一致）', () => {
    const decision = processLLMRound(createFireSessionState(), '想你了。快回消息！', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads.map((p) => p.message)).toEqual(['想你了。快回消息！']);
  });

  // 標籤用 SEND_EMOJI 這種約定好的：模型現編的標籤（`[[分享卡: …]]`）獨佔一段時會被
  // sanitize 整段丟掉，那是「橫幅響了、點進去 0 氣泡」那條規則，跟這裡驗的劈碎無關。
  it('迴歸：[[...]] 標籤內的句讀不再把標籤劈碎（曾把「]]」拼進下一條消息）', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '看到個熱搜。\n[[SEND_EMOJI: 官宣了！速看]]',
      build,
    );
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads.map((p) => p.message)).toEqual([
      '看到個熱搜。',
      '[[SEND_EMOJI: 官宣了！速看]]',
    ]);
  });

  it('SEND_EMOJI 獨立成段：message 保留原始標籤給客戶端渲染，banner 顯示可讀形態', () => {
    const decision = processLLMRound(createFireSessionState(), '想你了\n[[SEND_EMOJI: 抱抱]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[1].message).toBe('[[SEND_EMOJI: 抱抱]]');
    expect((decision.pushPayloads[1].notification as any).body).toBe('[表情：抱抱]');
  });

  it('空輸出且無累積 → skip-push', () => {
    const decision = processLLMRound(createFireSessionState(), '', build);
    expect(decision.decision).toBe('skip-push');
  });
});

describe('processLLMRound — 數據標籤 tool-request 與跨輪累積', () => {
  it('RECALL 標籤 → tool-request，旁白暫存；下一輪 finish 時旁白排在正文前', () => {
    const state = createFireSessionState();

    const round1 = processLLMRound(state, '等等，我想想上個月的事。[[RECALL: 2026-06]]', build);
    expect(round1.decision).toBe('tool-request');
    if (round1.decision !== 'tool-request') return;
    expect(round1.toolCalls).toHaveLength(1);
    expect(round1.toolCalls[0].function.name).toBe('recall');
    expect(JSON.parse(round1.toolCalls[0].function.arguments)).toEqual({ year: '2026', month: '06' });
    expect(state.narrations).toEqual(['等等，我想想上個月的事。']);

    const round2 = processLLMRound(state, '想起來了，那天的落日超好看！', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    expect(round2.pushPayloads.map((p) => p.message)).toEqual([
      '等等，我想想上個月的事。',
      '想起來了，那天的落日超好看！',
    ]);
  });

  it('tool-request 輪旁白裡的副作用標籤也被結構化累積，finish 時掛上', () => {
    const state = createFireSessionState();

    const round1 = processLLMRound(state, '[[ACTION:POKE]]在嗎在嗎。[[SEARCH: 今晚 流星雨]]', build);
    expect(round1.decision).toBe('tool-request');
    // 旁白存原始文本（副作用標籤保留），finish 時拼回全文統一掃。
    expect(state.narrations).toEqual(['[[ACTION:POKE]]在嗎在嗎。']);

    const round2 = processLLMRound(state, '今晚十點有流星雨！[[ACTION:ADD_EVENT|看流星雨|今晚10點]]', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([
      { type: 'poke' },
      { type: 'add_event', title: '看流星雨', date: '今晚10點' },
    ]);
    // 非最後一條不掛 directives（客戶端只在 isLastChunk 時 replay 一次）。
    for (const p of round2.pushPayloads.slice(0, -1)) {
      expect((p.metadata as any).directives).toBeUndefined();
    }
    // 副作用標籤已從正文剝掉。
    for (const p of round2.pushPayloads) {
      expect(String(p.message)).not.toContain('[[ACTION');
    }
  });
});

// 迴歸守衛：`[[MUSIC_ACTION:add|歌單標題]]` 裡只有歌單名，沒有歌名。客戶端重放時若只能
// 取「用戶此刻在聽的那首」，定時消息補收的那一刻用戶多半什麼都沒在放 —— 正文聊著這首歌，
// 卡片和加歌單卻整個沒發生。所以到點渲染「你此刻在聽：《X》」時順手把 X 凍進 directive。
describe('processLLMRound — MUSIC_ACTION 凍結這次在聽的那首歌', () => {
  const song = { id: 33, name: '夜航星', artists: '某某' };
  const withSong: PushBuildInput = { ...build, sceneSong: song };

  const directivesOf = (decision: ReturnType<typeof processLLMRound>) => {
    if (decision.decision !== 'finish') return undefined;
    const last = decision.pushPayloads[decision.pushPayloads.length - 1];
    return (last.metadata as any).directives;
  };

  it('這次渲染挑了歌 → music_action 帶上它', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '這首太好聽了，收進歌單。\n[[MUSIC_ACTION:add|深夜]]',
      withSong,
    );
    expect(directivesOf(decision)).toEqual([
      { type: 'music_action', verb: 'add', args: ['深夜'], song },
    ]);
  });

  it('這次沒渲染「此刻在聽」（不在聽歌的時段 / 跨天作廢）→ 不附，客戶端走實時快照那條路', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '這首太好聽了。\n[[MUSIC_ACTION:add|深夜]]',
      { ...build, sceneSong: null },
    );
    expect(directivesOf(decision)).toEqual([
      { type: 'music_action', verb: 'add', args: ['深夜'] },
    ]);
  });

  it('其餘類型的 directive 一概不動', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '戳你一下。\n[[ACTION:POKE]]',
      withSong,
    );
    expect(directivesOf(decision)).toEqual([{ type: 'poke' }]);
  });
});

describe('processLLMRound — 無正文邊界', () => {
  // 空正文的 push 連 banner body 都是空的：用戶鎖屏收到一條只有標題的空橫幅、未讀 +1、
  // 點進去 0 氣泡。所以沒正文就整條不發，副作用一起放棄，兩種成因分開記進 last_skip。
  it('全程只有副作用標籤、沒有正文：整條不發，記 side-effects-only', () => {
    const decision = processLLMRound(createFireSessionState(), '[[ACTION:POKE]]', build);
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.reason).toBe('side-effects-only');
  });

  // 日程改動是「沒正文就整條丟」這條規矩裡的唯一例外：它不是做給用戶看的動作，是角色
  // 在糾正自己的表。一起丟掉的話，下一次 fire 讀到的還是那條舊安排，角色會反覆想改又
  // 反覆改不掉。所以照舊不發推送，但把改動帶出來交給調用方走 emitResult。
  it('只有日程改動、沒有正文：仍然不發推送，但把改動帶出來', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]',
      build,
    );
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.reason).toBe('side-effects-only');
    expect(decision.scheduleChanges).toEqual([{ startTime: '22:00', activity: '陪你聊天' }]);
  });

  it('沒有日程改動時不帶這個字段（別讓調用方對著空數組白跑一趟）', () => {
    const decision = processLLMRound(createFireSessionState(), '[[ACTION:POKE]]', build);
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.scheduleChanges).toBeUndefined();
  });

  it('既沒正文也沒副作用：整條不發，記 empty-generation', () => {
    const decision = processLLMRound(createFireSessionState(), '', build);
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.reason).toBe('empty-generation');
  });

  it('工具輪後 LLM 空輸出：仍沖刷累積旁白，不靜默丟', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我查查。[[SEARCH: 天氣]]', build);
    const round2 = processLLMRound(state, '', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    expect(round2.pushPayloads.map((p) => p.message)).toEqual(['我查查。']);
  });
});

describe('processLLMRound — 副作用標籤塊被數據標籤劈成兩輪（實機迴歸）', () => {
  it('長形態日記寫一半去 RECALL：finish 拼回全文，日記成 directive、裸標籤不漏進 push', () => {
    const state = createFireSessionState();

    // round 1：日記開了頭，中途想查記憶 → 數據標籤把文本劈開。
    const round1 = processLLMRound(
      state,
      '[[DIARY_START: 專屬點讀機 | 傲嬌]]\n今天那傢伙又纏著我。[[RECALL: 2026-06]]',
      build,
    );
    expect(round1.decision).toBe('tool-request');

    // round 2：日記收尾 + 正文。
    const round2 = processLLMRound(state, '……才、才不是想他！\n[[DIARY_END]]\n寫完了，哼。', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;

    // 日記整塊成了 directive（title/mood/跨輪內容都在），掛最後一條 push。
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    const directives = (last.metadata as any).directives;
    expect(directives).toHaveLength(1);
    expect(directives[0].type).toBe('notion_write_diary');
    expect(directives[0].title).toBe('專屬點讀機');
    expect(directives[0].mood).toBe('傲嬌');
    expect(directives[0].content).toContain('今天那傢伙又纏著我。');
    expect(directives[0].content).toContain('……才、才不是想他！');

    // 正文 push 裡不再出現孤立的 DIARY_START / DIARY_END 裸標籤。
    for (const p of round2.pushPayloads) {
      expect(String(p.message)).not.toContain('DIARY_START');
      expect(String(p.message)).not.toContain('DIARY_END');
    }
    expect(round2.pushPayloads.map((p) => p.message)).toContain('寫完了，哼。');
  });

  it('飛書長形態同款劈裂也能拼回', () => {
    const state = createFireSessionState();
    processLLMRound(state, '[[FS_DIARY_START: 今日份|開心]]\n上半段。[[SEARCH: 流星雨]]', build);
    // 末尾這句正文是必要的：日記整塊會被剝成 directive，一句話不留的話這輪沒有可發的
    // 正文，走的是「無正文不發」那條路，驗不到這裡想驗的「跨輪拼回」。
    const round2 = processLLMRound(state, '下半段。\n[[FS_DIARY_END]]\n記好啦。', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    const directives = (last.metadata as any).directives;
    expect(directives?.[0]?.type).toBe('feishu_write_diary');
    expect(directives?.[0]?.content).toContain('上半段。');
    expect(directives?.[0]?.content).toContain('下半段。');
  });
});

// ─── XHS 筆記隨 push 帶回（amsg2 round 1 在 worker 跑，客戶端缺筆記緩衝） ────────

const makeNote = (n: number, descLen = 10): XhsNote => ({
  noteId: `note-${n}`,
  title: `標題${n}`,
  desc: 'd'.repeat(descLen),
  likes: n,
  author: `作者${n}`,
  authorId: `author-${n}`,
  xsecToken: `tok-${n}`,
  coverUrl: `https://img.example.com/${n}.jpg`,
});

describe('buildXhsSessionPayload — 按 directive 引用挑選最小數據包', () => {
  const notes = [makeNote(1), makeNote(2), makeNote(3)];

  it('xhs_share 的 idx（1-based）→ 對應筆記；未引用的不帶', () => {
    const payload = buildXhsSessionPayload([{ type: 'xhs_share', idx: 2 }], notes, []);
    expect(payload).not.toBeNull();
    expect(payload!.notes).toHaveLength(1);
    expect(payload!.notes[0].idx).toBe(2);
    expect(payload!.notes[0].note.noteId).toBe('note-2');
  });

  it('越界 / 編造的序號取不到筆記 → 跳過；全落空且無 token → null', () => {
    const payload = buildXhsSessionPayload([{ type: 'xhs_share', idx: 14 }], notes, []);
    expect(payload).toBeNull();
  });

  it('desc 截斷到 120 字符（防 web push ~4KB payload 超限）', () => {
    const payload = buildXhsSessionPayload(
      [{ type: 'xhs_share', idx: 1 }],
      [makeNote(1, 500)],
      [],
    );
    expect(payload!.notes[0].note.desc).toHaveLength(120);
    // 原數組的筆記不能被就地改掉（worker 內同 fire 後續還會用）。
    expect(notes[0].desc).toHaveLength(10);
  });

  it('點贊/評論引用的 noteId → 只帶對應 xsecToken', () => {
    const payload = buildXhsSessionPayload(
      [{ type: 'xhs_like', noteId: 'note-3' }],
      notes,
      [['note-1', 'tok-1'], ['note-3', 'tok-3']],
    );
    expect(payload!.notes).toHaveLength(0);
    expect(payload!.xsecTokens).toEqual([['note-3', 'tok-3']]);
  });

  it('無任何 XHS directive → null（poke 等副作用不觸發帶筆記）', () => {
    expect(buildXhsSessionPayload([{ type: 'poke' }], notes, [['note-1', 'tok-1']])).toBeNull();
  });

  // 迴歸守衛：角色說分享了幾張就帶幾張，絕不按張數砍。
  // 砍過的版本會讓用戶看到「說分享了 6 張、只出來 4 張卡」——話和內容對不上。
  // 裝不裝得進一條 push 由 index.ts 的 offloadOversizedPush 按真實字節算，
  // 超出的旁路存 client_state，不是丟內容。
  it('share 引用幾張就帶幾張，不按張數砍', () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => makeNote(n));
    const payload = buildXhsSessionPayload(
      [1, 2, 3, 4, 5, 6].map((idx) => ({ type: 'xhs_share' as const, idx })),
      many,
      [],
    );
    expect(payload!.notes).toHaveLength(6);
  });
});

describe('processLLMRound — metadata.xhsSession 掛載', () => {
  it('share 引用的筆記與 directives 同掛最後一條 push，其餘 push 不掛', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我去逛逛。[[XHS_BROWSE]]', build);
    const round2 = processLLMRound(state, '看到個好玩的！\n[[XHS_SHARE: 1]]', {
      ...build,
      xhsNotes: [makeNote(1)],
      xhsXsecTokens: [['note-1', 'tok-1']],
    });
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([{ type: 'xhs_share', idx: 1 }]);
    expect((last.metadata as any).xhsSession.notes).toEqual([
      { idx: 1, note: makeNote(1) },
    ]);
    for (const p of round2.pushPayloads.slice(0, -1)) {
      expect((p.metadata as any).xhsSession).toBeUndefined();
    }
  });

  // [[XHS_SHARE: n]] 的 n 指的是模型寫這句話時手上那份筆記列表。列表在後面的輪次被
  // 另一次搜索整個換掉之後，還按最終列表解引用就會推錯卡片——正文聊的是露營帖、卡片
  // 推的卻是同一序號的口紅帖，用戶點開一眼假。
  it('說要分享之後列表又被換掉 → 卡片仍取說這句話那一輪的列表', () => {
    const state = createFireSessionState();
    const 露營帖 = [makeNote(1), makeNote(2), makeNote(3)];
    const 口紅帖 = [makeNote(11), makeNote(12), makeNote(13)];

    // 輪 1：先逛一圈，還沒有筆記。
    processLLMRound(state, '我去逛逛。[[XHS_BROWSE]]', build);
    // 輪 2：拿到露營帖列表，說分享第 3 篇，同一輪又去搜別的。
    const round2 = processLLMRound(
      state,
      '這第三個露營帖太可了！[[XHS_SHARE: 3]]\n[[XHS_SEARCH: 口紅]]',
      { ...build, xhsNotes: 露營帖 },
    );
    expect(round2.decision).toBe('tool-request');
    // 輪 3：手上的列表已經被搜索換成口紅帖了，這時候收尾。
    const round3 = processLLMRound(state, '就這些啦。', { ...build, xhsNotes: 口紅帖 });

    expect(round3.decision).toBe('finish');
    if (round3.decision !== 'finish') return;
    const last = round3.pushPayloads[round3.pushPayloads.length - 1];
    expect((last.metadata as any).xhsSession.notes).toEqual([
      { idx: 3, note: makeNote(3) },
    ]);
  });

  it('分享和收尾同一輪（沒換過列表）照舊用最終列表', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我去逛逛。[[XHS_BROWSE]]', build);
    const round2 = processLLMRound(state, '看看這個！\n[[XHS_SHARE: 2]]', {
      ...build,
      xhsNotes: [makeNote(1), makeNote(2)],
    });
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).xhsSession.notes).toEqual([{ idx: 2, note: makeNote(2) }]);
  });

  it('沒有 XHS 引用時 metadata 不多掛 xhsSession 鍵（形狀迴歸）', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '[[ACTION:POKE]]在嗎',
      { ...build, xhsNotes: [makeNote(1)], xhsXsecTokens: [['note-1', 'tok-1']] },
    );
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const last = decision.pushPayloads[decision.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([{ type: 'poke' }]);
    expect((last.metadata as any).xhsSession).toBeUndefined();
  });
});

// 模型卡在同一個工具上出不來時的止損。
//
// 實測過一次最惡劣的情況：提示詞裡寫著「每一輪第一行都要先輸出 [[RECALL: 2026-06]]」，
// 那句話常駐在 system prompt 裡、每輪都在模型眼前，工具結果裡說什麼都蓋不過它——連著
// 五輪都在請求同一個 recall，最後撞上輪次上限拋 AGENTIC_LOOP_EXCEEDED，任務不出清、
// 下一分鐘整條從頭重跑，用戶一個字都收不到。
//
// 打回重複調用只省下網絡請求，止不住這個循環；到閾值直接收尾才行。
describe('processLLMRound — 重複調用到閾值就收尾', () => {
  it('還沒到閾值時照常給下一輪工具機會', () => {
    const state = createFireSessionState();
    state.duplicateToolCalls = 1;
    const decision = processLLMRound(state, '讓我想想。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('tool-request');
  });

  it('到閾值後不再請求工具，直接把已經寫出來的內容發出去', () => {
    const state = createFireSessionState();
    // 前兩輪攢下的旁白
    processLLMRound(state, '讓我想想六月的事。\n[[RECALL: 2026-06]]', build);
    state.duplicateToolCalls = 2;

    const decision = processLLMRound(state, '再查一下。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;

    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text).toContain('讓我想想六月的事');
    // 轉不出去的那個標籤不能漏進正文
    expect(text).not.toContain('RECALL');
  });

  it('之前幾輪的旁白只出現一次，不重複', () => {
    const state = createFireSessionState();
    processLLMRound(state, '就說這一句。\n[[RECALL: 2026-06]]', build);
    state.duplicateToolCalls = 2;
    const decision = processLLMRound(state, '再查一次。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text.match(/就[说說][这這]一句/g)?.length).toBe(1);
  });

  it('卡住時一個字都沒寫出來 → skip-push，不發空消息', () => {
    const state = createFireSessionState();
    state.duplicateToolCalls = 2;
    expect(processLLMRound(state, '[[RECALL: 2026-06]]', build).decision).toBe('skip-push');
  });
});

// 穿透收尾（重複到閾值 / 最後一輪）時，觸發穿透那一輪的旁白是「等我翻翻記錄哈」這種半句：
// 它請求的工具永遠不會跑了，發出去用戶收到的最後一條消息就永遠沒有下文。
describe('processLLMRound — 穿透收尾丟掉懸空的「我去查查」', () => {
  it('觸發穿透那一輪的旁白不進正文，之前幾輪的照發', () => {
    const state = createFireSessionState();
    processLLMRound(state, '今天路過那家店了。\n[[RECALL: 2026-06]]', build);
    state.duplicateToolCalls = 2;

    const decision = processLLMRound(state, '等我翻翻記錄哈。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text).toContain('今天路過那家店了');
    expect(text, '這句後面永遠沒有下文，不能當結尾發出去').not.toContain('等我翻翻記錄哈');
  });

  it('只有這一句半截話可發 → skip-push，寧可不發', () => {
    const state = createFireSessionState();
    state.duplicateToolCalls = 2;
    const decision = processLLMRound(state, '稍等，我查查看。\n[[SEARCH: 天氣]]', build);
    expect(decision.decision).toBe('skip-push');
  });
});

// 上游在最後一輪遇到 tool-request 會直接拋 AGENTIC_LOOP_EXCEEDED：這次攢下的旁白全丟、
// 任務不出清、下一分鐘整條從頭重跑再燒一遍 LLM，而用戶一個字都收不到。
describe('processLLMRound — 最後一輪不再放行工具請求', () => {
  it('最後一輪還想調工具 → 拿之前幾輪的內容收尾', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我想想六月發生了什麼。\n[[RECALL: 2026-06]]', build, null, null, 0);
    processLLMRound(state, '順便看看天氣。\n[[SEARCH: 明天 天氣]]', build, null, null, 1);

    const decision = processLLMRound(
      state, '還得再查一次。\n[[RECALL: 2026-07]]', build, null, null, DEFAULT_TOOL_ITERATIONS - 1);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text).toContain('我想想六月發生了什麼');
    expect(text).toContain('順便看看天氣');
    expect(text).not.toContain('還得再查一次');
    expect(text).not.toContain('RECALL');
  });

  it('倒數第二輪照常給工具機會', () => {
    const decision = processLLMRound(
      createFireSessionState(), '查一下。\n[[SEARCH: 天氣]]', build, null, null, DEFAULT_TOOL_ITERATIONS - 2);
    expect(decision.decision).toBe('tool-request');
  });

  it('不傳輪次（拿不到 ctx.iteration 的老部署）行為不變', () => {
    const decision = processLLMRound(createFireSessionState(), '查一下。\n[[SEARCH: 天氣]]', build);
    expect(decision.decision).toBe('tool-request');
  });
});

describe('工具輪次預算 — 普通任務省成本，MCP 多步任務可繼續', () => {
  it('沒有 MCP 保持 5 輪，有 MCP 放寬到 12 輪', () => {
    expect(resolveToolIterationBudget(false)).toBe(DEFAULT_TOOL_ITERATIONS);
    expect(resolveToolIterationBudget(true)).toBe(MCP_MAX_TOOL_ITERATIONS);
    expect(DEFAULT_TOOL_ITERATIONS).toBe(5);
    expect(MCP_MAX_TOOL_ITERATIONS).toBe(12);
  });

  it('MCP 的第 5 輪仍可繼續，第 12 輪才強制收尾', () => {
    const fifth = processLLMRound(
      createFireSessionState(), '繼續查。\n[[SEARCH: 天氣]]', build, null, null,
      DEFAULT_TOOL_ITERATIONS - 1, MCP_MAX_TOOL_ITERATIONS,
    );
    expect(fifth.decision).toBe('tool-request');

    const last = processLLMRound(
      createFireSessionState(), '再查。\n[[SEARCH: 天氣]]', build, null, null,
      MCP_MAX_TOOL_ITERATIONS - 1, MCP_MAX_TOOL_ITERATIONS,
    );
    expect(last.decision).not.toBe('tool-request');
  });
});

// ─── 通用 MCP 的兩層識別（native tool_calls 優先，正文協議兜底） ────────────────

const mcpSrv: McpFireServer = {
  id: 's1',
  name: '探針',
  url: 'https://probe.example.com',
  tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }],
};
const mcpResolve = buildMcpNameMap([mcpSrv]);
const nativeCall = (args = '{}') => ({
  id: 'call_n1',
  type: 'function' as const,
  function: { name: 'mcp__get_secret', arguments: args },
});

describe('processLLMRound + MCP', () => {
  it('native tool_calls → tool-request 原樣透傳, 正文全文入旁白', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去問問暗號。', build, {
      resolve: mcpResolve,
      nativeToolCalls: [nativeCall('{"who":"小滿"}')],
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeCall('{"who":"小滿"}')]);
    expect(state.narrations.join('')).toContain('我去問問暗號');
  });

  it('第二層：無 native 時識別正文假調用, 名字帶 mcp__ 前綴, 旁白剝淨語法', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去問問暗號。\nget_secret({"who":"小滿"})', build, {
      resolve: mcpResolve,
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');
    expect(JSON.parse(d.toolCalls[0].function.arguments)).toEqual({ who: '小滿' });
    expect(state.narrations.join('')).not.toContain('get_secret(');
  });

  it('模型把帶前綴的名字寫進正文（native 模式掉格式）也認, 不出現雙前綴', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, 'mcp__get_secret({"who":"小滿"})', build, { resolve: mcpResolve });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');
  });

  // 模型經常同一個意圖兩處都寫：native 通道發一份、正文裡再"演"一份。
  // 兩份都入列會把同一個工具跑兩遍（第二次還會被判成重複調用往收尾計數上加），
  // 所以 native 在場時正文那份只剝語法、不入列。
  it('native 與正文同時出現 → 只認 native，正文語法照剝', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去問問。\nget_secret({"who":"小滿"})', build, {
      resolve: mcpResolve,
      nativeToolCalls: [nativeCall('{"who":"小滿"}')],
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeCall('{"who":"小滿"}')]);   // 不重複入列
    expect(state.narrations.join('')).not.toContain('get_secret('); // 語法照剝
  });

  // 合成 id 曾用「已跑過的工具數」做輪間區分度，但重複調用被短路、工具拋錯這兩條路
  // 都不會往 toolCalls 落帳——連著兩輪都會拿到同一個 id，assistant/tool 消息配不上對。
  it('正文合成的 tool_call id 跨輪不重號（輪間沒有工具落帳也不撞）', () => {
    const state = createFireSessionState();
    const r1 = processLLMRound(state, 'get_secret({"who":"甲"})', build, { resolve: mcpResolve });
    const r2 = processLLMRound(state, 'get_secret({"who":"乙"})', build, { resolve: mcpResolve });
    expect(r1.decision).toBe('tool-request');
    expect(r2.decision).toBe('tool-request');
    if (r1.decision !== 'tool-request' || r2.decision !== 'tool-request') return;
    expect(r1.toolCalls[0].id).not.toBe(r2.toolCalls[0].id);
  });

  it('native 與數據標籤同輪 → 合併進同一個 tool-request', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '[[RECALL: 2026-06]]', build, {
      resolve: mcpResolve,
      nativeToolCalls: [nativeCall()],
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    const names = d.toolCalls.map((tc) => tc.function.name);
    expect(names).toContain('recall');
    expect(names).toContain('mcp__get_secret');
  });

  it('無 MCP 參與時行為與不傳第 4 參完全一致（迴歸）', () => {
    const a = processLLMRound(createFireSessionState(), '正常收尾文本。', build, { resolve: mcpResolve });
    const b = processLLMRound(createFireSessionState(), '正常收尾文本。', build);
    expect(a).toEqual(b);
  });

  it('finish 後最終推送正文不含調用語法（防洩漏迴歸守衛）', () => {
    const state = createFireSessionState();
    processLLMRound(state, '先問暗號。\nget_secret({})', build, { resolve: mcpResolve });
    const d = processLLMRound(state, '拿到了，暗號是 X。', build, { resolve: mcpResolve });
    expect(d.decision).toBe('finish');
    if (d.decision !== 'finish') return;
    const all = d.pushPayloads.map((p) => String(p.message)).join('\n');
    expect(all).toContain('先問暗號');
    expect(all).not.toContain('get_secret(');
  });
});

// ─── native tool_call 認領：嚴格命中優先，去命名空間唯一命中兜底（實機迴歸） ────────
//
// 實測裡兩類丟棄都真實發生過：模型把 mcp__ 前綴弄丟只報裸名（sess_task_60/61），
// 以及 native 調 cancel_active_message 這個明明聲明過的工具被當幻覺丟掉（sess_task_64
// ——舊入口只認 schedule + mcp__ 兩種名字，cancel / renew 壓根沒有池可進）。

const manageNames = new Set([AMSG_FIRE_SCHEDULE_TOOL, AMSG_FIRE_CANCEL_TOOL]);
const rawCall = (name: string, args = '{}', id = 'call_x1') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});

describe('classifyNativeToolCalls — 認領與丟棄', () => {
  it('嚴格命中照舊：mcp__ 前綴名進 mcp 池、聲明的管理工具名進 manage 池，名字不動', () => {
    const r = classifyNativeToolCalls(
      [rawCall('mcp__get_secret'), rawCall(AMSG_FIRE_SCHEDULE_TOOL), rawCall(AMSG_FIRE_CANCEL_TOOL)],
      manageNames, mcpResolve,
    );
    expect(r.mcp.map((tc) => tc.function.name)).toEqual(['mcp__get_secret']);
    expect(r.manage.map((tc) => tc.function.name))
      .toEqual([AMSG_FIRE_SCHEDULE_TOOL, AMSG_FIRE_CANCEL_TOOL]);
    expect(r.dropped).toEqual([]);
  });

  it('模型丟了 mcp__ 前綴只報裸名 → 認領並把名字改寫回聲明名（sess_task_60/61 現場）', () => {
    const r = classifyNativeToolCalls(
      [rawCall('get_secret', '{"who":"小滿"}')], manageNames, mcpResolve);
    expect(r.mcp).toHaveLength(1);
    expect(r.mcp[0].function.name).toBe('mcp__get_secret');
    // id 與參數原樣保留，只改名字
    expect(r.mcp[0].id).toBe('call_x1');
    expect(r.mcp[0].function.arguments).toBe('{"who":"小滿"}');
    expect(r.dropped).toEqual([]);
  });

  it('換了「姓」的命名空間寫法（default_api: / functions. / tools/）取最後一段唯一命中', () => {
    const r = classifyNativeToolCalls([
      rawCall('default_api:get_secret'),
      rawCall('functions.mcp__get_secret'),
      rawCall(`tools/${AMSG_FIRE_CANCEL_TOOL}`),
    ], manageNames, mcpResolve);
    expect(r.mcp.map((tc) => tc.function.name))
      .toEqual(['mcp__get_secret', 'mcp__get_secret']);
    expect(r.manage.map((tc) => tc.function.name)).toEqual([AMSG_FIRE_CANCEL_TOOL]);
    expect(r.dropped).toEqual([]);
  });

  it('幻覺工具（哪份清單都對不上）照舊丟棄，名字留給日誌', () => {
    const r = classifyNativeToolCalls(
      [rawCall('made_up_tool'), rawCall('default_api:also_fake')], manageNames, mcpResolve);
    expect(r.manage).toEqual([]);
    expect(r.mcp).toEqual([]);
    expect(r.dropped).toEqual(['made_up_tool', 'default_api:also_fake']);
  });

  it('工具沒聲明就不認領：manage 清單空時 cancel 照丟、mcpResolve 為 null 時裸名照丟', () => {
    const r = classifyNativeToolCalls(
      [rawCall(AMSG_FIRE_CANCEL_TOOL), rawCall('get_secret')], new Set<string>(), null);
    expect(r.manage).toEqual([]);
    expect(r.mcp).toEqual([]);
    expect(r.dropped).toEqual([AMSG_FIRE_CANCEL_TOOL, 'get_secret']);
  });

  it('形狀不對的輸入（非數組 / 沒有名字）不炸，進 dropped 或忽略', () => {
    expect(classifyNativeToolCalls(undefined, manageNames, mcpResolve))
      .toEqual({ manage: [], mcp: [], dropped: [] });
    const r = classifyNativeToolCalls(
      [{ id: 'call_bad', type: 'function', function: { name: '', arguments: '{}' } }],
      manageNames, mcpResolve);
    expect(r.dropped).toEqual([null]);
  });
});

describe('processLLMRound — 排程池混入 cancel / renew', () => {
  it('本輪只 native 取消了一條 → 正文裡的排程語法照常認（不同意圖不算跑兩遍）', () => {
    const state = createFireSessionState();
    const d = processLLMRound(
      state,
      `那條不用發了，我重新約。\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"2026-07-22 09:00","topic":"約早飯"})`,
      build, null, { nativeToolCalls: [rawCall(AMSG_FIRE_CANCEL_TOOL, '{"task_id":"abcd1234"}')] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    const names = d.toolCalls.map((tc) => tc.function.name);
    expect(names).toContain(AMSG_FIRE_CANCEL_TOOL);
    expect(names).toContain(AMSG_FIRE_SCHEDULE_TOOL);
    // 正文那句排程語法照剝，不能漏進旁白
    expect(state.narrations.join('')).not.toContain(`${AMSG_FIRE_SCHEDULE_TOOL}(`);
  });

  it('native 排程在場時正文排程語法仍只剝不入列（防同一意圖跑兩遍，迴歸守衛）', () => {
    const state = createFireSessionState();
    const nativeSchedule = rawCall(AMSG_FIRE_SCHEDULE_TOOL, '{"send_at":"2026-07-22 09:00"}');
    const d = processLLMRound(
      state,
      `我給你排上啦。\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"2026-07-22 09:00"})`,
      build, null, { nativeToolCalls: [nativeSchedule] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeSchedule]);
    expect(state.narrations.join('')).not.toContain(`${AMSG_FIRE_SCHEDULE_TOOL}(`);
  });
});
