/**
 * NPC 搬成配角：會寫資料庫的那一半（純邏輯在 utils/npcMigration.ts）。
 * OSContext 在關係線預覽開著、資料載入完、還有沒搬的 NPC 時跑一次。
 */
import type { CharacterProfile, GroupProfile, NPCProfile, UserProfile } from '../types';
import { DB } from './db';
import { migrateContacts, migrateGroup, migrateMomentPost, migrateTheater, npcToCharacter, pendingNpcs } from './npcMigration';

export interface NpcMigrationResult {
    /** 新建的配角 */
    added: CharacterProfile[];
    /** 通訊錄被改過的既有角色（整份新的） */
    updatedChars: CharacterProfile[];
    /** 改過的群 */
    groups: GroupProfile[];
    /** 標好 migratedToCharAt 的 NPC（整份） */
    npcs: NPCProfile[];
    movedIds: string[];
}

export async function runNpcMigration(args: {
    npcs: NPCProfile[];
    characters: CharacterProfile[];
    profileBase: UserProfile;
    groups: GroupProfile[];
    now?: number;
}): Promise<NpcMigrationResult> {
    const now = args.now ?? Date.now();
    const pending = pendingNpcs(args.npcs);
    const charIds = new Set(args.characters.map(c => c.id));
    // id 已經有同名角色（例如之前搬到一半）：那筆當成搬過了，不再建第二個
    const toCreate = pending.filter(n => !charIds.has(n.id));
    const movedIds = new Set(pending.map(n => n.id));

    const added = toCreate.map(n => npcToCharacter(n, args.profileBase, args.characters));
    for (const c of added) await DB.saveCharacter(c);

    const groups: GroupProfile[] = [];
    for (const g of args.groups) {
        const next = migrateGroup(g, movedIds);
        if (next) { await DB.saveGroup(next); groups.push(next); }
    }

    const updatedChars: CharacterProfile[] = [];
    for (const c of [...args.characters, ...added]) {
        const contacts = migrateContacts(c.phoneState?.contacts, movedIds);
        if (!contacts) continue;
        const next = { ...c, phoneState: { ...c.phoneState, records: c.phoneState?.records || [], contacts } } as CharacterProfile;
        await DB.saveCharacter(next);
        updatedChars.push(next);
    }

    try {
        const posts = await DB.getAllMomentPosts();
        const changed = posts.map(p => migrateMomentPost(p, movedIds)).filter((p): p is NonNullable<typeof p> => !!p);
        if (changed.length) await DB.saveMomentPosts(changed);
    } catch (e) { console.warn('[NPC 搬家] 朋友圈改寫失敗（不影響其他）', e); }

    try {
        const theaters = await DB.getStoryTheaters();
        for (const t of theaters) {
            const next = migrateTheater(t, movedIds);
            if (next) await DB.saveStoryTheater(next);
        }
    } catch (e) { console.warn('[NPC 搬家] 劇情劇場改寫失敗（不影響其他）', e); }

    const npcs = args.npcs.map(n => (movedIds.has(n.id) ? { ...n, migratedToCharAt: now } : n));
    for (const n of npcs) if (movedIds.has(n.id)) await DB.saveNPC(n);

    return { added, updatedChars, groups, npcs, movedIds: [...movedIds] };
}
