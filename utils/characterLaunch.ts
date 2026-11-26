export interface CharacterLaunchIntent {
    charId?: string;
    openChibiStudio?: boolean;
    /** 直接停在主角或配角分頁 */
    tab?: 'characters' | 'supporting';
    /** 從角色名片進來的：編輯頁按返回直接回聊天（closeApp 會照 utils/appLaunch.ts 的 appReturn 走） */
    backToCaller?: boolean;
}

let pending: CharacterLaunchIntent | null = null;

export const characterLaunch = {
    request(intent: CharacterLaunchIntent): void {
        pending = intent;
    },
    peek(): CharacterLaunchIntent | null {
        return pending;
    },
    consume(): CharacterLaunchIntent | null {
        const value = pending;
        pending = null;
        return value;
    },
};
