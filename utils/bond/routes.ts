/**
 * 羈絆的路線與階段（plans/bond-batch1.md 1.2）。純邏輯，不碰資料庫。
 *
 * 「朋友」是階段不是路線：戀愛線、友情線、未指定都可以停在 friend。能不能往戀愛走一律看路線。
 */
import type { BondRecord, BondRoute } from '../../types';

export const BOND_ROUTES: BondRoute[] = ['romance', 'friendship', 'family'];

export const ROUTE_LABEL: Record<BondRoute | 'none', string> = {
    romance: '戀愛',
    friendship: '友情',
    family: '親情',
    none: '未指定',
};

/** 設定頁每個路線下面那一行 */
export const ROUTE_HINT: Record<BondRoute | 'none', string> = {
    romance: '可以從朋友開始，經過曖昧、成為戀人，往穩定相伴、訂婚、結婚走。身份要經過實際發生的事和你們雙方的表達才會改變。',
    friendship: '一直是友情。羈絆再深、再親近，也不會往戀愛走，角色也不會被引導成暗戀；友情一樣可以很深。',
    family: '血緣親屬。親近、理解、信任可以變深，稱謂是人物事實，升級不會改掉它，也不會變成戀愛。',
    none: '還沒選路線。目前是什麼關係照聊天設定寫的走，不限制、也不鎖定。',
};

export interface BondStageDef {
    id: string;
    label: string;
}

const STAGES: Record<BondRoute | 'none', BondStageDef[]> = {
    none: [{ id: 'friend', label: '朋友' }],
    romance: [
        { id: 'friend', label: '朋友' },
        { id: 'ambiguous', label: '曖昧' },
        { id: 'lovers', label: '戀人' },
        { id: 'steady', label: '穩定相伴' },
        { id: 'engaged', label: '訂婚' },
        { id: 'married', label: '結婚' },
    ],
    friendship: [
        { id: 'friend', label: '朋友' },
        { id: 'close', label: '摯友' },
        { id: 'familyLike', label: '家人式友情' },
    ],
    family: [{ id: 'kin', label: '親屬' }],
};

export const CUSTOM_STAGE = 'custom';

/** 這條路線能選的階段（最後一個永遠是自訂） */
export function stagesOf(route: BondRoute | undefined): BondStageDef[] {
    return [...STAGES[route || 'none'], { id: CUSTOM_STAGE, label: '自訂' }];
}

/** 路線的預設起始階段 */
export function defaultStage(route: BondRoute | undefined): string {
    return route === 'family' ? 'kin' : 'friend';
}

/** 換路線時，舊階段在新路線裡還有沒有；沒有就回新路線的預設 */
export function stageForRoute(route: BondRoute | undefined, stage: string): string {
    if (stage === CUSTOM_STAGE) return stage;
    return STAGES[route || 'none'].some(s => s.id === stage) ? stage : defaultStage(route);
}

/** 顯示用的階段名：自訂的用名稱，親情線有稱謂就用稱謂 */
export function stageLabel(bond: Pick<BondRecord, 'route' | 'stage' | 'stageLabel'>): string {
    if (bond.stage === CUSTOM_STAGE) return bond.stageLabel?.trim() || '自訂';
    if (bond.route === 'family' && bond.stageLabel?.trim()) return bond.stageLabel.trim();
    return [...STAGES[bond.route || 'none'], ...STAGES.romance, ...STAGES.friendship, ...STAGES.family]
        .find(s => s.id === bond.stage)?.label || '朋友';
}

/** 路線小標（清單、主視覺） */
export function routeLabel(route: BondRoute | undefined): string {
    return ROUTE_LABEL[route || 'none'];
}

/** 跟預設一樣（沒選路線、階段還是朋友、沒自訂名）：提示詞不帶任何東西 */
export function isDefaultBondState(bond: Pick<BondRecord, 'route' | 'stage' | 'stageLabel'> | undefined): boolean {
    if (!bond) return true;
    return !bond.route && bond.stage === 'friend' && !bond.stageLabel?.trim();
}

// ─── 從關係文字認路線（只建議，不自動設） ───

/** 戀愛字眼 → 對應階段。順序有意義：先比長的（未婚夫 比 夫 先） */
const ROMANCE_WORDS: Array<[RegExp, string]> = [
    [/未婚[夫妻]|婚約|fiancé|fiancee/i, 'engaged'],
    [/老公|老婆|丈夫|妻子|夫妻|夫婦|伴侶|配偶|太太|husband|wife|spouse/i, 'married'],
    [/戀人|情侶|男友|女友|男朋友|女朋友|交往|愛人|lover|boyfriend|girlfriend|dating/i, 'lovers'],
    [/曖昧|暗戀|喜歡的人|crush/i, 'ambiguous'],
];

/** 只收明確的親屬稱謂；「好兄弟」「好姐妹」「阿姨」這類常拿來叫朋友或路人的不收 */
const FAMILY_WORDS = /(哥哥|姐姐|姊姊|弟弟|妹妹|兄長|親兄弟|親姐妹|親姊妹|爸爸|媽媽|父親|母親|兒子|女兒|爺爺|奶奶|外公|外婆|祖父|祖母|孫子|孫女|親叔叔|舅舅|姑姑|伯伯|表哥|表姐|表姊|表弟|表妹|堂哥|堂姐|堂姊|堂弟|堂妹|雙胞胎)/;

/** 「先生」「對象」這種多義的字不收 */
function romanceStageIn(text: string): string | undefined {
    for (const [re, stage] of ROMANCE_WORDS) if (re.test(text)) return stage;
    return undefined;
}

/** 關係字串裡有沒有戀愛字眼（擋 [[ACTION:RELATIONSHIP]] 用） */
export function hasRomanceWords(text: string | undefined | null): boolean {
    return !!text && !!romanceStageIn(text);
}

export interface BondSuggestion {
    route: BondRoute;
    stage: string;
    /** 親情線的稱謂 */
    label?: string;
    /** 從哪句看出來的（卡片上寫） */
    from: string;
}

/**
 * 首頁的建議路線卡：看「你認為的關係」「角色認為的關係」和角色關係清單裡指向你的那條。
 * 只建議戀愛和親情；友情不建議（寫著「摯友」不代表要鎖純友情）。
 */
export function suggestBond(texts: Array<string | undefined | null>): BondSuggestion | null {
    for (const raw of texts) {
        const text = raw?.trim();
        if (!text) continue;
        const stage = romanceStageIn(text);
        if (stage) return { route: 'romance', stage, from: text };
    }
    for (const raw of texts) {
        const text = raw?.trim();
        if (!text) continue;
        const m = text.match(FAMILY_WORDS);
        if (m) return { route: 'family', stage: 'kin', label: m[1], from: text };
    }
    return null;
}

/** 天數的文案（相識那個起點照路線換說法） */
export function metDayLabel(route: BondRoute | undefined): string {
    if (route === 'family') return '一起長大';
    if (route === 'friendship') return '認識';
    return '相識';
}
