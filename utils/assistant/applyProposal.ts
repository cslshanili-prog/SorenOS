/**
 * 提案卡片的「套用」「還原」（plans/ai-assistant.md 第 3 節）。
 * 套用前再檢查一次（資料可能變了）、記下那一刻的內容當快照，再寫；還原就是把快照寫回去。
 * 真的寫交給 write（畫面那頭接 updateTheme／updateCharacter／…），這裡不碰 React。
 */
import type { AssistantProposal } from '../../types';
import { buildCssWrite, type CssData, type CssWrite, cssTargetStillThere, findCssLocation, readLocationCss, validateLocationCss } from './cssLocations';

export type CssWriteFn = (write: CssWrite) => Promise<void> | void;

const locOf = (proposal: AssistantProposal) => {
    const loc = findCssLocation(proposal.location);
    if (!loc) throw new Error('這個位置已經不存在了');
    return loc;
};

export const applyCssProposal = async (proposal: AssistantProposal, data: CssData, write: CssWriteFn): Promise<AssistantProposal> => {
    const loc = locOf(proposal);
    if (!cssTargetStillThere(loc, proposal.targetId, data)) throw new Error('要改的角色或群已經不在了');
    if (proposal.css) {
        const errors = validateLocationCss(loc, proposal.css);
        if (errors.length) throw new Error(`檢查沒過：${errors[0]}`);
    }
    const existed = loc.target !== 'chatTheme' || data.customThemes.some(t => t.id === proposal.targetId);
    const snapshot = { css: existed ? readLocationCss(loc, proposal.targetId, data) : '', existed, at: Date.now() };
    const newTheme = proposal.newThemeName ? { id: proposal.targetId, name: proposal.newThemeName } : undefined;
    await write(buildCssWrite(loc, proposal.targetId, proposal.css, data, newTheme));
    return { ...proposal, status: 'applied', snapshot, appliedAt: Date.now() };
};

/** 套用之後用戶自己又改過（還原會把那些改動也蓋掉，畫面要先問） */
export const changedSinceApply = (proposal: AssistantProposal, data: CssData): boolean => {
    const loc = findCssLocation(proposal.location);
    if (!loc || proposal.status !== 'applied') return false;
    if (loc.target === 'chatTheme' && !data.customThemes.some(t => t.id === proposal.targetId)) return true;
    return readLocationCss(loc, proposal.targetId, data).trim() !== proposal.css.trim();
};

export const restoreCssProposal = async (proposal: AssistantProposal, data: CssData, write: CssWriteFn): Promise<AssistantProposal> => {
    const loc = locOf(proposal);
    if (!proposal.snapshot) throw new Error('這張卡片沒有快照，沒辦法還原');
    if (!proposal.snapshot.existed) {
        if (loc.target === 'chatTheme' && data.customThemes.some(t => t.id === proposal.targetId)) {
            await write({ kind: 'removeChatTheme', id: proposal.targetId });
        }
    } else {
        if (!cssTargetStillThere(loc, proposal.targetId, data)) throw new Error('要還原的角色或群已經不在了');
        await write(buildCssWrite(loc, proposal.targetId, proposal.snapshot.css, data));
    }
    return { ...proposal, status: 'restored' };
};
