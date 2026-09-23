import { describe, it, expect } from 'vitest';
import { DB } from './db';

// 「幽靈表情包」殘留清理（cleanupEmojiResidue）：
// 刪角色不級聯清理表情分類，只對已刪角色可見的專屬分類會卡在庫裡——
// 單聊面板被可見性過濾（看不到也刪不掉），群聊面板/提示詞卻還能看到。
// 清理規則：綁定全失效的非系統分類連表情一起刪；部分失效只剔除死 id；
// categoryId 懸空的無主表情刪除；系統分類只清綁定、絕不刪。
describe('cleanupEmojiResidue 幽靈表情包清理', () => {
  it('dryRun 只統計不落庫；真跑後殘留分類/表情被刪、混合綁定被修復、健康數據不動', async () => {
    // char-a 還活著，char-b 已被刪除
    await DB.saveEmojiCategory({ id: 'cat-alive', name: '活人專屬', allowedCharacterIds: ['char-a'] });
    await DB.saveEmojiCategory({ id: 'cat-ghost', name: '幽靈專屬', allowedCharacterIds: ['char-b'] });
    await DB.saveEmojiCategory({ id: 'cat-mixed', name: '混合綁定', allowedCharacterIds: ['char-a', 'char-b'] });
    await DB.saveEmojiCategory({ id: 'cat-public', name: '公開分類' });
    await DB.saveEmojiCategory({ id: 'cat-system', name: '系統分類', isSystem: true, allowedCharacterIds: ['char-b'] });

    await DB.saveEmoji('ghost-1', 'url-g1', 'cat-ghost');
    await DB.saveEmoji('ghost-2', 'url-g2', 'cat-ghost');
    await DB.saveEmoji('alive-1', 'url-a1', 'cat-alive');
    await DB.saveEmoji('public-1', 'url-p1', undefined);
    await DB.saveEmoji('dangling-1', 'url-d1', 'cat-gone'); // 分類早已不存在的無主表情

    // 1) dryRun：報告正確，但數據一個都不能少
    const scan = await DB.cleanupEmojiResidue(['char-a'], { dryRun: true });
    expect(scan.removedCategories.map(c => c.id)).toEqual(['cat-ghost']);
    expect(scan.fixedCategories.map(c => c.id).sort()).toEqual(['cat-mixed', 'cat-system']);
    expect(scan.removedEmojiCount).toBe(3); // ghost-1 + ghost-2 + dangling-1
    expect((await DB.getEmojis()).length).toBe(5);
    expect((await DB.getEmojiCategories()).length).toBe(5);

    // 2) 真跑
    const report = await DB.cleanupEmojiResidue(['char-a']);
    expect(report.removedCategories.map(c => c.id)).toEqual(['cat-ghost']);
    expect(report.removedEmojiCount).toBe(3);

    const cats = await DB.getEmojiCategories();
    expect(cats.find(c => c.id === 'cat-ghost')).toBeUndefined();
    // 混合綁定：只剔除已刪角色，分類和表情保留
    expect(cats.find(c => c.id === 'cat-mixed')?.allowedCharacterIds).toEqual(['char-a']);
    // 系統分類：綁定全失效也不刪，回落全員可見
    expect(cats.find(c => c.id === 'cat-system')?.allowedCharacterIds).toEqual([]);
    // 健康數據不動
    expect(cats.find(c => c.id === 'cat-alive')?.allowedCharacterIds).toEqual(['char-a']);
    expect(cats.find(c => c.id === 'cat-public')?.allowedCharacterIds).toBeUndefined();

    const emojiNames = (await DB.getEmojis()).map(e => e.name).sort();
    expect(emojiNames).toEqual(['alive-1', 'public-1']);

    // 3) 冪等：再跑一次應該什麼都掃不到
    const again = await DB.cleanupEmojiResidue(['char-a']);
    expect(again.removedCategories).toEqual([]);
    expect(again.fixedCategories).toEqual([]);
    expect(again.removedEmojiCount).toBe(0);
  });
});
