/**
 * 提案卡片的預覽（plans/ai-assistant.md 第 4 節第 2 批）：用協同工作那套假資料頁（buildInstallablePreviewDocument），
 * 套上新的或原本的 CSS，放進沙盒 iframe。見面沒有假資料頁，不給預覽（套用後去見面看，不滿意還原）。
 * 角色／群的白框疊在全域白框上面，預覽也照這個順序疊，看起來才跟實際一樣。
 * 預覽頁的 CSP 只收 data: 圖片，背景用網址圖片的在預覽裡看不到。
 */
import type { AssistantProposal } from '../../types';
import { buildInstallablePreviewDocument } from '../../features/collaboration/makers';
import type { CollaborationInstallableArtifact } from '../../features/collaboration/types';
import { type CssData, findCssLocation, NEW_THEME_SIDES, readLocationCss } from './cssLocations';

const ARTIFACT_KIND: Record<string, CollaborationInstallableArtifact['kind'] | undefined> = {
    chat_chrome_global: 'whitebox-css',
    chat_chrome_char: 'whitebox-css',
    chat_chrome_group: 'whitebox-css',
    bubble_theme: 'bubble-theme',
    journal: 'journal-css',
    schedule: 'schedule-css',
    thinking_chain: 'psyche-css',
};

export const canPreviewProposal = (proposal: AssistantProposal) => !!ARTIFACT_KIND[proposal.location];

/** which：看新的還是原本的 */
export const buildProposalPreview = (proposal: AssistantProposal, data: CssData, which: 'after' | 'before'): string | null => {
    const kind = ARTIFACT_KIND[proposal.location];
    const loc = findCssLocation(proposal.location);
    if (!kind || !loc) return null;
    let css = which === 'after' ? proposal.css : proposal.before;
    if (proposal.location === 'chat_chrome_char' || proposal.location === 'chat_chrome_group') {
        const global = readLocationCss(findCssLocation('chat_chrome_global')!, '', data);
        css = [global, css].filter(Boolean).join('\n');
    }
    if (kind === 'bubble-theme') {
        const theme = data.customThemes.find(t => t.id === proposal.targetId);
        return buildInstallablePreviewDocument({
            kind, title: proposal.targetLabel,
            payload: { user: theme?.user || NEW_THEME_SIDES.user, ai: theme?.ai || NEW_THEME_SIDES.ai, customCss: css },
        });
    }
    return buildInstallablePreviewDocument({ kind, title: proposal.targetLabel, payload: { css } });
};
