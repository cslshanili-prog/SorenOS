import { toMountedWorldbook } from './worldbook';
import { orderWorldEpisodes } from './worldHome/episodeOrder';



import {
    CharacterProfile, ChatTheme, Message, UserProfile,
    Task, Anniversary, DiaryEntry, RoomTodo, RoomNote, DailySchedule,
    GalleryImage, FullBackupData, GroupProfile, SocialPost, StudyCourse, GameSession, Worldbook, NovelBook, Emoji, EmojiCategory,
    BankTransaction, SavingsGoal, BankFullState, DollhouseState, XhsStockImage, XhsActivityRecord, XhsOwnedPost, SongSheet, QuizSession, GuidebookSession,
    LifeSimState, HandbookEntry, Tracker, TrackerEntry, HotNewsSnapshot,
    LifeRecord, MedPlan, LifeRecordSettings, CharacterGroup, NPCProfile,
    VRWorldNovel, VRLibraryCategory, VRNovelAnnotation, CustomCreatorPart, VRMusicRoomState, VRGuestbookState, VRScript, VRStagedPlay, VRLetter,
    WorldProfile, WorldEpisode, StoryTheaterEntry, StoryTheaterPreset, StoryTheaterMask,
    MallCategory, MallProduct
} from '../types';
import { exportPostOfficeLocal, importPostOfficeLocal } from './vrWorld/postOffice';
import { exportSignalLocal, importSignalLocal } from './vrWorld/signal';
import { exportLuckinLocal, importLuckinLocal } from './luckinMcpClient';
import { exportMcdLocal, importMcdLocal } from './mcdMcpClient';
import { exportMcpLocal, importMcpLocal } from './mcpClient';
import { exportAmsg2GlobalConfig, importAmsg2GlobalConfig } from './activeMsgStore';
import { exportWorldHomeLocal, importWorldHomeLocal } from './worldHome/localBackup';
import { exportDesktopSkinLocal, importDesktopSkinLocal } from './desktopSkinBackup';
import { editLibrary, VR_LIBRARY_RECORD, type LibraryEdit } from './vrWorld/library';

const DB_NAME = 'AetherOS_Data';
// v67：兩條並行線各自用掉了 v65/v66（A線: blob_assets + 生活記錄；B線: room_plates 門牌 + digest_reports 消化日誌），
// 合併後統一推到 67——建表全部走冪等的 if(!contains)，任一側的 v66 老庫升級時都會補齊缺的那組表。
// v68：character_groups 角色分組（神經鏈接"文件夾"，見 types.ts CharacterGroup）。
// v69：見面·劇情條目與糯米機原生預設。正文繼續複用 messages 表，避免再造會話存儲。
// v70：劇場面具箱（原創人物面具）；角色面具仍只存 characterId，不復制神經鏈接資料。
// v71：角色小紅書偽主頁；發帖歸屬與可刪除的自由活動日誌分離。
// v72：NPC 檔案（獨立於 characters，見 types.ts NPCProfile）——群聊/查手機聯繫人/見面劇情
//       三處讀取，不參與日程/情緒/主動消息/記憶宮殿等背景任務。
// v73：購物中心（商品/外賣目錄）——用戶自己維護的商品庫，獨立於全局設置導入導出，
//      不進 exportSettings/importSettings 的打包範圍（見 utils/shoppingMall.ts）。
const DB_VERSION = 73;

const STORE_CHARACTERS = 'characters';
const STORE_CHAR_GROUPS = 'character_groups'; // 角色分組定義（角色通過 groupId 指向；與群聊 groups 無關）
const STORE_NPCS = 'npcs';
const STORE_MESSAGES = 'messages';
const STORE_EMOJIS = 'emojis';
const STORE_EMOJI_CATEGORIES = 'emoji_categories'; 
const STORE_THEMES = 'themes';
const STORE_ASSETS = 'assets';
const STORE_BLOB_ASSETS = 'blob_assets'; // 圖片二進制 Blob 存儲（key=生成 id，value={id, blob}）；壁紙/小屋等圖片改存 Blob 而非 base64，省 ~33% 空間且不佔 JS 堆。見 utils/blobRef.ts
const STORE_SCHEDULED = 'scheduled_messages'; 
const STORE_GALLERY = 'gallery';
const STORE_USER = 'user_profile'; 
const STORE_DIARIES = 'diaries';
const STORE_TASKS = 'tasks'; 
const STORE_ANNIVERSARIES = 'anniversaries';
const STORE_ROOM_TODOS = 'room_todos'; 
const STORE_ROOM_NOTES = 'room_notes'; 
const STORE_GROUPS = 'groups'; 
const STORE_JOURNAL_STICKERS = 'journal_stickers';
const STORE_SOCIAL_POSTS = 'social_posts';
const STORE_COURSES = 'courses';
const STORE_GAMES = 'games';
const STORE_WORLDBOOKS = 'worldbooks'; 
const STORE_NOVELS = 'novels'; 
const STORE_BANK_TX = 'bank_transactions';
const STORE_BANK_DATA = 'bank_data';
const STORE_XHS_STOCK = 'xhs_stock';
const STORE_XHS_ACTIVITIES = 'xhs_activities';
const STORE_XHS_OWNED_POSTS = 'xhs_owned_posts';
const STORE_SONGS = 'songs';
const STORE_QUIZZES = 'quizzes';
const STORE_GUIDEBOOK = 'guidebook';
const STORE_LIFE_SIM = 'life_sim';
const STORE_DAILY_SCHEDULE = 'daily_schedule';
const STORE_HANDBOOK = 'handbook'; // 跨角色聚合手帳，每天一條 entry，id = 'YYYY-MM-DD'
const STORE_TRACKERS = 'trackers';                // 手帳打卡 tracker 定義
const STORE_TRACKER_ENTRIES = 'tracker_entries';  // tracker 每日打卡數據
const STORE_HOTNEWS = 'hotnews_snapshots';        // 分時段熱點快照（全角色共享，key=日期#時段）
const STORE_VR_NOVELS = 'vr_novels';              // 虛擬世界「彼方」全局小說庫（所有角色共享原文）
const STORE_VR_ANNOTATIONS = 'vr_annotations';    // 虛擬世界小說批註（per-segment per-char，可互相吐槽）
const STORE_CC_PARTS = 'cc_custom_parts';         // 捏臉系統自定義部件（開發模式追加，注入捏人器）
const STORE_VR_MUSIC = 'vr_music';                // 聽歌房共享狀態（單例 nowPlaying + 循環隊列）
const STORE_VR_GUESTBOOK = 'vr_guestbook';        // 留言簿共享版聊牆（單例 messages）
const STORE_VR_SCRIPTS = 'vr_scripts';            // 劇院·投稿劇本庫（每份劇本一條）
const STORE_VR_PLAYS = 'vr_plays';                // 劇院·歷史舞台劇（每場演出一條）
const STORE_VR_PRESETS = 'vr_presets';            // 劇院·用戶自定義寫作風格預設（key 為主鍵）
const STORE_VR_LETTERS = 'vr_letters';            // 郵局信件（本地存檔 + 待寄出/待回覆隊列）
const STORE_VR_SETTINGS = 'vr_settings';          // 彼方設置單例：獨立 API（id='api'）+ 調用記錄（id='apilog'）
const STORE_API_CALL_LOG = 'api_call_log';        // 全局 API 調用記錄單例（id='log'，保留近 5 天）
const STORE_WORLDS = 'worlds';                    // 家園·世界定義（成員/NPC/居住/關係/模式）
const STORE_WORLD_EPISODES = 'world_episodes';    // 家園·演繹歷史（每輪一條，index worldId）
const STORE_LIFE_RECORDS = 'life_records';        // 生活記錄：生理期/藥盒打卡/鍛鍊（記帳走 bank_transactions）
const STORE_MED_PLANS = 'med_plans';              // 藥盒計劃（每天幾點吃什麼藥）
const STORE_LIFE_SETTINGS = 'life_record_settings'; // 生活記錄設置單例（id='main'：週期長度等）
const STORE_STORY_THEATERS = 'story_theaters';       // 見面·劇情條目（消息用 story-theater:${id}）
const STORE_STORY_THEATER_PRESETS = 'story_theater_presets'; // 糯米機原生劇情預設
const STORE_STORY_THEATER_MASKS = 'story_theater_masks'; // 劇場原創人物面具
const STORE_MALL_CATEGORIES = 'mall_categories';     // 購物中心·分類（購物/外賣各自一套，用 kind 區分）
const STORE_MALL_PRODUCTS = 'mall_products';          // 購物中心·商品/外賣條目

// API 調用記錄：保留近 5 天，超期丟棄；再加一個硬上限防止異常情況撐爆
const API_CALL_LOG_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const API_CALL_LOG_MAX_ENTRIES = 2000;

export interface ScheduledMessage {
    id: string;
    charId: string;
    content: string;
    dueAt: number;
    createdAt: number;
}

// Built-in Presets
const SULLY_CATEGORY_ID = 'cat_sully_exclusive';
const SULLY_PRESET_EMOJIS = [
    { name: 'Sully晚安', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/night.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully無語', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/w.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully偷看', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/see.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully打氣', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/fight.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully生氣', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/an.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully疑惑', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/sDN.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully道歉', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/sorry.png', categoryId: SULLY_CATEGORY_ID },
    { name: 'Sully等你消息', url: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/wait.png', categoryId: SULLY_CATEGORY_ID },
];

// 單例連接緩存。openDB 原本每次調用都新開一條 IDB 連接, 既不復用也不 close ——
// 在記憶管線 (hybridSearch / touchAccess 等) 併發讀寫下會瞬間堆出幾十條 AetherOS_Data
// 連接, 撐爆 Chromium 底層 backing store; 一旦底層報錯, 整個 origin 的 IndexedDB
// (含 Service Worker 的 dedupe / inbox 庫) 可能跟著開不了或被強關, 推送消息因此確認超時。
// 改成複用同一條連接, 並在連接被外部失效 (另一 tab 升級版本 / 瀏覽器強制關閉) 時
// 清掉緩存, 下次 openDB 自動重開 —— 一處改, 全部 ~165 個調用點受益。
let dbPromise: Promise<IDBDatabase> | null = null;

/** 和新消息同事務失效鏡像，防止後台把剛清掉的舊水位重新恢復。 */
function clearStaleMemoryMirror(transaction: IDBTransaction, charId: string, newId: number): void {
    const assets = transaction.objectStore(STORE_ASSETS);
    const key = `mp_hwm_v1_${charId}`;
    const request = assets.get(key);
    request.onsuccess = () => {
        const mirror = request.result?.data;
        const hwm = typeof mirror === 'number' ? mirror : Number(mirror?.msgId);
        if (Number.isFinite(hwm) && hwm >= newId) assets.delete(key);
    };
}

export const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // onblocked 不是終態: 它先 reject, 但底層 open request 還活著, 等佔用方關閉後仍會
    // 觸發 onsuccess。用 settled 標記 promise 已 settle, 讓那條遲到的連接被 close 掉而
    // 不是洩漏成一條沒人持有、卻能 block 後續升級/刪庫的孤兒連接。
    // 清緩存一律先比對 dbPromise === promise: onclose/onerror 等都是異步回調, 期間若已
    // 重開並緩存了新 promise, 陳舊連接的回調不能誤清新單例 (否則又憑空多開一條連接)。
    let settled = false;

    request.onerror = () => {
        const err = request.error;
        // 版本回退兜底: 瀏覽器裡已存在「比當前 build 的 DB_VERSION 更高」的版本時
        // (用戶先跑過更新的 build / 另一個 tab 升過級 / SW 緩存了更新的 bundle),
        // 帶 DB_VERSION 打開會拋 VersionError("lower version than existing")。
        // 舊邏輯直接 reject → 整個 origin 的 IndexedDB 讀寫全掛: SYSTEM ERROR、
        // 美化(themes 存在庫裡)讀不出來、線下(LifeSim)進不去。其實更高版本的 store
        // 只是當前 schema 的超集, 不帶版本號打開就能連到現有版本、讀寫完全兼容,
        // 不需要也不能降級建表。所以這裡回退到「不帶版本號 open」一次而不是報死。
        if (err?.name === 'VersionError') {
            console.warn('[DB] open VersionError —— 現有版本高於當前 build, 回退到不帶版本號打開');
            settled = true; // 原 request 已終結 (VersionError 後不會再 onsuccess), 標記以防遲到回調
            const fb = indexedDB.open(DB_NAME); // 不帶版本號 = 連到現有(更高)版本, 不觸發 upgrade
            fb.onsuccess = () => {
                const db = fb.result;
                // 與正常路徑一致地掛上失效自愈回調 (另一 tab 升級 / 瀏覽器強關連接)。
                db.onversionchange = () => {
                    db.close();
                    if (dbPromise === promise) dbPromise = null;
                };
                db.onclose = () => {
                    if (dbPromise === promise) dbPromise = null;
                };
                resolve(db);
            };
            fb.onerror = () => {
                console.error("DB Open Error (versionless fallback):", fb.error);
                if (dbPromise === promise) dbPromise = null;
                reject(fb.error);
            };
            return;
        }
        console.error("DB Open Error:", err);
        if (dbPromise === promise) dbPromise = null; // 打開失敗別把 rejected promise 緩存住
        settled = true;
        reject(err);
    };

    request.onsuccess = () => {
        const db = request.result;
        // 已經 reject 過 (onblocked / onerror): 這條遲到的連接沒人接收, 直接 close,
        // 否則它開著會 block 後續的版本升級 / deleteDatabase。
        if (settled) {
            try { db.close(); } catch { /* ignore */ }
            return;
        }
        // 另一個 tab 觸發版本升級時必須主動 close 讓位, 否則對方 open 會被 block;
        // 順手清緩存, 下次 openDB 重開到新版本。
        db.onversionchange = () => {
            db.close();
            if (dbPromise === promise) dbPromise = null;
        };
        // Chromium 因 backing store 出錯等原因強制關閉連接時觸發 —— 清緩存自愈,
        // 避免後續操作一直複用一條已死的連接。
        //
        // 已知殘餘 (有意不修): onclose 是異步派發的, 強關到回調跑之間, 命中這條 fast-path
        // 的調用方會拿到將死連接, 其 db.transaction() 同步拋 InvalidStateError —— 當次操作
        // 失敗, 但下一次調用就自愈。主庫這 ~165 個調用點全是記憶管線 / UI 讀寫, 失敗是
        // 瞬時且會自然重試的 (不丟數據), 不值得為它給每個調用點鋪事務級重試 (要全覆蓋得上
        // 共享 runTx 層並遷移所有 DB.* 方法, 是獨立大重構)。SW inbox 那條路徑不一樣: 同樣
        // 的競態會讓 push 靜默丟失 → 主線程超時, 所以那邊 (worker/sw-keep-alive.ts 的
        // withInboxTx) 單獨補了「InvalidStateError 清緩存重開一次」的事務級兜底。
        db.onclose = () => {
            if (dbPromise === promise) dbPromise = null;
        };
        resolve(db);
    };

    request.onblocked = () => {
        // 另一個 tab 仍持有舊版本連接, 升級被擋。清緩存 + reject, 別讓調用方無限掛著;
        // 與 activeMsgStore / sw-keep-alive 的 openDB 一致, 對方 tab 關閉後下次調用可重試。
        console.warn('[DB] open blocked —— 另一個 tab 仍持有舊版本連接未關閉');
        if (dbPromise === promise) dbPromise = null;
        settled = true;
        reject(new Error('IndexedDB open blocked —— 關閉其它標籤頁後重試'));
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      const createStore = (name: string, options?: IDBObjectStoreParameters) => {
          if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, options);
          }
      };

      createStore(STORE_CHARACTERS, { keyPath: 'id' });
      createStore(STORE_CHAR_GROUPS, { keyPath: 'id' }); // v68: 角色分組
      createStore(STORE_NPCS, { keyPath: 'id' }); // v72: NPC 檔案

      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id', autoIncrement: true });
        msgStore.createIndex('charId', 'charId', { unique: false });
        msgStore.createIndex('groupId', 'groupId', { unique: false }); 
      } else {
          const msgStore = (event.target as IDBOpenDBRequest).transaction?.objectStore(STORE_MESSAGES);
          if (msgStore && !msgStore.indexNames.contains(STORE_MESSAGES) && !msgStore.indexNames.contains('groupId')) {
              try {
                  msgStore.createIndex('groupId', 'groupId', { unique: false });
              } catch (e) { console.log('Index already exists'); }
          }
      }

      // v62: messages 加 [charId, type] 複合索引。彼方動態按 (charId, 'vr_card') 直取 vr_card，
      // 成本只跟 vr_card 條數相關，跟總消息量無關——上萬條聊天的用戶也不必把整段歷史 getAll
      // 進內存再篩。沒有 type 字段的老消息不會進此索引，正好不影響（我們只查 vr_card）。
      try {
          const msgStore = (event.target as IDBOpenDBRequest).transaction?.objectStore(STORE_MESSAGES);
          if (msgStore && !msgStore.indexNames.contains('charId_type')) {
              msgStore.createIndex('charId_type', ['charId', 'type'], { unique: false });
          }
      } catch (e) { console.log('charId_type index migration skipped', e); }

      createStore(STORE_EMOJIS, { keyPath: 'name' });
      createStore(STORE_EMOJI_CATEGORIES, { keyPath: 'id' });

      createStore(STORE_THEMES, { keyPath: 'id' });
      createStore(STORE_ASSETS, { keyPath: 'id' });
      createStore(STORE_BLOB_ASSETS, { keyPath: 'id' }); // v65: 圖片二進制 Blob 存儲
      
      if (!db.objectStoreNames.contains(STORE_SCHEDULED)) {
        const schedStore = db.createObjectStore(STORE_SCHEDULED, { keyPath: 'id' });
        schedStore.createIndex('charId', 'charId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_GALLERY)) {
          const galleryStore = db.createObjectStore(STORE_GALLERY, { keyPath: 'id' });
          galleryStore.createIndex('charId', 'charId', { unique: false });
      }

      createStore(STORE_USER, { keyPath: 'id' });
      
      if (!db.objectStoreNames.contains(STORE_DIARIES)) {
          const diaryStore = db.createObjectStore(STORE_DIARIES, { keyPath: 'id' });
          diaryStore.createIndex('charId', 'charId', { unique: false });
      }
      
      createStore(STORE_TASKS, { keyPath: 'id' });
      createStore(STORE_ANNIVERSARIES, { keyPath: 'id' });

      if (!db.objectStoreNames.contains(STORE_ROOM_TODOS)) {
          db.createObjectStore(STORE_ROOM_TODOS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_ROOM_NOTES)) {
          const notesStore = db.createObjectStore(STORE_ROOM_NOTES, { keyPath: 'id' });
          notesStore.createIndex('charId', 'charId', { unique: false });
      }

      createStore(STORE_GROUPS, { keyPath: 'id' });
      createStore(STORE_JOURNAL_STICKERS, { keyPath: 'name' });
      createStore(STORE_SOCIAL_POSTS, { keyPath: 'id' });
      createStore(STORE_COURSES, { keyPath: 'id' });
      createStore(STORE_GAMES, { keyPath: 'id' }); 
      createStore(STORE_WORLDBOOKS, { keyPath: 'id' }); 
      createStore(STORE_NOVELS, { keyPath: 'id' });

      createStore(STORE_VR_NOVELS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_VR_ANNOTATIONS)) {
          const vrAnnStore = db.createObjectStore(STORE_VR_ANNOTATIONS, { keyPath: 'id' });
          vrAnnStore.createIndex('novelId', 'novelId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CC_PARTS)) {
          const ccStore = db.createObjectStore(STORE_CC_PARTS, { keyPath: 'id' });
          ccStore.createIndex('categoryKey', 'categoryKey', { unique: false });
      }
      createStore(STORE_VR_MUSIC, { keyPath: 'id' });
      createStore(STORE_VR_GUESTBOOK, { keyPath: 'id' });
      createStore(STORE_VR_SCRIPTS, { keyPath: 'id' });
      createStore(STORE_VR_PLAYS, { keyPath: 'id' });
      createStore(STORE_VR_PRESETS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_VR_LETTERS)) {
          const ltStore = db.createObjectStore(STORE_VR_LETTERS, { keyPath: 'id' });
          ltStore.createIndex('box', 'box', { unique: false });
      }
      createStore(STORE_VR_SETTINGS, { keyPath: 'id' });
      createStore(STORE_API_CALL_LOG, { keyPath: 'id' });

      // v63: 家園（同世界觀多角色大世界）
      createStore(STORE_WORLDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_WORLD_EPISODES)) {
          const weStore = db.createObjectStore(STORE_WORLD_EPISODES, { keyPath: 'id' });
          weStore.createIndex('worldId', 'worldId', { unique: false });
      }

      createStore(STORE_BANK_TX, { keyPath: 'id' });
      createStore(STORE_BANK_DATA, { keyPath: 'id' });
      createStore(STORE_XHS_STOCK, { keyPath: 'id' });

      if (!db.objectStoreNames.contains(STORE_XHS_ACTIVITIES)) {
          const xhsActStore = db.createObjectStore(STORE_XHS_ACTIVITIES, { keyPath: 'id' });
          xhsActStore.createIndex('characterId', 'characterId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_XHS_OWNED_POSTS)) {
          const ownedPostStore = db.createObjectStore(STORE_XHS_OWNED_POSTS, { keyPath: 'id' });
          ownedPostStore.createIndex('characterId', 'characterId', { unique: false });
          ownedPostStore.createIndex('noteId', 'noteId', { unique: false });
      }

      createStore(STORE_SONGS, { keyPath: 'id' });
      createStore(STORE_QUIZZES, { keyPath: 'id' });
      createStore(STORE_GUIDEBOOK, { keyPath: 'id' });
      createStore(STORE_LIFE_SIM, { keyPath: 'id' });
      createStore(STORE_DAILY_SCHEDULE, { keyPath: 'id' });
      createStore(STORE_HANDBOOK, { keyPath: 'id' });

      createStore(STORE_TRACKERS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_TRACKER_ENTRIES)) {
          const teStore = db.createObjectStore(STORE_TRACKER_ENTRIES, { keyPath: 'id' });
          teStore.createIndex('trackerId', 'trackerId', { unique: false });
          teStore.createIndex('date', 'date', { unique: false });
      }

      // v65: 生活記錄（檔案 App）
      if (!db.objectStoreNames.contains(STORE_LIFE_RECORDS)) {
          const lrStore = db.createObjectStore(STORE_LIFE_RECORDS, { keyPath: 'id' });
          lrStore.createIndex('date', 'date', { unique: false });
          lrStore.createIndex('module', 'module', { unique: false });
      }
      createStore(STORE_MED_PLANS, { keyPath: 'id' });
      createStore(STORE_LIFE_SETTINGS, { keyPath: 'id' });
      createStore(STORE_STORY_THEATERS, { keyPath: 'id' });
      createStore(STORE_STORY_THEATER_PRESETS, { keyPath: 'id' });
      createStore(STORE_STORY_THEATER_MASKS, { keyPath: 'id' });

      createStore(STORE_HOTNEWS, { keyPath: 'id' });

      // ─── Memory Palace (記憶宮殿) stores ───
      if (!db.objectStoreNames.contains('memory_nodes')) {
          const mnStore = db.createObjectStore('memory_nodes', { keyPath: 'id' });
          mnStore.createIndex('charId', 'charId', { unique: false });
          mnStore.createIndex('room', 'room', { unique: false });
          mnStore.createIndex('embedded', 'embedded', { unique: false });
          mnStore.createIndex('boxId', 'boxId', { unique: false }); // deprecated，保留索引兼容舊數據
          mnStore.createIndex('eventBoxId', 'eventBoxId', { unique: false });
      } else {
          // Migration: 為已有 memory_nodes 表補建 eventBoxId 索引（v47 新增）
          const mnStore = (event.target as IDBOpenDBRequest).transaction?.objectStore('memory_nodes');
          if (mnStore && !mnStore.indexNames.contains('eventBoxId')) {
              try { mnStore.createIndex('eventBoxId', 'eventBoxId', { unique: false }); }
              catch (e) { console.log('memory_nodes eventBoxId index migration skipped'); }
          }
      }

      if (!db.objectStoreNames.contains('memory_vectors')) {
          const mvStore = db.createObjectStore('memory_vectors', { keyPath: 'memoryId' });
          mvStore.createIndex('charId', 'charId', { unique: false });
      } else {
          // Migration: add charId index to existing memory_vectors store
          const mvStore = (event.target as IDBOpenDBRequest).transaction?.objectStore('memory_vectors');
          if (mvStore && !mvStore.indexNames.contains('charId')) {
              try { mvStore.createIndex('charId', 'charId', { unique: false }); } catch (e) { console.log('memory_vectors charId index migration skipped'); }
          }
      }

      if (!db.objectStoreNames.contains('memory_links')) {
          const mlStore = db.createObjectStore('memory_links', { keyPath: 'id' });
          mlStore.createIndex('sourceId', 'sourceId', { unique: false });
          mlStore.createIndex('targetId', 'targetId', { unique: false });
      }

      if (!db.objectStoreNames.contains('memory_batches')) {
          const mbStore = db.createObjectStore('memory_batches', { keyPath: 'id' });
          mbStore.createIndex('charId', 'charId', { unique: false });
      }

      if (!db.objectStoreNames.contains('topic_boxes')) {
          const tbStore = db.createObjectStore('topic_boxes', { keyPath: 'id' });
          tbStore.createIndex('charId', 'charId', { unique: false });
          tbStore.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains('anticipations')) {
          const antStore = db.createObjectStore('anticipations', { keyPath: 'id' });
          antStore.createIndex('charId', 'charId', { unique: false });
          antStore.createIndex('status', 'status', { unique: false });
      }

      // ─── EventBox（事件盒，v47 新增） ───────────────
      if (!db.objectStoreNames.contains('event_boxes')) {
          const ebStore = db.createObjectStore('event_boxes', { keyPath: 'id' });
          ebStore.createIndex('charId', 'charId', { unique: false });
      }

      // ─── 房間門牌（v65 新增，情景→語義固化層） ───────
      if (!db.objectStoreNames.contains('room_plates')) {
          const rpStore = db.createObjectStore('room_plates', { keyPath: 'id' });
          rpStore.createIndex('charId', 'charId', { unique: false });
      }

      // ─── 消化日誌（v66 新增，認知消化可回看記錄） ─────
      if (!db.objectStoreNames.contains('digest_reports')) {
          const drStore = db.createObjectStore('digest_reports', { keyPath: 'id' });
          drStore.createIndex('charId', 'charId', { unique: false });
      }

      // ─── v48 一次性強制清空記憶宮殿（EventBox 體系，舊 boxId 數據不兼容） ───
      //     oldVersion === 0 = 全新安裝，沒東西可清
      //     oldVersion >= 48 = 已經清過，跳過
      //     0 < oldVersion < 48 = 現有用戶升級 → 清一次
      const oldVersion = event.oldVersion || 0;
      if (oldVersion > 0 && oldVersion < 48) {
          const upgradeTx = (event.target as IDBOpenDBRequest).transaction;
          const MP_STORES_TO_CLEAR = [
              'memory_nodes', 'memory_vectors', 'memory_links',
              'memory_batches', 'topic_boxes', 'anticipations', 'event_boxes',
          ];
          let cleared = 0;
          for (const name of MP_STORES_TO_CLEAR) {
              if (db.objectStoreNames.contains(name) && upgradeTx) {
                  try {
                      upgradeTx.objectStore(name).clear();
                      cleared++;
                  } catch (e) {
                      console.warn(`[DB v48 wipe] skip ${name}:`, e);
                  }
              }
          }
          // 同步清理 localStorage 裡的高水位標記
          let hwmCleared = 0;
          try {
              const toRemove: string[] = [];
              for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i);
                  if (key && key.startsWith('mp_lastMsgId_')) toRemove.push(key);
              }
              for (const key of toRemove) { localStorage.removeItem(key); hwmCleared++; }
          } catch { /* ignore */ }
          console.log(`🗑️ [DB v48] 一次性清空完成：${cleared} 個 store，${hwmCleared} 個高水位（oldVersion=${oldVersion}）`);
      }

      // ─── Pixel Home（像素家園）stores ───────────────
      if (!db.objectStoreNames.contains('pixel_home_assets')) {
          const phaStore = db.createObjectStore('pixel_home_assets', { keyPath: 'id' });
          phaStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('pixel_home_layouts')) {
          const phlStore = db.createObjectStore('pixel_home_layouts', { keyPath: ['charId', 'roomId'] });
          phlStore.createIndex('charId', 'charId', { unique: false });
      }

      // ─── 購物中心（商品/外賣目錄）v73 ───────────────
      createStore(STORE_MALL_CATEGORIES, { keyPath: 'id' });
      createStore(STORE_MALL_PRODUCTS, { keyPath: 'id' });
    };
  });

  dbPromise = promise;
  return promise;
};

/**
 * 家園關係條讀時遷移：早期格式是無序對 {aId,bId}（雙方共用一個數值），
 * 現為有向 {fromId,toId}（你對ta ≠ ta對你）。舊邊拆成兩條對稱有向邊，數值/關係名照抄，
 * 之後各自的演繹會讓兩邊自然分化。
 */
const normalizeWorldRelationships = (world: WorldProfile): WorldProfile => {
    const rels = world.relationships || [];
    if (!rels.some((r: any) => r.aId !== undefined)) return world;
    const out: WorldProfile['relationships'] = [];
    const has = (fromId: string, toId: string) => out.some(r => r.fromId === fromId && r.toId === toId);
    for (const r of rels as any[]) {
        if (r.aId !== undefined && r.bId !== undefined) {
            if (!has(r.aId, r.bId)) out.push({ fromId: r.aId, toId: r.bId, label: r.label, value: r.value ?? 50 });
            if (!has(r.bId, r.aId)) out.push({ fromId: r.bId, toId: r.aId, label: r.label, value: r.value ?? 50 });
        } else if (r.fromId !== undefined && r.toId !== undefined && !has(r.fromId, r.toId)) {
            out.push(r);
        }
    }
    return { ...world, relationships: out };
};

export const DB = {
  deleteDB: async (): Promise<void> => {
      // 刪庫前先關掉單例連接, 否則這條還開著的連接會 block 掉 deleteDatabase。
      if (dbPromise) {
          try { (await dbPromise).close(); } catch { /* ignore */ }
          dbPromise = null;
      }
      return new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase(DB_NAME);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => console.warn('Delete blocked');
      });
  },

  getCharacter: async (id: string): Promise<CharacterProfile | undefined> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_CHARACTERS, 'readonly').objectStore(STORE_CHARACTERS).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  getAllCharacters: async (): Promise<CharacterProfile[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHARACTERS, 'readonly');
      const store = transaction.objectStore(STORE_CHARACTERS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveCharacter: async (character: CharacterProfile): Promise<void> => {
    const db = await openDB();
    // 等事務真正提交再 resolve —— 否則調用方 await 後立刻重讀 DB 會拿到舊值 (情緒 buff 落庫競態根因).
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHARACTERS, 'readwrite');
      transaction.objectStore(STORE_CHARACTERS).put(character);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('saveCharacter aborted'));
    });
  },

  deleteCharacter: async (id: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_CHARACTERS, 'readwrite');
    transaction.objectStore(STORE_CHARACTERS).delete(id);
  },

  // ---- NPC 檔案（神經鏈接「NPC」分頁，獨立於 characters）----

  getAllNPCs: async (): Promise<NPCProfile[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NPCS, 'readonly');
      const store = transaction.objectStore(STORE_NPCS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveNPC: async (npc: NPCProfile): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NPCS, 'readwrite');
      transaction.objectStore(STORE_NPCS).put(npc);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('saveNPC aborted'));
    });
  },

  deleteNPC: async (id: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_NPCS, 'readwrite');
    transaction.objectStore(STORE_NPCS).delete(id);
  },

  // ---- 角色分組（神經鏈接"文件夾"，與群聊 groups 無關）----

  getCharacterGroups: async (): Promise<CharacterGroup[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(STORE_CHAR_GROUPS)) {
        resolve([]);
        return;
      }
      const transaction = db.transaction(STORE_CHAR_GROUPS, 'readonly');
      const request = transaction.objectStore(STORE_CHAR_GROUPS).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveCharacterGroup: async (group: CharacterGroup): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHAR_GROUPS, 'readwrite');
      transaction.objectStore(STORE_CHAR_GROUPS).put(group);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('saveCharacterGroup aborted'));
    });
  },

  // 只刪分組定義。組內角色的 groupId 回落由 OSContext.deleteCharacterGroup 負責
  // （角色 state 在 context 裡，這裡改了 DB 不改 state 會出現"刪組后角色還掛在幽靈組裡"）。
  deleteCharacterGroup: async (id: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_CHAR_GROUPS, 'readwrite');
      transaction.objectStore(STORE_CHAR_GROUPS).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },

  /**
   * 獲取角色的私聊消息。
   * @param includeProcessed 是否包含已被記憶宮殿處理的消息（默認 false，即自動過濾）。
   *                         記憶歸檔、批量總結等需要完整歷史的場景應傳 true。
   */
  getMessagesByCharId: async (charId: string, includeProcessed: boolean = false): Promise<Message[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const request = index.getAll(IDBKeyRange.only(charId));
      request.onsuccess = () => {
          let results = (request.result || []).filter((m: Message) => !m.groupId);
          // 記憶宮殿：過濾已處理的消息（高水位標記之前的），用向量記憶替代
          if (!includeProcessed) {
              try {
                  const hwm = parseInt(localStorage.getItem(`mp_lastMsgId_${charId}`) || '0', 10);
                  if (hwm > 0) {
                      results = results.filter((m: Message) => m.id > hwm);
                  }
              } catch {}
          }
          resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * 某個角色的聊天條數。走 charId 索引的 count()，**一條消息都不會被讀出來**，
   * IndexedDB 只回一個數字。使用統計的規模檔位用它，別拿 getMessagesByCharId
   * 去 length ——那會把整段聊天記錄讀進內存。
   */
  countMessagesByCharId: async (charId: string): Promise<number> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const request = transaction.objectStore(STORE_MESSAGES).index('charId').count(IDBKeyRange.only(charId));
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    });
  },

  // Performance: Load only the most recent N messages for a character
  getRecentMessagesByCharId: async (charId: string, limit: number, includeProcessed: boolean = false): Promise<Message[]> => {
    const db = await openDB();
    const hwm = includeProcessed ? 0 : (() => {
        try { return parseInt(localStorage.getItem(`mp_lastMsgId_${charId}`) || '0', 10) || 0; } catch { return 0; }
    })();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const collected: Message[] = [];
      const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && collected.length < limit) {
              const m = cursor.value as Message;
              if (!m.groupId && (includeProcessed || m.id > hwm)) collected.push(m);
              cursor.continue();
          } else {
              resolve(collected.reverse());
          }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  // DateApp 等按來源展示的輕量歷史讀取：用 charId 索引倒序掃，只收集目標 source 的最近 N 條。
  // 這樣不會為了渲染見面閱讀模式，把該角色全量聊天（含圖片/base64消息）一次性 getAll 進內存。
  getRecentMessagesByCharIdAndSource: async (charId: string, source: string, limit: number): Promise<Message[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const collected: Message[] = [];
      const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && collected.length < limit) {
              const m = cursor.value as Message;
              if (!m.groupId && m.metadata?.source === source) collected.push(m);
              cursor.continue();
          } else {
              resolve(collected.reverse());
          }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  // 彼方動態專用：撈某角色全部 vr_card，不受"最近 N 條窗口"、記憶宮殿高水位
  // （mp_lastMsgId）、歸檔隱藏起點（char.hideBeforeMessageId）影響。
  // 這些機制只管「LLM 上下文能否看到」；彼方動態是用戶自己的瀏覽界面，
  // 只要消息還在 IndexedDB 裡就應當永遠可見——哪怕它早被新聊天擠出聊天取數窗口、
  // 或被歸檔標記為「對 AI 隱藏」。（清空聊天會真刪消息，刪掉就沒了——那是預期行為。）
  //
  // 性能：走 [charId, type] 複合索引直取 vr_card，成本只跟該角色 vr_card 條數相關，
  // 跟總消息量無關——上萬條聊天的用戶也不會把整段歷史讀進內存。
  getVRCardsByCharId: async (charId: string): Promise<Message[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      if (store.indexNames.contains('charId_type')) {
          const idx = store.index('charId_type');
          const req = idx.getAll(IDBKeyRange.only([charId, 'vr_card']));
          req.onsuccess = () => {
              const results = (req.result || []).filter((m: Message) => !m.groupId && (m as any).metadata?.vrCard);
              resolve(results);
          };
          req.onerror = () => reject(req.error);
          return;
      }
      // 兜底：複合索引尚未建好的極少數情況（如升級事務還沒跑完），用倒序游標掃，
      // 湊夠 80 條 vr_card 即停——避免 getAll 整段歷史。
      const index = store.index('charId');
      const collected: Message[] = [];
      const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && collected.length < 80) {
              const m = cursor.value as Message;
              if (!m.groupId && m.type === 'vr_card' && (m as any).metadata?.vrCard) collected.push(m);
              cursor.continue();
          } else {
              resolve(collected);
          }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  // UI 讀取不受記憶水位影響。先按展示範圍篩選，再湊滿 N 條，避免見面/通話佔滿窗口。
  // totalCount 仍是廉價的索引計數上限；游標已取盡時，調用方用實際展示條數替代它。
  getRecentMessagesWithCount: async (charId: string, limit: number, accept?: (message: Message) => boolean): Promise<{ messages: Message[], totalCount: number }> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const countReq = index.count(IDBKeyRange.only(charId));
      countReq.onsuccess = () => {
          const totalCount = countReq.result;
          // Use reverse cursor to only collect the last N messages
          const collected: Message[] = [];
          const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
          cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor && collected.length < limit) {
                  const m = cursor.value as Message;
                  if (!m.groupId && (!accept || accept(m))) collected.push(m);
                  cursor.continue();
              } else {
                  resolve({ messages: collected.reverse(), totalCount });
              }
          };
          cursorReq.onerror = () => reject(cursorReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  },

  // Get all messages for a character from a given message ID onward (for hideBeforeMessageId)
  getMessagesFromId: async (charId: string, fromId: number): Promise<{ messages: Message[], totalCount: number }> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const collected: Message[] = [];
      const cursorReq = index.openCursor(IDBKeyRange.only(charId), 'prev');
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && Number(cursor.primaryKey) >= fromId) {
              const m = cursor.value as Message;
              if (!m.groupId && m.id >= fromId) {
                  collected.push(m);
              }
              cursor.continue();
          } else {
              resolve({ messages: collected.reverse(), totalCount: collected.length });
          }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  saveMessage: async (msg: Omit<Message, 'id' | 'timestamp'> & { timestamp?: number }): Promise<number> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_MESSAGES, STORE_ASSETS], 'readwrite');
        const store = transaction.objectStore(STORE_MESSAGES);
        const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();
        const { timestamp: _ignored, ...payload } = msg;
        const request = store.add({ ...payload, timestamp });
        request.onsuccess = () => clearStaleMemoryMirror(transaction, msg.charId, request.result as number);
        // request 成功後事務仍可能回滾。主動消息通知和定時任務銷帳都必須等提交。
        transaction.oncomplete = () => {
            const newId = request.result as number;
            // 水位線自愈：新消息的自增 id 必然大於既有一切消息 id，也就必然大於水位線
            // （水位線本身是某條舊消息的 id）。出現 newId ≤ 水位線，說明水位與消息
            // ID 序列不一致（例如清庫/恢復後的殘留）。鏡像已在同事務內清理，提交後
            // 再清本地值，避免新消息從 AI 上下文消失（請求只剩 system → 上游 400）。
            try {
                const staleKeys = [`mp_lastMsgId_${msg.charId}`];
                if (msg.groupId) staleKeys.push(`mp_lastMsgId_group_${msg.groupId}`);
                for (const key of staleKeys) {
                    const hwm = parseInt(localStorage.getItem(key) || '0', 10) || 0;
                    if (hwm >= newId) localStorage.removeItem(key);
                }
            } catch { /* localStorage 不可用時靜默跳過 */ }
            resolve(newId);
        };
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error || new Error('消息未能保存'));
        transaction.onabort = () => reject(transaction.error || new Error('消息未能保存'));
    });
  },

  /** One persisted message per logical delivery, including retries after a tab closes. */
  saveMessageOnce: async (deliveryId: string, msg: Omit<Message, 'id' | 'timestamp'> & { timestamp?: number }): Promise<number> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_MESSAGES, STORE_ASSETS], 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      let savedId = 0;
      let inserted = false;
      const cursorRequest = store.index('charId').openCursor(IDBKeyRange.only(msg.charId), 'prev');
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          if (cursor.value.metadata?.deliveryId === deliveryId) { savedId = cursor.value.id; return; }
          cursor.continue(); return;
        }
        const request = store.add({ ...msg, timestamp: msg.timestamp ?? Date.now(), metadata: { ...msg.metadata, deliveryId } });
        request.onsuccess = () => {
          savedId = request.result as number;
          inserted = true;
          clearStaleMemoryMirror(tx, msg.charId, savedId);
        };
      };
      tx.oncomplete = () => {
        if (inserted) {
          try {
            for (const key of [`mp_lastMsgId_${msg.charId}`, ...(msg.groupId ? [`mp_lastMsgId_group_${msg.groupId}`] : [])]) {
              if (parseInt(localStorage.getItem(key) || '0', 10) >= savedId) localStorage.removeItem(key);
            }
          } catch { /* message was committed even if browser preferences are unavailable */ }
        }
        resolve(savedId);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('消息未能保存'));
    });
  },

  updateMessage: async (id: number, content: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
    const store = transaction.objectStore(STORE_MESSAGES);
    
    // 同 saveAsset：等事務落盤再 resolve。put 發完就 resolve 的話，配額不足
    // （iOS Safari 常見）時改寫靜默丟失，界面上還是新內容、庫裡卻是舊的。
    return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => {
            const data = req.result as Message;
            if (data) {
                data.content = content;
                store.put(data);
            } else {
                reject(new Error('Message not found'));
            }
        };
        req.onerror = () => reject(req.error);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('updateMessage transaction aborted'));
    });
  },

  getMessageById: async (id: number): Promise<Message | null> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const request = transaction.objectStore(STORE_MESSAGES).get(id);
      request.onsuccess = () => resolve((request.result as Message | undefined) || null);
      request.onerror = () => reject(request.error);
    });
  },

  findImageMessageByUrl: async (charId: string, url: string): Promise<Message | null> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readonly');
      const request = transaction.objectStore(STORE_MESSAGES).index('charId').openCursor(IDBKeyRange.only(charId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(null);
          return;
        }
        const message = cursor.value as Message;
        if (!message.groupId && message.type === 'image' && message.content === url) {
          resolve(message);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  },

  updateMessageMetadata: async (id: number, updater: (prev: any) => any): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
    const store = transaction.objectStore(STORE_MESSAGES);

    return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => {
            const data = req.result as Message | undefined;
            if (data) {
                (data as any).metadata = updater((data as any).metadata);
                store.put(data);
                resolve();
            } else {
                reject(new Error('Message not found'));
            }
        };
        req.onerror = () => reject(req.error);
    });
  },

  deleteMessage: async (id: number): Promise<void> => {
    const { preserveContentFavoritesBeforeMessageDeletion } = await import('./contentFavorites');
    await preserveContentFavoritesBeforeMessageDeletion({ ids: [id] });
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
      transaction.objectStore(STORE_MESSAGES).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('deleteMessage aborted'));
    });
  },

  deleteMessages: async (ids: number[]): Promise<void> => {
      if (!ids.length) return;
      const { preserveContentFavoritesBeforeMessageDeletion } = await import('./contentFavorites');
      await preserveContentFavoritesBeforeMessageDeletion({ ids });
      const db = await openDB();
      const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = transaction.objectStore(STORE_MESSAGES);
      ids.forEach(id => store.delete(id));
      return new Promise((resolve) => {
          transaction.oncomplete = () => resolve();
      });
  },

  clearMessages: async (charId: string): Promise<void> => {
    const { preserveContentFavoritesBeforeMessageDeletion } = await import('./contentFavorites');
    await preserveContentFavoritesBeforeMessageDeletion({ charId });
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = transaction.objectStore(STORE_MESSAGES);
      const index = store.index('charId');
      const request = index.openCursor(IDBKeyRange.only(charId));

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
            const m = cursor.value as Message;
            if (!m.groupId) {
                store.delete(cursor.primaryKey);
            }
            cursor.continue();
        }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('clearMessages aborted'));
    });
  },

  getGroups: async (): Promise<GroupProfile[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_GROUPS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GROUPS, 'readonly');
          const store = transaction.objectStore(STORE_GROUPS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveGroup: async (group: GroupProfile): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GROUPS, 'readwrite');
      transaction.objectStore(STORE_GROUPS).put(group);
  },

  deleteGroup: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GROUPS, 'readwrite');
      transaction.objectStore(STORE_GROUPS).delete(id);
  },

  getGroupMessages: async (groupId: string): Promise<Message[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_MESSAGES, 'readonly');
          const store = transaction.objectStore(STORE_MESSAGES);
          const index = store.index('groupId');
          const request = index.getAll(IDBKeyRange.only(groupId));
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  getRecentGroupMessagesWithCount: async (groupId: string, limit: number): Promise<{ messages: Message[], totalCount: number }> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_MESSAGES, 'readonly');
          const store = transaction.objectStore(STORE_MESSAGES);
          const index = store.index('groupId');
          const countReq = index.count(IDBKeyRange.only(groupId));
          countReq.onsuccess = () => {
              const totalCount = countReq.result;
              const collected: Message[] = [];
              const cursorReq = index.openCursor(IDBKeyRange.only(groupId), 'prev');
              cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result;
                  if (cursor && collected.length < limit) {
                      collected.push(cursor.value as Message);
                      cursor.continue();
                  } else {
                      resolve({ messages: collected.reverse(), totalCount });
                  }
              };
              cursorReq.onerror = () => reject(cursorReq.error);
          };
          countReq.onerror = () => reject(countReq.error);
      });
  },

  getSocialPosts: async (): Promise<SocialPost[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_SOCIAL_POSTS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readonly');
          const store = transaction.objectStore(STORE_SOCIAL_POSTS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveSocialPost: async (post: SocialPost): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readwrite');
      transaction.objectStore(STORE_SOCIAL_POSTS).put(post);
  },

  deleteSocialPost: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readwrite');
      transaction.objectStore(STORE_SOCIAL_POSTS).delete(id);
  },

  clearSocialPosts: async (): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SOCIAL_POSTS, 'readwrite');
      transaction.objectStore(STORE_SOCIAL_POSTS).clear();
  },

  getEmojis: async (): Promise<Emoji[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_EMOJIS, 'readonly');
      const store = transaction.objectStore(STORE_EMOJIS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveEmoji: async (name: string, url: string, categoryId?: string): Promise<void> => {
    const db = await openDB();
    // 同 saveAsset：等事務真正落盤並把失敗拋出去。發完 put 就返回的話，配額不足
    // （iOS Safari 常見）時寫入靜默丟失，「一鍵優化」還會照報「已轉 N 張」。
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_EMOJIS, 'readwrite');
      transaction.objectStore(STORE_EMOJIS).put({ name, url, categoryId });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('saveEmoji transaction aborted'));
    });
  },

  deleteEmoji: async (name: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_EMOJIS, 'readwrite');
    transaction.objectStore(STORE_EMOJIS).delete(name);
  },

  // 表情包重命名: name 是主鍵, 改名 = 刪舊鍵 + 寫新鍵 (保留 url / categoryId)。
  // 新名為空、與舊名相同、或已被佔用都會拋錯, 讓調用方提示用戶。
  renameEmoji: async (oldName: string, newName: string): Promise<void> => {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('表情包名稱不能為空');
    if (trimmed === oldName) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_EMOJIS, 'readwrite');
      const store = tx.objectStore(STORE_EMOJIS);
      const getReq = store.get(oldName);
      getReq.onsuccess = () => {
        const record = getReq.result as Emoji | undefined;
        if (!record) { reject(new Error('未找到要重命名的表情包')); return; }
        const dupReq = store.get(trimmed);
        dupReq.onsuccess = () => {
          if (dupReq.result) { reject(new Error('已存在同名表情包')); return; }
          store.delete(oldName);
          store.put({ ...record, name: trimmed });
        };
        dupReq.onerror = () => reject(dupReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  getEmojiCategories: async (): Promise<EmojiCategory[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_EMOJI_CATEGORIES)) {
              resolve([]);
              return;
          }
          const transaction = db.transaction(STORE_EMOJI_CATEGORIES, 'readonly');
          const store = transaction.objectStore(STORE_EMOJI_CATEGORIES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveEmojiCategory: async (category: EmojiCategory): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_EMOJI_CATEGORIES, 'readwrite');
      transaction.objectStore(STORE_EMOJI_CATEGORIES).put(category);
  },

  deleteEmojiCategory: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction([STORE_EMOJI_CATEGORIES, STORE_EMOJIS], 'readwrite');
      tx.objectStore(STORE_EMOJI_CATEGORIES).delete(id);
      const emojiStore = tx.objectStore(STORE_EMOJIS);
      const request = emojiStore.getAll();
      request.onsuccess = () => {
          const allEmojis = request.result as Emoji[];
          allEmojis.forEach(e => {
              if (e.categoryId === id) {
                  emojiStore.delete(e.name);
              }
          });
      };
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  // 「幽靈表情包」清理：刪角色不會級聯清理表情分類，導致只對已刪角色可見的
  // 專屬分類在單聊面板裡被過濾掉（看不到也刪不掉），卻仍會出現在群聊表情面板
  // 和 AI 提示詞裡。按「現存角色 id 白名單」做三件事：
  //   1. 分類綁定裡指向已刪角色的 id → 剔除（部分失效只修綁定，不動表情）
  //   2. 剔除後一個角色都不剩的非系統分類 → 整個刪除，連同分類下所有表情
  //   3. categoryId 指向已不存在分類的表情 → 刪除（無主表情）
  // dryRun=true 只掃描統計、不落庫，供 UI 做「先掃描再確認」。
  cleanupEmojiResidue: async (
      validCharacterIds: string[],
      options: { dryRun?: boolean } = {}
  ): Promise<{
      removedCategories: { id: string; name: string }[];
      fixedCategories: { id: string; name: string }[];
      removedEmojiCount: number;
  }> => {
      const validIds = new Set(validCharacterIds);
      const [categories, emojis] = await Promise.all([DB.getEmojiCategories(), DB.getEmojis()]);

      const removedCategories: { id: string; name: string }[] = [];
      const fixedCategories: EmojiCategory[] = [];
      for (const cat of categories) {
          if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) continue; // 全員可見，不動
          const alive = cat.allowedCharacterIds.filter(cid => validIds.has(cid));
          if (alive.length === cat.allowedCharacterIds.length) continue; // 綁定全部有效
          if (alive.length === 0 && !cat.isSystem) {
              removedCategories.push({ id: cat.id, name: cat.name });
          } else {
              // 系統分類綁定全失效時也走這裡：清空綁定回落「全員可見」，絕不刪系統分類
              fixedCategories.push({ ...cat, allowedCharacterIds: alive });
          }
      }

      const removedCatIds = new Set(removedCategories.map(c => c.id));
      const remainingCatIds = new Set(categories.map(c => c.id).filter(id => !removedCatIds.has(id)));
      const emojisToDelete = emojis.filter(e => e.categoryId && !remainingCatIds.has(e.categoryId));

      if (!options.dryRun && (removedCategories.length || fixedCategories.length || emojisToDelete.length)) {
          const db = await openDB();
          const tx = db.transaction([STORE_EMOJI_CATEGORIES, STORE_EMOJIS], 'readwrite');
          const catStore = tx.objectStore(STORE_EMOJI_CATEGORIES);
          const emojiStore = tx.objectStore(STORE_EMOJIS);
          removedCategories.forEach(c => catStore.delete(c.id));
          fixedCategories.forEach(c => catStore.put(c));
          emojisToDelete.forEach(e => emojiStore.delete(e.name));
          await new Promise<void>((resolve, reject) => {
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
              tx.onabort = () => reject(tx.error);
          });
      }

      return {
          removedCategories,
          fixedCategories: fixedCategories.map(c => ({ id: c.id, name: c.name })),
          removedEmojiCount: emojisToDelete.length,
      };
  },

  initializeEmojiData: async (): Promise<void> => {
      const cats = await DB.getEmojiCategories();
      // 巧妙利用 UI 強制保留 default 分類的特性：
      // 只要初始化過一次，cats.length 至少為 1（必然包含 default）。
      // 只有全量清空的首次安裝，cats.length 才為 0。這樣無需 localStorage 即可避免內置分類無限復活。
      if (cats.length === 0) {
          await DB.saveEmojiCategory({ id: 'default', name: '默認', isSystem: true });
          // 去掉 isSystem 標記，允許用戶在 UI 裡直接刪除此分類
          await DB.saveEmojiCategory({ id: SULLY_CATEGORY_ID, name: 'Sully 專屬', isSystem: false });
          const db = await openDB();
          const tx = db.transaction(STORE_EMOJIS, 'readwrite');
          const store = tx.objectStore(STORE_EMOJIS);
          SULLY_PRESET_EMOJIS.forEach(emoji => store.put(emoji));
          await new Promise(resolve => { tx.oncomplete = resolve; });
      }
  },

  getThemes: async (): Promise<ChatTheme[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_THEMES, 'readonly');
      const store = transaction.objectStore(STORE_THEMES);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveTheme: async (theme: ChatTheme): Promise<void> => {
    const db = await openDB();
    // 同 saveAsset：等事務落盤，配額不足時把錯誤拋給調用方，別讓主題「保存成功」是假的。
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_THEMES, 'readwrite');
      transaction.objectStore(STORE_THEMES).put(theme);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('saveTheme transaction aborted'));
    });
  },

  deleteTheme: async (id: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_THEMES, 'readwrite');
    transaction.objectStore(STORE_THEMES).delete(id);
  },

  getAllAssets: async (): Promise<{id: string, data: string}[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_ASSETS, 'readonly');
      const store = transaction.objectStore(STORE_ASSETS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  getAsset: async (id: string): Promise<string | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_ASSETS, 'readonly');
          const store = transaction.objectStore(STORE_ASSETS);
          const request = store.get(id);
          request.onsuccess = () => resolve(request.result?.data || null);
          request.onerror = () => reject(request.error);
      });
  },

  saveAsset: async (id: string, data: string): Promise<void> => {
    const db = await openDB();
    // 等事務真正落盤並把失敗拋出去：舊實現發完 put 就返回，配額不足（iOS Safari 常見）
    // 時寫入靜默丟失，調用方還以為保存成功了。
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ASSETS, 'readwrite');
        transaction.objectStore(STORE_ASSETS).put({ id, data });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  },

  getAssetRaw: async (id: string): Promise<any | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_ASSETS, 'readonly');
          const store = transaction.objectStore(STORE_ASSETS);
          const request = store.get(id);
          request.onsuccess = () => resolve(request.result?.data ?? null);
          request.onerror = () => reject(request.error);
      });
  },

  saveAssetRaw: async (id: string, data: any): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_ASSETS, 'readwrite');
          transaction.objectStore(STORE_ASSETS).put({ id, data });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('saveAssetRaw transaction aborted'));
      });
  },

  deleteAsset: async (id: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_ASSETS, 'readwrite');
      transaction.objectStore(STORE_ASSETS).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('deleteAsset aborted'));
    });
  },

  // ─── Blob 資源（圖片二進制，見 utils/blobRef.ts）───────────────
  // IndexedDB 原生支持存 Blob（結構化克隆），比 base64 省 ~33% 空間、不佔 JS 堆，
  // 讀出後用 URL.createObjectURL 渲染即可。舊庫（<v65）可能還沒有此 store，讀操作做空兜底。
  getBlobAsset: async (id: string): Promise<Blob | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_BLOB_ASSETS)) return null;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BLOB_ASSETS, 'readonly');
          const store = transaction.objectStore(STORE_BLOB_ASSETS);
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result?.blob as Blob) ?? null);
          request.onerror = () => reject(request.error);
      });
  },

  putBlobAsset: async (id: string, blob: Blob): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BLOB_ASSETS, 'readwrite');
          transaction.objectStore(STORE_BLOB_ASSETS).put({ id, blob });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('putBlobAsset aborted'));
      });
  },

  deleteBlobAsset: async (id: string): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_BLOB_ASSETS)) return;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BLOB_ASSETS, 'readwrite');
          transaction.objectStore(STORE_BLOB_ASSETS).delete(id);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('deleteBlobAsset aborted'));
      });
  },

  // 只列 blobRef 命名空間的 id（img_ 存量 / b_ SDK 新生成）。blob_assets 是混用表，
  // GC 的世界觀必須限制在自己的前綴內；今後往這張表加新 id 族時不得使用這兩個前綴。
  listBlobAssetIds: async (): Promise<string[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_BLOB_ASSETS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BLOB_ASSETS, 'readonly');
          const store = transaction.objectStore(STORE_BLOB_ASSETS);
          const request = store.getAllKeys();
          request.onsuccess = () => {
              const keys = request.result || [];
              resolve(keys.filter((k): k is string =>
                  typeof k === 'string' && (k.startsWith('img_') || k.startsWith('b_'))
              ));
          };
          request.onerror = () => reject(request.error);
      });
  },

  // 按主鍵升序分頁讀一個 store 的行（afterKey 傳 null 從頭開始）。給 GC 的引用面
  // 枚舉用（utils/blobGc.ts）：async generator 每次 yield 都會掛起、IDB 事務撐不過
  // 掛起，游標沒法跨 yield 拿著用，只能每批開一個新的 readonly 事務。
  // 注意：枚舉失敗必須把錯誤拋出去——GC 的安全閥靠它整輪放棄，吞錯靜默返回空
  // 等於「這張表沒有引用」，會把活圖當孤兒刪掉。
  getStoreRowsPage: async (
      storeName: string,
      afterKey: IDBValidKey | null,
      limit: number,
  ): Promise<{ rows: unknown[]; lastKey: IDBValidKey | null }> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return { rows: [], lastKey: null };
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readonly');
          const store = transaction.objectStore(storeName);
          const range = afterKey === null ? undefined : IDBKeyRange.lowerBound(afterKey, true);
          // 同一事務裡 getAll + getAllKeys：行給引用掃描，鍵尾巴當下一頁的起點。
          const rowsRequest = store.getAll(range, limit);
          const keysRequest = store.getAllKeys(range, limit);
          let rows: unknown[] | null = null;
          let keys: IDBValidKey[] | null = null;
          const maybeResolve = () => {
              if (rows !== null && keys !== null) {
                  resolve({ rows, lastKey: keys.at(-1) ?? null });
              }
          };
          rowsRequest.onsuccess = () => { rows = rowsRequest.result || []; maybeResolve(); };
          keysRequest.onsuccess = () => { keys = keysRequest.result || []; maybeResolve(); };
          rowsRequest.onerror = () => reject(rowsRequest.error);
          keysRequest.onerror = () => reject(keysRequest.error);
          transaction.onabort = () => reject(transaction.error || new Error('getStoreRowsPage aborted'));
      });
  },

  // 數一張表有多少行，不讀行裡的內容。給「優化資源存儲」算進度條總數用
  // （utils/storageOptimize.ts）：那幾張表加起來能有幾十 MB，只為算個總數就整表讀進內存太虧，
  // count() 只回行數，代價跟表裡存了多大的圖基本無關。
  // 表不存在時返回 0，跟 getStoreRowsPage 的空頁兜底一個口徑：沒有這張表 = 沒有行。
  countStoreRows: async (storeName: string): Promise<number> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return 0;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readonly');
          const request = transaction.objectStore(storeName).count();
          request.onsuccess = () => resolve(request.result || 0);
          request.onerror = () => reject(request.error);
          transaction.onabort = () => reject(transaction.error || new Error('countStoreRows aborted'));
      });
  },

  /**
   * 通用整行寫回（引用改寫用，見 utils/blobDedupe.ts）。傳進來的必須是從同一張表讀出、
   * 原地改過的行——引用面那 7 張表都是 inline keyPath，put(row) 自帶主鍵，不會另起新行。
   * 一頁一個事務：中途失敗時先前提交的頁不回滾，但引用改寫是冪等的（同一份 mapping
   * 再跑一遍結果相同），重跑即可補齊。
   */
  putStoreRows: async (storeName: string, rows: unknown[]): Promise<void> => {
      if (rows.length === 0) return;
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readwrite');
          const store = transaction.objectStore(storeName);
          for (const row of rows) store.put(row as any);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error(`putStoreRows(${storeName}) aborted`));
      });
  },

  getJournalStickers: async (): Promise<{name: string, url: string}[]> => {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_JOURNAL_STICKERS)) return [];
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_JOURNAL_STICKERS, 'readonly');
      const store = transaction.objectStore(STORE_JOURNAL_STICKERS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  saveJournalSticker: async (name: string, url: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_JOURNAL_STICKERS, 'readwrite');
    transaction.objectStore(STORE_JOURNAL_STICKERS).put({ name, url });
  },

  deleteJournalSticker: async (name: string): Promise<void> => {
    const db = await openDB();
    const transaction = db.transaction(STORE_JOURNAL_STICKERS, 'readwrite');
    transaction.objectStore(STORE_JOURNAL_STICKERS).delete(name);
  },

  saveGalleryImage: async (img: GalleryImage): Promise<void> => {
      const db = await openDB();
      // 同 saveAsset：等事務落盤並把失敗拋出去，配額不足時不再靜默丟圖。
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GALLERY, 'readwrite');
          transaction.objectStore(STORE_GALLERY).put(img);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('saveGalleryImage transaction aborted'));
      });
  },

  getGalleryImages: async (charId?: string): Promise<GalleryImage[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GALLERY, 'readonly');
          const store = transaction.objectStore(STORE_GALLERY);
          let request;
          if (charId) {
              const index = store.index('charId');
              request = index.getAll(IDBKeyRange.only(charId));
          } else {
              request = store.getAll();
          }
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  getGalleryImageById: async (id: string): Promise<GalleryImage | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GALLERY, 'readonly');
          const request = transaction.objectStore(STORE_GALLERY).get(id);
          request.onsuccess = () => resolve((request.result as GalleryImage | undefined) || null);
          request.onerror = () => reject(request.error);
      });
  },

  findGalleryImageBySourceMessageId: async (charId: string, messageId: number): Promise<GalleryImage | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GALLERY, 'readonly');
          const request = transaction.objectStore(STORE_GALLERY).index('charId').openCursor(IDBKeyRange.only(charId));
          request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                  resolve(null);
                  return;
              }
              const image = cursor.value as GalleryImage;
              if (image.sourceMessageId === messageId) {
                  resolve(image);
                  return;
              }
              cursor.continue();
          };
          request.onerror = () => reject(request.error);
      });
  },

  findGalleryImageByUrl: async (charId: string, url: string): Promise<GalleryImage | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GALLERY, 'readonly');
          const request = transaction.objectStore(STORE_GALLERY).index('charId').openCursor(IDBKeyRange.only(charId));
          request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                  resolve(null);
                  return;
              }
              const image = cursor.value as GalleryImage;
              if (image.url === url) {
                  resolve(image);
                  return;
              }
              cursor.continue();
          };
          request.onerror = () => reject(request.error);
      });
  },

  updateGalleryImageReview: async (id: string, review: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GALLERY, 'readwrite');
      const store = transaction.objectStore(STORE_GALLERY);
      return new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => {
              const data = req.result as GalleryImage;
              if (data) {
                  data.review = review;
                  data.reviewTimestamp = Date.now();
                  store.put(data);
                  resolve();
              } else reject(new Error('Image not found'));
          };
          req.onerror = () => reject(req.error);
      });
  },

  deleteGalleryImage: async (id: string): Promise<void> => {
      const { preserveContentFavoritesBeforeGalleryDeletion } = await import('./contentFavorites');
      await preserveContentFavoritesBeforeGalleryDeletion({ ids: [id] });
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GALLERY, 'readwrite');
          transaction.objectStore(STORE_GALLERY).delete(id);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('deleteGalleryImage aborted'));
      });
  },

  // --- XHS Stock Images ---
  getXhsStockImages: async (): Promise<XhsStockImage[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_XHS_STOCK, 'readonly');
          const request = transaction.objectStore(STORE_XHS_STOCK).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveXhsStockImage: async (img: XhsStockImage): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_STOCK, 'readwrite');
      transaction.objectStore(STORE_XHS_STOCK).put(img);
  },

  deleteXhsStockImage: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_STOCK, 'readwrite');
      transaction.objectStore(STORE_XHS_STOCK).delete(id);
  },

  updateXhsStockImageUsage: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_STOCK, 'readwrite');
      const store = transaction.objectStore(STORE_XHS_STOCK);
      return new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => {
              const data = req.result as XhsStockImage;
              if (data) {
                  data.usedCount = (data.usedCount || 0) + 1;
                  data.lastUsedAt = Date.now();
                  store.put(data);
                  resolve();
              } else reject(new Error('Stock image not found'));
          };
          req.onerror = () => reject(req.error);
      });
  },

  // --- XHS Activities (Free Roam) ---
  saveXhsActivity: async (activity: XhsActivityRecord): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readwrite');
      transaction.objectStore(STORE_XHS_ACTIVITIES).put(activity);
  },

  getXhsActivities: async (characterId: string, limit?: number): Promise<XhsActivityRecord[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readonly');
          const store = transaction.objectStore(STORE_XHS_ACTIVITIES);
          const index = store.index('characterId');
          const request = index.getAll(IDBKeyRange.only(characterId));
          request.onsuccess = () => {
              let results = (request.result || []) as XhsActivityRecord[];
              results.sort((a, b) => b.timestamp - a.timestamp);
              if (limit) results = results.slice(0, limit);
              resolve(results);
          };
          request.onerror = () => reject(request.error);
      });
  },

  getAllXhsActivities: async (): Promise<XhsActivityRecord[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readonly');
          const request = transaction.objectStore(STORE_XHS_ACTIVITIES).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  deleteXhsActivity: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readwrite');
      transaction.objectStore(STORE_XHS_ACTIVITIES).delete(id);
  },

  clearXhsActivities: async (characterId: string): Promise<void> => {
      const activities = await DB.getXhsActivities(characterId);
      const db = await openDB();
      const transaction = db.transaction(STORE_XHS_ACTIVITIES, 'readwrite');
      const store = transaction.objectStore(STORE_XHS_ACTIVITIES);
      for (const a of activities) {
          store.delete(a.id);
      }
  },

  // --- XHS Character Profiles (durable ownership, independent from activity history) ---
  saveXhsOwnedPost: async (post: XhsOwnedPost): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_XHS_OWNED_POSTS)) return;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_XHS_OWNED_POSTS, 'readwrite');
          tx.objectStore(STORE_XHS_OWNED_POSTS).put(post);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('保存角色小紅書帖子失敗'));
          tx.onabort = () => reject(tx.error || new Error('保存角色小紅書帖子被中止'));
      });
  },

  getXhsOwnedPosts: async (characterId: string): Promise<XhsOwnedPost[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_XHS_OWNED_POSTS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_XHS_OWNED_POSTS, 'readonly');
          const request = tx.objectStore(STORE_XHS_OWNED_POSTS).index('characterId').getAll(IDBKeyRange.only(characterId));
          request.onsuccess = () => {
              const posts = (request.result || []) as XhsOwnedPost[];
              posts.sort((a, b) => b.publishedAt - a.publishedAt);
              resolve(posts);
          };
          request.onerror = () => reject(request.error || tx.error);
      });
  },

  getAllXhsOwnedPosts: async (): Promise<XhsOwnedPost[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_XHS_OWNED_POSTS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_XHS_OWNED_POSTS, 'readonly');
          const request = tx.objectStore(STORE_XHS_OWNED_POSTS).getAll();
          request.onsuccess = () => resolve((request.result || []) as XhsOwnedPost[]);
          request.onerror = () => reject(request.error || tx.error);
      });
  },

  saveScheduledMessage: async (msg: ScheduledMessage): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SCHEDULED, 'readwrite');
          transaction.objectStore(STORE_SCHEDULED).put(msg);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error || new Error('定時消息未能保存'));
          transaction.onabort = () => reject(transaction.error || new Error('定時消息未能保存'));
      });
  },

  getDueScheduledMessages: async (charId: string): Promise<ScheduledMessage[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SCHEDULED, 'readonly');
          const store = transaction.objectStore(STORE_SCHEDULED);
          const index = store.index('charId');
          const request = index.getAll(IDBKeyRange.only(charId));
          request.onsuccess = () => {
              const all = request.result as ScheduledMessage[];
              const now = Date.now();
              const due = all.filter(m => m.dueAt <= now);
              resolve(due);
          };
          request.onerror = () => reject(request.error);
      });
  },

  deleteScheduledMessage: async (id: string): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SCHEDULED, 'readwrite');
          transaction.objectStore(STORE_SCHEDULED).delete(id);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error || new Error('定時消息未能刪除'));
          transaction.onabort = () => reject(transaction.error || new Error('定時消息未能刪除'));
      });
  },

  saveUserProfile: async (profile: UserProfile): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_USER, 'readwrite');
      transaction.objectStore(STORE_USER).put({ ...profile, id: 'me' });
  },

  getUserProfile: async (): Promise<UserProfile | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_USER, 'readonly');
          const store = transaction.objectStore(STORE_USER);
          const request = store.get('me');
          request.onsuccess = () => {
              if (request.result) {
                  const { id, ...profile } = request.result;
                  resolve(profile as UserProfile);
              } else {
                  resolve(null);
              }
          };
          request.onerror = () => reject(request.error);
      });
  },

  getDiariesByCharId: async (charId: string): Promise<DiaryEntry[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_DIARIES, 'readonly');
          const store = transaction.objectStore(STORE_DIARIES);
          const index = store.index('charId');
          const request = index.getAll(IDBKeyRange.only(charId));
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveDiary: async (diary: DiaryEntry): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_DIARIES, 'readwrite');
      transaction.objectStore(STORE_DIARIES).put(diary);
  },

  deleteDiary: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_DIARIES, 'readwrite');
      transaction.objectStore(STORE_DIARIES).delete(id);
  },

  getAllTasks: async (): Promise<Task[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_TASKS)) return [];
      
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_TASKS, 'readonly');
          const store = transaction.objectStore(STORE_TASKS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveTask: async (task: Task): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_TASKS, 'readwrite');
      transaction.objectStore(STORE_TASKS).put(task);
  },

  deleteTask: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_TASKS, 'readwrite');
      transaction.objectStore(STORE_TASKS).delete(id);
  },

  getAllAnniversaries: async (): Promise<Anniversary[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_ANNIVERSARIES)) return [];

      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_ANNIVERSARIES, 'readonly');
          const store = transaction.objectStore(STORE_ANNIVERSARIES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveAnniversary: async (anniversary: Anniversary): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ANNIVERSARIES, 'readwrite');
      transaction.objectStore(STORE_ANNIVERSARIES).put(anniversary);
  },

  deleteAnniversary: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ANNIVERSARIES, 'readwrite');
      transaction.objectStore(STORE_ANNIVERSARIES).delete(id);
  },

  getRoomTodo: async (charId: string, date: string): Promise<RoomTodo | null> => {
      const db = await openDB();
      const id = `${charId}_${date}`;
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_ROOM_TODOS)) { resolve(null); return; }
          const transaction = db.transaction(STORE_ROOM_TODOS, 'readonly');
          const store = transaction.objectStore(STORE_ROOM_TODOS);
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveRoomTodo: async (todo: RoomTodo): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ROOM_TODOS, 'readwrite');
      transaction.objectStore(STORE_ROOM_TODOS).put(todo);
  },

  getRoomNotes: async (charId: string): Promise<RoomNote[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_ROOM_NOTES)) { resolve([]); return; }
          const transaction = db.transaction(STORE_ROOM_NOTES, 'readonly');
          const store = transaction.objectStore(STORE_ROOM_NOTES);
          const index = store.index('charId');
          const request = index.getAll(IDBKeyRange.only(charId));
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveRoomNote: async (note: RoomNote): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ROOM_NOTES, 'readwrite');
      transaction.objectStore(STORE_ROOM_NOTES).put(note);
  },

  deleteRoomNote: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_ROOM_NOTES, 'readwrite');
      transaction.objectStore(STORE_ROOM_NOTES).delete(id);
  },

  // ─── Daily Schedule (角色日程表) ───
  getDailySchedule: async (charId: string, date: string): Promise<DailySchedule | null> => {
      const db = await openDB();
      const id = `${charId}_${date}`;
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_DAILY_SCHEDULE)) { resolve(null); return; }
          const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readonly');
          const store = transaction.objectStore(STORE_DAILY_SCHEDULE);
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveDailySchedule: async (schedule: DailySchedule): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readwrite');
      transaction.objectStore(STORE_DAILY_SCHEDULE).put(schedule);
  },

  deleteDailySchedule: async (charId: string, date: string): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_DAILY_SCHEDULE)) return;
      const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readwrite');
      transaction.objectStore(STORE_DAILY_SCHEDULE).delete(`${charId}_${date}`);
  },

  // ─── 熱點快照 (分時段，全角色共享) ───
  getHotNewsSnapshot: async (id: string): Promise<HotNewsSnapshot | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_HOTNEWS)) { resolve(null); return; }
          const transaction = db.transaction(STORE_HOTNEWS, 'readonly');
          const req = transaction.objectStore(STORE_HOTNEWS).get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveHotNewsSnapshot: async (snapshot: HotNewsSnapshot): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_HOTNEWS, 'readwrite');
      transaction.objectStore(STORE_HOTNEWS).put(snapshot);
  },

  // 拿最近一次快照（按 fetchedAt 倒序），失敗兜底與 App 展示用
  getLatestHotNewsSnapshot: async (): Promise<HotNewsSnapshot | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_HOTNEWS)) { resolve(null); return; }
          const transaction = db.transaction(STORE_HOTNEWS, 'readonly');
          const req = transaction.objectStore(STORE_HOTNEWS).getAll();
          req.onsuccess = () => {
              const all = (req.result || []) as HotNewsSnapshot[];
              if (all.length === 0) { resolve(null); return; }
              all.sort((a, b) => b.fetchedAt - a.fetchedAt);
              resolve(all[0]);
          };
          req.onerror = () => reject(req.error);
      });
  },

  // 清理過期快照（保留最近 N 條），避免無限堆積
  pruneHotNewsSnapshots: async (keep = 12): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve) => {
          if (!db.objectStoreNames.contains(STORE_HOTNEWS)) { resolve(); return; }
          const transaction = db.transaction(STORE_HOTNEWS, 'readwrite');
          const store = transaction.objectStore(STORE_HOTNEWS);
          const req = store.getAll();
          req.onsuccess = () => {
              const all = (req.result || []) as HotNewsSnapshot[];
              all.sort((a, b) => b.fetchedAt - a.fetchedAt);
              all.slice(keep).forEach(s => store.delete(s.id));
              resolve();
          };
          req.onerror = () => resolve();
      });
  },

  getScheduleCoverImage: async (charId: string): Promise<string | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_DAILY_SCHEDULE)) { resolve(null); return; }
          const transaction = db.transaction(STORE_DAILY_SCHEDULE, 'readonly');
          const store = transaction.objectStore(STORE_DAILY_SCHEDULE);
          const req = store.openCursor();
          req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                  const val = cursor.value as DailySchedule;
                  if (val.charId === charId && val.coverImage) {
                      resolve(val.coverImage);
                      return;
                  }
                  cursor.continue();
              } else {
                  resolve(null);
              }
          };
          req.onerror = () => reject(req.error);
      });
  },

  // ─── Handbook (手帳) ───
  getHandbook: async (date: string): Promise<HandbookEntry | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_HANDBOOK)) { resolve(null); return; }
          const transaction = db.transaction(STORE_HANDBOOK, 'readonly');
          const store = transaction.objectStore(STORE_HANDBOOK);
          const req = store.get(date);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  getAllHandbooks: async (): Promise<HandbookEntry[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_HANDBOOK)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_HANDBOOK, 'readonly');
          const store = transaction.objectStore(STORE_HANDBOOK);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  saveHandbook: async (entry: HandbookEntry): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_HANDBOOK, 'readwrite');
      transaction.objectStore(STORE_HANDBOOK).put(entry);
  },

  deleteHandbook: async (date: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_HANDBOOK, 'readwrite');
      transaction.objectStore(STORE_HANDBOOK).delete(date);
  },

  // ─── Trackers (手帳打卡引擎) ───
  getAllTrackers: async (): Promise<Tracker[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_TRACKERS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_TRACKERS, 'readonly');
          const req = tx.objectStore(STORE_TRACKERS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  saveTracker: async (tracker: Tracker): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_TRACKERS, 'readwrite');
      tx.objectStore(STORE_TRACKERS).put(tracker);
  },

  deleteTracker: async (id: string): Promise<void> => {
      const db = await openDB();
      // 同時刪掉該 tracker 的所有 entries
      const tx = db.transaction([STORE_TRACKERS, STORE_TRACKER_ENTRIES], 'readwrite');
      tx.objectStore(STORE_TRACKERS).delete(id);
      const teStore = tx.objectStore(STORE_TRACKER_ENTRIES);
      const idx = teStore.index('trackerId');
      const req = idx.openCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
      };
  },

  getTrackerEntriesByTracker: async (trackerId: string): Promise<TrackerEntry[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_TRACKER_ENTRIES)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_TRACKER_ENTRIES, 'readonly');
          const idx = tx.objectStore(STORE_TRACKER_ENTRIES).index('trackerId');
          const req = idx.getAll(IDBKeyRange.only(trackerId));
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  getTrackerEntry: async (trackerId: string, date: string): Promise<TrackerEntry | null> => {
      // 複合查詢:用 tracker 索引,客戶端再過濾 date(簡單且足夠快)
      const all = await DB.getTrackerEntriesByTracker(trackerId);
      return all.find(e => e.date === date) || null;
  },

  saveTrackerEntry: async (entry: TrackerEntry): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_TRACKER_ENTRIES, 'readwrite');
      tx.objectStore(STORE_TRACKER_ENTRIES).put(entry);
  },

  deleteTrackerEntry: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_TRACKER_ENTRIES, 'readwrite');
      tx.objectStore(STORE_TRACKER_ENTRIES).delete(id);
  },

  // ─── 生活記錄（檔案 App：生理期 / 藥盒 / 鍛鍊；記帳走 bank_transactions） ───
  getAllLifeRecords: async (): Promise<LifeRecord[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_RECORDS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_LIFE_RECORDS, 'readonly');
          const req = tx.objectStore(STORE_LIFE_RECORDS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  getLifeRecordById: async (id: string): Promise<LifeRecord | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_RECORDS)) return null;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_LIFE_RECORDS, 'readonly');
          const req = tx.objectStore(STORE_LIFE_RECORDS).get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveLifeRecord: async (record: LifeRecord): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_LIFE_RECORDS, 'readwrite');
      tx.objectStore(STORE_LIFE_RECORDS).put(record);
  },

  deleteLifeRecord: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_LIFE_RECORDS, 'readwrite');
      tx.objectStore(STORE_LIFE_RECORDS).delete(id);
  },

  getAllMedPlans: async (): Promise<MedPlan[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_MED_PLANS)) return [];
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_MED_PLANS, 'readonly');
          const req = tx.objectStore(STORE_MED_PLANS).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
      });
  },

  saveMedPlan: async (plan: MedPlan): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_MED_PLANS, 'readwrite');
      tx.objectStore(STORE_MED_PLANS).put(plan);
  },

  deleteMedPlan: async (id: string): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_MED_PLANS, 'readwrite');
      tx.objectStore(STORE_MED_PLANS).delete(id);
  },

  getLifeRecordSettings: async (): Promise<LifeRecordSettings | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_SETTINGS)) return null;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_LIFE_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_LIFE_SETTINGS).get('main');
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveLifeRecordSettings: async (settings: LifeRecordSettings): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_LIFE_SETTINGS, 'readwrite');
      tx.objectStore(STORE_LIFE_SETTINGS).put({ ...settings, id: 'main' });
  },

  getAllCourses: async (): Promise<StudyCourse[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_COURSES)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_COURSES, 'readonly');
          const store = transaction.objectStore(STORE_COURSES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveCourse: async (course: StudyCourse): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_COURSES, 'readwrite');
      transaction.objectStore(STORE_COURSES).put(course);
  },

  deleteCourse: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_COURSES, 'readwrite');
      transaction.objectStore(STORE_COURSES).delete(id);
  },

  // --- Quiz / Practice Book ---
  getAllQuizzes: async (): Promise<QuizSession[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_QUIZZES)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_QUIZZES, 'readonly');
          const store = transaction.objectStore(STORE_QUIZZES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveQuiz: async (quiz: QuizSession): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_QUIZZES, 'readwrite');
      transaction.objectStore(STORE_QUIZZES).put(quiz);
  },

  deleteQuiz: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_QUIZZES, 'readwrite');
      transaction.objectStore(STORE_QUIZZES).delete(id);
  },

  getAllGames: async (): Promise<GameSession[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_GAMES)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GAMES, 'readonly');
          const store = transaction.objectStore(STORE_GAMES);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveGame: async (game: GameSession): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GAMES, 'readwrite');
      transaction.objectStore(STORE_GAMES).put(game);
  },

  deleteGame: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GAMES, 'readwrite');
      transaction.objectStore(STORE_GAMES).delete(id);
  },

  getAllWorldbooks: async (): Promise<Worldbook[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLDBOOKS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_WORLDBOOKS, 'readonly');
          const store = transaction.objectStore(STORE_WORLDBOOKS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveWorldbook: async (book: Worldbook): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_WORLDBOOKS, 'readwrite');
      transaction.objectStore(STORE_WORLDBOOKS).put(book);
  },

  deleteWorldbook: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_WORLDBOOKS, 'readwrite');
      transaction.objectStore(STORE_WORLDBOOKS).delete(id);
  },

  // Read current records and update the library + mounted caches atomically.
  // Never loop updateWorldbook with a captured React character snapshot.
  mutateWorldbooks: async (ids: string[], updates: Partial<Worldbook> | null): Promise<{ books: Worldbook[]; characters: CharacterProfile[] }> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const tx = db.transaction([STORE_WORLDBOOKS, STORE_CHARACTERS], 'readwrite');
          const library = tx.objectStore(STORE_WORLDBOOKS);
          const charactersStore = tx.objectStore(STORE_CHARACTERS);
          const targets = new Set(ids);
          const books: Worldbook[] = [];
          const changedCharacters: CharacterProfile[] = [];
          const request = library.getAll();
          request.onsuccess = () => {
              for (const book of request.result as Worldbook[]) {
                  if (!targets.has(book.id)) continue;
                  if (updates === null) library.delete(book.id);
                  else {
                      const next = { ...book, ...updates, id: book.id, createdAt: book.createdAt, updatedAt: Date.now() };
                      books.push(next);
                      library.put(next);
                  }
              }
              const replacements = new Map(books.map(book => [book.id, toMountedWorldbook(book)]));
              const chars = charactersStore.getAll();
              chars.onsuccess = () => {
                  for (const char of chars.result as CharacterProfile[]) {
                      const mounted = char.mountedWorldbooks || [];
                      if (!mounted.some(book => updates === null ? targets.has(book.id) : replacements.has(book.id))) continue;
                      const next = { ...char, mountedWorldbooks: updates === null
                          ? mounted.filter(book => !targets.has(book.id))
                          : mounted.map(book => replacements.get(book.id) || book) };
                      changedCharacters.push(next);
                      charactersStore.put(next);
                  }
              };
          };
          tx.oncomplete = () => resolve({ books, characters: changedCharacters });
          tx.onerror = () => reject(tx.error || new Error('世界書保存失敗'));
          tx.onabort = () => reject(tx.error || new Error('世界書保存已撤銷'));
      });
  },

  // --- 見面 · 劇情劇場 ---
  getStoryTheaters: async (): Promise<StoryTheaterEntry[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_STORY_THEATERS)) return [];
      return new Promise((resolve, reject) => {
          const request = db.transaction(STORE_STORY_THEATERS, 'readonly').objectStore(STORE_STORY_THEATERS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: StoryTheaterEntry, b: StoryTheaterEntry) => b.updatedAt - a.updatedAt));
          request.onerror = () => reject(request.error);
      });
  },

  saveStoryTheater: async (entry: StoryTheaterEntry): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_STORY_THEATERS, 'readwrite');
      transaction.objectStore(STORE_STORY_THEATERS).put(entry);
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('saveStoryTheater aborted'));
      });
  },

  deleteStoryTheater: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_STORY_THEATERS, 'readwrite');
      transaction.objectStore(STORE_STORY_THEATERS).delete(id);
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('deleteStoryTheater aborted'));
      });
  },

  getStoryTheaterPresets: async (): Promise<StoryTheaterPreset[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_STORY_THEATER_PRESETS)) return [];
      return new Promise((resolve, reject) => {
          const request = db.transaction(STORE_STORY_THEATER_PRESETS, 'readonly').objectStore(STORE_STORY_THEATER_PRESETS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: StoryTheaterPreset, b: StoryTheaterPreset) => b.updatedAt - a.updatedAt));
          request.onerror = () => reject(request.error);
      });
  },

  saveStoryTheaterPreset: async (preset: StoryTheaterPreset): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_STORY_THEATER_PRESETS, 'readwrite');
      transaction.objectStore(STORE_STORY_THEATER_PRESETS).put(preset);
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('saveStoryTheaterPreset aborted'));
      });
  },

  deleteStoryTheaterPreset: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_STORY_THEATER_PRESETS, 'readwrite');
      transaction.objectStore(STORE_STORY_THEATER_PRESETS).delete(id);
  },

  getStoryTheaterMasks: async (): Promise<StoryTheaterMask[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_STORY_THEATER_MASKS)) return [];
      return new Promise((resolve, reject) => {
          const request = db.transaction(STORE_STORY_THEATER_MASKS, 'readonly').objectStore(STORE_STORY_THEATER_MASKS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: StoryTheaterMask, b: StoryTheaterMask) => b.updatedAt - a.updatedAt));
          request.onerror = () => reject(request.error);
      });
  },

  saveStoryTheaterMask: async (mask: StoryTheaterMask): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_STORY_THEATER_MASKS, 'readwrite');
      transaction.objectStore(STORE_STORY_THEATER_MASKS).put(mask);
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('saveStoryTheaterMask aborted'));
      });
  },

  deleteStoryTheaterMask: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_STORY_THEATER_MASKS, 'readwrite');
      transaction.objectStore(STORE_STORY_THEATER_MASKS).delete(id);
  },

  getAllNovels: async (): Promise<NovelBook[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_NOVELS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_NOVELS, 'readonly');
          const store = transaction.objectStore(STORE_NOVELS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveNovel: async (novel: NovelBook): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_NOVELS, 'readwrite');
      transaction.objectStore(STORE_NOVELS).put(novel);
  },

  deleteNovel: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_NOVELS, 'readwrite');
      transaction.objectStore(STORE_NOVELS).delete(id);
  },

  // --- VR World 「彼方」 全局小說庫 ---
  getVRLibraryCategories: async (): Promise<VRLibraryCategory[]> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const req = db.transaction(STORE_VR_SETTINGS, 'readonly').objectStore(STORE_VR_SETTINGS).get(VR_LIBRARY_RECORD);
          req.onsuccess = () => resolve(req.result?.categories || []);
          req.onerror = () => reject(req.error);
      });
  },

  editVRLibrary: async (edit: LibraryEdit): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const tx = db.transaction([STORE_VR_SETTINGS, STORE_VR_NOVELS], 'readwrite');
          const settings = tx.objectStore(STORE_VR_SETTINGS), books = tx.objectStore(STORE_VR_NOVELS);
          const categoryRequest = settings.get(VR_LIBRARY_RECORD), novelRequest = books.getAll();
          let ready = 0;
          let failure: unknown;
          const apply = () => {
              if (++ready !== 2) return;
              try {
                  const result = editLibrary(categoryRequest.result?.categories || [], novelRequest.result || [], edit);
                  settings.put({ id: VR_LIBRARY_RECORD, categories: result.categories });
                  for (const novel of result.changed) books.put(novel);
              } catch (error) { failure = error; tx.abort(); }
          };
          categoryRequest.onsuccess = apply;
          novelRequest.onsuccess = apply;
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('書庫分類保存失敗'));
      });
  },

  getVRNovels: async (): Promise<VRWorldNovel[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_NOVELS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_VR_NOVELS, 'readonly');
          const request = transaction.objectStore(STORE_VR_NOVELS).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveVRNovel: async (novel: VRWorldNovel): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_VR_NOVELS, 'readwrite');
          transaction.objectStore(STORE_VR_NOVELS).put(novel);
          transaction.oncomplete = () => resolve();
          transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('書籍保存失敗'));
      });
  },

  deleteVRNovel: async (id: string): Promise<void> => {
      const db = await openDB();
      // 刪書時連帶刪掉這本書的全部批註
      const annIds: string[] = await new Promise((resolve) => {
          if (!db.objectStoreNames.contains(STORE_VR_ANNOTATIONS)) return resolve([]);
          const tx = db.transaction(STORE_VR_ANNOTATIONS, 'readonly');
          const idx = tx.objectStore(STORE_VR_ANNOTATIONS).index('novelId');
          const req = idx.getAll(id);
          req.onsuccess = () => resolve((req.result || []).map((a: VRNovelAnnotation) => a.id));
          req.onerror = () => resolve([]);
      });
      const tx = db.transaction([STORE_VR_NOVELS, STORE_VR_ANNOTATIONS], 'readwrite');
      tx.objectStore(STORE_VR_NOVELS).delete(id);
      const annStore = tx.objectStore(STORE_VR_ANNOTATIONS);
      for (const aid of annIds) annStore.delete(aid);
  },

  // --- VR World 小說批註 ---
  getVRAnnotations: async (novelId?: string): Promise<VRNovelAnnotation[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_ANNOTATIONS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_VR_ANNOTATIONS, 'readonly');
          const store = transaction.objectStore(STORE_VR_ANNOTATIONS);
          const request = novelId ? store.index('novelId').getAll(novelId) : store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveVRAnnotation: async (annotation: VRNovelAnnotation): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_ANNOTATIONS, 'readwrite');
      transaction.objectStore(STORE_VR_ANNOTATIONS).put(annotation);
  },

  deleteVRAnnotation: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_ANNOTATIONS, 'readwrite');
      transaction.objectStore(STORE_VR_ANNOTATIONS).delete(id);
  },

  // --- 捏臉系統自定義部件 ---
  getCustomCreatorParts: async (): Promise<CustomCreatorPart[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_CC_PARTS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_CC_PARTS, 'readonly');
          const request = transaction.objectStore(STORE_CC_PARTS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: CustomCreatorPart, b: CustomCreatorPart) => a.createdAt - b.createdAt));
          request.onerror = () => reject(request.error);
      });
  },

  saveCustomCreatorPart: async (part: CustomCreatorPart): Promise<void> => {
      const db = await openDB();
      // 同 saveAsset：等事務落盤並把失敗拋出去，配額不足時不再靜默丟部件。
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_CC_PARTS, 'readwrite');
          transaction.objectStore(STORE_CC_PARTS).put(part);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('saveCustomCreatorPart transaction aborted'));
      });
  },

  deleteCustomCreatorPart: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_CC_PARTS, 'readwrite');
      transaction.objectStore(STORE_CC_PARTS).delete(id);
  },

  // --- 聽歌房共享狀態（單例 id='state'） ---
  getVRMusicRoom: async (): Promise<VRMusicRoomState | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_MUSIC)) return null;
      return new Promise((resolve) => {
          const transaction = db.transaction(STORE_VR_MUSIC, 'readonly');
          const request = transaction.objectStore(STORE_VR_MUSIC).get('state');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
      });
  },

  saveVRMusicRoom: async (state: VRMusicRoomState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_MUSIC, 'readwrite');
      transaction.objectStore(STORE_VR_MUSIC).put({ ...state, id: 'state' });
  },

  // --- 留言簿共享狀態（單例 id='board'） ---
  getVRGuestbook: async (): Promise<VRGuestbookState | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_GUESTBOOK)) return null;
      return new Promise((resolve) => {
          const transaction = db.transaction(STORE_VR_GUESTBOOK, 'readonly');
          const request = transaction.objectStore(STORE_VR_GUESTBOOK).get('board');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
      });
  },

  saveVRGuestbook: async (state: VRGuestbookState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_GUESTBOOK, 'readwrite');
      // 不限存儲條數：留言牆已支持每 50 條翻頁，舊留言全部保留可翻看
      const messages = state.messages || [];
      transaction.objectStore(STORE_VR_GUESTBOOK).put({ ...state, id: 'board', messages });
  },

  /** Atomic append: concurrent visitors and system announcements cannot replace each other. */
  appendVRGuestbookMessages: async (messages: VRGuestbookState['messages']): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VR_GUESTBOOK, 'readwrite');
      const store = tx.objectStore(STORE_VR_GUESTBOOK);
      const request = store.get('board');
      request.onsuccess = () => {
        const board: VRGuestbookState = request.result || { id: 'board', messages: [], updatedAt: 0 };
        const ids = new Set(board.messages.map(m => m.id));
        const fresh = messages.filter(m => { if (ids.has(m.id)) return false; ids.add(m.id); return true; });
        if (fresh.length) store.put({ ...board, messages: [...board.messages, ...fresh], updatedAt: Date.now() });
      };
      tx.oncomplete = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('vr-guestbook-updated')); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('留言未能保存'));
    });
  },

  clearVRGuestbook: async (): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_GUESTBOOK)) return;
      const transaction = db.transaction(STORE_VR_GUESTBOOK, 'readwrite');
      transaction.objectStore(STORE_VR_GUESTBOOK).put({ id: 'board', messages: [], updatedAt: Date.now() });
  },

  // --- 劇院·投稿劇本庫 ---
  getVRScripts: async (): Promise<VRScript[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_SCRIPTS)) return [];
      return new Promise((resolve) => {
          const request = db.transaction(STORE_VR_SCRIPTS, 'readonly').objectStore(STORE_VR_SCRIPTS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: VRScript, b: VRScript) => b.createdAt - a.createdAt));
          request.onerror = () => resolve([]);
      });
  },
  saveVRScript: async (script: VRScript): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_SCRIPTS, 'readwrite').objectStore(STORE_VR_SCRIPTS).put(script);
  },
  deleteVRScript: async (id: string): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_SCRIPTS, 'readwrite').objectStore(STORE_VR_SCRIPTS).delete(id);
  },

  // --- 劇院·歷史舞台劇 ---
  getVRStagedPlays: async (): Promise<VRStagedPlay[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_PLAYS)) return [];
      return new Promise((resolve) => {
          const request = db.transaction(STORE_VR_PLAYS, 'readonly').objectStore(STORE_VR_PLAYS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: VRStagedPlay, b: VRStagedPlay) => b.createdAt - a.createdAt));
          request.onerror = () => resolve([]);
      });
  },
  saveVRStagedPlay: async (play: VRStagedPlay): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PLAYS, 'readwrite').objectStore(STORE_VR_PLAYS).put(play);
  },
  deleteVRStagedPlay: async (id: string): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PLAYS, 'readwrite').objectStore(STORE_VR_PLAYS).delete(id);
  },

  // --- 劇院·用戶自定義寫作風格預設 ---
  getVRPresets: async (): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_PRESETS)) return [];
      return new Promise((resolve) => {
          const request = db.transaction(STORE_VR_PRESETS, 'readonly').objectStore(STORE_VR_PRESETS).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => resolve([]);
      });
  },
  saveVRPreset: async (preset: { key: string; name: string; prompt: string; blurb?: string }): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PRESETS, 'readwrite').objectStore(STORE_VR_PRESETS).put(preset);
  },
  deleteVRPreset: async (key: string): Promise<void> => {
      const db = await openDB();
      db.transaction(STORE_VR_PRESETS, 'readwrite').objectStore(STORE_VR_PRESETS).delete(key);
  },

  // --- 郵局信件 ---
  getVRLetters: async (): Promise<VRLetter[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_LETTERS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_VR_LETTERS, 'readonly');
          const request = transaction.objectStore(STORE_VR_LETTERS).getAll();
          request.onsuccess = () => resolve((request.result || []).sort((a: VRLetter, b: VRLetter) => b.createdAt - a.createdAt));
          request.onerror = () => reject(request.error);
      });
  },

  saveVRLetter: async (letter: VRLetter): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_LETTERS, 'readwrite');
      transaction.objectStore(STORE_VR_LETTERS).put(letter);
  },

  saveVRLetters: async (letters: VRLetter[]): Promise<void> => {
      if (letters.length === 0) return;
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_LETTERS, 'readwrite');
      const store = transaction.objectStore(STORE_VR_LETTERS);
      for (const l of letters) store.put(l);
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  deleteVRLetter: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_VR_LETTERS, 'readwrite');
      transaction.objectStore(STORE_VR_LETTERS).delete(id);
  },

  // --- 家園（世界定義 + 演繹歷史）---
  getWorlds: async (): Promise<WorldProfile[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLDS)) return [];
      return new Promise((resolve, reject) => {
          const request = db.transaction(STORE_WORLDS, 'readonly').objectStore(STORE_WORLDS).getAll();
          request.onsuccess = () => resolve((request.result || []).map(normalizeWorldRelationships).sort((a: WorldProfile, b: WorldProfile) => b.updatedAt - a.updatedAt));
          request.onerror = () => reject(request.error);
      });
  },

  getWorld: async (id: string): Promise<WorldProfile | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLDS)) return null;
      return new Promise((resolve, reject) => {
          const request = db.transaction(STORE_WORLDS, 'readonly').objectStore(STORE_WORLDS).get(id);
          request.onsuccess = () => resolve(request.result ? normalizeWorldRelationships(request.result) : null);
          request.onerror = () => reject(request.error);
      });
  },

  saveWorld: async (world: WorldProfile): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_WORLDS, 'readwrite');
      tx.objectStore(STORE_WORLDS).put(world);
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  /** Apply UI changes against the latest persisted world without rolling back engine progress. */
  updateWorld: async (id: string, patch: Partial<WorldProfile> | ((current: WorldProfile) => Partial<WorldProfile>)): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_WORLDS, 'readwrite');
          const store = tx.objectStore(STORE_WORLDS);
          const request = store.get(id);
          request.onsuccess = () => {
              if (!request.result) return;
              const current = request.result as WorldProfile;
              store.put({ ...current, ...(typeof patch === 'function' ? patch(current) : patch), id });
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
      });
  },

  deleteWorld: async (id: string): Promise<void> => {
      const db = await openDB();
      // 連帶刪掉該世界的全部演繹歷史
      const tx = db.transaction([STORE_WORLDS, STORE_WORLD_EPISODES], 'readwrite');
      tx.objectStore(STORE_WORLDS).delete(id);
      const epStore = tx.objectStore(STORE_WORLD_EPISODES);
      const cursorReq = epStore.index('worldId').openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
      };
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  getWorldEpisodes: async (worldId: string, limit: number = 30): Promise<WorldEpisode[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_WORLD_EPISODES)) return [];
      return new Promise((resolve, reject) => {
          const index = db.transaction(STORE_WORLD_EPISODES, 'readonly').objectStore(STORE_WORLD_EPISODES).index('worldId');
          const request = index.getAll(IDBKeyRange.only(worldId));
          request.onsuccess = () => {
              const all = orderWorldEpisodes(request.result || []);
              resolve(all.slice(0, limit));
          };
          request.onerror = () => reject(request.error);
      });
  },

  saveWorldEpisode: async (episode: WorldEpisode): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_WORLD_EPISODES, 'readwrite');
      const { observationNumber: _displayOnly, ...stored } = episode;
      tx.objectStore(STORE_WORLD_EPISODES).put(stored);
      return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  // --- 彼方獨立 API + 調用記錄（vr_settings 單例 store）---
  getVRApiConfig: async (): Promise<any | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_SETTINGS)) return null;
      return new Promise((resolve) => {
          const tx = db.transaction(STORE_VR_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_VR_SETTINGS).get('api');
          req.onsuccess = () => resolve(req.result?.config ?? null);
          req.onerror = () => resolve(null);
      });
  },

  saveVRApiConfig: async (config: any | null): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'api', config: config ?? null });
  },

  getVRApiLog: async (): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_VR_SETTINGS)) return [];
      return new Promise((resolve) => {
          const tx = db.transaction(STORE_VR_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_VR_SETTINGS).get('apilog');
          req.onsuccess = () => resolve(req.result?.entries ?? []);
          req.onerror = () => resolve([]);
      });
  },

  setVRApiLog: async (entries: any[]): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'apilog', entries: (entries || []).slice(0, 120) });
  },

  appendVRApiLog: async (entry: any): Promise<void> => {
      const db = await openDB();
      const read = (): Promise<any[]> => new Promise((resolve) => {
          const tx = db.transaction(STORE_VR_SETTINGS, 'readonly');
          const req = tx.objectStore(STORE_VR_SETTINGS).get('apilog');
          req.onsuccess = () => resolve(req.result?.entries ?? []);
          req.onerror = () => resolve([]);
      });
      const cur = await read();
      cur.unshift(entry);
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'apilog', entries: cur.slice(0, 120) });
  },

  clearVRApiLog: async (): Promise<void> => {
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put({ id: 'apilog', entries: [] });
  },

  // --- 全局 API 調用記錄（api_call_log 單例 store，id='log'）---
  // 只保留近 5 天的記錄，超期在寫入時丟棄。讀出時再過濾一次兜底。
  getApiCallLog: async (): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return [];
      return new Promise((resolve) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readonly');
          const req = tx.objectStore(STORE_API_CALL_LOG).get('log');
          req.onsuccess = () => {
              const entries: any[] = req.result?.entries ?? [];
              const cutoff = Date.now() - API_CALL_LOG_MAX_AGE_MS;
              resolve(entries.filter((e) => (e?.timestamp ?? 0) > cutoff));
          };
          req.onerror = () => resolve([]);
      });
  },

  appendApiCallLog: async (entry: any): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return;
      // 必須在同一個 readwrite 事務裡完成“讀 → 合併/去重 → 寫”。
      // 舊實現先 readonly、再另開 readwrite；兩條 API 同時返回時會讀到同一舊數組，
      // 後寫入者把前一條整筆覆蓋，表現為供應商有調用而本地日誌隨機缺行。
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readwrite');
          const store = tx.objectStore(STORE_API_CALL_LOG);
          const req = store.get('log');
          req.onsuccess = () => {
              const cur: any[] = req.result?.entries ?? [];
              const duplicateIndex = cur.findIndex((e) => e?.id && e.id === entry?.id);
              if (duplicateIndex >= 0) {
                  // 顯式 safeFetch 記錄和全局 clone 兜底可能先後抵達；合併非空字段，
                  // 既不重複計費，也能讓後到的 usage/backendModel 補齊早到的簡版記錄。
                  const existing = cur[duplicateIndex];
                  const defined = Object.fromEntries(
                      Object.entries(entry || {}).filter(([, value]) => value !== undefined),
                  );
                  cur[duplicateIndex] = { ...existing, ...defined, id: existing.id };
              } else {
                  cur.unshift(entry);
              }
              const cutoff = Date.now() - API_CALL_LOG_MAX_AGE_MS;
              const pruned = cur
                  .filter((e) => (e?.timestamp ?? 0) > cutoff)
                  .sort((a, b) => (b?.timestamp ?? 0) - (a?.timestamp ?? 0))
                  .slice(0, API_CALL_LOG_MAX_ENTRIES);
              store.put({ id: 'log', entries: pruned });
          };
          req.onerror = () => tx.abort();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('appendApiCallLog transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('appendApiCallLog transaction aborted'));
      });
  },

  clearApiCallLog: async (): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readwrite');
          tx.objectStore(STORE_API_CALL_LOG).put({ id: 'log', entries: [] });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('clearApiCallLog transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('clearApiCallLog transaction aborted'));
      });
  },

  // --- 下一次 LLM 請求完整抓包（同 store 獨立單例，永遠只保留一份）---
  getApiRequestCapture: async (): Promise<any | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return null;
      return new Promise((resolve) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readonly');
          const req = tx.objectStore(STORE_API_CALL_LOG).get('one-shot-capture');
          req.onsuccess = () => resolve(req.result?.capture ?? null);
          req.onerror = () => resolve(null);
      });
  },

  saveApiRequestCapture: async (capture: any): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readwrite');
          tx.objectStore(STORE_API_CALL_LOG).put({ id: 'one-shot-capture', capture });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('saveApiRequestCapture transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('saveApiRequestCapture transaction aborted'));
      });
  },

  patchApiRequestCapture: async (captureId: string, patch: Record<string, unknown>): Promise<boolean> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return false;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readwrite');
          const store = tx.objectStore(STORE_API_CALL_LOG);
          const req = store.get('one-shot-capture');
          let updated = false;
          req.onsuccess = () => {
              const current = req.result?.capture;
              if (!current || current.id !== captureId) return;
              store.put({ id: 'one-shot-capture', capture: { ...current, ...patch } });
              updated = true;
          };
          req.onerror = () => reject(req.error || new Error('patchApiRequestCapture read failed'));
          tx.oncomplete = () => resolve(updated);
          tx.onerror = () => reject(tx.error || new Error('patchApiRequestCapture transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('patchApiRequestCapture transaction aborted'));
      });
  },

  clearApiRequestCapture: async (): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_API_CALL_LOG)) return;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_API_CALL_LOG, 'readwrite');
          tx.objectStore(STORE_API_CALL_LOG).delete('one-shot-capture');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('clearApiRequestCapture transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('clearApiRequestCapture transaction aborted'));
      });
  },

  // 導入備份用：直接寫回一條 vr_settings 原始記錄（{id, ...}）。
  saveVRSettingRecord: async (record: any): Promise<void> => {
      if (!record || !record.id) return;
      const db = await openDB();
      const tx = db.transaction(STORE_VR_SETTINGS, 'readwrite');
      tx.objectStore(STORE_VR_SETTINGS).put(record);
  },

  // --- BANK / PET APP LOGIC ---
  getBankState: async (): Promise<BankFullState | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_BANK_DATA)) { resolve(null); return; }
          const transaction = db.transaction(STORE_BANK_DATA, 'readonly');
          const store = transaction.objectStore(STORE_BANK_DATA);
          const req = store.get('main_state');
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveBankState: async (state: BankFullState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_DATA, 'readwrite');
      // Strip dollhouse from the main state save (dollhouse is saved separately)
      const { dollhouse: _dh, ...shopWithoutDollhouse } = (state.shop || {}) as any;
      const cleanState = { ...state, shop: shopWithoutDollhouse };
      transaction.objectStore(STORE_BANK_DATA).put({ ...cleanState, id: 'main_state' });
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  // Dollhouse state saved separately (same pattern as RoomApp's per-character roomConfig)
  getBankDollhouse: async (): Promise<DollhouseState | null> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          if (!db.objectStoreNames.contains(STORE_BANK_DATA)) { resolve(null); return; }
          const transaction = db.transaction(STORE_BANK_DATA, 'readonly');
          const store = transaction.objectStore(STORE_BANK_DATA);
          const req = store.get('dollhouse_state');
          req.onsuccess = () => resolve(req.result?.data || null);
          req.onerror = () => reject(req.error);
      });
  },

  saveBankDollhouse: async (state: DollhouseState): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_DATA, 'readwrite');
      transaction.objectStore(STORE_BANK_DATA).put({ id: 'dollhouse_state', data: state });
      return new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  getAllTransactions: async (): Promise<BankTransaction[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_BANK_TX)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_BANK_TX, 'readonly');
          const store = transaction.objectStore(STORE_BANK_TX);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveTransaction: async (txData: BankTransaction): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_TX, 'readwrite');
      transaction.objectStore(STORE_BANK_TX).put(txData);
  },

  deleteTransaction: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_BANK_TX, 'readwrite');
      transaction.objectStore(STORE_BANK_TX).delete(id);
  },

  // --- Songs (Songwriting App) ---
  getAllSongs: async (): Promise<SongSheet[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_SONGS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SONGS, 'readonly');
          const store = transaction.objectStore(STORE_SONGS);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveSong: async (song: SongSheet): Promise<void> => {
      const db = await openDB();
      // 同 saveAsset：等事務落盤並把失敗拋出去，配額不足時不再靜默丟歌。
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_SONGS, 'readwrite');
          transaction.objectStore(STORE_SONGS).put(song);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('saveSong transaction aborted'));
      });
  },

  deleteSong: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_SONGS, 'readwrite');
      transaction.objectStore(STORE_SONGS).delete(id);
  },

  // --- Guidebook (攻略本) ---
  getAllGuidebookSessions: async (): Promise<GuidebookSession[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_GUIDEBOOK)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_GUIDEBOOK, 'readonly');
          const store = transaction.objectStore(STORE_GUIDEBOOK);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveGuidebookSession: async (session: GuidebookSession): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GUIDEBOOK, 'readwrite');
      transaction.objectStore(STORE_GUIDEBOOK).put(session);
  },

  deleteGuidebookSession: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_GUIDEBOOK, 'readwrite');
      transaction.objectStore(STORE_GUIDEBOOK).delete(id);
  },

  // --- 購物中心（商品/外賣目錄，用戶本地維護，不隨全局設置導入導出走）---
  getAllMallCategories: async (): Promise<MallCategory[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_MALL_CATEGORIES)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_MALL_CATEGORIES, 'readonly');
          const request = transaction.objectStore(STORE_MALL_CATEGORIES).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveMallCategory: async (category: MallCategory): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_MALL_CATEGORIES, 'readwrite');
      transaction.objectStore(STORE_MALL_CATEGORIES).put(category);
  },

  deleteMallCategory: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_MALL_CATEGORIES, 'readwrite');
      transaction.objectStore(STORE_MALL_CATEGORIES).delete(id);
  },

  getAllMallProducts: async (): Promise<MallProduct[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_MALL_PRODUCTS)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_MALL_PRODUCTS, 'readonly');
          const request = transaction.objectStore(STORE_MALL_PRODUCTS).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  saveMallProduct: async (product: MallProduct): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_MALL_PRODUCTS, 'readwrite');
      transaction.objectStore(STORE_MALL_PRODUCTS).put(product);
  },

  deleteMallProduct: async (id: string): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_MALL_PRODUCTS, 'readwrite');
      transaction.objectStore(STORE_MALL_PRODUCTS).delete(id);
  },

  // ── LifeSim (模擬人生) ────────────────────────────────────
  getLifeSimState: async (): Promise<LifeSimState | null> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_LIFE_SIM)) return null;
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_LIFE_SIM, 'readonly');
          const request = transaction.objectStore(STORE_LIFE_SIM).get('main');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
      });
  },

  saveLifeSimState: async (state: LifeSimState): Promise<void> => {
      const db = await openDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_LIFE_SIM, 'readwrite');
          transaction.objectStore(STORE_LIFE_SIM).put({ ...state, id: 'main' });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  },

  clearLifeSimState: async (): Promise<void> => {
      const db = await openDB();
      const transaction = db.transaction(STORE_LIFE_SIM, 'readwrite');
      transaction.objectStore(STORE_LIFE_SIM).clear();
  },

  getRawStoreData: async (storeName: string): Promise<any[]> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readonly');
          const store = transaction.objectStore(storeName);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
      });
  },

  /**
   * 在單個 readonly 事務裡用游標逐條同步消費整表。onItem 不能返回 Promise；每次 cursor
   * success 都只持有當前記錄，適合邊剝圖邊寫備份分片，同時保留 getAll 的單事務快照語義。
   */
  streamRawStoreData: async (
      storeName: string,
      onItem: (item: any) => void,
  ): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return;
      return new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).openCursor();
          let callbackError: unknown;

          req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor || callbackError) return;
              try {
                  onItem(cursor.value);
                  cursor.continue();
              } catch (error) {
                  callbackError = error;
                  try { tx.abort(); } catch { /* transaction may already be closing */ }
              }
          };
          req.onerror = () => reject(req.error || tx.error || new Error('streamRawStoreData cursor failed'));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(callbackError || tx.error || new Error('streamRawStoreData tx failed'));
          tx.onabort = () => reject(callbackError || tx.error || new Error('streamRawStoreData tx aborted'));
      });
  },

  /**
   * 游標分批讀整表：每攢夠 batchSize 條回調一次 onBatch(batch)，回調內消費完即釋放，
   * 絕不像 getRawStoreData 那樣把整表一次性 getAll 進內存。導出大 store 時用它，把讀取
   * 峰值從「整個 store」降到「一個 batch」。
   *
   * 實現要點——每批一個獨立 readonly 事務，按主鍵升序續讀（順序與 getAll 完全一致）：
   * IDB 事務在控制權回到事件循環、且沒有掛起請求時會自動提交關閉。onBatch 可能是 async
   * （要 await 寫分片 / 讓出主線程），await 必然跨過這個提交點把事務關掉，之後再 cursor
   * .continue() 就會拋 TransactionInactiveError。所以這裡先在一個事務內用游標攢滿一批、
   * 讓事務自然關閉，await onBatch 消費完，再用 lowerBound(lastKey, true) 開下一個事務從
   * 斷點續讀。這是 memoryPalace/db.ts 的 scanAndMigrateLegacy 同款分批事務做法。
   *
   * ⚠ 一致性語義（接進導出前必讀）：分批跨多個事務 ≠ getAll 的單事務快照。store 靜止時
   * 兩者結果一致；但若批次之間有併發寫入，key 大於斷點的新記錄會被帶進來、已掃過 key 上的
   * 增刪改會漏掉或讀到陳舊值——拼出來的可能是內部不一致的 store。getRawStoreData 的單次
   * getAll 至少是「每個 store 自帶一致快照」。所以把本函數接進備份導出時，必須先保證導出
   * 期間 store 靜止（暫停寫入 / 加導出鎖），否則要接受「活動中導出 = 盡力而為快照」並補一條
   * 批間改動的迴歸測試。當前備份導出仍走 getRawStoreData，未用本函數，此約束留給後續接入時兌現。
   */
  getStoreDataChunked: async (
      storeName: string,
      onBatch: (batch: any[]) => void | Promise<void>,
      batchSize = 200,
  ): Promise<void> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(storeName)) return;

      let lastKey: IDBValidKey | null = null;
      for (;;) {
          const { batch, newLastKey, done } = await new Promise<{
              batch: any[]; newLastKey: IDBValidKey | null; done: boolean;
          }>((resolve, reject) => {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const range = lastKey !== null ? IDBKeyRange.lowerBound(lastKey, true) : undefined;
              const req = store.openCursor(range);
              const collected: any[] = [];
              let bLast: IDBValidKey | null = lastKey;
              let bDone = false;
              req.onsuccess = () => {
                  const cursor = req.result;
                  if (!cursor) { bDone = true; return; } // 走到末尾
                  if (collected.length >= batchSize) return; // 攢夠這批，停 continue 等事務關閉
                  collected.push(cursor.value);
                  bLast = cursor.primaryKey;
                  cursor.continue();
              };
              req.onerror = () => reject(req.error);
              tx.oncomplete = () => resolve({ batch: collected, newLastKey: bLast, done: bDone });
              tx.onerror = () => reject(tx.error || new Error('getStoreDataChunked tx failed'));
              tx.onabort = () => reject(tx.error || new Error('getStoreDataChunked tx aborted'));
          });

          if (batch.length > 0) await onBatch(batch);
          lastKey = newLastKey;
          if (done) break;
      }
  },

  exportFullData: async (): Promise<Partial<FullBackupData>> => {
      const db = await openDB();
      
      const getAllFromStore = (storeName: string): Promise<any[]> => {
          if (!db.objectStoreNames.contains(storeName)) {
              return Promise.resolve([]);
          }
          return new Promise((resolve) => {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const req = store.getAll();
              req.onsuccess = () => resolve(req.result || []);
              req.onerror = () => resolve([]); 
          });
      };

      const [characters, characterGroups, npcs, messages, themes, emojis, emojiCategories, assets, galleryImages, userProfiles, diaries, tasks, anniversaries, roomTodos, roomNotes, groups, journalStickers, socialPosts, courses, games, worldbooks, storyTheaters, storyTheaterPresets, storyTheaterMasks, novels, bankTx, bankData, xhsActivities, xhsOwnedPosts, xhsStockImages, songs, quizzes, guidebookSessions, scheduledMessages, lifeSimStates, handbooks, trackers, trackerEntries, hotNewsSnapshots, vrNovels, vrAnnotations, customCreatorParts, vrMusic, vrGuestbook, vrScripts, vrStagedPlays, vrPresets, vrLetters, vrSettings, worlds, worldEpisodes, lifeRecords, medPlans, lifeRecordSettings] = await Promise.all([
          getAllFromStore(STORE_CHARACTERS),
          getAllFromStore(STORE_CHAR_GROUPS),
          getAllFromStore(STORE_NPCS),
          getAllFromStore(STORE_MESSAGES),
          getAllFromStore(STORE_THEMES),
          getAllFromStore(STORE_EMOJIS),
          getAllFromStore(STORE_EMOJI_CATEGORIES),
          getAllFromStore(STORE_ASSETS),
          getAllFromStore(STORE_GALLERY),
          getAllFromStore(STORE_USER),
          getAllFromStore(STORE_DIARIES),
          getAllFromStore(STORE_TASKS),
          getAllFromStore(STORE_ANNIVERSARIES),
          getAllFromStore(STORE_ROOM_TODOS),
          getAllFromStore(STORE_ROOM_NOTES),
          getAllFromStore(STORE_GROUPS),
          getAllFromStore(STORE_JOURNAL_STICKERS),
          getAllFromStore(STORE_SOCIAL_POSTS),
          getAllFromStore(STORE_COURSES),
          getAllFromStore(STORE_GAMES),
          getAllFromStore(STORE_WORLDBOOKS),
          getAllFromStore(STORE_STORY_THEATERS),
          getAllFromStore(STORE_STORY_THEATER_PRESETS),
          getAllFromStore(STORE_STORY_THEATER_MASKS),
          getAllFromStore(STORE_NOVELS),
          getAllFromStore(STORE_BANK_TX),
          getAllFromStore(STORE_BANK_DATA),
          getAllFromStore(STORE_XHS_ACTIVITIES),
          getAllFromStore(STORE_XHS_OWNED_POSTS),
          getAllFromStore(STORE_XHS_STOCK),
          getAllFromStore(STORE_SONGS),
          getAllFromStore(STORE_QUIZZES),
          getAllFromStore(STORE_GUIDEBOOK),
          getAllFromStore(STORE_SCHEDULED),
          getAllFromStore(STORE_LIFE_SIM),
          getAllFromStore(STORE_HANDBOOK),
          getAllFromStore(STORE_TRACKERS),
          getAllFromStore(STORE_TRACKER_ENTRIES),
          getAllFromStore(STORE_HOTNEWS),
          getAllFromStore(STORE_VR_NOVELS),
          getAllFromStore(STORE_VR_ANNOTATIONS),
          getAllFromStore(STORE_CC_PARTS),
          getAllFromStore(STORE_VR_MUSIC),
          getAllFromStore(STORE_VR_GUESTBOOK),
          getAllFromStore(STORE_VR_SCRIPTS),
          getAllFromStore(STORE_VR_PLAYS),
          getAllFromStore(STORE_VR_PRESETS),
          getAllFromStore(STORE_VR_LETTERS),
          getAllFromStore(STORE_VR_SETTINGS),
          getAllFromStore(STORE_WORLDS),
          getAllFromStore(STORE_WORLD_EPISODES),
          getAllFromStore(STORE_LIFE_RECORDS),
          getAllFromStore(STORE_MED_PLANS),
          getAllFromStore(STORE_LIFE_SETTINGS),
      ]);

      const userProfile = userProfiles.length > 0 ? {
          name: userProfiles[0].name,
          avatar: userProfiles[0].avatar,
          bio: userProfiles[0].bio
      } : undefined;

      const mainState = bankData.find((d: any) => d.id === 'main_state');
      const dollhouseRecord = bankData.find((d: any) => d.id === 'dollhouse_state');

      return {
          characters, characterGroups, npcs, messages, customThemes: themes, savedEmojis: emojis, emojiCategories, assets, galleryImages, userProfile, diaries, tasks, anniversaries, roomTodos, roomNotes, groups, savedJournalStickers: journalStickers, socialPosts, courses, games, worldbooks, storyTheaters, storyTheaterPresets, storyTheaterMasks, novels,
          bankState: mainState ? { ...mainState, id: undefined } : undefined,
          bankDollhouse: dollhouseRecord?.data || undefined,
          bankTransactions: bankTx,
          xhsActivities,
          xhsOwnedPosts,
          xhsStockImages,
          songs,
          quizSessions: quizzes,
          guidebookSessions,
          scheduledMessages,
          lifeSimState: lifeSimStates[0] || null,
          handbooks,
          trackers,
          trackerEntries,
          lifeRecords,
          medPlans,
          lifeRecordSettings,
          hotNewsSnapshots,
          vrNovels,
          vrAnnotations,
          customCreatorParts,
          vrMusicRoom: vrMusic && vrMusic.length ? vrMusic[0] : undefined,
          vrGuestbook: vrGuestbook && vrGuestbook.length ? vrGuestbook[0] : undefined,
          vrScripts,
          vrStagedPlays,
          vrPresets,
          vrLetters,
          vrSettings,
          vrPostOffice: exportPostOfficeLocal(), // 郵局本機配置（身份/後端地址，存 localStorage）
          vrSignal: exportSignalLocal(),         // 信號墜落處本機記錄（句子歸屬「你·角色」+ 反覆用清單，存 localStorage）
          worlds,
          worldEpisodes,
          worldHomeLocal: exportWorldHomeLocal(), // 家園本機配置：全局 API + 文風收藏（存 localStorage）
          luckinLocal: exportLuckinLocal(),       // 瑞幸 token + 啟用狀態（存 localStorage）
          mcdLocal: exportMcdLocal(),             // 麥當勞 token + 啟用狀態（存 localStorage）
          mcpLocal: exportMcpLocal(),             // 通用 MCP 服務器配置（存 localStorage）
          amsg2GlobalConfig: await exportAmsg2GlobalConfig(), // 主動消息 2.0 全局配置（存獨立的 ActiveMsg 庫）
          desktopSkinLocal: await exportDesktopSkinLocal(), // 桌面皮膚：界面配色 + 看板 banner（看板圖令牌解析為 data URL）
      };
  },

  importFullData: async (
      data: FullBackupData,
      options: {
          beforeWrite?: (root: any, label: string) => Promise<void>;
          onProgress?: (progress: {
              label: string;
              stage: 'start' | 'items' | 'done';
              sectionDone: number;
              sectionTotal: number;
              itemDone?: number;
              itemTotal?: number;
          }) => void;
      } = {}
  ): Promise<void> => {
      const db = await openDB();
      
      const availableStores = [
          STORE_CHARACTERS, STORE_CHAR_GROUPS, STORE_NPCS, STORE_MESSAGES, STORE_THEMES, STORE_EMOJIS, STORE_EMOJI_CATEGORIES,
          STORE_ASSETS, STORE_GALLERY, STORE_USER, STORE_DIARIES,
          STORE_TASKS, STORE_ANNIVERSARIES, STORE_ROOM_TODOS, STORE_ROOM_NOTES,
          STORE_GROUPS, STORE_JOURNAL_STICKERS, STORE_SOCIAL_POSTS, STORE_COURSES, STORE_GAMES, STORE_WORLDBOOKS, STORE_STORY_THEATERS, STORE_STORY_THEATER_PRESETS, STORE_STORY_THEATER_MASKS, STORE_NOVELS, STORE_SONGS,
          STORE_BANK_TX, STORE_BANK_DATA,
          STORE_XHS_ACTIVITIES, STORE_XHS_OWNED_POSTS, STORE_XHS_STOCK,
          STORE_QUIZZES,
          STORE_GUIDEBOOK,
          STORE_SCHEDULED,
          STORE_LIFE_SIM,
          STORE_DAILY_SCHEDULE,
          STORE_HANDBOOK,
          STORE_TRACKERS,
          STORE_TRACKER_ENTRIES,
          STORE_LIFE_RECORDS,
          STORE_MED_PLANS,
          STORE_LIFE_SETTINGS,
          STORE_HOTNEWS,
          STORE_VR_NOVELS, STORE_VR_ANNOTATIONS, STORE_CC_PARTS, STORE_VR_MUSIC, STORE_VR_GUESTBOOK, STORE_VR_SCRIPTS, STORE_VR_PLAYS, STORE_VR_PRESETS, STORE_VR_LETTERS, STORE_VR_SETTINGS,
          STORE_WORLDS, STORE_WORLD_EPISODES,
          'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
          'room_plates', 'digest_reports',
          'memory_batches', 'pixel_home_assets', 'pixel_home_layouts'
      ].filter(name => db.objectStoreNames.contains(name));

      const hasStore = (storeName: string) => availableStores.includes(storeName);

      const waitForTransaction = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });

      const withStore = async (storeName: string, writer: (store: IDBObjectStore) => void): Promise<void> => {
          if (!hasStore(storeName)) return;
          const tx = db.transaction(storeName, 'readwrite');
          try {
              writer(tx.objectStore(storeName));
          } catch (err) {
              try { tx.abort(); } catch { /* ignore */ }
              throw err;
          }
          await waitForTransaction(tx);
      };

      const getAllFromStore = async <T,>(storeName: string): Promise<T[]> => {
          if (!hasStore(storeName)) return [];
          return new Promise((resolve, reject) => {
              const tx = db.transaction(storeName, 'readonly');
              const request = tx.objectStore(storeName).getAll();
              request.onsuccess = () => resolve(request.result as T[]);
              request.onerror = () => reject(request.error || tx.error);
              tx.onerror = () => reject(tx.error || new Error('IndexedDB read failed'));
              tx.onabort = () => reject(tx.error || new Error('IndexedDB read aborted'));
          });
      };

      const plannedSections = [
          data.characters !== undefined || data.mediaAssets !== undefined,
          data.characterGroups !== undefined,
          data.npcs !== undefined,
          data.messages !== undefined,
          data.customThemes !== undefined,
          data.savedEmojis !== undefined,
          data.emojiCategories !== undefined,
          data.assets !== undefined,
          data.savedJournalStickers !== undefined,
          data.galleryImages !== undefined,
          data.diaries !== undefined,
          data.tasks !== undefined,
          data.anniversaries !== undefined,
          data.roomTodos !== undefined,
          data.roomNotes !== undefined,
          data.groups !== undefined,
          data.socialPosts !== undefined,
          data.courses !== undefined,
          data.games !== undefined,
          data.worldbooks !== undefined,
          data.storyTheaters !== undefined,
          data.storyTheaterPresets !== undefined,
          data.storyTheaterMasks !== undefined,
          data.novels !== undefined,
          data.songs !== undefined,
          data.quizSessions !== undefined,
          data.guidebookSessions !== undefined,
          data.scheduledMessages !== undefined,
          data.lifeSimState !== undefined,
          data.bankTransactions !== undefined,
          data.xhsActivities !== undefined,
          data.xhsStockImages !== undefined,
          data.memoryNodes !== undefined,
          data.memoryVectors !== undefined,
          data.memoryLinks !== undefined,
          data.topicBoxes !== undefined,
          data.anticipations !== undefined,
          data.eventBoxes !== undefined,
          data.roomPlates !== undefined,
          data.digestReports !== undefined,
          data.memoryBatches !== undefined,
          data.dailySchedules !== undefined,
          data.handbooks !== undefined,
          data.trackers !== undefined,
          data.trackerEntries !== undefined,
          data.lifeRecords !== undefined,
          data.medPlans !== undefined,
          data.lifeRecordSettings !== undefined,
          data.hotNewsSnapshots !== undefined,
          data.vrNovels !== undefined,
          data.vrAnnotations !== undefined,
          data.customCreatorParts !== undefined,
          data.vrMusicRoom !== undefined,
          data.vrGuestbook !== undefined,
          data.vrScripts !== undefined,
          data.vrStagedPlays !== undefined,
          data.vrPresets !== undefined,
          data.vrLetters !== undefined,
          (data as any).vrPostOffice !== undefined,
          data.worlds !== undefined,
          data.worldEpisodes !== undefined,
          (data as any).worldHomeLocal !== undefined,
          (data as any).luckinLocal !== undefined,
          (data as any).mcdLocal !== undefined,
          data.pixelHomeAssets !== undefined,
          data.pixelHomeLayouts !== undefined,
          data.userProfile !== undefined,
          data.bankState !== undefined || data.bankDollhouse !== undefined,
      ];
      const sectionTotal = Math.max(1, plannedSections.filter(Boolean).length);
      let sectionDone = 0;

      const report = (
          label: string,
          stage: 'start' | 'items' | 'done',
          itemDone?: number,
          itemTotal?: number
      ) => {
          options.onProgress?.({
              label,
              stage,
              sectionDone,
              sectionTotal,
              itemDone,
              itemTotal,
          });
      };

      const runSection = async (
          label: string,
          present: boolean,
          work: () => Promise<void>,
          itemTotal?: number
      ) => {
          if (!present) return;
          report(label, 'start', 0, itemTotal);
          await work();
          sectionDone += 1;
          report(label, 'done', itemTotal, itemTotal);
      };

      const beforeWrite = async (root: any, label: string, restoreAssets: boolean) => {
          if (!restoreAssets || root === undefined || root === null) return;
          if (!options.beforeWrite) return;
          await options.beforeWrite(root, label);
      };

      const clearStore = async (storeName: string) => {
          await withStore(storeName, store => {
              store.clear();
          });
      };

      const putItems = async (
          storeName: string,
          items: any[] | undefined | null,
          label: string,
          restoreAssets = true
      ) => {
          if (!hasStore(storeName) || !items || items.length === 0) return;

          const CHUNK_SIZE = 50;
          const total = items.length;
          for (let i = 0; i < total; i += CHUNK_SIZE) {
              const end = Math.min(i + CHUNK_SIZE, total);
              const chunk = items.slice(i, end).filter(Boolean);
              if (chunk.length === 0) {
                  report(label, 'items', end, total);
                  continue;
              }
              await beforeWrite(chunk, label, restoreAssets);
              await withStore(storeName, store => {
                  chunk.forEach(item => store.put(item));
              });
              for (let j = i; j < end; j++) {
                  (items as any[])[j] = undefined;
              }
              report(label, 'items', end, total);
          }
      };

      const clearAndAdd = async (
          storeName: string,
          items: any[] | undefined | null,
          label: string,
          restoreAssets = true
      ) => {
          if (!hasStore(storeName) || items === undefined || items === null) return;
          await clearStore(storeName);
          await putItems(storeName, items, label, restoreAssets);
      };

      const mergeStore = async (
          storeName: string,
          items: any[] | undefined | null,
          label: string,
          restoreAssets = true
      ) => {
          if (!hasStore(storeName) || !items || items.length === 0) return;
          await putItems(storeName, items, label, restoreAssets);
      };

      const applyMediaToChar = (c: CharacterProfile, media: NonNullable<FullBackupData['mediaAssets']>[number]): CharacterProfile => {
          return {
              ...c,
              avatar: media.avatar || c.avatar,
              companionAvatar: media.companionAvatar || c.companionAvatar,
              companionTouchSettings: media.companionTouchSettings || c.companionTouchSettings,
              sprites: media.sprites || c.sprites,
              dateSkinSets: media.dateSkinSets || c.dateSkinSets,
              activeSkinSetId: media.activeSkinSetId || c.activeSkinSetId,
              customDateSprites: media.customDateSprites || c.customDateSprites,
              spriteConfig: media.spriteConfig || c.spriteConfig,
              chatBackground: media.backgrounds?.chat || c.chatBackground,
              dateBackground: media.backgrounds?.date || c.dateBackground,
              roomConfig: c.roomConfig ? {
                  ...c.roomConfig,
                  wallImage: media.backgrounds?.roomWall || c.roomConfig.wallImage,
                  floorImage: media.backgrounds?.roomFloor || c.roomConfig.floorImage,
                  items: c.roomConfig.items.map(item => {
                      const img = media.roomItems?.[item.id];
                      return img ? { ...item, image: img } : item;
                  })
              } : c.roomConfig
          } as CharacterProfile;
      };

      const hasCharacterBackup = Array.isArray(data.characters);

      await runSection('角色資料', data.characters !== undefined || data.mediaAssets !== undefined, async () => {
          if (data.characters) {
              if (data.mediaAssets) {
                  await beforeWrite(data.mediaAssets, '角色媒體', true);
                  const mediaAssets = data.mediaAssets;
                  data.characters = data.characters.map(c => {
                      const media = mediaAssets.find(m => m.charId === c.id);
                      return media ? applyMediaToChar(c, media) : c;
                  });
              }
              await clearAndAdd(STORE_CHARACTERS, data.characters, '角色資料', true);
          } else if (data.mediaAssets && hasStore(STORE_CHARACTERS)) {
              await beforeWrite(data.mediaAssets, '角色媒體', true);
              const mediaAssets = data.mediaAssets;
              const existingChars = await getAllFromStore<CharacterProfile>(STORE_CHARACTERS);
              if (existingChars.length > 0) {
                  const updatedChars = existingChars.map(c => {
                      const media = mediaAssets.find(m => m.charId === c.id);
                      return media ? applyMediaToChar(c, media) : c;
                  });
                  await putItems(STORE_CHARACTERS, updatedChars, '角色資料', false);
              }
          }
          data.characters = undefined as any;
          data.mediaAssets = undefined as any;
      }, data.characters?.length || data.mediaAssets?.length || 0);

      await runSection('角色分組', data.characterGroups !== undefined, async () => {
          await mergeStore(STORE_CHAR_GROUPS, data.characterGroups, '角色分組', false);
          data.characterGroups = undefined as any;
      }, data.characterGroups?.length || 0);

      await runSection('NPC 檔案', data.npcs !== undefined, async () => {
          await mergeStore(STORE_NPCS, data.npcs, 'NPC 檔案', false);
          data.npcs = undefined as any;
      }, data.npcs?.length || 0);

      await runSection('聊天記錄', data.messages !== undefined, async () => {
          if (!hasStore(STORE_MESSAGES)) return;
          const isPatchMode = !hasCharacterBackup;
          if (!isPatchMode) {
              await clearStore(STORE_MESSAGES);
          }
          await putItems(STORE_MESSAGES, data.messages || [], '聊天記錄', true);
          data.messages = undefined as any;
      }, data.messages?.length || 0);

      await runSection('聊天主題', data.customThemes !== undefined, async () => {
          await mergeStore(STORE_THEMES, data.customThemes, '聊天主題', true);
          data.customThemes = undefined as any;
      }, data.customThemes?.length || 0);
      await runSection('表情包', data.savedEmojis !== undefined, async () => {
          await mergeStore(STORE_EMOJIS, data.savedEmojis, '表情包', true);
          data.savedEmojis = undefined as any;
      }, data.savedEmojis?.length || 0);
      await runSection('表情分類', data.emojiCategories !== undefined, async () => {
          await mergeStore(STORE_EMOJI_CATEGORIES, data.emojiCategories, '表情分類', false);
          data.emojiCategories = undefined as any;
      }, data.emojiCategories?.length || 0);
      await runSection('系統資源', data.assets !== undefined, async () => {
          await clearAndAdd(STORE_ASSETS, data.assets || [], '系統資源', true);
          data.assets = undefined as any;
      }, data.assets?.length || 0);
      await runSection('日記貼紙', data.savedJournalStickers !== undefined, async () => {
          await mergeStore(STORE_JOURNAL_STICKERS, data.savedJournalStickers, '日記貼紙', true);
          data.savedJournalStickers = undefined as any;
      }, data.savedJournalStickers?.length || 0);

      await runSection('相冊圖片', data.galleryImages !== undefined, async () => {
          await clearAndAdd(STORE_GALLERY, data.galleryImages, '相冊圖片', true);
          data.galleryImages = undefined as any;
      }, data.galleryImages?.length || 0);
      await runSection('日記', data.diaries !== undefined, async () => {
          await clearAndAdd(STORE_DIARIES, data.diaries, '日記', true);
          data.diaries = undefined as any;
      }, data.diaries?.length || 0);
      await runSection('任務', data.tasks !== undefined, async () => {
          await clearAndAdd(STORE_TASKS, data.tasks, '任務', false);
          data.tasks = undefined as any;
      }, data.tasks?.length || 0);
      await runSection('紀念日', data.anniversaries !== undefined, async () => {
          await clearAndAdd(STORE_ANNIVERSARIES, data.anniversaries, '紀念日', false);
          data.anniversaries = undefined as any;
      }, data.anniversaries?.length || 0);
      await runSection('房間待辦', data.roomTodos !== undefined, async () => {
          await clearAndAdd(STORE_ROOM_TODOS, data.roomTodos, '房間待辦', false);
          data.roomTodos = undefined as any;
      }, data.roomTodos?.length || 0);
      await runSection('房間便籤', data.roomNotes !== undefined, async () => {
          await clearAndAdd(STORE_ROOM_NOTES, data.roomNotes, '房間便籤', false);
          data.roomNotes = undefined as any;
      }, data.roomNotes?.length || 0);
      await runSection('群聊資料', data.groups !== undefined, async () => {
          await clearAndAdd(STORE_GROUPS, data.groups, '群聊資料', true);
          data.groups = undefined as any;
      }, data.groups?.length || 0);
      await runSection('動態帖子', data.socialPosts !== undefined, async () => {
          await clearAndAdd(STORE_SOCIAL_POSTS, data.socialPosts, '動態帖子', true);
          data.socialPosts = undefined as any;
      }, data.socialPosts?.length || 0);
      await runSection('學習課程', data.courses !== undefined, async () => {
          await clearAndAdd(STORE_COURSES, data.courses, '學習課程', false);
          data.courses = undefined as any;
      }, data.courses?.length || 0);
      await runSection('遊戲記錄', data.games !== undefined, async () => {
          await clearAndAdd(STORE_GAMES, data.games, '遊戲記錄', false);
          data.games = undefined as any;
      }, data.games?.length || 0);
      await runSection('世界書', data.worldbooks !== undefined, async () => {
          await clearAndAdd(STORE_WORLDBOOKS, data.worldbooks, '世界書', false);
          data.worldbooks = undefined as any;
      }, data.worldbooks?.length || 0);
      await runSection('劇情劇場', data.storyTheaters !== undefined, async () => {
          await clearAndAdd(STORE_STORY_THEATERS, data.storyTheaters, '劇情劇場', false);
          data.storyTheaters = undefined as any;
      }, data.storyTheaters?.length || 0);
      await runSection('劇情預設', data.storyTheaterPresets !== undefined, async () => {
          await clearAndAdd(STORE_STORY_THEATER_PRESETS, data.storyTheaterPresets, '劇情預設', false);
          data.storyTheaterPresets = undefined as any;
      }, data.storyTheaterPresets?.length || 0);
      await runSection('劇場面具箱', data.storyTheaterMasks !== undefined, async () => {
          await clearAndAdd(STORE_STORY_THEATER_MASKS, data.storyTheaterMasks, '劇場面具箱', true);
          data.storyTheaterMasks = undefined as any;
      }, data.storyTheaterMasks?.length || 0);
      await runSection('小說', data.novels !== undefined, async () => {
          await clearAndAdd(STORE_NOVELS, data.novels, '小說', false);
          data.novels = undefined as any;
      }, data.novels?.length || 0);
      await runSection('彼方小說庫', data.vrNovels !== undefined, async () => {
          await clearAndAdd(STORE_VR_NOVELS, data.vrNovels, '彼方小說庫', false);
          data.vrNovels = undefined as any;
      }, data.vrNovels?.length || 0);
      await runSection('彼方批註', data.vrAnnotations !== undefined, async () => {
          await clearAndAdd(STORE_VR_ANNOTATIONS, data.vrAnnotations, '彼方批註', false);
          data.vrAnnotations = undefined as any;
      }, data.vrAnnotations?.length || 0);
      await runSection('捏臉自定義部件', data.customCreatorParts !== undefined, async () => {
          // restoreAssets=true：部件 src/shadowSrc 是 data:image，media/full 導出時被抽進 zip，
          // 導入必須經 beforeWrite 把 assets/*.png 路徑還原回 base64，否則部件圖裂成死鏈。
          await clearAndAdd(STORE_CC_PARTS, data.customCreatorParts, '捏臉自定義部件', true);
          data.customCreatorParts = undefined as any;
      }, data.customCreatorParts?.length || 0);
      await runSection('聽歌房', data.vrMusicRoom !== undefined, async () => {
          if (hasStore(STORE_VR_MUSIC) && data.vrMusicRoom) await DB.saveVRMusicRoom(data.vrMusicRoom);
          data.vrMusicRoom = undefined as any;
      }, 1);
      await runSection('留言簿', data.vrGuestbook !== undefined, async () => {
          if (hasStore(STORE_VR_GUESTBOOK) && data.vrGuestbook) await DB.saveVRGuestbook(data.vrGuestbook);
          data.vrGuestbook = undefined as any;
      }, 1);
      await runSection('劇院劇本', data.vrScripts !== undefined, async () => {
          if (hasStore(STORE_VR_SCRIPTS) && Array.isArray(data.vrScripts)) for (const s of data.vrScripts) await DB.saveVRScript(s);
          data.vrScripts = undefined as any;
      }, data.vrScripts?.length || 0);
      await runSection('歷史舞台劇', data.vrStagedPlays !== undefined, async () => {
          if (hasStore(STORE_VR_PLAYS) && Array.isArray(data.vrStagedPlays)) for (const p of data.vrStagedPlays) await DB.saveVRStagedPlay(p);
          data.vrStagedPlays = undefined as any;
      }, data.vrStagedPlays?.length || 0);
      await runSection('劇院預設', (data as any).vrPresets !== undefined, async () => {
          if (hasStore(STORE_VR_PRESETS) && Array.isArray((data as any).vrPresets)) for (const p of (data as any).vrPresets) await DB.saveVRPreset(p);
          (data as any).vrPresets = undefined as any;
      }, (data as any).vrPresets?.length || 0);
      await runSection('郵局信件', data.vrLetters !== undefined, async () => {
          await clearAndAdd(STORE_VR_LETTERS, data.vrLetters, '郵局信件', false);
          data.vrLetters = undefined as any;
      }, data.vrLetters?.length || 0);
      await runSection('彼方設置', data.vrSettings !== undefined, async () => {
          if (hasStore(STORE_VR_SETTINGS) && Array.isArray(data.vrSettings)) {
              for (const rec of data.vrSettings) await DB.saveVRSettingRecord(rec);
          }
          data.vrSettings = undefined as any;
      }, data.vrSettings?.length || 0);
      await runSection('郵局身份', (data as any).vrPostOffice !== undefined, async () => {
          importPostOfficeLocal((data as any).vrPostOffice);
          (data as any).vrPostOffice = undefined;
      }, 1);
      await runSection('信號墜落處', (data as any).vrSignal !== undefined, async () => {
          importSignalLocal((data as any).vrSignal);
          (data as any).vrSignal = undefined;
      }, 1);
      await runSection('家園世界', data.worlds !== undefined, async () => {
          await clearAndAdd(STORE_WORLDS, data.worlds, '家園世界', false);
          data.worlds = undefined as any;
      }, data.worlds?.length || 0);
      await runSection('家園演繹歷史', data.worldEpisodes !== undefined, async () => {
          await clearAndAdd(STORE_WORLD_EPISODES, data.worldEpisodes, '家園演繹歷史', false);
          data.worldEpisodes = undefined as any;
      }, data.worldEpisodes?.length || 0);
      await runSection('家園本機配置', (data as any).worldHomeLocal !== undefined, async () => {
          importWorldHomeLocal((data as any).worldHomeLocal); // 全局 API + 文風收藏
          (data as any).worldHomeLocal = undefined;
      }, 1);
      await runSection('瑞幸配置', (data as any).luckinLocal !== undefined, async () => {
          importLuckinLocal((data as any).luckinLocal); // token + 啟用狀態
          (data as any).luckinLocal = undefined;
      }, 1);
      await runSection('麥當勞配置', (data as any).mcdLocal !== undefined, async () => {
          importMcdLocal((data as any).mcdLocal); // token + 啟用狀態
          (data as any).mcdLocal = undefined;
      }, 1);
      await runSection('MCP 服務器配置', (data as any).mcpLocal !== undefined, async () => {
          importMcpLocal((data as any).mcpLocal); // 用戶自配的 MCP 服務器列表
          (data as any).mcpLocal = undefined;
      }, 1);
      await runSection('主動消息配置', (data as any).amsg2GlobalConfig !== undefined, async () => {
          // 必須在 OSContext 那段「導入後跟雲端對一次帳」之前落地：那段的第一道門是
          // 「本機有沒有 Worker 地址」，地址還沒寫回去的話它會整段跳過，舊檔角色留在
          // 雲端的無主任務就沒人取消，等用戶手填回地址時照樣到點推送。
          await importAmsg2GlobalConfig((data as any).amsg2GlobalConfig);
          (data as any).amsg2GlobalConfig = undefined;
      }, 1);
      await runSection('桌面皮膚偏好', (data as any).desktopSkinLocal !== undefined, async () => {
          await importDesktopSkinLocal((data as any).desktopSkinLocal); // 界面配色 + 看板 banner（data URL→本機 blob）
          (data as any).desktopSkinLocal = undefined;
      }, 1);
      await runSection('歌曲', data.songs !== undefined, async () => {
          await clearAndAdd(STORE_SONGS, data.songs, '歌曲', false);
          data.songs = undefined as any;
      }, data.songs?.length || 0);
      await runSection('練習本', data.quizSessions !== undefined, async () => {
          await clearAndAdd(STORE_QUIZZES, data.quizSessions, '練習本', false);
          data.quizSessions = undefined as any;
      }, data.quizSessions?.length || 0);
      await runSection('攻略本', data.guidebookSessions !== undefined, async () => {
          await clearAndAdd(STORE_GUIDEBOOK, data.guidebookSessions, '攻略本', false);
          data.guidebookSessions = undefined as any;
      }, data.guidebookSessions?.length || 0);
      await runSection('定時消息', data.scheduledMessages !== undefined, async () => {
          await clearAndAdd(STORE_SCHEDULED, data.scheduledMessages || [], '定時消息', false);
          data.scheduledMessages = undefined as any;
      }, data.scheduledMessages?.length || 0);
      await runSection('人生模擬', data.lifeSimState !== undefined, async () => {
          if (!hasStore(STORE_LIFE_SIM)) return;
          await beforeWrite(data.lifeSimState, '人生模擬', true);
          await withStore(STORE_LIFE_SIM, store => {
              store.clear();
              if (data.lifeSimState) {
                  store.put({ ...data.lifeSimState, id: 'main' });
              }
          });
          data.lifeSimState = undefined as any;
      }, data.lifeSimState ? 1 : 0);
      await runSection('銀行流水', data.bankTransactions !== undefined, async () => {
          await clearAndAdd(STORE_BANK_TX, data.bankTransactions, '銀行流水', false);
          data.bankTransactions = undefined as any;
      }, data.bankTransactions?.length || 0);
      await runSection('小紅書活動', data.xhsActivities !== undefined, async () => {
          await clearAndAdd(STORE_XHS_ACTIVITIES, data.xhsActivities, '小紅書活動', false);
          data.xhsActivities = undefined as any;
      }, data.xhsActivities?.length || 0);
      await runSection('角色小紅書主頁', data.xhsOwnedPosts !== undefined, async () => {
          await clearAndAdd(STORE_XHS_OWNED_POSTS, data.xhsOwnedPosts, '角色小紅書主頁', false);
          data.xhsOwnedPosts = undefined as any;
      }, data.xhsOwnedPosts?.length || 0);
      await runSection('小紅書圖庫', data.xhsStockImages !== undefined, async () => {
          await clearAndAdd(STORE_XHS_STOCK, data.xhsStockImages, '小紅書圖庫', true);
          data.xhsStockImages = undefined as any;
      }, data.xhsStockImages?.length || 0);

      // Memory Palace (記憶宮殿)
      await runSection('記憶節點', data.memoryNodes !== undefined, async () => {
          await clearAndAdd('memory_nodes', data.memoryNodes, '記憶節點', false);
          data.memoryNodes = undefined as any;
      }, data.memoryNodes?.length || 0);
      await runSection('記憶向量', data.memoryVectors !== undefined, async () => {
          if (!data.memoryVectors || !hasStore('memory_vectors')) {
              data.memoryVectors = undefined as any;
              return;
          }
          await clearStore('memory_vectors');
          const CHUNK_SIZE = 50;
          const total = data.memoryVectors.length;
          for (let i = 0; i < total; i += CHUNK_SIZE) {
              const end = Math.min(i + CHUNK_SIZE, total);
              const chunk = data.memoryVectors.slice(i, end).filter(Boolean).map((v: any) => {
                  if (!v || !v.vector || !Array.isArray(v.vector)) return v;
                  const f32 = new Float32Array(v.vector);
                  return { ...v, vector: new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength) };
              });
              await withStore('memory_vectors', store => {
                  chunk.forEach((item: any) => store.put(item));
              });
              for (let j = i; j < end; j++) {
                  (data.memoryVectors as any[])[j] = undefined;
              }
              report('記憶向量', 'items', end, total);
          }
          data.memoryVectors = undefined as any;
      }, data.memoryVectors?.length || 0);
      await runSection('記憶關係', data.memoryLinks !== undefined, async () => {
          await clearAndAdd('memory_links', data.memoryLinks, '記憶關係', false);
          data.memoryLinks = undefined as any;
      }, data.memoryLinks?.length || 0);
      await runSection('話題盒', data.topicBoxes !== undefined, async () => {
          await clearAndAdd('topic_boxes', data.topicBoxes, '話題盒', false);
          data.topicBoxes = undefined as any;
      }, data.topicBoxes?.length || 0);
      await runSection('期待事項', data.anticipations !== undefined, async () => {
          await clearAndAdd('anticipations', data.anticipations, '期待事項', false);
          data.anticipations = undefined as any;
      }, data.anticipations?.length || 0);
      await runSection('事件盒', data.eventBoxes !== undefined, async () => {
          await clearAndAdd('event_boxes', data.eventBoxes, '事件盒', false);
          data.eventBoxes = undefined as any;
      }, data.eventBoxes?.length || 0);
      await runSection('房間門牌', data.roomPlates !== undefined, async () => {
          await clearAndAdd('room_plates', data.roomPlates, '房間門牌', false);
          data.roomPlates = undefined as any;
      }, data.roomPlates?.length || 0);
      await runSection('消化日誌', data.digestReports !== undefined, async () => {
          await clearAndAdd('digest_reports', data.digestReports, '消化日誌', false);
          data.digestReports = undefined as any;
      }, data.digestReports?.length || 0);
      await runSection('記憶批次', data.memoryBatches !== undefined, async () => {
          await clearAndAdd('memory_batches', data.memoryBatches, '記憶批次', false);
          data.memoryBatches = undefined as any;
      }, data.memoryBatches?.length || 0);

      // 角色日程表（每日日程 + 意識流）
      await runSection('每日程', data.dailySchedules !== undefined, async () => {
          await clearAndAdd(STORE_DAILY_SCHEDULE, data.dailySchedules, '每日程', false);
          data.dailySchedules = undefined as any;
      }, data.dailySchedules?.length || 0);

      // 手帳（跨角色聚合留痕本）
      await runSection('手帳', data.handbooks !== undefined, async () => {
          await clearAndAdd(STORE_HANDBOOK, data.handbooks, '手帳', false);
          data.handbooks = undefined as any;
      }, data.handbooks?.length || 0);

      // 手帳 Tracker（健康/生活打卡引擎）
      await runSection('打卡項目', data.trackers !== undefined, async () => {
          await clearAndAdd(STORE_TRACKERS, data.trackers, '打卡項目', false);
          data.trackers = undefined as any;
      }, data.trackers?.length || 0);
      await runSection('打卡記錄', data.trackerEntries !== undefined, async () => {
          await clearAndAdd(STORE_TRACKER_ENTRIES, data.trackerEntries, '打卡記錄', false);
          data.trackerEntries = undefined as any;
      }, data.trackerEntries?.length || 0);

      // 生活記錄（檔案 App：生理期/藥盒/鍛鍊 + 藥盒計劃 + 設置）
      await runSection('生活記錄', data.lifeRecords !== undefined, async () => {
          await clearAndAdd(STORE_LIFE_RECORDS, data.lifeRecords, '生活記錄', false);
          data.lifeRecords = undefined as any;
      }, data.lifeRecords?.length || 0);
      await runSection('藥盒計劃', data.medPlans !== undefined, async () => {
          await clearAndAdd(STORE_MED_PLANS, data.medPlans, '藥盒計劃', false);
          data.medPlans = undefined as any;
      }, data.medPlans?.length || 0);
      await runSection('生活記錄設置', data.lifeRecordSettings !== undefined, async () => {
          await clearAndAdd(STORE_LIFE_SETTINGS, data.lifeRecordSettings, '生活記錄設置', false);
          data.lifeRecordSettings = undefined as any;
      }, data.lifeRecordSettings?.length || 0);

      // 熱點快照（全角色共享緩存）
      await runSection('熱點快照', data.hotNewsSnapshots !== undefined, async () => {
          await clearAndAdd(STORE_HOTNEWS, data.hotNewsSnapshots, '熱點快照', false);
          data.hotNewsSnapshots = undefined as any;
      }, data.hotNewsSnapshots?.length || 0);

      // Pixel Home（小屋像素界面）
      await runSection('像素小屋素材', data.pixelHomeAssets !== undefined, async () => {
          await clearAndAdd('pixel_home_assets', data.pixelHomeAssets, '像素小屋素材', true);
          data.pixelHomeAssets = undefined as any;
      }, data.pixelHomeAssets?.length || 0);
      await runSection('像素小屋佈局', data.pixelHomeLayouts !== undefined, async () => {
          await clearAndAdd('pixel_home_layouts', data.pixelHomeLayouts, '像素小屋佈局', false);
          data.pixelHomeLayouts = undefined as any;
      }, data.pixelHomeLayouts?.length || 0);

      await runSection('用戶資料', data.userProfile !== undefined, async () => {
          if (!hasStore(STORE_USER)) return;
          await beforeWrite(data.userProfile, '用戶資料', true);
          await withStore(STORE_USER, store => {
              store.clear();
              if (data.userProfile) {
                  store.put({ ...data.userProfile, id: 'me' });
              }
          });
          data.userProfile = undefined as any;
      }, data.userProfile ? 1 : 0);

      await runSection('銀行狀態', data.bankState !== undefined || data.bankDollhouse !== undefined, async () => {
          if (!hasStore(STORE_BANK_DATA)) return;
          await beforeWrite([data.bankState, data.bankDollhouse], '銀行狀態', true);
          await withStore(STORE_BANK_DATA, store => {
              store.clear();
              if (data.bankState) {
                  store.put({ ...data.bankState, id: 'main_state' });
              }
              if (data.bankDollhouse) {
                  store.put({ id: 'dollhouse_state', data: data.bankDollhouse });
              }
          });
          data.bankState = undefined as any;
          data.bankDollhouse = undefined as any;
      }, (data.bankState ? 1 : 0) + (data.bankDollhouse ? 1 : 0));
  }
};
