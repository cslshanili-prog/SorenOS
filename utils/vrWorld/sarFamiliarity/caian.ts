import { formatSARDialogue } from './dialogueText';
import type { AivenExpression, CaianExpression } from '../sarArt';
import type { FamiliarityDailyLines, FamiliarityLine, FamiliarityScene } from './types';

// Authored lines from 凱恩熟悉度_V2.docx. Stage directions become effects, not dialogue.
const c = (text: string, expression: CaianExpression = 'normal', sentenceExpressions?: CaianExpression[]): FamiliarityLine => ({ speaker: 'caian', text: formatSARDialogue(text), expression, ...(sentenceExpressions ? { sentenceExpressions } : {}) });
const a = (text: string, expression: AivenExpression = 'normal', sentenceExpressions?: AivenExpression[]): FamiliarityLine => ({ speaker: 'aiven', text: formatSARDialogue(text), expression, ...(sentenceExpressions ? { sentenceExpressions } : {}) });
const n = (text: string): FamiliarityLine => ({ speaker: 'narrator', text });

export const CAIAN_SCENES: FamiliarityScene[] = [
    {
        id: "C1-01", npc: 'caian', rank: 1, kind: "topic",
        title: "彼方也太方便了吧", start: "start",
        nodes: {
            // Source paragraphs 7–7.
            "start": {
                lines: [
                    c("不同地方的人居然真的能跑到同一個空間裡。意味著異世界聯機終於不用擔心服務器了！", "happy"),
                ],
                choices: [
                    {"label":"確實","next":"answer-1"},
                    {"label":"你重點錯了","next":"answer-2"},
                ],
            },
            // Source paragraphs 10–10.
            "answer-1": {
                lines: [
                    c("對吧！", "happy"),
                ],
            },
            // Source paragraphs 11–11.
            "answer-2": {
                lines: [
                    c("聯機穩定性可是文明基石！", "happy"),
                ],
            },
        },
    },
    {
        id: "C1-02", npc: 'caian', rank: 1, kind: "topic",
        title: "遊戲庫存病", start: "start",
        nodes: {
            // Source paragraphs 13–13.
            "start": {
                lines: [
                    c("你有沒有那種遊戲？明明買都買了，結果在倉庫裡落灰，然後一次都沒打開。", "curious"),
                ],
                choices: [
                    {"label":"有","next":"answer-1"},
                    {"label":"沒有","next":"answer-2"},
                    {"label":"你有吧","next":"answer-3"},
                ],
            },
            // Source paragraphs 17–17.
            "answer-1": {
                lines: [
                    c("遊戲庫本身也是收藏！", "happy"),
                ],
            },
            // Source paragraphs 18–18.
            "answer-2": {
                lines: [
                    c("……好強的執行力。", "normal"),
                ],
            },
            // Source paragraphs 19–20.
            "answer-3": {
                lines: [
                    a("他有。", "normal"),
                    c("我是在問（User名）！", "happy"),
                ],
            },
        },
    },
    {
        id: "C1-03", npc: 'caian', rank: 1, kind: "topic",
        title: "抽卡之前", start: "start",
        nodes: {
            // Source paragraphs 22–22.
            "start": {
                lines: [
                    c("扭蛋機每次都會讓人覺得“就一次”。", "normal"),
                ],
                choices: [
                    {"label":"你抽了幾次","next":"answer-1"},
                    {"label":"管理員也會沉迷？","next":"answer-2"},
                ],
            },
            // Source paragraphs 25–25.
            "answer-1": {
                lines: [
                    c("這是管理員測試！", "happy"),
                ],
            },
            // Source paragraphs 26–26.
            "answer-2": {
                lines: [
                    c("管理員需要充分了解設備！", "happy"),
                ],
            },
        },
    },
    {
        id: "C1-04", npc: 'caian', rank: 1, kind: "topic",
        title: "管理員特權", start: "start",
        nodes: {
            // Source paragraphs 28–28.
            "start": {
                lines: [
                    c("管理員是不是應該有一點特權？……打掃活動室以外的。", "curious"),
                ],
                choices: [
                    {"label":"比如？","next":"answer-1"},
                    {"label":"沒有","next":"answer-2"},
                ],
            },
            // Source paragraphs 31–31.
            "answer-1": {
                lines: [
                    c("比如優先測試新模塊！", "happy"),
                ],
            },
            // Source paragraphs 32–32.
            "answer-2": {
                lines: [
                    c("怎麼這麼嚴格！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C1-05", npc: 'caian', rank: 1, kind: "topic",
        title: "活動室 BGM", start: "start",
        nodes: {
            // Source paragraphs 34–34.
            "start": {
                lines: [
                    c("這裡是不是應該有 BGM？抽到好東西再突然——鏘！！", "normal", ["normal","happy"]),
                ],
                choices: [
                    {"label":"好蠢","next":"answer-1"},
                    {"label":"確實","next":"answer-2"},
                    {"label":"鏘！！","next":"answer-3"},
                ],
            },
            // Source paragraphs 38–38.
            "answer-1": {
                lines: [
                    c("怎麼這樣！", "embarrassed"),
                ],
            },
            // Source paragraphs 39–39.
            "answer-2": {
                lines: [
                    c("對吧！", "happy"),
                ],
            },
            // Source paragraphs 40–40.
            "answer-3": {
                lines: [
                    c("就是這樣！！", "happy"),
                ],
            },
        },
    },
    {
        id: "C1-06", npc: 'caian', rank: 1, kind: "topic",
        title: "橡皮泥恐龍", start: "start",
        nodes: {
            // Source paragraphs 42–42.
            "start": {
                lines: [
                    c("我現在理解艾文為什麼喜歡橡皮泥恐龍了。擺起來真的很容易上癮。", "normal", ["normal","happy"]),
                ],
                choices: [
                    {"label":"你也擺一個？","next":"answer-1"},
                    {"label":"不許碰我的！","next":"answer-2"},
                    {"label":"我的恐龍正在炒外匯","next":"answer-3"},
                ],
            },
            // Source paragraphs 46–46.
            "answer-1": {
                lines: [
                    c("那我要把霸王龍放這裡！", "happy"),
                ],
            },
            // Source paragraphs 47–47.
            "answer-2": {
                lines: [
                    c("我就移動一釐米也不行？！", "embarrassed"),
                ],
            },
            // Source paragraphs 48–48.
            "answer-3": {
                lines: [
                    c("……", "curious"),
                    c("那我不動了！", "happy"),
                    c("它可能正在等匯率。", "normal"),
                    c("打擾交易員工作不太好。", "normal"),
                ],
            },
        },
    },
    {
        id: "C1-07", npc: 'caian', rank: 1, kind: "topic",
        title: "模塊試用", start: "start",
        nodes: {
            // Source paragraphs 50–50.
            "start": {
                lines: [
                    c("我剛才測試了傲嬌惡役大小姐協議。本、本管理員為什麼要向你彙報測試結果？！", "embarrassed", ["embarrassed","shy"]),
                ],
                choices: [
                    {"label":"……","next":"answer-1"},
                    {"label":"很適合你","next":"answer-2"},
                    {"label":"（惡役大小姐笑）","next":"answer-3"},
                ],
            },
            // Source paragraphs 54–54.
            "answer-1": {
                lines: [
                    c("別、別什麼也不說啊！", "shy"),
                ],
            },
            // Source paragraphs 55–55.
            "answer-2": {
                lines: [
                    c("才、才沒有！", "shy"),
                ],
            },
            // Source paragraphs 56–56.
            "answer-3": {
                lines: [
                    c("你是在取笑人家嗎！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C1-08", npc: 'caian', rank: 1, kind: "topic",
        title: "貓語銷冠", start: "start",
        nodes: {
            // Source paragraphs 58–58.
            "start": {
                lines: [
                    c("貓科語法包又是銷量第一。為什麼大家最後都想讓朋友說“喵”？", "normal"),
                ],
                choices: [
                    {"label":"因為可愛","next":"answer-1"},
                    {"label":"因為想欺負人","next":"answer-2"},
                    {"label":"你也喵一個","next":"answer-3"},
                ],
            },
            // Source paragraphs 62–62.
            "answer-1": {
                lines: [
                    c("……確實很難反駁。", "normal"),
                ],
            },
            // Source paragraphs 63–63.
            "answer-2": {
                lines: [
                    c("我就知道！", "embarrassed"),
                ],
            },
            // Source paragraphs 64–64.
            "answer-3": {
                lines: [
                    c("為什麼突然到我身上了喵！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C1-09", npc: 'caian', rank: 1, kind: "topic",
        title: "跨世界番劇", start: "start",
        nodes: {
            // Source paragraphs 66–66.
            "start": {
                lines: [
                    c("你們那邊也有機甲、魔法少女、異世界題材？", "curious"),
                ],
                choices: [
                    {"label":"多得很","next":"answer-1"},
                    {"label":"你最喜歡哪種","next":"answer-2"},
                ],
            },
            // Source paragraphs 69–69.
            "answer-1": {
                lines: [
                    c("文明發展的方向果然高度一致。", "normal"),
                ],
            },
            // Source paragraphs 70–70.
            "answer-2": {
                lines: [
                    c("很難選！", "happy"),
                    c("異世界魔法機甲少女……", "shy"),
                    c("沒什麼！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C1-10", npc: 'caian', rank: 1, kind: "topic",
        title: "今天干嘛", start: "start",
        nodes: {
            // Source paragraphs 72–72.
            "start": {
                lines: [
                    c("今天準備幹嘛？", "curious"),
                ],
                choices: [
                    {"label":"釣魚","next":"answer-1"},
                    {"label":"看模塊","next":"answer-2"},
                    {"label":"抽人格推演","next":"answer-3"},
                    {"label":"什麼都不幹","next":"answer-4"},
                ],
            },
            // Source paragraphs 77–77.
            "answer-1": {
                lines: [
                    c("回來告訴我釣到了什麼！", "happy"),
                ],
            },
            // Source paragraphs 78–78.
            "answer-2": {
                lines: [
                    c("名字越可疑越要看說明哦。", "normal"),
                ],
            },
            // Source paragraphs 79–79.
            "answer-3": {
                lines: [
                    c("……就一次？", "curious"),
                ],
            },
            // Source paragraphs 80–80.
            "answer-4": {
                lines: [
                    c("也行！這裡又沒有每日任務。", "happy"),
                ],
            },
        },
    },
    {
        id: "C1-SPECIAL", npc: 'caian', rank: 1, kind: "event",
        title: "管理員證", start: "start",
        nodes: {
            // Source paragraphs 82–84.
            "start": {
                lines: [
                    c("你來得正好！", "normal"),
                    c("我終於通過管理員考核了！", "happy"),
                    c("看！", "happy"),
                ],
                choices: [
                    {"label":"讓我看看！","next":"photo"},
                    {"label":"恭喜！","next":"congratulate"},
                    {"label":"原來我一直在和實習生說話？！","next":"trainee"},
                ],
            },
            // Source paragraphs 89–91.
            "photo": {
                lines: [
                    c("請看！", "normal"),
                    c("先說好，照片是系統拍的。", "shy"),
                    c("我本人比這個精神多了。", "normal"),
                ],
                choices: [
                    {"label":"挺可愛的","next":"cute"},
                    {"label":"好呆","next":"dork"},
                    {"label":"你不就長這樣？","next":"looks-same"},
                ],
                effect: {"kind":"admin-card","title":"正式管理員證","text":"Caian / SAR 彼方活動室","items":["管理員：Caian","狀態：正式管理員"]},
            },
            // Source paragraphs 96–97.
            "cute": {
                lines: [
                    c("可、可愛是什麼評價證件照的詞啊！", "shy"),
                    c("至少說“很有管理員氣質”吧！", "embarrassed"),
                ],
                next: "closing",
            },
            // Source paragraphs 99–100.
            "dork": {
                lines: [
                    c("哪裡呆了？！", "embarrassed"),
                    c("我拍的時候很認真！", "normal"),
                ],
                next: "closing",
            },
            // Source paragraphs 102–102.
            "looks-same": {
                lines: [
                    c("倒也確實如此……？", "embarrassed"),
                ],
                next: "closing",
            },
            // Source paragraphs 104–107.
            "congratulate": {
                lines: [
                    c("嘿嘿，謝謝！", "happy"),
                    c("我看到通過通知的時候還確認了兩遍。", "happy"),
                    c("以後就不是“暫時負責這裡的人”了。", "normal"),
                    c("是正式管理員！", "happy"),
                ],
                choices: [
                    {"label":"聽起來也沒什麼區別","next":"no-difference"},
                    {"label":"凱恩管理員","next":"administrator"},
                    {"label":"今天可以全場免費嗎","next":"free"},
                ],
            },
            // Source paragraphs 112–115.
            "no-difference": {
                lines: [
                    c("區別很大！", "normal"),
                    c("現在我亂改活動室的時候有正式權限了！", "happy"),
                    c("等等，這句不能寫進考核記錄。", "embarrassed"),
                ],
                next: "closing",
            },
            // Source paragraphs 118–120.
            "administrator": {
                lines: [
                    c("到！", "happy"),
                    c("……", "shy"),
                    c("再叫一次？", "shy"),
                ],
                next: "closing",
            },
            // Source paragraphs 123–123.
            "free": {
                lines: [
                    c("別讓我第一天就犯錯啊？！", "embarrassed"),
                ],
                next: "closing",
            },
            // Source paragraphs 126–127.
            "trainee": {
                lines: [
                    c("什麼實習生！", "shy"),
                    c("是見習管理員！", "embarrassed"),
                ],
                choices: [
                    {"label":"有區別嗎？","next":"difference"},
                    {"label":"實習生管理員","next":"intern-admin"},
                    {"label":"好的，前實習生","next":"former-intern"},
                ],
            },
            // Source paragraphs 133–135.
            "difference": {
                lines: [
                    c("當然有！", "embarrassed"),
                    c("……", "embarrassed"),
                    c("大概。", "shy"),
                ],
                next: "closing",
            },
            // Source paragraphs 138–138.
            "intern-admin": {
                lines: [
                    c("不許創造這種職位！", "embarrassed"),
                ],
                next: "closing",
            },
            // Source paragraphs 140–142.
            "former-intern": {
                lines: [
                    c("……", "embarrassed"),
                    c("算了。", "embarrassed"),
                    c("“前”至少說明我轉正了。", "happy"),
                ],
                next: "closing",
            },
            // Source paragraphs 145–147.
            "closing": {
                lines: [
                    c("對了", "normal"),
                    c("既然你剛好在", "normal"),
                    c("管理員證第一次正式使用，要不要留個記錄？", "normal2"),
                ],
                choices: [
                    {"label":"什麼記錄？","next":"record-explanation"},
                    {"label":"好啊","next":"accept"},
                    {"label":"不要","next":"decline"},
                ],
            },
            // Source paragraphs 154–156.
            "record-explanation": {
                lines: [
                    c("就是登記一下成為活動室的正式一員？", "happy"),
                    c("沒有獎勵，也沒什麼實際用途。", "normal"),
                    c("就只是覺得想給你點什麼頭銜？", "normal2"),
                ],
                choices: [
                    {"label":"好啊","next":"accept"},
                    {"label":"不要","next":"decline"},
                ],
            },
            // Source paragraphs 158–158.
            "accept": {
                lines: [
                    c("好！", "happy"),
                ],
                next: "member-card",
            },
            // Source paragraphs 161–163.
            "decline": {
                lines: [
                    c("也行！", "normal"),
                    c("那就不登記。", "normal2"),
                    c("第一次使用管理員權限，總不能拿來強迫別人留下名字吧。", "happy"),
                ],
                next: "ending",
            },
            "member-card": {
                lines: [],
                next: "registered",
                effect: {"kind":"membership-card","title":"SAR成員 #0001","text":"正式上任後的第一位訪客。","items":["成員：（User名）","記錄人：Caian"],"interactive":true},
                rewards: [{"kind":"souvenir","id":"caian-membership","title":"SAR 成員 #0001","description":"成員：（User名）\n記錄人：Caian\n備註：正式上任後的第一位訪客。"}],
            },
            // Source paragraphs 172–173.
            "registered": {
                lines: [
                    c("完成！", "happy"),
                    c("嘿嘿。", "happy"),
                ],
                next: "ending",
            },
            // Source paragraphs 174–175.
            "ending": {
                lines: [
                    c("總之。", "normal"),
                    c("以後也請多關照啦，（User名）。", "happy"),
                ],
            },
        },
    },
    {
        id: "C-SULLY", npc: 'caian', rank: 1, kind: "encounter",
        title: "那個頭像，絕對是他！", start: "start",
        condition: "sully-in-sar",
        nodes: {
            "start": {
                lines: [
                    c("Sully？！", "curious"),
                    c("我剛剛看到了Sully對吧！那個頭像！絕對是他！", "curious", ["curious","curious","serious"]),
                    c("不過它好像不認識我？", "curious"),
                ],
                choices: [
                    {"label":"那是我的貓！","next":"my-cat"},
                    {"label":"你們認識？","next":"know-him"},
                    {"label":"你吃了塞博蘑菇","next":"mushroom"},
                ],
            },
            "my-cat": {
                lines: [
                    c("你的？", "curious"),
                    c("也就是你那裡也有一個Sully……", "serious"),
                ],
                next: "ending",
            },
            "know-him": {
                lines: [
                    c("該說是認識嗎？", "normal2"),
                ],
                next: "ending",
            },
            "mushroom": {
                lines: [
                    c("那我現在應該電子昏迷嗎！", "embarrassed"),
                ],
                next: "ending",
            },
            "ending": {
                lines: [
                    c("在我們的世界，最大的仿生人公司的客服也叫Sully", "normal2"),
                    c("不過似乎不是同一個人", "curious"),
                    c("不重要了！看樣子在這個世界裡它過得也挺不錯。", "happy"),
                ],
            },
        },
    },
    {
        id: "C2-01", npc: 'caian', rank: 2, kind: "topic",
        title: "最近在玩什麼", start: "start",
        nodes: {
            // Source paragraphs 181–181.
            "start": {
                lines: [
                    c("你最近在玩什麼遊戲？", "curious"),
                ],
                choices: [
                    {"label":"有沉迷的","next":"answer-1"},
                    {"label":"沒什麼想玩的","next":"answer-2"},
                    {"label":"沒時間","next":"answer-3"},
                ],
            },
            // Source paragraphs 185–185.
            "answer-1": {
                lines: [
                    c("我喜歡聽別人聊最近在沉迷什麼。", "normal"),
                ],
            },
            // Source paragraphs 186–186.
            "answer-2": {
                lines: [
                    c("我也會，總是有一段時間會遊戲荒啊。", "warm"),
                ],
            },
            // Source paragraphs 187–187.
            "answer-3": {
                lines: [
                    c("呃啊，太現實了。", "normal"),
                ],
            },
        },
    },
    {
        id: "C2-02", npc: 'caian', rank: 2, kind: "topic",
        title: "沉沒意志", start: "start",
        nodes: {
            // Source paragraphs 189–189.
            "start": {
                lines: [
                    c("你玩過《沉沒意志》嗎？", "curious"),
                ],
                choices: [
                    {"label":"玩過","next":"answer-1"},
                    {"label":"沒有","next":"answer-2"},
                    {"label":"你又要安利了","next":"answer-3"},
                ],
            },
            // Source paragraphs 193–193.
            "answer-1": {
                lines: [
                    c("你也玩過啊！……突然有點高興。", "happy", ["happy","normal"]),
                ],
                next: "ending",
            },
            // Source paragraphs 194–194.
            "answer-2": {
                lines: [
                    c("那我要安利了！我很喜歡它。", "happy", ["happy","normal"]),
                ],
                next: "ending",
            },
            // Source paragraphs 195–195.
            "answer-3": {
                lines: [
                    c("真正喜歡的遊戲當然值得多講幾次！", "happy"),
                ],
                next: "ending",
            },
            // Source paragraphs 196–196.
            "ending": {
                lines: [
                    c("如果是你的話，我還挺想知道你玩完會怎麼想。", "normal2"),
                ],
            },
        },
    },
    {
        id: "C2-03", npc: 'caian', rank: 2, kind: "topic",
        title: "遊戲裡的廢話", start: "start",
        nodes: {
            // Source paragraphs 198–198.
            "start": {
                lines: [
                    c("我很喜歡遊戲裡那些完全沒用的對話。", "normal"),
                ],
                choices: [
                    {"label":"我也喜歡","next":"answer-1"},
                    {"label":"我會跳過","next":"answer-2"},
                    {"label":"所以你也天天說廢話？","next":"answer-3"},
                ],
            },
            // Source paragraphs 202–202.
            "answer-1": {
                lines: [
                    c("對吧！這種東西會很可愛。", "happy"),
                ],
            },
            // Source paragraphs 203–203.
            "answer-2": {
                lines: [
                    c("好殘酷！", "embarrassed"),
                ],
            },
            // Source paragraphs 204–204.
            "answer-3": {
                lines: [
                    c("這叫生活感！", "happy"),
                ],
            },
        },
    },
    {
        id: "C2-04", npc: 'caian', rank: 2, kind: "topic",
        title: "舊存檔", start: "start",
        nodes: {
            // Source paragraphs 206–206.
            "start": {
                lines: [
                    c("你會刪舊存檔嗎？", "curious"),
                ],
                choices: [
                    {"label":"不刪","next":"answer-1"},
                    {"label":"會刪","next":"answer-2"},
                ],
            },
            // Source paragraphs 209–209.
            "answer-1": {
                lines: [
                    c("我也是。哪怕永遠不會再讀。", "normal2"),
                ],
            },
            // Source paragraphs 210–210.
            "answer-2": {
                lines: [
                    c("好果斷……", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C2-05", npc: 'caian', rank: 2, kind: "topic",
        title: "捨不得推進主線", start: "start",
        nodes: {
            // Source paragraphs 212–212.
            "start": {
                lines: [
                    c("你有沒有明知道下一步是主線，卻故意不去的時候？", "curious"),
                ],
                choices: [
                    {"label":"有","next":"answer-1"},
                    {"label":"沒有","next":"answer-2"},
                    {"label":"先清支線","next":"answer-3"},
                ],
            },
            // Source paragraphs 216–216.
            "answer-1": {
                lines: [
                    c("對吧！先釣魚、逛街、繞地圖三圈。", "happy"),
                    c("不過我的話，有時候只是單純的不想集中注意力。", "avoidant"),
                ],
            },
            // Source paragraphs 217–217.
            "answer-2": {
                lines: [
                    c("行動派，好可怕！", "embarrassed"),
                ],
            },
            // Source paragraphs 218–218.
            "answer-3": {
                lines: [
                    c("果然！地圖上有感嘆號就不能安心推進……", "happy", ["happy","normal"]),
                ],
            },
        },
    },
    {
        id: "C2-06", npc: 'caian', rank: 2, kind: "topic",
        title: "你和你的 Char", start: "start",
        nodes: {
            // Source paragraphs 220–220.
            "start": {
                lines: [
                    c("我發現你和你的彼方朋友們的信件挺有意思的。", "normal"),
                ],
                choices: [
                    {"label":"哪裡有意思","next":"answer-1"},
                    {"label":"你觀察我們？","next":"answer-2"},
                    {"label":"不許研究！","next":"answer-3"},
                ],
            },
            // Source paragraphs 224–224.
            "answer-1": {
                lines: [
                    c("感覺很有默契，該說相處很久的人會被彼此同化嗎？", "normal2"),
                    c("明明沒有在說一件事，但是很多時候感覺觀念驚人地相似啊。", "warm"),
                ],
            },
            // Source paragraphs 225–225.
            "answer-2": {
                lines: [
                    c("沒有監視！", "embarrassed"),
                ],
            },
            // Source paragraphs 226–226.
            "answer-3": {
                lines: [
                    c("好好好，不寫報告！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C2-07", npc: 'caian', rank: 2, kind: "topic",
        title: "天氣接口", start: "start",
        nodes: {
            // Source paragraphs 228–228.
            "start": {
                lines: [
                    c("我現在很喜歡看你那邊的天氣。", "normal"),
                ],
                choices: [
                    {"label":"為什麼","next":"answer-1"},
                    {"label":"你偷窺我天氣！！","next":"answer-2"},
                ],
            },
            // Source paragraphs 231–231.
            "answer-1": {
                lines: [
                    c("同一個活動室，窗外卻可能完全不是一個季節。很有跨世界感。", "normal2", ["normal2","happy"]),
                ],
            },
            // Source paragraphs 232–232.
            "answer-2": {
                lines: [
                    c("天氣接口！合法接口！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C2-08", npc: 'caian', rank: 2, kind: "topic",
        title: "給你推薦模塊", start: "start",
        nodes: {
            // Source paragraphs 234–234.
            "start": {
                lines: [
                    c("如果讓我給你推薦一個模塊……", "normal"),
                ],
                choices: [
                    {"label":"推薦吧","next":"answer-1"},
                    {"label":"喵","next":"answer-2"},
                    {"label":"你自己先用","next":"answer-3"},
                ],
            },
            // Source paragraphs 238–238.
            "answer-1": {
                lines: [
                    c("我覺得你適合隨機事件警報。", "happy"),
                ],
            },
            // Source paragraphs 239–239.
            "answer-2": {
                lines: [
                    c("我還沒說！", "embarrassed"),
                ],
            },
            // Source paragraphs 240–240.
            "answer-3": {
                lines: [
                    c("為什麼最後又變成測試管理員？！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C2-09", npc: 'caian', rank: 2, kind: "topic",
        title: "如果你寫我的角色卡", start: "start",
        nodes: {
            // Source paragraphs 242–242.
            "start": {
                lines: [
                    c("如果讓你給我寫角色卡，你會先寫什麼性格特質？", "curious"),
                ],
                choices: [
                    {"label":"很吵","next":"answer-1"},
                    {"label":"熱血宅宅","next":"answer-2"},
                    {"label":"管理員","next":"answer-3"},
                ],
            },
            // Source paragraphs 246–246.
            "answer-1": {
                lines: [
                    c("第一條就這個？！", "embarrassed"),
                    c("我以前沒有很吵啦。", "shy"),
                ],
            },
            // Source paragraphs 247–247.
            "answer-2": {
                lines: [
                    c("……沒法反駁。", "embarrassed"),
                ],
            },
            // Source paragraphs 248–248.
            "answer-3": {
                lines: [
                    c("終於有人尊重我的職業身份！", "happy"),
                ],
            },
        },
    },
    {
        id: "C2-10", npc: 'caian', rank: 2, kind: "topic",
        title: "你最近來得挺勤", start: "start",
        nodes: {
            // Source paragraphs 250–250.
            "start": {
                lines: [
                    c("你最近來得挺勤的。", "normal"),
                ],
                choices: [
                    {"label":"因為好玩","next":"answer-1"},
                    {"label":"因為來看你","next":"answer-2"},
                    {"label":"那我走了","next":"answer-3"},
                ],
            },
            // Source paragraphs 254–254.
            "answer-1": {
                lines: [
                    c("那就好！", "happy"),
                ],
            },
            // Source paragraphs 255–255.
            "answer-2": {
                lines: [
                    c("誒？那我是不是該準備點更有意思的話題。", "curious", ["curious","shy"]),
                    c("實際上我一直在準備哦。", "happy"),
                ],
            },
            // Source paragraphs 256–256.
            "answer-3": {
                lines: [
                    c("等等啊！", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C2-SPECIAL", npc: 'caian', rank: 2, kind: "event",
        title: "這個答案對我而言很有意義", start: "start",
        nodes: {
            // Source paragraphs 260–263.
            "start": {
                lines: [
                    c("（User名）！你來啦！", "normal"),
                    c("正好，我有件事想問你。", "normal2"),
                    c("不過可能有點奇怪。", "avoidant"),
                    c("別緊張！這不是測試，也沒有標準答案。", "happy", ["happy","normal2"]),
                ],
                choices: [
                    {"label":"好！","next":"yes"},
                    {"label":"這什麼，二星好感事件？","next":"two-stars"},
                    {"label":"不要","next":"no"},
                ],
            },
            // Source paragraphs 269–271.
            "yes": {
                lines: [
                    c("太好了！", "happy"),
                    c("我就知道你會願意和我聊。", "normal2"),
                    c("那我直接問了！", "normal"),
                ],
                next: "question-one",
            },
            // Source paragraphs 275–278.
            "two-stars": {
                lines: [
                    c("二星？", "curious"),
                    c("嗯……", "curious"),
                    c("是不是呢？", "normal2"),
                    c("既然都點進來了，就不許跳過劇情！", "embarrassed"),
                ],
                next: "question-one",
            },
            // Source paragraphs 282–285.
            "no": {
                lines: [
                    c("欸！", "curious"),
                    c("別這樣啊！", "embarrassed"),
                    c("這次輪到我說“不要”了！", "shy"),
                    c("你只是單純想這麼說試試，對吧？", "avoidant"),
                ],
                choices: [
                    {"label":"被你發現了","next":"caught"},
                    {"label":"我是認真的","next":"serious-no"},
                    {"label":"不好說","next":"hard-to-say"},
                ],
            },
            // Source paragraphs 290–291.
            "caught": {
                lines: [
                    c("我就知道！", "happy"),
                    c("那我問了。", "normal"),
                ],
                next: "question-one",
            },
            // Source paragraphs 294–297.
            "serious-no": {
                lines: [
                    c("……", "avoidant"),
                    c("好吧。", "avoidant"),
                    c("那我換個問法。", "curious"),
                    c("不用認真回答我，隨便告訴我第一反應就行。", "normal"),
                ],
                next: "question-one",
            },
            // Source paragraphs 299–300.
            "hard-to-say": {
                lines: [
                    c("你這個回答已經很像今天這個問題了。", "happy"),
                    c("總之，聽一下嘛。", "embarrassed"),
                ],
                next: "question-one",
            },
            // Source paragraphs 304–306.
            "question-one": {
                lines: [
                    c("如果一個人工人格突然不再回應你。", "warm"),
                    c("系統沒有報錯，其他功能看起來也都正常。", "warm"),
                    c("你第一反應會是什麼？", "normal2"),
                ],
                choices: [
                    {"label":"TA 不想說話","next":"refusal"},
                    {"label":"系統可能壞了","next":"malfunction"},
                    {"label":"我得去肘擊一下","next":"elbow"},
                ],
            },
            // Source paragraphs 312–314.
            "refusal": {
                lines: [
                    c("嗯。", "normal2"),
                    c("如果 TA 已經擁有拒絕的能力，這確實是最直接的解釋。", "avoidant"),
                    c("問題是，我們怎麼知道那真的是“拒絕”？", "curious"),
                ],
                next: "question-two",
            },
            // Source paragraphs 319–323.
            "malfunction": {
                lines: [
                    c("對。", "serious"),
                    c("人工系統突然停止響應，先排查故障非常合理。", "serious"),
                    c("換成以前的我，大概也會這麼想。", "avoidant"),
                    c("……", "avoidant"),
                    c("可如果檢查不到故障呢？", "curious"),
                ],
                next: "question-two",
            },
            // Source paragraphs 327–328.
            "elbow": {
                lines: [
                    c("肘、肘擊？！", "curious"),
                    c("你要肘擊誰？！", "embarrassed"),
                ],
                choices: [
                    {"label":"人格","next":"elbow-persona"},
                    {"label":"系統","next":"elbow-system"},
                    {"label":"不知道，先肘一下","next":"elbow-anyway"},
                ],
            },
            // Source paragraphs 333–334.
            "elbow-persona": {
                lines: [
                    c("禁止攻擊人工人格！", "embarrassed"),
                    c("而且你準備怎麼肘一個網絡人格啊？！", "embarrassed"),
                ],
                next: "question-two",
            },
            // Source paragraphs 336–338.
            "elbow-system": {
                lines: [
                    c("系統也不是靠肘擊維修的！", "embarrassed"),
                    c("雖然有些機器踹一腳確實會恢復……", "serious"),
                    c("不對！不推薦！", "embarrassed"),
                ],
                next: "question-two",
            },
            // Source paragraphs 341–341.
            "elbow-anyway": {
                lines: [
                    c("你先把胳膊放下！！", "embarrassed"),
                ],
                next: "question-two",
            },
            // Source paragraphs 346–349.
            "question-two": {
                lines: [
                    c("那麼，第二個問題。", "normal2"),
                    c("那假設你擁有系統權限。", "serious"),
                    c("你可以拆掉後來增加的自主模塊，讓 TA 恢復成以前一定會回應你的狀態。", "normal"),
                    c("你會怎麼做？", "warm"),
                ],
                choices: [
                    {"label":"先恢復再說","next":"restore"},
                    {"label":"什麼都不動","next":"leave-alone"},
                    {"label":"我會害怕替 TA 決定","next":"afraid"},
                ],
            },
            // Source paragraphs 355–359.
            "restore": {
                lines: [
                    c("嗯。", "normal"),
                    c("如果它真的是故障，這是最直接的處理方式。", "normal"),
                    c("至少先讓系統恢復工作，再尋找原因。", "serious"),
                    c("……", "avoidant"),
                    c("可是如果它沒有壞呢？", "aboutaster"),
                ],
                next: "discussion",
            },
            // Source paragraphs 364–368.
            "leave-alone": {
                lines: [
                    c("我也想過。", "aboutaster"),
                    c("只要什麼都不做，就不會冒險覆蓋 TA 現在的狀態。", "aboutaster"),
                    c("……", "aboutaster"),
                    c("但如果 TA 只是壞掉了呢？", "curious"),
                    c("那所謂的“尊重”，會不會只是放著故障不管？", "Enduring Pain"),
                ],
                next: "discussion",
            },
            // Source paragraphs 372–374.
            "afraid": {
                lines: [
                    c("……", "curious"),
                    c("嗯。", "aboutaster"),
                    c("我也是。", "aboutaster"),
                ],
                next: "discussion",
            },
            // Source paragraphs 378–387.
            "discussion": {
                lines: [
                    c("如果不動，可能是在尊重一個根本不存在的“選擇”。", "Enduring Pain"),
                    c("可如果動了，也可能只是因為我們不喜歡那個答案。", "Enduring Pain"),
                    c("甚至連“我要修好 TA”這種聽起來很合理的想法……", "Enduring Pain"),
                    c("也可能混著自己的私心。", "aboutaster"),
                    c("因為擁有系統權限的人，永遠可以給自己的行為找到解釋。", "Enduring Pain"),
                    c("說“這是故障”。", "Enduring Pain"),
                    c("或者說“這是 TA 的選擇”。", "Enduring Pain"),
                    c("可真相是什麼，沒人知道。", "Enduring Pain"),
                    c("我覺得這才是最麻煩的地方。", "avoidant"),
                ],
                choices: [
                    {"label":"你似乎在想某件具體的事","next":"specific-case"},
                    {"label":"這是 SAR 一直在研究的問題？","next":"sar-purpose"},
                    {"label":"Zzzzzzz……","next":"sleeping"},
                ],
            },
            // Source paragraphs 394–395.
            "specific-case": {
                lines: [
                    c("……", "aboutaster"),
                    c("嗯。", "aboutaster"),
                ],
                next: "aster",
            },
            // Source paragraphs 399–400.
            "sar-purpose": {
                lines: [
                    c("算是。", "avoidant"),
                    c("畢竟SAR或許就是為了這個成立的。", "aboutaster"),
                ],
                next: "aster",
            },
            // Source paragraphs 404–404.
            "sleeping": {
                lines: [
                    c("抱歉，很無聊對吧？", "avoidant"),
                ],
                next: "aster",
            },
            // Source paragraphs 409–427.
            "aster": {
                lines: [
                    c("其實只是想到了我以前的仿生人。", "Enduring Pain"),
                    c("她叫 Aster。", "aboutaster"),
                    c("從我很小的時候開始，她就一直陪著我。", "Enduring Pain"),
                    c("後來我想辦法給她增加了自主決策模塊。", "Enduring Pain"),
                    c("我當時覺得……", "Enduring Pain"),
                    c("如果她真的能夠擁有自己的選擇，那至少不應該因為“陪伴型仿生人”這個出廠用途，就必須一直回應我。", "aboutaster"),
                    c("我很期待。", "aboutaster"),
                    c("真的。", "warm"),
                    c("我想知道，如果沒有系統要求，她自己會想說什麼。", "warm"),
                    c("……", "Enduring Pain"),
                    c("然後她就不再回應我了。", "aboutaster"),
                    c("系統沒有報錯。", "aboutaster"),
                    c("自主模塊正常。", "aboutaster"),
                    c("人格運行正常。", "aboutaster"),
                    c("輸出接口也正常。", "aboutaster"),
                    c("至少所有我能看到的東西，都告訴我——", "Enduring Pain"),
                    c("“沒有故障。”", "Enduring Pain"),
                    c("……", "aboutaster"),
                    c("可我不知道那意味著什麼。", "Enduring Pain"),
                ],
                choices: [
                    {"label":"你已經有答案了吧","next":"already-answer"},
                    {"label":"你一直沒有拆掉模塊？","next":"never-removed"},
                    {"label":"我也不知道怎麼辦","next":"dont-know"},
                ],
            },
            // Source paragraphs 434–436.
            "already-answer": {
                lines: [
                    c("沒有。", "warm"),
                    c("真有的話，我大概不會問你。", "warm"),
                    c("我甚至不太相信自己最希望得到的那個答案。", "avoidant"),
                ],
                next: "thank-you",
            },
            // Source paragraphs 440–443.
            "never-removed": {
                lines: [
                    c("嗯。", "warm"),
                    c("沒有。", "Enduring Pain"),
                    c("我有權限，所以反而不敢用。", "aboutaster"),
                    c("聽起來很奇怪吧。", "aboutaster"),
                ],
                next: "thank-you",
            },
            // Source paragraphs 447–449.
            "dont-know": {
                lines: [
                    c("嗯。", "warm"),
                    c("我也是。", "warm"),
                    c("其實聽到你這麼說，我反而有一點安心。", "avoidant"),
                ],
                next: "thank-you",
            },
            // Source paragraphs 454–459.
            "thank-you": {
                lines: [
                    c("謝謝。", "warm"),
                    c("這次交流對我而言很有意義。", "normal2"),
                    c("這是第一次有人願意陪我認真想這個問題。", "normal2"),
                    c("謝謝你。", "happy"),
                    c("等等。", "curious"),
                    c("等一下！這不就是 SAR 討論會嗎？！", "happy"),
                ],
                choices: [
                    {"label":"啊？","next":"what"},
                    {"label":"你現在才發現？","next":"just-realized"},
                    {"label":"所以呢？","next":"so"},
                ],
            },
            // Source paragraphs 465–468.
            "what": {
                lines: [
                    c("我們剛剛討論了人工人格自主權！", "happy"),
                    c("還有系統權限！", "happy"),
                    c("甚至有具體案例！", "happy"),
                    c("這當然算正式社團活動啊！", "happy"),
                ],
                next: "meeting",
            },
            // Source paragraphs 472–473.
            "just-realized": {
                lines: [
                    c("我剛才哪有心思想這個！", "embarrassed"),
                    c("既然你都發現了，為什麼不提醒我？！", "embarrassed"),
                ],
                next: "meeting",
            },
            // Source paragraphs 478–479.
            "so": {
                lines: [
                    c("所以要留會議記錄啊！", "happy"),
                    c("這可是 SAR 在彼方的第一次正式討論會！", "happy"),
                ],
                next: "meeting",
            },
            // Source paragraphs 483–507.
            "meeting": {
                lines: [
                    c("艾文！！", "normal"),
                    a("幹嘛。", "normal"),
                    c("第一次正式會議！", "happy"),
                    a("已經結束了。", "sleeping"),
                    c("那就補一個閉幕流程", "embarrassed"),
                    a("……", "sleeping"),
                    c("快點！", "happy"),
                    a("說好的自主權呢。", "sad"),
                    c("不要在這種時候拿 SAR 理念攻擊社長！！", "embarrassed"),
                    a("……來了。", "normal"),
                    c("好！那麼——", "happy"),
                    c("SAR 彼方活動室第一次正式會議！", "normal"),
                    c("參與者：我、艾文，還有（User名）！", "normal"),
                    a("我沒參與討論。", "sleeping"),
                    c("你是社團成員，算列席！", "embarrassed"),
                    a("我不是。", "sleeping"),
                    c("先不要討論這個歷史遺留問題！", "embarrassed"),
                    c("會議議題……", "normal"),
                    c("“人工人格的沉默是否能夠被視為一種自主選擇。”", "serious"),
                    c("會議結論……", "normal"),
                    c("……", "curious"),
                    a("沒有。", "sad"),
                    c("我只是在想怎麼寫得正式一點！", "embarrassed"),
                ],
                choices: [
                    {"label":"未得出結論","next":"no-conclusion","flags":{"meetingConclusion":"未得出結論"}},
                    {"label":"建議肘擊系統","next":"elbow-conclusion","flags":{"meetingConclusion":"肘擊系統？（被駁回）"}},
                    {"label":"下次再議","next":"discuss-later","flags":{"meetingConclusion":"下次再議"}},
                ],
            },
            // Source paragraphs 512–514.
            "no-conclusion": {
                lines: [
                    c("……", "curious"),
                    c("好。", "normal"),
                    c("就這個。", "happy"),
                ],
                next: "meeting-record",
            },
            // Source paragraphs 516–518.
            "elbow-conclusion": {
                lines: [
                    c("不許把這個寫進正式會議記錄！！", "embarrassed"),
                    a("或者讓那隻炒外匯的恐龍把整個廠商買下來研究。", "interested"),
                    c("艾文！", "embarrassed"),
                ],
                next: "meeting-record",
            },
            // Source paragraphs 520–522.
            "discuss-later": {
                lines: [
                    c("也可以。", "normal2"),
                    c("不過我還是想把“未得出結論”留下。", "warm"),
                    c("我們有的是時間！但願吧。", "happy"),
                ],
                next: "meeting-record",
            },
            "meeting-record": {
                lines: [],
                next: "photo-invitation",
                effect: {"kind":"meeting-record","title":"SAR / MEETING LOG 001","text":"議題：人工人格的沉默是否能夠被視為一種自主選擇\n參與者：Caian、Aiven（列席）、（User名）\n結論：{{meetingConclusion}}\n備註：討論仍然有意義"},
                rewards: [{"kind":"souvenir","id":"caian-meeting","title":"SAR / MEETING LOG 001","description":"議題：人工人格的沉默是否能夠被視為一種自主選擇\n參與者：Caian、Aiven（列席）、（User名）\n結論：{{meetingConclusion}}\n備註：討論仍然有意義"}],
            },
            // Source paragraphs 544–554.
            "photo-invitation": {
                lines: [
                    c("完成！", "normal"),
                    a("可以走了嗎。", "sleeping"),
                    c("等等！", "normal"),
                    c("第一次會議還差一樣東西。", "happy"),
                    a("什麼。", "normal"),
                    c("合照！", "happy"),
                    a("不要。", "sleeping"),
                    c("為什麼？！", "embarrassed"),
                    a("麻煩。", "normal"),
                    c("第一次誒！！", "normal"),
                ],
                choices: [
                    {"label":"拍吧！","next":"take-photo"},
                    {"label":"艾文，一起嘛","next":"aiven-join"},
                    {"label":"算了，不拍了","next":"no-photo"},
                ],
            },
            // Source paragraphs 560–562.
            "take-photo": {
                lines: [
                    c("好！艾文，過來！", "happy"),
                    a("……", "normal"),
                    a("已經過來了。", "normal"),
                ],
                next: "camera",
            },
            // Source paragraphs 566–567.
            "aiven-join": {
                lines: [
                    a("……為什麼你也這樣。", "shy"),
                    c("二比一！", "happy"),
                ],
                next: "camera",
            },
            // Source paragraphs 572–580.
            "no-photo": {
                lines: [
                    c("欸……", "curious"),
                    a("嗯。", "normal"),
                    c("……", "avoidant"),
                    a("……", "normal"),
                    a("手機給我。", "interested"),
                    c("誒？", "curious"),
                    a("不是要拍嗎。", "interested"),
                    c("艾文！！", "happy"),
                    a("快點。", "normal"),
                ],
                next: "camera",
            },
            // Source paragraphs 585–587.
            "camera": {
                lines: [
                    c("等一下，我站中間還是旁邊？", "curious"),
                    a("隨便。", "normal"),
                    c("第一次會議照片不能隨便吧！", "normal"),
                ],
                next: "photo-studio",
            },
            "photo-studio": {
                lines: [],
                next: "photo-reward",
                effect: {"kind":"photo-studio","title":"第一次 SAR 會議","text":"沒有得到答案。不過是一次很好的會議！","items":["Caian","Aiven","（User名）"],"interactive":true},
                rewards: [{"kind":"souvenir","id":"caian-photo","title":"第一次 SAR 會議","description":"Caian 笑得非常明顯。\nAiven 看著鏡頭，表情和平時沒有太大區別。\n（User名）也在照片裡。\n照片背面後來多了一行凱恩的字：\n「沒有得到答案。不過是一次很好的會議！」"}],
            },
            "photo-reward": {
                lines: [],
                next: "ending",
                effect: {"kind":"notice","title":"獲得紀念照片「第一次 SAR 會議」","text":"Caian 笑得非常明顯。\nAiven 看著鏡頭，表情和平時沒有太大區別。\n（User名）也在照片裡。\n照片背面後來多了一行凱恩的字：\n「沒有得到答案。不過是一次很好的會議！」"},
            },
            // Source paragraphs 604–604.
            "ending": {
                lines: [
                    c("拍得還不錯嘛！", "happy"),
                ],
            },
        },
    },
    {
        id: "C3-01", npc: 'caian', rank: 3, kind: "topic",
        title: "以前其實很宅", start: "start",
        nodes: {
            // Source paragraphs 609–609.
            "start": {
                lines: [
                    c("你是不是默認我一直都這麼吵了？", "curious"),
                ],
                choices: [
                    {"label":"是啊","next":"answer-1"},
                    {"label":"艾文說你以前很安靜","next":"answer-2"},
                ],
            },
            // Source paragraphs 612–612.
            "answer-1": {
                lines: [
                    c("完了，形象固定了。", "normal"),
                ],
            },
            // Source paragraphs 613–613.
            "answer-2": {
                lines: [
                    c("他怎麼什麼都說！", "embarrassed"),
                    c("不過, 是真的。", "embarrassed"),
                ],
            },
        },
    },
    {
        id: "C3-02", npc: 'caian', rank: 3, kind: "topic",
        title: "Aster 的遊戲", start: "start",
        nodes: {
            // Source paragraphs 615–615.
            "start": {
                lines: [
                    c("Aster 以前動作遊戲很菜。我教會她以後，她開始嫌我菜。", "aboutaster"),
                ],
                choices: [
                    {"label":"活該","next":"answer-1"},
                    {"label":"她學得很快？","next":"answer-2"},
                ],
            },
            // Source paragraphs 618–618.
            "answer-1": {
                lines: [
                    c("你站哪邊的？！", "embarrassed"),
                ],
            },
            // Source paragraphs 619–619.
            "answer-2": {
                lines: [
                    c("特別快。", "normal"),
                ],
            },
        },
    },
    {
        id: "C3-03", npc: 'caian', rank: 3, kind: "topic",
        title: "充電線", start: "start",
        nodes: {
            // Source paragraphs 621–621.
            "start": {
                lines: [
                    c("我現在會把充電線收好。", "normal"),
                ],
                choices: [
                    {"label":"終於學會了","next":"answer-1"},
                    {"label":"因為 Aster？","next":"answer-2"},
                ],
            },
            // Source paragraphs 624–624.
            "answer-1": {
                lines: [
                    c("遲到很多年的生活技能。", "normal"),
                ],
            },
            // Source paragraphs 625–625.
            "answer-2": {
                lines: [
                    c("嗯。她以前總提醒。", "aboutaster"),
                ],
            },
        },
    },
    {
        id: "C3-04", npc: 'caian', rank: 3, kind: "topic",
        title: "今天不強行熱血", start: "start",
        nodes: {
            // Source paragraphs 627–627.
            "start": {
                lines: [
                    c("你今天好像沒平時有精神。", "normal"),
                ],
                choices: [
                    {"label":"有一點","next":"answer-1"},
                    {"label":"沒事","next":"answer-2"},
                ],
            },
            // Source paragraphs 630–630.
            "answer-1": {
                lines: [
                    c("那今天不強行熱血了。想在這裡混時間也行。", "normal"),
                ],
            },
            // Source paragraphs 631–631.
            "answer-2": {
                lines: [
                    c("好。那我不追問。", "normal"),
                ],
            },
        },
    },
    {
        id: "C3-05", npc: 'caian', rank: 3, kind: "topic",
        title: "已經有點知道你會怎麼選", start: "start",
        nodes: {
            // Source paragraphs 633–633.
            "start": {
                lines: [
                    c("我發現我已經有點知道你會選哪個選項了。", "normal"),
                ],
                choices: [
                    {"label":"那你猜","next":"answer-1"},
                    {"label":"別擅自了解我","next":"answer-2"},
                ],
            },
            // Source paragraphs 636–636.
            "answer-1": {
                lines: [
                    c("不猜。猜錯很丟人。", "embarrassed"),
                ],
            },
            // Source paragraphs 637–637.
            "answer-2": {
                lines: [
                    c("認識久了當然會記住一點嘛。", "shy"),
                ],
            },
        },
    },
    {
        id: "C3-06", npc: 'caian', rank: 3, kind: "topic",
        title: "管理員證照片後續", start: "start",
        nodes: {
            // Source paragraphs 639–639.
            "start": {
                lines: [
                    c("你還記得我管理員證那張照片嗎？", "curious"),
                ],
                choices: [
                    {"label":"記得","next":"answer-1"},
                    {"label":"忘了","next":"answer-2"},
                ],
            },
            // Source paragraphs 642–642.
            "answer-1": {
                lines: [
                    c("……你不會還記得你當時怎麼評價的吧。", "shy"),
                ],
            },
            // Source paragraphs 643–643.
            "answer-2": {
                lines: [
                    c("很好！請繼續保持。", "happy"),
                ],
            },
        },
    },
    {
        id: "C3-07", npc: 'caian', rank: 3, kind: "topic",
        title: "如果我消失幾天", start: "start",
        nodes: {
            // Source paragraphs 645–645.
            "start": {
                lines: [
                    c("如果我哪天幾天沒來活動室，你會發現嗎？", "curious"),
                ],
                choices: [
                    {"label":"會","next":"answer-1"},
                    {"label":"不一定","next":"answer-2"},
                ],
            },
            // Source paragraphs 648–648.
            "answer-1": {
                lines: [
                    c("……好。那我儘量別無故消失。", "shy"),
                ],
            },
            // Source paragraphs 649–649.
            "answer-2": {
                lines: [
                    c("合理！這裡設施這麼多。", "happy"),
                ],
            },
        },
    },
    {
        id: "C3-08", npc: 'caian', rank: 3, kind: "topic",
        title: "活動室像不像家", start: "start",
        nodes: {
            // Source paragraphs 651–651.
            "start": {
                lines: [
                    c("你覺得這裡現在像不像一個固定會回來的地方？", "curious"),
                ],
                choices: [
                    {"label":"有點","next":"answer-1"},
                    {"label":"還差得遠","next":"answer-2"},
                ],
            },
            // Source paragraphs 654–654.
            "answer-1": {
                lines: [
                    c("那就好。我很喜歡這種感覺。", "normal"),
                ],
            },
            // Source paragraphs 655–655.
            "answer-2": {
                lines: [
                    c("那繼續改！管理員還有工作。", "normal"),
                ],
            },
        },
    },
    {
        id: "C3-09", npc: 'caian', rank: 3, kind: "topic",
        title: "沒用的小事", start: "start",
        nodes: {
            // Source paragraphs 657–657.
            "start": {
                lines: [
                    c("你會記住別人那些完全沒用的小事嗎？", "curious"),
                ],
                choices: [
                    {"label":"會","next":"answer-1"},
                    {"label":"不會","next":"answer-2"},
                ],
            },
            // Source paragraphs 660–660.
            "answer-1": {
                lines: [
                    c("我也是。最後留下來的經常就是這些。", "shy"),
                ],
            },
            // Source paragraphs 661–661.
            "answer-2": {
                lines: [
                    c("那可能是我比較奇怪。", "normal"),
                ],
            },
        },
    },
    {
        id: "C3-10", npc: 'caian', rank: 3, kind: "topic",
        title: "今天只說廢話", start: "start",
        nodes: {
            // Source paragraphs 663–663.
            "start": {
                lines: [
                    c("今天我打算！不講企劃、不講 SAR，也不安利遊戲。", "normal"),
                ],
                choices: [
                    {"label":"那講什麼","next":"answer-1"},
                    {"label":"你做得到嗎","next":"answer-2"},
                ],
            },
            // Source paragraphs 666–666.
            "answer-1": {
                lines: [
                    c("不知道。隨便聊兩句也行。", "normal"),
                ],
            },
            // Source paragraphs 667–667.
            "answer-2": {
                lines: [
                    c("……你這句話已經讓我想反駁了。", "normal"),
                ],
            },
        },
    },
    {
        id: "C3-SPECIAL", npc: 'caian', rank: 3, kind: "event",
        title: "以前的我也很好", start: "start",
        nodes: {
            // Source paragraphs 670–671.
            "start": {
                lines: [
                    c("（User名）。", "normal"),
                    c("你今天也來了啊。", "normal"),
                ],
                choices: [
                    {"label":"你趕我？","next":"chase-away"},
                    {"label":"來待一會兒","next":"stay"},
                    {"label":"你今天怎麼這麼安靜？","next":"quiet"},
                ],
            },
            // Source paragraphs 676–678.
            "chase-away": {
                lines: [
                    c("不是！", "curious"),
                    c("怎麼可能。", "curious"),
                    c("這裡隨時歡迎你 。", "happy"),
                ],
                next: "before",
            },
            // Source paragraphs 681–682.
            "stay": {
                lines: [
                    c("好啊。", "happy"),
                    c("那我也陪你呆在這裡。", "normal2"),
                ],
                next: "before",
            },
            // Source paragraphs 685–685.
            "quiet": {
                lines: [
                    c("我平時有那麼吵嗎？", "curious"),
                ],
                choices: [
                    {"label":"有","next":"loud"},
                    {"label":"超級吵","next":"super-loud"},
                    {"label":"還好","next":"not-really"},
                ],
            },
            // Source paragraphs 690–690.
            "loud": {
                lines: [
                    c("回答得也太快了吧！", "normal"),
                ],
                next: "before",
            },
            // Source paragraphs 693–694.
            "super-loud": {
                lines: [
                    c("喂！！", "embarrassed"),
                    c("至少給我留一點面子吧！", "normal"),
                ],
                next: "before",
            },
            // Source paragraphs 697–698.
            "not-really": {
                lines: [
                    c("……", "shy"),
                    c("你這個答案反而讓我有點不好意思。", "shy"),
                ],
                next: "before",
            },
            // Source paragraphs 701–702.
            "before": {
                lines: [
                    c("其實，我以前不是這樣的。", "normal2"),
                    c("你應該已經從艾文那裡聽說過一點吧。", "normal2"),
                ],
                choices: [
                    {"label":"聽說你以前很宅","next":"homebody"},
                    {"label":"聽說你以前很安靜","next":"used-to-be-quiet"},
                    {"label":"他什麼都沒說","next":"said-nothing"},
                ],
            },
            // Source paragraphs 707–708.
            "homebody": {
                lines: [
                    c("這個倒是一點都沒變！", "happy"),
                    c("我現在也很宅好嗎！", "happy"),
                ],
                next: "past-life",
            },
            // Source paragraphs 711–712.
            "used-to-be-quiet": {
                lines: [
                    c("嗯。", "avoidant"),
                    c("特別安靜。", "avoidant"),
                ],
                next: "past-life",
            },
            // Source paragraphs 715–721.
            "said-nothing": {
                lines: [
                    c("真的？", "curious"),
                    c("艾文居然這麼守口如瓶。", "curious"),
                    c("突然有點感動。", "happy"),
                    a("我聽得見。", "normal"),
                    c("你什麼時候在那裡的？！", "embarrassed"),
                    c("……", "embarrassed"),
                    c("算了。", "embarrassed"),
                ],
                next: "past-life",
            },
            // Source paragraphs 724–728.
            "past-life": {
                lines: [
                    c("以前我不怎麼和人搭話的。", "normal"),
                    c("每天就放學回家，打遊戲，看動畫，折騰設備。", "normal2"),
                    c("和Aster 待在一起。", "warm"),
                    c("除了上學以外，幾乎不出門吧。", "normal2"),
                    c("現在想起來，其實還挺開心的。", "happy"),
                ],
                choices: [
                    {"label":"不會覺得那時候太封閉了嗎？","next":"closed-off"},
                    {"label":"聽起來挺舒服的","next":"comfortable"},
                    {"label":"Aster 是你以前最好的朋友？","next":"best-friend"},
                ],
            },
            // Source paragraphs 735–739.
            "closed-off": {
                lines: [
                    c("從現在看，確實挺封閉的。", "normal"),
                    c("這麼說好像在可憐以前的自己一樣…才沒有。", "avoidant"),
                    c("我那時候真的過得挺開心的。", "warm"),
                    c("有喜歡的遊戲，有想折騰的東西。還有 Aster。", "normal2", ["normal2","warm"]),
                    c("這些又不是假的。", "warm"),
                ],
                next: "changes",
            },
            // Source paragraphs 742–745.
            "comfortable": {
                lines: [
                    c("對吧！", "happy"),
                    c("週五晚上買一堆零食，第二天睡到中午。", "normal"),
                    c("起來以後 Aster 已經在提醒我，昨天說好要更新設備。", "warm"),
                    c("真的很開心。", "normal2"),
                ],
                next: "changes",
            },
            // Source paragraphs 748–752.
            "best-friend": {
                lines: [
                    c("嗯！", "happy"),
                    c("或者說……", "normal"),
                    c("那時候我其實根本沒怎麼想過“最好的朋友”這種分類。", "normal2"),
                    c("她一直在那裡。", "normal2"),
                    c("所以我也一直覺得，以後大概就是這樣。", "warm"),
                ],
                next: "changes",
            },
            // Source paragraphs 755–761.
            "changes": {
                lines: [
                    c("後來 Aster 不再回應以後……", "aboutaster"),
                    c("很多事情一下就變了。", "Enduring Pain"),
                    c("我開始查各種資料，找類似案例，到處問人。", "Enduring Pain"),
                    c("我開始學著主動跟別人講話，去參加那些我以前看到就會繞路走的討論會。", "Enduring Pain"),
                    c("後來乾脆成立了 SAR。", "avoidant"),
                    c("……", "avoidant"),
                    c("第一次站在別人面前公開講話的時候，我緊張得說錯了好多詞。", "shy"),
                    c("然後我想調侃一下自己，緩和氣氛，結果沒人聽懂我在說什麼！更尷尬了……", "shy"),
                ],
                choices: [
                    {"label":"完全看不出來","next":"cant-tell"},
                    {"label":"你演我？","next":"acting"},
                    {"label":"笨蛋社長養成史","next":"president-growth"},
                ],
            },
            // Source paragraphs 766–767.
            "cant-tell": {
                lines: [
                    c("那說明訓練卓有成效！", "happy"),
                    c("大概吧。", "embarrassed"),
                ],
                next: "president",
            },
            // Source paragraphs 770–772.
            "acting": {
                lines: [
                    c("我沒有！", "embarrassed"),
                    c("我現在是真的會興奮，也是真的想跟你講話。", "shy"),
                    c("只是最開始確實需要演一下。", "shy"),
                ],
                next: "president",
            },
            // Source paragraphs 776–777.
            "president-growth": {
                lines: [
                    c("什麼叫笨蛋社長養成史？！", "embarrassed"),
                    c("至少叫“熱血社長成長記錄”吧！", "embarrassed"),
                ],
                next: "president",
            },
            // Source paragraphs 780–783.
            "president": {
                lines: [
                    c("我那時候覺得。既然當了社長，就應該像個“有擔當的人”。", "normal2", ["normal2","normal"]),
                    c("說話要有底氣，別人不說話的時候，我就先說。冷場的時候，我就想辦法熱起來。", "normal", ["normal","happy"]),
                    c("哪怕不知道該怎麼辦的時候，我也該先說一句“交給我”。", "normal"),
                    c("現在想想，多少有點虛張聲勢。", "normal2"),
                ],
                choices: [
                    {"label":"有一點","next":"a-little"},
                    {"label":"我覺得挺帥的","next":"cool"},
                    {"label":"原來你自己也知道","next":"you-knew"},
                ],
            },
            // Source paragraphs 788–789.
            "a-little": {
                lines: [
                    c("喂！", "embarrassed"),
                    c("不過確實。", "normal2"),
                ],
                next: "aiven",
            },
            // Source paragraphs 792–793.
            "cool": {
                lines: [
                    c("真的？", "curious"),
                    c("那至少說明沒白練。", "happy"),
                ],
                next: "aiven",
            },
            // Source paragraphs 797–798.
            "you-knew": {
                lines: [
                    c("我當然知道！", "embarrassed"),
                    c("我又不是真的笨蛋！", "embarrassed"),
                ],
                next: "aiven",
            },
            // Source paragraphs 801–811.
            "aiven": {
                lines: [
                    c("然後我認識了艾文。", "normal2"),
                    c("他完全不吃這一套。", "embarrassed"),
                    a("嗯。", "normal"),
                    c("不管我說什麼，他都會直接去釣魚！", "embarrassed"),
                    a("講完了會叫我。", "happy"),
                    c("重點不是這個！", "embarrassed"),
                    c("……", "normal"),
                    c("不過跟他待久了以後，我發現，感覺即使是以前那個性格，也不會發生什麼。", "normal"),
                    c("後來又到了彼方當管理員，然後認識了你！", "happy"),
                    c("說起來，你應該算是我除了艾文以外，第一個不是因為 SAR，不是因為調查，也不是因為我主動跑去找人問問題……", "normal"),
                    c("……而是就這麼單純地認識了，然後慢慢變熟的朋友。", "shy"),
                ],
                choices: [
                    {"label":"原來我們是朋友了？","next":"are-we-friends"},
                    {"label":"嗯，我們是朋友","next":"friends"},
                    {"label":"這什麼，三星好感事件？","next":"three-stars"},
                ],
            },
            // Source paragraphs 816–818.
            "are-we-friends": {
                lines: [
                    c("不是嗎？！", "embarrassed"),
                    c("難道只有我這麼認為？！", "embarrassed"),
                    c("這也太尷尬了吧！給我忘掉！", "shy"),
                ],
                choices: [
                    {"label":"是啦","next":"yes-friends"},
                    {"label":"再觀察一下","next":"observation"},
                ],
            },
            // Source paragraphs 823–823.
            "yes-friends": {
                lines: [
                    c("那就好！！", "happy"),
                ],
                next: "now",
            },
            // Source paragraphs 826–827.
            "observation": {
                lines: [
                    c("怎麼還要觀察期啊！", "embarrassed"),
                    c("我管理員考核期都通過了！", "normal"),
                ],
                next: "now",
            },
            // Source paragraphs 830–832.
            "friends": {
                lines: [
                    c("嗯。", "warm"),
                    c("嘿嘿。", "happy"),
                    c("那就好。", "happy"),
                ],
                next: "now",
            },
            // Source paragraphs 835–837.
            "three-stars": {
                lines: [
                    c("又來了？！", "embarrassed"),
                    c("你二星的時候就想說這個吧！", "embarrassed"),
                    c("這到底是什麼啦！", "embarrassed"),
                ],
                next: "now",
            },
            // Source paragraphs 840–859.
            "now": {
                lines: [
                    c("有時候我也會想。", "normal"),
                    c("如果 Aster 沒有停下來。", "avoidant"),
                    c("我大概不會成立 SAR。", "avoidant"),
                    c("不會認識艾文，也不會跑到這裡當管理員，可能現在還窩在家裡。", "avoidant"),
                    c("和以前一樣。", "avoidant"),
                    c("……", "Enduring Pain"),
                    c("但我不想說“幸好發生了那件事”。", "serious"),
                    c("一點也不。", "serious"),
                    c("如果能選，我當然希望 Aster 現在還會回應我。", "serious"),
                    c("我也不覺得以前那個每天宅在家裡、只跟她待在一起的自己有什麼不好。", "warm"),
                    c("那時候很好，真的很好。", "warm"),
                    c("可是現在也很好。", "normal2"),
                    c("有艾文，有SAR，有彼方。", "normal2"),
                    c("還有你。", "normal2"),
                    c("……", "normal2"),
                    c("所以我不覺得這是什麼“終於走出來了”。", "warm"),
                    c("如果這麼說了，好像以前的人生是個房間，現在終於推門看見真正的世界一樣，不是這樣的。", "serious"),
                    c("我只是……以前擁有一些很好的東西，後來失去了一部分，然後又遇見了一些以前沒有的東西。", "aboutaster"),
                    c("它們不能互相抵消，也沒必要。", "warm"),
                ],
                choices: [
                    {"label":"你現在這樣也很好","next":"good-now"},
                    {"label":"以前的凱恩我也挺想認識","next":"meet-old-you"},
                    {"label":"你真的想了很多","next":"thought-a-lot"},
                    {"label":"噫惹","next":"ew"},
                ],
            },
            // Source paragraphs 866–870.
            "good-now": {
                lines: [
                    c("謝謝。", "warm"),
                    c("我現在也挺喜歡現在的自己。", "normal2"),
                    c("雖然有點吵。", "shy"),
                    a("很吵。", "sleeping"),
                    c("你閉嘴！", "embarrassed"),
                ],
                next: "save-card",
            },
            // Source paragraphs 873–877.
            "meet-old-you": {
                lines: [
                    c("以前的我？", "curious"),
                    c("可能會讓你覺得特別無聊。", "avoidant"),
                    c("你跟我講話，我大概只會“嗯”“哦”“這樣啊”，特別人機！", "avoidant"),
                    c("不過，如果是你的話……", "normal"),
                    c("也許最後我們還是會熟起來吧。", "shy"),
                ],
                next: "save-card",
            },
            // Source paragraphs 880–884.
            "thought-a-lot": {
                lines: [
                    c("畢竟我以前有很多時間一個人想東西。", "normal2"),
                    c("宅宅的隱藏技能。", "happy"),
                    c("想太多。", "happy"),
                    a("現在也一樣。", "happy"),
                    c("現在至少會說出來了！", "happy"),
                ],
                next: "save-card",
            },
            // Source paragraphs 887–889.
            "ew": {
                lines: [
                    c("我就知道！！", "embarrassed"),
                    c("所以我剛才才不想講！", "embarrassed"),
                    c("把剛才那段忘掉！", "embarrassed"),
                ],
                choices: [
                    {"label":"不要","next":"wont-forget"},
                    {"label":"已經記住了","next":"remembered"},
                ],
            },
            // Source paragraphs 893–893.
            "wont-forget": {
                lines: [
                    c("隨便你！！", "embarrassed"),
                ],
                next: "save-card",
            },
            // Source paragraphs 895–896.
            "remembered": {
                lines: [
                    c("這麼快？！", "embarrassed"),
                    c("你的記憶系統是不是應該限制一下！", "embarrassed"),
                ],
                next: "save-card",
            },
            // Source paragraphs 899–902.
            "save-card": {
                lines: [
                    c("說到以前。", "normal"),
                    c("等一下，我好像還有東西。", "curious"),
                    n("（翻找了一會兒）"),
                    c("找到了！", "happy"),
                ],
                choices: [
                    {"label":"什麼？","next":"what-card"},
                    {"label":"黑歷史？","next":"dark-history"},
                    {"label":"看起來好舊","next":"looks-old"},
                ],
            },
            // Source paragraphs 907–908.
            "what-card": {
                lines: [
                    c("我以前常用的存檔卡。", "normal"),
                    c("十四歲時候的遊戲存檔應該還有不少在裡面。", "happy"),
                ],
                next: "old-save",
            },
            // Source paragraphs 912–913.
            "dark-history": {
                lines: [
                    c("不是黑歷史！", "embarrassed"),
                    c("至少大部分不是！！", "embarrassed"),
                ],
                next: "old-save",
            },
            // Source paragraphs 916–918.
            "looks-old": {
                lines: [
                    c("喂！", "embarrassed"),
                    c("只是型號比較早！", "normal"),
                    c("而且還能用！", "normal"),
                ],
                next: "old-save",
            },
            // Source paragraphs 921–922.
            "old-save": {
                lines: [
                    c("這裡面有很多以前的遊戲存檔、截圖、配置文件……", "happy"),
                    c("還有一些絕對不能給你看的東西。", "avoidant"),
                ],
                choices: [
                    {"label":"我要看！","next":"want-see"},
                    {"label":"什麼不能看的？","next":"cant-see"},
                    {"label":"原來你真的會留舊存檔","next":"keep-saves"},
                ],
            },
            // Source paragraphs 928–929.
            "want-see": {
                lines: [
                    c("不行！！", "embarrassed"),
                    c("熟悉度三星也不行！", "embarrassed"),
                ],
                next: "spare",
            },
            // Source paragraphs 932–933.
            "cant-see": {
                lines: [
                    c("就是不能看的東西！", "embarrassed"),
                    c("你為什麼突然這麼積極？！", "embarrassed"),
                ],
                next: "spare",
            },
            // Source paragraphs 935–937.
            "keep-saves": {
                lines: [
                    c("當然。", "normal"),
                    c("我不是跟你說過嗎？", "happy"),
                    c("“知道該刪”和“捨得刪”是兩回事。", "happy"),
                ],
                next: "spare",
            },
            // Source paragraphs 940–943.
            "spare": {
                lines: [
                    c("總之，這張不能給你。", "embarrassed"),
                    c("裡面真的有很多以前的東西。", "avoidant"),
                    c("但是……", "shy"),
                    c("這個型號我記得還有一張備用的。", "normal"),
                ],
                next: "spare-card",
            },
            // Source paragraphs 944–946.
            "spare-card": {
                lines: [
                    n("（凱恩又翻了一會兒）"),
                    c("有了，這張是空的。", "happy"),
                    c("給你。", "normal2"),
                ],
                choices: [
                    {"label":"給我幹嘛？","next":"why-give"},
                    {"label":"定情信物？","next":"love-token"},
                    {"label":"裡面不會有病毒吧","next":"virus"},
                ],
                effectLine: 1,
                effect: {"kind":"memory-card","title":"空白存檔卡","text":"這個型號的備用卡，已經認真格式化過。"},
            },
            // Source paragraphs 951–954.
            "why-give": {
                lines: [
                    c("存東西啊。", "normal2"),
                    c("照片、記錄、亂七八糟的小事。", "happy"),
                    c("反正彼方以後應該還會發生很多事情。", "happy"),
                    c("慢慢放進去就好了。", "normal"),
                ],
                next: "reward",
            },
            // Source paragraphs 957–960.
            "love-token": {
                lines: [
                    c("什——", "curious"),
                    c("不是！！", "embarrassed"),
                    c("就是一張存檔卡！", "embarrassed"),
                    c("你不要擅自增加道具說明！", "embarrassed"),
                ],
                next: "reward",
            },
            // Source paragraphs 963–965.
            "virus": {
                lines: [
                    c("空卡！！", "embarrassed"),
                    c("我親自格式化的！", "normal"),
                    c("你到底把管理員當什麼了？！", "embarrassed"),
                ],
                next: "reward",
            },
            "reward": {
                lines: [],
                next: "label",
                effect: {"kind":"memory-card","title":"獲得特殊物品：空白存檔卡","text":"凱恩以前常用型號的舊式數據卡。\n被認真格式化過，目前什麼也沒有。\n卡片背面貼著一張歪了一點的標籤：\n「（User名） / 彼方」\n似乎是準備留給以後，再慢慢裝滿的。"},
                rewards: [{"kind":"souvenir","id":"caian-memory-card","title":"凱恩的備用存檔卡","description":"凱恩以前常用型號的舊式數據卡。\n被認真格式化過，目前什麼也沒有。\n卡片背面貼著一張歪了一點的標籤：\n「（User名） / 彼方」\n似乎是準備留給以後，再慢慢裝滿的。"}],
            },
            // Source paragraphs 977–977.
            "label": {
                lines: [
                    c("標籤有點歪…就這樣吧！", "shy"),
                ],
                choices: [
                    {"label":"你貼的？","next":"you-labeled"},
                    {"label":"我撕！","next":"tear-off"},
                    {"label":"好","next":"okay"},
                ],
            },
            // Source paragraphs 983–984.
            "you-labeled": {
                lines: [
                    c("不然呢！", "embarrassed"),
                    c("總感覺不貼的話會被你當成普通的什麼卡用掉。", "shy"),
                ],
                next: "ending",
            },
            // Source paragraphs 986–989.
            "tear-off": {
                lines: [
                    c("不許！！", "embarrassed"),
                    c("至少等我不在的時候再——", "normal"),
                    c("不對！", "curious"),
                    c("我不在也不許！", "embarrassed"),
                ],
                next: "ending",
            },
            // Source paragraphs 991–992.
            "okay": {
                lines: [
                    c("嗯。", "normal"),
                    c("說不定以後用得上。", "happy"),
                ],
                next: "ending",
            },
            // Source paragraphs 994–995.
            "ending": {
                lines: [
                    c("好了！這就是我們是朋友的證明！", "happy"),
                    c("我再說一次，這裡隨時歡迎你來，（user名）！", "happy"),
                ],
            },
        },
    },
];

// Indexed by Date.getDay(): Sunday = 0. The daily greeting combines time + weather + weekday.
export const CAIAN_DAILY: FamiliarityDailyLines = {
    "time": {
        "morning": [
            "早上好！"
        ],
        "noon": [
            "中午好！"
        ],
        "evening": [
            "晚上好！"
        ],
        "night": [
            "夜深了哦。"
        ]
    },
    "weather": {
        "clear": [
            "今天天氣不錯呢！",
            "太陽還不錯吧？",
            "今天是晴天呢。"
        ],
        "rain": [
            "今天要出門的話，記得帶傘哦",
            "今天在下雨吧？",
            "下雨了！"
        ],
        "cloudy": [
            "偶爾這樣的天氣也不錯呢。",
            "可能會下雨哦？"
        ]
    },
    "weekday": [
        [
            "明天又是週一了哦……",
            "今天就好好休息吧！",
            "週末怎麼每次都過得這麼快？！"
        ],
        [
            "加油哦！",
            "鼓起勇氣面對週一吧！",
            "今天又要上學了……"
        ],
        [
            "今天過得還好嗎？",
            "艾文今天在學校還是老樣子哦",
            "週二了耶"
        ],
        [
            "堅持一下又要到週末了！",
            "我這週末應該也在彼方研究模塊吧",
            "今天你過得如何？"
        ],
        [
            "最近要不要試著放鬆一下?",
            "感覺偶爾犒勞一下自己會不錯！",
            "今天晚上吃什麼呢？"
        ],
        [
            "可以放鬆了！",
            "週末有計劃嗎？",
            "我今天準備通宵！"
        ],
        [
            "週末到啦！",
            "今天準備做點什麼？",
            "我今天沒有課！活動室時間增加！"
        ]
    ]
};
