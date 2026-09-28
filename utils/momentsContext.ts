import type { CharacterProfile, GroupProfile, MomentPost, NPCProfile, PhoneContact, UserProfile } from '../types';
import { DB } from './db';
import { actorDisplayName, buildFriendGraph, momentFeedFor, visibleComments, visibleLikes, type FriendGraph } from './momentsPool';
import { buildPersonaKnowledge } from './momentsPersona';
import { distinctPersonaNote } from './personaSpeaker';

/**
 * 私聊 prompt 的「最近的朋友圈」（路線圖第 6 項第二批）：角色看得到的最近幾篇，加上它自己在上面的互動，
 * 讓角色聊天時接得上「你昨天發的那張照片」。放在易變段；主動消息雲端打包（fire_pack）不帶。
 *
 * chatPrompts 位於 utils 層、拿不到 OSContext 的角色／NPC 清單（朋友關係要用），
 * 由 OSContext 在清單變化時登記到這裡——跟 utils/charNameRegistry.ts 同一個做法。
 */

type GraphChar = Pick<CharacterProfile, 'id' | 'name' | 'chatBlock' | 'groupId'> & { phoneState?: { contacts?: PhoneContact[] } };
type GraphNpc = Pick<NPCProfile, 'id' | 'name' | 'relationships' | 'knownPersonaId'>;

let registered: { characters: GraphChar[]; npcs: GraphNpc[]; graph: FriendGraph } | null = null;

export function setMomentsGraphInputs(
    characters: GraphChar[],
    npcs: GraphNpc[],
    personas?: { profileBase: UserProfile; groups: Array<Pick<GroupProfile, 'id' | 'members'>> },
): void {
    const slimChars = characters.map(c => ({ id: c.id, name: c.name, groupId: c.groupId, chatBlock: c.chatBlock, phoneState: { contacts: c.phoneState?.contacts } }));
    const slimNpcs = npcs.map(n => ({ id: n.id, name: n.name, relationships: n.relationships, knownPersonaId: n.knownPersonaId }));
    const knowledge = personas ? buildPersonaKnowledge(personas.profileBase, slimChars, personas.groups, slimNpcs) : undefined;
    registered = { characters: slimChars, npcs: slimNpcs, graph: buildFriendGraph(slimChars, slimNpcs, knowledge) };
}

export const MOMENTS_CONTEXT_WINDOW_MS = 3 * 24 * 3600_000;
export const MOMENTS_CONTEXT_MAX_POSTS = 5;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const stamp = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 純函數：把角色看得到的最近幾篇整理成一段提示詞；沒有就回空字串。 */
export function buildMomentsContextForChar(params: {
    charId: string;
    posts: MomentPost[];
    characters: GraphChar[];
    npcs: GraphNpc[];
    graph: FriendGraph;
    userName: string;
    now: number;
}): string {
    const { charId, posts, characters, npcs, graph, userName, now } = params;
    const recent = momentFeedFor(charId, posts, graph)
        .filter(p => now - p.createdAt <= MOMENTS_CONTEXT_WINDOW_MS)
        .slice(0, MOMENTS_CONTEXT_MAX_POSTS);
    if (recent.length === 0) return '';
    // 你用別的身份出現的（公開貼文、或留在它貼文底下的言）：用那張卡的名字，最後提醒那是另一個人
    const otherPersonaNames: string[] = [];
    const nameOf = (actor: MomentPost['author']) => {
        if (actor.id === charId) return '你';
        const name = actorDisplayName(actor, characters, npcs, userName, graph);
        if (actor.kind === 'user' && graph.personaRelation && graph.personaRelation(charId, actor.personaKey) !== 'main') otherPersonaNames.push(name);
        return name;
    };
    const lines = recent.map(p => {
        const who = p.author.id === charId ? '你發的' : `${nameOf(p.author)}發的`;
        const photos = p.images.length ? `（${p.images.length} 張照片）` : '';
        const likes = visibleLikes(charId, p, graph).map(l => nameOf(l.actor));
        const comments = visibleComments(charId, p, graph).slice(-3).map(c => `${nameOf(c.actor)}：${clip(c.content, 40)}`);
        const extra = [
            likes.length ? `讚：${likes.join('、')}` : '',
            comments.length ? `留言：${comments.join('／')}` : '',
        ].filter(Boolean).join('；');
        return `- [${stamp(p.createdAt)}] ${who}${photos}：「${clip(p.content || '（只有照片）', 80)}」${extra ? `（${extra}）` : ''}`;
    });
    const personaNote = distinctPersonaNote(otherPersonaNames, userName, '朋友圈裡');
    return `\n### 【最近的朋友圈】\n（你滑朋友圈看到的最近幾篇，還有大家在上面的互動，「你」就是你自己。聊天時自然想得起來就好，不用主動逐條提起。）${personaNote ? `\n${personaNote}` : ''}\n${lines.join('\n')}\n`;
}

/** chatPrompts 用：讀池子、套登記的朋友關係。還沒登記（例如測試環境）就回空字串。 */
export async function getMomentsContextForChar(charId: string, userName: string): Promise<string> {
    if (!registered) return '';
    const posts = await DB.getAllMomentPosts();
    if (posts.length === 0) return '';
    return buildMomentsContextForChar({ charId, posts, ...registered, userName, now: Date.now() });
}
