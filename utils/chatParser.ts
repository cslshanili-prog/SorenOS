
import { DB } from './db';
import { LocalNotifications } from '@capacitor/local-notifications';
import { CharacterProfile, CharPlaylistSong, ImageGenApiConfig } from '../types';
import { sanitizeForBubble } from './sanitize';
import { extractTransferCommands } from './transferFormat';
import { extractMallOrderCommands } from './mallOrderFormat';
import { executeLifeDirectives } from './lifeRecords';
import { wallClockToTimestamp } from './timezone';
import { createPendingPhoto, fulfillPendingPhoto } from './pendingPhoto';
import { CollaborationStore } from '../features/collaboration/store';
import {
    collaborationFileMessageMetadata,
    extractCollaborationFileDirectives,
    resolveCollaborationFileByTitle,
} from '../features/collaboration/chatLibrary';

export interface MusicActionSnapshot {
    songId: number;
    name: string;
    artists: string;
    album: string;
    albumPic: string;
    duration: number;
    fee: number;
}

/**
 * 把 user 的歌加到 char 的歌單時，char 可以指定目標：
 * - 不傳 target → 默認放進第一個歌單（兼容老 [[MUSIC_ACTION:add]]）
 * - target.kind === 'existing' → 按標題模糊匹配現有歌單；匹配不到回落到第一個
 * - target.kind === 'new' → 現場新建一個歌單，把這首作為第一首
 *
 * 不論哪種，存入 char 歌單時都會打上 source: 'user' 標籤，讓 char 之後"聽"
 * 這首歌時知道是從 user 那裡收來的（prompt 注入會用到）。
 */
export type AddSongTarget =
    | { kind: 'existing'; title: string }
    | { kind: 'new'; title: string; description?: string };

export interface MusicActionHooks {
    /** 返回 user 此刻正在聽的歌快照（chatParser 自己不去碰 MusicContext） */
    getListeningSnapshot: () => MusicActionSnapshot | null;
    /** 將 charId 加入"一起聽"名單（chatParser 不維護狀態，只通知） */
    joinListeningTogether: (charId: string) => void;
    /**
     * 把 song 加到 char 的歌單。
     * 返回 { playlistTitle, created } —— created=true 表示這次是新建了歌單。
     */
    addSongToCharPlaylist: (
        charId: string,
        song: CharPlaylistSong,
        target?: AddSongTarget,
    ) => Promise<{ playlistTitle: string; created: boolean } | null>;
}

/**
 * 主動消息 2.0 凍在 music_action directive 裡的那首歌（見 worker/amsg 的 attachSceneSong）。
 *
 * 為什麼要有這一層：定時消息的正文是角色幾小時前對著**它自己那時在聽的那首**寫的，
 * 而 `[[MUSIC_ACTION:add|歌單標題]]` 標籤裡只有歌單名、沒有歌名。重放時若只能取
 * 「用戶此刻在聽的那首」，用戶多半早就沒在放歌了 —— 正文聊著這首歌，卡片和加歌單
 * 卻整個沒發生。worker 到點把那首歌凍進 directive，調用方（applyAssistantPostProcessing）
 * 再顯式傳進來。本地聊天路徑不傳，走實時快照。
 */
export interface FrozenMusicSong {
    id?: number;
    name: string;
    artists: string;
}

/** 凍結的那首歌來自推送 metadata，字段形狀不保證；歌名都沒有就當沒傳。 */
const normalizeFrozenSong = (song?: FrozenMusicSong | null): FrozenMusicSong | null => {
    if (!song || typeof song.name !== 'string' || !song.name.trim()) return null;
    return {
        id: typeof song.id === 'number' ? song.id : undefined,
        name: song.name,
        artists: typeof song.artists === 'string' ? song.artists : '',
    };
};

/**
 * 把凍結的那首歌還原成一張完整快照 —— 卡片要封面、加歌單要時長/收費這些字段，
 * 而 directive 裡只帶得動 id / 歌名 / 歌手（推送 payload 就那麼點額度）。
 *
 * 那首歌是從角色自己的歌單抽樣池裡挑的，所以回角色歌單按 id 找基本必中；id 對不上
 * （歌單被改過）再按歌名 + 歌手兜一次。都找不到就只用手上這三個字段，封面空著 ——
 * 也比把用戶此刻在聽的另一首當成它強。
 */
const resolveFrozenSongSnapshot = async (
    charId: string,
    frozen: FrozenMusicSong,
): Promise<MusicActionSnapshot> => {
    try {
        const chars = await DB.getAllCharacters();
        const songs = (chars.find(c => c.id === charId)?.musicProfile?.playlists || [])
            .flatMap(pl => pl.songs || []);
        const norm = (s: string) => (s || '').trim().toLowerCase();
        const hit = (frozen.id != null ? songs.find(s => s.id === frozen.id) : undefined)
            || songs.find(s => norm(s.name) === norm(frozen.name) && norm(s.artists) === norm(frozen.artists))
            || songs.find(s => norm(s.name) === norm(frozen.name));
        if (hit) {
            return {
                songId: hit.id,
                name: hit.name,
                artists: hit.artists,
                album: hit.album,
                albumPic: hit.albumPic,
                duration: hit.duration,
                fee: hit.fee,
            };
        }
    } catch (e) {
        console.warn('[MusicAction] 回角色歌單補歌曲信息失敗，只用推送裡帶的那幾個字段:', e);
    }
    return {
        songId: frozen.id ?? 0,
        name: frozen.name,
        artists: frozen.artists,
        album: '',
        albumPic: '',
        duration: 0,
        fee: 0,
    };
};

// 轉帳的提取（規範標籤 + 模型掉格式的系統日誌形態）統一在 utils/transferFormat.ts:
// extractTransferCommands —— 與 worker classifier 共用一份源碼。master 上曾有一版
// 獨立實現 extractAssistantTransfers, 合併時其能力（全角括號【】/ 主語「我」/ credits
// 後綴）已併入 transferFormat, 測試見 utils/chatParser.transfer.test.ts。

export const ChatParser = {
    // Return cleaned content and perform side effects
    parseAndExecuteActions: async (
        aiContent: string,
        charId: string,
        charName: string,
        addToast: (msg: string, type: 'info'|'success'|'error') => void,
        musicHooks?: MusicActionHooks,
        /** 角色自定義時區；定時消息裡的時間是角色照著自己的鐘寫的，要按這個還原成真實時刻。 */
        charTz?: string,
        /**
         * 這一輪消息該落的時間戳（離線補收時是原始發送時刻）。不傳則各條按寫庫當刻。
         *
         * 必須跟 applyAssistantPostProcessing 的 persistMessage 用同一個值：不然離線補收時
         * 正文氣泡顯示凌晨三點、同一條消息拆出來的戳一戳/轉帳/日程系統提示顯示「用戶打開
         * App 那一刻」，一條消息被劈成兩個時間。
         */
        messageTimestamp?: number,
        /**
         * 這一輪消息統一繼承的 metadata（主動消息 2.0 的 `source` / `activeMsg2.messageId` 等，
         * 見 applyAssistantPostProcessing 的 mcdInheritMeta）。
         *
         * 副作用產物（戳一戳 / 轉帳卡 / 收款回執 / 音樂卡 / 新聞卡 / 日程系統提示 / 生活記錄卡）
         * 要跟正文氣泡帶同一個標記：主動消息處理失敗後會整條重來，重來前靠
         * metadata.activeMsg2.messageId 認領「這條推送上一趟已經寫下的東西」。副作用跑在正文
         * 之前，一條都認不出來就會被當成「上次什麼都沒做」，整套副作用再跑一遍——同一筆轉帳
         * 落兩張卡、日記寫兩遍。
         */
        inheritMeta?: Record<string, any>,
        /**
         * 這一輪 `[[MUSIC_ACTION:…]]` 說的是哪首歌（見 FrozenMusicSong）。
         * 只有主動消息 2.0 的定時路徑傳，其餘路徑不傳 = 取用戶此刻在聽的那首。
         */
        frozenMusicSong?: FrozenMusicSong,
        /**
         * 「系統設置 → 生圖API」配置。傳了且角色發圖開關都開著，才會真的執行
         * `[[ACTION:SEND_PHOTO|畫面描述]]`；不傳（或配置不全）時靜默剝掉標籤、不生成——
         * 教沒教角色這個動作是 chatPrompts.ts 的事，這裡只負責「教了就要能兌現」。
         */
        imageGenConfig?: ImageGenApiConfig,
        /**
         * 角色退回用戶發起的轉帳（`[[ACTION:TRANSFER_RETURN]]`，resolveUserTransfer 的
         * 'returned' 分支）時調用，退款回 Real Balance——錢在用戶發送那一刻就已經從
         * Real Balance 扣走了（apps/Chat.tsx 的 onTransfer），退回等於這筆錢沒花出去，
         * 得還回去。'accepted' 分支不用回調：錢已經在發送時結清，收下不再改動餘額。
         * 不傳就靜默不退款（舊調用方 / 用不到 Real Balance 的場景）。
         *
         * 只在前台實時聊天路徑傳（useChatAI.ts）：TRANSFER_ACCEPT/TRANSFER_RETURN 這兩個
         * 標籤沒被 worker 的 SIDE_EFFECT_TAGS 收錄，主動消息 2.0 的 push 路徑上會被當成
         * 普通文本剝掉，根本傳不到這裡、這個回調在那條路徑上永遠不會被調用（worker 側的
         * 已知缺口，見 worker/instant-push/src/classifier.ts 的 transfer_accept/return 註釋）。
         */
        onUserTransferReturned?: (amount: number) => Promise<void> | void,
        /**
         * 角色收下用戶發起的轉帳（resolveUserTransfer 的 'accepted' 分支）時調用，
         * 把這筆錢記入角色自己的 Real Balance（跟 onUserTransferReturned 是同一枚硬幣的
         * 兩面：退回款回用戶，收下入帳角色）。不傳就靜默不入帳。同樣只在前台路徑有意義，
         * 原因見 onUserTransferReturned 的註釋。
         */
        onUserTransferAccepted?: (amount: number) => Promise<void> | void,
        /**
         * 角色主動發起轉帳（`[[ACTION:TRANSFER|...]]`，即 transferEvents 裡 kind === 'send'）
         * 落卡之前調用，從角色自己的 Real Balance 扣款——跟用戶發起轉帳時"發送即結清"
         * （apps/Chat.tsx 的 onTransfer）對稱：錢在角色說出口那一刻就已經離開角色帳戶，
         * 而不是等用戶"收下"才發現角色餘額不夠。返回 false 時餘額不夠，跳過這筆轉帳
         * （不落待處理轉帳卡，等於角色這句"轉給你"沒真的發生）。不傳則不做餘額檢查，
         * 按老行為直接落卡（舊調用方 / 用不到 Real Balance 的場景）。
         */
        onCharTransferSend?: (amount: number) => Promise<boolean>,
        /**
         * 角色收到「外賣代付請求」（購物中心 mini-app 發起，見 utils/mallOrderFormat.ts）後
         * 選擇支付（`[[ACTION:DAIFU_ACCEPT]]`）時調用，從角色自己的 Real Balance 扣這筆錢——
         * 這是消費性的單向支出（角色替用戶付了這頓飯），不是轉帳，用戶這邊不會有對應入帳。
         * 返回 false 表示餘額不夠，這種情況會把這張卡自動改判成"已拒絕"（附系統生成的原因），
         * 不會讓卡片卡死在"待處理"。不傳就靜默不結算（舊調用方 / 用不到 Real Balance 的場景）。
         */
        onCharDaifuAccept?: (amount: number) => Promise<boolean>,
        /**
         * 角色主動送用戶一份禮物/外賣（`[[ACTION:GIFT|item=|price=|note=]]`）落卡之前調用，
         * 從角色自己的 Real Balance 扣款——跟 onCharTransferSend 對稱的"發送即結清"：錢在
         * 角色說出口那一刻就已經離開角色帳戶。返回 false 時餘額不夠，跳過這份禮物（不落卡，
         * 等於角色這句"給你帶了個禮物"沒真的發生）。不傳則不做餘額檢查，直接落卡。
         */
        onCharGiftSend?: (amount: number) => Promise<boolean>,
    ) => {
        let content = aiContent;
        /** 落庫統一走這裡，別直接調 DB.saveMessage —— 漏一處就是一條消息兩個時間、重試時還認不出來。 */
        const persist = (msg: Parameters<typeof DB.saveMessage>[0]) => DB.saveMessage({
            ...msg,
            ...(messageTimestamp != null ? { timestamp: messageTimestamp } : {}),
            // 卡片自己的字段優先，inheritMeta 只補它沒有的鍵（兩邊鍵名本來就不重疊，這裡是防禦）
            ...(inheritMeta ? { metadata: { ...inheritMeta, ...(msg.metadata || {}) } } : {}),
        });

        // COLLAB_FILE — current-chat collaboration mode can hand the user an
        // existing file from the sidecar cabinet. The chat message stores only
        // metadata + assetId; the canonical Blob remains in CollaborationStore.
        const fileDirectives = extractCollaborationFileDirectives(content);
        if (fileDirectives.requestedTitles.length > 0) {
            content = fileDirectives.visibleText;
            try {
                const chars = await DB.getAllCharacters();
                const collaborationEnabled = !!chars.find(char => char.id === charId)?.chatCollaborationEnabled;
                if (!collaborationEnabled) {
                    console.warn('[CollaborationFileCabinet] 忽略未開啟協同能力時的文件標記:', { charId });
                } else {
                    const files = await CollaborationStore.listLibraryFiles(charId);
                    for (const requestedTitle of fileDirectives.requestedTitles) {
                        const file = resolveCollaborationFileByTitle(files, requestedTitle);
                        if (!file) {
                            addToast(`文件櫃裡找不到《${requestedTitle}》，已跳過發送`, 'error');
                            continue;
                        }
                        await persist({
                            charId,
                            role: 'assistant',
                            type: 'collaboration_file',
                            content: `[協同文件：${file.name}]`,
                            metadata: collaborationFileMessageMetadata(file),
                        });
                    }
                }
            } catch (error) {
                console.warn('[CollaborationFileCabinet] 發送文件失敗:', error);
                addToast('協同文件櫃暫時讀取失敗', 'error');
            }
        }

        // POKE
        if (content.includes('[[ACTION:POKE]]')) {
            await persist({ charId, role: 'assistant', type: 'interaction', content: '[戳一戳]' });
            content = content.replace('[[ACTION:POKE]]', '').trim();
        }

        // SEND_PHOTO — 角色自主發圖。教沒教這個動作在 chatPrompts.ts（取決於生圖開關+配置是否
        // 齊全）；這裡只要看到標籤就按 imageGenConfig 有沒有傳、配得全不全來決定真生成還是
        // 靜默剝掉——沒傳等於「沒接生圖」，避免標籤原樣漏進氣泡裡。
        const photoMatches = [...content.matchAll(/\[\[ACTION:SEND_PHOTO\s*\|\s*(.*?)\s*\]\]/g)];
        if (photoMatches.length > 0) {
            for (const m of photoMatches) content = content.replace(m[0], '').trim();
            const canGenerate = !!(
                imageGenConfig?.charImageGenEnabled && imageGenConfig?.charImageSendEnabled
                && imageGenConfig?.baseUrl && imageGenConfig?.model
            );
            if (canGenerate) {
                // 先落「照片生成中」的佔位卡再生成（utils/pendingPhoto.ts）：生成途中切走、失敗的，
                // 卡片留著，回到 App 時自動補。挨個順序來——生圖要花錢，不併發搶速度。
                for (const m of photoMatches) {
                    const description = m[1].trim();
                    if (!description) continue;
                    try {
                        const pendingId = await createPendingPhoto(persist, charId, description);
                        const ok = await fulfillPendingPhoto(pendingId, imageGenConfig);
                        if (!ok) addToast(`${charName} 的照片還沒生成好，回到 App 時會自動再試`, 'info');
                    } catch (error) {
                        console.warn('[ChatParser] 角色發圖失敗:', error);
                        addToast(`${charName} 想發張照片，但生成失敗了`, 'error');
                    }
                }
            } else {
                console.warn('[ChatParser] 角色想發圖，但生圖未開啟/未配置完整，已忽略標籤', { charId });
            }
        }

        // TRANSFER_ACCEPT / TRANSFER_RETURN — char 收下 / 退回 user 最近一筆待處理的轉帳。
        // 找最近一條 user 發出、還沒被收/退、且不是回執卡本身的轉帳，標記狀態並補一張回執小卡。
        //
        // 找不到待處理轉帳時**不落回執**：老實現會照樣落一張，渲染成「xx已收款」
        // (MessageItem.tsx TransferCard)，等於角色能憑空聲明自己收了一筆用戶從沒發過的錢。
        // 老註釋寫的「至少 user 能看到反饋」意圖是防靜默失敗，但代價是假帳——角色那句話
        // 照常顯示，用戶看到的最多是句廢話，比看到一筆不存在的收款好。
        const resolveUserTransfer = async (action: 'accepted' | 'returned') => {
            let amount: string | number | undefined;
            let refId: number | undefined;
            try {
                const all = await DB.getMessagesByCharId(charId, true);
                const pendings = all.filter(
                    x => x.type === 'transfer' && x.role === 'user' && !x.metadata?.receipt
                        && (!x.metadata?.status || x.metadata.status === 'pending'),
                );
                // 角色收的是**它說這句話那一刻**看得到的那筆。主動消息補收會把「生成」和「重放」
                // 拉開幾小時：用戶早上又轉了 1000，按「最新一筆待收」結算就會讓角色半夜那句
                // 「這五塊我收下啦」把早上那 1000 給收了。所以先在原始發送時刻之前的待收裡取最新，
                // 一筆都沒有再退回老行為（並留一行日誌說明這次是按最新一筆結的）。
                let pending = messageTimestamp != null
                    ? [...pendings].reverse().find(x => (x.timestamp ?? 0) <= messageTimestamp)
                    : undefined;
                if (!pending) {
                    if (messageTimestamp != null && pendings.length > 0) {
                        console.warn(
                            '[Transfer] 這條消息發出時並沒有待收的轉帳，退回按最新一筆結算:',
                            { charId, messageTimestamp, pendingCount: pendings.length },
                        );
                    }
                    pending = pendings[pendings.length - 1];
                }
                if (pending) {
                    amount = pending.metadata?.amount;
                    refId = pending.id;
                    await DB.updateMessageMetadata(pending.id, (prev) => ({ ...(prev || {}), status: action, resolvedAt: Date.now() }));
                }
            } catch (e) {
                console.warn('[Transfer] 查待處理轉帳失敗，跳過回執:', e);
                return;
            }
            if (refId === undefined) {
                console.warn(`[Transfer] 角色想${action === 'accepted' ? '收下' : '退回'}轉帳，但沒有待處理的用戶轉帳，已忽略`);
                return;
            }
            await persist({
                charId, role: 'assistant', type: 'transfer',
                content: action === 'accepted' ? '[已收款]' : '[已退回]',
                metadata: { receipt: action, amount, ref: refId },
            });
            // 退回：錢在用戶發送那一刻就已經從 Real Balance 扣走了，角色退回等於這筆錢
            // 沒真的花出去，得退款回去。收下：錢這時才真的到帳角色，記入角色的 Real Balance。
            const numericAmount = Number(amount);
            if (Number.isFinite(numericAmount) && numericAmount > 0) {
                if (action === 'returned' && onUserTransferReturned) {
                    await onUserTransferReturned(numericAmount);
                } else if (action === 'accepted' && onUserTransferAccepted) {
                    await onUserTransferAccepted(numericAmount);
                }
            }
        };

        // TRANSFER — 規範標籤 + 模仿歷史日誌的口語形態一起解析，見 utils/transferFormat.ts。
        // 按出現順序執行，保住角色「先轉帳再說謝謝」這類語序意圖。
        const { text: transferCleanedText, events: transferEvents, consumed: transferConsumed } = extractTransferCommands(content);
        if (transferConsumed > 0) content = transferCleanedText;
        for (const ev of transferEvents) {
            if (ev.kind === 'send') {
                // 發送即結清：先從角色 Real Balance 扣款，扣不出來就不落卡（等於這句「轉給你」
                // 沒真的發生）。不傳檢查回調則維持老行為，直接落卡。
                const sendAmount = Number(ev.amount);
                const ok = onCharTransferSend && Number.isFinite(sendAmount) && sendAmount > 0
                    ? await onCharTransferSend(sendAmount)
                    : true;
                if (!ok) {
                    console.warn('[Transfer] 角色 Real Balance 不足，跳過這筆主動轉帳:', { charId, amount: ev.amount });
                    continue;
                }
                // role 固定 'assistant' —— 方向不由文本決定，文本里的方向信息只在
                // transferFormat 裡做過校驗（偽造的已被丟棄）。
                await persist({ charId, role: 'assistant', type: 'transfer', content: '[轉帳]', metadata: { amount: ev.amount, status: 'pending' } });
            } else {
                await resolveUserTransfer(ev.kind === 'accept' ? 'accepted' : 'returned');
            }
        }

        // MALL DAIFU — 角色對「外賣代付請求」支付或拒絕。跟 resolveUserTransfer 結構相同：
        // 找最近一條 user 發出、還 pending 的 mall_order(mode=daifu)，標記狀態。跟轉帳不同的是
        // 這不是兩方帳本的轉移，是角色單方面的支出（角色替用戶付了這頓飯），所以只更新原卡
        // 自己的 status，不另外落一張回執小卡——MallOrderCard 本身就靠 status 字段切換四種展示。
        const resolveMallDaifu = async (action: 'accepted' | 'declined', reason?: string) => {
            let amount: number | undefined;
            let refId: number | undefined;
            try {
                const all = await DB.getMessagesByCharId(charId, true);
                const pendings = all.filter(
                    x => x.type === 'mall_order' && x.role === 'user' && x.metadata?.mode === 'daifu' && x.metadata?.status === 'pending',
                );
                // 跟 resolveUserTransfer 同一個理由：按「這句話說出口那一刻」看得到的最新一筆結算，
                // 離線補收拉開生成/重放的時間差時不會讓半夜那句話結了早上才發的請求。
                let pending = messageTimestamp != null
                    ? [...pendings].reverse().find(x => (x.timestamp ?? 0) <= messageTimestamp)
                    : undefined;
                if (!pending) {
                    if (messageTimestamp != null && pendings.length > 0) {
                        console.warn('[MallDaifu] 這條消息發出時並沒有待處理的代付請求，按最新一筆結算:', { charId, messageTimestamp, pendingCount: pendings.length });
                    }
                    pending = pendings[pendings.length - 1];
                }
                if (pending) {
                    amount = Number(pending.metadata?.total);
                    refId = pending.id;
                }
            } catch (e) {
                console.warn('[MallDaifu] 查待處理代付請求失敗，跳過:', e);
                return;
            }
            if (refId === undefined) {
                console.warn(`[MallDaifu] 角色想${action === 'accepted' ? '支付' : '拒絕'}代付請求，但沒有待處理的請求，已忽略`);
                return;
            }
            let finalAction = action;
            let finalReason = action === 'declined' ? reason : undefined;
            if (action === 'accepted' && Number.isFinite(amount) && (amount as number) > 0 && onCharDaifuAccept) {
                const ok = await onCharDaifuAccept(amount as number);
                if (!ok) {
                    finalAction = 'declined';
                    finalReason = '餘額不夠，付不出這筆錢';
                    console.warn('[MallDaifu] 角色 Real Balance 不足，代付請求自動改判拒絕:', { charId, amount });
                }
            }
            await DB.updateMessageMetadata(refId, (prev) => ({
                ...(prev || {}),
                status: finalAction,
                ...(finalReason ? { declineReason: finalReason } : {}),
                resolvedAt: Date.now(),
            }));
        };

        // MALL — 購物中心的 GIFT send / DAIFU accept-decline，見 utils/mallOrderFormat.ts。
        const { text: mallCleanedText, events: mallOrderEvents, consumed: mallOrderConsumed } = extractMallOrderCommands(content);
        if (mallOrderConsumed > 0) content = mallCleanedText;
        for (const ev of mallOrderEvents) {
            if (ev.kind === 'send') {
                const price = Number(ev.price);
                const ok = onCharGiftSend && Number.isFinite(price) && price > 0
                    ? await onCharGiftSend(price)
                    : true;
                if (!ok) {
                    console.warn('[Mall] 角色 Real Balance 不足，跳過這份主動送出的禮物:', { charId, item: ev.item, price: ev.price });
                    continue;
                }
                await persist({
                    charId, role: 'assistant', type: 'mall_order', content: '[購物中心卡片]',
                    metadata: { mode: 'gift', items: [{ name: ev.item, price, qty: 1 }], total: price, note: ev.note, status: 'sent' },
                });
            } else {
                await resolveMallDaifu(ev.kind === 'accept' ? 'accepted' : 'declined', ev.kind === 'decline' ? ev.reason : undefined);
            }
        }

        // MALL GIFT ACK — 用戶送的禮物是「發送即結清」，沒有 accept 步驟，但完全沒反饋不好；
        // 角色這一輪既然生成了回覆，就說明已經看到了這份禮物，順手標一個 acknowledged，
        // 讓 MallOrderCard 在"已送出"旁邊多顯示一句"TA已收下"。不用教模型專門喊一個標籤——
        // 這是純擺設確認，說不說都不影響結算，沒必要為這個引入"想做≠做了"的標籤遺忘風險；
        // 直接按"角色這輪說話了 = 已經看到最新一條歷史"這個必然成立的事實來標記，更穩。
        // 只標最新一條：老的已經錯過時機，不用倒著一次性全標。
        try {
            const allMsgs = await DB.getMessagesByCharId(charId, true);
            const unacked = allMsgs
                .filter(x => x.type === 'mall_order' && x.role === 'user' && x.metadata?.mode === 'gift' && x.metadata?.status === 'sent' && !x.metadata?.acknowledged)
                .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
            if (unacked[0]) {
                await DB.updateMessageMetadata(unacked[0].id, (prev) => ({ ...(prev || {}), acknowledged: true }));
            }
        } catch (e) {
            console.warn('[Mall] 標記禮物已讀失敗，跳過:', e);
        }

        // MUSIC_ACTION — char 對 user 正在聽的歌表態（只處理第一次出現，每條消息最多一次插卡）
        // 支持的格式（後兩種是為了讓 char 自己挑歌單 / 新建歌單）：
        //   [[MUSIC_ACTION:join]]
        //   [[MUSIC_ACTION:add]]                              → 默認放第一個歌單
        //   [[MUSIC_ACTION:add|歌單標題]]                      → 放進現有歌單（標題匹配）
        //   [[MUSIC_ACTION:add_new|新歌單標題|可選描述]]        → 新建歌單
        //   [[MUSIC_ACTION:join_and_add(|...)]]              → 同 add 一套
        //   [[MUSIC_ACTION:join_and_add_new|新歌單標題|描述]]  → 同 add_new
        // 用 | 分隔參數，避免和 : 衝突（標題裡很容易出現 :)
        const MUSIC_TAG_RE = /\[\[MUSIC_ACTION:(join|add|add_new|join_and_add|join_and_add_new)(?:\|([^\]]*))?\]\]/;
        const MUSIC_TAG_GLOBAL_RE = /\[\[MUSIC_ACTION:(?:join|add|add_new|join_and_add|join_and_add_new)(?:\|[^\]]*)?\]\]/g;
        const musicMatch = content.match(MUSIC_TAG_RE);
        if (musicMatch && musicHooks) {
            const verb = musicMatch[1] as 'join' | 'add' | 'add_new' | 'join_and_add' | 'join_and_add_new';
            const argsRaw = (musicMatch[2] || '').trim();
            const args = argsRaw ? argsRaw.split('|').map(s => s.trim()).filter(Boolean) : [];
            // 卡片元數據裡只用 join / add / join_and_add 三種意圖，把 _new 摺疊回 add 系
            const intent: 'join' | 'add' | 'join_and_add' =
                verb === 'join' ? 'join'
                : (verb === 'add' || verb === 'add_new') ? 'add'
                : 'join_and_add';
            const wantsJoin = verb === 'join' || verb === 'join_and_add' || verb === 'join_and_add_new';
            const wantsAdd = verb !== 'join';

            let target: AddSongTarget | undefined;
            if (wantsAdd) {
                if (verb === 'add_new' || verb === 'join_and_add_new') {
                    // 至少要有標題；沒標題就退化成默認 add
                    if (args[0]) target = { kind: 'new', title: args[0], description: args[1] };
                } else if (args[0]) {
                    target = { kind: 'existing', title: args[0] };
                }
            }

            // 先認「角色寫這句話時讀到的那首」（定時消息由 worker 凍進 directive、調用方傳進來），
            // 沒有這一份才退回「用戶此刻在聽的那首」——本地聊天走的一直是後者。
            const frozen = normalizeFrozenSong(frozenMusicSong);
            const snap = frozen
                ? await resolveFrozenSongSnapshot(charId, frozen)
                : musicHooks.getListeningSnapshot();
            if (snap) {
                let addedToPlaylistTitle: string | undefined;
                let playlistCreated = false;
                if (wantsJoin) {
                    musicHooks.joinListeningTogether(charId);
                }
                if (wantsAdd) {
                    try {
                        const playlistSong: CharPlaylistSong = {
                            id: snap.songId,
                            name: snap.name,
                            artists: snap.artists,
                            album: snap.album,
                            albumPic: snap.albumPic,
                            duration: snap.duration,
                            fee: snap.fee,
                            // 'user' 的意思是「這首是從用戶那兒聽來的」，之後的提示詞會照著說
                            // （見 ContextBuilder 那段「從對方那兒收進來的歌」）。凍結的那首是
                            // 角色自己在聽的，標成 'user' 等於讓它以後認錯來路。
                            source: frozen ? 'discovered' : 'user',
                            addedAt: Date.now(),
                        };
                        const added = await musicHooks.addSongToCharPlaylist(charId, playlistSong, target);
                        if (added) {
                            addedToPlaylistTitle = added.playlistTitle;
                            playlistCreated = added.created;
                        }
                    } catch { /* 忽略 */ }
                }
                await persist({
                    charId,
                    role: 'assistant',
                    type: 'music_card',
                    content: '[音樂卡片]',
                    metadata: {
                        intent,
                        song: snap,
                        addedToPlaylistTitle,
                        playlistCreated,
                    },
                });
                const playlistSuffix = addedToPlaylistTitle
                    ? (playlistCreated ? `（新建《${addedToPlaylistTitle}》）` : `《${addedToPlaylistTitle}》`)
                    : '';
                addToast(
                    intent === 'join' ? `${charName} 和你一起聽` :
                    intent === 'add' ? `${charName} 把這首加到了${playlistSuffix || '自己歌單'}` :
                    `${charName} 和你一起聽，也加到了${playlistSuffix || '歌單'}`,
                    'info'
                );
            } else {
                // 兩頭都空：推送裡沒凍歌（比如那一刻角色的日程不在聽歌的時段，或者是本地
                // 聊天路徑），用戶此刻也沒在放歌。剩下的選擇只有跳過 —— 但靜默跳過的結果是
                // 「正文在聊這首歌，卡片和歌單動作卻整個沒發生」，排查時一點線索都沒有，
                // 所以至少留一行。
                console.warn(
                    '[MusicAction] 既沒有凍結的歌、也取不到"正在聽"快照，這條音樂動作跳過:',
                    { charId, verb, args, messageTimestamp },
                );
            }
            content = content.replace(musicMatch[0], '').trim();
            // 同類 tag 全清，防止 LLM 一條消息裡插多次
            content = content.replace(MUSIC_TAG_GLOBAL_RE, '').trim();
        } else if (musicMatch) {
            // 沒有 hooks（無音樂上下文）— 靜默丟棄
            content = content.replace(MUSIC_TAG_GLOBAL_RE, '').trim();
        }

        // NEWS_CARD — char 主動把某條熱點當作新聞卡片分享（來源 + 標題）
        //   [[NEWS_CARD: 來源|標題]]    （來源可省略 → [[NEWS_CARD: 標題]]）
        const NEWS_CARD_RE = /\[\[NEWS_CARD:\s*([^\]]*?)\s*\]\]/;
        const NEWS_CARD_GLOBAL_RE = /\[\[NEWS_CARD:[^\]]*\]\]/g;
        const newsCardMatch = content.match(NEWS_CARD_RE);
        if (newsCardMatch) {
            const raw = (newsCardMatch[1] || '').trim();
            if (raw) {
                const segs = raw.split('|').map(s => s.trim());
                let source = '';
                let title = raw;
                if (segs.length >= 2) {
                    source = segs[0];
                    title = segs.slice(1).join('|').trim();
                }
                // char 不知道鏈接，嘗試從最近一次熱點快照裡按標題補 url / 來源 / 簡介
                let url: string | undefined;
                let desc: string | undefined;
                try {
                    const snap = await DB.getLatestHotNewsSnapshot();
                    const items = snap?.items || [];
                    // 先精確匹配。模糊匹配只在**唯一命中**時才用：本地這份快照和角色當時看到的
                    // 那份常常不是同一刻，熱搜裡相似標題成堆（同一件事好幾條），挑錯一條就是卡片
                    // 標題說 A、點進去是 B。寧可不掛鏈接——無鏈接的卡片本來就是既有形態。
                    let hit = items.find(it => it.title === title);
                    if (!hit && title) {
                        const fuzzy = items.filter(it => it.title.includes(title) || title.includes(it.title));
                        if (fuzzy.length === 1) {
                            hit = fuzzy[0];
                        } else if (fuzzy.length > 1) {
                            console.warn(
                                '[NewsCard] 本地熱搜裡有多條標題對得上，這張卡不掛鏈接:',
                                { title, matched: fuzzy.map(it => it.title) },
                            );
                        }
                    }
                    if (hit) {
                        url = hit.url;
                        desc = hit.desc;
                        if (!source && hit.source) source = hit.source;
                    }
                } catch { /* 補不到就算了 */ }
                if (title) {
                    await persist({
                        charId,
                        role: 'assistant',
                        type: 'news_card',
                        content: `[你分享了一個熱點：「${title}」${source ? `（來源：${source}）` : ''}${desc ? `——${desc}` : ''}]`,
                        metadata: { source, title, url, desc },
                    });
                    addToast(`${charName} 分享了一條熱點`, 'info');
                }
            }
            content = content.replace(NEWS_CARD_GLOBAL_RE, '').trim();
        }

        // ADD_EVENT
        const eventMatch = content.match(/\[\[ACTION:ADD_EVENT\s*\|\s*(.*?)\s*\|\s*(.*?)\]\]/);
        if (eventMatch) {
            const title = eventMatch[1].trim();
            const date = eventMatch[2].trim();
            if (title && date) {
                const anni: any = { id: `anni-${Date.now()}`, title: title, date: date, charId };
                await DB.saveAnniversary(anni);
                addToast(`${charName} 添加了新日程: ${title}`, 'success');
                await persist({ charId, role: 'system', type: 'text', content: `[系統: ${charName} 新增了日程 "${title}" (${date})]` });
            }
            content = content.replace(eventMatch[0], '').trim();
        }

        // SCHEDULE
        const scheduleRegex = /\[schedule_message \| (.*?) \| fixed \| (.*?)\]/g;
        let match;
        while ((match = scheduleRegex.exec(content)) !== null) {
            const timeStr = match[1].trim();
            const msgContent = match[2].trim();
            // 角色照著自己那邊的鐘寫時間，按設備時區解釋會整體偏一個時差：
            // 紐約角色在自己上午說「今晚 21:00 找你」，設備在中國就會算成已經過期。
            const dueTime = wallClockToTimestamp(timeStr, charTz);
            // 時間寫歪 / 已經過去的一律不排。這兩種情況下角色在正文裡往往已經把話說出去了
            // （「我到點叫你」），排不上就是一句空頭承諾，所以留一行日誌說清是哪條、為什麼，
            // 別讓它悄無聲息地消失。離線補收時尤其常見：消息是凌晨發的，人第二天早上才打開。
            if (isNaN(dueTime)) {
                console.warn('[ScheduledMessage] 時間解析不了，這條不排:', timeStr, '內容:', msgContent);
                continue;
            }
            if (dueTime <= Date.now()) {
                console.warn(
                    '[ScheduledMessage] 時間已經過去，這條不排:', timeStr,
                    `(角色時區 ${charTz ?? '設備默認'}，晚了 ${Math.round((Date.now() - dueTime) / 60000)} 分鐘)`,
                    '內容:', msgContent,
                );
                continue;
            }
            await DB.saveScheduledMessage({ id: `sched-${Date.now()}-${Math.random()}`, charId, content: msgContent, dueAt: dueTime, createdAt: Date.now() });
            try {
                const hasPerm = await LocalNotifications.checkPermissions();
                if (hasPerm.display === 'granted') {
                    await LocalNotifications.schedule({ notifications: [{ title: charName, body: msgContent, id: Math.floor(Math.random() * 100000), schedule: { at: new Date(dueTime) }, smallIcon: 'ic_stat_icon_config_sample' }] });
                }
            } catch (e) { console.log("Notification schedule skipped (web mode)"); }
            addToast(`${charName} 似乎打算一會兒找你...`, 'info');
        }
        content = content.replace(scheduleRegex, '').trim();

        // LIFE — 生活記錄代記（生理期/藥盒/記帳/鍛鍊）。開關校驗、去重、寫庫、落 life_card
        // 都在 lifeRecords.ts 裡；這裡只負責取角色檔案。取不到就只剝 tag（靜默丟棄）。
        if (content.includes('[[LIFE:')) {
            try {
                const chars = await DB.getAllCharacters();
                const charProfile = chars.find(c => c.id === charId);
                content = charProfile
                    ? await executeLifeDirectives(content, charProfile, addToast, messageTimestamp, inheritMeta)
                    : content.replace(/\[\[LIFE:[^\]]*\]\]/g, '').trim();
            } catch (e) {
                console.error('[LifeRecord] parse failed:', e);
                content = content.replace(/\[\[LIFE:[^\]]*\]\]/g, '').trim();
            }
        }

        // RECALL tag removal (handling done in main loop logic, but cleaning here just in case)
        content = content.replace(/\[\[RECALL:.*?\]\]/g, '').trim();

        return content;
    },

    /**
     * Comprehensive sanitizer for AI output before saving to DB.
     * Removes AI-specific artifacts that should never appear in chat bubbles.
     * Safe to call multiple times (idempotent). Preserves %%BILINGUAL%% markers.
     * Pass { keepCitations: true } to preserve [QUOTE:..]/[引用:..]/[回覆 ".."] tags
     * (used when downstream chunking needs to detect per-bubble citation targets).
     */
    sanitize: (text: string, options?: { keepCitations?: boolean }): string => sanitizeForBubble(text, options),

    /**
     * Check if text has meaningful display content after stripping all markers/junk.
     * Used to decide whether a chunk is worth saving as a message.
     */
    hasDisplayContent: (text: string): boolean => {
        const stripped = text
            .replace(/%%BILINGUAL%%/gi, '')
            .replace(/%%TRANS%%[\s\S]*/gi, '')
            // 容錯版 (對齊 MessageItem stripJunk): 截斷/全角/簡繁的破翻譯標籤也不算顯示內容
            .replace(/[<＜]\s*[/／]?\s*(?:翻[译譯譯]|原文|[译譯譯]文)\s*[>＞]?/g, '')
            .replace(/^\s*---\s*$/gm, '')
            .replace(/``+/g, '')
            .replace(/(^|\s)`(\s|$)/gm, '$1$2')
            .replace(/\[\[[\s\S]*?\]\]/g, '')
            .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
            .replace(/\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g, '')
            .replace(/\[回[复覆]\s*[""\u201C][^""\u201D]*?[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/g, '')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/^\s*[-*+]\s*$/gm, '')
            .trim();
        return stripped.length > 0;
    },

    // Split text into bubbles (text and emojis)
    splitResponse: (content: string): { type: 'text' | 'emoji', content: string }[] => {
        const emojiPattern = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
        const parts: {type: 'text' | 'emoji', content: string}[] = [];
        let lastIndex = 0;
        let emojiMatch;

        while ((emojiMatch = emojiPattern.exec(content)) !== null) {
            if (emojiMatch.index > lastIndex) {
                const textBefore = content.slice(lastIndex, emojiMatch.index).trim();
                if (textBefore) parts.push({ type: 'text', content: textBefore });
            }
            parts.push({ type: 'emoji', content: emojiMatch[1].trim() });
            lastIndex = emojiMatch.index + emojiMatch[0].length;
        }

        if (lastIndex < content.length) {
            const remaining = content.slice(lastIndex).trim();
            if (remaining) parts.push({ type: 'text', content: remaining });
        }

        if (parts.length === 0 && content.trim()) parts.push({ type: 'text', content: content.trim() });
        return parts;
    },

    // Chunking text for typing effect - splits into separate chat bubbles.
    // Only explicit line breaks are bubble boundaries. Ordinary whitespace must stay in the
    // same bubble: models often put spaces inside Japanese/Chinese mixed-language prose, and
    // treating those spaces as implicit newlines cuts a single sentence in half.
    chunkText: (text: string): string[] => {
        // 0. 保護 <語音…>…</語音> 原子塊。外語語音字幕對齊模式下 (見 chatPrompts
        //    voiceActingGuide) 標籤內部常按空行分成好幾段，一旦被下面的換行斷句切碎，
        //    <語音> 的開 / 閉標籤就會散落到不同氣泡裡；MessageItem 的 hasVoiceTag 要求
        //    開閉成對，配不上就當純文字漏出原始標籤，語音條和翻譯也全不渲染 (掉格式)。
        //    跟 worker 端 sanitize.ts 的 Phase 1.5 一樣把整塊換成獨佔一行的佔位符，
        //    切分後再原樣還原成一個 chunk。
        const ATOM = String.fromCharCode(2);
        const voiceBlocks: string[] = [];
        // 語音塊 + 緊鄰 <字幕> 塊是一個原子單元 (字幕是該語音的中文對照, 拆開就配不上)。
        // 閉合標籤容許空格 / 簡繁互換 (normalizeVoiceTags 在 sanitize 階段已修, 這裡是保險)
        const guardedText = text.replace(/(?:<字幕>[\s\S]*?<\/字幕>\s*)?<[语語語]音[^>]*>[\s\S]*?<\/\s*[语語語]音\s*>(?:\s*<字幕>[\s\S]*?<\/字幕>)?/g, m => {
            const idx = voiceBlocks.length;
            voiceBlocks.push(m);
            return `\n${ATOM}${idx}${ATOM}\n`;
        });

        // 1. Split on line breaks (AI decides where to break)
        const lineChunks = guardedText.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
            .map(c => c.trim())
            .filter(c => c.length > 0);

        const ATOM_GLOBAL = new RegExp(`${ATOM}(\\d+)${ATOM}`, 'g');
        const restoreVoice = (s: string) => s.replace(ATOM_GLOBAL, (_m, n) => voiceBlocks[Number(n)] ?? '');
        return lineChunks
            .map(restoreVoice)
            .filter(c => c.length > 0);
    }
}
