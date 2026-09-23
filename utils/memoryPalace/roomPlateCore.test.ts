// utils/memoryPalace/roomPlateCore.test.ts
// 門牌整理上雲帶來的那個時間差：提示詞是拿**提交那一刻**的快照拼的，LLM 說的 `U0`
// 指的是快照裡的第 0 條；結果幾分鐘後才回來，這中間門牌可能已經被別的路徑動過
// （手動回填就在本地跑）。不重新對準標籤就直接合並，`U0` 會指到另一條認知上，
// 兩條認知的來歷（firstLearnedAt / sourceCount）被悄悄接錯——而且界面上完全看不出來。
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { mergeCloudPlateEntries, mergePlateEntries, remapBasedOnLabels } from './roomPlateCore';
import { PLATE_ENTRY_CAPS } from './types';
import type { PlateEntry } from './types';

const entry = (id: string, text: string, extra: Partial<PlateEntry> = {}): PlateEntry => ({
  id,
  text,
  firstLearnedAt: 1_000,
  updatedAt: 1_000,
  sourceCount: 1,
  ...extra,
});

describe('remapBasedOnLabels — 把 basedOn 從「提交時的標籤」改寫成「現在的標籤」', () => {
  it('門牌沒動過時是恆等變換', () => {
    const current = [entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ room: 'user_room', text: 'A+', basedOn: 'U1' }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current))
      .toEqual([{ room: 'user_room', text: 'A+', basedOn: 'U1' }]);
  });

  it('提交後前面插了一條 → 標籤跟著後移，指的還是同一條認知', () => {
    // 提交時：[pe_a, pe_b]，LLM 說 U1 = pe_b
    // 回來時：[pe_new, pe_a, pe_b]，pe_b 現在排第 2
    const current = [entry('pe_new', 'N'), entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ room: 'user_room', text: 'B+', basedOn: 'U1' }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current)[0].basedOn).toBe('U2');
  });

  // 迴歸守衛：這份結果拿的是舊快照，它「保留」的是一條已經不在了的認知。當新條目收
  // 進去就是原地復活，而門牌面板恰恰是用戶手刪的地方——刪完還眼看著它自己長回來。
  it('快照裡有、現在沒了（提交之後被刪掉）→ 整條丟掉，不許當新條目復活', () => {
    const current = [entry('pe_c', 'C')];
    const items = [
      { room: 'user_room', text: 'B+', basedOn: 'U1' },
      { room: 'user_room', text: 'C', basedOn: null },
    ];

    expect(
      remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current),
      '抹成 null 當新條目收的話，用戶剛刪掉的那條會帶著新 id 長回來',
    ).toEqual([{ room: 'user_room', text: 'C', basedOn: null }]);
  });

  it('標籤越界 / 前綴不對 / 不是數字 → 一律抹成 null', () => {
    const current = [entry('pe_a', 'A')];
    const ids = ['pe_a'];
    const bad = [
      { room: 'user_room', text: 'x', basedOn: 'U9' },
      { room: 'user_room', text: 'x', basedOn: 'B0' },
      { room: 'user_room', text: 'x', basedOn: 'Uabc' },
    ];
    for (const item of bad) {
      expect(remapBasedOnLabels('user_room', [item], ids, current)[0].basedOn).toBeNull();
    }
  });

  // 迴歸守衛：光禿禿的前綴是「不是數字」裡最坑的一種，因為 Number('') 是 0。
  it('模型把數字掉了（basedOn: "U"）→ 抹成 null，不許當成第 0 條', () => {
    const current = [entry('pe_first', '第一條', { firstLearnedAt: 100, sourceCount: 5 })];
    const items = [{ room: 'user_room', text: '一條毫不相干的新認知', basedOn: 'U' }];

    const aligned = remapBasedOnLabels('user_room', items, ['pe_first'], current);
    expect(aligned[0].basedOn, 'Number("") === 0，不顯式擋住就會指到快照第 0 條').toBeNull();

    // 落到合併上：當新條目收，不繼承第一條的來歷
    const merged = mergePlateEntries('user_room', current, aligned, 20_000);
    expect(merged[0].id).not.toBe('pe_first');
    expect(merged[0].firstLearnedAt).toBe(20_000);
  });
});

describe('mergeCloudPlateEntries — 護住提交之後才出現的條目', () => {
  it('迴歸守衛：等結果的這一兩分鐘裡新沉澱的條目不被整理結果淘汰', () => {
    // 提交時快照裡只有 pe_old；結果還沒回來，封盒又往門牌裡寫了 pe_fresh。
    // LLM 壓根沒見過 pe_fresh，它沒被重新輸出不等於「決定淘汰」。
    const snapshotIds = ['pe_old'];
    const current = [entry('pe_old', '小明住家裡'), entry('pe_fresh', '小明最近在學做飯')];
    const items = [{ text: '小明搬去和同學合租', basedOn: 'U0' }];

    expect(
      mergePlateEntries('user_room', current, items, 20_000).map(e => e.id),
      '照原樣合併的話 pe_fresh 被靜默抹掉——用戶看到剛沉澱的認知憑空消失',
    ).toEqual(['pe_old']);

    expect(mergeCloudPlateEntries('user_room', current, items, snapshotIds, 20_000, 0).map(e => e.id))
      .toEqual(['pe_old', 'pe_fresh']);
  });

  it('快照裡的條目照常淘汰（合併語義沒被削弱成只增不減）', () => {
    const current = [entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ text: 'A', basedOn: 'U0' }];

    expect(mergeCloudPlateEntries('user_room', current, items, ['pe_a', 'pe_b'], 20_000, 0).map(e => e.id))
      .toEqual(['pe_a']);
  });

  it('整理結果裡已經原樣保留過的新條目不重複收一次', () => {
    // pe_fresh 不在快照裡，但 LLM 恰好輸出了同樣的文本（沒標 basedOn）
    const current = [entry('pe_fresh', '小明最近在學做飯')];
    const items = [{ text: '小明最近在學做飯' }];

    expect(mergeCloudPlateEntries('user_room', current, items, [], 20_000, 0).map(e => e.id))
      .toEqual(['pe_fresh']);
  });

  // 迴歸守衛：原先是 [...merged, ...born].slice(0, cap)——整理結果佔滿上限時 born 被整批
  // 扔掉，日誌還寫著「下輪整理再收」。可它們的來源節點早就打過 digestedAt，不會再來第二
  // 次，那批認知就這麼永久沒了，而門牌上看不出少了什麼。
  it('整理結果佔滿上限時也要給快照之後新增的條目留位子', () => {
    const cap = PLATE_ENTRY_CAPS.user_room;
    const current = [entry('pe_fresh', '剛沉澱的')];
    const items = Array.from({ length: cap }, (_, i) => ({ text: `整理出來的第 ${i} 條` }));

    const merged = mergeCloudPlateEntries('user_room', current, items, [], 20_000, 0);
    expect(merged, '門牌不能被撐爆').toHaveLength(cap);
    expect(merged.some(e => e.id === 'pe_fresh'), '來源已消化，擠掉就是永久丟').toBe(true);
  });

  it('新增的條目再多也不許把整理結果整塊擠出去（一半封頂）', () => {
    const cap = PLATE_ENTRY_CAPS.user_room;
    const current = Array.from({ length: cap }, (_, i) => entry(`pe_fresh_${i}`, `剛沉澱的第 ${i} 條`));
    const items = Array.from({ length: cap }, (_, i) => ({ text: `整理出來的第 ${i} 條` }));

    const merged = mergeCloudPlateEntries('user_room', current, items, [], 20_000, 0);
    expect(merged).toHaveLength(cap);
    expect(merged.filter(e => e.id.startsWith('pe_fresh')), '粗糙候選不該反客為主')
      .toHaveLength(Math.floor(cap / 2));
  });

  // 迴歸守衛：門牌面板是人工糾錯的口子——蒸錯的事實一旦常駐，角色會自信地重複很久。
  // 用戶在等結果這幾分鐘裡把一條改對了，而這份結果照著改之前那份快照生成：照常合併
  // 就是把剛糾正的那條又蓋回舊說法，用戶看著自己敲的字變回原樣。
  it('快照之後被本地改過的條目，文本以本地那份為準', () => {
    const snapshotAt = 10_000;
    // pe_home 在快照之後被用戶改成了「小明搬去和同學合租了」（updatedAt 晚於快照時刻）
    const current = [entry('pe_home', '小明搬去和同學合租了', { firstLearnedAt: 100, updatedAt: 15_000, sourceCount: 5 })];
    const items = [{ text: '小明住家裡', basedOn: 'U0' }];

    const merged = mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, snapshotAt);
    expect(merged[0].text, '用戶剛改對的事實被一份陳舊結果蓋回去了').toBe('小明搬去和同學合租了');
    // 條目本身照常參與這一輪：來歷留著，沒被當成新條目重開
    expect(merged[0].id).toBe('pe_home');
    expect(merged[0].firstLearnedAt).toBe(100);
  });

  // 迴歸守衛：快照時刻原先取的是**提交那一刻**，而門牌是更早讀出來的——中間還夾著拼身份
  // 上下文、探測這台 worker 認不認識後台任務（要發一次請求）、把消化剛提交的候選先保底
  // 並進去。用戶在這幾秒裡改的字 LLM 根本沒看到，卻因為 updatedAt 早於提交時刻被判成
  // 「LLM 見過」，於是被一份陳舊結果原樣蓋回去。
  it('改動落在「讀完門牌、還沒提交」那幾秒裡，同樣算本地改過', () => {
    const readAt = 10_000;       // 門牌是這一刻讀出來的
    const submittedAt = 13_000;  // 三秒後才交上去
    const current = [entry('pe_home', '小明搬去和同學合租了', { firstLearnedAt: 100, updatedAt: 11_500 })];
    const items = [{ text: '小明住家裡', basedOn: 'U0' }];

    expect(
      mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, submittedAt)[0].text,
      '按提交時刻算就會漏掉這一段的編輯',
    ).toBe('小明住家裡');
    expect(mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, readAt)[0].text)
      .toBe('小明搬去和同學合租了');
  });

  // 迴歸守衛：交雲端之前，送達保證會先把消化剛提交的候選機械並進門牌（fallbackMergeSubmissions），
  // 那批的 updatedAt 就是併入那一刻、必然晚於快照。把它們也當成「本地改過」的話，雲端整理
  // 把粗糙候選改寫成人話的結果會被原樣退回去——而改寫它們正是那一輪整理最主要的目的。
  it('從建出來就沒被改過的條目照常被結果改寫（保底併入的那批不算本地編輯）', () => {
    const rescued = entry('pe_raw', '父母離異', { firstLearnedAt: 12_000, updatedAt: 12_000 });
    const items = [{ text: '小明的父母在他初中時離異，他跟著母親', basedOn: 'U0' }];

    const merged = mergeCloudPlateEntries('user_room', [rescued], items, ['pe_raw'], 20_000, 10_000);
    expect(merged[0].text, '粗糙候選沒被改寫，整理白跑一輪').toBe('小明的父母在他初中時離異，他跟著母親');
    expect(merged[0].id).toBe('pe_raw');
  });

  // 結果遲到太久 / 記號被 TTL 收走 / 換了設備：快照時刻無從查起。那時候按「誰都可能被
  // 改過」保守處理——有過改動痕跡的一律留本地文本，沒被碰過的照常讓結果改寫。
  it('快照時刻問不到（傳 0）時，被改過的條目一律留本地文本', () => {
    const edited = entry('pe_edited', '用戶手改過的說法', { firstLearnedAt: 100, updatedAt: 9_000 });
    const untouched = entry('pe_plain', '沒人碰過的說法', { firstLearnedAt: 100, updatedAt: 100 });
    const items = [
      { text: '結果裡的說法 A', basedOn: 'U0' },
      { text: '結果裡的說法 B', basedOn: 'U1' },
    ];

    const merged = mergeCloudPlateEntries('user_room', [edited, untouched], items, ['pe_edited', 'pe_plain'], 20_000, 0);
    expect(merged[0].text).toBe('用戶手改過的說法');
    expect(merged[1].text).toBe('結果裡的說法 B');
  });

  it('提交之前就是那個樣子的條目照常被結果改寫（別把保護做成誰都不許動）', () => {
    const current = [entry('pe_home', '小明住家裡', { firstLearnedAt: 100, updatedAt: 5_000 })];
    const items = [{ text: '小明搬去和同學合租了', basedOn: 'U0' }];

    const merged = mergeCloudPlateEntries('user_room', current, items, ['pe_home'], 20_000, 10_000);
    expect(merged[0].text).toBe('小明搬去和同學合租了');
    expect(merged[0].id).toBe('pe_home');
  });

  it('沒帶 basedOn 的原樣穿過去', () => {
    const items = [{ room: 'user_room', text: 'x' }, { room: 'user_room', text: 'y', basedOn: null }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a'], [entry('pe_a', 'A')])).toEqual(items);
  });

  // 這條是整件事的意義所在：不重映射會怎樣。
  it('迴歸守衛：不重映射就會把來歷接到另一條認知上', () => {
    // 提交時快照：[pe_home（住家裡）, pe_job（在讀研）]，LLM 要更新 U0「住家裡」
    const snapshotIds = ['pe_home', 'pe_job'];
    const items = [{ room: 'user_room', text: '小明搬去和同學合租', basedOn: 'U0' }];
    // 結果回來時 pe_home 已經排到第 1（前面插進來一條別的）
    const current = [
      entry('pe_new', '小明養了只貓', { firstLearnedAt: 9_000, sourceCount: 1 }),
      entry('pe_home', '小明住家裡', { firstLearnedAt: 100, sourceCount: 5 }),
      entry('pe_job', '小明在讀研', { firstLearnedAt: 200, sourceCount: 3 }),
    ];

    // 不重映射：U0 落到 pe_new 上 —— 「養貓」那條的來歷被「搬家」這條繼承走了
    const wrong = mergePlateEntries('user_room', current, items, 20_000);
    expect(wrong[0].id).toBe('pe_new');
    expect(wrong[0].firstLearnedAt).toBe(9_000);

    // 重映射之後：落在 pe_home 上，繼承的是「住家裡」那條的來歷
    const right = mergePlateEntries(
      'user_room', current, remapBasedOnLabels('user_room', items, snapshotIds, current), 20_000,
    );
    expect(right[0].id).toBe('pe_home');
    expect(right[0].firstLearnedAt).toBe(100);
    expect(right[0].sourceCount).toBe(6);
  });
});

describe('葉子紀律', () => {
    // 這三份都會被 pnpm build:workers 打進 amsg worker bundle。import 到帶瀏覽器依賴的
    // 模塊（db / safeApi / context / activeMsgClient…）就會在 worker 裡炸，而且要等真機
    // 跑到那一步才發現。靠源碼掃描當場攔住：白名單裡的三個自己也是零依賴葉子。
    const ALLOWED = new Set([
        './types', './jsonUtils', './roomPlateCore',
        './memoryPalace/types', './memoryPalace/roomPlateCore',
    ]);

    it.each([
        ['門牌提示詞與合併', './roomPlateCore.ts'],
        ['門牌上雲契約', '../amsgPlateJob.ts'],
        ['後台任務通用約定', '../amsgTaskKinds.ts'],
    ])('%s 保持環境無關', (_label, rel) => {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        const specifiers = [...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
        expect(specifiers.filter((s) => !ALLOWED.has(s))).toEqual([]);
        // 只認 `from` 的話，`import '../db';` 這種**只為副作用**的引入會整條漏過去——
        // 它一樣會把 db 打進 bundle、一樣在 worker 裡炸，而這道守衛的意義正是別等真機
        // 跑到那一步才發現。這種寫法在這三份葉子裡沒有任何正當用途，見一個攔一個。
        expect(src.match(/^\s*import\s*['"][^'"]+['"]/gm) ?? []).toEqual([]);
        // 動態引入同理，運行期才炸更難查
        expect(src.match(/\bimport\s*\(/g) ?? []).toEqual([]);
    });
});
