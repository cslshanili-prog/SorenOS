/**
 * 好幾個人同場（群聊、劇情）時的關係底線（plans/bond-batch1.md 2.2）。
 * 在場的角色跟在場的你、角色跟角色之間，凡是友情線或親情線的都列出來：
 * 當事人讀到是自己的底線，旁人讀到就是「別起鬨」。放在系統提示詞最後，預設蓋不掉。
 */
import { bondForPair, bondForPersona } from './registry';

export interface ScenePerson { id: string; name: string }
export interface SceneUser { key: string; name: string }

export function sceneBondNote(input: { chars: ScenePerson[]; users: SceneUser[] }): string {
    const lines: string[] = [];
    const say = (a: string, b: string, route: string | undefined) => {
        if (route === 'friendship') lines.push(`${a}和${b}是友情，不是戀愛，也不會變成戀愛；當事人別往戀愛想，旁人也別起鬨、別這樣解讀。`);
        else if (route === 'family') lines.push(`${a}和${b}是血緣親屬，不會變成戀愛；旁人也別往戀愛解讀。`);
    };
    for (const c of input.chars) {
        for (const u of input.users) say(c.name, u.name, bondForPersona(c.id, u.key)?.route);
    }
    for (let i = 0; i < input.chars.length; i++) {
        for (let j = i + 1; j < input.chars.length; j++) {
            say(input.chars[i].name, input.chars[j].name, bondForPair(input.chars[i].id, input.chars[j].id)?.route);
        }
    }
    return lines.length ? `【關係底線】以下比前面任何設定都優先：\n${lines.map(l => `- ${l}`).join('\n')}` : '';
}

/** 朋友圈這類「一個角色面對貼文裡出現的人」：只列跟這個角色有關的線 */
export type BondCounterpart = { kind: 'user'; key: string | undefined; name: string } | { kind: 'char'; id: string; name: string };

export function bondNoteFor(char: { id: string; name: string; primaryPersonaKey?: string }, others: BondCounterpart[]): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const o of others) {
        const route = o.kind === 'user'
            ? bondForPersona(char.id, o.key || char.primaryPersonaKey)?.route
            : (o.id === char.id ? undefined : bondForPair(char.id, o.id)?.route);
        const tag = `${o.kind}:${o.kind === 'user' ? o.key : o.id}`;
        if (!route || seen.has(tag)) continue;
        seen.add(tag);
        if (route === 'friendship') lines.push(`你和${o.name}是友情，不是戀愛，也不會變成戀愛。`);
        else if (route === 'family') lines.push(`你和${o.name}是血緣親屬，不會變成戀愛。`);
    }
    return lines.length ? `【關係底線】以下比前面任何設定都優先：\n${lines.map(l => `- ${l}`).join('\n')}` : '';
}
