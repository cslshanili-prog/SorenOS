import type { CharacterProfile, NPCProfile, PhoneContact } from '../types';
import { USER_ID } from './momentsPool';

/**
 * 朋友圈批次留言用的「這個人怎麼說話」片段，和「跟發文的人什麼關係」。
 *
 * 以前只拿角色說明（沒有就系統設定）的前 180 字：說明常常是給用戶看的一句話，系統設定開頭多半是世界觀，
 * 高冷、話少這種關鍵特質常常不在裡面，模型就照一般人的熱情寫——這是朋友圈 OOC 的主因。
 * 現在優先挑講個性、說話方式的句子。等之後有「精簡人設」欄位，這裡改成優先用它。
 */

export const VOICE_SNIPPET_MAX = 320;

/** 講個性、說話方式、話量的字眼 */
const VOICE_KEYWORDS = /(性格|個性|性情|脾氣|說話|講話|語氣|口吻|口頭禪|話少|話多|寡言|沉默|高冷|冷淡|冷漠|毒舌|傲嬌|溫柔|開朗|活潑|內向|外向|慵懶|懶得|不愛|不廢話|簡短|淡漠|嘴硬|害羞|personality|speech|tone|talks?\b|quiet|cold|reserved)/i;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** 從長設定裡挑出講個性和說話方式的句子；一句都沒有就退回開頭。 */
export function voiceSnippet(parts: Array<string | undefined>, max: number = VOICE_SNIPPET_MAX): string {
    const source = parts.filter((p): p is string => !!p?.trim()).join('\n');
    if (!source.trim()) return '';
    // 不用 lookbehind 切句（舊版 iOS Safari 不支援，見 noLookbehind 守衛）：先在句尾標點後插分隔符再切
    const sentences = source.replace(/([。！？!?；;\n])/g, '$1\u0000').split('\u0000').map(squash).filter(Boolean);
    const picked: string[] = [];
    let length = 0;
    for (const sentence of sentences) {
        if (!VOICE_KEYWORDS.test(sentence)) continue;
        if (length + sentence.length > max && picked.length) break;
        picked.push(sentence);
        length += sentence.length;
    }
    return picked.length ? clip(picked.join(' '), max) : clip(squash(source), Math.min(max, 200));
}

export const characterVoice = (char: Pick<CharacterProfile, 'description' | 'systemPrompt'>): string =>
    voiceSnippet([char.systemPrompt, char.description]);

export const npcVoice = (npc: Pick<NPCProfile, 'description'>): string => voiceSnippet([npc.description]);

type RelChar = Pick<CharacterProfile, 'id' | 'charViewRelationship'> & { phoneState?: { contacts?: PhoneContact[] } };
type RelNpc = Pick<NPCProfile, 'id' | 'relationships'>;

/** 留言的人跟發文的人什麼關係（一句話；不知道就空字串）。 */
export function relationToAuthor(params: {
    commenterId: string;
    authorId: string | undefined;
    characters: RelChar[];
    npcs: RelNpc[];
}): string {
    const { commenterId, authorId, characters, npcs } = params;
    if (!authorId) return '';
    const npc = npcs.find(n => n.id === commenterId);
    if (npc) return npc.relationships.find(r => r.targetId === authorId)?.description?.trim() || '';
    const char = characters.find(c => c.id === commenterId);
    if (!char) return '';
    if (authorId === USER_ID) return char.charViewRelationship?.trim() || '';
    const contact = (char.phoneState?.contacts || []).find(c => c.linkedCharId === authorId || c.linkedNpcId === authorId);
    return [contact?.identity, contact?.note].map(s => s?.trim()).filter(Boolean).join('，');
}

/** 所有朋友圈回話共用的話量守則：高冷的人不會突然笑場。 */
export const MOMENTS_VOICE_RULE = '照這個人的性格決定話量：話少、高冷、懶得理人的，一兩個字或乾脆不留；不要為了熱鬧硬擠「哈哈哈」、一連串笑聲或驚嘆號，除非這個人本來就是這樣說話。';
