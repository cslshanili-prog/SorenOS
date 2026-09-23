export interface CharacterLaunchIntent {
    charId?: string;
    openChibiStudio?: boolean;
    /** Chat 主頁「聯繫人」tab 點 NPC 行時用：直接停在 NPC 分頁，不必挑角色。 */
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
