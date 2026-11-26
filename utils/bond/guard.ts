/**
 * 擋 AI 改路線（plans/bond-batch1.md 2.3）：角色用 [[ACTION:RELATIONSHIP|…]] 改「角色認為的關係」時，
 * 這條線是友情或親情、新的說法又帶戀愛字眼 → 不生效。其他情況照舊。
 */
import type { CharacterProfile } from '../../types';
import { bondForChar } from './registry';
import { hasRomanceWords } from './routes';

export function relationshipChangeBlocked(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>, relationship: string): boolean {
    const route = bondForChar(char)?.route;
    if (route !== 'friendship' && route !== 'family') return false;
    if (!hasRomanceWords(relationship)) return false;
    console.info(`[羈絆] 「${relationship}」帶戀愛字眼，這條線是${route === 'friendship' ? '友情' : '親情'}路線，不改`);
    return true;
}
