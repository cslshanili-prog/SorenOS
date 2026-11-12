/**
 * 資料庫第三批：在資料庫裡直接生成照片（plans/asset-library-design.md「畫面」）。
 *
 * - 四種：獨照（一個人）、合照（兩個人以上）、物品、風景
 * - 有人的照片：每個人拼上自己的長相提示詞（角色的 imageGenCharConfig、你那張身份卡的 imageGenConfig），
 *   有參考圖的照順序一起送（utils/imageGeneration.ts 的多張參考圖；這家不收多張就只鎖第一張，再不行純文字）
 * - 物品、風景不帶參考圖，提示詞寫明畫面裡沒有人
 * 結果先給預覽，存不存由畫面決定；存的是 origin: 'generated'。
 */

import type { CharacterProfile, ImageGenApiConfig, LibraryAccess, LibraryGenKind, UserProfile } from '../types';
import { isImageFeatureOff } from './imageStyle';
import { generateImage, resolveCharacterReferenceImage } from './imageGeneration';

export const LIBRARY_GEN_KINDS: { kind: LibraryGenKind; label: string; placeholder: string }[] = [
    { kind: 'solo', label: '獨照', placeholder: '例：午後在咖啡廳窗邊看書，陽光斜斜照進來，側臉' },
    { kind: 'group', label: '合照', placeholder: '例：傍晚在海邊並肩坐著，看向鏡頭笑，風把頭髮吹亂' },
    { kind: 'object', label: '物品', placeholder: '例：木桌上一杯拿鐵和一本翻開的書，旁邊有一副眼鏡' },
    { kind: 'scenery', label: '風景', placeholder: '例：雨後的城市夜景，街燈倒映在積水裡' },
];

export const LIBRARY_GEN_PROMPT_MAX = 800;

/** 照片裡的一個人：角色或你 */
export type LibraryGenSubject =
    | { type: 'char'; char: CharacterProfile }
    | { type: 'user'; profile: UserProfile };

export const subjectKey = (subject: LibraryGenSubject) => (subject.type === 'char' ? subject.char.id : 'user');

const genderWord = (gender?: string) => (gender === '男' ? '男性' : gender === '女' ? '女性' : '');
const NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八'];
const personLabel = (index: number) => `人物${NUMBERS[index] ?? index + 1}`;

export const isPeopleKind = (kind: LibraryGenKind) => kind === 'solo' || kind === 'group';

/** 人數合不合這個類型 */
export const libraryGenSubjectError = (kind: LibraryGenKind, count: number): string | null => {
    if (kind === 'solo' && count !== 1) return '獨照選一個人';
    if (kind === 'group' && count < 2) return '合照至少選兩個人';
    if (kind === 'group' && count > NUMBERS.length) return `合照最多 ${NUMBERS.length} 個人`;
    return null;
};

/** 描述＋每個人的長相 → 生圖提示詞 */
export const buildLibraryImagePrompt = (input: {
    kind: LibraryGenKind;
    prompt: string;
    /** 照片裡的人，照參考圖送的順序 */
    people?: { appearance?: string; gender?: string; hasRef: boolean }[];
}): string => {
    const scene = input.prompt.trim();
    if (input.kind === 'object') return [scene, '類型：物品照，主體清楚，畫面裡沒有人，也沒有文字。'].join('\n');
    if (input.kind === 'scenery') return [scene, '類型：風景照，畫面裡沒有人，也沒有文字。'].join('\n');
    const people = input.people || [];
    let refNo = 0;
    const lines = people.map((person, index) => {
        const ref = person.hasRef ? `長相照第 ${++refNo} 張參考圖` : '';
        const detail = [genderWord(person.gender), person.appearance?.trim(), ref].filter(Boolean).join('；');
        return `${personLabel(index)}：${detail || '自然發揮'}`;
    });
    const withRef = people.filter(person => person.hasRef).length;
    return [
        scene,
        people.length > 1 ? `畫面裡有 ${people.length} 個人，每個人都要在畫面裡：` : '',
        ...lines,
        withRef > 0 && withRef < people.length ? '沒寫參考圖的人別套用參考圖的長相。' : '',
        '風格：像一張真實拍下的照片，構圖自然，畫面裡沒有文字。',
    ].filter(Boolean).join('\n');
};

/** 預設給誰用：有角色的給那幾個角色，物品風景大家共用 */
export const defaultLibraryGenAccess = (kind: LibraryGenKind, subjects: LibraryGenSubject[]): LibraryAccess => {
    const charIds = subjects.filter((s): s is Extract<LibraryGenSubject, { type: 'char' }> => s.type === 'char').map(s => s.char.id);
    return isPeopleKind(kind) && charIds.length ? { mode: 'chars', charIds } : { mode: 'all' };
};

export const describeLibraryGenLock = (locked: number, wanted: number, error?: string, people = wanted): string => {
    if (!wanted) return '沒鎖臉（沒有參考圖）';
    if (locked >= wanted) {
        if (people > wanted) return `鎖了 ${wanted} 張臉（另外 ${people - wanted} 個人沒參考圖）`;
        return wanted === 1 ? '鎖了臉' : `${wanted} 張臉都鎖了`;
    }
    if (!locked) return error ? '沒鎖臉（參考圖沒送成）' : '沒鎖臉';
    return `只鎖了 ${locked} 張臉（生圖服務不收多張參考圖）`;
};

export const canGenerateInLibrary = (config: ImageGenApiConfig | undefined): config is ImageGenApiConfig =>
    !!(config?.baseUrl?.trim() && config?.model?.trim()) && !isImageFeatureOff(config, 'library');

export interface LibraryGenResult {
    /** 畫風偏好的那組 API 失敗、改用全域那組 */
    apiFallbackFrom?: string;
    dataUrl: string;
    prompt: string;
    /** 想鎖幾張、實際鎖了幾張 */
    wantedLocks: number;
    lockedCount: number;
    /** 照片裡有幾個人 */
    peopleCount: number;
    lockError?: string;
}

export const generateLibraryImage = async (input: {
    kind: LibraryGenKind;
    prompt: string;
    subjects: LibraryGenSubject[];
    imageConfig: ImageGenApiConfig;
    /** 這一次的畫風（臨時下拉）；不給照「各處畫風」的資料庫那格、再跟全域 */
    styleId?: string;
}): Promise<LibraryGenResult> => {
    const people = isPeopleKind(input.kind) ? input.subjects : [];
    const subjectError = isPeopleKind(input.kind) ? libraryGenSubjectError(input.kind, people.length) : null;
    if (subjectError) throw new Error(subjectError);
    if (!input.prompt.trim()) throw new Error('先寫想拍什麼');
    // 人一定在畫面裡，參考圖照送（不看「非自拍不帶參考圖」那個開關）
    const refs = await Promise.all(people.map(subject => resolveCharacterReferenceImage(
        subject.type === 'char' ? subject.char : { imageGenCharConfig: subject.profile.imageGenConfig },
        { forceReference: true },
    )));
    const prompt = buildLibraryImagePrompt({
        kind: input.kind,
        prompt: input.prompt,
        people: people.map((subject, index) => ({
            appearance: subject.type === 'char' ? subject.char.imageGenCharConfig?.characterPrompt : subject.profile.imageGenConfig?.characterPrompt,
            gender: subject.type === 'user' ? subject.profile.gender : undefined,
            hasRef: !!refs[index],
        })),
    });
    const blobs = refs.filter((blob): blob is Blob => !!blob);
    const result = await generateImage(input.imageConfig, prompt, blobs.length ? (blobs.length === 1 ? blobs[0] : blobs) : undefined, { feature: 'library', styleId: input.styleId, hasPerson: people.length > 0 });
    const lockedCount = result.referenceUsed ? Math.min(blobs.length, result.referenceCount ?? 1) : 0;
    return {
        dataUrl: result.dataUrl,
        prompt,
        wantedLocks: blobs.length,
        lockedCount,
        peopleCount: people.length,
        ...(result.referenceError ? { lockError: result.referenceError } : {}),
        ...(result.apiFallbackFrom ? { apiFallbackFrom: result.apiFallbackFrom } : {}),
    };
};
