import type { SARExpression } from './sarArt';

/** 只給三句日常問候配表情；劇情使用逐句編排的表情，尤其不提前洩露 embarrassed 包袱。 */
function preferredGreetingExpression(npc: 'caian' | 'aiven', text: string, index: number): SARExpression {
    if (npc === 'caian') {
        if (/深了|上[学學]|[周週]一|下雨|[带帶][伞傘]/.test(text)) return 'serious';
        if (/[？?]|怎[么麼]|研究|艾文/.test(text)) return 'curious';
        if (/太好了|不[错錯]|加油|[周週]末|耶/.test(text)) return 'happy';
        return (['normal', 'curious', 'normal'] as const)[index % 3];
    }
    if (/[没沒]睡|夜深|早起|通宵/.test(text)) return 'sleeping';
    if (/上[课課]|[周週]一|[还還]有四天/.test(text)) return 'sad';
    if (/[鱼魚]|水|雨|浮[标標]|太[阳陽]|[云雲]/.test(text)) return 'interested';
    if (/好|不用|[周週]末/.test(text)) return 'happy';
    return (['normal', 'interested', 'happy'] as const)[index % 3];
}

export function sarGreetingExpression(npc: 'caian' | 'aiven', text: string, index: number, previous?: SARExpression): SARExpression {
    const preferred = preferredGreetingExpression(npc, text, index);
    return preferred === previous ? previous === 'normal' ? (npc === 'caian' ? 'curious' : 'interested') : 'normal' : preferred;
}
