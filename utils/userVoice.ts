/**
 * 你的聲音（plans/user-voice.md）：私聊裡你發的語音條。
 *
 * 訊息照舊是 `type: 'text'`，內容就是那句純文字，`metadata.userVoice` 標記它是語音條；
 * 不塞 `<語音>` 標籤（那是角色的輸出格式，混進你的訊息會被模型學走）。
 * 念的聲音是這條線那張身份卡的 voiceProfile，借角色當殼丟進同一套 TTS。
 */
import type { CharacterProfile, Message, UserProfile } from '../types';

export type UserVoiceVia = 'typed' | 'spoken';

export interface UserVoiceMeta {
    via: UserVoiceVia;
}

export const isUserVoiceMessage = (m: Pick<Message, 'role' | 'type' | 'metadata'> | null | undefined): boolean =>
    !!m && m.role === 'user' && m.type === 'text' && !!m.metadata?.userVoice;

export const userVoiceMeta = (via: UserVoiceVia): { userVoice: UserVoiceMeta } => ({ userVoice: { via } });

/**
 * TTS 三家都只讀 `char.voiceProfile`（加全域 Key／模型），所以把角色的 voiceProfile 換成你的就行。
 * 你沒設聲音就是 undefined，`canSynthesizeSpeech` 會擋下來，絕不借角色的聲音念你的話。
 */
export const userVoiceShell = (char: CharacterProfile, profile: Pick<UserProfile, 'name' | 'voiceProfile'>): CharacterProfile =>
    ({ ...char, name: profile.name || char.name, voiceProfile: profile.voiceProfile });

/** 角色看到的歷史寫法：一眼看得出你是用說的。 */
export const USER_VOICE_PREFIX = '[語音]';

export const formatUserVoiceContent = (content: string): string => {
    const text = (content || '').trim();
    return text ? `${USER_VOICE_PREFIX} ${text}` : USER_VOICE_PREFIX;
};

/** 語音條模式「說話辨識」的語言；辨識出來的字照這個語言（中文台灣出繁體）。 */
export const USER_VOICE_STT_LANGS: ReadonlyArray<{ code: string; label: string }> = [
    { code: 'zh-TW', label: '中文（台灣）' },
    { code: 'zh-CN', label: '中文（大陸）' },
    { code: 'yue-Hant-HK', label: '粵語' },
    { code: 'en-US', label: 'English' },
    { code: 'ja-JP', label: '日本語' },
    { code: 'ko-KR', label: '한국어' },
    { code: 'fr-FR', label: 'Français' },
];

const STT_LANG_KEY = 'soren_user_voice_stt_lang';

export const readUserVoiceSttLang = (): string => {
    try {
        const v = localStorage.getItem(STT_LANG_KEY);
        if (v && USER_VOICE_STT_LANGS.some(l => l.code === v)) return v;
    } catch { /* 無痕模式之類讀不到就用預設 */ }
    return 'zh-TW';
};

export const saveUserVoiceSttLang = (code: string): void => {
    try { localStorage.setItem(STT_LANG_KEY, code); } catch { /* 存不了就只記這次 */ }
};
