import { formatSARDialogue } from './dialogueText';
import type { AivenExpression, CaianExpression } from '../sarArt';
import type { FamiliarityDailyLines, FamiliarityLine, FamiliarityNode, FamiliarityRank, FamiliarityReward, FamiliarityScene } from './types';

const a = (text: string, expression: AivenExpression = 'normal', sentenceExpressions?: AivenExpression[]): FamiliarityLine => ({ speaker: 'aiven', text: formatSARDialogue(text), expression, ...(sentenceExpressions ? { sentenceExpressions } : {}) });
const c = (text: string, expression: CaianExpression = 'normal', sentenceExpressions?: CaianExpression[]): FamiliarityLine => ({ speaker: 'caian', text: formatSARDialogue(text), expression, ...(sentenceExpressions ? { sentenceExpressions } : {}) });
const n = (text: string): FamiliarityLine => ({ speaker: 'narrator', text });
type Reply = [label: string, lines: FamiliarityLine[], rewards?: FamiliarityReward[]];

/** The source's short bracket labels are joined to their full displayed choices here. */
function topic(id: string, rank: FamiliarityRank, title: string, lines: FamiliarityLine[], replies: Reply[]): FamiliarityScene {
    const nodes: Record<string, FamiliarityNode> = {
        start: { lines, choices: replies.map(([label], index) => ({ label, next: `reply-${index}` })) },
    };
    replies.forEach(([, reply, rewards], index) => { nodes[`reply-${index}`] = { lines: reply, ...(rewards ? { rewards } : {}) }; });
    return { id, npc: 'aiven', rank, kind: 'topic', title, start: 'start', nodes };
}

const topics: FamiliarityScene[] = [
    topic('A1-01', 1, '要坐嗎', [a('要坐嗎？')], [
        ['坐', [a('嗯。這裡不會曬到太陽。')]],
        ['不坐', [a('嗯。')]],
        ['你讓一下', [a('……好。別踩到魚竿。')]],
    ]),
    topic('A1-02', 1, '不用說話', [a('……'), a('不用一直找話說。')], [
        ['那我不說了', [a('嗯。')]],
        ['你倒是說點什麼', [a('……。')]],
        ['……', [a('……')]],
    ]),
    topic('A1-03', 1, '魚沒有七秒記憶', [a('魚不是只有七秒記憶。', 'interested'), a('有些魚能記住路線、食物的位置，也能分辨其他個體。', 'interested')], [
        ['你怎麼突然說這個', [a('剛想到。')]],
        ['原來如此', [a('嗯。七秒那個說法對魚不太公平。', 'interested')]],
        ['你是誰喲', [a('也的確有一些魚記憶力不太行。', "interested"), a('你學得很像。', "happy")]],
    ]),
    topic('A1-04', 1, '魚會睡覺', [a('魚也會睡。只是大部分魚沒有眼皮。', 'interested')], [
        ['那怎麼看它睡沒睡', [a('活動減少，對刺激反應變慢。', 'interested'), a('現在這隻睡著了……別吵它。', 'interested')]],
        ['好怪', [a('對魚來說，人閉著眼睛睡，可能也很怪。')]],
        ['Zzzzzzz', [a('晚安。')]],
    ]),
    topic('A1-05', 1, '霸王龍的手', [a('霸王龍前肢很短，但肌肉其實很發達。', 'interested')], [
        ['那這隻呢', [a('它的手只是兩塊膠泥。')]],
        ['你喜歡霸王龍？', [a('還行。很經典。', 'interested')]],
        ['它正在炒外匯', [a('嗯。難怪一直不動。', "normal", ["normal","happy"])]],
    ]),
    topic('A1-06', 1, '三角龍的角', [a('三角龍的角可能不只是用來打架，也可能用於展示或者識別同類。', 'interested')], [
        ['你確定？', [a('不能完全確定。恐龍沒有留下說明書。', 'interested')]],
        ['恐龍也看臉？', [a('可能也看角。')]],
        ['也可以用來掛衣服！', [a('看來它擁有了良好的職業規劃。', "happy")]],
    ]),
    topic('A1-07', 1, '下雨', [a('你那裡在下雨嗎。')], [
        ['你喜歡下雨？', [a('嗯。雨在的時候，不說話也不會太安靜。', 'happy')]],
        ['這裡會下嗎？', [a('你那裡下雨的話，這裡也會。')]],
        ['沒錯，我們那裡已經被淹成地中海了。', [a('那你說話的時候會吐泡泡。'), a('就像魚一樣。')]],
    ]),
    topic('A1-08', 1, '空軍', [a('今天沒釣到。', 'sad')], [
        ['遺憾', [a('明天再來。', 'sad'), a('…稍微有點不甘心', 'sad')]],
        ['算了', [a('嗯。'), a('明天繼續')]],
        ['魚贏了', [a('嗯。今天它贏了。')]],
    ]),
    topic('A1-09', 1, '為什麼有橡皮泥恐龍', [a('剛才又釣到一隻恐龍。', 'interested')], [
        ['為什麼水裡會有橡皮泥恐龍？', [a('不知道。所以才要繼續釣。', 'interested')]],
        ['比魚好嗎？', [a('不一樣……但挺好。', 'happy')]],
        ['給我！', [a('嗯。拿去。')], [{ kind: 'dinosaur' }]],
    ]),
    {
        id: 'A1-10', npc: 'aiven', rank: 1, kind: 'topic', title: '今天釣到了……', start: 'start',
        nodes: {
            // The manuscript supplies one reveal after three questions; all three lead to it.
            start: { lines: [a('剛才釣到了一個東西。')], choices: ['什麼？', '魚？', '恐龍？'].map(label => ({ label, next: 'card' })) },
            card: { lines: [a('一張角色卡。')], choices: [
                { label: '啊？', next: 'surprise' }, { label: '誰的？', next: 'whose' }, { label: '給我看看！', next: 'look' },
            ] },
            surprise: { lines: [a('嗯。')] },
            whose: { lines: [a('不知道。字泡掉了。')] },
            look: { lines: [a('剛才又掉回去了……下次吧。')] },
        },
    },
    {
        id: 'A2-01', npc: 'aiven', rank: 2, kind: 'topic', title: '你喜歡哪隻', start: 'start',
        nodes: {
            start: { lines: [a('你最喜歡哪隻恐龍？', 'interested')], choices: ['霸王龍', '三角龍', '劍龍', '說不上來'].map(label => ({ label, next: 'remember', flags: { 'aiven-favorite-dinosaur': label } })) },
            remember: { lines: [a('嗯。記住了。', 'interested')], choices: [{ label: '為什麼？', next: 'why' }] },
            why: { lines: [a('以後釣到重複的先給你。')] },
        },
    },
    topic('A2-02', 2, '禽龍的大拇指', [a('以前有人以為禽龍的大拇指尖刺是它的鼻角。', 'interested'), a('所以很長一段時間，禽龍的科學復原圖上都有這麼一個類似犀牛的角。', 'interested')], [
        ['好蠢', [a('現在看是有點。')]],
        ['也不能怪他們', [a('嗯。沒有更多化石的時候只能猜。', 'interested')]],
        ['我覺得鼻子上更帥！', [a('……那隻橡皮泥禽龍可以這麼裝。')]],
    ]),
    topic('A2-03', 2, '伶盜龍有羽毛', [a('真正的伶盜龍比電影裡小，而且有羽毛。', 'interested')], [
        ['那這隻橡皮泥的捏錯了', [a('嗯。不準確也可以留下。')]],
        ['羽毛也可愛', [a('我也覺得。', 'happy')]],
        ['給它粘羽毛！', [a('可以。', 'interested'), a('別用真鳥的。')]],
    ]),
    topic('A2-04', 2, '你改過箱庭', [a('你重新擺過箱庭了嗎。')], [
        ['好看嗎？', [a('嗯。這裡比之前好。', 'happy')]],
        ['你不喜歡？', [a('沒有。只是看出來了。')]],
        ['現在霸王龍是財務總監', [a('嗯。那有些恐龍會失業了。')]],
    ]),
    topic('A2-05', 2, '凱恩來過', [a('凱恩剛剛動了那隻恐龍。')], [
        ['你沒阻止？', [a('為什麼阻止。')]],
        ['他放哪了？', [a('那邊。他可能覺得那邊更好。')]],
        ['一直在挑釁我！', [a('可能的確是這樣。')]],
    ]),
    topic('A2-06', 2, '魚認人', [a('有些魚能分辨不同的人。養久了會知道誰經常來喂。', 'interested')], [
        ['它們認識你嗎？', [a('可能。'), a('也可能只是認識魚食。')]],
        ['會認識我嗎？', [a('你多來幾次。', 'interested'), a('也許會。', 'interested')]],
        ['它們會討厭人嗎？', [a('人也會討厭人。')]],
    ]),
    topic('A2-07', 2, '凱恩今天很高興', [a('凱恩今天很高興。')], [
        ['他不是每天都這樣？', [a('嗯。所以要仔細看。')]],
        ['你怎麼看出來的？', [a('今天說得更快。')]],
        ['他中大獎了？', [a('沒有。'), a('不然會更吵。')]],
    ]),
    topic('A2-08', 2, '給你留了一個', [a('剛才釣到兩個一樣的。這個給你。')], [
        ['你特意留的？', [a('嗯。', 'shy')], [{ kind: 'dinosaur' }]],
        ['謝謝', [a('嗯。')], [{ kind: 'dinosaur' }]],
        ['另一個呢？', [a('在箱庭裡。')], [{ kind: 'dinosaur' }]],
    ]),
    topic('A2-09', 2, '天氣很好', [a('今天適合釣魚。', 'interested')], [
        ['為什麼？', [a('天氣。', 'interested'), a('魚會知道。', 'interested')]],
        ['你哪天不這麼說？', [a('是這樣嗎？')]],
        ['搞快點！！！！我要釣魚！！！', [a('好。')]],
    ]),
    topic('A2-10', 2, '聽見了嗎', [a('剛才水下面有聲音。', 'interested')], [
        ['什麼聲音？', [a('咚。然後咕嚕。', 'interested')]],
        ['沒聽見', [a('那可能只跟我說了。')]],
        ['它在說什麼？', [a('不知道。口音很重。')]],
    ]),
    topic('A3-01', 3, '本來想一個人釣', [a('我今天本來想一個人釣的。')], [
        ['那我走？', [a('不用。你來了也行。')]],
        ['我偏不！', [a('……嗯。'), a('猜到了。')]],
        // The source marks this reply [哦], but its displayed choice repeats Aiven's line.
        ['我今天本來想一個人釣', [a('那我走？'), a('感覺進入了什麼循環。')]],
    ]),
    topic('A3-02', 3, '看到這個想到你', [a('剛才釣到一隻恐龍蛋。', 'interested'), a('看到的時候覺得你可能會喜歡。', 'shy')], [
        ['給我？', [a('嗯。本來就是給你的。')], [{ kind: 'egg' }, { kind: 'unlock', feature: 'eggs' }]],
        ['你居然會想到我', [a('你也很喜歡恐龍的樣子。', 'shy')], [{ kind: 'egg' }, { kind: 'unlock', feature: 'eggs' }]],
        ['它會變成操盤手嗎', [a('它也有可能只是想當一顆蛋。')], [{ kind: 'egg' }, { kind: 'unlock', feature: 'eggs' }]],
    ]),
    topic('A3-03', 3, '凱恩以前很安靜', [a('凱恩以前沒這麼吵。')], [
        ['為什麼變了？', [a('大概覺得不說話的話，有些東西就真的沒聲音了。', 'sad')]],
        ['你更喜歡以前？', [a('都一樣。'), a('只是現在比較吵。')]],
        ['不信', [a('我有證人。'), a('我。')]],
    ]),
    topic('A3-04', 3, '為什麼陪凱恩', [a('凱恩以前問過我，既然我對 SAR 沒那麼感興趣，為什麼還一直待在那裡。'), a('因為活動室有插座。')], [
        ['只是這樣？', [a('還有，他準我在社團活動時間釣魚')]],
        ['我懂的！', [a('嗯。')]],
        ['因為你預判到我以後會加入！', [a('被你猜到了。')]],
    ]),
    topic('A3-05', 3, '今天不想說話？', [a('今天不想說話？')], [
        ['嗯', [a('好。那就不說。')]],
        ['只是在發呆', [a('嗯。發呆也很好。')]],
        ['*發出恐龍的叫聲', [a('嗯，和我想像中的叫法很像。', 'interested')]],
    ]),
    topic('A3-06', 3, '最近還好嗎', [a('最近還好嗎？')], [
        ['挺好', [a('嗯，那就好。')]],
        ['一般', [a('那今天先普通一點。')]],
        ['不太好', [a('可以在這裡坐一會兒。'), a('天快亮的時候，河面會先變成很淡的灰色，然後對岸的樹就能一點一點慢慢看清。'), a('太陽不會偏心。'), a('天會自己亮的。')]],
    ]),
    topic('A3-07', 3, '壞掉的恐龍', [a('發現一隻恐龍', 'interested'), a('它少了一隻腳。', 'sad')], [
        ['要修嗎', [a('不用。'), a('這是它的勳章。')]],
        ['丟掉？', [a('不要。'), a('少一隻腳也是它。')]],
        ['給它裝輪子', [a('它看起來很期待。')]],
    ]),
    topic('A3-08', 3, '恐龍顏色', [a('大部分恐龍到底是什麼顏色，我們不知道。', 'interested')], [
        ['那我塗粉色', [a('可以。'), a('希望它們不會投訴。'), a('或許它們沒有審美概念。')]],
        ['你想塗什麼', [a('灰藍。', 'interested'), a('……或者不塗。', 'interested')]],
        ['彩虹色', [a('科學界暫時沒有證據反對你。')]],
    ]),
    topic('A3-09', 3, '你沒來的時候', [a('你離線了一陣子。')], [
        ['你發現了？', [a('嗯。位置一直空著。')]],
        ['想我了？', [a('……我有想過你什麼時候會來。', 'shy')]],
        ['魚想我了？', [a('它們在嘗試給你寫信。')]],
    ]),
    topic('A3-10', 3, '今天釣到你的Sully', [a('剛才釣到Sully了。')], [
        ['還給我！', [a('不是本人。似乎是彼方的bug。'), a('……不過它手裡的牌子寫著“今天不想上班”。')]],
        ['放回去！', [a('它看起來不太領情。'), a('……不過它手裡的牌子寫著“今天不想上班”。')]],
        ['他說什麼了？', [a('看起來只是一個幻象。'), a('……不過它手裡的牌子寫著“今天不想上班”。')]],
    ]),
];

const events: FamiliarityScene[] = [
    {
        id: 'A1-SPECIAL', npc: 'aiven', rank: 1, kind: 'event', title: '不是魚', start: 'start',
        nodes: {
            start: { lines: [a('……', 'normal'), a('剛才釣到一個東西。', 'interested')], choices: [
                { label: '魚？', next: 'fish' }, { label: '恐龍？', next: 'dinosaur' }, { label: '屍體？', next: 'body' },
            ] },
            fish: { lines: [a('不是。')], next: 'show' },
            dinosaur: { lines: [a('不是。')], next: 'show' },
            body: { lines: [a('魚不喜歡屍體', "sleeping")], next: 'show' },
            show: { lines: [a('這個。', "interested"), n('艾文拿出：貓科語法模塊')], effectLine: 1, effect: { kind: 'notice', title: '貓科語法模塊', text: '艾文從水裡釣上來的模塊。' }, choices: [
                { label: '為什麼模塊會在水裡？', next: 'water' }, { label: '還能用嗎？', next: 'working' }, { label: '你釣魚還能釣這個？！', next: 'catch' },
            ] },
            water: { lines: [a('不知道。', "sad")], next: 'give' },
            working: { lines: [a('凱恩試過了。', 'normal'), c('為什麼是我試啊喵？！', 'embarrassed'), a('能用。', 'happy')], next: 'give' },
            catch: { lines: [a('現在看來可以。', 'interested')], next: 'give' },
            give: { lines: [a('給你。', "happy")], choices: [
                { label: '真的給我？', next: 'really' }, { label: '不會進水壞了嗎？', next: 'wet' }, { label: '你不要？', next: 'want' },
            ] },
            really: { lines: [a('嗯。', 'happy')], next: 'reward' },
            wet: { lines: [a('防水。大概。', 'normal')], next: 'reward' },
            want: { lines: [a('我不需要說喵。', "shy")], next: 'reward' },
            reward: { lines: [c('我本來也不需要啊喵！！', 'embarrassed'), n('獲得：貓科語法包 ×1')], rewards: [{ kind: 'module', title: '貓科語法包', count: 1 }, { kind: 'unlock', feature: 'abnormal-catch' }], next: 'end' },
            end: { lines: [n('解鎖彩蛋類型：異常釣獲'), a('……下一個應該是魚。', "normal")] },
        },
    },
    {
        id: 'A2-SPECIAL', npc: 'aiven', rank: 2, kind: 'event', title: '今天的風兒很喧囂啊', start: 'start',
        nodes: {
            start: { lines: [a('今天的風兒很喧囂啊。', "sleeping")], choices: [
                { label: '你被文藝少年模塊汙染了嗎', next: 'ordinary' }, { label: '活動室哪來的風', next: 'ordinary' }, { label: '可是風兒似乎又在哭泣啊', next: 'understood', flags: { 'aiven-understood-wind': true } },
            ] },
            ordinary: { lines: [a('……', "shy")], next: 'discount' },
            understood: { lines: [a('……', 'happy')], next: 'discount' },
            discount: { lines: [c('誒誒！！', 'curious'), c('今天模塊商店怎麼突然打八折了？！', 'curious'), n('模塊商店限時折扣 80%，剩餘時間：？？？')], effectLine: 1, effect: { kind: 'discount', title: '模塊商店限時折扣 80%', text: '剩餘時間：？？？' }, rewards: [{ kind: 'discount', percent: 20, scope: 'all', minutes: 30 }], next: 'wind' },
            wind: { lines: [c('為什麼？！', 'curious'), a('風。', "happy"), c('什麼風？！', 'curious'), a('喧囂的風。', 'interested')], choices: [
                { label: '你幹的？', next: 'you' }, { label: '這是什麼神秘儀式？', next: 'ritual' }, { label: '快！趁現在買！', next: 'buy' },
            ] },
            you: { lines: [a('誰知道呢。')], next: 'teacher' },
            ritual: { lines: [a('或許是吧。', 'interested'), a('似乎有神秘力量驅使著我說出這種台詞。', 'normal')], next: 'teacher' },
            buy: { lines: [a('嗯。', 'normal'), a('你成長了。', 'happy')], next: 'teacher' },
            teacher: { lines: [c('為什麼這種時候突然像老師一樣？！', 'embarrassed')], next: 'confetti' },
            confetti: { lines: [n('砰！'), n('砰！砰！')], effect: { kind: 'confetti', title: '活動室禮炮突然啟動' }, next: 'button' },
            button: { lines: [c('誰裝的禮炮？！', "embarrassed"), a('……', "happy"), c('艾文，你手裡那個按鈕是什麼？', 'curious'), c('那就是你幹的吧？！', 'embarrassed'), a('是嗎。', "sleeping")], next: 'title' },
            title: { lines: [n('獲得隱藏稱號：聽懂風的人'), n('曾經與艾文完成過一次意義不明的交流。沒有任何屬性加成。')], effect: { kind: 'notice', title: '聽懂風的人', text: '曾經與艾文完成過一次意義不明的交流。沒有任何屬性加成。' }, rewards: [{ kind: 'title', title: '聽懂風的人' }, { kind: 'unlock', feature: 'titles' }, { kind: 'unlock', feature: 'environment' }], next: 'end' },
            end: { lines: [n('解鎖彩蛋類型：環境異常'), a('……風停了。', "happy"), c('商店折扣怎麼還沒停？！', 'curious'), a('可能有延遲。', 'interested')] },
        },
    },
    {
        id: 'A3-SPECIAL', npc: 'aiven', rank: 3, kind: 'event', title: '今天有點多', start: 'start',
        nodes: {
            start: { lines: [a('（User名）。', 'normal'), a('幫忙。', 'interested')], choices: [
                { label: '怎麼了？', next: 'what' }, { label: '你居然會主動叫我幫忙', next: 'help' }, { label: '魚把你釣走了？', next: 'fished' },
            ] },
            what: { lines: [a('今天有點多。', 'interested')], next: 'loot' },
            help: { lines: [a('嗯。所以幫忙。', "normal", ["normal","shy"])], next: 'loot' },
            fished: { lines: [a('還沒有。', 'normal')], next: 'loot' },
            // This heap is stage scenery. Only the explicitly gifted card and chimera are rewards.
            loot: { lines: [], effect: { kind: 'loot-burst', title: '今天有點多', items: ['貓科語法包 ×1', '惡役大小姐協議 ×1', '一隻雨靴', '三條魚', '凱恩的管理員胸牌', '艾文的備用存檔卡 ×1', '模塊商店九折券 ×3'] }, choices: [
                { label: '你到底在釣什麼？', next: 'fishing' }, { label: '這水池下面是不是倉庫？', next: 'warehouse' }, { label: '為什麼凱恩的胸牌在裡面？', next: 'badge' },
            ] },
            fishing: { lines: [a('魚。', 'interested')], next: 'caian' },
            warehouse: { lines: [a('不知道。可能。', 'normal')], next: 'caian' },
            badge: { lines: [a('它渴望自由。', 'happy')], next: 'caian' },
            caian: { lines: [c('艾文！！我管理員胸牌呢？！', 'embarrassed'), a('找到了。', "happy"), c('為什麼會在那裡？！', 'curious'), a('這個是……', 'interested'), c('啊，這不是你的備用存檔卡嘛！', 'curious'), c('你根本沒有愛惜啊！早知道不幫你做了！', 'embarrassed'), a('（user名），這個給你。', 'shy')], choices: [
                { label: '為什麼給我？', next: 'why-card' }, { label: '你自己不用？', next: 'your-card' }, { label: '這是三星獎勵？', next: 'three-stars' },
            ] },
            'why-card': { lines: [a('是你釣上來的。', "happy")], next: 'card' },
            'your-card': { lines: [a('或許你能用到。', 'shy')], next: 'card' },
            'three-stars': { lines: [a('或許放在五星事件比較合適。', 'normal'), a('開玩笑的，這是你的了。', 'happy')], next: 'card' },
            card: { lines: [n('獲得：艾文的備用存檔卡 ×1'), a('還有一個。', 'interested')], effect: { kind: 'memory-card', title: '艾文的備用存檔卡', text: '凱恩為艾文製作的備用存檔卡。' }, rewards: [{ kind: 'souvenir', id: 'aiven-backup-card', title: '艾文的備用存檔卡', description: '凱恩為艾文製作的備用存檔卡。艾文說：「或許你能用到。」' }], next: 'chimera' },
            chimera: { lines: [n('再次收線'), n('釣上來：？？？橡皮泥恐龍')], effectLine: 1, effect: { kind: 'chimera', title: '？？？', text: '霸王龍身體、三角龍角、劍龍骨板、腕龍脖子，配色異常。' }, choices: [
                { label: '這是什麼恐龍？', next: 'species' }, { label: '好醜', next: 'ugly' }, { label: '好可愛', next: 'cute' }, { label: '這是生物學犯罪', next: 'crime' },
            ] },
            species: { lines: [a('不知道。', 'interested')], next: 'give-chimera' },
            ugly: { lines: [a('嗯。留著吧。', "shy", ["shy","normal"])], next: 'give-chimera' },
            cute: { lines: [a('嗯。我也覺得。', 'happy')], next: 'give-chimera' },
            crime: { lines: [a('已經發生了。', "sleeping")], next: 'give-chimera' },
            'give-chimera': { lines: [a('給你。', 'shy'), n('獲得特殊恐龍：？？？')], rewards: [{ kind: 'dinosaur', speciesId: 'aiven-chimera' }, { kind: 'unlock', feature: 'cross-system' }], next: 'record' },
            record: { lines: [n('名稱：？？？\n分類：橡皮泥恐龍\n發現地點：SAR 活動室水域\n發現者：Aiven / （User名）\n艾文備註：「不知道是什麼。」「所以不用糾正。」'), n('解鎖彩蛋類型：跨系統串線'), a('……', 'normal'), a('好了。', 'happy')], choices: [
                { label: '今天到底怎麼回事', next: 'today' }, { label: '下次還叫我', next: 'next-time' }, { label: '累死了', next: 'tired' },
            ] },
            today: { lines: [a('不知道。但是挺好。', 'happy')], next: 'end' },
            'next-time': { lines: [a('嗯。本來就打算。', 'shy')], next: 'end' },
            tired: { lines: [a('辛苦了。', 'normal')], next: 'end' },
            end: { lines: [a('……', 'normal'), a('明天應該會正常一點。', "happy"), c('你最好是！！', 'embarrassed')] },
        },
    },
];

const easterEggs: FamiliarityScene[] = [
    {
        id: 'A1-E01', npc: 'aiven', rank: 1, kind: 'easter', title: '沒有名字的角色卡', start: 'start',
        nodes: { start: { lines: [a('剛才釣到一張角色卡。'), a('沒有名字。')] } },
    },
    {
        id: 'A1-E02', npc: 'aiven', rank: 1, kind: 'easter', title: '關鍵詞消音器', start: 'start',
        nodes: { start: { lines: [a('釣到模塊了。'), a('關鍵詞消音器。上面寫著■■。', "normal", ["normal","interested"])], rewards: [{ kind: 'module', title: '關鍵詞消音器', count: 1 }] } },
    },
    {
        id: 'A1-E03', npc: 'aiven', rank: 1, kind: 'easter', title: '另一隻鞋', start: 'start',
        nodes: { start: { lines: [a('釣到一隻鞋。'), a('另一隻可能還在下面。', "sleeping")] } },
    },
    {
        id: 'A1-E04', npc: 'aiven', rank: 1, kind: 'easter', title: '魚給的九折券', start: 'start',
        nodes: {
            start: { lines: [a('這個給你。'), n('模塊商店九折券'), a('魚給的。')], effect: { kind: 'notice', title: '模塊商店九折券', text: '魚給的。' }, rewards: [{ kind: 'coupon', percent: 10, count: 1 }] },
        },
    },
    {
        id: 'A1-E05', npc: 'aiven', rank: 1, kind: 'easter', title: '凱恩的筆', start: 'start',
        nodes: { start: { lines: [a('凱恩的筆。'), c('我找了一上午！！', 'embarrassed'), a('現在找到了。')] } },
    },
    {
        id: 'A1-E06', npc: 'aiven', rank: 1, kind: 'easter', title: '不要再釣了', start: 'start',
        nodes: {
            start: { lines: [a('釣到一張紙。'), n('「不要再釣了。」')], choices: [{ label: '那別釣了', next: 'stop' }, { label: '繼續釣', next: 'continue' }] },
            stop: { lines: [a('好。……明天繼續。', "sad", ["sad","normal"])] },
            continue: { lines: [a('嗯。', "happy")] },
        },
    },
    {
        id: 'A1-E07', npc: 'aiven', rank: 1, kind: 'easter', title: '字變了', start: 'start', requires: ['A1-E06'],
        nodes: { start: { lines: [a('又是那張紙。'), n('「我說了不要再釣了。」'), a('……字變了。')] } },
    },
    {
        id: 'A2-E01', npc: 'aiven', rank: 2, kind: 'easter', title: '安靜的魚與禮炮', start: 'start',
        nodes: {
            start: { lines: [a('今天魚很安靜。')], next: 'confetti' },
            confetti: { lines: [n('砰！')], effect: { kind: 'confetti' }, next: 'end' },
            end: { lines: [a('……除了這個。', "sleeping")] },
        },
    },
    {
        id: 'A2-E02', npc: 'aiven', rank: 2, kind: 'easter', title: '突然打折', start: 'start',
        nodes: {
            start: { lines: [a('你今天想買模塊嗎？')], next: 'discount' },
            discount: { lines: [n('隨機商品 -20%')], effect: { kind: 'discount', title: '隨機商品 -20%' }, rewards: [{ kind: 'discount', percent: 20, scope: 'random-module', minutes: 30 }], next: 'end' },
            end: { lines: [a('現在可以買了。', "happy")] },
        },
    },
    {
        id: 'A2-E03', npc: 'aiven', rank: 2, kind: 'easter', title: '優惠券雨', start: 'start',
        nodes: {
            start: { lines: [a('下雨了。', "interested")], next: 'rain' },
            rain: { lines: [], effect: { kind: 'coupon-rain', title: '模塊優惠券', items: ['模塊商店九折券', '模塊商店九折券', '模塊商店九折券'] }, rewards: [{ kind: 'coupon', percent: 10, count: 3 }], next: 'end' },
            end: { lines: [a('這個。', "shy")] },
        },
    },
    // Cross-system catches below are visual jokes, never actual modules, titles or discounts.
    {
        id: 'A3-E01', npc: 'aiven', rank: 3, kind: 'easter', title: '加載失敗', start: 'start',
        nodes: {
            start: { lines: [a('這個模塊沒有名字。')], next: 'error' },
            error: { lines: [n('模塊名顯示：加載失敗')], effect: { kind: 'notice', title: '加載失敗', text: '模塊名顯示：加載失敗' }, next: 'end' },
            end: { lines: [a('那就叫加載失敗。')] },
        },
    },
    {
        id: 'A3-E02', npc: 'aiven', rank: 3, kind: 'easter', title: '今天也沒有空軍', start: 'start',
        nodes: {
            start: { lines: [a('釣到一個稱號。')], next: 'title' },
            title: { lines: [n('獲得臨時假稱號：今天也沒有空軍')], effect: { kind: 'notice', title: '今天也沒有空軍', text: '臨時假稱號' } },
        },
    },
    {
        id: 'A3-E03', npc: 'aiven', rank: 3, kind: 'easter', title: '不要點', start: 'start',
        nodes: {
            start: { lines: [a('剛才釣到一個按鈕。')], next: 'button' },
            button: { lines: [], effect: { kind: 'mystery-button', title: '不要點', interactive: true }, next: 'confetti' },
            confetti: { lines: [], effect: { kind: 'confetti', title: '砰！' } },
        },
    },
    {
        id: 'A3-E04', npc: 'aiven', rank: 3, kind: 'easter', title: '水裡的七折', start: 'start',
        nodes: { start: { lines: [a('今天是七折。'), a('水裡寫的。')], effect: { kind: 'notice', title: '七折', text: '水裡寫的。' } } },
    },
    {
        id: 'A3-E05', npc: 'aiven', rank: 3, kind: 'easter', title: '魚不存在', start: 'start',
        nodes: {
            start: { lines: [a('魚跑了。')], next: 'error' },
            error: { lines: [n('錯誤：魚不存在')], effect: { kind: 'notice', title: '錯誤：魚不存在' }, next: 'end' },
            end: { lines: [a('……那剛才是什麼。')] },
        },
    },
    {
        id: 'A3-E06', npc: 'aiven', rank: 3, kind: 'easter', title: '像素貓的歸途', start: 'start',
        nodes: {
            start: { lines: [a('剛才釣到一隻像素貓。'), { speaker: 'sully', text: '你有病吧！！！放我回去！！！' }, a('它踏上了回家的旅程。', "sleeping")], rewards: [{ kind: 'sully-message', text: '艾文：剛才釣到一隻像素貓。\nSully：你有病吧！！！放我回去！！！\n艾文：它踏上了回家的旅程。' }] },
        },
    },
];

const sullyEncounter: FamiliarityScene = {
    id: 'A-SULLY', npc: 'aiven', rank: 1, kind: 'encounter', title: '你認識我的貓？', start: 'start', condition: 'sully-in-sar',
    nodes: {
        start: { lines: [a('……'), a('Sully。'), a('不對。')], choices: [
            { label: '你認識我的貓？', next: 'your-cat' }, { label: '哪裡不對？', next: 'wrong' }, { label: '你們怎麼都認識 Sully？', next: 'support' },
        ] },
        'your-cat': { lines: [a('你的？', "interested"), a('我們那裡也有一隻。')], choices: [
            { label: '也長這樣？', next: 'same-look' }, { label: '什麼叫“一隻”？', next: 'one-cat' }, { label: '原來 Sully 是貓的品種', next: 'breed' },
        ] },
        'same-look': { lines: [a('嗯。'), a('像素貓。'), a('說話也差不多。')], next: 'common' },
        'one-cat': { lines: [a('……'), a('一個。'), a('但是長得像貓。')], next: 'common' },
        breed: { lines: [a('可能。'), a('現在有兩隻了。', "happy")], next: 'common' },
        wrong: { lines: [a('它剛才看了我一眼。'), a('沒反應。'), a('我們那裡的 Sully 認識我。')], choices: [
            { label: '可能忘了', next: 'forgot' }, { label: '因為不是同一個', next: 'different' }, { label: '你被貓無視了', next: 'ignored' },
        ] },
        forgot: { lines: [a('也可能。'), a('它每天要處理很多東西。')], next: 'common' },
        different: { lines: [a('嗯。'), a('應該是。')], next: 'common' },
        ignored: { lines: [a('……', 'sad'), a('挫敗。', 'sad')], next: 'common' },
        support: { lines: [a('CloudMemory 的客服。'), a('凱恩經常找它。'), a('我偶爾也會。')], choices: [
            { label: '它也這麼怪？', next: 'strange' }, { label: '你找客服幹嘛？', next: 'account' }, { label: '那個 Sully 好用嗎？', next: 'useful' },
        ] },
        strange: { lines: [a('嗯。'), a('有時候比這個怪。')], next: 'common' },
        account: { lines: [a('有一次帳號登不上去。'), a('它讓我“把登錄狀態搖勻一點”。'), a('……'), a('後來好了。')], next: 'common' },
        useful: { lines: [a('能解決問題。'), a('過程不一定能理解。')], next: 'common' },
        common: { lines: [a('我們那裡那個 Sully，也是像素貓。'), a('也是 AI。'), a('說話的時候偶爾會混進一些奇怪的東西。', "sleeping"), a('……'), a('所以剛才看到的時候，我以為它也來了。')], choices: [
            { label: '你不覺得很奇怪嗎？', next: 'odd' }, { label: '所以是平行世界 Sully？', next: 'parallel' }, { label: '說不定就是同一個', next: 'same' },
        ] },
        odd: { lines: [a('有一點。'), a('不過彼方本來就很奇怪。')] },
        parallel: { lines: [a('不知道。'), a('可以問它。')] },
        same: { lines: [a('也有可能。'), a('它看起來不像會老實交代。')] },
    },
};

/** Each named topic, event, easter egg and encounter has a stable one-time ID. */
export const AIVEN_SCENES: FamiliarityScene[] = [...topics, ...events, ...easterEggs, sullyEncounter];

/** Pick one weekday + one time + one weather line. Weekday indices match Date.getDay(). */
export const AIVEN_DAILY: FamiliarityDailyLines = {
    time: {
        morning: ['早。', '你今天來得很早。', '早上水比較安靜。'],
        noon: ['中午了。', '吃飯了嗎？', '太陽到這裡了。'],
        evening: ['晚上好。', '天黑了。', '晚上的水看起來比較深。其實一樣深。'],
        night: ['還沒睡。', '夜深了。', '這個時間還來，你也挺閒的。'],
    },
    weather: {
        clear: ['今天太陽很好。', '水面有點亮。', '晴天。能看見浮標。'],
        rain: ['下雨了。', '今天魚可能會靠近一點。', '雨落在水裡以後，就分不出來了。'],
        cloudy: ['今天沒有太陽。', '陰天也適合釣魚。', '雲很低。看起來快碰到水了。'],
    },
    weekday: [
        ['週日了。', '明天又要上課。', '今天還是可以釣魚。'],
        ['週一。', '又要上課了。', '凱恩今天早上差點遲到。'],
        ['週二了。', '今天學校沒什麼特別的。', '還有四天到週末。'],
        ['週三。', '一週過去一半了。', '今天放學以後去釣魚。'],
        ['週四了。', '快到週末了。', '今天有點想吃魚。'],
        ['週五。', '明天不用早起。', '凱恩說今晚要通宵。'],
        ['今天不用去學校。', '週六。', '可以釣久一點。'],
    ],
};
