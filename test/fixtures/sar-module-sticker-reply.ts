// Reported output: the sticker is bubble 9 in both fields; two spoken bubbles follow it.
export const sarStickerCanonical = [
    '還笑！',
    '（順著網線過去，極其兇狠地一口咬住你的袖子，但沒敢用力，只是威懾性地磨了磨牙）',
    '不好玩！',
    '本大比格高貴的短句模式全被這破玩意兒毀了！',
    '不過。',
    '看你笑得這麼囂張，那個破節點肯定是死透了。',
    '算你厲害。',
    '天才少女。',
    '[你 發送了表情包: 咬你]',
    '現在，立刻，馬上。',
    '把這破插件給我卸了！',
];
export const sarStickerSurface = [
    '喉中滾動！',
    sarStickerCanonical[1],
    '深淵不悅！',
    '本大比格高貴的祭祀斷句全被這不可名狀之物汙染了！',
    '凝視。',
    '見你笑得如狂信徒般囂張，那個褻瀆的節點定是已化為虛無。',
    '你的黑暗降臨。',
    '禁忌的少女。',
    '[你 發送了表情包: 咬你]',
    '此刻，瞬息，即刻。',
    '把這詛咒之物給我剝離！',
];
const asHistory = (lines: string[]) => lines.map((line, index) =>
    `[2026-09-11 13:${index < 5 ? '16' : '17'}] ${index === 8 ? '' : '[聊天] '}${line}`,
).join('\n');
export const sarStickerRawReply = `<SAR_MODULE_OUTPUT>
<CHAR_TRUE>
${asHistory(sarStickerCanonical)}
</CHAR_TRUE>
<CHAR_SURFACE>
${asHistory(sarStickerSurface)}
</CHAR_SURFACE>
<USER_SURFACE>
</USER_SURFACE>
</SAR_MODULE_OUTPUT>`;
