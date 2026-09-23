import { describe, expect, it } from 'vitest';
import { dialogueSentences } from './vrWorld/sarFamiliarity/dialogueText';
import { keepDialogueGuest } from './vrWorld/sarDialogueStaging';
import { getSARDialogueNode, SAR_CAIAN_INTRO_DIALOGUE } from './vrWorld/sarClub';
import { familiarityScene } from './vrWorld/sarFamiliarity/catalog';

describe('SAR dialogue presentation',()=>{
    it('pages sentences without losing punctuation, quotes or quiet pauses',()=>{
        expect(dialogueSentences('你好！再坐一會兒。\n……好。你說“真的嗎？！”')).toEqual(['你好！','再坐一會兒。','……好。','你說“真的嗎？！”']);
        expect(dialogueSentences('……')).toEqual(['……']);
        expect(dialogueSentences('')).toEqual([]);
    });
    it('only brings in a new guest when they speak, then keeps the whole exchange together',()=>{
        const nodes=SAR_CAIAN_INTRO_DIALOGUE;
        expect(keepDialogueGuest(nodes,'about-sar',2,'caian',false)).toBe(false);
        for(let i=3;i<nodes['about-sar'].lines.length;i++)expect(keepDialogueGuest(nodes,'about-sar',i,'caian',false)).toBe(true);
        expect(keepDialogueGuest(nodes,'about-bioroid',0,'caian',true)).toBe(true);
        expect(keepDialogueGuest(nodes,'about-character-card',0,'caian',true)).toBe(false);
        expect(keepDialogueGuest(nodes,'about-character-card',15,'caian',true)).toBe(false);
        expect(keepDialogueGuest(nodes,'end',0,'caian',true)).toBe(false);
    });
    it('keeps a guest for the reply in a personal scene and tolerates graph cycles',()=>{
        const scene=familiarityScene('A1-SPECIAL')!;
        expect(keepDialogueGuest(scene.nodes,'working',0,'aiven',false)).toBe(false);
        expect(keepDialogueGuest(scene.nodes,'working',1,'aiven',false)).toBe(true);
        expect(keepDialogueGuest(scene.nodes,'working',2,'aiven',true)).toBe(true);
        expect(keepDialogueGuest({loop:{lines:[],next:'loop'}},'loop',0,'aiven',true)).toBe(false);
    });
    it('does not reveal Caian’s embarrassed punchline during Aiven’s setup',()=>{
        const {lines}=getSARDialogueNode('about-sar',{mentionedCharacterCard:false});
        const i=lines.findIndex(l=>l.text==='這裡似乎沒有仿生人。');
        expect(lines[i].castExpressions?.caian).toBe('curious');
        expect(lines[i+1].castExpressions?.caian).toBe('embarrassed');
    });
});


it('formats spoken prose consistently and preserves stage directions and pauses', async () => {
    const { formatSARDialogue, familiarityLineExpression } = await import('./vrWorld/sarFamiliarity/dialogueText');
    expect(formatSARDialogue('這裡隨時歡迎你 。')).toBe('這裡隨時歡迎你。');
    expect(formatSARDialogue('明天繼續')).toBe('明天繼續。');
    expect(formatSARDialogue('（低頭看魚）')).toBe('（低頭看魚）');
    expect(formatSARDialogue('……')).toBe('……');
    const line = { speaker: 'caian' as const, text: '當了社長。就得有擔當。', expression: 'serious' as const, sentenceExpressions: ['serious', 'normal'] as const };
    const authored = { ...line, sentenceExpressions: [...line.sentenceExpressions] };
    expect(familiarityLineExpression(authored, 0)).toBe('serious');
    expect(familiarityLineExpression(authored, 1)).toBe('normal');
    expect(familiarityLineExpression(authored)).toBe('normal');
});

it('user-authored sentence portraits remain valid for each speaker', async () => {
    const { FAMILIARITY_SCENES } = await import('./vrWorld/sarFamiliarity/catalog');
    const { familiarityLineExpression } = await import('./vrWorld/sarFamiliarity/dialogueText');
    const { SAR_EXPRESSIONS } = await import('./vrWorld/sarArt');
    for (const scene of FAMILIARITY_SCENES.filter(scene => scene.kind === 'event')) {
        for (const [id, node] of Object.entries(scene.nodes)) {
            for (const line of node.lines) {
                if (line.speaker !== 'caian' && line.speaker !== 'aiven') continue;
                for (const [page] of dialogueSentences(line.text).entries()) {
                    const expression = familiarityLineExpression(line, page);
                    expect(SAR_EXPRESSIONS[line.speaker]).toContain(expression);
                }
            }
        }
    }
});

it('keeps listeners on their last spoken expression through narration and the other actor\'s lines', async () => {
    const { familiarityCast } = await import('./vrWorld/sarFamiliarity/dialogueText');
    let cast = familiarityCast({}, {speaker:'caian',text:'第一句。第二句。',expression:'normal',sentenceExpressions:['normal','warm']});
    expect(cast.caian).toBe('warm');
    cast = familiarityCast(cast, {speaker:'aiven',text:'嗯。',expression:'happy',castExpressions:{caian:'embarrassed'}});
    expect(cast).toEqual({caian:'warm',aiven:'happy'});
    cast = familiarityCast(cast, {speaker:'narrator',text:'風吹過。',castExpressions:{caian:'sad' as never}});
    expect(cast).toEqual({caian:'warm',aiven:'happy'});
});

it('resolves dialogue, dinosaur discoverer and gift name placeholders without replacement-string expansion', async () => {
    const { familiarityText, familiarityScene } = await import('./vrWorld/sarFamiliarity/catalog');
    const name = '小雨$&';
    expect(familiarityText('（User名） / (user名) / {{user}} / user',name)).toBe(Array(4).fill(name).join(' / '));
    const record = familiarityScene('A3-SPECIAL')!.nodes.record.lines[0].text;
    expect(familiarityText(record,name)).toContain('發現者：Aiven / '+name);
    expect(familiarityText('（User名），你好！','User')).toBe('你，你好！');
    const ending=familiarityScene('C3-SPECIAL')!.nodes.ending.lines;
    expect(ending.every(line=>line.expression==='happy')).toBe(true);
    expect(familiarityText(ending[1].text,name)).toContain(name+'！');
});
