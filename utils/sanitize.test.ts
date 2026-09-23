import { describe, it, expect } from 'vitest';
import { sanitizeForBubble, sanitizeForNotification, sanitizeIntoSegments } from './sanitize';

// ─── Oracle: 原版 chatParser.sanitize (來自 commit e97f9ed) ─────────────────
// 用來跟 sanitizeForBubble 字節對齊校驗. refactor 後改 sanitize.ts 就立刻能
// 看到行為漂移.
function originalSanitize(text: string, options?: { keepCitations?: boolean }): string {
  let result = text
    .replace(/\\n/g, '\n')
    .replace(/\s*\[(?:聊天|通[话話]|[约約][会會])\]\s*/g, '\n')
    .replace(/\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*/gm, '')
    .replace(/（[上下]午\d{1,2}[：:]\d{2}）/g, '')
    .replace(/\(\d{1,2}:\d{2}\s*[AP]M\)/gi, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END|MUSIC_ACTION)[:\s][\s\S]*?\]\]/g, '')
    .replace(/\[schedule_message[^\]]*\]/g, '');
  if (!options?.keepCitations) {
    result = result
      .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')
      .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
      .replace(/\[回[复覆]\s*[""“][^""”]*?[""”](?:\.{0,3})\]\s*[：:]?\s*/g, '');
  }
  return result
    .replace(/`(\[\[[\s\S]*?\]\])`/g, '$1')
    .replace(/``+/g, '')
    .replace(/(^|\s)`(\s|$)/gm, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*{2,}/g, '')
    .replace(/^\s*---\s*$/gm, '')
    .replace(/^\s*[-*+]\s*$/gm, '')
    .replace(/%%TRANS%%[\s\S]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── sanitizeForNotification: 底層 helper 等價類 ───────────────────────────

describe('sanitizeForNotification', () => {
  it('A1 字面 \\n 還原', () => {
    expect(sanitizeForNotification('a\\nb')).toBe('a\nb');
  });

  it('A2 源標籤 → 換行 (replace-with-marker)', () => {
    expect(sanitizeForNotification('你好[聊天]在嗎')).toBe('你好\n在嗎');
  });

  it('A2b 模型把來源標籤中英混寫或翻譯後仍會剝掉', () => {
    expect(sanitizeForNotification('抖音BGM有節奏感，那就聽著\n[聊chat] 播客那是別人的習慣')).toBe(
      '抖音BGM有節奏感，那就聽著\n播客那是別人的習慣',
    );
    expect(sanitizeForNotification('前文 [chat] 後文 [通call] 收尾 [約date] 好')).toBe(
      '前文\n後文\n收尾\n好',
    );
  });

  it('A3 時間戳 4 變體一次過', () => {
    // 注意: English 12h `\(...\)` 不吃 trailing 空格 (跟原版正則保持一致),
    // 所以 `(1:52 PM) hi4` 剝後是 ' hi4'.
    const input = '[2026-05-20 13:52] hi\n2026-05-20 13:52 hi2\n（下午1:52）hi3\n(1:52 PM) hi4';
    expect(sanitizeForNotification(input)).toBe('hi\nhi2\nhi3\n hi4');
  });

  it('A4 業務標籤 alternation 全剝', () => {
    const input = 'a[[ACTION:POKE]]b[[RECALL: 2024-05]]c[schedule_message|t1|fixed|x]d';
    expect(sanitizeForNotification(input)).toBe('abcd');
  });

  it('A5 引用三變體 (keepCitations=false)', () => {
    expect(sanitizeForNotification('[[QUOTE：x]]a[QUOTE：y]b[回覆 "z"]: c'))
      .toBe('abc');
  });

  it('A5b 模仿歷史渲染的引用頭 [xx引用了xx「…」，並回復了 ↓] 也剝', () => {
    expect(sanitizeForNotification('[我引用了你說的「昨晚那句話」，並回復了 ↓]\n好啦我錯了'))
      .toBe('好啦我錯了');
    expect(sanitizeForNotification('[用戶引用了你之前說的「截斷的摘要…」，並回復了 ↓] 嗯'))
      .toBe('嗯');
    // 非引用格式的普通方括號不誤傷
    expect(sanitizeForNotification('我看了[那本書]感覺一般'))
      .toBe('我看了[那本書]感覺一般');
    // 缺閉合 」 的畸形引用頭不跨行吞掉後續正文段落
    expect(sanitizeForNotification('[我引用了你說的「沒有閉合\n第一行正文\n第二行正文'))
      .toBe('[我引用了你說的「沒有閉合\n第一行正文\n第二行正文');
  });

  it('A6 backtick 三變體', () => {
    expect(sanitizeForNotification('a `[[X:1]]` b `` c ` d'))
      .toBe('a [[X:1]] b  c  d');
  });

  it('A7 markdown link → [鏈接：text]', () => {
    expect(sanitizeForNotification('see [click](https://x.com) here'))
      .toBe('see [鏈接：click] here');
  });

  it('A9 <think> 閉合 + 未閉合兜底', () => {
    expect(sanitizeForNotification('a<think>x</think>b<thinking>tail'))
      .toBe('ab');
  });

  it('A10 SEND_EMOJI 正向 + 反向 emoji tag', () => {
    expect(sanitizeForNotification('[Sully 發送了表情包: 笑] 然後 [[SEND_EMOJI: 哭]]'))
      .toBe('[表情：笑] 然後 [表情：哭]');
  });

  it('A11 [html] 塊屏蔽內部 markdown', () => {
    expect(sanitizeForNotification('前 [html]# h1 **bold**[/html] 後'))
      .toBe('前 [HTML 卡片] 後');
  });

  it('A12 <翻譯> 保留原文剝譯文 (規範格式 with <原文>)', () => {
    expect(sanitizeForNotification('<翻譯><原文>Hi</原文><譯文>嗨</譯文></翻譯>'))
      .toBe('Hi');
  });

  it('A12+ <翻譯> LLM 幻覺錯誤格式 (無 <原文> 包裹) → 兜底剝 <譯文> + 標籤', () => {
    // T7 實測踩到: LLM 輸出 `<翻譯>X</翻譯><譯文>Y</譯文>` 而不是規範的
    // `<翻譯><原文>X</原文><譯文>Y</譯文></翻譯>`. 必須兜底剝, 否則 banner 上
    // 漏出原始標籤字符. 譯文整塊吞, 殘留 open/close tag 剝光, 留原文.
    expect(sanitizeForNotification('<翻譯>Hello</翻譯><譯文>你好</譯文>'))
      .toBe('Hello');
    expect(sanitizeForNotification('<翻譯>Check the notification.</翻譯><譯文>檢查通知。</譯文>'))
      .toBe('Check the notification.');
  });

  it('A12++ 落單的 <譯文> / <翻譯> 標籤也剝乾淨', () => {
    expect(sanitizeForNotification('before <譯文>only translated</譯文> after'))
      .toBe('before  after');
    expect(sanitizeForNotification('orphan <翻譯> open <原文> tags'))
      .toBe('orphan  open  tags');
  });

  // ─── 順序依賴 (interaction bugs) ─────────────────────────────────────────

  it('B1 markdown link 在 header strip 之前 (不吃 # frag)', () => {
    expect(sanitizeForNotification('[click](https://x.com/#frag)'))
      .toBe('[鏈接：click]');
  });

  it('B2 [html] 在 markdown 之前 (內部 # 不被剝)', () => {
    expect(sanitizeForNotification('[html]# h1\n**b**\n[/html]'))
      .toBe('[HTML 卡片]');
  });

  it('B3 <think> 在 INNER_STATE / 業務標籤之前 (一次吃光)', () => {
    expect(sanitizeForNotification('<think>[[INNER_STATE: x]][[ACTION:POKE]]</think>real'))
      .toBe('real');
  });

  it('B4 字面 \\n 還原在 line-anchored 之前', () => {
    // 字面 `\n` 還原後, ^錨定的 timestamp 才能命中
    expect(sanitizeForNotification('foo\\n2026-05-20 13:52 hi'))
      .toBe('foo\nhi');
  });

  // ─── 邊界 ──────────────────────────────────────────────────────────────

  it('C1 空串', () => {
    expect(sanitizeForNotification('')).toBe('');
  });

  it('C2 全空白', () => {
    expect(sanitizeForNotification('\n\n\n   ')).toBe('');
  });

  it('C3 冪等 (關鍵不變量)', () => {
    const cases = [
      '<think>x</think>real',
      '[html]內容[/html]',
      '<翻譯><原文>A</原文><譯文>B</譯文></翻譯>',
      'a[[ACTION:POKE]]b[[SEND_EMOJI: 笑]]c',
      '[click](https://example.com/#anchor)',
    ];
    for (const x of cases) {
      const once = sanitizeForNotification(x);
      const twice = sanitizeForNotification(once);
      expect(twice).toBe(once);
    }
  });

  // ─── notification 路徑獨有: READ_NOTE / XHS_* 剝 ───────────────────────

  it('notification 路徑額外剝 READ_NOTE / XHS_*', () => {
    expect(sanitizeForNotification('a[[READ_NOTE: key]]b[[XHS_LIKE: 1]]c[[XHS_MY_PROFILE]]d'))
      .toBe('abcd');
  });
});

// ─── sanitizeForBubble: byte-aligned to original chatParser.sanitize ──────

describe('sanitizeForBubble byte-alignment (C4 oracle)', () => {
  const fixtures: Array<{ name: string; input: string; opts?: { keepCitations?: boolean } }> = [
    { name: 'plain text', input: '你好世界' },
    { name: 'business tags', input: 'a[[ACTION:POKE]]b' },
    { name: 'timestamp leak', input: '[2026-05-20 13:52] hi' },
    { name: 'source tag', input: '你好[聊天]在嗎' },
    { name: 'backtick wrap', input: 'a `[[X:1]]` b' },
    { name: 'markdown link', input: 'see [click](https://x.com)' },
    { name: 'markdown header', input: '# title\nbody' },
    { name: 'literal newline', input: 'a\\nb' },
    { name: 'bold markers', input: '**hi** **bye**' },
    { name: 'quote keepCitations=false', input: '[[QUOTE：x]] hi', opts: { keepCitations: false } },
    { name: 'quote keepCitations=true', input: '[[QUOTE：x]] hi', opts: { keepCitations: true } },
    { name: '回覆 reply quote', input: '[回覆 "原話"]: 嗯' },
    { name: 'empty', input: '' },
    { name: 'whitespace only', input: '\n\n\n' },
    { name: 'XHS tag (bubble 保留, notification 剝)', input: '[[XHS_LIKE: 1]] hi' },
    { name: 'SEND_EMOJI (bubble 保留)', input: 'hi [[SEND_EMOJI: 笑]]' },
    { name: '<think> (bubble 保留)', input: '<think>x</think>real' },
  ];

  for (const { name, input, opts } of fixtures) {
    it(`oracle: ${name}`, () => {
      expect(sanitizeForBubble(input, opts)).toBe(originalSanitize(input, opts));
    });
  }
});

// ─── sanitizeForBubble 跟 sanitizeForNotification 差異點 ───────────────────

describe('bubble vs notification differences', () => {
  it('氣泡與 worker 分段都不會洩漏模型變形後的來源標籤', () => {
    const raw = '得了吧 [聊chat] 剛才還叫寶寶';
    expect(sanitizeForBubble(raw)).toBe('得了吧\n剛才還叫寶寶');
    expect(sanitizeIntoSegments(raw).map(segment => segment.sanitized)).toEqual([
      '得了吧',
      '剛才還叫寶寶',
    ]);
  });

  it('A8 bubble 路徑: markdown link → text (無 [鏈接：] 包裝)', () => {
    // notification 把 [text](url) → [鏈接：text]; bubble 保留老行為 → text
    expect(sanitizeForBubble('see [click](https://x.com)')).toBe('see click');
  });

  it('bubble 路徑保留 SEND_EMOJI / <think> / INNER_STATE (下游 step 用)', () => {
    expect(sanitizeForBubble('[[SEND_EMOJI: 笑]]'))
      .toBe('[[SEND_EMOJI: 笑]]');
    expect(sanitizeForBubble('<think>x</think>real'))
      .toBe('<think>x</think>real');
    expect(sanitizeForBubble('[[INNER_STATE: x]]real'))
      .toBe('[[INNER_STATE: x]]real');
  });

  // ─── 系統日誌 leak 終線 ──────────────────────────────────────────────────
  // 能還原成動作的 (轉帳) 已在上游被 chatParser/transferFormat 認領走; 走到 sanitize
  // 的一律不進氣泡/通知。這是對原版 chatParser.sanitize 的**有意**分叉, 不是 refactor 漂移。

  it('bubble + notification 都剝 [系統: ...] 殘留', () => {
    expect(sanitizeForBubble('[系統: 你向阿桃轉帳 1999]拿去花')).toBe('拿去花');
    expect(sanitizeForNotification('[系統: 你向阿桃轉帳 1999]拿去花')).toBe('拿去花');
  });

  it('系統日誌的各種形態: 全角冒號 / 系統提示 / 無冒號 / System', () => {
    expect(sanitizeForBubble('[系統：用戶戳了你一下]我在呢')).toBe('我在呢');
    expect(sanitizeForBubble('[系統提示: 距離上一條消息: 3 小時]好久不見')).toBe('好久不見');
    expect(sanitizeForBubble('[系統] 通話已結束')).toBe('通話已結束');
    expect(sanitizeForBubble('[System: 你接收了阿桃的轉帳 520]謝謝')).toBe('謝謝');
  });

  it('不跨塊吞正文: 內層禁方括號', () => {
    expect(sanitizeForBubble('[系統: a]保留[[SEND_EMOJI: 笑]]')).toBe('保留[[SEND_EMOJI: 笑]]');
  });

  it('普通方括號不受影響', () => {
    expect(sanitizeForBubble('[圖片]和[表情]都留著')).toBe('[圖片]和[表情]都留著');
  });

  it('冪等', () => {
    const once = sanitizeForBubble('[系統: 你向阿桃轉帳 1999]拿去花');
    expect(sanitizeForBubble(once)).toBe(once);
  });

  // [[記錄:...]] 命名空間 —— 歷史渲染形態 (transferFormat.formatTransferRecord)，
  // 上游沒認領的一律不進氣泡/通知。同為對原版的有意分叉。
  it('[[記錄:...]] 整個命名空間在 bubble + notification 都剝', () => {
    expect(sanitizeForBubble('[[記錄:TRANSFER|to=user|amount=1999|status=待處理]]拿去花')).toBe('拿去花');
    expect(sanitizeForNotification('[[記錄:TRANSFER|to=user|amount=1999|status=已收下]]好耶')).toBe('好耶');
    // 未來的記錄類型自動受保護
    expect(sanitizeForBubble('[[記錄:POKE|by=user]]我在')).toBe('我在');
    expect(sanitizeForBubble('[[記錄:TRANSFER|to=user]]繁體也剝')).toBe('繁體也剝');
  });

  it('bubble 路徑不剝 XHS_* / READ_NOTE (老行為)', () => {
    expect(sanitizeForBubble('[[XHS_LIKE: 1]] hi')).toBe('[[XHS_LIKE: 1]] hi');
    expect(sanitizeForBubble('[[READ_NOTE: key]] hi')).toBe('[[READ_NOTE: key]] hi');
  });

  // ─── LIFE / NEWS_CARD 的兩條路 ────────────────────────────────────────────
  // 前台聊天: chatParser.parseAndExecuteActions 直接從原文掃這兩個標籤執行 (LIFE 見
  // chatParser.ts LIFE 分支, NEWS_CARD 見 NEWS_CARD_RE), 所以 bubble 側必須原樣留著。
  // push: 副作用改走 classifier 的 life_record / news_card directive, 正文裡剝光,
  // 否則鎖屏橫幅直接顯示標籤源碼。

  it('notification 剝 LIFE / NEWS_CARD, bubble 原樣保留', () => {
    expect(sanitizeForNotification('你今天吃藥了嗎\n[[LIFE:MED|布洛芬]]')).toBe('你今天吃藥了嗎');
    expect(sanitizeForNotification('看到個新聞\n[[NEWS_CARD: 微博|某某官宣]]')).toBe('看到個新聞');
    // 無參形態 (生理期開始/結束) 同樣剝掉
    expect(sanitizeForNotification('記下了[[LIFE:PERIOD_START]]')).toBe('記下了');

    expect(sanitizeForBubble('你今天吃藥了嗎\n[[LIFE:MED|布洛芬]]'))
      .toBe('你今天吃藥了嗎\n[[LIFE:MED|布洛芬]]');
    expect(sanitizeForBubble('看到個新聞\n[[NEWS_CARD: 微博|某某官宣]]'))
      .toBe('看到個新聞\n[[NEWS_CARD: 微博|某某官宣]]');
  });
});

// ─── sanitizeIntoSegments (amsg-instant 0.8+ pushPayloads) ─────────────────

describe('sanitizeIntoSegments', () => {
  it('單行普通文本 → 1 個 segment, raw === sanitized', () => {
    const segs = sanitizeIntoSegments('你好');
    expect(segs).toEqual([{ raw: '你好', sanitized: '你好' }]);
  });

  it('多行 (換行切) → N 個 segments', () => {
    const segs = sanitizeIntoSegments('你看\n看來昨天忙的還是機密啊。\n我沒事的');
    expect(segs.map((s) => s.raw)).toEqual([
      '你看',
      '看來昨天忙的還是機密啊。',
      '我沒事的',
    ]);
  });

  it('SEND_EMOJI 單獨成行 → 獨立 segment, raw 是 raw tag, sanitized 是 [表情：x]', () => {
    const segs = sanitizeIntoSegments('你看\n[[SEND_EMOJI: 笑]]\n我沒事的');
    expect(segs).toEqual([
      { raw: '你看', sanitized: '你看' },
      { raw: '[[SEND_EMOJI: 笑]]', sanitized: '[表情：笑]' },
      { raw: '我沒事的', sanitized: '我沒事的' },
    ]);
  });

  it('inline SEND_EMOJI 在文字中間 → 拆 3 段 (text/emoji/text)', () => {
    const segs = sanitizeIntoSegments('你看 [[SEND_EMOJI: 笑]] 我沒事的');
    expect(segs).toEqual([
      { raw: '你看', sanitized: '你看' },
      { raw: '[[SEND_EMOJI: 笑]]', sanitized: '[表情：笑]' },
      { raw: '我沒事的', sanitized: '我沒事的' },
    ]);
  });

  it('CJK 字符之間空格屬於正文，不切 segment', () => {
    const segs = sanitizeIntoSegments('漢字 漢字');
    expect(segs.map((s) => s.raw)).toEqual(['漢字 漢字']);
  });

  it('非內置雙語格式的中日混排內容保持為一個 segment', () => {
    const text = '「筋トレ界隈じゃ日常茶飯事だ（那時候我也說過 健身圈一天四個蛋是日常）」';
    const segs = sanitizeIntoSegments(text);
    expect(segs).toEqual([{ raw: text, sanitized: text }]);
  });

  it('<think> 整段被剝, 只剩 think 時 → 空數組 (skip-push 觸發)', () => {
    const segs = sanitizeIntoSegments('<think>internal monologue</think>');
    expect(segs).toEqual([]);
  });

  it('<think> 跟正文混合 → think 剝光, 正文按 chunkText 切', () => {
    const segs = sanitizeIntoSegments('<think>internal</think>你好\n再見');
    expect(segs.map((s) => s.raw)).toEqual(['你好', '再見']);
  });

  it('業務標籤 + INNER_STATE 全 strip → 留下純文字', () => {
    const segs = sanitizeIntoSegments('[[INNER_STATE: x]]你好[[ACTION:POKE]]\n再見');
    expect(segs.map((s) => s.raw)).toEqual(['你好', '再見']);
  });

  it('整段只有業務標籤 → 空數組', () => {
    const segs = sanitizeIntoSegments('[[ACTION:POKE]][[INNER_STATE: y]]');
    expect(segs).toEqual([]);
  });

  // 這兩條釘住 worker 為什麼必須走 directive 通道傳轉帳 (classifier.ts extractTransferCommands):
  // 獨佔一行的日誌塊 banner 為空 → 整塊被 skip, 留在正文裡就到不了客戶端。
  it('[系統: ...] 獨佔一行 → banner 為空, 整塊 skip (所以副作用不能靠正文傳)', () => {
    const segs = sanitizeIntoSegments('[系統: 你向阿桃轉帳 1999]\n拿去花');
    expect(segs).toEqual([{ raw: '拿去花', sanitized: '拿去花' }]);
  });

  it('[[記錄:...]] 在 segments 裡當業務標籤整剝 (worker 已在 directive 通道認領轉帳, 殘留即 leak)', () => {
    const segs = sanitizeIntoSegments('[[記錄:POKE|by=user]]你好\n再見');
    expect(segs.map((s) => s.raw)).toEqual(['你好', '再見']);
  });

  it('[系統: ...] 與正文同行 → raw 保留日誌, banner 剝掉', () => {
    const segs = sanitizeIntoSegments('[系統: 你向阿桃轉帳 1999]拿去花');
    expect(segs).toEqual([
      { raw: '[系統: 你向阿桃轉帳 1999]拿去花', sanitized: '拿去花' },
    ]);
  });

  it('markdown link 行內 → raw 保留 [text](url), sanitized 是 [鏈接：text]', () => {
    const segs = sanitizeIntoSegments('see [click](https://x.com) here');
    expect(segs).toHaveLength(1);
    expect(segs[0].raw).toBe('see [click](https://x.com) here');
    expect(segs[0].sanitized).toBe('see [鏈接：click] here');
  });

  it('[html] 單獨成行 → raw 保留 [html] 塊給客戶端 Step 5, sanitized 是 [HTML 卡片]', () => {
    const segs = sanitizeIntoSegments('前\n[html]<div>x</div>[/html]\n後');
    expect(segs).toEqual([
      { raw: '前', sanitized: '前' },
      { raw: '[html]<div>x</div>[/html]', sanitized: '[HTML 卡片]' },
      { raw: '後', sanitized: '後' },
    ]);
  });

  it('[html] 多行 HTML → 整塊單 segment, 不被 chunkText 按 \\n 切碎', () => {
    // Regression: 在沒有 Phase 1.5 保護時, chunkText 會把多行 HTML 按 \n 拆成
    // 多個 segment, 每個 segment 都是 HTML 碎片, 客戶端 extractHtmlBlocks 匹配不
    // 到完整 [html]...[/html] 對兒, 渲染成一條條裸標籤氣泡.
    const input = '前\n[html]<div>\n  hello\n  <span>world</span>\n</div>[/html]\n後';
    const segs = sanitizeIntoSegments(input);
    expect(segs).toEqual([
      { raw: '前', sanitized: '前' },
      {
        raw: '[html]<div>\n  hello\n  <span>world</span>\n</div>[/html]',
        sanitized: '[HTML 卡片]',
      },
      { raw: '後', sanitized: '後' },
    ]);
  });

  it('[html] 連續兩個多行塊 → 各自獨立成 segment, 內容不交叉', () => {
    const input = '[html]<div>\nA\n</div>[/html]\n[html]<div>\nB\n</div>[/html]';
    const segs = sanitizeIntoSegments(input);
    expect(segs).toEqual([
      { raw: '[html]<div>\nA\n</div>[/html]', sanitized: '[HTML 卡片]' },
      { raw: '[html]<div>\nB\n</div>[/html]', sanitized: '[HTML 卡片]' },
    ]);
  });

  it('<翻譯> 整塊保留給客戶端 Step 8 雙語渲染; banner 只顯示原文', () => {
    // raw 必須帶完整 <翻譯><原文>X</原文><譯文>Y</譯文></翻譯>, 否則客戶端
    // applyAssistantPostProcessing.ts:1564 hasTranslationTags 配不上, 譯文丟失.
    const segs = sanitizeIntoSegments('<翻譯><原文>Hi</原文><譯文>嗨</譯文></翻譯>');
    expect(segs).toEqual([
      {
        raw: '<翻譯><原文>Hi</原文><譯文>嗨</譯文></翻譯>',
        sanitized: 'Hi',
      },
    ]);
  });

  it('<翻譯> 多行塊 + 前後文 → 翻譯整塊獨立成 segment, 不被 chunkText 切碎', () => {
    const input = '前\n<翻譯>\n<原文>Wait... seriously?</原文>\n<譯文>等等… 你認真的嗎？</譯文>\n</翻譯>\n後';
    const segs = sanitizeIntoSegments(input);
    expect(segs).toEqual([
      { raw: '前', sanitized: '前' },
      {
        raw: '<翻譯>\n<原文>Wait... seriously?</原文>\n<譯文>等等… 你認真的嗎？</譯文>\n</翻譯>',
        sanitized: 'Wait... seriously?',
      },
      { raw: '後', sanitized: '後' },
    ]);
  });

  it('殘留 <譯文> sibling tag (LLM 幻覺) → 兜底剝光, 不會產 segment', () => {
    // 沒被規範 <翻譯> 包住的孤立 <譯文> 仍按 extractTranslationOriginal 兜底剝
    const segs = sanitizeIntoSegments('你好<譯文>嗨</譯文>再見');
    expect(segs.map((s) => s.raw)).toEqual(['你好再見']);
  });

  it('<語音> 整塊保留給客戶端 extractVoiceTag 觸發 auto-TTS', () => {
    const segs = sanitizeIntoSegments('<語音>Hello world</語音>');
    expect(segs).toEqual([
      { raw: '<語音>Hello world</語音>', sanitized: 'Hello world' },
    ]);
  });

  it('<語音 emotion="…"> 帶情緒屬性也整塊保留 + banner 取內部文字', () => {
    const segs = sanitizeIntoSegments('<語音 emotion="sad">Hello world</語音>');
    expect(segs).toEqual([
      { raw: '<語音 emotion="sad">Hello world</語音>', sanitized: 'Hello world' },
    ]);
  });

  it('<語音> 多行內容 → 整塊單 segment, 不被 chunkText 按 \\n 切碎', () => {
    const input = '前面文字\n<語音>\nWait...\nare you serious?\n</語音>\n後面文字';
    const segs = sanitizeIntoSegments(input);
    expect(segs).toEqual([
      { raw: '前面文字', sanitized: '前面文字' },
      {
        raw: '<語音>\nWait...\nare you serious?\n</語音>',
        sanitized: 'Wait...\nare you serious?',
      },
      { raw: '後面文字', sanitized: '後面文字' },
    ]);
  });

  it('引用 [[QUOTE:...]] 保留給客戶端 Step 7 配 aiReplyTarget; banner 剝光', () => {
    // worker 不再剝引用 — 否則客戶端 firstQuoteMatch 配不上 → 沒回複目標.
    // 但 sanitizeTextForBanner 仍剝, 通知乾淨.
    const segs = sanitizeIntoSegments('[[QUOTE: 用戶的話]] 我的回覆');
    expect(segs).toHaveLength(1);
    expect(segs[0].raw).toBe('[[QUOTE: 用戶的話]] 我的回覆');
    expect(segs[0].sanitized).toBe('我的回覆');
  });

  it('引用 [回覆 "..."]  中文形態同樣保留 raw', () => {
    // stripQuotes 的 REPLY_CLEAN_CN 正則把 `[回覆 "..."]:` (含冒號) 一起吃掉, 所以
    // banner 是乾淨的正文; raw 留全, 客戶端 Step 7 用 REPLY_RE_CN 配出 aiReplyTarget.
    const segs = sanitizeIntoSegments('[回覆 "在幹嘛"]: 在工作呀');
    expect(segs).toHaveLength(1);
    expect(segs[0].raw).toBe('[回覆 "在幹嘛"]: 在工作呀');
    expect(segs[0].sanitized).toBe('在工作呀');
  });

  it('空串 / 全空白 → 空數組', () => {
    expect(sanitizeIntoSegments('')).toEqual([]);
    expect(sanitizeIntoSegments('   \n\n  ')).toEqual([]);
  });

  it('時間戳 leak 跟正文混 → 時間戳 strip 後正文按 chunkText 切', () => {
    const segs = sanitizeIntoSegments('[2026-05-20 13:52] 你好\n（下午1:52）再見');
    expect(segs.map((s) => s.raw)).toEqual(['你好', '再見']);
  });

  it('LIFE / NEWS_CARD 獨佔一行時整段消失, 不產生只有標籤的 push', () => {
    // 老行為: 這兩個標籤既不在 classifier 表裡也不在 strip 表裡, 於是原樣切成獨立
    // segment 發出去 —— 鎖屏橫幅直接顯示 `[[LIFE:MED|布洛芬]]`。
    expect(sanitizeIntoSegments('你今天吃藥了嗎\n[[LIFE:MED|布洛芬]]'))
      .toEqual([{ raw: '你今天吃藥了嗎', sanitized: '你今天吃藥了嗎' }]);
    expect(sanitizeIntoSegments('刷到條新聞\n[[NEWS_CARD: 微博|某某官宣]]'))
      .toEqual([{ raw: '刷到條新聞', sanitized: '刷到條新聞' }]);
    // 跟正文同一行時也不留殘骸
    expect(sanitizeIntoSegments('記下啦[[LIFE:EXPENSE|38|打車]]'))
      .toEqual([{ raw: '記下啦', sanitized: '記下啦' }]);
  });

  it('冪等: sanitizeIntoSegments(joinAll) 跟原結果在等價 input 上保持穩定', () => {
    // 不是嚴格冪等 (raw 跟 sanitized 不同就不能直接 join 還原), 但對 sanitized-only
    // 視角應該冪等
    const input = '你好\n[[SEND_EMOJI: 笑]]\n再見';
    const segs1 = sanitizeIntoSegments(input);
    const joinedSanitized = segs1.map((s) => s.sanitized).join('\n');
    const segs2 = sanitizeIntoSegments(joinedSanitized);
    // segs2 的 sanitized 應該等於 segs1 的 sanitized (經過一次 emoji 替換後已經是
    // [表情：笑] placeholder, 再過一遍 sanitize 不會變)
    expect(segs2.map((s) => s.sanitized)).toEqual(segs1.map((s) => s.sanitized));
  });
});

// 引用標籤獨佔一行是提示詞教出來的常見形態（回覆開頭寫 [[QUOTE:]]）。banner 側會把它
// 剝空，早先整段連 raw 一起丟掉，引用關係就永遠到不了客戶端——這是唯一一類「角色發了
// 但用戶收不到」的內容。現在攢著順延到下一個文字段的 raw 開頭。
describe('sanitizeIntoSegments — 獨佔一行的引用不丟', () => {
  it('引用行順延到下一條文字段的 raw，banner 只顯示正文', () => {
    const segs = sanitizeIntoSegments('[[QUOTE: 我說的話]]\n消失了整整三十六個小時');
    expect(segs).toHaveLength(1);
    expect(segs[0].raw).toContain('[[QUOTE: 我說的話]]');
    expect(segs[0].raw).toContain('消失了整整三十六個小時');
    expect(segs[0].sanitized).toBe('消失了整整三十六個小時');
  });

  it('引用行後面隔著表情時，引用仍落到再後面的文字段上', () => {
    const segs = sanitizeIntoSegments('[[QUOTE: 我說的話]]\n[[SEND_EMOJI: 有點生氣]]\n你幹嘛去了');
    expect(segs.map((s) => s.sanitized)).toEqual(['[表情：有點生氣]', '你幹嘛去了']);
    expect(segs[0].raw).not.toContain('QUOTE');
    expect(segs[1].raw).toContain('[[QUOTE: 我說的話]]');
  });

  it('整條只有引用、沒有正文 → 沒東西可發，照舊不產 segment', () => {
    expect(sanitizeIntoSegments('[[QUOTE: 我說的話]]')).toEqual([]);
  });
});

// 「橫幅響了一下、點進去一個氣泡都沒有」的成因：worker 只認識白名單裡的標籤，模型現編的
// `[[擁抱]]` 原樣留著就被當成有內容照發；客戶端 chatParser.hasDisplayContent 剝光一切
// `[[...]]` 後判空，這一條不落庫。兩端判空口徑必須一致，橫幅數才等於氣泡數。
describe('sanitizeIntoSegments — 未知 [[標籤]] 不產生空氣泡的橫幅', () => {
  it('模型現編的未知標籤獨佔一行 → 整段丟掉，不發這條 push', () => {
    expect(sanitizeIntoSegments('你今天還好嗎\n[[擁抱]]'))
      .toEqual([{ raw: '你今天還好嗎', sanitized: '你今天還好嗎' }]);
    expect(sanitizeIntoSegments('[[輕輕抱住你]]')).toEqual([]);
  });

  it('未知標籤跟正文同一行 → 照舊發，客戶端那邊也有正文能成氣泡', () => {
    const segs = sanitizeIntoSegments('抱一下[[擁抱]]');
    expect(segs).toHaveLength(1);
    expect(segs[0].raw).toBe('抱一下[[擁抱]]');
  });

  it('被丟掉的未知標籤段不吃掉攢著的引用，引用繼續順延到後面的正文', () => {
    const segs = sanitizeIntoSegments('[[QUOTE: 我說的話]]\n[[擁抱]]\n我在的');
    expect(segs).toHaveLength(1);
    expect(segs[0].raw).toContain('[[QUOTE: 我說的話]]');
    expect(segs[0].sanitized).toBe('我在的');
  });
});

describe('SEND_EMOJI 全角冒號容錯', () => {
  it('[[SEND_EMOJI：xx]] 當表情段處理，raw 按半角規範形態給客戶端', () => {
    expect(sanitizeIntoSegments('[[SEND_EMOJI：抱抱]]'))
      .toEqual([{ raw: '[[SEND_EMOJI: 抱抱]]', sanitized: '[表情：抱抱]' }]);
    expect(sanitizeIntoSegments('你看 [[SEND_EMOJI：笑]] 我沒事的').map((s) => s.sanitized))
      .toEqual(['你看', '[表情：笑]', '我沒事的']);
  });

  it('notification 終態路徑同樣認全角冒號', () => {
    expect(sanitizeForNotification('[[SEND_EMOJI：抱抱]]')).toBe('[表情：抱抱]');
  });
});
