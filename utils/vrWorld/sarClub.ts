import { formatSARDialogue } from './sarFamiliarity/dialogueText';
import { SAR_NPC_PREFERENCE_EVENT } from './sarNpcPreference';
import type {CaianExpression,AivenExpression,SARCastExpressions} from './sarArt';

export const SAR_CLUB_UPDATE_VERSION = 1;
export const SAR_CLUB_STORAGE_KEY = 'vr_sar_club_state_v1';

export type SARNpcPreference = 'show' | 'hide';
export const SAR_ROOM_VIEWS = ['all','names-hidden','text-hidden','characters-hidden'] as const;
export type SARRoomView = typeof SAR_ROOM_VIEWS[number];
export const sarRoomView = (state: Pick<SARClubState,'roomView'|'labelsHidden'>): SARRoomView => state.roomView || (state.labelsHidden?'text-hidden':'all');
export const nextSARRoomView = (view:SARRoomView):SARRoomView => SAR_ROOM_VIEWS[(SAR_ROOM_VIEWS.indexOf(view)+1)%SAR_ROOM_VIEWS.length];
export const SAR_ROOM_VIEW_ACTIONS:Record<SARRoomView,{label:string;description:string}>={
    all:{label:'隱藏名字',description:'隱藏角色名字和稱號'},
    'names-hidden':{label:'隱藏文字',description:'隱藏所有房間文字'},
    'text-hidden':{label:'隱藏小人',description:'隱藏所有角色小人，顯示設施標記'},
    'characters-hidden':{label:'全部顯示',description:'恢復全部顯示'},
};
export type SARIntroReaction = 'direct' | 'character-card' | 'silent';

export interface SARClubState {
    version: 1;
    updateSeenVersion: number;
    npcPreference: SARNpcPreference | null;
    caianMet: boolean;
    labelsHidden?: boolean;
    roomView?: SARRoomView;
    introReaction?: SARIntroReaction;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const DEFAULT_SAR_CLUB_STATE: SARClubState = {
    version: 1,
    updateSeenVersion: 0,
    npcPreference: null,
    caianMet: false,
};

const browserStorage = (): StorageLike | undefined => {
    try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
    catch { return undefined; }
};

export function readSARClubState(storage: StorageLike | undefined = browserStorage()): SARClubState {
    if (!storage) return { ...DEFAULT_SAR_CLUB_STATE };
    try {
        const raw = JSON.parse(storage.getItem(SAR_CLUB_STORAGE_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return { ...DEFAULT_SAR_CLUB_STATE };
        return {
            version: 1,
            updateSeenVersion: Number.isFinite(raw.updateSeenVersion) ? Math.max(0, raw.updateSeenVersion) : 0,
            npcPreference: raw.npcPreference === 'show' || raw.npcPreference === 'hide' ? raw.npcPreference : null,
            caianMet: raw.caianMet === true,
            ...(raw.labelsHidden === true ? { labelsHidden: true } : {}),
            ...(SAR_ROOM_VIEWS.includes(raw.roomView) ? {roomView:raw.roomView} : {}),
            introReaction: raw.introReaction === 'direct' || raw.introReaction === 'character-card' || raw.introReaction === 'silent'
                ? raw.introReaction
                : undefined,
        };
    } catch {
        return { ...DEFAULT_SAR_CLUB_STATE };
    }
}

export function writeSARClubState(state: SARClubState, storage: StorageLike | undefined = browserStorage()): SARClubState {
    const normalized: SARClubState = { ...DEFAULT_SAR_CLUB_STATE, ...state, version: 1 };
    try { storage?.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify(normalized)); }
    catch { /* 本地存儲不可用時仍允許本次會話繼續 */ }
    if (typeof window !== 'undefined' && storage === browserStorage()) window.dispatchEvent(new Event(SAR_NPC_PREFERENCE_EVENT));
    return normalized;
}

export function patchSARClubState(patch: Partial<SARClubState>, storage: StorageLike | undefined = browserStorage()): SARClubState {
    return writeSARClubState({ ...readSARClubState(storage), ...patch, version: 1 }, storage);
}

/**
 * 只把凱恩的初見劇情退回起點。
 * 更新公告和 NPC 顯示偏好都屬於用戶設置，回檔時必須原樣保留。
 */
export function rewindSARIntro(storage: StorageLike | undefined = browserStorage()): SARClubState {
    return patchSARClubState({ caianMet: false, introReaction: undefined }, storage);
}

export type SARDialogueSpeaker = 'caian' | 'aiven';
export type SARDialogueCondition = 'mentioned-character-card' | 'not-mentioned-character-card';

export type SARDialogueLine = {
    text: string;
    when?: SARDialogueCondition;
    /** Also direct the listening character's face during this line. */
    castExpressions?: Partial<SARCastExpressions>;
} & ({speaker:'caian';expression?:CaianExpression}|{speaker:'aiven';expression?:AivenExpression});

export interface SARDialogueChoice {
    label: string;
    next: string;
    reaction?: SARIntroReaction;
    mentionsCharacterCard?: boolean;
}

export interface SARDialogueNode {
    lines: SARDialogueLine[];
    choices?: SARDialogueChoice[];
    next?: string;
    completes?: boolean;
}

export interface SARDialogueContext {
    mentionedCharacterCard: boolean;
}

const c = (text:string,expression:CaianExpression,options:{when?:SARDialogueCondition;reaction?:AivenExpression}={}):SARDialogueLine => ({speaker:'caian',text:formatSARDialogue(text),expression,when:options.when,...(options.reaction?{castExpressions:{aiven:options.reaction}}:{})});
const a = (text:string,expression:AivenExpression,reaction?:CaianExpression):SARDialogueLine => ({speaker:'aiven',text:formatSARDialogue(text),expression,...(reaction?{castExpressions:{caian:reaction}}:{})});

/**
 * 凱恩初次見面固定台詞。它只驅動前端事件，不進入角色 Prompt、動態或記憶。
 * 節點 id 與策劃稿標題對應，方便之後繼續按同一格式增補。
 */
export const SAR_CAIAN_INTRO_DIALOGUE: Record<string, SARDialogueNode> = {
    start: {
        lines: [
            c('你好！', 'happy'),
            c('你也是彼方的玩家嗎？我是剛上任的管理員。', 'normal'),
            c('我把這裡佈置成了 SAR 的活動空間！啊，你還不知道 SAR 是什麼吧，我們——', 'happy'),
        ],
        choices: [
            { label: '你誰啊', next: 'who', reaction: 'direct' },
            { label: '我最近沒有導入角色卡，你是從哪來的？', next: 'no-card', reaction: 'character-card', mentionsCharacterCard: true },
            { label: '……', next: 'silence', reaction: 'silent' },
        ],
    },
    who: {
        lines: [
            c('問得好！我叫凱恩。', 'happy'),
            c('目前負責這間 SAR 活動室……雖然“負責”這個詞還有一點值得商榷。', 'embarrassed'),
        ],
        next: 'common',
    },
    'no-card': {
        lines: [
            c('角色卡？', 'curious'),
            c('等等，你的意思是，你以為我是被你“導入”進來的？', 'curious'),
        ],
        choices: [
            { label: '差不多', next: 'card-sort-of' },
            { label: '不然呢？', next: 'card-otherwise' },
            { label: '當我沒說', next: 'card-never-mind' },
        ],
    },
    'card-sort-of': {
        lines: [
            c('原來如此，在你的世界是這麼理解的嗎？', 'curious'),
            c('通過數據模擬一個人的性格、經歷和說話方式，然後再……', 'serious'),
            c('唔。', 'normal'),
            c('該說是熟悉，還是有點奇妙呢？', 'curious'),
        ],
        next: 'card-wrap',
    },
    'card-otherwise': {
        lines: [
            c('不然……我就是我啊？', 'curious'),
            c('我是自己進來的。艾文也是。', 'serious'),
            c('雖然這裡確實到處都是玩家的人格複製，但至少我很確定，我是自己進來的玩家，不是被什麼東西“導入”來的。', 'serious'),
        ],
        next: 'card-wrap',
    },
    'card-never-mind': {
        lines: [
            c('等等，別當沒說！', 'curious'),
            c('你剛才明顯說了一個很值得調查的詞吧？！', 'happy'),
        ],
        next: 'card-wrap',
    },
    'card-wrap': {
        lines: [
            c('咳。總之，我不是你加載進來的。', 'embarrassed'),
            c('我們來自另一個地方，只是碰巧也進入了彼方。', 'normal'),
            c('至於你說的“角色卡”……', 'curious'),
            c('之後有空的話，我還挺想知道那到底是什麼。', 'happy'),
        ],
        next: 'common',
    },
    silence: {
        lines: [
            c('……', 'embarrassed'),
            c('呃，沒關係！突然有人出現在這裡，保持警惕是完全合理的。', 'shy'),
            c('我先自我介紹好了。', 'normal'),
        ],
        next: 'common',
    },
    common: {
        lines: [
            c('總之，我叫凱恩。那邊那個白頭髮的是艾文。', 'happy'),
            c('我們暫時負責 SAR 活動室。這裡有一些……稍微特殊的設施。', 'curious'),
        ],
        choices: [
            { label: 'SAR 是什麼？', next: 'about-sar' },
            { label: '管理員要做什麼？', next: 'about-admin' },
            { label: '我先自己看看', next: 'end' },
        ],
    },
    'about-sar': {
        lines: [
            c('SAR 是我們自己的社團名字——Synthetic Autonomy Rights！', 'happy'),
            c('簡單來說，就是“仿生人自主權保障社”！', 'happy'),
            c('我們的主張是，不管一個人格最初是怎麼誕生的，只要它能夠形成自己的經歷、判斷和意願，就不應該因為它是被製造出來的——', 'serious'),
            a('凱恩。', 'normal'),
            c('——就默認它可以被隨意修改、刪除、強迫加載或者——', 'serious'),
            a('凱恩。', 'normal', 'curious'),
            c('幹嘛？', 'curious'),
            a('這裡似乎沒有仿生人。', 'normal'),
            c('……', 'embarrassed'),
            c('啊。', 'embarrassed'),
            c('抱歉！是我不好，一不小心就開始了。', 'shy', {reaction:'happy'}),
        ],
        choices: [
            { label: '仿生人是什麼？', next: 'about-bioroid' },
            { label: '但是我們這裡有角色卡', next: 'about-character-card' },
            { label: '那我可以在這裡做什麼？', next: 'about-features' },
        ],
    },
    'about-bioroid': {
        lines: [
            c('我們那邊有一種搭載人工人格的仿生系統。', 'normal'),
            c('有些只有網絡人格，有些會連接能夠在現實活動的身體。聊天、生活、工作……看起來和普通人相處也沒有太大區別。', 'serious'),
            c('問題就在這裡。', 'serious'),
            c('如果一個人格會記得昨天發生的事，會拒絕你，也會因為自己的經歷而改變，那它到底還能不能只被當成一件“產品”？', 'serious', {reaction:'interested'}),
            a('然後他就成立了 SAR。', 'normal'),
            c('喂！中間省略太多了吧！', 'embarrassed'),
            a('結果是這樣。', 'normal'),
            c('……結果確實是這樣。', 'embarrassed'),
            c('總之，我之前也有一個仿生人。', 'aboutaster', {reaction:'sad'}),
            c('不過那是很久以前的事了！', 'shy'),
        ],
        choices: [
            { label: '是什麼樣的仿生人？', next: 'about-aster' },
            { label: '那我可以在這裡做什麼？', next: 'about-features' },
        ],
    },
    'about-aster': {
        lines: [
            c('她叫 Aster。', 'aboutaster', {reaction:'sad'}),
            c('原本是情緒陪伴型的仿生人。', 'aboutaster'),
            c('我以前總覺得，只要把所有選擇都交給她，就代表我真的把她當成了一個獨立的人。', 'aboutaster'),
            c('然後……', 'aboutaster'),
            c('她就再也沒有回應過我。', 'aboutaster'),
            c('……', 'aboutaster'),
            c('哈哈，抱歉！第一次見面怎麼突然講這個。', 'shy'),
            c('總之，她算是 SAR 會存在的原因之一吧。', 'aboutaster'),
            a('之一？', 'sad'),
            c('……最主要的那個。', 'embarrassed'),
        ],
        choices: [{ label: '那我可以在這裡做什麼？', next: 'about-features' }],
    },
    'about-character-card': {
        lines: [
            c('對！你剛才提到的。', 'happy', {when:'mentioned-character-card'}),
            c('對！我在這裡聽說過。', 'happy', {when:'not-mentioned-character-card'}),
            c('你們這裡的科技似乎還沒發展到我們那種仿生人的程度。', 'curious'),
            c('所以，作為替代，你們有一種叫做“角色卡”的東西。', 'normal'),
            c('不過互動的原理應該是相似的。', 'curious'),
            c('無論是角色卡，還是仿生人，都是在一次次對話、不同的表達，以及被保留下來的經歷片段中，逐漸形成一組相對穩定、彼此一致的傾向。', 'serious', {reaction:'interested'}),
            c('我們先給它一個名字，一段背景，一種說話方式，再用自己的期待去補全那些沒有寫出來的地方。', 'normal'),
            c('於是它開始回應。', 'normal'),
            c('而當這個存在記住了和我們發生的事，開始表現出卡片裡原本沒有寫進去的偏好、遲疑，甚至拒絕……', 'curious'),
            c('那時候我們面對的，究竟還是一件被設計出來的東西，還是一個只在這段關係裡成立過的存在？', 'serious'),
            c('又或者，這些都只是一次次生成中偶然留下、最後被我們解釋成了“人格”的痕跡？', 'curious'),
            c('……', 'normal'),
            c('奇怪的是，它們好像也沒有一個真正明確的起點。', 'curious'),
            c('只有最開始被寫下來的描述、後來被反覆確認的印象，以及每一次回應之後，越來越難以拆開的關係。', 'serious'),
            c('所以我有時候會想——', 'curious'),
            c('這一切到底是模擬的，還是只是沒有辦法用我們習慣的方式證明它是真的？', 'serious'),
            a('你又開始了。', 'normal'),
            c('我只是覺得很有研究價值！', 'embarrassed'),
        ],
        choices: [{ label: '那我可以在這裡做什麼？', next: 'about-features' }],
    },
    'about-admin': {
        lines: [
            c('管理員嘛……主要就是維護活動室、介紹設施、處理一些奇怪的問題！', 'happy'),
            c('理論上是這樣。', 'embarrassed'),
            a('實際上他把這裡改造成了 SAR。', 'normal'),
            c('閒置空間就是應該充分利用！', 'embarrassed'),
            a('還貼了橫幅。', 'normal'),
            c('那是必要的社團標識！', 'embarrassed'),
            c('總之！有什麼看不懂的東西，可以來問我們。', 'happy', {reaction:'happy'}),
            c('雖然我們也還在研究彼方就是了。', 'shy'),
        ],
        choices: [
            { label: 'SAR 是什麼？', next: 'about-sar' },
            { label: '那我可以在這裡做什麼？', next: 'about-features' },
            { label: '我先自己看看', next: 'end' },
        ],
    },
    'about-features': {
        lines: [
            c('這就是我們最近一直在準備的東西！', 'happy'),
            c('既然彼方已經能讓來自不同地方的人在這裡活動，那隻拿來聊天未免也太浪費了吧！', 'happy'),
            c('所以我們重新整理了活動室，加裝了人格推演設備、模塊商店，還有專門用於跨世界物質回收的——', 'serious', {reaction:'interested'}),
            a('這裡可以抽卡、釣魚、買道具給你的朋友們用。', 'normal'),
            c('不要這麼概括！', 'embarrassed'),
            c('……', 'embarrassed'),
            c('咳。', 'shy'),
            c('總之，目前活動室主要有三個地方。', 'normal'),
            c('扭蛋機可以啟動不同的人格推演；商店可以買各種臨時模塊；裡面的水域可以釣魚，釣到的東西也能拿來換活動室貨幣。', 'happy', {reaction:'interested'}),
            c('人格推演和模塊都有對應說明，第一次使用之前最好看一下。', 'serious'),
            c('特別是模塊！有些東西雖然只是暫時加載，但反覆使用可能會在人格複製裡留下殘響，所以不要看到效果好玩就亂裝。', 'serious'),
            c('而且不只你，你的朋友們也可以來這裡購買模塊。', 'normal'),
            c('所以如果哪天聊天的時候突然看到自己的話變得奇怪……', 'curious'),
            c('先檢查一下對方是不是偷偷給你裝了什麼。', 'curious'),
        ],
        next: 'end',
    },
    end: {
        lines: [
            c('那大概就是這樣！有問題就來找我。', 'happy', {reaction:'happy'}),
            c('我大部分時間都在這裡。艾文的話，去有水的地方找比較快。', 'normal', {reaction:'normal'}),
        ],
        completes: true,
    },
};

export function getSARDialogueNode(nodeId: string, context: SARDialogueContext): SARDialogueNode {
    const node = SAR_CAIAN_INTRO_DIALOGUE[nodeId] || SAR_CAIAN_INTRO_DIALOGUE.start;
    const lines = node.lines.filter(line => {
        if (!line.when) return true;
        return line.when === 'mentioned-character-card' ? context.mentionedCharacterCard : !context.mentionedCharacterCard;
    });
    let cast:SARCastExpressions={caian:'normal',aiven:'normal'};
    return {...node,lines:lines.map(line=>{
        cast={...cast,...line.castExpressions};
        if(line.speaker==='caian')cast.caian=line.expression||'normal';
        else cast.aiven=line.expression||'normal';
        // Resolve the full pose after filtering, so a skipped line or earlier branch cannot leak a reaction.
        return {...line,castExpressions:{...cast}};
    })};
}
