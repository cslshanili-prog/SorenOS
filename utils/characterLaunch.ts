export interface CharacterLaunchIntent {
    charId?: string;
    openChibiStudio?: boolean;
    /** Chat 主页「联系人」tab 点 NPC 行时用：直接停在 NPC 分页，不必挑角色。 */
    tab?: 'characters' | 'npcs';
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
