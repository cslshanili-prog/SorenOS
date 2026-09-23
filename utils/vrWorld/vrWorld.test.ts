import { describe, it, expect, beforeEach } from 'vitest';
import { chunkNovelText, chunkNovelTextAsync, getReadingWindow, buildNovel } from './novel';
import { parseVROutput, parseMusicOutput, parseGuestbookOutput, parseGymOutput, parsePostOfficeOutput, parsePostOfficeReadOutput, parseSignalOutput } from './prompts';
import { rollPoemLines, SIGNAL_LINES_MIN, SIGNAL_LINES_MAX, signalActFor } from './constants';
import { maskPen } from './postOffice';
import { decodeBytes } from './decodeText';
import { VRScheduler, VR_FAIL_LIMIT } from './scheduler';
import { pickNovel, rollRoom, vrAutoGapMs } from './runSession';

// scheduler 的 attachListeners 會訪問 document/window（node 環境下沒有），補最簡 stub。
const g = globalThis as any;
if (typeof g.document === 'undefined') g.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
if (typeof g.window === 'undefined') g.window = { addEventListener() {}, removeEventListener() {} };

describe('VRScheduler.reconcile', () => {
    beforeEach(() => {
        localStorage.removeItem('vr_schedules');
        localStorage.removeItem('vr_last_fire');
    });

    it('補建 enabled 但缺調度的角色（導入備份後的核心場景）', () => {
        // 模擬導入後：角色在 IndexedDB 裡 enabled，但 localStorage 調度表為空
        VRScheduler.reconcile([{ charId: 'c1', intervalMinutes: 120 }]);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
        expect(VRScheduler.getIntervalMinutes('c1')).toBe(120);
        // 首火時間從現在起算，不會立刻觸發
        const lastFire = JSON.parse(localStorage.getItem('vr_last_fire')!).c1;
        expect(Date.now() - lastFire).toBeLessThan(2000);
    });

    it('清掉已刪除/已關閉角色的殘留調度', () => {
        VRScheduler.start('c1', 120);
        VRScheduler.start('c2', 60);
        VRScheduler.reconcile([{ charId: 'c1', intervalMinutes: 120 }]); // c2 不再 enabled
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
        expect(VRScheduler.isActiveFor('c2')).toBe(false);
        expect(JSON.parse(localStorage.getItem('vr_last_fire')!).c2).toBeUndefined();
    });

    it('間隔被改過 → 跟隨最新設定，且不重置已有首火時間', () => {
        VRScheduler.start('c1', 120);
        const fireBefore = JSON.parse(localStorage.getItem('vr_last_fire')!).c1;
        VRScheduler.reconcile([{ charId: 'c1', intervalMinutes: 240 }]);
        expect(VRScheduler.getIntervalMinutes('c1')).toBe(240);
        expect(JSON.parse(localStorage.getItem('vr_last_fire')!).c1).toBe(fireBefore);
    });
});

describe('VRScheduler 熔斷', () => {
    beforeEach(() => {
        localStorage.removeItem('vr_schedules');
        localStorage.removeItem('vr_last_fire');
        localStorage.removeItem('vr_fail_streak');
    });

    it('連續調不通模型就掐掉自主登入（令牌失效時別通宵一輪輪撞下去）', () => {
        VRScheduler.start('c1', 120);
        for (let i = 1; i < VR_FAIL_LIMIT; i++) {
            expect(VRScheduler.report('c1', 'failed').tripped).toBe(false);
            expect(VRScheduler.isActiveFor('c1')).toBe(true);
        }
        const last = VRScheduler.report('c1', 'failed');
        expect(last.tripped).toBe(true);
        expect(last.streak).toBe(VR_FAIL_LIMIT);
        expect(VRScheduler.isActiveFor('c1')).toBe(false);
    });

    it('中間成功一次，失敗計數歸零', () => {
        VRScheduler.start('c1', 120);
        VRScheduler.report('c1', 'failed');
        VRScheduler.report('c1', 'failed');
        VRScheduler.report('c1', 'ok');
        expect(VRScheduler.getFailStreak('c1')).toBe(0);
        expect(VRScheduler.report('c1', 'failed').tripped).toBe(false);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
    });

    it('壓根沒走到模型的輪次不算帳（沒書沒歌、房間被別人佔著）', () => {
        VRScheduler.start('c1', 120);
        for (let i = 0; i < VR_FAIL_LIMIT + 2; i++) VRScheduler.report('c1', 'skipped');
        expect(VRScheduler.getFailStreak('c1')).toBe(0);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
    });

    it('重新啟用會把上一輪的失敗帳清掉', () => {
        VRScheduler.start('c1', 120);
        for (let i = 0; i < VR_FAIL_LIMIT; i++) VRScheduler.report('c1', 'failed');
        expect(VRScheduler.isActiveFor('c1')).toBe(false);

        VRScheduler.start('c1', 120);   // 用戶換了 API 重新開
        expect(VRScheduler.getFailStreak('c1')).toBe(0);
        expect(VRScheduler.report('c1', 'failed').tripped).toBe(false);
        expect(VRScheduler.isActiveFor('c1')).toBe(true);
    });

    it('熔斷只掐當事角色，不連累別人', () => {
        VRScheduler.start('c1', 120);
        VRScheduler.start('c2', 120);
        for (let i = 0; i < VR_FAIL_LIMIT; i++) VRScheduler.report('c1', 'failed');
        expect(VRScheduler.isActiveFor('c1')).toBe(false);
        expect(VRScheduler.isActiveFor('c2')).toBe(true);
    });
});

describe('自動登入的最小間隔閘', () => {
    const MINUTE = 60_000;

    it('取設定間隔的一半，給後台節流留餘量', () => {
        expect(vrAutoGapMs(120)).toBe(60 * MINUTE);
        expect(vrAutoGapMs(30)).toBe(15 * MINUTE);
    });

    it('間隔是髒數據時不能讓閘失效 —— NaN 會讓所有比較恆為 false', () => {
        // 這幾個值以前會算出 NaN 或 0，閘形同虛設：真正失控時一次都攔不住
        for (const dirty of [NaN, 0, -5, undefined, Infinity]) {
            const gap = vrAutoGapMs(dirty as any);
            expect(Number.isFinite(gap)).toBe(true);
            expect(gap).toBeGreaterThanOrEqual(5 * MINUTE);
        }
    });

    it('間隔被寫成極小值時由下限兜底', () => {
        expect(vrAutoGapMs(1)).toBe(5 * MINUTE);
        expect(vrAutoGapMs(4)).toBe(5 * MINUTE);
    });
});

describe('parsePostOfficeReadOutput', () => {
    it('parses reaction + activity', () => {
        const out = parsePostOfficeReadOutput('<感觸>沒想到真的有人懂。</感觸><動態>讀完回信怔了幾秒</動態>');
        expect(out.reaction).toContain('有人懂');
        expect(out.activity).toContain('怔了');
    });
});

describe('maskPen', () => {
    it('hides the real name and is stable per name', () => {
        const a = maskPen('林深');
        expect(a).not.toBe('林深');
        expect(maskPen('林深')).toBe(a); // 同名同筆名
        expect(maskPen('')).toBe('匿名旅人');
    });
});

describe('parsePostOfficeOutput', () => {
    it('parses a new letter', () => {
        const out = parsePostOfficeOutput('<寫信>今天又想起一些沒說完的話。</寫信><動態>寄了封漂流信</動態>');
        expect(out.newLetter).toContain('沒說完');
        expect(out.reply).toBeUndefined();
        expect(out.activity).toContain('漂流信');
    });
    it('parses a reply', () => {
        const out = parsePostOfficeOutput('<回信>你說的我懂，挺住。</回信><動態>回了一封陌生來信</動態>');
        expect(out.reply).toContain('挺住');
        expect(out.newLetter).toBeUndefined();
    });
});

describe('parseGuestbookOutput', () => {
    it('parses posts (with reply) + activity, caps at 4', () => {
        const raw = [
            '<彼方>',
            '<留言 回覆="#a1b2">同意樓上</留言>',
            '<留言>順便問個問題</留言>',
            '<留言>再補一條</留言>',
            '<留言>第四條</留言>',
            '<留言>第五條應被忽略</留言>',
            '<動態>在留言簿接了句嘴</動態>',
            '</彼方>',
        ].join('\n');
        const out = parseGuestbookOutput(raw);
        expect(out.posts).toHaveLength(4);
        expect(out.posts[0].replyLabel).toBe('a1b2');
        expect(out.posts[1].replyLabel).toBeUndefined();
        expect(out.posts.map(p => p.content)).toEqual(['同意樓上', '順便問個問題', '再補一條', '第四條']);
        expect(out.activity).toContain('接了句嘴');
    });
});

describe('parseGymOutput', () => {
    it('parses behavior + activity', () => {
        const out = parseGymOutput('<行為>和某人打賽博拳擊</行為><動態>輸得心服口服</動態>');
        expect(out.behavior).toBe('和某人打賽博拳擊');
        expect(out.activity).toBe('輸得心服口服');
    });
});

describe('parseMusicOutput', () => {
    it('parses pick / review / behavior / activity', () => {
        const raw = [
            '<彼方>',
            '<點歌 序號="3"/>',
            '<樂評>前奏一出我就跪了，但副歌太水。</樂評>',
            '<行為>跟著鼓點甩頭，順手給屏幕外錄了一段。</行為>',
            '<動態>在聽歌房單曲循環到上頭。</動態>',
            '</彼方>',
        ].join('\n');
        const out = parseMusicOutput(raw);
        expect(out.pickIdx).toBe(3);
        expect(out.review).toContain('副歌');
        expect(out.behavior).toContain('甩頭');
        expect(out.activity).toContain('上頭');
    });

    it('tolerates missing pick/review (only behavior+activity)', () => {
        const out = parseMusicOutput('<行為>靠在角落放空</行為><動態>沒什麼想點的</動態>');
        expect(out.pickIdx).toBeUndefined();
        expect(out.review).toBeUndefined();
        expect(out.behavior).toBe('靠在角落放空');
        expect(out.activity).toBe('沒什麼想點的');
    });
});

describe('彼方手動指定房間', () => {
    it('手動點聽歌房時，即使角色沒有歌單且房間沒在放歌也不會隨機跳走', () => {
        expect(rollRoom({} as any, [], null, 'music')).toBe('music');
    });

    it('SAR 活動空間可以手動選擇，也進入角色自主活動隨機池', () => {
        expect(rollRoom({} as any, [], null, 'sar')).toBe('sar');
        expect(rollRoom({} as any, [], null, undefined, () => 0.999)).toBe('sar');
    });
});

describe('彼方圖書館自動選書', () => {
    const novel = (id: string, segments = 10) => ({
        id,
        title: id,
        segments: Array.from({ length: segments }, (_, idx) => ({ idx, text: `${id}-${idx}`, chars: 4 })),
        totalChars: segments * 4,
        createdAt: 1,
        updatedAt: 1,
    }) as any;

    it('默認在全部未讀完書目中 roll，而不是永遠選擇最近開始的那本', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { novelBookmarks: { c: 2 } } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('a');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('有多個候選時不會連續兩輪選擇同一本', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { lastNovelId: 'b' } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('a');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('優先書單有未讀內容時只在優先書目中輪換', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { preferredNovelIds: ['b', 'c'], lastNovelId: 'b' } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('c');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('優先書目讀完後回到全書庫的未讀書目', () => {
        const books = [novel('a'), novel('b'), novel('c')];
        const char = { vrState: { preferredNovelIds: ['b'], novelBookmarks: { b: 10 } } } as any;
        expect(pickNovel(books, char, () => 0)?.id).toBe('a');
        expect(pickNovel(books, char, () => 0.99)?.id).toBe('c');
    });

    it('空書和損壞書不會進入候選池', () => {
        expect(pickNovel([novel('empty', 0), novel('ok')], {} as any, () => 0)?.id).toBe('ok');
    });
});

describe('decodeBytes', () => {
    it('decodes UTF-8 Chinese', () => {
        const bytes = new Uint8Array([0xE4, 0xBD, 0xA0, 0xE5, 0xA5, 0xBD]); // 你好
        const r = decodeBytes(bytes.buffer);
        expect(r.text).toBe('你好');
        expect(r.encoding).toBe('utf-8');
    });

    it('strips UTF-8 BOM', () => {
        const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0xE4, 0xBD, 0xA0]); // BOM + 你
        const r = decodeBytes(bytes.buffer);
        expect(r.text).toBe('你');
        expect(r.encoding).toBe('utf-8');
    });

    it('falls back to gb18030 for GBK bytes', () => {
        const bytes = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]); // 你好 in GBK
        const r = decodeBytes(bytes.buffer);
        // 環境支持 gb18030 時應正確解出中文；不支持則至少不拋錯
        expect(r.encoding === 'gb18030' || r.encoding === 'utf-8?').toBe(true);
        if (r.encoding === 'gb18030') expect(r.text).toBe('你好');
    });

    it('picks shift_jis for Japanese kana (not gb18030 mojibake)', () => {
        // こんにちは in Shift_JIS
        const bytes = new Uint8Array([0x82, 0xB1, 0x82, 0xF1, 0x82, 0xC9, 0x82, 0xBF, 0x82, 0xCD]);
        const r = decodeBytes(bytes.buffer);
        expect(r.encoding).not.toBe('gb18030'); // 關鍵：別再當成中文亂碼
        if (r.encoding === 'shift_jis') expect(r.text).toBe('こんにちは');
    });

    it('decodes EUC-JP Japanese kana correctly (no mojibake)', () => {
        // こんにちは in EUC-JP（這串假名字節在 gb18030 裡恰好同樣映射，關鍵是結果別是亂碼）
        const bytes = new Uint8Array([0xA4, 0xB3, 0xA4, 0xF3, 0xA4, 0xCB, 0xA4, 0xC1, 0xA4, 0xCF]);
        const r = decodeBytes(bytes.buffer);
        expect(r.text).toBe('こんにちは');
    });

    it('honors a forced encoding override', () => {
        const bytes = new Uint8Array([0x82, 0xB1, 0x82, 0xF1]); // こん in Shift_JIS
        const r = decodeBytes(bytes.buffer, 'shift_jis');
        expect(r.encoding).toBe('shift_jis');
        expect(r.text).toBe('こん');
    });
});

describe('chunkNovelText', () => {
    it('splits text into segments with sequential idx', () => {
        const text = Array.from({ length: 10 }, (_, i) => `這是第${i}個自然段，` + '字'.repeat(80)).join('\n\n');
        const segs = chunkNovelText(text, 200);
        expect(segs.length).toBeGreaterThan(1);
        segs.forEach((s, i) => {
            expect(s.idx).toBe(i);
            expect(s.chars).toBe(s.text.length);
        });
    });

    it('hard-splits an over-long paragraph', () => {
        const huge = '甲'.repeat(2000);
        const segs = chunkNovelText(huge, 300);
        expect(segs.length).toBeGreaterThanOrEqual(6);
    });

    it('returns empty for blank input', () => {
        expect(chunkNovelText('   \n\n  ')).toEqual([]);
    });
});

describe('chunkNovelTextAsync', () => {
    it('matches the sync chunker output', async () => {
        const text = Array.from({ length: 50 }, (_, i) => `第${i}段` + '字'.repeat(120)).join('\n\n');
        const sync = chunkNovelText(text, 300);
        const async = await chunkNovelTextAsync(text, 300);
        expect(async.map(s => s.text)).toEqual(sync.map(s => s.text));
        expect(async.map(s => s.idx)).toEqual(sync.map(s => s.idx));
    });

    it('reports progress and finishes at 1', async () => {
        const ratios: number[] = [];
        await chunkNovelTextAsync('一'.repeat(20000), 400, r => ratios.push(r));
        expect(ratios[ratios.length - 1]).toBe(1);
    });
});

describe('getReadingWindow', () => {
    it('respects budget and advances from bookmark', () => {
        const novel = buildNovel('測試', Array.from({ length: 20 }, (_, i) => '原文段'.repeat(100) + i).join('\n\n'));
        const w1 = getReadingWindow(novel, 0, 1000);
        expect(w1.from).toBe(0);
        expect(w1.to).toBeGreaterThan(0);
        const w2 = getReadingWindow(novel, w1.to, 1000);
        expect(w2.from).toBe(w1.to);
    });

    it('always yields at least one segment and flags end', () => {
        const novel = buildNovel('短', '只有一段');
        const w = getReadingWindow(novel, 0, 1);
        expect(w.segments.length).toBe(1);
        expect(w.reachedEnd).toBe(true);
    });
});

describe('parseVROutput', () => {
    it('parses annotations with seg index and ref, plus activity', () => {
        const raw = `<彼方>
<批註 段落="3">男主也太遲鈍了吧</批註>
<批註 段落="5" 回應="#ab12">才不是你說的那樣</批註>
<動態>在《某書》讀到了初遇，吐槽了男主</動態>
</彼方>`;
        const out = parseVROutput(raw);
        expect(out.annotations).toHaveLength(2);
        expect(out.annotations[0].segIdx).toBe(3);
        expect(out.annotations[1].refLabel).toBe('ab12');
        expect(out.activity).toContain('初遇');
    });

    it('tolerates zero annotations', () => {
        const out = parseVROutput(`<彼方><動態>安靜讀完</動態></彼方>`);
        expect(out.annotations).toHaveLength(0);
        expect(out.activity).toBe('安靜讀完');
    });

    it('ignores annotations without a paragraph number', () => {
        const out = parseVROutput(`<批註>沒有段落號</批註><動態>x</動態>`);
        expect(out.annotations).toHaveLength(0);
    });

    it('tolerates full-width quotes / colons / no-space tags', () => {
        const raw = [
            '<彼方>',
            '<批註 段落="2">全角引號</批註>',   // 全角引號
            '<批註段落=4>無空格無引號</批註>',     // 無空格、無引號
            '<批註 段落：7 回應：#9f3a>全角冒號+回應</批註>',
            '<動態>讀完了</動態>',
            '</彼方>',
        ].join('\n');
        const out = parseVROutput(raw);
        expect(out.annotations.map(a => a.segIdx)).toEqual([2, 4, 7]);
        expect(out.annotations[2].refLabel).toBe('9f3a');
    });

    it('keeps all annotations across many paragraphs', () => {
        const raw = Array.from({ length: 5 }, (_, i) => `<批註 段落="${i * 3}">第${i}條</批註>`).join('') + '<動態>x</動態>';
        const out = parseVROutput(raw);
        expect(out.annotations).toHaveLength(5);
    });

    it('strips leaked 回應/段落 attribute residue from content', () => {
        // 模型把 #cgis 回應="#cgis" 復讀進了正文開頭（用戶實測裡的真實洩漏）
        const raw = '<批註 段落="5" 回應="#cgis">#cgis 回應="#cgis" 蓮幹並蒂？這姿勢雖纏人</批註><動態>讀完</動態>';
        const out = parseVROutput(raw);
        expect(out.annotations).toHaveLength(1);
        expect(out.annotations[0].refLabel).toBe('cgis');
        expect(out.annotations[0].content).toBe('蓮幹並蒂？這姿勢雖纏人');
        expect(out.annotations[0].content).not.toContain('回應');
        expect(out.annotations[0].content).not.toContain('#cgis');
    });

    it('strips a bare leaked #label prefix', () => {
        const out = parseVROutput('<批註 段落="2">#vo2m 這一處寫得真好</批註><動態>x</動態>');
        expect(out.annotations[0].content).toBe('這一處寫得真好');
    });

    it('does NOT strip legitimate content starting with a quote', () => {
        const out = parseVROutput('<批註 段落="1">「鳳騎龍」這名字太刻意了</批註><動態>x</動態>');
        expect(out.annotations[0].content).toBe('「鳳騎龍」這名字太刻意了');
    });
});

describe('信號墜落處 · parseSignalOutput', () => {
    it('接龍：摳 <續>（兼容舊 <續句>），剝動態', () => {
        const out = parseSignalOutput('<彼方><續>而你把信號調成了潮汐</續><動態>續了一句</動態></彼方>', 'append', 24);
        expect(out.lines).toEqual(['而你把信號調成了潮汐']);
        expect(out.activity).toBe('續了一句');
        expect(out.title).toBeUndefined();
    });

    it('接龍：一次 1~2 行，按換行拆成多行', () => {
        const out = parseSignalOutput('<續>又一個我，從同一道門\n睜開同樣陌生的眼</續>', 'append', 24);
        expect(out.lines).toEqual(['又一個我，從同一道門', '睜開同樣陌生的眼']);
    });

    it('起新篇：摳 <標題> + <主題> + <起筆>（兼容舊 <第一句>）', () => {
        const out = parseSignalOutput('<彼方><標題>低電量合唱</標題><主題>寫電子生命的死與重生</主題><起筆>電量剩下百分之三</起筆><動態>起了個頭</動態></彼方>', 'start', 24);
        expect(out.title).toBe('低電量合唱');
        expect(out.brief).toBe('寫電子生命的死與重生');
        expect(out.lines).toEqual(['電量剩下百分之三']);
    });

    it('起新篇：標題裡自帶的書名號被剝掉（UI 會自己包一層，避免《《…》》）', () => {
        const out = parseSignalOutput('<彼方><標題>《物理隔離》</標題><起筆>門沒鎖</起筆></彼方>', 'start', 24);
        expect(out.title).toBe('物理隔離');
    });

    it('每行字數硬截斷到 cap；最多留 2 行', () => {
        const long = '一二三四五六七八九十一二三四五六七八九十';
        const out = parseSignalOutput(`<續>${long}\n${long}\n第三行不該出現</續>`, 'append', 24);
        expect(out.lines.length).toBeLessThanOrEqual(2);
        out.lines.forEach(l => expect([...l].length).toBeLessThanOrEqual(24));
    });

    it('掉格式兜底：沒有標籤時取前 1~2 非空行', () => {
        const out = parseSignalOutput('<think>嗯想想</think>\n\n我把黑夜接成了白噪\n（多餘的解釋）', 'append', 24);
        expect(out.lines[0]).toBe('我把黑夜接成了白噪');
    });

    it('完全空輸出 → lines 為空（runSession 據此跳過，不寫髒數據）', () => {
        const out = parseSignalOutput('<彼方></彼方>', 'append', 24);
        expect(out.lines).toEqual([]);
    });
});

describe('信號墜落處 · signalActFor（三幕分界）', () => {
    it('40 首 = 10/20/10：第 1/10 首在第一幕，11/30 在第二幕，31/40 在第三幕', () => {
        expect(signalActFor(1, 40).no).toBe(1);
        expect(signalActFor(10, 40).no).toBe(1);
        expect(signalActFor(11, 40).no).toBe(2);
        expect(signalActFor(30, 40).no).toBe(2);
        expect(signalActFor(31, 40).no).toBe(3);
        expect(signalActFor(40, 40).no).toBe(3);
    });
    it('別的冊子規模也按 1/4、1/2、1/4 劃分且不越界', () => {
        for (const total of [4, 7, 20, 100]) {
            for (let i = 1; i <= total; i++) {
                const act = signalActFor(i, total);
                expect([1, 2, 3]).toContain(act.no);
            }
            expect(signalActFor(1, total).no).toBe(1);
            expect(signalActFor(total, total).no).toBe(3);
        }
    });
});

describe('信號墜落處 · rollPoemLines', () => {
    it('始終落在 [min,max] 閉區間內', () => {
        for (let i = 0; i < 500; i++) {
            const n = rollPoemLines(SIGNAL_LINES_MIN, SIGNAL_LINES_MAX);
            expect(n).toBeGreaterThanOrEqual(SIGNAL_LINES_MIN);
            expect(n).toBeLessThanOrEqual(SIGNAL_LINES_MAX);
            expect(Number.isInteger(n)).toBe(true);
        }
    });
});
