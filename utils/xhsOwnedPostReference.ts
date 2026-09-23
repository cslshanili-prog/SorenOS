import type { XhsOwnedPost } from '../types';

const compact = (value: unknown): string => String(value || '')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');

const meaningfulChunks = (value: string): string[] => {
    const normalized = compact(value);
    const chunks = new Set<string>();
    for (let size = Math.min(6, normalized.length); size >= 2; size--) {
        for (let index = 0; index + size <= normalized.length; index++) {
            chunks.add(normalized.slice(index, index + size));
        }
        if (chunks.size >= 80) break;
    }
    return [...chunks];
};

const RECENT_REFERENCE_RE = /([刚剛]才|[刚剛][刚剛]|[刚剛][发發]|[刚剛][写寫]|上一[个個]|上一[条條]|最近|那[个個]帖子|那篇帖子|那[条條][笔筆][记記])/;

/**
 * 從大量角色帖子裡選出最值得放進本輪提示詞的少量候選。
 * ID 仍由代碼持有；模型只看經過排序的候選，不需要背下整個主頁。
 */
export const selectOwnedPostsForReference = (
    posts: XhsOwnedPost[],
    referenceText: string,
    limit = 8,
): XhsOwnedPost[] => {
    const chronological = [...posts].sort((a, b) => b.publishedAt - a.publishedAt);
    const reference = compact(referenceText);
    const wantsRecent = RECENT_REFERENCE_RE.test(referenceText);

    return chronological
        .map((post, index) => {
            const title = compact(post.title);
            const body = compact(post.body);
            let score = Math.max(0, 100 - index);
            if (title && reference.includes(title)) score += 10_000;
            if (body && body.length <= 80 && reference.includes(body)) score += 5_000;
            for (const tag of post.tags || []) {
                const normalizedTag = compact(tag);
                if (normalizedTag && reference.includes(normalizedTag)) score += 800;
            }
            const titleMatches = meaningfulChunks(post.title)
                .filter(chunk => reference.includes(chunk));
            if (titleMatches.length > 0) {
                score += Math.max(...titleMatches.map(chunk => chunk.length)) * 120;
            }
            if (wantsRecent) score += Math.max(0, 2_000 - index * 200);
            return { post, score, index };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, Math.max(1, limit))
        .map(item => item.post);
};
