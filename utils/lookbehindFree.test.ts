/**
 * lookbehind-free 改寫對照測試
 *
 * 背景: 正則後行斷言 (?<=) / (?<!) 在 iOS Safari < 16.4 (WebKit/JSC) 不支持,
 *   舊設備上 `new RegExp('(?<=…)')` 直接拋 "Invalid regular expression:
 *   invalid group specifier name", 被聊天兜底 catch 包成 "[連接中斷: …]" 彈給用戶。
 *   見 utils/chatParser.ts / sanitize.ts / GroupChat.tsx 等 8 處。
 *
 * 策略: 這裡把每處「舊 lookbehind 寫法」當 oracle, 「新 lookahead 寫法」當 candidate,
 *   在支持 lookbehind 的 Node/V8 裡跑一批覆蓋性輸入, 斷言兩者逐字節一致。
 *   舊寫法只存在於本測試文件 (oracle), 源碼裡已全部清除 (見 no-lookbehind 守衛)。
 *
 * 注意: oracle 用的 lookbehind 正則本身會讓 <16.4 的 JSC 解析失敗, 但本測試只在
 *   CI / 開發機的 Node 上跑, 不進 bundle, 所以無所謂。
 */
import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 1) CJK 分氣泡: chatParser.chunkText / sanitize.chunkText
//    舊: split(/(?<=[CJK])\s+(?=[CJK])/)  ——「夾在兩個 CJK 之間的空格」處斷開
//    新: 把左側 CJK 捕獲進來, 用換行哨兵標記切點, 再 split
// ─────────────────────────────────────────────────────────────────────────────
const CJK =
  '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3000-\\u303f\\uff00-\\uffef\\u2000-\\u206f\\u2e80-\\u2eff\\u3001-\\u3003\\u2018-\\u201f\\u300a-\\u300f\\uff01-\\uff0f\\uff1a-\\uff20';

const oracleCjkSplit = (chunk: string): string[] => {
  const re = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`);
  return chunk.split(re);
};

// candidate: lookahead-only。左側 CJK 用捕獲組吃進來再用 $1 補回, 右側保持零寬 lookahead。
// 哨兵用 U+241F (␟, Unit Separator 的可見符號), 正文裡不會出現, 且肉眼可見 —— 別用裸 \0,
// 那東西不可見、會汙染 shell、Read 還會把它顯示成普通空格 (本測試就被這坑過一次)。
const SPLIT_SENTINEL = '␟';
const candidateCjkSplit = (chunk: string): string[] => {
  const re = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');
  return chunk.replace(re, `$1${SPLIT_SENTINEL}`).split(SPLIT_SENTINEL);
};

describe('CJK 分氣泡: lookahead 改寫與 lookbehind 等價', () => {
  const cases = [
    '你好 世界',           // 基本: 一個空格夾在兩漢字間
    '中 文 字',            // 連續單字: 必須切成三段, 不能漏 (codex 提的坑)
    '中  文',              // 多個空格
    'hello world',         // 純英文: 不該切
    '你好 world 再見',      // 中英混: 中-英 不切, 英-中 不切, 只切 中-中? (空格右邊是 w 非 CJK)
    '句號。 下一句',        // 標點也在 CJK 集合裡
    '   ',                 // 全空格
    '',                    // 空串
    '單',                  // 單字符
    'a 中',                // 英-中 (左非 CJK, 不切)
    '中 a',                // 中-英 (右非 CJK, 不切)
    '你好	世界',          // tab 分隔
    '我 是 誰 啊 喂',       // 多個連續單字
  ];
  for (const input of cases) {
    it(`等價: ${JSON.stringify(input)}`, () => {
      expect(candidateCjkSplit(input)).toEqual(oracleCjkSplit(input));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) GroupChat 分氣泡: 左右字符集不同 (左含標點全集, 右只含漢字兩段)
//    舊: split(/(?<=[左CJK])\s+(?=[右CJK])/)
// ─────────────────────────────────────────────────────────────────────────────
const GC_LEFT =
  '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3000-\\u303f\\uff00-\\uffef\\u2000-\\u206f\\u2e80-\\u2eff\\u3001-\\u3003\\u2018-\\u201f\\u300a-\\u300f\\uff01-\\uff0f\\uff1a-\\uff20';
const GC_RIGHT = '\\u4e00-\\u9fff\\u3400-\\u4dbf';

const oracleGroupSplit = (text: string): string[] => {
  const re = new RegExp(`(?<=[${GC_LEFT}])\\s+(?=[${GC_RIGHT}])`);
  return text.split(re);
};
const candidateGroupSplit = (text: string): string[] => {
  const re = new RegExp(`([${GC_LEFT}])\\s+(?=[${GC_RIGHT}])`, 'g');
  return text.replace(re, `$1${SPLIT_SENTINEL}`).split(SPLIT_SENTINEL);
};

describe('GroupChat 分氣泡: 左右範圍不同也等價', () => {
  const cases = [
    '你好 世界',
    '中 文 字',
    '句號。 中文',        // 左標點 + 右漢字: 切
    '句號。 ！',          // 右是全角標點 (在左集但不在右集): 不切
    '中 文',
    '我 是 誰 啊 喂',
    '中 a 文',            // 中-英不切, 英-中不切
    '',
    '中',
  ];
  for (const input of cases) {
    it(`等價: ${JSON.stringify(input)}`, () => {
      expect(candidateGroupSplit(input)).toEqual(oracleGroupSplit(input));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) memoryPalace/migration 句末切句
//    舊: split(/(?<=[。！？!?])\s*|\n+/)  —— 句末標點後切 (標點留給前句), 或換行切
//    新: 先用佔位把 \n 段統一, 標點切點同樣靠"捕獲標點 + 哨兵"
// ─────────────────────────────────────────────────────────────────────────────
const oracleSentenceSplit = (summary: string): string[] =>
  summary
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

// candidate: 兩個 alternation 分支分別處理。
//   分支 A「(?<=[標點])\s*」: 在標點後(含可選空白)切, 標點留前句 → 捕獲標點 + 哨兵 + 吃掉隨後的 \s*
//   分支 B「\n+」: 直接切
const candidateSentenceSplit = (summary: string): string[] => {
  const marked = summary
    .replace(/([。！？!?])\s*/g, `$1${SPLIT_SENTINEL}`)
    .replace(/\n+/g, SPLIT_SENTINEL);
  return marked
    .split(SPLIT_SENTINEL)
    .map((s) => s.trim())
    .filter(Boolean);
};

describe('句末切句: 等價', () => {
  const cases = [
    '今天去爬山了。天氣很好！你呢?',
    '第一句。\n第二句。\n\n第三句',
    '沒有標點的一長句話',
    '混合。 帶空格 ！ 帶換行\n結尾',
    'Hello. World! How are you?',
    '',
    '。。。',
    '結尾標點。',
    '中間\n\n\n多換行',
  ];
  for (const input of cases) {
    it(`等價: ${JSON.stringify(input)}`, () => {
      expect(candidateSentenceSplit(input)).toEqual(oracleSentenceSplit(input));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) dateResolver: (?<![\d年]) 前向否定 —— 候選月/月日前面不能緊跟數字或"年"
//    舊: matchAll(/(?<![\d年])(\d{1,2}|[一二三四五六七八九十]+)\s*月.../gu)
//    新: 去掉 lookbehind, 改成匹配後用 m.index 檢查前一字符, 不滿足則跳過 (codex 提的法子)
//    這裡驗證「保留集合」逐字節一致: 對同一 query, 兩種方法篩出的 (值, index) 列表相同。
// ─────────────────────────────────────────────────────────────────────────────
type Hit = { v1: string; v2?: string; index: number };

const oracleMonthDay = (query: string): Hit[] => {
  const out: Hit[] = [];
  for (const m of query.matchAll(
    /(?<![\d年])(\d{1,2}|[一二三四五六七八九十]+)\s*月\s*(\d{1,2}|[一二三四五六七八九十]+)\s*[日号號]/gu,
  )) {
    out.push({ v1: m[1], v2: m[2], index: m.index ?? 0 });
  }
  return out;
};
const candidateMonthDay = (query: string): Hit[] => {
  const out: Hit[] = [];
  for (const m of query.matchAll(
    /(\d{1,2}|[一二三四五六七八九十]+)\s*月\s*(\d{1,2}|[一二三四五六七八九十]+)\s*[日号號]/gu,
  )) {
    const index = m.index ?? 0;
    if (index > 0 && /[\d年]/u.test(query[index - 1])) continue; // 模擬 (?<![\d年])
    out.push({ v1: m[1], v2: m[2], index });
  }
  return out;
};

const oracleMonth = (query: string): Hit[] => {
  const out: Hit[] = [];
  for (const m of query.matchAll(
    /(?<![\d年])(\d{1,2}|[一二三四五六七八九十]+)\s*月(?![\d日号號份一二三四五六七八九十])/gu,
  )) {
    out.push({ v1: m[1], index: m.index ?? 0 });
  }
  return out;
};
const candidateMonth = (query: string): Hit[] => {
  const out: Hit[] = [];
  for (const m of query.matchAll(
    /(\d{1,2}|[一二三四五六七八九十]+)\s*月(?![\d日号號份一二三四五六七八九十])/gu,
  )) {
    const index = m.index ?? 0;
    if (index > 0 && /[\d年]/u.test(query[index - 1])) continue;
    out.push({ v1: m[1], index });
  }
  return out;
};

describe('dateResolver: m.index 檢查與 lookbehind 等價', () => {
  const cases = [
    '3月4號',
    '12月15日',
    '去年3月4號',         // "年"在前 → 舊的被 (?<!年) 拒, 新的也得拒
    '2024年3月',          // 年前綴
    '13月4號',            // 月份非法但正則仍匹配 (篩選在業務層)
    '我想查3月的事',
    '3月 和 5月6號',
    '第3月',              // 前面是"第"(非數字非年) → 應保留
    '20240304',           // 純數字無月
    '十二月三十一號',
    '前面有2然後3月',      // "2"非緊鄰? "然後3月" → 3 前是"後", 保留
    '23月',               // 2 緊鄰 3 → 舊 lookbehind 在 "3月" 處前一字符是 "2"(數字) 應拒
    // 以下專門壓「matchAll 消費跳過」: 候選 A 被前綴拒絕後, 緊挨的候選 B 不能被 A 的匹配吞掉
    '1月2月',             // "1月"前是行首應留; "2月"前是"月"(非數字非年)應留 → 兩個都中
    '5月3月4號',          // "5月"留; 緊跟"3月4號"前是"月"應留
    '12月34號56號',       // 連續日號
    '年3月',              // "年"緊貼 → 拒; 但行首"年"本身不參與
    '3月4月5月',          // 三連月, 全應保留
    '99月88號77月',       // 全非法值但匹配, 測純切分一致性
  ];
  for (const input of cases) {
    it(`月日等價: ${JSON.stringify(input)}`, () => {
      expect(candidateMonthDay(input)).toEqual(oracleMonthDay(input));
    });
    it(`孤立月等價: ${JSON.stringify(input)}`, () => {
      expect(candidateMonth(input)).toEqual(oracleMonth(input));
    });
  }
});

// dateResolver: 有意偏離舊 lookbehind 的 case (順手修了舊 bug, 不強行等價)
//
// 舊 lookbehind 寫法有個隱藏 bug: 當中文數字是多字符貪婪串 (如"十二月") 且前面緊跟 年/數字時,
// (?<![\d年]) 在首字"十"處拒絕後, 正則引擎會從"二"重試, 貪婪量詞 [一二三…]+ 只夠匹配"二",
// 於是把"十二月"錯誤肢解成"二月"去檢索記憶 —— 這是 bug。
// 新寫法 (matchAll 一次性貪婪吃掉"十二月" + idx-1 檢查) 會整條跳過, 不再摳出假的"二月"。
// 這類輸入本就該由前面的 case 5「絕對年月」(\d{2,4}年\d{1,2}月) 處理, case 8 這個 fallback 不該插手。
// 所以這裡斷言新行為 (整條跳過), 不和舊 oracle 比。
describe('dateResolver: 順手修正舊 lookbehind 的"短匹配回退"bug', () => {
  const cases: Array<[string, Hit[]]> = [
    ['2024年十二月', []],   // 舊: 摳出"二月"(idx6); 新: 跳過 (該走絕對年月 case)
    ['今年三四月', []],      // 舊: 摳出"四月"(idx3); 新: 跳過
    ['x1十二月', []],        // 舊: 摳出"二月"(idx3); 新: 跳過 (數字前綴也觸發)
    ['去年十二月', []],      // 舊: 摳出"二月"(idx3); 新: 跳過 (該走相對年月)
  ];
  for (const [input, expected] of cases) {
    it(`孤立月不再肢解: ${JSON.stringify(input)}`, () => {
      expect(candidateMonth(input)).toEqual(expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) scheduleGenerator: 數未轉義引號
//    舊: s.match(/(?<!\\)"/g)?.length —— 前面不是反斜槓的引號個數
//    注意: 舊寫法對 \\" (偶數反斜槓, 即轉義的反斜槓 + 真引號) 會誤判成"已轉義",
//         所以新寫法不追求和舊寫法字節一致, 而是追求"正確": 數引號前連續反斜槓, 偶數才算未轉義。
//    這裡測「新寫法在舊寫法正確的場景下與之一致」+「新寫法修正了舊寫法的 bug」。
// ─────────────────────────────────────────────────────────────────────────────
const oracleUnescapedQuoteCount = (s: string): number =>
  (s.match(/(?<!\\)"/g) || []).length;

// 新: 掃描器。數每個 " 前連續反斜槓數量, 偶數(含0) → 未轉義。
const countUnescapedQuotes = (s: string): number => {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue;
    let backslashes = 0;
    let j = i - 1;
    while (j >= 0 && s[j] === '\\') {
      backslashes++;
      j--;
    }
    if (backslashes % 2 === 0) count++;
  }
  return count;
};

describe('未轉義引號計數', () => {
  it('與舊寫法在簡單場景一致', () => {
    const simple = ['"abc"', 'no quotes', '\\"escaped\\"', 'a"b"c', '""'];
    for (const s of simple) {
      expect(countUnescapedQuotes(s)).toBe(oracleUnescapedQuoteCount(s));
    }
  });
  it('修正舊寫法對偶數反斜槓的誤判', () => {
    // 字符串字面量 '\\\\"' = 反斜槓 + 反斜槓 + 引號 = 轉義的反斜槓後跟真引號 → 應算"未轉義"(1)
    const tricky = '\\\\"';
    expect(countUnescapedQuotes(tricky)).toBe(1);   // 新: 正確
    expect(oracleUnescapedQuoteCount(tricky)).toBe(0); // 舊: 誤判為已轉義
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) JournalRichText: 單星斜體 (區分 *斜體* 與 **粗體**)
//    舊: rest.match(/(?<!\*)\*([^*]+)\*(?!\*)/) —— 左右都不是星號的單星
//    新: (^|[^*])\* …, 命中後 idx/len 要減去前綴字符 it[1]
// ─────────────────────────────────────────────────────────────────────────────
type ItalicHit = { idx: number; len: number; inner: string } | null;

const oracleItalic = (rest: string): ItalicHit => {
  const it = rest.match(/(?<!\*)\*([^*]+)\*(?!\*)/);
  if (it && it.index !== undefined) {
    return { idx: it.index, len: it[0].length, inner: it[1] };
  }
  return null;
};
const candidateItalic = (rest: string): ItalicHit => {
  const it = rest.match(/(^|[^*])\*([^*]+)\*(?!\*)/);
  if (it && it.index !== undefined) {
    const offset = it[1].length; // 前綴 (^ 時為 '' 長度0, [^*] 時為 1)
    return { idx: it.index + offset, len: it[0].length - offset, inner: it[2] };
  }
  return null;
};

describe('斜體單星: 前綴捕獲改寫與 lookbehind 等價', () => {
  const cases = [
    '*斜體*',
    '行首*斜體*尾',
    'a*斜體*b',
    '**粗體**',           // 不該被斜體命中
    '**粗**和*斜*',        // 混合: 單星應命中"斜"
    '沒有星號',
    '*單邊',              // 不閉合
    '* 空格星',
    '前綴*x*',
    '*a* *b*',            // 多個, match 取第一個
  ];
  for (const input of cases) {
    it(`等價: ${JSON.stringify(input)}`, () => {
      expect(candidateItalic(input)).toEqual(oracleItalic(input));
    });
  }
});
