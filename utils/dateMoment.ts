/**
 * 見面「拍下這一刻」（plans/offline-date-redesign.md 第 4 項）。
 *
 * 1. 對話模型讀最近幾輪劇情，寫一段「此刻這一幕」的畫面描述（人物一＝角色、人物二＝你，不寫名字：生圖模型看不懂名字）
 * 2. 拼上角色的人物特徵（imageGenCharConfig）和你這張身份卡的外觀（UserProfile.imageGenConfig）
 * 3. 兩張參考圖一起送（第一張角色、第二張你）；這家不收多張就只鎖角色，再不行純文字（utils/imageGeneration.ts）
 * 結果存進見面記錄（插在這一輪後面）和相簿（origin: 'date_moment'）。只有用戶自己按，角色不會主動拍。
 */

import type { CharacterProfile, DateStory, ImageGenApiConfig, Message, UserProfile } from '../types';
import type { ApiMessage } from './datePrompts';
import { formatDateTranscript, storyMessages, callDateSummaryLLM, type DateSummaryApi } from './dateSummary';
import { generateImage, resolveCharacterReferenceImage } from './imageGeneration';

/** 生圖總開關開著、API 填好了才能拍 */
export const canCaptureDateMoment = (config: ImageGenApiConfig | undefined): config is ImageGenApiConfig =>
    !!(config?.charImageGenEnabled && config?.baseUrl && config?.model);

/** 讀最近幾則就夠（畫的是「此刻」） */
export const MOMENT_CONTEXT_MESSAGES = 8;

export const buildMomentSceneMessages = (input: {
    charName: string;
    userName: string;
    scenario?: string;
    /** 故事裡此刻的時間（有設時間模式才給），讓光線對得上 */
    timeText?: string;
    messages: Message[];
}): ApiMessage[] => [
    {
        role: 'system',
        content: [
            `你是一位攝影師，替一場線下故事拍下「此刻」這一幕。畫面裡有兩個人：人物一是${input.charName}，人物二是${input.userName || '對方'}。`,
            input.scenario?.trim() ? `故事大綱：${input.scenario.trim()}` : '',
            input.timeText ? `故事裡現在是：${input.timeText}` : '',
            '根據最近的劇情，用一段話（80–200 字）寫出這張照片的畫面，給生圖模型看：地點、光線和天氣、兩人的位置、姿勢、動作和表情、劇情裡提到的穿著、鏡頭的距離和角度。',
            '兩個人都要在畫面裡。用「人物一」「人物二」稱呼，不要寫名字；不要寫長相細節（另外會給）；畫面裡不要出現文字或對話框。只輸出畫面描述本身。',
        ].filter(Boolean).join('\n'),
    },
    { role: 'user', content: `最近的劇情：\n\n${formatDateTranscript(input.messages, input.charName, input.userName)}` },
];

const genderWord = (gender?: string) => (gender === '男' ? '男性' : gender === '女' ? '女性' : '');

/** 畫面描述＋兩個人的長相 → 生圖提示詞 */
export const buildMomentImagePrompt = (input: {
    scene: string;
    charAppearance?: string;
    userAppearance?: string;
    userGender?: string;
    /** 哪幾個人有參考圖（照角色、你的順序送）：寫清楚誰對哪一張，免得只有一張時被套到兩個人臉上 */
    refs?: { char: boolean; user: boolean };
}): string => {
    const refs = input.refs ?? { char: false, user: false };
    const charRefNo = refs.char ? 1 : 0;
    const userRefNo = refs.user ? (refs.char ? 2 : 1) : 0;
    const refNote = (no: number) => (no ? `長相照第 ${no} 張參考圖` : '');
    const lines = [
        input.scene.trim(),
        `人物一：${[input.charAppearance?.trim(), refNote(charRefNo)].filter(Boolean).join('；') || '照劇情自然發揮'}`,
        `人物二：${[genderWord(input.userGender), input.userAppearance?.trim(), refNote(userRefNo)].filter(Boolean).join('；') || '照劇情自然發揮'}`,
        refs.char !== refs.user ? `只有${refs.char ? '人物一' : '人物二'}有參考圖，另一個人別套用它的長相。` : '',
        '風格：像當下隨手拍下的一張照片，構圖自然，畫面裡沒有文字。',
    ];
    return lines.filter(Boolean).join('\n');
};

export type MomentLock = 'both' | 'char' | 'user' | 'none';

export const describeMomentLock = (lock: MomentLock | undefined, error?: string): string => {
    switch (lock) {
        case 'both': return '兩張臉都鎖了';
        case 'char': return error ? '只鎖了角色的臉（生圖服務不收兩張參考圖）' : '只鎖了角色的臉';
        case 'user': return '只鎖了你的臉';
        case 'none': return error ? '沒鎖臉（參考圖沒送成）' : '沒鎖臉（沒設參考圖）';
        default: return '';
    }
};

export interface DateMomentResult {
    dataUrl: string;
    scene: string;
    prompt: string;
    lock: MomentLock;
    lockError?: string;
}

/** 拍一張。回傳圖和要記下來的東西；存不存由呼叫的人決定 */
export const captureDateMoment = async (input: {
    char: CharacterProfile;
    /** 這個角色眼中的你（resolveUserProfileForChar） */
    user: UserProfile;
    story: DateStory | null;
    /** 角色的見面訊息 */
    messages: Message[];
    chatApi: DateSummaryApi;
    imageConfig: ImageGenApiConfig;
    timeText?: string;
    fetchImpl?: typeof fetch;
}): Promise<DateMomentResult> => {
    const recent = (input.story ? storyMessages(input.messages, input.story) : input.messages.filter(m => m.metadata?.source === 'date' && (m.type || 'text') === 'text'))
        .slice(-MOMENT_CONTEXT_MESSAGES);
    if (!recent.length) throw new Error('還沒有劇情可以拍');
    const scene = await callDateSummaryLLM(input.chatApi, buildMomentSceneMessages({
        charName: input.char.name,
        userName: input.user.name,
        scenario: input.story?.scenario,
        timeText: input.timeText,
        messages: recent,
    }), input.fetchImpl);
    // 合照一定有人，參考圖照送（不看「非自拍不帶參考圖」那個開關）
    const charRef = await resolveCharacterReferenceImage(input.char, { forceReference: true });
    const userRef = await resolveCharacterReferenceImage({ imageGenCharConfig: input.user.imageGenConfig }, { forceReference: true });
    const prompt = buildMomentImagePrompt({
        scene,
        charAppearance: input.char.imageGenCharConfig?.characterPrompt,
        userAppearance: input.user.imageGenConfig?.characterPrompt,
        userGender: input.user.gender,
        refs: { char: !!charRef, user: !!userRef },
    });
    const refs = [charRef, userRef].filter((blob): blob is Blob => !!blob);
    const result = await generateImage(input.imageConfig, prompt, refs.length ? refs : undefined);
    let lock: MomentLock = 'none';
    if (result.referenceUsed) {
        if (charRef && userRef) lock = (result.referenceCount ?? 1) >= 2 ? 'both' : 'char';
        else lock = charRef ? 'char' : 'user';
    }
    return { dataUrl: result.dataUrl, scene, prompt, lock, ...(result.referenceError ? { lockError: result.referenceError } : {}) };
};
