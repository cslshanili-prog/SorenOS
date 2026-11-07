/**
 * 資料庫第二批：角色知道手邊有哪些照片，也能原樣傳出去（plans/asset-library-design.md「角色怎麼用」）。
 *
 * - 私聊提示詞的易變段加一節「你手邊的照片」：分配給這個角色（含共用、照世界）而且**有描述**的照片，
 *   最近的 20 張，每張一個短編號＋描述（截到 60 字）。沒描述的不列——角色「知道」一張圖靠的就是描述
 * - 角色輸出 `[[ACTION:SEND_SAVED_PHOTO|編號]]` → chatParser 照編號找回那張圖，直接落一條圖片訊息
 *   （不重新生成、不花錢、臉不會飄）；編號對不上就不發、留日誌
 * - 編號從圖的 id 算出來（不是列表順序），提示詞和解析之間資料庫多了一張也對得上
 * - 雲端（fire_pack／即時對話）先不帶，worker 那邊接不住這個標籤
 */

import type { CharacterProfile, GalleryImage } from '../types';
import { canCharUseLibraryImage, librarySourceOf } from './library';

export const LIBRARY_PROMPT_LIMIT = 20;
export const LIBRARY_PROMPT_DESCRIPTION_MAX = 60;

export const SEND_SAVED_PHOTO_RE = /\[\[\s*ACTION\s*[:：]\s*SEND_SAVED_PHOTO\s*[|｜]\s*([^\]\n]*?)\s*\]\]/g;

/** 圖的短編號：id 的 FNV-1a 雜湊取 4 位 36 進位 */
export const libraryPhotoCode = (id: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash % 1679616).toString(36).padStart(4, '0');
};

const normalizeCode = (code: string) => code.trim().replace(/^[#＃]/, '').toLowerCase();

/** 這個角色手邊的照片：能用、有描述、最近的在前 */
export const pickCharLibraryPhotos = (
    images: GalleryImage[],
    char: Pick<CharacterProfile, 'id' | 'groupId'>,
    limit = LIBRARY_PROMPT_LIMIT,
): GalleryImage[] =>
    images
        .filter(image => (image.description || '').trim() && image.url && canCharUseLibraryImage(image, char))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);

/** 只對這個角色自己的那幾張說它從哪來；別的角色的私聊它不該知道 */
const sourceHint = (image: GalleryImage, charId: string): string => {
    if (image.charId !== charId) return '';
    switch (librarySourceOf(image)) {
        case 'chat_char': return '你之前傳過的';
        case 'chat_user': return '對方傳給你的';
        case 'date_moment': return '見面時拍的';
        default: return '';
    }
};

const clip = (text: string, max: number) => {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

export const buildLibraryPhotoBlock = (photos: GalleryImage[], charId: string, userName: string): string => {
    if (!photos.length) return '';
    const lines = photos.map(photo => {
        const hint = sourceHint(photo, charId);
        return `- ${libraryPhotoCode(photo.id)}｜${hint ? `${hint}｜` : ''}${clip(photo.description || '', LIBRARY_PROMPT_DESCRIPTION_MAX)}`;
    });
    return `\n### 你手邊的照片
（這些是你手機裡現有的照片，你知道每張拍的是什麼。想給${userName || '對方'}看哪張，就單獨起一行輸出 \`[[ACTION:SEND_SAVED_PHOTO|編號]]\`，那張照片會原樣傳過去，不用再描述畫面。聊到相關的事再自然地用，剛傳過的別重複傳。）
${lines.join('\n')}
`;
};

/** 照編號找回圖；只在這個角色能用的裡面找 */
export const resolveLibraryPhotoCode = (
    images: GalleryImage[],
    char: Pick<CharacterProfile, 'id' | 'groupId'>,
    code: string,
): GalleryImage | null => {
    const wanted = normalizeCode(code);
    if (!wanted) return null;
    return [...images]
        .sort((a, b) => b.timestamp - a.timestamp)
        .find(image => image.url && libraryPhotoCode(image.id) === wanted && canCharUseLibraryImage(image, char)) || null;
};
