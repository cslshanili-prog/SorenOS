// 即時對話的接線守衛（源碼級斷言）。
//
// 倉庫的 vitest 是純 Node 環境（沒裝 jsdom），useChatAI 是個綁死 React 的大 hook、
// Chat.tsx 和設置面板是組件，都跑不起來測行為，所以沿用 amsg2ChatLoop.wiring.test.ts
// 的做法：讀源碼釘接線。它驗證不了運行時時序，只防「接線被誤刪 / 改回去」這一種迴歸。
//
// 這裡釘的每一條，塌了都不會報錯，只會表現成「功能怎麼不響」：
//   · 分流條件漏了工具循環的排除 → 瑞一杯/麥當勞選完城市沒反應（請求交給 worker 了）；
//   · 失敗時悄悄回本地跑 → 用戶以為雲端在跑，其實每條都在本地生成，查無可查；
//   · 收尾還打髒 → 同一份 fire_pack 再傳一遍，白走一趟網絡；
//   · 「正在輸入…」不看落盤記錄 → 關一次頁面燈就沒了，用戶以為消息丟了；
//   · 路由不在構建 prompt 之前定下來 → 上雲那份也烤前端時效段，一份 prompt 兩個鍾。
//
// 取源碼片段統一走 sliceSrc（下面那個 helper）：按需調用、兩個錨點都要命中，
// 找不到就拋一條寫明是哪一段、缺哪個錨點的錯，只掛真正用到它的那幾條用例。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const chatAiSrc = read('../hooks/useChatAI.ts');
const chatSrc = read('../apps/Chat.tsx');
const settingsSrc = read('../components/settings/ActiveMsgGlobalSettingsModal.tsx');

/** 即時對話分支的判定行（分支起點、也是排序基準）。 */
const INSTANT_CHAT_BRANCH_HEAD = 'if (instantChatRoute)';
/** 路由判定那一段的起點（否決名單從這行開始拼）。 */
const ROUTING_HEAD = 'const luckinChatOn =';

/**
 * 取一段源碼：從起點錨點到終點錨點之間。兩個錨點都要求命中，找不到就拋一條寫明
 * 「哪一段、哪個錨點」的錯——按需調用，只有真正用到這一段的用例會掛，其餘照跑。
 * （別在模塊頂層取：那樣錨點一改名整份文件在收集階段就集體陣亡，報出來的還是
 * `expected -1 to be greater than -1`，看不出是哪條不變量塌了。）
 */
const sliceSrc = (src: string, label: string, startAnchor: string, endAnchor: string): string => {
  const start = src.indexOf(startAnchor);
  if (start < 0) {
    throw new Error(`[${label}] 找不到起點錨點 ${JSON.stringify(startAnchor)}。先確認這條不變量本身還在（只是改了名就更新錨點，被刪了就是真迴歸）。`);
  }
  const end = src.indexOf(endAnchor, start);
  if (end <= start) {
    throw new Error(`[${label}] 起點之後找不到終點錨點 ${JSON.stringify(endAnchor)}，這一段的邊界變了。`);
  }
  return src.slice(start, end);
};

/** 路由判定那一段源碼（在 buildChatRequestPayload 之前算好，上雲與否 + 要不要剝時效段 + 沒上雲的留痕）。 */
const routingSrc = () => sliceSrc(chatAiSrc, '即時對話路由段', ROUTING_HEAD, 'const payload = await stageT(');

/** 即時對話分支那一段源碼（從判定行到它自己的 return）。 */
const branchSrc = () => sliceSrc(chatAiSrc, '即時對話分支', INSTANT_CHAT_BRANCH_HEAD, '// 流式預覽：');

/** Chat 裡自動合成語音那個 effect 的源碼（含它的依賴數組）。 */
const autoTtsSrc = () => sliceSrc(chatSrc, '語音自動合成', '// --- Auto-TTS: when chatVoiceEnabled', 'const canReroll =');

describe('useChatAI 的分流接縫', () => {
  it('MCP 本身不在排除名單裡（worker 會跑後台 MCP；整片排掉 = 配了 MCP 的人永遠靜默走本地）', () => {
    // e2e 實測踩過：只要全局有一台 enabled 的 MCP 服務器，mcpChatActive 對所有角色為真，
    // 拿它當排除條件的話，即時對話開關亮著卻永遠走本地生成，用戶查無可查。
    // 判定挪到構建 payload 之前之後，這條要連路由那一段一起看。
    // （地址 worker 夠不著的那幾台是另一回事，見下面那條。）
    expect(routingSrc()).not.toContain('mcpChatActive');
    expect(branchSrc()).not.toContain('mcpChatActive');
  });

  it('本機/內網地址的 MCP 服務器否決這一輪上雲（上雲會讓角色掉工具）', () => {
    // 上雲那一輪前端不注入 MCP 說明塊（chatRequestPayload 的 timelyByWorker 分支），
    // 而上雲清單 collectMcpFireServers 恰好把 localhost / 私網地址過濾掉了——兩邊都不說，
    // 角色這一輪徹底不知道自己有工具，設置頁卻還顯示 MCP 已連接、聊天界面毫無異常。
    // 判據是「這一輪上雲會掉能力就別上雲」，所以它得是個 veto、且帶 char.id（服務器可綁角色）。
    const routing = routingSrc();
    expect(routing).toContain('hasWorkerUnreachableMcpServer(char.id)');
    expect(routing).toContain("'mcp-worker-unreachable'");
    // 否決也要留痕：走的是下面那條統一的 instant-chat-veto trace（reason 帶著它）。
    expect(routing).toContain('const skipReason = instantChatVeto;');
    expect(routing).toContain('reason: skipReason');
  });

  it('全局配置讀不出來單獨留一條 trace（它不是「用戶沒開」）', () => {
    // 讀失敗時 instantChatOn 天然為假，veto 那條 trace 的條件夠不到它。不單獨留痕的話，
    // 這一輪悄悄退回本地直連生成，用戶按完發送鎖屏就什麼都收不到，觀察窗裡還查無此事。
    const routing = routingSrc();
    expect(routing).toContain('resolveInstantChatReadiness');
    expect(routing).toContain("reason === 'config-unreadable'");
    expect(routing).toContain("event: 'instant-chat-config-unreadable'");
    // 跟 veto 一樣只報不攔（那條 return 的守衛在下面「留痕只此一處」那條裡）。
  });

  it('角色級即時對話開關吃進路由判定（char-disabled 靜默走本地，不留 veto trace）', () => {
    const routing = routingSrc();
    // readiness 判定必須帶上 char：角色單獨關了的話 ready 直接為 false，veto trace 的
    // 條件（instantChatOn && …）夠不到它。不帶 char 的話角色關了照上雲——舊行為回潮。
    expect(routing).toContain('resolveInstantChatReadiness(char)');
    // 也不許給 char-disabled 單開留痕分支：那是用戶的主動選擇，和「全局沒開」同一待遇，
    // 每條消息刷一遍 warn 就成騷擾了。查的是帶引號的字面量——真要按它分支繞不開這個比較；
    // 註釋裡提一嘴不算。
    expect(routing).not.toContain("'char-disabled'");
  });

  it('上雲的判定在構建 prompt 之前就定下來，並作為 timelyByWorker 交給 payload', () => {
    // 這一條釘的是「一份 prompt 只剩一個鐘」：走雲端時前端不烤時鐘/節日/天氣/熱搜/
    // MCP 說明，那幾段由 worker 在 fire 時刻獨家補。判定要是又挪回分支裡現算，
    // payload 就只能按全量構建，模型會同時讀到前端快照和 worker 現拉的兩份。
    expect(routingSrc()).toContain('const instantChatRoute =');
    expect(chatAiSrc).toMatch(/timelyByWorker:\s*instantChatRoute/);
    const routeAt = chatAiSrc.indexOf('const instantChatRoute =');
    const payloadAt = chatAiSrc.indexOf('const payload = await stageT(');
    expect(routeAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeGreaterThan(routeAt);
    // 上雲只看兩樣：即時對話就緒、沒被否決。
    expect(routingSrc()).toContain('const instantChatRoute = instantChatOn && !instantChatVeto;');
  });

  it('雲端生成只剩即時對話這一條路（聊天鏈路裡不再有別的雲端發送分支）', () => {
    // 發送、情緒評估、安全網都只認 instantChatRoute；再冒出一條雲端分支的話，這幾處
    // 要各自重新分叉，漏一處就是「按一條路打包、實際走了另一條」。
    for (const src of [chatAiSrc, chatSrc]) {
      for (const gone of ['instantPushClient', 'isInstantConfigReady', 'sendInstantPushAndAwaitReply', 'onInstantPosted']) {
        expect(src).not.toContain(gone);
      }
    }
    expect(chatAiSrc).not.toContain('cloudGenRoute');
  });

  it('分支只認 instantChatRoute，不拿原料重算一遍', () => {
    // 「這份 prompt 剝沒剝時效段」和「這一輪走不走雲端」必須出自同一個值。分支要是
    // 自己再拿 instantChatOn / 否決名單拼一次條件，兩處早晚會不同意——剝過時效段的
    // prompt 就落到本地那條路上去了。
    const branch = branchSrc();
    for (const reDerived of ['instantChatOn', 'instantChatVeto']) {
      expect(branch).not.toContain(reDerived);
    }
    // 上雲那一路一進來就直奔發送，中間沒有別的門。
    expect(branch.indexOf('sendInstantChatTurn')).toBeGreaterThan(-1);
    expect(branch).toContain('return;');
  });

  it('開著即時對話卻沒上雲 —— 每一種情形都在路由段留 trace，就這一處', () => {
    // 原因都在否決名單裡：SAR 模塊、點單流程（瑞幸/麥當勞要客戶端交互）、MCP 地址夠不著，
    // 這一輪留在本地是對的。哪一種沒留痕，都是「開關亮著、消息照常出來」的靜默分流，用戶查無可查。
    const routing = routingSrc();
    // 否決的三個來源和 payload.flags 同源，只是算得更早
    for (const source of ['luckinChatRef?.current?.active', 'mcdMiniOpen', 'luckinMiniOpen']) {
      expect(routing).toContain(source);
    }
    expect(routing).toContain('const instantChatVeto');
    expect(routing).toContain("event: 'instant-chat-veto'");
    // 判定用的是「上雲沒成」這個總口徑，不是逐個原因去數——漏一種就又靜默了。
    expect(routing).toMatch(/if \(instantChatOn && !instantChatRoute\)/);
    // 留痕只此一處：多寫一處遲早會漏掉某種情形，或者同一輪報兩遍。
    const traceSites = chatAiSrc.match(/event: 'instant-chat-veto'/g) ?? [];
    expect(traceSites.length).toBe(1);
    // 只報不攔：報完照常往下走本地路徑，不能順手 return 掉整輪。
    // （config-unreadable 的裸情形是唯一例外——那檔要攔，單獨一條用例釘在下面。）
    const vetoBranch = sliceSrc(
      chatAiSrc,
      '否決留痕分支',
      'if (instantChatOn && !instantChatRoute)',
      "} else if (instantChatReadiness.reason === 'config-unreadable')",
    );
    expect(vetoBranch).not.toContain('return;');
  });

  it('配置讀不出來（config-unreadable）：裸情形明確報錯攔下這一輪，veto 在場只留痕', () => {
    // 靜默退回本地的坑：用戶按「發完就自由」的心智鎖屏，本地 fetch 被系統掐死，回來
    // 既無回覆也無報錯，設置頁還寫著「已開啟」。裸情形（沒有否決）
    // 必須與 sendInstantChatTurn 失敗同口徑：落系統消息 + 彈錯 + return，不發起本地
    // 生成。迴歸守衛——改回「靜默走本地」這條會掛。
    const branch = sliceSrc(
      chatAiSrc,
      'config-unreadable 分支',
      "} else if (instantChatReadiness.reason === 'config-unreadable')",
      'const payload = await stageT(',
    );
    expect(branch).toContain("event: 'instant-chat-config-unreadable'");
    // 裸情形的判定與兩檔去向：veto 在場時本就輪不到即時對話，照原路只留痕不攔。
    expect(branch).toMatch(/configUnreadableFailsTurn = !instantChatVeto;/);
    expect(branch).toMatch(/outcome: configUnreadableFailsTurn \? 'turn-failed' : 'other-route'/);
    // 攔下的那一檔：落系統消息、彈錯、return——絕不靜默退回本地生成。
    expect(branch).toMatch(/if \(configUnreadableFailsTurn\) \{[\s\S]*?return;/);
    expect(branch).not.toContain('safeFetchJson');
  });

  it('雲端拿到的就是本地要發的那串消息和那份憑據（回執塊只附在末尾，不動原消息）', () => {
    // 基底永遠是 fullMessages；有作廢回執時單獨成塊貼在末尾（雲端到點自己渲染排程
    // 清單和能力簡介，chat 段只補回執這一樣，別和 timely block 撞車）。
    expect(branchSrc()).toMatch(/\[\.\.\.fullMessages, \{ role: 'system', content: amsg2NoticesBlock \}\]/);
    expect(branchSrc()).toMatch(/:\s*fullMessages\)/);
    expect(branchSrc()).toMatch(/buildAmsg2NoticesText\(/);
    expect(branchSrc()).toMatch(/baseUrl:\s*effectiveApi\.baseUrl/);
    // model / temperature 取 baseReqBody 的終值：本地那套 thinking 後綴（claude 系
    // -thinking）和「開思考刪溫度」跑完是什麼，雲端就發什麼——同一句話兩條路才是
    // 同一個模型、同一個溫度。回退成 effectiveApi 原始值就是行為分叉的開始。
    expect(branchSrc()).toMatch(/model:\s*baseReqBody\.model/);
    expect(branchSrc()).toMatch(/temperature:\s*baseReqBody\.temperature/);
  });

  it('作廢回執在 202 之後只記帳不銷帳（受理 ≠ 角色讀到過）', () => {
    // 202 只說明雲端收下了。那一輪照樣可能空輸出被判 skip-push、或 fire 重試打光標 failed，
    // 回執不會重新注入——用戶只收到「[即時對話沒能完成…]」並重發，而重發那一輪已經沒有
    // 回執可注入，角色永遠不知道那條任務被作廢過，聊天裡許下的承諾就這麼消失。
    // 正確時機是回覆真的落庫之後（跟本地路徑同一口徑），所以這裡只落台帳。
    const branch = branchSrc();
    expect(branch).not.toContain('markExpiredNoticesNotified');
    expect(branch).toMatch(/instantChatResult\.ok[\s\S]{0,800}stageInstantChatExpiredNotices/);
  });

  it('失敗時不悄悄回本地生成：分支裡沒有本地 LLM 請求，走完就 return', () => {
    expect(branchSrc()).not.toContain('safeFetchJson');
    expect(branchSrc()).not.toContain('chat/completions');
    expect(branchSrc()).toContain('return;');
  });

  it('失敗時留下能看見的痕跡（系統消息 + 彈錯），不是靜默吞掉', () => {
    expect(branchSrc()).toContain("role: 'system'");
    expect(branchSrc()).toMatch(/showError\(/);
  });

  it('受理成功那一輪不再打髒重傳 fire_pack', () => {
    expect(branchSrc()).toContain('instantChatAccepted = true');
    expect(chatAiSrc).toMatch(/if \(!instantChatAccepted\) \{[\s\S]{0,200}markAmsgStateDirty\(/);
  });

  // 情緒評估跟著這一輪一起上雲：用戶發完就能關頁面，評估在 worker 裡跑完，結果隨
  // 最後一條推送回來。留在本地發一槍的話，頁面一關情緒底色和意識流就悄悄停更了。
  it('情緒評估跟著一起交給雲端，不在本地再發一槍', () => {
    expect(branchSrc()).toContain('emotionEval: cloudEmotionEval');
    expect(branchSrc()).not.toContain('fireLocalEmotionEval');
    // 本地那一槍和上雲那份認的是同一個 instantChatRoute，
    // 不然兩邊會同時跑評估（雙扣費，而且後落的那份會蓋掉先落的）。
    expect(chatAiSrc).toMatch(/const fireLocalEmotionEval = \(emotionEvalEnabled && !instantChatRoute/);
    expect(chatAiSrc).toMatch(/const cloudEmotionEval = \(emotionEvalEnabled && instantChatRoute/);
  });

  it('不在這條路上開活躍會話租約（生成不在本機跑，沒人需要它舉手）', () => {
    // 租約那句排在分支的 return 之後，走這條路根本到不了。
    const leaseAt = chatAiSrc.indexOf('startAmsgChatPresence(char.id');
    expect(leaseAt).toBeGreaterThan(chatAiSrc.indexOf(INSTANT_CHAT_BRANCH_HEAD));
    expect(branchSrc()).not.toContain('startAmsgChatPresence');
  });
});

describe('Chat 界面的「正在輸入…」', () => {
  it('燈的依據是落盤的待收記錄，而不是本輪的內存狀態', () => {
    expect(chatSrc).toContain('getInstantChatPending');
    expect(chatSrc).toContain('AMSG_INSTANT_CHAT_PENDING_EVENT');
    // 只訂閱事件、不讀一次現狀的話，重開應用時燈是滅的（記錄還在，回覆還沒到）。
    expect(chatSrc).toMatch(/const sync = \(\) => setInstantChatPending\(/);
  });

  it('三個點的顯示條件帶上它（isTyping 在 POST 完就滅了）', () => {
    expect(chatSrc).toMatch(/\(isTyping \|\| instantChatPending \|\|/);
  });
});

describe('Chat 界面的語音自動合成', () => {
  it('雲端回來的回覆也算數（只認 isTyping 的話，開了自動播放的角色一路靜音）', () => {
    // isTyping 在 POST 完就滅了，即時對話的回覆是之後靠推送落庫的，永遠等不到那一下。
    // 燈滅（instantChatPending 由真變假）開窗 + messages 進依賴補掃，缺一條都沒聲音。
    expect(autoTtsSrc()).toMatch(/wasPending && !instantChatPending/);
    expect(autoTtsSrc()).toMatch(/\}, \[isTyping, instantChatPending, messages\]\)/);
  });

  it('不在窗裡就還是只在打字結束那一下掃（不然每來一條消息都重掃一遍歷史）', () => {
    expect(autoTtsSrc()).toMatch(/if \(!typingJustEnded && !inInstantWindow\) return;/);
  });

  it('換角色把掃描窗作廢（Chat 裡切角色不卸載組件，ref 會跨角色留著）', () => {
    // 甲還欠著回覆時切到乙，指示燈會跟著乙的記錄滅——那不是「乙的回覆到了」，
    // 拿它開窗就會把乙的歷史消息整批合成一遍。
    expect(autoTtsSrc()).toContain('instantVoiceScanCharRef');
  });
});

describe('設置頁那一道門', () => {
  it('版本門檻只有這一處：探 /config-check 的 instantChat 標誌', () => {
    expect(settingsSrc).toContain('probeInstantChatSupport');
    // 逐調用預檢會讓每發一條消息多一次網絡往返，而且探失敗時分不清是舊版還是網抖。
    expect(chatAiSrc).not.toContain('probeInstantChatSupport');
  });

  it('三道門缺一不可：三個輸入都要喂進同一份判定', () => {
    // 順序和每道門的文案釘在 amsgDiagnostics.test.ts（resolveInstantChatBlocker 是純函數，
    // 能直接測）。這裡只釘「設置頁確實把三個輸入都遞過去了」——漏一個的話那道門就消失了，
    // 界面上表現為開關能點，點完發一條掛一條。
    const gate = sliceSrc(settingsSrc, '即時對話開關的置灰理由', 'const instantChatBlocker = resolveInstantChatBlocker(', '\n  const instantChatBlockedReason');
    expect(gate).toContain('isConnected');
    expect(gate).toContain('pushStatus?.hasSubscription');
    expect(gate).toContain('instantChatSupported');
    // 黃字直接取自代號表：文案跟上報屬性共用一份判定，不許哪天各寫各的。
    expect(settingsSrc).toContain('INSTANT_CHAT_BLOCKER_HINTS[instantChatBlocker]');
  });

  it('開不了卡在哪要上報，且跟界面共用那份判定', () => {
    // 開關灰著的時候用戶什麼都點不動，也就不會產生別的事件——不主動收的話，被擋在門外的人
    // 和「不想要這功能的人」在數據里長得一模一樣。
    const report = sliceSrc(settingsSrc, '即時對話可用性上報', 'const reportInstantChatGate', '\n  const refresh');
    expect(report).toContain('resolveInstantChatBlocker(gate)');
    expect(report).toContain(`trackEvent('即时对话能不能开'`);
    // 反覆點「連接」的人否則一個人能刷出十幾條同樣的結果，把分佈帶歪。
    expect(report).toContain('instantChatGateReported');
  });

  it('開關落盤：兩個 saveGlobalConfig 調用點都要帶上它', () => {
    // 漏一處的話，用戶改完 Worker 地址（或點一次「連接」）開關就被衝回默認值。
    const saves = settingsSrc.match(/ActiveMsgStore\.saveGlobalConfig\(\{[\s\S]{0,220}?\}\)/g) ?? [];
    expect(saves.length).toBeGreaterThanOrEqual(3);
    for (const save of saves) {
      expect(save).toContain('instantChatEnabled');
    }
  });
});
