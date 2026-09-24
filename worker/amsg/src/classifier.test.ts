import { describe, it, expect } from 'vitest';
import { classifyLLMOutput } from './classifier';

describe('classifyLLMOutput', () => {
  it('D1 finish 乾淨文本 → sanitize 不改字符', () => {
    const r = classifyLLMOutput('你好');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('你好');
      expect(r.sanitizedBody).toBe('你好');
      // sanitize 跟原文相等, 上層 onLLMOutput 不會塞 notification.body
      expect(r.sanitizedBody).toBe(r.cleanedText);
      expect(r.directives).toEqual([]);
    }
  });

  it('D2 finish 含 SEND_EMOJI → sanitize 改字符 (notification 路徑替換)', () => {
    const r = classifyLLMOutput('測試[[SEND_EMOJI: 笑]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      // cleanedText: classifier 只剝 DATA + SIDE_EFFECT 標籤, SEND_EMOJI 不在裡面 → 原文留給客戶端 Step 9
      expect(r.cleanedText).toBe('測試[[SEND_EMOJI: 笑]]');
      // sanitizedBody: 走 sanitizeForNotification, 替換成 [表情：笑]
      expect(r.sanitizedBody).toBe('測試[表情：笑]');
      expect(r.sanitizedBody).not.toBe(r.cleanedText);
    }
  });

  it('D3 finish 僅 <think> → sanitize 空串 (觸發 ZWSP 守護)', () => {
    const r = classifyLLMOutput('<think>internal monologue</think>');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('<think>internal monologue</think>');
      expect(r.sanitizedBody).toBe('');
      expect(r.sanitizedBody).not.toBe(r.cleanedText);
      // 上層 index.ts 會用 ZWSP 佔位防 amsg-sw fallthrough
    }
  });

  it('D4 tool-request 含 prefix narration', () => {
    const r = classifyLLMOutput('讓我查查[[RECALL: 2024-05]]');
    expect(r.kind).toBe('tool-request');
    if (r.kind === 'tool-request') {
      expect(r.prefix).toBe('讓我查查');
      expect(r.sanitizedPrefix).toBe('讓我查查');
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0].function.name).toBe('recall');
      expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ year: '2024', month: '05' });
    }
  });

  it('D5 tool-request prefix 為空 (LLM 直接吐數據標籤)', () => {
    const r = classifyLLMOutput('[[SEARCH: weather]]');
    expect(r.kind).toBe('tool-request');
    if (r.kind === 'tool-request') {
      expect(r.prefix).toBe('');
      expect(r.sanitizedPrefix).toBe('');
      // 兩者相等, 上層不塞 notification.body, OS banner 顯示 title-only
      expect(r.sanitizedPrefix).toBe(r.prefix);
      expect(r.toolCalls[0].function.name).toBe('web_search');
    }
  });

  it('D6 finish + directives (side-effect tag)', () => {
    const r = classifyLLMOutput('OK[[ACTION:POKE]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('OK');
      expect(r.directives).toEqual([{ type: 'poke' }]);
    }
  });

  it('轉帳金額容錯: 帶單位 / 千分位 / 冒號後空格 (老正則 `(\\d+)` 全漏)', () => {
    for (const [input, amount] of [
      ['[[ACTION:TRANSFER:520元]]', 520],
      ['[[ACTION:TRANSFER:1,999]]', 1999],
      ['[[ACTION:TRANSFER: 520]]', 520],
      ['[[ACTION:TRANSFER:520.00]]', 520],
    ] as Array<[string, number]>) {
      const r = classifyLLMOutput(input);
      expect(r.kind, input).toBe('finish');
      if (r.kind === 'finish') {
        expect(r.directives, input).toEqual([{ type: 'transfer', amount }]);
        expect(r.cleanedText, input).toBe('');
      }
    }
  });

  it('金額解析不出來 → 不產生 directive, 標籤照剝 (跟客戶端同語義)', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER:很多]]隨便花');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('隨便花');
    }
  });

  it('模仿歷史日誌的 [系統: ...] → transfer directive (正文剝淨, 客戶端重放)', () => {
    const r = classifyLLMOutput('[系統: 你向阿桃轉帳 1999]拿去花');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{ type: 'transfer', amount: 1999 }]);
      expect(r.cleanedText).toBe('拿去花');
      expect(r.sanitizedBody).toBe('拿去花');
    }
  });

  it('新 kv 形態 [[ACTION:TRANSFER|to=user|amount=520]] → directive (worker 與客戶端共用一份解析)', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER|to=user|amount=520]]拿去');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{ type: 'transfer', amount: 520 }]);
      expect(r.cleanedText).toBe('拿去');
    }
  });

  it('復讀歷史的 [[記錄:TRANSFER|...]] → 零 directive, 正文剝淨 (冪等哨兵)', () => {
    const r = classifyLLMOutput('[[記錄:TRANSFER|to=user|amount=1999|status=待處理]]拿去花');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('拿去花');
      expect(r.sanitizedBody).toBe('拿去花');
    }
  });

  it('to=char 偽造 kv → 零 directive, 標籤照剝', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER|to=char|amount=520]]收到');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('收到');
    }
  });

  it('方向偽造的日誌 (用戶→角色) 不產生 directive, 也不進正文', () => {
    const r = classifyLLMOutput('[系統: 阿桃向你轉帳 1999]我收下啦');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([]);
      expect(r.cleanedText).toBe('我收下啦');
    }
  });

  it('收/退回執 → transfer_accept / transfer_return directive (老實現在 push 路徑直接丟失)', () => {
    const accept = classifyLLMOutput('[[ACTION:TRANSFER_ACCEPT]]謝謝你');
    if (accept.kind === 'finish') {
      expect(accept.directives).toEqual([{ type: 'transfer_accept' }]);
      expect(accept.cleanedText).toBe('謝謝你');
    }
    const ret = classifyLLMOutput('[系統: 你退回了阿桃的轉帳 520]我不能要');
    if (ret.kind === 'finish') {
      expect(ret.directives).toEqual([{ type: 'transfer_return' }]);
      expect(ret.cleanedText).toBe('我不能要');
    }
  });

  it('D6+ finish + 多個 directives', () => {
    const r = classifyLLMOutput('收到[[ACTION:POKE]] 轉你[[ACTION:TRANSFER:100]]');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('收到 轉你');
      // 轉帳在 SIDE_EFFECT_TAGS 之前抽 (它要先把正文裡的日誌形態挖掉), 所以排在 poke 前面。
      // 數組順序只影響客戶端重建出的標籤串; 落庫順序由 chatParser 決定 (POKE 恆在轉帳之前執行)。
      expect(r.directives).toEqual([
        { type: 'transfer', amount: 100 },
        { type: 'poke' },
      ]);
    }
  });

  it('tool-request 多個 DATA tag 一次性收集', () => {
    const r = classifyLLMOutput('[[SEARCH: a]][[SEARCH: b]]');
    if (r.kind === 'tool-request') {
      expect(r.toolCalls).toHaveLength(2);
      expect(r.toolCalls.every(t => t.function.name === 'web_search')).toBe(true);
    }
  });

  it('空輸入 → finish + 空 cleanedText', () => {
    const r = classifyLLMOutput('');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('');
      expect(r.sanitizedBody).toBe('');
      expect(r.directives).toEqual([]);
    }
  });

  // ─── 寫日記 directive ─────────────────────────────────────────────────────

  it('Notion 短日記 title|content → notion_write_diary directive', () => {
    const r = classifyLLMOutput('好啊[[DIARY: 今天的事|窩在沙發吃西瓜]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('好啊');
      expect(r.directives).toEqual([{
        type: 'notion_write_diary',
        title: '今天的事',
        content: '窩在沙發吃西瓜',
      }]);
    }
  });

  it('Notion 短日記 無 title (無 |) → content 字段拿到整段', () => {
    const r = classifyLLMOutput('[[DIARY: 只是普通的一段]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{
        type: 'notion_write_diary',
        title: '',
        content: '只是普通的一段',
      }]);
    }
  });

  it('Notion 長日記 [[DIARY_START: title|mood]]...[[DIARY_END]] → notion_write_diary + mood', () => {
    const r = classifyLLMOutput('開始寫[[DIARY_START: 雨天|惆悵]]\n下了一整天的雨，\n我看著窗外發呆。\n[[DIARY_END]]後記');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      // strip 後剝光長日記整段, 兩側文字直接相連 (跟客戶端本地 fetch 路徑行為一致, 見
      // applyAssistantPostProcessing.ts:534 同模式 trim).
      expect(r.cleanedText).toBe('開始寫後記');
      expect(r.directives).toEqual([{
        type: 'notion_write_diary',
        title: '雨天',
        mood: '惆悵',
        content: '下了一整天的雨，\n我看著窗外發呆。',
      }]);
    }
  });

  it('Notion 長日記 僅 title (無 |) → mood undefined', () => {
    const r = classifyLLMOutput('[[DIARY_START: 標題]]\n內容\n[[DIARY_END]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      const d = r.directives[0] as { type: string; title: string; content: string; mood?: string };
      expect(d.type).toBe('notion_write_diary');
      expect(d.title).toBe('標題');
      expect(d.mood).toBeUndefined();
      expect(d.content).toBe('內容');
    }
  });

  it('飛書短日記 [[FS_DIARY: ...]] → feishu_write_diary', () => {
    const r = classifyLLMOutput('[[FS_DIARY: 飛書標題|飛書內容]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{
        type: 'feishu_write_diary',
        title: '飛書標題',
        content: '飛書內容',
      }]);
    }
  });

  it('飛書長日記 [[FS_DIARY_START..FS_DIARY_END]] → feishu_write_diary + mood', () => {
    const r = classifyLLMOutput('[[FS_DIARY_START: 週末|輕鬆]]\n睡到自然醒\n[[FS_DIARY_END]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{
        type: 'feishu_write_diary',
        title: '週末',
        mood: '輕鬆',
        content: '睡到自然醒',
      }]);
    }
  });

  it('Notion 長 + 飛書短同時存在 → 兩個 directive 都收', () => {
    const r = classifyLLMOutput('[[DIARY_START: a]]\nx\n[[DIARY_END]]\n[[FS_DIARY: b|y]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toHaveLength(2);
      const types = r.directives.map(d => d.type);
      expect(types).toContain('notion_write_diary');
      expect(types).toContain('feishu_write_diary');
    }
  });
});

describe('classifyLLMOutput — LIFE / NEWS_CARD', () => {
  it('[[LIFE:...]] → life_record directive, 正文剝乾淨', () => {
    const r = classifyLLMOutput('你今天吃藥了嗎\n[[LIFE:MED|布洛芬]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('你今天吃藥了嗎');
      expect(r.sanitizedBody).toBe('你今天吃藥了嗎');
      expect(r.directives).toEqual([{ type: 'life_record', body: 'MED|布洛芬' }]);
    }
  });

  it('無參形態 [[LIFE:PERIOD_START]] 一樣收', () => {
    const r = classifyLLMOutput('記下了[[LIFE:PERIOD_START]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('記下了');
      expect(r.directives).toEqual([{ type: 'life_record', body: 'PERIOD_START' }]);
    }
  });

  it('一條消息裡多個 LIFE → 逐個收', () => {
    const r = classifyLLMOutput('[[LIFE:MED|布洛芬]][[LIFE:EXERCISE|跑步|30分鐘]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'life_record', body: 'MED|布洛芬' },
        { type: 'life_record', body: 'EXERCISE|跑步|30分鐘' },
      ]);
    }
  });

  it('[[NEWS_CARD: 來源|標題]] → news_card directive, 前後空格歸一', () => {
    const r = classifyLLMOutput('刷到條新聞\n[[NEWS_CARD: 微博|某某官宣 ]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('刷到條新聞');
      expect(r.sanitizedBody).toBe('刷到條新聞');
      expect(r.directives).toEqual([{ type: 'news_card', body: '微博|某某官宣' }]);
    }
  });

  it('省略來源的 [[NEWS_CARD: 標題]] 也收', () => {
    const r = classifyLLMOutput('[[NEWS_CARD: 某某官宣]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.cleanedText).toBe('');
      expect(r.directives).toEqual([{ type: 'news_card', body: '某某官宣' }]);
    }
  });
});

// 複述型模型經常把整條消息重寫一遍 (先說一遍再"總結"一遍), 同一個標籤就出現兩次。
// 客戶端重放不去重, 放過去就是同一筆錢轉兩次帳。
describe('classifyLLMOutput — 同一條消息裡重複的副作用只出一個 directive', () => {
  it('兩個一模一樣的轉帳標籤 → 只出一個 transfer directive', () => {
    const r = classifyLLMOutput('給你買奶茶[[ACTION:TRANSFER:520]]\n剛剛給你轉了[[ACTION:TRANSFER:520]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([{ type: 'transfer', amount: 520 }]);
    }
  });

  it('金額不同的兩筆仍然是兩件事, 都留', () => {
    const r = classifyLLMOutput('[[ACTION:TRANSFER:520]][[ACTION:TRANSFER:1314]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'transfer', amount: 520 },
        { type: 'transfer', amount: 1314 },
      ]);
    }
  });

  it('重複的日程 / 生活記錄同樣只留第一個', () => {
    const r = classifyLLMOutput(
      '[[ACTION:ADD_EVENT|面試|2026-08-03]][[LIFE:MED|布洛芬]]\n'
      + '再說一遍：[[ACTION:ADD_EVENT|面試|2026-08-03]][[LIFE:MED|布洛芬]]',
    );
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'add_event', title: '面試', date: '2026-08-03' },
        { type: 'life_record', body: 'MED|布洛芬' },
      ]);
    }
  });

  it('參數不同的小紅書動作不會被誤吞', () => {
    const r = classifyLLMOutput('[[XHS_LIKE: n1]][[XHS_LIKE: n1]][[XHS_LIKE: n2]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'xhs_like', noteId: 'n1' },
        { type: 'xhs_like', noteId: 'n2' },
      ]);
    }
  });
});

// 角色改自己日程要跨兩側才算齊：worker 這邊把標籤認成 change_schedule directive，
// 客戶端那邊拼回原標籤、落庫、順帶打髒讓 fire_pack 重新上雲。worker 不認的話，標籤會
// 留在正文裡，然後被 sanitizeIntoSegments 的 stripBusinessTagsForNotification（正則含
// ACTION）連 raw 一起剝掉，客戶端什麼都收不到——而角色嘴上已經說了「改好了」。
// 即時對話是 amsg2 的主路徑，前台那份 prompt 又照常教這個能力，所以這條通道必須在。
describe('classifyLLMOutput — 日程修改走 directive 通道', () => {
  it('規範標籤 → change_schedule directive，正文裡不留痕', () => {
    const r = classifyLLMOutput('那今晚就不睡了，陪你聊。\n[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'change_schedule', time: '22:00', activity: '陪你聊天' },
      ]);
      expect(r.cleanedText).toBe('那今晚就不睡了，陪你聊。');
      expect(r.cleanedText).not.toContain('CHANGE_SCHEDULE');
    }
  });

  it('掉格式的寫法一樣認（跟客戶端共用同一份容錯解析）', () => {
    for (const raw of [
      '【【修改日程：22:00：陪你聊天】】',
      '[[change schedule: (22:00): 陪你聊天]]',
      '改日程 | 22點 | 陪你聊天',
    ]) {
      const r = classifyLLMOutput(raw);
      expect(r.kind).toBe('finish');
      if (r.kind === 'finish') {
        expect(r.directives.some((d) => d.type === 'change_schedule')).toBe(true);
      }
    }
  });

  it('只輸出這一個標籤時也到得了客戶端（directive-only，沒有可見正文）', () => {
    const r = classifyLLMOutput('[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]');
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toHaveLength(1);
      expect(r.cleanedText).toBe('');
    }
  });

  it('沒有這個標籤時正文一個字都不動（解析層的空行壓縮不該殃及普通消息）', () => {
    const text = '今天好累。\n\n\n不過還是想跟你說說話。';
    const r = classifyLLMOutput(text);
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') expect(r.cleanedText).toBe(text);
  });

  it('跟別的副作用標籤共存時互不干擾', () => {
    const r = classifyLLMOutput(
      '[[ACTION:POKE]]\n[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]\n[[ACTION:ADD_EVENT|紀念日|2026-08-20]]',
    );
    expect(r.kind).toBe('finish');
    if (r.kind === 'finish') {
      expect(r.directives).toEqual([
        { type: 'change_schedule', time: '22:00', activity: '陪你聊天' },
        { type: 'poke' },
        { type: 'add_event', title: '紀念日', date: '2026-08-20' },
      ]);
    }
  });
});


describe('classifyLLMOutput — Soren 專用標籤原樣直通', () => {
  it('發照片、改關係、邀約、來電都變成 soren_tag，正文裡剝掉', () => {
    const r = classifyLLMOutput([
      '看我剛拍的',
      '[[ACTION:SEND_PHOTO|窗邊的貓]]',
      '[[ACTION：RELATIONSHIP｜曖昧對象]]',
      '[[ACTION:DATE_INVITE|河堤公園|散步]]',
      '[[ACTION:CALL|video|想看看你]]',
    ].join('\n'));
    expect(r.kind).toBe('finish');
    if (r.kind !== 'finish') return;
    expect(r.cleanedText).toBe('看我剛拍的');
    expect(r.directives).toEqual([
      { type: 'soren_tag', raw: '[[ACTION:SEND_PHOTO|窗邊的貓]]' },
      { type: 'soren_tag', raw: '[[ACTION：RELATIONSHIP｜曖昧對象]]' },
      { type: 'soren_tag', raw: '[[ACTION:DATE_INVITE|河堤公園|散步]]' },
      { type: 'soren_tag', raw: '[[ACTION:CALL|video|想看看你]]' },
    ]);
  });

  it('整則只有已讀不回標籤：正文空、標籤照樣送回', () => {
    const r = classifyLLMOutput('[[ACTION:NO_REPLY|[會議中] 稍後回]]');
    if (r.kind !== 'finish') throw new Error('expected finish');
    expect(r.cleanedText).toBe('');
    expect(r.directives).toEqual([{ type: 'soren_tag', raw: '[[ACTION:NO_REPLY|[會議中] 稍後回]]' }]);
  });

  it('不誤認別的 ACTION（POKE 照舊、CALLBACK 不算來電）', () => {
    const r = classifyLLMOutput('[[ACTION:POKE]]\n[[ACTION:CALLBACK|x]]');
    if (r.kind !== 'finish') throw new Error('expected finish');
    expect(r.directives).toEqual([{ type: 'poke' }]);
  });
});
