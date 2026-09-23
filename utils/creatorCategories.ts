// 捏人器類目清單——與 character_creator.html 裡 PARTS 的 key 一一對應。
// dev 面板（CharCreatorDevApp）與用戶面板（CreatorPartsUploader / 手辦櫃）共用，避免各寫一份漂移。
export interface CreatorCategory {
    key: string;
    label: string;
    /** 可多選類目（面紋 / 配飾），僅影響提示，不影響導入 */
    multi?: boolean;
}

export const CC_CATEGORIES: CreatorCategory[] = [
    { key: 'skin', label: '膚色' },
    { key: 'eyes', label: '眼睛' },
    { key: 'mouth', label: '嘴' },
    { key: 'fronthair', label: '前發' },
    { key: 'earhair', label: '耳發' },
    { key: 'back1', label: '後發1' },
    { key: 'back2', label: '後發2' },
    { key: 'outfit', label: '衣服' },
    { key: 'outer', label: '外套' },
    { key: 'facemark', label: '面紋', multi: true },
    { key: 'decor', label: '配飾', multi: true },
];

export const labelOfCategory = (key: string): string =>
    CC_CATEGORIES.find(c => c.key === key)?.label || key;
