// 「優化資源存儲」：一個按鈕還三筆存儲上的債。
//
//   一、把已接入令牌鏈路的面裡仍以 base64（data:image）落庫的存量圖片，批量轉成
//       blobref 令牌 + Blob 二進制（省掉 base64 的 ~33% 膨脹）。
//   二、把「同一張圖在庫裡存了好幾份 Blob」收斂成一份。
//   三、把還停留在 number[] 形態的記憶向量壓成 Float32 原始字節（每維 ~20 字節 → 4 字節）。
//
// 第一筆債的由來：這些面平時靠惰性遷移——哪個消費點讀到 data: 才順手轉（加載壁紙、
// 進小屋……），從不打開的內容會一直躺著多佔空間；導入 v2 老備份也會重新帶進一批 base64。
//
// 第二筆債的由來：同一張圖有好幾條互不相識的遷移入口，各轉各的，於是令牌不同、內容
// 逐字節相同。SDK 的 scanContent 按內容哈希找出這些重複組，utils/blobDedupe.ts 把重複
// 令牌在全部引用面上改寫成組內保留的那個。合併只改引用、不刪 Blob——失去引用的那幾份
// 變成孤兒，交給孤兒 GC 收（刪除不可逆，走那條帶安全閥的老路更穩）。
//
// 前兩筆債咬合在一起：掃庫結果會先給 blobRef 的內容記憶預熱，所以第一步轉換時遇到「庫裡
// 已經有一份同樣內容」的圖，直接複用那個令牌，不會又存出一份新的重複來。
//
// 第三筆債的由來：向量的緊湊形態（Uint8Array）和讀出口（ensureFloat32）早就到位，靠的卻是
// 「誰被搜到誰才轉」的惰性遷移 + 一次開機後台掃描；後者跑在頁面加載後台、失敗只 console.warn，
// 從外面完全看不出來它有沒有跑完。這裡把同一個掃描掛到手動按鈕上，並把失敗原樣報到界面——
// 一次沒轉完，下次再點就是了（冪等）。壓縮是無損的：讀出口兩種形態都認，召回質量不受影響。
//
// 跑過一遍後再跑就是 no-op（冪等），導入過舊備份後可以再跑。
//
// 十二個面都是按主鍵分頁讀的，一次只有一批行在內存裡。別改回整表讀：真實庫裡這幾張表
// 加起來能有幾十 MB（光 messages 一張就兩萬多行、20 MB 量級），光是把它們讀進來就夠嗆，
// 何況全程還得佔著。
//
// ─── 覆蓋面即安全邊界（本文件的生死線）───
// 只允許收錄「當前寫入路徑已產出令牌」的字段——寫令牌意味著讀端全鏈路認令牌，
// 換成令牌不可能破圖。逐面對應的現役令牌寫入點：
//   assets 'wallpaper' / 'lock_wallpaper' / 'wallpaper_user_backup' ← 壁紙加載器（OSContext）
//   assets 'icon_*'                  ← AppIconEditor
//   assets 'widget_*'                ← 桌面小組件圖上傳（apps/Appearance.tsx 的 handleWidgetUpload）
//   assets 'appearance_preset_*'     ← migrateAppearancePresetBlobRefs（字段清單複用同一函數，
//     含內嵌的 chatThemes[] 六個字段；順便扔掉死字段 launcherWidgetImage）
//   assets 'room_custom_assets_list' ← RoomApp 自定義素材
//   assets 'spark_user_bg' / 'spark_social_profile'.avatar ← 社交主頁的背景與頭像上傳
//   characters avatar                ← 角色資料頁的頭像上傳（apps/Character.tsx）
//   characters roomConfig.wallImage / floorImage / items[].image ← RoomApp
//   songs coverImage                 ← SongwritingApp
//   cc_custom_parts src / shadowSrc  ← creatorPartToBlobRefs（字段清單複用同一函數）
//   gallery url                      ← Chat 把用戶發的圖存進相冊時
//   themes user/ai 各自的 backgroundImage / decoration / avatarDecoration ← 氣泡工坊（ThemeMaker）
//   messages content（type 為 image / emoji 的行，整條正文就是一張圖）← Chat / GroupChat 發圖發表情
//   messages 卡片行裡的頭像與合照副本：content(json) 和 metadata.scoreCard 各存一份的
//     charAvatar / photoDataUrl（兩份必須一起轉，讀端優先讀 metadata 那份）、
//     metadata.characterAvatar（通話結束卡）、metadata.post 的 authorAvatar 與
//     comments[].authorAvatar（分享出去的帖子快照）
//   messages replyTo.content ← 引用回覆的內容快照。這一條不轉令牌，圖片值直接換成佔位符：
//     引用塊本來就只顯示純文本（還截前 10 字），令牌擺在那兒既難看，被截斷後剩下的
//     'blobref:b_' 還正好是所有令牌 id 的公共前綴，會讓孤兒清理判定「引用面被截斷了」
//     從而整輪不敢刪（新寫入的快照已經直接寫佔位符，見 utils/applyAssistantPostProcessing.ts）
//   emojis url                       ← Chat 表情導入（http 外鏈不是本機資源，不轉）
//   user_profile avatar / perCharAvatars ← 個人檔案的頭像上傳 / 分角色聊天頭像
//   user_profile vrState.chibi.img   ← 手辦櫃 / 彼方（ChibiStudio、VRWorldApp）
//   characters sprites / dateSkinSets[].sprites ← 見面場景佈置的立繪上傳（DateSettings）
//   characters chatBackground        ← 聊天頁的背景圖上傳（Chat）
//   characters dateBackground        ← 見面場景佈置的背景圖上傳（DateSettings）
//   characters vrState.chibi.img     ← 手辦櫃 / 彼方
//   characters phoneState.contacts[].avatar ← 查手機通訊錄（值是角色頭像的副本）
//   characters specialMomentRecords.*.image ← 活動留存的大圖（白色情人節明信片、520 定妝照）
//   characters specialMomentRecords.*.customData.chatCard.charAvatar ← 活動留存的聊天卡片
//   social_posts authorAvatar / comments[].authorAvatar ← 社交發帖（值是角色 / 我方頭像副本）
//   groups avatar                    ← 群資料頁（GroupChat 早已走 migrateDataUrlToRef）
//   life_sim actionLog[].actorAvatar ← 生活模擬劇情日誌（同樣是頭像副本）
//   characters companionAvatar.imageRef 與 .imageWardrobe[].imageRef ← 桌面陪伴的靜態形象與衣櫃
//   characters videoCallBackground   ← 視頻通話的舞台背景（CallApp）
//   characters companionBackground   ← 桌面陪伴的背景（CompanionHome）
//     ↑ 末尾這三個是「換圖即刪」字段，走 convertExclusive（不去重、令牌獨佔），
//       衣櫃裡那份還得跟頂層 imageRef 同令牌。兩條規矩的來由見各自函數註釋。
// 明確不碰：
//   · 手帳自己的配圖，以及帖子自己的配圖 social_posts.images[]——讀端還不認令牌，轉了就破圖
//     （帖子配圖還被當成「可能是 emoji 字符串」直接渲染成文本，見 MessageItem 的 social_card）；
//   · chibiStudio.like520.img 與 specialMomentRecords.*.customData.charChibi / userChibi——
//     刻意保持 dataURL（見 docs/chibi-studio.md）：520 活動那邊全是裸 <img> + canvas 合成，
//     令牌過不去。所以 specialMomentRecords 只能走 chatCard.charAvatar 那一條精確路徑，
//     絕不能整體深度遍歷；
//   · life_sim 的 actionLog[].attachments[].imageUrl——裸 <img> 渲染，同理只能字段定向；
//   · pixel_home_assets / pixel_home_layouts / pixel_char_* 這一族——收益只有幾十 KB，
//     但要先填四個坑：pixelImage 的讀端跨了裸 <img>、canvas getImageData（失敗被 catch 靜默
//     吞掉，症狀是角色穿牆）、fetch（令牌直接 TypeError）、分享 JSON 四種形態；牆紙地磚住在
//     pixel_home_layouts，而那張表不在 utils/blobGc.ts 的引用面清單裡，轉了會被孤兒 GC 當垃圾
//     刪掉；像素小屋的預設導出沒跑 resolveBlobRefsDeep，令牌會原樣進分享文件；
//     types.ts 的 decodeColorField 已經在用認令牌的 isImageValue，跟同文件裡
//     startsWith('data:') 的判據對不上。
// 新面收錄時除了加進上面清單，還必須確認該面已在 utils/blobGc.ts 的引用面清單裡——
// 否則轉出來的 Blob 會被孤兒 GC 刪掉（storageOptimize.test.ts 有守衛釘這條包含關係）。
//
// 與孤兒 GC 共用 maintenanceLock 互斥：遷移是「引用搬家」，不能撞上進行中的 mark。

import { DB } from './db';
import {
    isBlobRef, dataUrlToBlob, putImageBlob, putImageBlobDeduped, getBlobForRef, migrateAppearancePresetBlobRefs,
    primeContentMemo, CHAT_THEME_IMAGE_KEYS,
} from './blobRef';
import { blobStore } from './blobStore';
import { collectUnmergeableRefs, buildMergePlan, rewriteBlobRefs } from './blobDedupe';
import { creatorPartToBlobRefs } from './creatorPartsBlob';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock, currentMaintenanceHolder } from './maintenanceLock';
import type { AppearancePreset, ChatTheme, CharacterProfile, CustomCreatorPart, Emoji, GalleryImage, Message, SongSheet } from '../types';

/** 本工具會寫的表。守衛測試斷言它 ⊆ blobGc 的 REF_SOURCE_STORES（轉出的 Blob 必須在 GC 視野內）。 */
export const OPTIMIZE_TARGET_STORES = ['assets', 'characters', 'songs', 'cc_custom_parts', 'gallery', 'themes', 'messages', 'emojis', 'user_profile', 'social_posts', 'groups', 'life_sim'] as const;

/** 卡片 JSON 裡參與遷移的圖片字段名。只認這兩個——同一坨 JSON 裡還有別的圖片字段
 *  （520 的手辦圖 charChibi / userChibi）是刻意保持 dataURL 的，深度遍歷會把它們一起轉走。 */
const CARD_IMAGE_KEYS = ['charAvatar', 'photoDataUrl'] as const;

/** 值形態是「裸圖片字符串」的 assets 行。 */
const PLAIN_ASSET_IDS = new Set(['wallpaper', 'lock_wallpaper', 'wallpaper_user_backup', 'spark_user_bg']);

/** 每批讀多少行。跟 utils/blobGc.ts 一個口徑：批間事務各自獨立，內存峰值只有一批。 */
const PAGE_SIZE = 200;

/**
 * 按主鍵升序把一張表逐行吐出來，內存裡一次只留一批
 * （見 DB.getStoreRowsPage：IDB 事務撐不過 await 掛起，只能每批開一個新的 readonly 事務）。
 *
 * 邊讀邊寫為什麼不重不漏：翻頁靠主鍵推進，下一頁從上一頁最後那個鍵之後開始；而這幾面的遷移
 * 只改行裡的圖片字段，主鍵一個都不動——改完的行還待在它原來的位置上，翻過去的不會再回來，
 * 沒翻到的也不會挪到身後去。
 * 反過來說，誰要是在這個循環裡換主鍵（刪掉舊行、用新 id 重寫一條）或者往表裡插新行，這條保證
 * 就沒了：落在游標前面的再也掃不到，落在後面的會被當成新行又處理一遍。真要刪行 / 加行，
 * 請另起一趟遍歷，別混進來。
 */
async function* iterateStoreRows<T>(storeName: string): AsyncGenerator<T> {
    let afterKey: IDBValidKey | null = null;
    for (;;) {
        const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, PAGE_SIZE);
        for (const row of rows) yield row as T;
        if (lastKey === null || rows.length < PAGE_SIZE) break;
        afterKey = lastKey;
    }
}

export interface OptimizeProgress {
    /** 正在處理的面（給進度條文案用） */
    label: string;
    done: number;
    total: number;
}

export interface OptimizeResult {
    /** 被替換成令牌的字段數（同圖多處引用各計一次） */
    converted: number;
    /** 實際新建的 Blob 數（去重後） */
    uniqueBlobs: number;
    /** 被替換掉的 data: 字符串總長度（≈原來佔的字節） */
    bytesBefore: number;
    /** 對應 Blob 的總字節數（去重後） */
    bytesAfter: number;
    /** 轉換失敗、原值保留的字段數（圖不丟，只是這張沒省下來）。
     *  兩種來源：這張圖本身轉不動，以及轉好了但那一行寫不回去（配額滿） */
    failed: number;
    /**
     * 失敗原因 → 出現次數，鍵形如「相冊: TypeError: ...」。
     * failed 只說「有幾張沒轉成」，不說為什麼；同一個原因通常成批出現，按原因歸併
     * 既壓得住條數，又夠定位問題。沒有失敗時是個空對象。
     */
    failureReasons: Record<string, number>;
    /** 合併掉的重複 Blob 份數（同一張圖多存的那幾份） */
    mergedDuplicates: number;
    /** 合併後能被孤兒清理回收的字節數 */
    reclaimableBytes: number;
    /** 觸到「換圖即刪」的字段、不敢合併而跳過的重複組數（見 blobDedupe 的清單） */
    skippedGroups: number;
    /** 掃庫沒做成（keys 讀不出 / 沒有 crypto.subtle），這一輪沒有去重 */
    scanUnavailable: boolean;
    /** 壓成緊湊形態的記憶向量條數 */
    vectorsCompacted: number;
    /** 向量壓縮失敗的原因；null = 這輪沒出問題。開機那次是靜默 warn 的，這裡必須報出來 */
    vectorError: string | null;
}

export async function optimizeResourceStorage(
    onProgress?: (p: OptimizeProgress) => void,
): Promise<OptimizeResult> {
    if (!tryAcquireMaintenanceLock('優化資源存儲')) {
        throw new Error(`另一項存儲維護（${currentMaintenanceHolder()}）正在進行，請稍後再試。`);
    }
    try {
        const result: OptimizeResult = {
            converted: 0, uniqueBlobs: 0, bytesBefore: 0, bytesAfter: 0, failed: 0,
            failureReasons: {},
            mergedDuplicates: 0, reclaimableBytes: 0, skippedGroups: 0, scanUnavailable: false,
            vectorsCompacted: 0, vectorError: null,
        };
        // 當前正在處理哪個面（tick 時更新）。失敗原因帶上它才知道是哪張表出的事。
        let currentFace = '開始前';
        // 已計過字節數的令牌：canonical 遷移函數產出的令牌經這裡補記大小，避免重複計。
        const countedTokens = new Set<string>();
        // 這一行開跑時的記帳讀數 + 這一行新計過的令牌（tick 時刷新）。
        // 行寫回失敗時按它把這一行的帳原樣退回去，見 writeRow。
        const rowStart = () => ({
            converted: result.converted, bytesBefore: result.bytesBefore,
            uniqueBlobs: result.uniqueBlobs, bytesAfter: result.bytesAfter,
            newTokens: [] as string[],
        });
        let rowTally = rowStart();

        /** convert / convertExclusive 共用的轉換體。差別只在 put：走不走內容去重。 */
        const convertWith = async (
            value: unknown,
            put: (blob: Blob) => Promise<{ token: string; reused: boolean }>,
        ): Promise<string | null> => {
            if (typeof value !== 'string' || !value.startsWith('data:image/')) return null;
            // 內聯 SVG 一律跳過：庫裡這些不是用戶傳的圖，是代碼現畫出來的佔位符
            // （群默認頭像 ~300 字節、生活模擬的附件插圖）。上傳路徑產出的都是 png/jpeg，
            // 不會落到這個分支。拿一條 Blob 行去換幾百字節是負收益。
            if (value.startsWith('data:image/svg+xml')) return null;
            try {
                const blob = dataUrlToBlob(value);
                // 複用命中時不計新建：那份 Blob 本來就在庫裡佔著，這次一個字節都沒多存
                const { token, reused } = await put(blob);
                result.converted++;
                result.bytesBefore += value.length;
                if (!reused && !countedTokens.has(token)) {
                    countedTokens.add(token);
                    rowTally.newTokens.push(token);
                    result.uniqueBlobs++;
                    result.bytesAfter += blob.size;
                }
                return token;
            } catch (e) {
                result.failed++; // 壞 data: 轉不動：原值保留，圖不丟
                // 原因原本整個吞掉，只留一個數字，出問題時無從查起——按「面 + 原因」歸併記一筆。
                const reason = `${currentFace}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
                result.failureReasons[reason] = (result.failureReasons[reason] ?? 0) + 1;
                return null;
            }
        };

        /** data:image → 令牌；非圖片 data / 已是令牌 / http 一律返回 null（調用方不動原值）。
         *
         *  「同一份圖別轉兩遍」這件事交給 putImageBlobDeduped——它按內容哈希認人，記的是
         *  哈希（幾十字節），不是 base64 原文。這裡不要再套一層以 data URL 為鍵的緩存：
         *  那層緩存等於把這一輪見過的每張圖的原文都釘在內存裡，表分頁讀了也白讀。 */
        const convert = (value: unknown) => convertWith(value, putImageBlobDeduped);

        /** 「換圖即刪」字段專用：不走內容去重，每次都產出只歸這個字段的新令牌。
         *
         *  這幾個字段（清單見 utils/blobDedupe.ts）換圖 / 移除時會直接 deleteBlobRef 掉舊
         *  Blob，前提是「這份令牌只歸我」。走 putImageBlobDeduped 的話，兩個字段恰好放了
         *  同一張圖就會拿到同一個令牌，那邊一換圖，這邊的圖跟著沒。寧可多存一份二進制。 */
        const convertExclusive = (value: unknown) =>
            convertWith(value, async blob => ({ token: await putImageBlob(blob), reused: false }));

        /** 一袋立繪（情緒鍵 → 圖）整袋轉成令牌，返回有沒有動過。
         *  袋子裡除了見面情緒立繪還混著小小窩的 chibi，兩者都在令牌鏈路上，一起轉。 */
        const migrateSpriteMap = async (sprites: unknown): Promise<boolean> => {
            if (!sprites || typeof sprites !== 'object') return false;
            let touched = false;
            for (const key of Object.keys(sprites as Record<string, string>)) {
                const token = await convert((sprites as Record<string, string>)[key]);
                if (token) { (sprites as Record<string, string>)[key] = token; touched = true; }
            }
            return touched;
        };

        /** canonical 遷移函數（預設 / 捏人器部件）轉完後的記帳：按 before/after 差異補計。 */
        const tallyPair = async (before: unknown, after: unknown): Promise<void> => {
            if (typeof before !== 'string' || !before.startsWith('data:image/')) return;
            if (typeof after !== 'string' || !isBlobRef(after)) return;
            result.converted++;
            result.bytesBefore += before.length;
            if (!countedTokens.has(after)) {
                countedTokens.add(after);
                rowTally.newTokens.push(after);
                result.uniqueBlobs++;
                const blob = await getBlobForRef(after);
                if (blob) result.bytesAfter += blob.size;
            }
        };

        const yieldMain = () => new Promise<void>(r => setTimeout(r, 0));

        /**
         * 行級寫回：這一行寫不進去就只記一筆失敗，接著跑下一行。
         *
         * 這幾張表的寫入口會等事務真的提交完才 resolve，配額滿 / 事務 abort 都是從這裡拋
         * 上來的。而本函數只有 finally 沒有 catch，不在這兒接住的話，一行寫失敗就把整輪掐斷
         * 在半路——後面的面全不跑，連回收最省的那步「合併重複圖片」都輪不到，結果也返回不了。
         * 偏偏「存儲快滿」正是有人來點這個按鈕的時候。
         *
         * 帳按行退：這一行轉出來的令牌一個都沒落庫，庫裡還是原來那份 base64，所以算
         * 「沒省下來」（failed）而不是「省了」（converted）。退不掉的只有已經寫進 blob 表的
         * 那幾份二進制——它們現在沒有任何字段引用著，是孤兒，交給孤兒清理收。
         */
        const writeRow = async (save: () => Promise<unknown>): Promise<void> => {
            try {
                await save();
            } catch (e) {
                const rolledBack = result.converted - rowTally.converted;
                result.converted = rowTally.converted;
                result.bytesBefore = rowTally.bytesBefore;
                result.uniqueBlobs = rowTally.uniqueBlobs;
                result.bytesAfter = rowTally.bytesAfter;
                for (const token of rowTally.newTokens) countedTokens.delete(token);
                // 一行裡可能好幾個字段一起沒寫進去，各記一筆。一個字段都沒轉、只改了別的
                // 東西的行（比如只歸一化了引用快照）也得留下一筆，別讓失敗靜默過去。
                const lost = Math.max(rolledBack, 1);
                result.failed += lost;
                const reason = `${currentFace}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
                result.failureReasons[reason] = (result.failureReasons[reason] ?? 0) + lost;
            }
        };

        // ── 0) 掃庫：誰和誰裝的是同一份內容 ───────────────────────
        // 結果有兩個用處：給內容記憶預熱（下面轉換時直接複用庫裡已有的那份），
        // 以及收尾時把存量重複合併掉。掃不動就整輪跳過去重，轉換照跑。
        const scan = await blobStore.scanContent({
            onProgress: (done, total) => onProgress?.({ label: '查找重複圖片', done, total }),
        });
        // 每條都算不出哈希（非安全上下文沒有 crypto.subtle）和「真沒重複」長得一模一樣，
        // 這裡一併當作「這輪沒做成去重」報出去，別讓它靜默過去。
        // 判據靠 SDK 那兩個計數器互斥：算出哈希才 scanned++，讀不出 / 算不動一律 skipped++。
        // 所以「一條都沒成」寫作 skipped > 0 且 scanned === 0——空庫兩個都是 0，不算不可用；
        // 只壞了幾條時 scanned 仍大於 0，去重照跑，也不算。
        result.scanUnavailable = scan.aborted || (scan.skipped > 0 && scan.scanned === 0);

        // 被「換圖即刪」的字段引用著的令牌不能拿來共享：對方一刪，這邊就破圖。
        const unmergeable = result.scanUnavailable ? new Set<string>() : await collectUnmergeableRefs();
        if (!result.scanUnavailable) {
            const safeByHash = new Map<string, string[]>();
            for (const [hash, tokens] of scan.byHash) {
                const safe = tokens.filter(t => !unmergeable.has(t));
                if (safe.length > 0) safeByHash.set(hash, safe);
            }
            primeContentMemo(safeByHash);
        }

        // ── 進度條的總數：九張表各數一下行數 ─────────────────────
        // 只要個數字，count() 不讀行裡的內容，幾十 MB 的圖不會被順帶讀進內存。
        let total = 0;
        for (const storeName of OPTIMIZE_TARGET_STORES) total += await DB.countStoreRows(storeName);
        let done = 0;
        // total 是開跑那一刻的快照。跑的中途別處往這幾張表寫了行，實際走過的行數就跟它對不上：
        // 多出來的行照樣處理，只是報出去的 done 按 total 封頂——done 只增不減也不越過 total，
        // 進度條既不會倒退也不會衝過頭；行變少時它停在不滿格的位置，函數返回即收尾
        // （展示側本來就以返回為準，不靠進度條判完成）。
        // 每行開頭都會走一趟，順手把記帳起點也刷了——writeRow 退帳靠的就是這個讀數，
        // 少刷一次就會把上一行的帳一起退掉。
        const tick = (label: string) => { currentFace = label; rowTally = rowStart(); done++; onProgress?.({ label, done: Math.min(done, total), total }); };

        // ── 1) assets 表 ─────────────────────────────────────────
        for await (const a of iterateStoreRows<{ id: string; data: string }>('assets')) {
            tick('系統外觀');
            if (typeof a.data !== 'string') continue;
            if (PLAIN_ASSET_IDS.has(a.id) || a.id.startsWith('icon_') || a.id.startsWith('widget_')) {
                const token = await convert(a.data);
                if (token) { await writeRow(() => DB.saveAsset(a.id, token)); await yieldMain(); }
            } else if (a.id.startsWith('appearance_preset_')) {
                let preset: AppearancePreset;
                try { preset = JSON.parse(a.data); } catch { continue; }
                if (!preset || typeof preset !== 'object' || !preset.theme) continue;
                const beforeFields = presetImageFields(preset);
                const migrated = await migrateAppearancePresetBlobRefs(preset);
                const afterFields = presetImageFields(migrated);
                let changed = false;
                for (let i = 0; i < beforeFields.length; i++) {
                    if (beforeFields[i] !== afterFields[i]) { changed = true; await tallyPair(beforeFields[i], afterFields[i]); }
                }
                if (changed) { await writeRow(() => DB.saveAsset(a.id, JSON.stringify(migrated))); await yieldMain(); }
            } else if (a.id === 'spark_social_profile') {
                // 社交主頁的個人資料 JSON，圖只有 avatar 一個字段。
                let profile: { avatar?: string };
                try { profile = JSON.parse(a.data); } catch { continue; }
                if (!profile || typeof profile !== 'object') continue;
                const token = await convert(profile.avatar);
                if (token) { profile.avatar = token; await writeRow(() => DB.saveAsset(a.id, JSON.stringify(profile))); await yieldMain(); }
            } else if (a.id === 'room_custom_assets_list') {
                let list: Array<{ image?: string }>;
                try { list = JSON.parse(a.data); } catch { continue; }
                if (!Array.isArray(list)) continue;
                let changed = false;
                for (const entry of list) {
                    const token = await convert(entry?.image);
                    if (token) { entry.image = token; changed = true; }
                }
                if (changed) { await writeRow(() => DB.saveAsset(a.id, JSON.stringify(list))); await yieldMain(); }
            }
        }

        // ── 2) characters：角色頭像 + 小屋圖 ──────────────────────
        // 兩樣東西在同一趟遍歷裡一起轉。別拆成兩趟：翻頁靠主鍵推進，多一趟就是把整張表
        // 連同行裡那些幾 MB 的圖再讀一遍（見 iterateStoreRows 的註釋）。
        for await (const c of iterateStoreRows<CharacterProfile>('characters')) {
            tick('角色頭像與小屋');
            let changed = false;
            // ⚠️ 這一段必須跑在下面轉立繪之前：它靠「立繪的字面值」反查情緒鍵，
            // 立繪一旦換成令牌就再也對不上了。
            //
            // savedDateState.currentSprite 是歷史殘留——見面存檔現在只記情緒鍵
            // （DateSession 的 currentSpriteKey），types.ts 也把它標了 @deprecated。
            // 它躺的是整張立繪的 base64 副本，一條就能佔近 1 MB。
            // 這裡不轉成令牌而是直接扔掉：轉了也只是把「拿值反查鍵」這條脆鏈路
            // 從 base64 換成令牌，兩邊同進同退才成立；反查出鍵補上再刪字段，
            // 空間歸零，恢復存檔時照樣定位得到當時那個表情。
            const saved = (c as any).savedDateState;
            if (saved && typeof saved.currentSprite === 'string' && saved.currentSprite) {
                if (!saved.currentSpriteKey) {
                    const inferred = inferSavedSpriteKey(c, saved);
                    if (inferred) saved.currentSpriteKey = inferred;
                }
                delete saved.currentSprite;
                changed = true;
            }
            // 頭像是兩用字段：可能是圖，也可能是個 emoji，還可能是 http 外鏈或已經是令牌。
            // convert 只認 data:image/ 開頭的值，其餘一律原樣不動。
            const avatarToken = await convert(c.avatar);
            if (avatarToken) { c.avatar = avatarToken; changed = true; }

            // 桌面陪伴形象 / 視頻舞台背景 / 桌面背景：這三個是「換圖即刪」字段，
            // 只能走 convertExclusive，理由見那個函數的註釋。
            //
            // 衣櫃裡那份必須跟頂層 imageRef 轉成同一個令牌：companionWardrobe 拿令牌
            // 當條目 id 認親（utils/companionWardrobe.ts 的 activeUploadedOutfit 與
            // listUploadedCompanionOutfits），兩邊給出不同令牌的話，當前穿著的這套會在
            // 衣櫃裡裂成兩條重複項。非去重的 put 每次都產新令牌，所以這裡必須行內記帳。
            //
            // 記帳只在 companionAvatar 這一坨里通用，不跨到下面兩個背景字段：它們各自也是
            // 裸刪的，共享令牌等於把連坐從「別的表」搬到「同一行裡」。
            const companion = (c as any).companionAvatar;
            if (companion && typeof companion === 'object') {
                const seen = new Map<string, string>();
                const convertOnce = async (value: unknown): Promise<string | null> => {
                    if (typeof value !== 'string') return null;
                    const hit = seen.get(value);
                    if (hit) return hit;
                    const token = await convertExclusive(value);
                    if (token) seen.set(value, token);
                    return token;
                };
                const imageToken = await convertOnce(companion.imageRef);
                if (imageToken) { companion.imageRef = imageToken; changed = true; }
                if (Array.isArray(companion.imageWardrobe)) {
                    for (const outfit of companion.imageWardrobe) {
                        const token = await convertOnce(outfit?.imageRef);
                        if (token) { outfit.imageRef = token; changed = true; }
                    }
                }
            }
            for (const key of ['videoCallBackground', 'companionBackground'] as const) {
                const token = await convertExclusive((c as any)[key]);
                if (token) { (c as any)[key] = token; changed = true; }
            }

            const rc = (c as any).roomConfig;
            if (rc) {
                for (const key of ['wallImage', 'floorImage']) {
                    const token = await convert(rc[key]);
                    if (token) { rc[key] = token; changed = true; }
                }
                if (Array.isArray(rc.items)) {
                    for (const item of rc.items) {
                        const token = await convert(item?.image);
                        if (token) { item.image = token; changed = true; }
                    }
                }
            }
            // 聊天頁背景與見面場景背景。兩個字段的讀寫端都已改成認令牌
            // （Chat / ChatModals / DateSettings / DateSession / CheckPhone / PersonaSim），
            // 這裡收存量。
            for (const key of ['chatBackground', 'dateBackground'] as const) {
                const token = await convert((c as any)[key]);
                if (token) { (c as any)[key] = token; changed = true; }
            }
            // 彼方 / 小小窩的 Q 版形象。寫端存的是裸 dataURL（ChibiStudio、VRWorldApp），
            // 所以這一面確實有存量——別被「chibi 都是令牌原生」的印象騙了。
            const vrChibi = (c as any).vrState?.chibi;
            if (vrChibi) {
                const token = await convert(vrChibi.img);
                if (token) { vrChibi.img = token; changed = true; }
            }
            // 「查手機」通訊錄裡的聯繫人頭像，值是角色頭像的副本。
            const contacts = (c as any).phoneState?.contacts;
            if (Array.isArray(contacts)) {
                for (const contact of contacts) {
                    const token = await convert(contact?.avatar);
                    if (token) { contact.avatar = token; changed = true; }
                }
            }
            // 活動留存記錄裡的聊天卡片頭像。**只走這一條精確路徑**，絕不能對
            // specialMomentRecords 整體深度遍歷——隔壁 like520 的 customData.charChibi.dataUrl
            // 是刻意保持 dataURL 的（520 活動那邊全是裸 img + canvas 合成，令牌過不去），
            // 順手轉掉就是永久破圖。
            const moments = (c as any).specialMomentRecords;
            if (moments && typeof moments === 'object') {
                for (const key of Object.keys(moments)) {
                    // 活動自己留的那張大圖（白色情人節的明信片、520 的定妝照）。
                    const momentImage = await convert(moments[key]?.image);
                    if (momentImage) { moments[key].image = momentImage; changed = true; }
                    const chatCard = moments[key]?.customData?.chatCard;
                    if (!chatCard) continue;
                    const token = await convert(chatCard.charAvatar);
                    if (token) { chatCard.charAvatar = token; changed = true; }
                }
            }
            // 見面立繪：角色默認那套 + 每個換裝套裝各一套，結構一樣，走同一個轉換。
            // 漏掉換裝那側是這一面最容易犯的錯——不報錯也不破圖，只是沒省下來。
            if (await migrateSpriteMap((c as any).sprites)) changed = true;
            if (Array.isArray((c as any).dateSkinSets)) {
                for (const skin of (c as any).dateSkinSets) {
                    if (await migrateSpriteMap(skin?.sprites)) changed = true;
                }
            }
            if (changed) { await writeRow(() => DB.saveCharacter(c)); await yieldMain(); }
        }

        // ── 3) songs 封面 ─────────────────────────────────────────
        for await (const s of iterateStoreRows<SongSheet>('songs')) {
            tick('歌曲封面');
            const token = await convert((s as any).coverImage);
            if (token) { (s as any).coverImage = token; await writeRow(() => DB.saveSong(s)); await yieldMain(); }
        }

        // ── 4) 捏人器自定義部件 ───────────────────────────────────
        for await (const p of iterateStoreRows<CustomCreatorPart>('cc_custom_parts')) {
            tick('捏人器部件');
            const srcIsData = typeof p.src === 'string' && p.src.startsWith('data:');
            const shadowIsData = typeof p.shadowSrc === 'string' && p.shadowSrc.startsWith('data:');
            if (!srcIsData && !shadowIsData) continue;
            const migrated: CustomCreatorPart = await creatorPartToBlobRefs(p);
            if (migrated.src === p.src && migrated.shadowSrc === p.shadowSrc) continue;
            await tallyPair(p.src, migrated.src);
            await tallyPair(p.shadowSrc, migrated.shadowSrc);
            await writeRow(() => DB.saveCustomCreatorPart(migrated));
            await yieldMain();
        }

        // ── 5) 相冊 ───────────────────────────────────────────────
        // 聊天裡發的每張圖都會存一份進來，是最容易堆大的一面。
        for await (const g of iterateStoreRows<GalleryImage>('gallery')) {
            tick('相冊');
            const token = await convert(g.url);
            if (token) { g.url = token; await writeRow(() => DB.saveGalleryImage(g)); await yieldMain(); }
        }

        // ── 6) 聊天氣泡主題 ───────────────────────────────────────
        // 一套主題分用戶側和角色側，每側各帶底紋、氣泡貼紙、頭像掛件三張圖，最多 6 張。
        // 兩側字段名一樣，所以兩層循環走同一份清單；漏掉一側是這一面最容易犯的錯。
        for await (const t of iterateStoreRows<ChatTheme>('themes')) {
            tick('氣泡主題');
            let changed = false;
            for (const side of ['user', 'ai'] as const) {
                const style = t[side];
                if (!style) continue;
                for (const key of ['backgroundImage', 'decoration', 'avatarDecoration'] as const) {
                    const token = await convert(style[key]);
                    if (token) { style[key] = token; changed = true; }
                }
            }
            if (changed) { await writeRow(() => DB.saveTheme(t)); await yieldMain(); }
        }

        // ── 7) 聊天圖與表情消息 ───────────────────────────────────
        // 全庫最大的一張表（兩萬多行、20 MB 量級），也是唯一一張「絕大多數行跟圖片無關」的：
        // 只有 type 為 image / emoji 的行，content 裡躺的才是圖片。別的類型（文本、各種卡片
        // 的 JSON、轉帳…）一個字節都不許動——先按 type 卡一道，再交給只吃 data:image/ 的
        // convert，兩道一起擋住「正文恰好長得像 data URL 的文本消息」。
        // 轉出來的令牌可能跟相冊那一面是同一個（同一張圖發出去時兩邊各存了一份引用），
        // 這正是要的效果：一份 Blob 兩處引用，刪其中一處也絕不能直接刪 Blob。
        // 一行最多有兩處要動：正文（圖片行是整張圖，卡片行是 JSON 裡的頭像副本）和引用快照。
        // 兩處合成一次整行寫回——圖片行也可能帶引用（引用一條圖片消息後回了張圖 / 一個表情），
        // 誰要是讓某類行提前跳過引用那段，那幾 MB 的快照副本就永久留庫：正文一旦轉成令牌，
        // 重跑優化連正文都不動了，再也補不上。
        for await (const m of iterateStoreRows<Message>('messages')) {
            tick('聊天圖片');
            let changed = false;

            if (m.type === 'image' || m.type === 'emoji') {
                const token = await convert(m.content);
                if (token) { m.content = token; changed = true; }
            } else {
                // 其餘類型的行裡也壓著圖，但都是「副本」：卡片上印的角色頭像、通話結束卡上的
                // 頭像、分享出去的帖子快照。逐個字段定向處理，不做深度遍歷
                // ——同一坨 JSON 裡還躺著 520 的手辦圖，那個是刻意留 dataURL 的。

                // 卡片正文：content 是一段 JSON。只認這兩個字段名。
                if (typeof m.content === 'string' && m.content.startsWith('{')) {
                    try {
                        const card = JSON.parse(m.content);
                        if (card && typeof card === 'object') {
                            // 用行內的小旗子而不是外面那個 changed：外面那個會被別處的改動
                            // 點亮，拿它當判據的話，一張圖都沒轉到的卡片也會被重新 stringify
                            let cardChanged = false;
                            for (const key of CARD_IMAGE_KEYS) {
                                const token = await convert(card[key]);
                                if (token) { card[key] = token; cardChanged = true; }
                            }
                            if (cardChanged) { m.content = JSON.stringify(card); changed = true; }
                        }
                    } catch { /* 不是 JSON 的正文原樣不動 */ }
                }

                const meta = (m as any).metadata;
                if (meta && typeof meta === 'object') {
                    // metadata.scoreCard 是同一張卡的另一份副本，而且讀端優先讀它——
                    // 只轉 content 那份等於白轉。兩邊必須一起。
                    const card = meta.scoreCard;
                    if (card && typeof card === 'object') {
                        for (const key of CARD_IMAGE_KEYS) {
                            const token = await convert(card[key]);
                            if (token) { card[key] = token; changed = true; }
                        }
                    }
                    // 通話結束卡上留的角色頭像
                    const callAvatar = await convert(meta.characterAvatar);
                    if (callAvatar) { meta.characterAvatar = callAvatar; changed = true; }
                    // 分享到聊天裡的社交帖子快照
                    const post = meta.post;
                    if (post && typeof post === 'object') {
                        const authorToken = await convert(post.authorAvatar);
                        if (authorToken) { post.authorAvatar = authorToken; changed = true; }
                        if (Array.isArray(post.comments)) {
                            for (const comment of post.comments) {
                                const token = await convert(comment?.authorAvatar);
                                if (token) { comment.authorAvatar = token; changed = true; }
                            }
                        }
                        // post.images[] 不碰：渲染那頭把它當成「可能是 emoji 的字符串」
                        // 直接印成文本（見 MessageItem 的 social_card 分支）。
                    }
                }
            }

            // 引用回覆的內容快照：被引用的若是圖片，這裡存的是整張圖的副本。
            // 這一段對所有類型的行都要跑到（圖片 / 表情行照樣能帶引用），
            // 所以它待在上面那個 if / else 外面。
            // 不轉令牌而是換成佔位符——引用塊本來就只顯示純文本（還截前 10 字），
            // 令牌擺在那兒既難看，被截斷後剩下的 'blobref:b_' 還正好是所有令牌 id 的
            // 公共前綴，會讓孤兒清理判定「引用面被截斷了」從而整輪不敢刪。
            // 新寫入的快照已經直接寫佔位符（見 utils/applyAssistantPostProcessing.ts），
            // 這裡把存量對齊過去。
            const replyTo = (m as any).replyTo;
            if (replyTo && typeof replyTo.content === 'string') {
                const quoted = replyTo.content.trim();
                if (quoted.startsWith('data:') || isBlobRef(quoted)) {
                    replyTo.content = '[圖片]';
                    changed = true;
                }
            }

            if (changed) { await writeRow(() => DB.putStoreRows('messages', [m])); await yieldMain(); }
        }

        // ── 8) 表情庫 ─────────────────────────────────────────────
        // url 有兩種：用戶上傳的圖（data:）和加進來的網絡表情（http 外鏈）。外鏈是別人
        // 服務器上的地址，本機沒有它的二進制，轉不了也不用轉——convert 只認 data:image/
        // 開頭的值，外鏈天然落在判定之外。
        for await (const e of iterateStoreRows<Emoji>('emojis')) {
            tick('表情包');
            const token = await convert(e.url);
            if (token) { await writeRow(() => DB.saveEmoji(e.name, token, e.categoryId)); await yieldMain(); }
        }

        // ── 9) 我方頭像（user_profile 單例）───────────────────────
        // 兩處都要轉：整體頭像 avatar，和「分角色聊天頭像」perCharAvatars（charId → 頭像的
        // 對象，逐個值轉）。只轉 avatar 是這一面最容易犯的錯——分角色那幾張會靜默留在 base64。
        // 寫回用通用整行寫回而不是 DB.saveUserProfile：後者會把主鍵強行按成 'me'，而這個
        // 循環的不重不漏建立在「主鍵一個都不動」上（見 iterateStoreRows 的註釋）。
        for await (const p of iterateStoreRows<any>('user_profile')) {
            tick('我的頭像');
            let changed = false;
            const avatarToken = await convert(p?.avatar);
            if (avatarToken) { p.avatar = avatarToken; changed = true; }
            const perChar = p?.perCharAvatars;
            if (perChar && typeof perChar === 'object') {
                for (const charId of Object.keys(perChar)) {
                    const token = await convert(perChar[charId]);
                    if (token) { perChar[charId] = token; changed = true; }
                }
            }
            // 我方的彼方 Q 版形象，跟角色那側同一套渲染。
            const myChibi = p?.vrState?.chibi;
            if (myChibi) {
                const token = await convert(myChibi.img);
                if (token) { myChibi.img = token; changed = true; }
            }
            if (changed) { await writeRow(() => DB.putStoreRows('user_profile', [p])); await yieldMain(); }
        }

        // ── 10) 社交帖子：作者頭像與評論頭像 ─────────────────────
        // 都是角色 / 我方頭像的副本，讀端早就全是 TokenImg。
        // **只轉這兩個字段**：帖子自己的配圖 images[] 讀端還沒改造，不在收錄範圍。
        for await (const post of iterateStoreRows<any>('social_posts')) {
            tick('社交帖子');
            let changed = false;
            const authorToken = await convert(post?.authorAvatar);
            if (authorToken) { post.authorAvatar = authorToken; changed = true; }
            if (Array.isArray(post?.comments)) {
                for (const comment of post.comments) {
                    const token = await convert(comment?.authorAvatar);
                    if (token) { comment.authorAvatar = token; changed = true; }
                }
            }
            if (changed) { await writeRow(() => DB.putStoreRows('social_posts', [post])); await yieldMain(); }
        }

        // ── 11) 群頭像 ────────────────────────────────────────────
        // 用戶沒設頭像時這裡躺的是代碼現畫的 SVG 佔位符，convert 會跳過（見它開頭的判斷）。
        for await (const g of iterateStoreRows<any>('groups')) {
            tick('群頭像');
            const token = await convert(g?.avatar);
            if (token) { g.avatar = token; await writeRow(() => DB.putStoreRows('groups', [g])); await yieldMain(); }
        }

        // ── 12) 生活模擬：劇情日誌裡的角色頭像副本 ────────────────
        // **只轉 actorAvatar 這一條路徑**。同一行裡的 actionLog[].attachments[].imageUrl
        // 是裸 <img> 渲染的（apps/lifesim/StoryAttachments.tsx），整行深度遍歷會把它一起
        // 轉掉、永久破圖。
        for await (const sim of iterateStoreRows<any>('life_sim')) {
            tick('生活模擬');
            if (!Array.isArray(sim?.actionLog)) continue;
            let changed = false;
            for (const action of sim.actionLog) {
                const token = await convert(action?.actorAvatar);
                if (token) { action.actorAvatar = token; changed = true; }
            }
            if (changed) { await writeRow(() => DB.putStoreRows('life_sim', [sim])); await yieldMain(); }
        }

        // ── 13) 合併存量重複：把重複令牌在全部引用面上改寫成保留的那個 ──
        // 只改引用，不刪 Blob。失去引用的那幾份變成孤兒，由孤兒清理回收。
        if (!result.scanUnavailable && scan.duplicateGroups.length > 0) {
            const plan = buildMergePlan(scan.duplicateGroups, unmergeable);
            result.skippedGroups = plan.skippedGroups;
            if (plan.mapping.size > 0) {
                const rewrite = await rewriteBlobRefs(plan.mapping, {
                    onProgress: scanned => onProgress?.({ label: '合併重複圖片', done: scanned, total: scanned }),
                });
                // 按「真改掉的那些」記帳，不按計劃數。上一輪合併留下的孤兒 Blob 還躺在庫裡，
                // 這一輪掃描照樣把它當重複報出來，按計劃數就會虛報一筆並不存在的收益。
                result.mergedDuplicates = rewrite.mergedRefs.size;
                for (const ref of rewrite.mergedRefs) {
                    result.reclaimableBytes += plan.bytesByToken.get(ref) ?? 0;
                }
            }
        }

        // ── 14) 記憶向量壓成緊湊形態 ──────────────────────────────
        // 跟圖片沒有任何關係，單獨一個 try：圖片那幾步的成果不該因為向量失敗就報不出來。
        // 反過來也不吞錯——開機那次後台掃描正是因為只 console.warn，卡住了也沒人知道。
        try {
            const { MemoryVectorDB } = await import('./memoryPalace/db');
            result.vectorsCompacted = await MemoryVectorDB.scanAndMigrateLegacy((migrated, scanned) => {
                onProgress?.({ label: '壓縮記憶向量', done: migrated, total: Math.max(scanned, migrated) });
            });
        } catch (e) {
            result.vectorError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }

        return result;
    } finally {
        releaseMaintenanceLock();
    }
}

/**
 * 見面存檔裡那張立繪對應哪個情緒鍵——趁立繪還是原值的時候反查出來。
 *
 * 取值順序照搬 DateSession 的 getSpritesForSkin：先看存檔自己記的換裝套裝，
 * 再看角色當前套裝，最後才是角色默認那套。順序錯了會反查到另一套裡同名的鍵上。
 */
function inferSavedSpriteKey(char: any, saved: any): string {
    const src = saved?.currentSprite;
    if (typeof src !== 'string' || !src) return '';
    const skins: any[] = Array.isArray(char?.dateSkinSets) ? char.dateSkinSets : [];
    const candidates: Array<Record<string, string> | undefined> = [];
    const bySavedSkin = saved.activeSkinSetId ? skins.find(sk => sk?.id === saved.activeSkinSetId) : undefined;
    if (bySavedSkin?.sprites) candidates.push(bySavedSkin.sprites);
    const byCharSkin = char?.activeSkinSetId ? skins.find(sk => sk?.id === char.activeSkinSetId) : undefined;
    if (byCharSkin?.sprites) candidates.push(byCharSkin.sprites);
    candidates.push(char?.sprites);
    for (const sprites of candidates) {
        if (!sprites) continue;
        const hit = Object.entries(sprites).find(([, value]) => value === src);
        if (hit) return hit[0];
    }
    return '';
}

/** 外觀預設裡參與令牌遷移的圖片字段快照（順序穩定，before/after 逐位對比用）。
 *  字段範圍由 migrateAppearancePresetBlobRefs 決定，這裡只是讀它動過的位置。
 *  漏一個字段的後果不是報錯，是「轉換白跑一趟、預設一個字沒變、全程零報錯」——
 *  changed 判定完全靠這份清單，它看不見的改動等於沒發生。 */
function presetImageFields(preset: AppearancePreset): Array<string | undefined> {
    const icons = preset.customIcons || {};
    const fields: Array<string | undefined> = [
        preset.theme?.wallpaper,
        (preset.theme as any)?.lockWallpaper,
        // 死字段，遷移時直接扔掉。不列進來的話，「只有它變了」的預設會被判成沒變、寫不回去
        (preset.theme as any)?.launcherWidgetImage,
        ...Object.keys(icons).sort().map(k => icons[k]),
        // 桌面小組件圖：槽位鍵排序後展開，順序才穩定
        ...Object.keys((preset.theme as any)?.launcherWidgets || {}).sort()
            .map(k => (preset.theme as any).launcherWidgets[k]),
    ];
    // 預設裡內嵌的氣泡主題：數組順序就是預設裡的順序（穩定），每套按 user/ai 兩側 × 三張圖展開
    for (const ct of preset.chatThemes || []) {
        for (const side of ['user', 'ai'] as const) {
            for (const key of CHAT_THEME_IMAGE_KEYS) fields.push(ct?.[side]?.[key]);
        }
    }
    return fields;
}
