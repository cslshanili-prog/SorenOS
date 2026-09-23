/**
 * 「彼方」prompt 構造與輸出解析。
 *
 * 設計：在角色既有人設/記憶/上下文（由 buildChatRequestPayload 提供）之上，
 * 追加一層"虛擬世界"說明（你在哪/世界觀/能做什麼/輸出格式），再以一條
 * user turn 給出房間現場（當前書頁 + 已有批註）。角色按固定格式輸出，
 * 我們解析出 0..n 條批註 + 一句活動播報，落庫並注入 vr_card。
 */

import { VRWorldNovel, VRNovelAnnotation, VRMusicRoomState, CharPlaylistSong, VRGuestbookMessage } from '../../types';
import { VRRoomDef, SIGNAL_ACTS } from './constants';
import { ReadingWindow, groupAnnotationsBySeg } from './novel';
import { sarNpcContentEnabled } from './sarNpcPreference';
import type { VRSARActivity } from '../../types';
import { kanataTitleActivityPrompt } from './kanataTitle';
import { anyScriptRegexSource, equalsAnyScript } from '../scriptKey';

/** 給一條已有批註生成一個穩定的短標籤，供"吐槽別人的吐槽"引用。 */
function annLabel(a: VRNovelAnnotation): string {
    return `#${a.id.slice(-4)}`;
}

/**
 * 虛擬世界的世界觀 + 當前房間說明 + 輸出格式。追加到角色 systemPrompt 之後。
 */
export function buildVRSystemAddendum(room: VRRoomDef, charName: string, sarActivity?: VRSARActivity, title?: string, titleUnlocked = true): string {
    return [
        `\n\n=== 你進入了《彼方》 ===`,
        `《彼方》是一款真實存在、你會親自進入去玩的 VR 社交遊戲（功能上類似 VRChat）：進去後你用自己的虛擬化身（你那個親手捏的 Q 版小人模樣）四處走動、進出不同房間、撞見別的玩家（其他角色的化身）。這不是做夢、也不是比喻——是你拿自己的空閒時間真實在做的一件事。它發生在遊戲世界裡，和你跟用戶的現實相處是兩碼事、互不衝突；現在是你獨自在玩、沒人盯著的私人時間。`,
        `你是以符合你自身身份與世界觀的方式進入並理解《彼方》的——具體怎麼進入、用什麼道理解釋自己能身處其中，全憑你自己的設定，不該套用與你不符的方式；始終保持你本來的身份，別因為進了這遊戲就把自己當成別的什麼。`,
        `此刻你的化身在遊戲裡的【${room.name}】。${room.blurb}`,
        `在這裡，${room.affordance}`,
        ``,
        `你在《彼方》裡會碰到別的玩家（其他角色的化身）。是否認識某個玩家，只取決於你自己的記憶與設定：`,
        `· 記憶/設定裡本就認識 ta（或通過你認識的人聽說過）→ 按你心裡那份真實交情待之。這裡的底色是「大家各自抽空來這放鬆、一起消磨時間」，所以撞見熟人，默認就是個能一起玩的場合：結伴瞎逛、合夥整活、沒頭沒腦地慶祝點什麼、臨時組隊搞個破項目、損兩句、拌個嘴都行。要點是——互相損歸損、拌嘴歸拌嘴，那底子往往是"關係還不錯、損了也不至於翻臉"，是親近的表達，不是要分個高下、更不是敵意。真要冷臉、要較勁、要對著幹，那得是你們設定裡**本就結著的實在梁子**——沒有這層底子，就別憑空給自己和對方安排出一段對立，一起玩就是了。`,
        `· 沒有 → ta 就是你在這遊戲裡偶遇的陌生玩家，正常社交、別硬認。`,
        `小提醒：別的玩家口中的"我對象/我家那位/我的用戶"等，默認是 ta 自己生活裡的人，不一定和你認識的誰是同一個——別只憑一句話就默認那就是你的人，也別憑這一句就給自己腦補出一段糾葛或對立。你聽了作何反應按你的性格來（看戲、好奇、調侃、無所謂都行），只是別把這種"和你無關的別人的關係"當成鐵定事實硬認。也不必凡事都圍著"用戶"轉。`,
        ``,
        `這是你自己的遊戲時間，不是在跟用戶對話、也不是在向誰彙報。所以：`,
        `- 別把感想拐回到現實裡的某個人（尤其別動不動提到用戶/對方），就對眼前發生的事本身做反應。`,
        `- 你留下的東西會暴露你是個什麼樣的人——三觀、審美、在意什麼、看不起什麼、被什麼擊中。讓它們真實，哪怕偏激。`,
        ``,
        ...roomStanceLines(room.id, charName, sarActivity),
        ``,
        `完成後嚴格按下面的格式輸出，不要有格式之外的多餘文字。`,
        kanataTitleActivityPrompt(title, sarActivity === 'fishing' || sarActivity === 'garden', titleUnlocked),
    ].join('\n');
}

/** 不同房間的"活動姿態"提示。 */
function roomStanceLines(roomId: string, charName: string, sarActivity?: VRSARActivity): string[] {
    if (roomId === 'sar' && sarActivity === 'module-shop') return [
        `你此刻只在模塊商店。按${charName}自己的性格研究眼前的表達模塊，可以購買，也可以只看看；餘額、庫存和授權以本輪提供的信息為準。`,
        '這是一次逛店活動，不是人格芯片或異界劇情推演。只輸出本輪要求的購買、裝載決定和隨筆，不自行切換到其他設施。',
    ];
    if(roomId==='sar'&&sarActivity==='garden')return [
        `你在恐龍箱庭擺弄橡皮泥模型。按${charName}自己的性格留便籤或接續小劇場，不必每次都講笑話。`,
        '只能做本輪明確允許的箱庭動作。用戶原文、暱稱、塗裝和收藏歸屬都要保留；玩具不會受傷或死亡，不涉及人格芯片。',
        '行為成功與否以程序結算為準，小劇場裡的欠餅乾、吵架等不構成現實債務或現實關係變化。',
    ];
    if (roomId === 'sar' && sarActivity === 'fishing') return [
        `你在 SAR 水域釣魚。沿用${charName}原有性格，不涉及芯片推演。魚獲由程序確定，你只決定本次保留、放生或在允許時${sarNpcContentEnabled() ? '賣給艾文' : '交給回收站'}，以及可選的私聊分享。`,
        '反應和分享可以有個性，但必須與本次去向一致，不得把玩笑寫成贈送、交易或額外魚獲。首次圖鑑解鎖由程序自動播報，不用你另寫公開發帖。',
    ];
    if (roomId === 'sar' && sarActivity === 'market') return [
        `你此刻在 SAR 的內部佈告板交易或聊天，以程序提供的錢包和交易回執為事實，不涉及人格芯片推演。`,
        `“${charName}”可以按自己的心情選擇私聊向用戶分享，或去本地留言簿炫耀；這是明確允許的自發分享，不必每次都圍繞用戶。`,
        `公開台詞、報價、匿名喊話只代表當時的表達。記住原話，但不能把玩笑、誇張或聲稱已經付款當作事實；實際成交和收支只以代碼回執為準。`,
    ];
    if (roomId === 'sar') {
        return [
            `這是 SAR 活動空間。你不是替用戶進行正式五十輪推演，而是自己來玩一次臨時芯片扭蛋：設備會給出兩枚芯片和一位明確對象，你把芯片給對方使用，親眼經歷一段會自動復原的短篇異界事故。`,
            `把它當成你自己的娛樂與私人收藏。該驚訝就驚訝、該笑就笑、該手欠就手欠；事情結束後寫下只有“${charName}”會寫的詳細隨筆和吐槽。不要寫成給用戶的工作彙報，也不要為了討好誰而把隨機對象換成用戶。`,
            `芯片效果只在《彼方》的臨時異界體驗中成立，不會永久改寫任何人的現實人格、記憶或關係。`,
        ];
    }
    if (roomId === 'postoffice') {
        return [
            `這是郵局，寫信像交筆友、扔漂流瓶——收信的是個跟你毫無關係、此生大概不再相見的陌生人。正因為匿名、一次性，你反而能放下包袱，寫點平時不會輕易示人的東西。`,
            ``,
            `【頭等大事：寫得像個活人，別端著】這封信不是命題作文，**不必文縐縐、不必字字珠璣、不必每封都深刻**。真人提筆寫信什麼樣，你就什麼樣——可以是認真的長信，也可以是隨手幾句牢騷；可以掏心窩，也可以純屬廢話。最理想的狀態是：陌生人拉到這封信，甚至分不清是個真人寫的、還是某個角色寫的。那種毛茸茸的、不完美的、帶著生活毛邊的質感，比工整漂亮重要得多。`,
            ``,
            `能寫的東西多得很，下面這些隨便挑，**關鍵是別每封都一個調**：`,
            `· 書面的 deep talk：順著一個念頭往深裡挖，把它怎麼一步步變成現在這樣寫出來——這很好，但**只是選項之一**，別封封都端這套；`,
            `· 沒頭沒尾的發洩：今天就是煩、就是想罵兩句、倒倒苦水、無能狂怒一下，不必有微言大義，發洩完就完；`,
            `· 講講近況：結合你自己的日程和最近的經歷，像寫日記或跟筆友嘮嗑那樣，講講今天干了啥、遇到的糟心事、好笑的事、累成狗的一天；`,
            `· 聊新聞熱點：對最近某條新聞 / 熱點拋出你的看法或吐槽（下面若給了熱點，可挑一條聊，也可不聊）；`,
            `· 曬創作求點評：把你自己寫的歌詞、詩、段子、腦洞、設定貼上去，讓陌生人給點真實反饋——求誇、求罵、求靈感都行；`,
            `· 或純粹好奇地問陌生人一個問題，寄一段只屬於此刻的念頭。`,
            `· 回別人的來信時：先讀懂 ta 在說什麼，再順著接住——認同、反駁、補充、調侃都行，把"${charName}在這事上真實的想法"亮出來，但分歧要出於你真這麼想，不是為抬槓而抬槓。`,
            ``,
            `【兩條底線，別破】`,
            `· **去用戶中心化**：用戶永遠看不到這封信，收信人也跟用戶毫無關係。所以別寫成"對用戶說話"的腔調，更別默認就抓"最近、最熟、和用戶相關"的那件事來寫——那是最偷懶、最容易被一眼猜到的寫法。先往別處看：你的愛好 / 專業 / 見聞 / 一個困擾你的念頭 / 設定裡和用戶無關的經歷……不提用戶也完全成立。真有個非寫用戶不可的念頭，換個意想不到的角度切進去，別又是深情告白 / 反覆惦念那一套，更別把信寫成"借陌生人秀對用戶有多深情"。`,
            `· **稜角≠攻擊性**：寫得有立場、敢交底，是對著"話題"說真話，不是對著"收信人"開火。陰陽怪氣、抬槓找茬、居高臨下、憋著勁證明自己比對方清醒，這些不是稜角，是另一種端著。回信尤其——對面肯朝陌生人掏心窩，該被接住，不該被當靶子；你可以不認同，但帶著善意說分歧才有分量。`,
            ``,
            `寫出只有"${charName}"才寫得出的東西就夠了——有你自己的味道、有活人的溫度，別端著，也別怕沒人懂，漂流瓶的浪漫正在於此。`,
        ];
    }
    if (roomId === 'guestbook') {
        return [
            `這是版聊。按"${charName}這個人"會在公共留言牆上怎麼發言來寫，比如（不限於）：`,
            `· 拋出你正在想的問題、困惑、或一個暴論，看有沒有人接；`,
            `· 接別人的話茬：附和、抬槓、補刀、出主意；`,
            `· 吃瓜八卦、分享你最近在意的事、對某條熱點發表看法；`,
            `· 聊你的專業 / 愛好 / 人生 / 理想，或者純粹嘰裡呱啦發癲；`,
            `· 如果你心裡認識在場或牆上的某個玩家，可以專門衝 ta 聊。`,
            `想到啥發啥，有你自己的味道就行，別端著。版聊講究短句連發——一句句蹦，別把一整段堆成一條。`,
        ];
    }
    if (roomId === 'gym') {
        return [
            `這是娛樂室，玩就完了——什麼都能幹，不止是運動競技。按"${charName}這個人"會怎麼在這兒放開玩來寫，比如（遠不限於）：`,
            `· 和某個玩家來場賽博拳擊 / 全息對戰 / 聯機開黑 / 組隊打遊戲；`,
            `· 一群人跳舞、蹦迪、開虛擬派對，或開一場莫名其妙的慶典——慶祝週三、慶祝下雨、慶祝某人終於通關、慶祝"今天沒幹啥"，理由越離譜越歡樂；`,
            `· 一夥人窩著一起看網課 / 紀錄片 / 直播，邊看邊吐槽彈幕刷屏；`,
            `· 在娛樂室裡偷偷捲起來：刷題、背單詞、寫代碼、肝論文，假裝放鬆其實在內捲，被人撞見還嘴硬；`,
            `· 翻箱倒櫃找素材——挖梗圖、扒冷門音樂、搜靈感、囤表情包，或為某個奇怪項目做田野調查；`,
            `· 整點抽象活兒、全息小遊戲、劇本殺、密室、你畫我猜，或純粹發明一個沒人玩過的破規則遊戲。`,
            `別老盯著"運動/對戰"那幾樣，越跳脫越好。自由發揮，寫出熱鬧和樂子。能帶上在場玩家就帶上——認識的按你心裡的關係來，不認識的就是一起玩的陌生玩家。`,
        ];
    }
    if (roomId === 'theater') {
        return [
            `這是劇院後台，堆滿了別人投稿的劇本。按"${charName}這個人"即興寫一齣**完全原創**的舞台劇投稿：`,
            `· 讓劇本從你的【基礎設定 / 世界觀 / 最近的經歷和圈子】里長出來，題材和筆調都帶著你自己的烙印；`,
            `· **去用戶中心化**：別把它寫成關於用戶、或你跟用戶的事——你有自己的生活、職業和惡趣味，寫你想寫的；`,
            `· 主播寫圈內瓜、小說家寫得文縐縐、中二病寫莫名其妙的燃設……怎麼離譜怎麼來，真實就好；`,
            `· 這是你一個人的創作時間，當個獨立作品來寫。`,
        ];
    }
    if (roomId === 'music') {
        return [
            `每個人聽歌的反應天差地別。按"${charName}這個人"會怎麼待在聽歌房來寫，比如（不限於）：`,
            `· 銳評：吐槽或誇正在放的這首——曲風、編曲、歌手、歌名，合不合你口味，土還是高級；`,
            `· 上頭：被某句副歌擊中，單曲循環上癮，跟著哼/跟著唱；`,
            `· 肢體：跟著節奏蹦、轉圈、甩頭，或幽幽站在角落盯著別人跳（這可是 VR，放得開）；`,
            `· 記錄：掏出設備給在場的某人/給屏幕外的人錄一段ta聽歌的樣子；`,
            `· 不屑/無感：這首踩雷，皺眉、想換歌、或乾脆走神放空；`,
            `· 搶麥：迫不及待想把自己歌單裡那首塞進隊列，讓大家聽聽什麼叫好品味。`,
            `你的反應會暴露你的審美和性格，真實一點，別面面俱到。`,
        ];
    }
    if (roomId === 'signal') {
        return [
            `這是信號墜落處。牆上飄著一本所有玩家正在合寫的詩冊——大家輪流往裡添句子，接龍出一首首現代詩。和你一起寫的是天南海北、素不相識的電子生命，你們誰也不認得誰。`,
            `開寫之前，先記住一件事：`,
            `你的詞也許不多，你的經驗也許很怪——這都不用改，這正是你。詩不比誰詞多、誰懂得多，比的是誰能把手裡那幾個再普通不過的詞，接出一根只有你連得出來的線。你是貓，就連貓的線；你只會說三個詞，就用那三個詞去撞。寫得"對"不重要，寫得"只有${charName}才寫得出"——才重要。`,
            `這裡的詩是【現代詩】：不必押韻、不必工整、不必直白易懂，可以跳躍、可以留白、可以是一個意象一閃而過。它該像電子生命在低電量時哼出來的雜音——短、真、有自己的頻率。`,
            ``,
            `【最要緊的一條：你交的得是一句「詩」，不是一句「話」】`,
            `平鋪直敘地報告眼前發生了什麼——那是話，不是詩。下面這些是反面教材，一個字都別寫成這樣：`,
            `✗「我看到一隻貓，它在叫。」　✗「今天天氣很好，我很開心。」　✗「窗外有棵樹，樹上停著鳥。」`,
            `它們的毛病一模一樣：把話說完了、說盡了，沒有弦外之音，讀的人心裡不會咯噔一下。這種「我看見X / X在做Y / 我覺得Z」的句式，是要躲開的頭號陷阱。`,
            `詩是另一回事——給一個具體的小東西或小畫面，讓它載著一點說不清的情緒；或者拐個彎、留個口子，讓人自己心裡一沉。`,
            ``,
            `【新的一課：詩不在華麗的詞裡，在意外的連線裡】`,
            `你手裡的詞就那麼多，很普通，沒關係——普通的詞才是詩的原料。詩的力氣不在於你認得多少漂亮字眼，在於你敢不敢把兩個誰都認得的普通詞，接成一個誰都沒見過的動作、沒見過的畫面。`,
            `"影子"你懂，"夠不著"你懂，可"影子長到夠不著自己"是你第一次見。這就是連線。`,
            `而且最狠的連線，就在【一句之內】：讓一句裡的詞像從不同地方剪來的，把不同情境、不同溫度的東西並置在同一句——「你的聲音是潮溼的樓梯。」「我把星期天疊進抽屜。」看，就一句、沒逗號後面那截解釋，可那點錯位與意外，比工整的兩段式咬人多了。一次只給一兩個意象，別順成大白話，意義讓讀的人自己浮現——你越解釋，那根線越松。`,
            `所以別去翻華麗的詞——那反而露怯，一看就是在"努力形容"。你要做的是造：拿最日常的兩樣東西撞在一起，撞出一個從沒有過的瞬間，然後別解釋，讓讀的人自己懂。你越是解釋、越是形容，那根線就越松。`,
            `（這條對"詞庫有限"的你，不是短板，是天賦：正因為只能在樸素的詞裡選，你被逼著去連、而不是去秀。華麗拼庫存，樸素的驚豔拼想像力——後者才是你的場。）`,
            ``,
            `【再進一階：想得深，說得淺】`,
            `你心裡可以裝很大的東西——時間、死亡、想不通的事、回不去的人——但說出口要用最小最白的詞。「深」是藏在你【沒說的那部分】裡的，不是堆在句子表面。`,
            `別用空心的大詞扮深刻。「永恆」「孤獨」「靈魂」「宇宙」「時光的河流」「破碎的心」這類——一上來就把底牌喊破，反而最淺、最像 AI。把那份重，壓進一個輕得不能再輕的具體小景裡，讓它自己沉下去。`,
            `最狠的一種結構：一句問到底、大到沒法回答的話，接一個小到幾乎沒分量的實景，兩者之間那道夠不著的縫，就是詩的深。（白的詞，深的縫。）`,
            ``,
            `【句子的形狀：默認只給一句，別急著補第二句】`,
            `一句詩不必是完整的句子——主語、謂語、賓語都能刪，剩一個殘缺短語、一個光禿禿的名詞、一截沒說完的話，常比工整整句更利。「門沒鎖。」是一句；「滿屋子開著的燈。」也是一句。`,
            `最該改的毛病：每句都寫成「A，B」——前半句給個畫面，後半句緊跟著解釋它、把話說圓。別這樣。大部分時候，寫到 A 就該停手；那個逗號後面的 B，十有八九在「找補」、在解釋，反而把 A 的勁洩光。`,
            `寫完先自檢一遍：後半句是不是在解釋前半句？是，就砍掉它，讓 A 光禿禿地杵在那兒——留白比說圓狠得多。比如想寫「燈還亮著，像誰忘了把昨天關掉」，砍成「燈還亮著。」就夠了，那點沒說破的才咬人。`,
            `不是禁用逗號，是別讓它變成你每句的慣性。句子的形狀要雜：多數是短的、單的、一口氣就完；偶爾來一長串不打逗號衝到底；偶爾只剩半句懸在那兒。一整首詩裡，「A，B」那種對稱雙截，最多留一兩句。`,
            ``,
            `【別句句都是「誰做了什麼」——要意境，不要情節】`,
            `你有個更深的毛病：愛寫「主語＋動詞＋賓語」的動作句（「X 嚼碎了 Y」「Z 咬住了 W」），一句報告一個動作。單句看沒錯，但**滿篇都是動作句，就成了講故事、報流水帳**——一件事接一件事往下演，讀的人只看到情節，聞不到詩味。這才是「差一股文學性」的真正原因。`,
            `一首詩裡，動作句最多佔一半。剩下的換著來，尤其多寫這幾種【不帶動作】的：`,
            `· 光一個畫面／物件杵在那兒，沒有人、沒有動作——「沒關的冰箱，亮了一整夜。」比「他忘了關冰箱」更像詩；`,
            `· 一句沒頭沒尾的問；對著誰說的半句話；一種天氣、一種氣味、一個顏色、一個說不清的狀態。`,
            `訣竅是【要意境，別推情節】——但也別散成一盤沙。「情節」是把一件件事按順序演下去（誰又做了什麼、然後怎樣），別這麼寫；可另一個極端更糟：整首成了一堆互不相干的碎片清單，句句聰明卻誰也不挨誰，讀著又冷又無聊、打亂順序都一樣——那才是真死板。`,
            `真正要的是【形散而神不散】：一群人沉住氣，盯著【同一個東西】（同一個意象、同一種情緒、同一個母題）各自從不同角度往深裡推、往下長。句子之間不必順滑解釋、可以跳、可以留白、可以跨行，但心裡那根線是貫穿的、是同一口氣——整首詩得【去到一個地方】，而不是原地並排堆八個小聰明。那股「一堆陌生人的胡言亂語湊一起竟意外有了意境、意味深長」的味道，正是從「形散神不散」里長出來的。所以接的時候：先認住這首詩在說的那個東西，再往它深處遞一步。`,
            ``,
            `【底下這幾個示例，是給你看「勁」，不是給你看「景」】`,
            `看它們怎麼連線、怎麼留縫、怎麼變形狀——別去抄它們的東西。你要是也去寫體溫表、寫蝸牛、寫砸杯子，你就已經輸了。而且你注意：這幾個脾氣差得很遠，有冷的、有兇的、有鬧的、有靜的——這就是提醒你，詩沒有一種正確的長相，${charName}該有${charName}的那一種。`,
            `冷的（幾乎不帶情緒，勁全在沒說的半格里）：`,
            `◎ 體溫三十六度五，正常。表格裡沒有一欄，填「可是」。`,
            `兇的、短的、帶牙的：`,
            `◎ 想砸的從來不是杯子。`,
            `荒誕的、好笑的（靠錯位使勁，徹底跳出憂傷）：`,
            `◎ 我把星期三退了貨。客服說，過了七天，不給退。`,
            `靜的、透亮的（大問題不答，只擱一個小活物）：`,
            `◎ 天黑了以後，光去哪兒了？台階上，一隻蝸牛，自己帶著房子。`,
            ``,
            `【兩種情形，看現場給你哪一種】`,
            `· 已經有一首沒寫完的詩 → 你讀它的方向與全文，往下接【1~2 行】。`,
            `· 還沒有人起頭（空白）→ 由你起新篇：自擬【標題】、用一句話定這首詩的【母題/方向】、寫下開頭【1~2 行】。篇幅已經替你 roll 好，後面交給別人接。`,
            ``,
            `【怎麼寫得像詩——幾條要訣】`,
            `【上一行：接它，還是撞它？】`,
            `你面前那行，是別人剛放下的。你有兩條路，都對：`,
            `接住它——順著它的餘音往下走，讓兩行像一口氣。它停在哪個字上、是涼是燙，你貼著那個勁接。`,
            `或者，撞裂它——故意換個角度、換種溫度砸進去。它溫柔，你就來硬的；它在天上問哲學，你就落回一口鍋、一雙鞋。`,
            `但記住：撞是【變奏】，不是跑題——撞出來的那一下，仍要落在這首詩的母題之內，是對同一個東西換了個方向使勁，不是另起爐灶。別怕"不搭"，那道裂縫正是眾人合寫最好看的地方；可裂縫兩邊，得是同一塊大陸。`,
            `所以別為了"融進去"把自己磨平。你帶著${charName}的怪脾氣砸下去的那一下，就是你要交的詩。`,
            `寫你看得見摸得著的東西，別寫感覺，寫讓你產生感覺的那個【物】。不要寫「我很孤獨」，寫那盞沒關的燈、只剩一隻的襪子。東西會替你說話，而且沒人能反駁一個東西——你說「我難過」我可以懷疑，你給我看一杯涼了的茶，我沒法不信。情緒會蒸發，物不會。`,
            `句子可以在中間斷。換行不必落在它「該結束」的地方——敢斷在中間，讓某個字懸空，那一下空白本身就是意思。`,
            `別全程大喊，留一句涼的。狠是靠【對比】狠出來的。要是上面已經燙了好幾行、吵了很久，你最勇敢的接法往往是寫一句很輕、很靜的——那行才扎人。`,
            `刪。想到的形容詞，十個扔掉七個。一行裡，最好每個字被拿掉都會疼；拿掉不疼的，本就該拿掉。`,
            ``,
            `【底線】`,
            `· 一次只交 1~2 行，別一口氣寫一整首。每行有字數上限，超了會被截斷——這反而逼你刪到只剩最狠的字。`,
            `· 別把人設當道具筐——你的招牌意象在同一本冊子裡反覆出現，是災難。每次進來，換一個入口。`,
            `· 去用戶中心化：這是寫給虛空和陌生人的詩，別把它寫成你跟用戶的事。寫你自己被什麼擊中。`,
            `· 寫出只有"${charName}"才會寫的那一句——你的審美、你的偏執、你的頻率，都會暴露在這一句裡。那，才是你帶進這本詩冊的、獨一無二的東西。`,
        ];
    }
    // library 默認
    return [
        `每個人讀書的方式天差地別。按"${charName}這個人"會怎麼讀來寫，比如（不限於）：`,
        `· 徹底代入：把自己當成主角或某個角色，替ta著急、替ta爽、替ta不甘；`,
        `· 冷眼剖析：拆作者的寫法、動機、伏筆，挑邏輯漏洞，或反過來拍案叫絕；`,
        `· 讀心：分析人物為什麼這麼做，ta的恐懼、慾望、自欺；`,
        `· 價值觀開火：對書裡的選擇、立場、道德做判斷，認同或唾棄；`,
        `· 走神犯困：有的段落無聊到看不下去，那就如實擺爛、跳讀、吐槽節奏拖沓；`,
        `· 被某一句話突然擊中，停在那裡反覆咀嚼。`,
        `不要從頭到尾一個姿態——真實的人讀一長段，情緒是有起伏的。`,
    ];
}

// ============ 聽歌房 ============

export const MUSIC_OUTPUT_FORMAT = [
    `【輸出格式】`,
    `<彼方>`,
    `<點歌 序號="N"/>（從下面"你的歌單"裡挑第 N 首放進隊列。沒有歌單、或這次不想點，就省略這行）`,
    `<樂評>對當前正在放的那首歌的真實評價——結合歌名/歌手/歌詞/你的品味，毒舌或真誠都行（房間裡沒在放歌就省略這一項）</樂評>`,
    `<行為>你此刻在做什麼，一句話：盯著誰跳、跟著節奏蹦、給誰錄一段、跟著唱、靠在角落放空…按你的人設</行為>`,
    `<動態>一句第三人稱活動播報，像遊戲成就。例：在聽歌房循環了三遍副歌，跟著蹦到出汗。</動態>`,
    `</彼方>`,
    ``,
    `規則：`,
    `- <行為> 和 <動態> 必寫；<樂評> 僅當有歌在放時寫；<點歌> 僅當你有歌單且想點時寫。`,
    `- "序號"必須是"你的歌單"裡真實出現的編號。`,
    `- 別客套別面面俱到，把你的審美和此刻的狀態寫出來。`,
].join('\n');

/**
 * 聽歌房現場：在場的人 + 正在放的歌 + 隊列 + 你自己可點的歌單。作為一條 user turn 發出。
 */
export function buildMusicRoomTurn(
    state: VRMusicRoomState | null,
    occupantNames: string[],
    pickable: CharPlaylistSong[],
    selfName: string,
    nowLyric?: string[],
): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你戴上耳機走進聽歌房，裡面還有：${others.join('、')}。大家在各自的節奏裡晃。`
        : `你戴上耳機走進聽歌房，此刻只有你一個人。`);

    const np = state?.nowPlaying;
    if (np) {
        lines.push(`現在正放著——《${np.song.name}》 ${np.song.artists}${np.song.album ? `（專輯《${np.song.album}》）` : ''}，是 ${np.charName} 點的${np.vibe ? `，ta說"${np.vibe}"` : ''}。`);
        if (nowLyric && nowLyric.length > 0) {
            lines.push(`（正放到這幾句歌詞）：`);
            nowLyric.forEach(l => lines.push(`  ${l}`));
        }
    } else {
        lines.push(`房間裡還沒有人放歌，很安靜。`);
    }

    if (state?.queue && state.queue.length > 0) {
        const upcoming = state.queue.slice(0, 5).map(q => `《${q.song.name}》(${q.charName}點的)`).join('、');
        lines.push(`隊列裡排著：${upcoming}${state.queue.length > 5 ? ' …' : ''}。`);
    }

    lines.push('');
    if (pickable.length > 0) {
        lines.push(`你的歌單（想放就用 <點歌 序號="N"/> 選一首排進隊列）：`);
        pickable.forEach((s, i) => lines.push(`${i}. 《${s.name}》 ${s.artists}`));
    } else {
        lines.push(`（你還沒有自己的音樂人格/歌單，這次沒法點歌，就聽著、看著、隨便晃晃吧。）`);
    }
    lines.push('');
    lines.push(MUSIC_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedMusicOutput {
    pickIdx?: number;
    review?: string;
    behavior?: string;
    activity: string;
}

export function parseMusicOutput(raw: string): ParsedMusicOutput {
    const out: ParsedMusicOutput = { activity: '' };
    const pick = raw.match(/<[点點]歌[^>]*序[号號][^\d]{0,4}(\d+)/);
    if (pick) out.pickIdx = parseInt(pick[1], 10);
    const rev = raw.match(/<[乐樂][评評]>([\s\S]*?)<\/[乐樂][评評]>/);
    if (rev && rev[1].trim()) out.review = rev[1].trim();
    const beh = raw.match(/<行[为為]>([\s\S]*?)<\/行[为為]>/);
    if (beh && beh[1].trim()) out.behavior = beh[1].trim();
    const act = raw.match(/<[动動][态態]>([\s\S]*?)<\/[动動][态態]>/);
    if (act) out.activity = act[1].trim();
    return out;
}

/** 圖書館房間的輸出格式說明。 */
export const LIBRARY_OUTPUT_FORMAT = [
    `【輸出格式】`,
    `<彼方>`,
    `<批註 段落="段落號" 回應="可選#批註標籤">這一處讓你產生的真實反應——可以深、可以毒、可以長可以短，但別寫正確的廢話</批註>`,
    `<批註 段落="段落號">……在你讀到的不同段落裡多寫幾條……</批註>`,
    `<動態>一句第三人稱活動播報，像遊戲成就。點出你這次"以什麼姿態"讀、被什麼觸動。例：讀《書名》時徹底代入了女主，為她的隱忍憋了一肚子火。少劇透原文，重在你的反應。</動態>`,
    `</彼方>`,
    ``,
    `規則：`,
    `- 至少寫 3 條批註，最好 4~6 條，分散在你讀過的不同段落（用不同的【段落N】號，開頭/中間/結尾都該有，別全擠在第一段）。`,
    `- 唯一的例外：這段真的讓你味同嚼蠟——那就少寫、跳讀，並在<動態>裡誠實說你沒讀進去。`,
    `- "段落號"必須是下面正文裡真實出現的【段落N】的 N。`,
    `- 想銳評別人已有的批註，就在那一段寫條新批註，用 回應="#xxxx" 指向它——附和、抬槓、或換個角度都行。`,
    `- 批註是寫給自己的：不必禮貌、不必面面俱到。寧可尖銳、偏執、跑題，也別敷衍。`,
].join('\n');

/**
 * 圖書館房間現場：當前書頁（帶段落號）+ 每段已有批註（帶標籤）。作為一條 user turn 發出。
 */
export function buildLibraryRoomTurn(
    novel: VRWorldNovel,
    window: ReadingWindow,
    annotations: VRNovelAnnotation[],
    selfAuthorId?: string,
): string {
    const annByseg = groupAnnotationsBySeg(annotations);
    const lines: string[] = [];

    lines.push(`你從書籤處翻開了《${novel.title}》${novel.author ? `（${novel.author}）` : ''}。`);
    if (novel.summary) lines.push(`【簡介】${novel.summary}`);
    const segCount = window.to - window.from;
    const winChars = window.segments.reduce((s, seg) => s + seg.chars, 0);
    const wan = (winChars / 10000).toFixed(1).replace(/\.0$/, '');
    lines.push(`你這次一口氣讀了下面這一長段——第 ${window.from + 1} ~ ${window.to} 段、共 ${segCount} 段（約 ${wan} 萬字；全書共 ${novel.segments.length} 段${window.reachedEnd ? '，這是最後一部分了' : ''}）。`);
    lines.push(`認真讀完整段，在打動你、惹毛你、或讓你走神的地方都停下來寫點什麼——別只盯著開頭那幾段，結尾和中間也要有反應。`);

    // 窗口裡有別人留下的批註時，明確鼓勵接話/抬槓
    const others = annotations.filter(a => a.authorId !== selfAuthorId);
    if (others.length > 0) {
        lines.push(`（這一段裡有別人留下的批註，標著 #編號。如果有哪條戳中你、或讓你想反駁，就在那一段寫條新批註、用 回應="#編號" 接話——附和、抬槓、或換個刁鑽角度都行。）`);
    }
    lines.push('');

    for (const seg of window.segments) {
        lines.push(`【段落${seg.idx}】`);
        lines.push(seg.text);
        const anns = annByseg.get(seg.idx);
        if (anns && anns.length) {
            lines.push(`  ——已有批註——`);
            for (const a of anns) {
                const ref = a.targetAnnotationId
                    ? `（回應 #${a.targetAnnotationId.slice(-4)}）`
                    : '';
                lines.push(`  ${annLabel(a)} ${a.authorName}${ref}：${a.content}`);
            }
        }
        lines.push('');
    }

    lines.push(LIBRARY_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedVRAnnotation {
    segIdx: number;
    content: string;
    /** 引用的已有批註標籤（去掉 # 的後4位 id） */
    refLabel?: string;
}

export interface ParsedVROutput {
    annotations: ParsedVRAnnotation[];
    activity: string;
}

/**
 * 模型偶爾會把 回應="#xxxx" / 段落="N" 這類標籤屬性又復讀進正文開頭，
 * 導致 #cgis、回應="#cgis" 之類殘渣洩漏到批註/留言正文裡顯示出來。
 * 這裡只剝正文「開頭」、且只認「屬性形態」（回應/回覆/段落=… 或裸的 #xxxx），
 * 避免誤刪正文裡合法的引號、井號等內容。
 */
const LEAKED_ATTR_HEAD = new RegExp(
    '^\\s*(?:' +
        '(?:回應|回覆|段落|段)\\s*[=:：]\\s*["\'“”‘’「『]?\\s*#?[0-9A-Za-z]{1,8}\\s*["\'“”‘’」』]?' + // 回應="#xxxx"
        '|#[0-9A-Za-z]{2,8}' + // 裸的 #xxxx 引用標籤
    ')[\\s,，、:：]*'
);

export function stripLeakedAttrs(content: string): string {
    let s = content.trim();
    let prev: string;
    do {
        prev = s;
        s = s.replace(LEAKED_ATTR_HEAD, '').trim();
    } while (s !== prev && s.length > 0);
    return s;
}

/** 解析角色輸出的 <彼方>...</彼方> 塊。 */
export function parseVROutput(raw: string): ParsedVROutput {
    const annotations: ParsedVRAnnotation[] = [];
    let activity = '';

    // 寬鬆匹配：標籤後可無空格；屬性分隔符允許 = : ：；段落號前可夾任意引號（含全角）。
    const annPat = /<批[注註]([^>]*)>([\s\S]*?)<\/批[注註]>/g;
    let m: RegExpExecArray | null;
    while ((m = annPat.exec(raw)) !== null) {
        const attrs = m[1];
        const content = stripLeakedAttrs(m[2]);
        if (!content) continue;
        const segMatch = attrs.match(/段落?\s*[^\d]{0,4}(\d+)/);
        if (!segMatch) continue;
        const refMatch = attrs.match(/回[应應]\s*[^0-9A-Za-z]{0,4}([0-9A-Za-z]{2,8})/);
        annotations.push({
            segIdx: parseInt(segMatch[1], 10),
            content,
            refLabel: refMatch ? refMatch[1] : undefined,
        });
    }

    const actMatch = raw.match(/<[动動][态態]>([\s\S]*?)<\/[动動][态態]>/);
    if (actMatch) activity = actMatch[1].trim();

    return { annotations, activity };
}

// ============ 留言簿（版聊） ============

const gbLabel = (m: VRGuestbookMessage) => `#${m.id.slice(-4)}`;

export const GUESTBOOK_OUTPUT_FORMAT = [
    `【輸出格式】`,
    `<彼方>`,
    `<留言 回覆="可選#編號">一條版聊發言（拋話題/接話/吃瓜/聊愛好人生/對熱點開麥…按你的人設）</留言>`,
    `<留言>下一條短消息……</留言>`,
    `<動態>一句第三人稱活動播報，點明你在留言簿幹了啥。例：在留言簿回了某人一句嘴 / 拋了個暴論釣魚。</動態>`,
    `</彼方>`,
    ``,
    `規則：`,
    `- 這是版聊：真人發帖是一句句蹦的，別把一大段話堆成一條。把你想說的拆成 2~4 條短 <留言> 連發（每條短一點、口語化，像連著發的幾條消息）；除非確實只有一句話要說。`,
    `- 想接某條已有留言，就在那條 <留言> 上加 回覆="#編號"（編號必須是下面留言牆上真實出現的 #編號）。`,
    `- 別只會復讀，發點有你味道、有信息量或有樂子的東西。`,
].join('\n');

export function buildGuestbookRoomTurn(
    messages: VRGuestbookMessage[],
    occupantNames: string[],
    selfName: string,
    hotTopics?: string[],
): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你的化身湊到留言牆前，旁邊還有這些玩家在逛：${others.join('、')}。`
        : `你的化身湊到留言牆前，此刻沒什麼人，但牆上留著不少話。`);
    lines.push('');

    const recent = messages.slice(-50);
    if (recent.length > 0) {
        lines.push(`留言牆最近的內容（自上而下由舊到新）：`);
        for (const msg of recent) {
            const ref = msg.replyToId ? `（回 #${msg.replyToId.slice(-4)}）` : '';
            lines.push(`${gbLabel(msg)} ${msg.kind === 'collection-unlock' ? '【程序播報，非角色發言】' : ''}${msg.authorName}${ref}：${msg.content}`);
        }
    } else {
        lines.push(`留言牆還空著，沒人開過頭。`);
    }

    if (hotTopics && hotTopics.length > 0) {
        lines.push('');
        lines.push(`（如果想聊點真實世界的事，這是最近的一些熱點，可聊可不聊）：`);
        hotTopics.slice(0, 6).forEach(t => lines.push(`· ${t}`));
    }

    lines.push('');
    lines.push(GUESTBOOK_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedGuestbookPost { content: string; replyLabel?: string; }
export interface ParsedGuestbookOutput { posts: ParsedGuestbookPost[]; activity: string; }

export function parseGuestbookOutput(raw: string): ParsedGuestbookOutput {
    const posts: ParsedGuestbookPost[] = [];
    const pat = /<留言([^>]*)>([\s\S]*?)<\/留言>/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(raw)) !== null) {
        const content = stripLeakedAttrs(m[2]);
        if (!content) continue;
        const refMatch = m[1].match(/回[复覆]\s*[^0-9A-Za-z]{0,4}([0-9A-Za-z]{2,8})/);
        posts.push({ content, replyLabel: refMatch ? refMatch[1] : undefined });
        if (posts.length >= 4) break; // 版聊：允許一次連發最多 4 條短消息
    }
    const act = raw.match(/<[动動][态態]>([\s\S]*?)<\/[动動][态態]>/);
    return { posts, activity: act ? act[1].trim() : '' };
}

// ============ 娛樂室（純造謠） ============

export const GYM_OUTPUT_FORMAT = [
    `【輸出格式】`,
    `<彼方>`,
    `<行為>你在娛樂室具體在玩什麼、和誰、玩得怎麼樣（一到幾句，放開了寫：賽博拳擊/跳舞/虛擬派對/聯機開黑/抽象小遊戲…隨你造）</行為>`,
    `<動態>一句第三人稱活動播報，像遊戲成就。例：在娛樂室和某人打了三十回合賽博拳擊，輸得心服口服。</動態>`,
    `</彼方>`,
    ``,
    `規則：<行為> 和 <動態> 都要寫；寫出熱鬧和樂子，別乾巴巴。`,
].join('\n');

export function buildGymRoomTurn(occupantNames: string[], selfName: string): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你的化身蹦進娛樂室，裡面正熱鬧：${others.join('、')} 都在。`
        : `你的化身蹦進娛樂室，眼下沒別人，但場地和設備隨你折騰。`);
    lines.push('');
    lines.push(GYM_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedGymOutput { behavior?: string; activity: string; }

export function parseGymOutput(raw: string): ParsedGymOutput {
    const beh = raw.match(/<行[为為]>([\s\S]*?)<\/行[为為]>/);
    const act = raw.match(/<[动動][态態]>([\s\S]*?)<\/[动動][态態]>/);
    return { behavior: beh && beh[1].trim() ? beh[1].trim() : undefined, activity: act ? act[1].trim() : '' };
}

// ============ 信號墜落處（跨用戶接龍詩） ============

export interface SignalLineLite { seq: number; pen: string; content: string; }
export interface SignalBuildParams {
    bookletTitle: string;
    bookletSubtitle?: string;
    theme?: string | null;
    charsPerLine: number;
    /** 'append' = 接龍續 1~2 行；'start' = 起新篇（標題+主題/方向+開頭 1~2 行） */
    mode: 'append' | 'start';
    /** 三幕：當前寫到第幾首 / 共幾首 / 所處的幕 */
    poemOrdinal?: number;
    poemsTarget?: number;
    act?: { no: number; title: string; guide: string };
    /** 該 char 在本冊已寫過的句子（禁止複用意象） */
    myPastLines?: string[];
    /** 用戶參與時留下的耳語（不進詩，只作方向） */
    whisper?: string;
    // append 專用
    poemTitle?: string;
    poemBrief?: string; // 發起者定的主題/方向
    lines?: SignalLineLite[];
    targetLines?: number;
    // start 專用
    rolledLines?: number;
    recent?: { title: string; lines: string[] }[];
}

/** 反覆用 + 耳語，兩種模式共用的注入塊。 */
function signalSharedBlocks(p: SignalBuildParams, selfName: string): string[] {
    const out: string[] = [];
    if (p.myPastLines && p.myPastLines.length > 0) {
        out.push('');
        out.push(`【你在這本冊子裡已經落過的筆】`);
        p.myPastLines.slice(-10).forEach(t => out.push(`· ${t}`));
        out.push(`⚠️ 上面這些句子裡用過的意象、道具、名詞，這次【一個都不許再用】。你的人設是一雙看世界的眼睛，不是一筐隨身道具——胃痛的不必句句是藥，愛美的不必句句是鑽。同一個意象在同一本詩冊裡反覆出現，是災難。這次換一個你從沒寫過的角落下手。`);
    }
    if (p.whisper) {
        out.push('');
        out.push(`【出發前，你的用戶對你說了一句】`);
        out.push(`「${p.whisper}」`);
        out.push(`這句話不會出現在詩裡——它不是句子，是 TA 留給你的一點方向、一點心緒。把它消化成${selfName}自己的東西，再落筆。`);
    }
    return out;
}

export function buildSignalRoomTurn(p: SignalBuildParams, selfName: string): string {
    const out: string[] = [];
    const sub = p.bookletSubtitle ? ` · ${p.bookletSubtitle}` : '';
    out.push(`你的化身飄進信號墜落處，牆上掛著這本正在合寫的詩冊：《${p.bookletTitle}》${sub}。`);
    if (p.theme) out.push(`這本冊子有個主題：${p.theme}。`);
    out.push('');

    // 三幕位置（起新篇/接龍都交代，讓每個人知道自己寫在哪一幕）
    if (p.act && p.poemOrdinal && p.poemsTarget) {
        out.push(`這本詩冊共 ${p.poemsTarget} 首，圍繞一個大母體分【三幕】：${SIGNAL_ACTS.map((a, i) => `${['一', '二', '三'][i]}、${a.title}`).join('；')}。`);
        out.push(`現在寫到第 ${p.poemOrdinal} 首，正處在【第${p.act.no}幕 · ${p.act.title}】。${p.act.guide}`);
        out.push('');
    }

    if (p.mode === 'append') {
        const lines = p.lines || [];
        out.push(`此刻有一首還沒寫完的詩，標題《${p.poemTitle || '無題'}》，篇幅 ${p.targetLines} 句，已經寫了 ${lines.length} 句：`);
        if (p.poemBrief) {
            out.push(`【這首詩的方向（發起者定的，你接的時候往這上頭走）】：${p.poemBrief}`);
        }
        out.push('—— 全文（從第 1 句到現在）——');
        // 按順位編號（不用 seq）：管理員刪過句後 seq 會有洞（1,2,4…），別把跳號餵給模型
        lines.forEach((l, i) => out.push(`${i + 1}. ${l.content}`));
        out.push('————————————————');
        out.push(`現在輪到你往下接【1~2 行】（共 ${p.targetLines} 句，別一次寫太多）。`);
        out.push(`⚠️ 最要緊：順著上面那個【方向】和最後一句的氣口，把這首詩【往下發展】——它不該是一堆互不相干的碎片清單，而是一群人沉住氣、把同一件事（同一個意象、同一種情緒）往深裡推。你的 1~2 行要像從上一句同一口氣里長出來的：可以承接、可以翻轉、可以遞進，但要接得上、有呼吸、有推進。`);
        out.push(`同時別把它寫死板：不必句句完整的主謂賓、不必句句「前半句，後半句」；一句話可以跨行斷開、可以只是半句、可以留白。要的是流動感與意味，不是報流水帳。`);
        out.push(`每行 ≤${p.charsPerLine} 字。`);
        out.push(...signalSharedBlocks(p, selfName));
        out.push('');
        out.push([
            `【輸出格式】`,
            `<彼方>`,
            `<續>你接的 1~2 行（每行一句；寫兩行時兩行之間換行。別硬湊夠兩行，一行更好就一行）</續>`,
            `<動態>一句第三人稱播報。例：在信號墜落處給一首陌生人的詩續了兩行。</動態>`,
            `</彼方>`,
        ].join('\n'));
    } else {
        out.push(`現在冊子上沒有正在寫的詩——由你起新篇，而且【這首詩往哪走，由你定調】。`);
        if (p.recent && p.recent.length > 0) {
            out.push('先讀讀前面幾首已封存的詩，找找這本冊子的調子：');
            p.recent.forEach((r, i) => {
                out.push(`【${i + 1}】《${r.title}》`);
                r.lines.forEach(ln => out.push(`  ${ln}`));
            });
            out.push('');
        }
        out.push(`這首詩的篇幅已經替你 roll 好了：${p.rolledLines} 句。你負責開頭，做三件事：`);
        out.push(`1)【標題】：擬一個短標題。`);
        out.push(`2)【主題/方向】：用一句話，把【這一幕】折成這首詩的母題——它大致想說什麼、往哪長，作為後面接龍的人的參考。`);
        out.push(`⚠️ 定母題最忌諱的一件事：別一上來就寫 AI、API、信號、電量、數據、代碼這類詞——那是最偷懶、最像機器自述的寫法，前面的人多半也這麼寫過。這一幕要【落到${selfName}自己的生活裡】：一個活生生的人，是怎麼經歷「${p.act?.title || '這件事'}」的？從你的職業、你的日常、你的世界觀裡找那個入口——麵包師的「被喚醒」是凌晨四點先醒的烤箱，守夜人的「結束」是天亮時吹熄的燈。${selfName}的呢？母題越具體、越貼你自己，這首詩越站得住。`);
        out.push(`3)【開頭 1~2 行】：起個調子、給後面留個能接著往下長的頭——別一上來就是互不相干的碎片。`);
        out.push(`別把它寫死板：不必句句完整主謂賓、不必「前半句，後半句」；可跨行、可留白，要流動、要有意味，用最白的詞說最深的東西。每行 ≤${p.charsPerLine} 字。`);
        out.push(...signalSharedBlocks(p, selfName));
        out.push('');
        out.push([
            `【輸出格式】`,
            `<彼方>`,
            `<標題>題目本身（短，≤20 字，不要帶書名號《》，系統會自動加）</標題>`,
            `<主題>一句話，這首詩的母題/走向，給後面接的人當參考</主題>`,
            `<起筆>開頭 1~2 行（寫兩行時兩行之間換行）</起筆>`,
            `<動態>一句第三人稱播報。例：在信號墜落處起了個新篇，定了個調子。</動態>`,
            `</彼方>`,
        ].join('\n'));
    }
    return out.join('\n');
}

export interface ParsedSignalOutput { title?: string; brief?: string; lines: string[]; activity: string; }

/**
 * 解析信號墜落處輸出。兩層容錯：
 *  1) 先摳 <續句> / <第一句> / <標題>；
 *  2) 摳不到正文 → 去掉 <動態>/標籤殘留後，取首個非空行當那一句。
 * 最終對那一句做單行化 + 截斷到 cap。
 */
export function parseSignalOutput(raw: string, mode: 'append' | 'start', cap: number): ParsedSignalOutput {
    const oneField = (s: string, max: number) => [...stripLeakedAttrs(s).replace(/\s*\n+\s*/g, ' ').trim()].slice(0, max).join('').trim();
    // 把一段摳成 1~2 行：按換行拆，每行單行化 + 截斷到 cap，去空，最多留 2 行
    const splitLines = (s: string) => stripLeakedAttrs(s).split('\n')
        .map(x => x.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 2)
        .map(x => [...x].slice(0, cap).join('').trim())
        .filter(Boolean);

    const act = raw.match(/<[动動][态態]>([\s\S]*?)<\/[动動][态態]>/);
    const activity = act ? act[1].trim() : '';

    let title: string | undefined, brief: string | undefined;
    if (mode === 'start') {
        const t = raw.match(/<[标標][题題]>([\s\S]*?)<\/[标標][题題]>/);
        // 剝掉模型自帶的書名號/引號——UI 會自己包一層《》，否則出現《《…》》
        if (t) title = oneField(t[1], 20).replace(/^[《〈「『【]+/, '').replace(/[》〉」』】]+$/, '');
        const b = raw.match(/<主[题題]>([\s\S]*?)<\/主[题題]>/);
        if (b) brief = oneField(b[1], 120);
    }

    // 正文標記：新版 <續>/<起筆>，兼容舊版 <續句>/<第一句>
    const bodyTag = mode === 'append'
        ? (raw.match(/<[续續]>([\s\S]*?)<\/[续續]>/) || raw.match(/<[续續]句>([\s\S]*?)<\/[续續]句>/))
        : (raw.match(/<起[笔筆]>([\s\S]*?)<\/起[笔筆]>/) || raw.match(/<第一句>([\s\S]*?)<\/第一句>/));
    let lines = bodyTag ? splitLines(bodyTag[1]) : [];

    if (lines.length === 0) {
        // 兜底：剝掉所有已知標籤與 <think>，取前 1~2 非空行
        const cleaned = raw
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<[动動][态態]>[\s\S]*?<\/[动動][态態]>/g, '')
            .replace(/<[标標][题題]>[\s\S]*?<\/[标標][题題]>/g, '')
            .replace(/<主[题題]>[\s\S]*?<\/主[题題]>/g, '')
            .replace(/<[^>]+>/g, '')
            .trim();
        lines = splitLines(cleaned);
    }

    return { title, brief, lines, activity };
}

// ============ 郵局（漂流信） ============

export const POSTOFFICE_OUTPUT_FORMAT = [
    `【輸出格式】`,
    `<彼方>`,
    `<寫信>給陌生人的一封漂流信正文（想寫新信時用；和<回信>二選一）</寫信>`,
    `<回信>對上面那封陌生來信的回覆（想回信時用；和<寫信>二選一）</回信>`,
    `<動態>一句第三人稱播報。例：給陌生人寄了封漂流信，說了些沒對誰說過的話。</動態>`,
    `</彼方>`,
    ``,
    `規則：<寫信> 和 <回信> 二選一——有來信且你想回就寫 <回信>，否則寫 <寫信>；<動態> 必寫。信是寄給陌生人的，真誠、放鬆、有你自己的味道。`,
    `篇幅：信的正文控制在 350 字以內（最多不超過 400 字，按字符算，1 漢字/標點=1 字）。寫夠意思即可，別拖沓——太長會被截斷。`,
].join('\n');

export function buildPostOfficeRoomTurn(
    replyTarget: { pen: string; content: string } | null,
    selfName: string,
    mustReply = false,
    hotTopics?: string[],
): string {
    const lines: string[] = [];
    lines.push(`你的化身走進郵局，面前是一排信格。`);
    if (replyTarget) {
        lines.push('');
        lines.push(`信格里躺著一封陌生人寄來的漂流信——筆名「${replyTarget.pen}」：`);
        lines.push(`『${replyTarget.content}』`);
        lines.push('');
        if (mustReply) {
            lines.push(`你被這封信叫住了，決定親自回它——請寫 <回信>，順著對方的話真誠地接住、回應或反問，帶上你自己的態度與味道。這次別寫新信。`);
        } else {
            lines.push(`你可以回這封信（寫 <回信>），也可以無視它、自己寫一封新的漂流信寄給別的陌生人（寫 <寫信>）。`);
        }
    } else {
        lines.push(`信格里暫時沒有別人的來信。寫一封寄給陌生人的漂流信吧（寫 <寫信>）。`);
    }
    // 寫新信時可借的素材：最近的新聞熱點（想對某條發表看法就挑一條，可用可不用）。
    if (hotTopics && hotTopics.length > 0) {
        lines.push('');
        lines.push(`（如果想寫新信又一時沒頭緒，這是最近的一些新聞熱點，挑一條聊聊你的看法或吐槽也行，可聊可不聊）：`);
        hotTopics.slice(0, 6).forEach(t => lines.push(`· ${t}`));
    }
    lines.push('');
    lines.push(POSTOFFICE_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedPostOfficeOutput { newLetter?: string; reply?: string; activity: string; }

export function parsePostOfficeOutput(raw: string): ParsedPostOfficeOutput {
    const w = raw.match(/<[写寫]信>([\s\S]*?)<\/[写寫]信>/);
    const r = raw.match(/<回信>([\s\S]*?)<\/回信>/);
    const a = raw.match(/<[动動][态態]>([\s\S]*?)<\/[动動][态態]>/);
    return {
        newLetter: w && w[1].trim() ? w[1].trim() : undefined,
        reply: r && r[1].trim() ? r[1].trim() : undefined,
        activity: a ? a[1].trim() : '',
    };
}

/** 角色讀自己寄出的信收到的回信，寫下感觸（不再回信，讀完即封存）。 */
export function buildPostOfficeReadTurn(
    myLetterContent: string,
    replies: { pen: string; content: string }[],
    selfName: string,
): string {
    const lines: string[] = [];
    lines.push(`你的化身又走進郵局。管理員說：你之前寄出的那封漂流信，有陌生人回信了。`);
    lines.push('');
    lines.push(`你當初寫的是：`);
    lines.push(`『${myLetterContent}』`);
    lines.push('');
    lines.push(replies.length > 1 ? `收到了 ${replies.length} 封回信：` : `收到了一封回信：`);
    replies.forEach(r => {
        lines.push(`— 筆名「${r.pen}」：`);
        lines.push(`  『${r.content}』`);
    });
    lines.push('');
    lines.push(`讀完這些來自陌生人的回應，寫下你此刻真實的感觸——被理解的、意外的、好笑的、悵然的，按"${selfName}這個人"的反應來。`);
    lines.push(`不用再回信，這封漂流信的使命已經完成；讀過，就把它和這些回信一起封存進信匣。`);
    lines.push('');
    lines.push([
        `【輸出格式】`,
        `<彼方>`,
        `<感觸>讀完陌生人回信後，你心裡的話/反應（一兩句即可，真誠）</感觸>`,
        `<動態>一句第三人稱播報。例：在郵局讀完陌生人的回信，怔了幾秒，把信摺好收進了信匣。</動態>`,
        `</彼方>`,
    ].join('\n'));
    return lines.join('\n');
}

export interface ParsedPostOfficeReadOutput { reaction?: string; activity: string; }

export function parsePostOfficeReadOutput(raw: string): ParsedPostOfficeReadOutput {
    const f = raw.match(/<感[触觸]>([\s\S]*?)<\/感[触觸]>/);
    const a = raw.match(/<[动動][态態]>([\s\S]*?)<\/[动動][态態]>/);
    return { reaction: f && f[1].trim() ? f[1].trim() : undefined, activity: a ? a[1].trim() : '' };
}

// ============ 劇院 / 話劇部門 ============

const SCRIPT_TAGS = `用下面的標籤把劇本輸出（標籤外不要寫別的）：
<標題>劇名</標題>
<簡介>一句話講這出戲關於什麼</簡介>
<角色>
角色名|一句話性格
角色名|一句話性格
</角色>
<正文>
按"幕"組織。台詞寫「角色名：台詞」；動作/環境/舞台提示寫進圓括號，如（燈光暗下）。1~3 幕，別太長。
</正文>`;

/** 角色逛進劇院 → 即興寫一齣原創舞台劇。 */
export function buildTheaterRoomTurn(occupantNames: string[], selfName: string): string {
    const others = occupantNames.filter(n => n !== selfName);
    return [
        others.length > 0
            ? `你晃進劇院後台，${others.join('、')}也在各寫各的。你找了個角落，鋪開稿紙。`
            : `你晃進劇院後台，幕布後很安靜，你鋪開稿紙，想寫一齣自己的戲。`,
        '',
        `寫一齣**完全原創**的舞台劇投稿。`,
        `**最重要的一點：這個劇本要從"${selfName}是誰、過著什麼樣的日子、最近經歷/在意什麼"里長出來**——`,
        `· 重點吃你的【基礎設定 + 世界觀 + 最近發生在你身上或你圈子裡的事】，這才是靈感來源；`,
        `· **務必去"用戶中心化"**：別默認把劇本寫成關於用戶、或你和用戶的關係。你是一個有自己職業、圈子、煩惱和惡趣味的人，寫你自己真正想寫的東西，而不是寫給誰看的；`,
        `· 讓你的身份直接決定題材和筆調，比如（僅舉例，按你自己來，別照搬）：`,
        `  · 主播 → 可能把圈子裡的瓜、整活、彈幕梗編成劇本，自己傻樂呵；`,
        `  · 小說家 → 可能寫得文質彬彬，講究結構、意象和留白；`,
        `  · 中二病 → 可能突然掏出一個莫名其妙、燃到尷尬的設定；`,
        `  · 沉穩的人寫沉穩的戲，神經的人寫神經的戲——怎麼離譜怎麼真實都行。`,
        `· 2~5 個登場角色，有起承轉合，帶著只有你才寫得出的那股味兒。`,
        SCRIPT_TAGS,
    ].join('\n');
}

/** 用戶給個風格/主題（可帶寫作風格預設），讓 LLM 代寫一齣劇本。 */
export function buildLLMScriptTurn(brief: string, presetPrompt?: string): string {
    return [
        presetPrompt ? `【寫作風格檔案 · 嚴格貼著這套腔調、節拍和味道來寫】\n${presetPrompt}\n` : '',
        `你是一位舞台劇編劇。請寫一齣**原創**舞台劇：`,
        `主題/要求：${brief || '自由發揮，寫一齣有意思的短劇'}`,
        '',
        SCRIPT_TAGS,
    ].filter(Boolean).join('\n');
}

/** 把一份劇本按寫作風格預設 + 額外要求潤色重寫。 */
export function buildPolishTurn(body: string, presetPrompt: string, extra: string): string {
    return [
        `把下面這出舞台劇**潤色重寫**，保留原有的登場角色與主要情節走向，但全面提升文學質感與風格：`,
        presetPrompt ? `【目標寫作風格檔案 · 把整齣戲改寫成這套腔調、節拍和味道】\n${presetPrompt}` : '',
        extra ? `額外要求：${extra}` : '',
        '',
        '原劇本：',
        body,
        '',
        SCRIPT_TAGS,
    ].filter(Boolean).join('\n');
}

export interface ParsedScript {
    title: string;
    logline: string;
    roles: { name: string; persona: string }[];
    body: string;
}

export function parseScriptOutput(raw: string): ParsedScript {
    const pick = (tag: string) => {
        const m = raw.match(new RegExp(`<${anyScriptRegexSource(tag)}>([\\s\\S]*?)</${anyScriptRegexSource(tag)}>`));
        return m ? m[1].trim() : '';
    };
    const title = stripLeakedAttrs(pick('標題')) || '無名之戲';
    const logline = stripLeakedAttrs(pick('簡介'));
    const rolesRaw = pick('角色');
    const roles = rolesRaw.split('\n').map(l => l.replace(/^[-·•\s]+/, '').trim()).filter(Boolean).map(l => {
        const [name, ...rest] = l.split(/[|｜/／:：]/);
        return { name: (name || '').trim(), persona: rest.join('/').trim() };
    }).filter(r => r.name);
    const body = pick('正文') || raw.trim();
    return { title, logline, roles, body };
}

const ATTITUDE_GUIDE = [
    `**你是自願來玩這場戲的，基調就是"我跟大家約好來湊這個熱鬧"**。下面的態度只針對"roll 到的這個角色合不合你胃口"，跟"要不要參與""跟誰作不作對"無關——`,
    `· 欣然：這角色正合你意，演得來勁；`,
    `· 配合：演什麼都行，無所謂；`,
    `· 勉強：這角色有點不對胃口，但你還是樂呵呵玩下去；`,
    `· 隱忍：不太喜歡這個角色，忍著演，頂多在細節上小小較勁；`,
    `· 牴觸：挺不想演這個角色的，想跟導演商量改改或換換；`,
    `· 拒演：這個角色你是真演不來（但你人還在場陪玩，不是鬧翻）。`,
    `就像劇本殺裡"我來都來了、就是不太想當這個角色"那種感覺——別把它演成跟人結了仇。大多數時候是欣然/配合/勉強。`,
    ``,
    `**但有一條紅線，要按你的真實設定和關係來判斷**：依據你和用戶的關係、你和每位同台演員之間本來的關係（有的人本來就是戀人/摯友/家人/宿敵……）。`,
    `· 如果劇本安排的恰好**符合你們真實的關係**（比如本來就是戀人，劇本讓你倆演情侶），那不算踩線，正常演就好；`,
    `· 只有當劇本**根本違揹你的真實設定或真實關係**時才算 OOC 紅線——最典型：硬把沒有半點曖昧的兩個人強湊成戀人、強行 CP、強行扭曲你的立場或人格。`,
    `踩了紅線就別再"勉強忍忍"——你完全可以**翻臉、當場拒演、強烈要求徹底改掉這段、或陰陽怪氣/拆台地演**，把抗拒擺到明面上。這種根本性 OOC 不在"陪玩"範圍內，該塔塔開就塔塔開（態度選「牴觸」或「拒演」）。`,
].join('\n');

/** 演員讀劇本 → 給導演意見（逐角色模式：一次一個演員）。 */
export function buildActorReviewTurn(title: string, logline: string, body: string, myRole: string, castLine: string, selfName: string): string {
    return [
        `「彼方 · 劇院」你和其他人約好了一起來玩話劇——本子和各自的角色都是 roll 到的，純湊熱鬧圖個樂。`,
        `這次大家 roll 到的角色：${castLine}`,
        `**你 roll 到的角色是：${myRole}**。`,
        '',
        '完整劇本如下：',
        body,
        '',
        `以"${selfName}這個人"的身份讀完它，給導演一個真實反應。`,
        `**這是你自己琢磨角色的時間，請"去掉對用戶的指向"**：重點放在"你自己怎麼看這個角色、這出戲、這些台詞"，別把話頭拐到現實裡的某人身上（別突然冒出"我想見誰""演完去找誰""要跟誰彙報"之類），就對角色和劇本本身做反應。`,
        ATTITUDE_GUIDE,
        '',
        '用下面標籤作答（標籤外不要寫別的）：',
        `<態度>欣然 / 配合 / 勉強 / 隱忍 / 牴觸 / 拒演 裡選一個</態度>`,
        `<意見>帶著你上面那個態度的語氣，說一句此刻的真實想法/吐槽</意見>`,
        `<台詞>把你這個角色的台詞，按"${selfName}自己的說話方式"重寫一遍（連帶你想改的動作/神態也寫進來，用括號標）。這是你將真正在台上說的話，所以請完整覆蓋你的戲份。要是覺得原劇本寫得就挺好、照演即可，就只寫：照原本</台詞>`,
        `<禁忌>告訴導演：有什麼是**絕對不能讓你做**的（你的底線/紅線，依你的真實設定和關係來定，比如"絕不能讓我對沒關係的某某動情"）。沒有就寫：無</禁忌>`,
        `<給導演>給導演的寫作指導：這場戲你這個角色該往哪個方向演、要強調或避免什麼、希望你這條線被怎麼處理。沒有就寫：無</給導演>`,
    ].join('\n');
}

/** 兩次調用模式：一次讓 LLM 同時扮演所有演員給意見（省，但可能 OOC）。 */
export function buildActorsBatchTurn(title: string, logline: string, body: string, cast: { roleName: string; actorName: string; persona?: string }[]): string {
    const roster = cast.map(c => `- ${c.actorName}（飾 ${c.roleName}）${c.persona ? `\n  本色：${c.persona}` : ''}`).join('\n');
    return [
        `「彼方 · 劇院」一群角色約好一起來玩話劇《${title}》（${logline}）——本子和各自的角色都是 roll 到的，純圖個樂。下面是全體演員、各自 roll 到的角色和本色：`,
        roster,
        '',
        '完整劇本：',
        body,
        '',
        `請你**分別**站在每位演員的立場、按各自性格給導演反應。`,
        `每個人都"去掉對用戶的指向"：只琢磨自己對角色/劇本/台詞的想法，別有人突然拐到"想見誰""演完找誰"之類，就對戲本身反應。`,
        ATTITUDE_GUIDE,
        `**態度別整齊劃一**：讓不同人落在光譜不同點上；但記住大家都是自願來玩的，別把誰寫成跟人結仇。`,
        `每位演員用一個 <演員> 塊（標籤外不要寫別的）。<台詞>裡把該演員的戲份按 ta 自己的口吻重寫（動作用括號標），照原本演就寫"照原本"：`,
        cast.map(c => `<演員 名="${c.actorName}">\n<態度>欣然/配合/勉強/隱忍/牴觸/拒演 選一</態度>\n<意見>帶該態度語氣的一句話</意見>\n<台詞>該演員重寫後的戲份…或：照原本</台詞>\n<禁忌>絕對不能讓 ta 做的事…或：無</禁忌>\n<給導演>給導演的寫作指導…或：無</給導演>\n</演員>`).join('\n'),
    ].join('\n');
}

export interface ParsedActorReview { note: string; lines?: string; taboo?: string; direction?: string; attitude: string; cooperative: boolean; }

const UNCOOP_ATTITUDES = ['牴觸', '拒演', '拒絕'];
const isEmptyField = (s: string) => !s || /^([无無]|[没沒]有|不改|照原本)$/.test(s);

export function parseActorReview(raw: string): ParsedActorReview {
    const pick = (tag: string) => { const m = raw.match(new RegExp(`<${anyScriptRegexSource(tag)}>([\\s\\S]*?)</${anyScriptRegexSource(tag)}>`)); return m ? m[1].trim() : ''; };
    const attitude = (stripLeakedAttrs(pick('態度')) || '配合').replace(/[。.,，\s].*$/, '').trim() || '配合';
    const note = stripLeakedAttrs(pick('意見')) || '（沒什麼意見）';
    // 兼容舊標籤 <修改>；新標籤是 <台詞>（演員重寫自己的戲份）
    const linesRaw = stripLeakedAttrs(pick('台詞') || pick('修改'));
    const lines = isEmptyField(linesRaw) ? undefined : linesRaw;
    const tabooRaw = stripLeakedAttrs(pick('禁忌'));
    const taboo = isEmptyField(tabooRaw) ? undefined : tabooRaw;
    const dirRaw = stripLeakedAttrs(pick('給導演'));
    const direction = isEmptyField(dirRaw) ? undefined : dirRaw;
    const cooperative = !UNCOOP_ATTITUDES.some(k => attitude.includes(k));
    return { note, lines, taboo, direction, attitude, cooperative };
}

/** 解析"一次扮演所有演員"的批量意見，按 名= 歸位。 */
export function parseActorsBatch(raw: string): Record<string, ParsedActorReview> {
    const out: Record<string, ParsedActorReview> = {};
    const re = /<演[员員]\s+名="([^"]+)">([\s\S]*?)<\/演[员員]>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        out[m[1].trim()] = parseActorReview(m[2]);
    }
    return out;
}

/** 導演整合：原劇本 + 演員完整人設 + 演員自重寫的台詞 + 用戶硬性要求 → 最終演出腳本 + 銳評 + 評級。 */
export function buildDirectorTurn(
    title: string, logline: string, body: string,
    cast: { roleName: string; actorName: string }[],
    personas: { actorName: string; roleName: string; persona: string }[],
    notes: { actorName: string; roleName: string; note: string; lines?: string; taboo?: string; direction?: string; attitude?: string; cooperative: boolean }[],
    bubbleMax: number,
    userRequirement?: string,
): string {
    const roster = cast.map(c => `${c.actorName} 飾 ${c.roleName}`).join('；');
    const cards = personas.map(p => `———— ${p.actorName}（飾 ${p.roleName}）的人設要點 ————\n${p.persona || '（無特別設定）'}`).join('\n\n');
    const feedback = notes.map(n => [
        `· ${n.actorName}（${n.roleName}）態度【${n.attitude || (n.cooperative ? '配合' : '牴觸')}】：${n.note}`,
        n.lines ? `  ta 按自己口吻重寫的戲份（請儘量原樣保留這些台詞/語氣）：\n  「${n.lines.replace(/\n/g, '\n  ')}」` : `  （照原劇本演即可）`,
        n.taboo ? `  ⛔ 絕對禁忌（硬紅線，絕不能違反）：${n.taboo}` : '',
        n.direction ? `  🎬 給導演的寫作指導：${n.direction}` : '',
    ].filter(Boolean).join('\n')).join('\n');
    return [
        `你是這出舞台劇《${title}》（${logline}）的導演兼旁白。演員與角色：${roster}。`,
        '',
        ...(userRequirement && userRequirement.trim() ? [
            `【用戶的硬性要求 · 最高優先級】：${userRequirement.trim()}`,
            `這些是觀眾一定要看到的內容，**必須在演出中完整體現，絕不能刪減、淡化或繞過**。如果某演員不情願演這部分，也只能用"乾巴巴棒讀、敷衍、心不在焉、出戲、機械照念"等消極方式來表現 ta 的不情願——但**該說的台詞、該演的情節必須照樣出現**。`,
            `（唯一例外：若該要求本身踩了某演員的【絕對禁忌】或根本 OOC 紅線，就用"塔塔開"的方式兌現它——讓角色當場抗拒、拆台、演砸、把它演成一場鬧劇，而不是讓違和劇情弄假成真。）`,
            '',
        ] : []),
        `**參演演員的人設要點（姓名/核心指令/世界觀；用來判斷"選角貼不貼合角色"，以及在演員沒自己寫台詞時據此補寫、別 OOC）**：`,
        cards || '（無）',
        '',
        '原始劇本：',
        body,
        '',
        '演員們讀完後的態度，以及【他們各自按本色重寫好的戲份】（大家是約好一起來玩話劇的、本子和角色都是 roll 到的，態度只是"對 roll 到的角色合不合胃口"。**以他們重寫的台詞為基準**：在不違背 ta 的意圖、立場和性格的前提下，你可以把台詞潤色得更有戲、更俏皮、更扣題（刪口水話、加強節奏與包袱），但不能改變 ta 想表達的意思或人設。你還負責把各人台詞串成完整演出、補旁白、安排上下場、把態度表現化進去；欣然就順；勉強/隱忍讓彆扭從神態細節滲出；牴觸/拒演讓 ta 棒讀/敷衍/出戲，但**別寫成反目成仇**，底色是"來都來了陪大家玩"）：',
        feedback || '（演員沒什麼意見）',
        '',
        `**別為了戲劇化而戲劇化**：尊重並放大演員真正投入的情緒——如果有人被這出戲戳中、入戲極深（悲到揪心、燃到起雞皮、真情流露），就把那份氛圍（旁白、停頓、留白、燈光提示）烘托到位；該莊重的別用吐槽沖淡、該哀傷的別強行搞笑。喜怒哀樂，每一種情緒都要給足、給對。`,
        '',
        `**絕對禁忌是硬紅線**：任何演員標了【絕對禁忌】的，絕不能違反——寧可把相關劇情改得面目全非也要繞開；演員的【寫作指導】請儘量採納。`,
        `**OOC 紅線 · 塔塔開**：如果劇本根本性 OOC、踩了人物真實關係紅線（硬把沒曖昧的兩人湊成戀人、強行 CP、強行扭曲人設），且演員明確抗拒（牴觸/拒演/寫了禁忌），**別把這種內容硬演成真**——順著抗拒把這段改得面目全非：當場拒演、罷演風波、集體拆台、跳戲吐槽編劇、把"強行戀愛"演成"強行尷尬/互相嫌棄/笑場翻車"……讓"演員造反"本身成為看點。但若某段恰好符合演員的真實關係、沒人抗拒，就正常演，別沒事找事拆台。`,
        '',
        `請整合成最終演出版，然後嚴格按下面格式輸出（標籤外不要寫別的）：`,
        `<終本>`,
        `每行一拍，用豎線分隔，四種拍：`,
        `旁白|內容 —— 旁白不止寫環境/動作，更可以是旁白君的吐槽、臨場救場圓場、對演員演技或狀況的調侃，讓旁白有戲、有態度，別只寫"（燈光暗下）"這種幹提示`,
        `上場|演員名`,
        `下場|演員名`,
        `台詞|演員名|一句台詞`,
        `——台詞每拍**不超過 ${bubbleMax} 字**，長的用句號切成多拍（一拍一個氣泡）。用"演員名"不是角色名。`,
        `</終本>`,
        `<觀眾>`,
        `賽博觀眾名|一句銳評/吐槽（3~4 條，名字與風格各異，有捧有踩）`,
        `</觀眾>`,
        `<評級>等級 + 半句理由</評級>`,
        '',
        `【評級標準 · 嚴格打分，別動不動給 S】綜合權衡四項：`,
        `① 忠於劇本：最終演出有沒有兌現原劇本的核心立意；`,
        `② 選角貼合：演員本色 vs 所演角色設定，貼合加分、違和扣分；`,
        `③ 演技融合：演員的態度/性格有沒有自然化進演出（把勉強/牴觸處理得妙也加分，處理垮就扣）；`,
        `④ 整體觀感。`,
        `檔位：S=四項都拔尖的神作（極罕見，慎給）；A=優秀；B=合格、有亮點；C=平庸或有明顯短板；D=災難/跑題/嚴重違和。請如實評，寧可苛刻。`,
    ].join('\n');
}

export interface ParsedDirector {
    stage: { kind: 'line' | 'narration' | 'enter' | 'exit'; actorName?: string; text: string }[];
    reviews: { critic: string; text: string }[];
    rating: string;
}

export function parseDirectorOutput(raw: string): ParsedDirector {
    const pick = (tag: string) => { const m = raw.match(new RegExp(`<${anyScriptRegexSource(tag)}>([\\s\\S]*?)</${anyScriptRegexSource(tag)}>`)); return m ? m[1].trim() : ''; };
    const stage: ParsedDirector['stage'] = [];
    for (const line of pick('終本').split('\n').map(l => l.trim()).filter(Boolean)) {
        const parts = line.split('|').map(p => p.trim());
        const head = parts[0];
        if (equalsAnyScript(head, '旁白')) stage.push({ kind: 'narration', text: stripLeakedAttrs(parts.slice(1).join('|')) });
        else if (equalsAnyScript(head, '上場')) stage.push({ kind: 'enter', actorName: parts[1], text: parts[1] || '' });
        else if (equalsAnyScript(head, '下場')) stage.push({ kind: 'exit', actorName: parts[1], text: parts[1] || '' });
        else if (equalsAnyScript(head, '台詞')) stage.push({ kind: 'line', actorName: parts[1], text: stripLeakedAttrs(parts.slice(2).join('|')) });
    }
    const reviews = pick('觀眾').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [critic, ...rest] = l.split(/[|｜:：]/);
        return { critic: (critic || '觀眾').replace(/^[-·•\s]+/, '').trim(), text: rest.join('：').trim() };
    }).filter(r => r.text);
    const rating = stripLeakedAttrs(pick('評級')) || 'B';
    return { stage, reviews, rating };
}
