
export enum AppID {
  Launcher = 'launcher',
  Settings = 'settings',
  Character = 'character',
  Chat = 'chat',
  GroupChat = 'group_chat', 
  Gallery = 'gallery',
  Music = 'music',
  Browser = 'browser',
  ThemeMaker = 'thememaker',
  Appearance = 'appearance',
  Date = 'date',
  User = 'user',
  Journal = 'journal',
  Schedule = 'schedule',
  Room = 'room',
  CheckPhone = 'check_phone',
  Social = 'social',
  Study = 'study',
  FAQ = 'faq',
  Game = 'game',
  Worldbook = 'worldbook', 
  Novel = 'novel', 
  Bank = 'bank', // New App
  XhsStock = 'xhs_stock', // XHS image stock for publishing
  SpecialMoments = 'special_moments', // Valentine's Day & future events
  XhsFreeRoam = 'xhs_free_roam', // Character autonomous XHS activity
  Songwriting = 'songwriting', // Songwriting / Lyric creation app
  Call = 'call', // 語音電話測試（MiniMax TTS）
  VoiceDesigner = 'voice_designer', // 捏聲音 — MiniMax 音色設計器
  Guidebook = 'guidebook', // 攻略本 — 角色攻略用戶小遊戲
  LifeSim = 'lifesim', // 模擬人生 — 與角色共同經營的小世界
  MemoryPalace = 'memory_palace', // 記憶宮殿 — 七個房間可視化
  Handbook = 'handbook', // 手帳 — 跨角色聚合的生活留痕本（LLM 代筆 + 角色生活流陪伴）
  QQBridge = 'qq_bridge', // QQ 橋接 — 通過 NapCat 把 QQ 私聊接入當前角色，共享 IndexedDB 上下文
  HotNews = 'hot_news', // 熱點 — 分時段召回的多平台熱榜可視化（決定角色可能聊起的話題）
  VRWorld = 'vrworld', // 彼方 — 角色自主登入的虛擬世界（定時驅動，房間裡看小說/聽歌/留言，產出活動卡注入聊天+記憶）
  CharCreatorDev = 'char_creator_dev', // 捏臉系統開發模式 — 僅開發模式可見，向捏人器指定類目追加自定義部件
  WorldHome = 'world_home', // 家園 — 同世界觀多角色共同生活的大世界（觀測驅動演繹，每角色獨立 LLM 調用 + NPC 世界引擎）
  ChatHub = 'chat_hub', // Chat 主頁 — 消息/聯繫人/動態/主頁四欄導航殼，取代原本直接開 Chat 的入口
}

export interface SystemLog {
    id: string;
    timestamp: number;
    type: 'error' | 'network' | 'system';
    source: string;
    message: string;
    detail?: string;
}

export interface AppConfig {
  id: AppID;
  name: string;
  icon: string;
  color: string;
}

export interface DesktopDecoration {
  id: string;
  type: 'image' | 'preset';
  content: string; // data URI for image, SVG data URI or emoji for preset
  x: number;       // percentage 0-100
  y: number;       // percentage 0-100
  scale: number;   // multiplier (0.2 - 3)
  rotation: number; // degrees (-180 to 180)
  opacity: number;  // 0-1
  zIndex: number;
  flip?: boolean;
}

export type ScheduleCardPresetId =
  | 'original'
  | 'cream'
  | 'sakura'
  | 'mint'
  | 'twilight'
  | 'midnight'
  | 'custom';

/** 全局日程卡片皮膚：所有桌面組件、房間頁與聊天日程彈窗共用。 */
export interface ScheduleCardAppearance {
  preset?: ScheduleCardPresetId;
  /** preset='custom' 時使用；支持顏色或 CSS 漸變。 */
  background?: string;
  textColor?: string;
  accentColor?: string;
  /** 僅允許 .sully-schedule-* 作用域的進階美化。 */
  customCss?: string;
}

export type JournalAppearancePresetId =
  | 'original'
  | 'letterpress'
  | 'sakura'
  | 'forest'
  | 'midnight';

/** 交換日記 App 的全局皮膚。預設負責開箱即用，自定義 CSS 最後注入並可覆蓋預設。 */
export interface JournalAppearance {
  preset?: JournalAppearancePresetId;
  /** 僅允許 .sully-journal-* 作用域，避免樣式影響其它 App。 */
  customCss?: string;
}

export interface OSTheme {
  hue: number;
  saturation: number;
  lightness: number;
  wallpaper: string;
  /** 獨立鎖屏壁紙；未設置時跟隨桌面 wallpaper。 */
  lockWallpaper?: string;
  darkMode: boolean;
  contentColor?: string;
  /** 冷啟動時是否播放整機開機過場。默認開啟（undefined 視為 true）。 */
  bootAnimationEnabled?: boolean;
  /** 整機開場風格；未設置時使用水母。關閉動畫時仍保留選擇。 */
  bootAnimationStyle?: 'classic' | 'jellyfish';
  /** 進入聊天或切換角色時是否播放角色登場過場。默認開啟。 */
  chatCharacterSwitchAnimationEnabled?: boolean;
  /** App 代碼塊加載較慢時是否顯示加載柔光動畫。默認開啟；超時恢復頁不受影響。 */
  appLoadingAnimationEnabled?: boolean;
  /** 桌面整體皮膚。'animalcrossing' = 動森風格（NookPhone 彩色圓角圖標 + 暖色界面）；
   *  'mobilegame' = 二次元手遊首頁風格（角色卡 + 等級經驗條 + 貨幣欄 + 網格卡 + 羅盤 dock）；
   *  'tamagotchi' = 電子寵物養成機（桌面即角色的小屋舞台 + 四顆糖果實體鍵）。默認 'default'。 */
  skin?: 'default' | 'animalcrossing' | 'mobilegame' | 'tamagotchi' | 'companion';
  /** 默認桌面的視覺版本：紙感是現行默認，nostalgia 是用戶主動選擇的最初粉綠白玻璃界面。 */
  desktopVariant?: 'paper' | 'nostalgia';
  /** 動森皮膚下，聊天 App 是否也跟隨換成動森界面。默認 true（undefined 視為 true）。關掉則聊天保持原樣式。 */
  acnhChatSync?: boolean;
  launcherWidgetImage?: string; // DEPRECATED: always stripped on load — never renders.
  launcherWidgets?: Record<string, string>; // slots: 'tl' | 'tr' | 'wide' | 'dsq' (legacy 'bl' / 'br' are banned)
  /** 默認桌面長按編輯後的 App / Dock / 第二頁風車組件順序。 */
  launcherAppOrder?: string[];
  launcherDockOrder?: string[];
  launcherPinwheelOrder?: Array<'music' | 'appsA' | 'appsB' | 'image'>;
  /** 自定義透明圖標是否保留原始輪廓並移除系統圓角底框。默認 false。 */
  preserveCustomIconOutlines?: boolean;
  /** 默認皮膚桌面「正在播放」音樂卡片改用淺色系樣式（新安裝默認 true）。 */
  nowPlayingWidgetLight?: boolean;
  /** 日程卡片統一皮膚：桌面、全屏、房間與聊天內同步。 */
  scheduleCardAppearance?: ScheduleCardAppearance;
  /** 交換日記 App 全局皮膚與自定義 CSS。 */
  journalAppearance?: JournalAppearance;
  desktopDecorations?: DesktopDecoration[];
  customFont?: string;
  /** 頂部時間欄佈局：安全顯示（安全區下方）/ 緊湊顯示（嵌入安全區）/ 完全隱藏。 */
  statusBarMode?: 'standard' | 'compact' | 'hidden';
  /** @deprecated 舊版兩檔開關，僅用於兼容已有存檔；新設置寫入 statusBarMode。 */
  hideStatusBar?: boolean;
  // Chat UI customization (global)
  chatAvatarShape?: 'circle' | 'rounded' | 'square';
  chatAvatarSize?: 'small' | 'medium' | 'large';
  /** 聊天表情包大小三擋：小 96px（默認）/ 中 128px / 大 160px（舊版尺寸）。經 --sully-emoji-size CSS 變量生效 */
  chatEmojiSize?: 'small' | 'medium' | 'large';
  chatAvatarMode?: 'grouped' | 'every_message';
  /** 頭像位置：氣泡旁（默認）/ 每輪消息組上方（固定每輪一次） */
  chatAvatarPlacement?: 'beside' | 'above_group';
  // ── 聊天細節微調（外觀 → 聊天細節）。收編自社區白框美化 CSS，全部可選，缺省 = 現狀。
  //    經 utils/chatFineTuneCss.ts 生成 CSS 注入 .sully-chat-root；用戶自定義白框 CSS 排在其後可覆蓋。
  /** 頭像顯示：雙側 / 隱藏角色側 / 隱藏用戶側 / 全部隱藏 */
  chatAvatarVisibility?: 'both' | 'hide_ai' | 'hide_user' | 'hide_both';
  /** 頭像與氣泡的對齊：底部（默認）/ 頂部 / 垂直居中 */
  chatAvatarAlign?: 'bottom' | 'top' | 'center';
  /** 頭像垂直微調 px（負上正下），0/undefined = 不調 */
  chatAvatarOffsetY?: number;
  /** 氣泡正文字號 px，0/undefined = 默認 */
  chatBubbleFontSize?: number;
  /** 氣泡正文行距（如 1.35），0/undefined = 默認 */
  chatBubbleLineHeight?: number;
  /** 氣泡與頭像側的間距 px，0/undefined = 默認（48px） */
  chatBubbleIndent?: number;
  /** 隱藏頭像的一側是否貼邊（收回頭像空位） */
  chatSnapToEdge?: boolean;
  /** HTML 卡片 / 心象卡片 / 音樂卡片的出現位置：缺省/'center' = 水平居中（默認），'anchor' = 貼氣泡列
   *  （頭像位，不隨貼邊/縮進挪動，即舊版觀感）。經 MessageItem 佈局屬性生效（不走注入 CSS），
   *  同屬聊天細節微調字段、可按角色覆蓋 */
  chatModuleAlign?: 'anchor' | 'center';
  chatBubbleStyle?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios';
  chatMessageSpacing?: 'compact' | 'default' | 'spacious';
  chatShowTimestamp?: 'always' | 'hover' | 'never';
  chatHeaderStyle?: 'default' | 'minimal' | 'gradient' | 'wechat' | 'telegram' | 'discord' | 'pixel';
  chatInputStyle?: 'default' | 'rounded' | 'flat' | 'wechat' | 'ios' | 'telegram' | 'discord' | 'pixel';
  chatChromeStyle?: 'soft' | 'flat' | 'floating' | 'pixel';
  chatDefaultBubbleStyle?: string;
  chatBackground?: string;
  chatBackgroundStyle?: 'plain' | 'grid' | 'paper' | 'mesh';
  chatHeaderAlign?: 'left' | 'center';
  chatHeaderDensity?: 'compact' | 'default' | 'airy';
  chatStatusStyle?: 'subtle' | 'pill' | 'dot';
  chatSendButtonStyle?: 'circle' | 'pill' | 'minimal';
  /** 聊天「白框」自定義 CSS：作用於 .sully-chat-root 下的頂欄、輸入欄與消息佈局鉤子。
   *  可換色 / 貼圖 / 改外形 / 挪位；穩定選擇器清單見 ChromeCssEditor。 */
  chatChromeCustomCss?: string;
  /** 全局默認「白框提示音」：某角色未單獨設提示音時回落到這裡。src 同角色版（內置 key / 音頻直鏈 / data:audio）。 */
  chatSound?: { src: string; volume?: number };
  /** 隱藏頂欄的情緒 buff 欄。 */
  chatHideHeaderBuffs?: boolean;
}

/** 聊天細節微調字段（外觀 App「聊天細節微調」區塊），可整組按角色覆蓋。
 *  與 OSTheme 同名字段一一對應，經 utils/chatFineTuneCss.ts 生成 CSS。 */
export type ChatFineTuneFields = Pick<OSTheme,
  'chatAvatarVisibility' | 'chatAvatarPlacement' | 'chatAvatarAlign' | 'chatAvatarOffsetY' |
  'chatBubbleFontSize' | 'chatBubbleLineHeight' | 'chatBubbleIndent' | 'chatSnapToEdge' |
  'chatModuleAlign'>;

/** 角色級「聊天裝扮」覆蓋：enabled=true 才生效；生效時已定義的字段逐個覆蓋全局，
 *  未定義的字段跟隨全局（合併規則見 utils/chatFineTuneCss.ts 的 mergeChatFineTune）。 */
export interface ChatFineTuneOverride extends ChatFineTuneFields {
  enabled?: boolean;
}

export interface AppearancePreset {
  id: string;
  name: string;
  createdAt: number;
  theme: OSTheme;
  customIcons?: Record<string, string>;
  chatThemes?: ChatTheme[];
  chatLayout?: ChatLayoutPreset;
}

export interface ChatLayoutPreset {
  id: string;
  name: string;
  createdAt: number;
  chatBg?: string;
  chatBgOpacity?: number;
  headerStyle?: 'default' | 'minimal' | 'immersive';
  inputStyle?: 'default' | 'rounded' | 'flat';
  avatarShape?: 'circle' | 'rounded' | 'square';
  avatarSize?: 'small' | 'medium' | 'large';
  messageLayout?: 'default' | 'compact' | 'spacious';
  showTimestamp?: 'always' | 'hover' | 'never';
  bubbleThemeId?: string;
}

export interface TranslationConfig {
  enabled: boolean;
  sourceLang: string; // e.g. '日本語' - the language messages are displayed in (選)
  targetLang: string; // e.g. '中文' - the language to translate into (譯)
}

export interface VirtualTime {
  hours: number;
  minutes: number;
  day: string;
}

export type MinimaxRegion = 'domestic' | 'overseas';

// 語音合成（TTS）服務商。全局三選一：切換後聊天語音條 / 約會 / 電話統一用同一家。
export type TtsProvider = 'minimax' | 'fishaudio' | 'elevenlabs';

export interface VisionApiConfig {
  /** 開啟後，聊天圖片先由獨立視覺模型轉成文字，再交給主對話模型。 */
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 全局生圖 API（系統設置 → 生圖API）；OpenAI 兼容的 /images/generations 接口。 */
export interface ImageGenApiConfig {
  /** 總開關：允許調用生圖 API（角色/用戶手動生圖都受它管）。 */
  charImageGenEnabled?: boolean;
  /**
   * 允許角色在聊天中自主決定發圖。開啟後（且 baseUrl/model 都配好）會在聊天 system prompt 裡
   * 教角色 `[[ACTION:SEND_PHOTO|畫面描述]]`，由 utils/chatParser.ts 執行：調生圖 API、把結果
   * 存成一條 'image' 消息發出去。目前只接入本地/前台聊天（含即時對話 worker 代理轉發）路徑；
   * 主動消息 2.0 的雲端後台生成（worker 自己把副作用結構化成 directives 重放那條路）
   * 還沒教這個動作，見 utils/activeMsgClient.ts 的 fire_pack 模板未傳 imageGenConfig。
   */
  charImageSendEnabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 如 '1024x1024'，留空則不傳給接口，用引擎默認值。 */
  size?: string;
  /** 如 'standard' / 'hd'，隨引擎自定義，留空則不傳。 */
  quality?: string;
  /** 補充提示詞，拼在每次生成請求的正文提示詞後面。 */
  extraPrompt?: string;
}

export interface APIConfig {
  baseUrl: string;
  apiKey: string;
  // 可選識圖中轉：給不支持 image_url 的主模型補視覺能力。
  visionApi?: VisionApiConfig;
  // 生圖：角色/用戶在聊天裡生成圖片用的獨立引擎配置。
  imageGenConfig?: ImageGenApiConfig;
  minimaxApiKey?: string;
  minimaxGroupId?: string;
  // 'domestic' → https://api.minimaxi.com (國內站)
  // 'overseas' → https://api.minimax.io  (海外站)
  // Missing / unknown falls back to domestic.
  minimaxRegion?: MinimaxRegion;
  // 語音服務商三選一。缺省 → 'minimax'。
  ttsProvider?: TtsProvider;
  // 魚聲 Fish Audio API Key（https://fish.audio/）。僅 ttsProvider === 'fishaudio' 時使用。
  fishAudioApiKey?: string;
  // 魚聲默認模型（s2.1-pro / s2-pro / s1）。缺省 → 's2.1-pro'。
  // 角色 voiceProfile.fishModel 優先於這個全局默認。
  fishAudioModel?: string;
  // ElevenLabs BYOK 配置。Voice ID 存在角色 voiceProfile.elevenLabsVoiceId，避免角色串音色。
  elevenLabsApiKey?: string;
  // 缺省使用低延遲 eleven_flash_v2_5；也支持 eleven_v3 / eleven_multilingual_v2。
  elevenLabsModel?: string;
  // ElevenLabs Voice Settings（請求級覆蓋，不修改 ElevenLabs 控制台裡的音色默認值）。
  elevenLabsStability?: number;
  elevenLabsSimilarityBoost?: number;
  elevenLabsStyle?: number;
  elevenLabsUseSpeakerBoost?: boolean;
  // 用戶自定義「語音表演指南」——注入到角色 system prompt、教模型怎麼寫出有情緒的語音台詞。
  // minimax / fishaudio / elevenlabs：聊天 + 電話共用，按 TTS 服務商分別存；
  //   留空 → 用內置默認（minimaxTts.VOICE_ACTING_GUIDE / fishAudioTts.FISH_VOICE_ACTING_GUIDE）。
  // dateVoice：見面（DateApp）專用的 [v:xxx] 語音情緒規則，與服務商無關、單獨一份；
  //   留空 → 用內置默認（datePrompts.DATE_VOICE_GUIDE）。
  // 在「設置 → 其他 API → 語音提示詞」裡二次編輯，存 localStorage（隨 apiConfig）。
  voicePrompts?: {
    minimax?: string;
    fishaudio?: string;
    elevenlabs?: string;
    dateVoice?: string;
  };
  // Replicate token (r8_xxx) for ACE-Step song generation in 寫歌 App.
  aceStepApiKey?: string;
  model: string;
  // Per-API streaming toggle. Some endpoints only support stream:true.
  // Missing → false (默認非流式).
  stream?: boolean;
  // Per-API temperature for chat / 約會 main calls. Missing → 0.85.
  temperature?: number;
}

export type ActiveMsg2Mode = 'fixed' | 'auto' | 'prompted';
export type ActiveMsg2Recurrence = 'none' | 'daily' | 'weekly';

export interface ActiveMsg2ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ActiveMsg2GlobalConfig {
  userId: string;
  /** 單用戶 Cloudflare Worker 地址，例如 https://amsg.your-worker.dev */
  workerUrl: string;
  /** 與 worker 約定的共享密鑰；配了就每次請求帶 X-Client-Token，缺/錯 worker 返回 401 */
  serverToken?: string;
  /**
   * 一鍵部署時生成的 AMSG_MASTER_KEY（worker 側用它加密任務內容）。
   * 存在這裡只為「重裝時沿用同一把」——它一換，之前加密進 D1 的任務就全解不開了，
   * 而 worker 裡的值讀不回來。手動部署的用戶這裡是空的，屬正常。
   */
  masterKey?: string;
  /** 上次「連接」（在 worker 端建表）成功的時間 */
  initializedAt?: number;
  /**
   * 即時對話：聊天的每一輪都交給雲端跑（POST /instant-chat），回覆走推送回來。
   * 只在設置頁那一處開關（開關本身還有連接 / 通知權限 / worker 能力三道門），
   * 關掉就是現在的本地直連生成。
   */
  instantChatEnabled?: boolean;
  /**
   * 上一次**明確探到**的「那台 Worker 真的跑得動即時對話嗎」
   * （見 ActiveMsgClient.probeInstantChatSupportDetailed）。
   *
   * 只有問到了答案才會寫這裡：200 + instantTick 寫 true，200 但沒有 instantTick 寫 false。
   * 網絡異常、超時、401、5xx 一律不寫——那些說明的是線路或配置有問題，不是這台 Worker
   * 的能力，拿它們判死刑的話一次抖動就能把即時對話長期釘死在本地生成。
   *
   * false 時即時對話讓位給本地生成，**用戶開著也不走** —— 跑不動的 Worker 上這條路是
   * 發一條掛一條，讓位比讓他對著「已開啟」乾等強。發消息路上會帶冷卻地現探一次，
   * 用戶更新完 Worker 後自己就翻回來了，不用手動去重開開關。
   *
   * undefined = 還沒探過（剛裝、沒進過設置頁），按放行處理：這一檔說明我們不知道，
   * 而不是知道它不行；握手時會補探一次，之後就有準數了。
   */
  instantChatSupported?: boolean;
  /**
   * 上一次探到的「這台 Worker 能不能把 LLM 憑據存成表裡的一行」
   * （GET /capabilities 的 features 含 'llm-credentials'，見 ActiveMsgClient.probeLlmCredentialsSupport）。
   *
   * 達標時排程 / 即時對話只在任務裡帶一個引用名，換 Key 只要覆蓋那一行，已排的任務
   * （含角色自己排的）下次觸發自動跟上；不達標就把憑據照舊凍結進任務體。
   *
   * undefined / false 都按「不達標」處理：老路在哪台 Worker 上都跑得通，寧可多凍結
   * 一份憑據，也不要拿新寫法去撞一台還不認識它的 Worker。握手時會探一次。
   */
  llmCredentialsSupported?: boolean;
  /**
   * 上一次探到的「這台 Worker 認不認 PUT /client-state 裡 value: null 的刪行語義」
   * （GET /capabilities 的 features 含 'client-state-delete'，見 ActiveMsgClient.probeWorkerFeatures）。
   *
   * 達標時取回旁路存的大內容後把那一行真的刪掉；不達標照舊寫空串、留一個空殼。
   * undefined / false 都按「不達標」處理：老 Worker 收到 null 會逐條拒掉。握手時會探一次。
   */
  clientStateDeleteSupported?: boolean;
  /**
   * 旁路存儲的存量空殼已經掃過一遍的角色 id（見 activeMsgClient 的存量空殼清理）。
   * 每個角色只掃一次：掃完記進來，之後的同步不再為它多讀一次雲端。
   */
  sidechannelShellsSweptCharIds?: string[];
  updatedAt?: number;
}

export type ActiveMsg2ExpirePolicy = 'expire' | 'force';
export type ActiveMsg2TaskSource = 'user' | 'character';
/** scheduled=待觸發/循環中；cancelled 僅短暫存在（取消即從清單移除）。到點後的
 *  一次性任務不改 status——「已發送/已作廢」由消息歷史現場推導，避免 React 外寫角色數據。 */
export type ActiveMsg2TaskStatus = 'scheduled' | 'cancelled';

export interface ActiveMsg2TaskRecord {
  taskUuid: string;
  /** 客戶端排程前自造的 uuid v4，與 push metadata 的 amsgClientTaskId 同源——送達歸屬匹配鍵。 */
  clientTaskId: string;
  mode: ActiveMsg2Mode;
  /** ISO / datetime-local 字符串，首次觸發時間。 */
  firstSendTime: string;
  /**
   * 遠端算出來的下一次觸發時刻（對帳時同步回來）。循環任務按角色所在時區的牆鍾推進，
   * 本地拿固定週期自己乘出來的那個一跨夏令時就會偏一小時——顯示以這份為準。
   */
  nextSendAt?: string;
  recurrenceType: ActiveMsg2Recurrence;
  /** fixed 模式的固定內容。 */
  userMessage?: string;
  promptHint?: string;
  /** 防穿幫策略；fixed 任務恆為 'force'（見 amsg2Tasks.resolveExpirePolicy）。 */
  expirePolicy: ActiveMsg2ExpirePolicy;
  source: ActiveMsg2TaskSource;
  status: ActiveMsg2TaskStatus;
  createdAt: number;
  lastError?: string;
}

export interface ActiveMsg2CharacterConfig {
  enabled: boolean;
  /**
   * 即時對話按角色單獨關。undefined = 跟隨全局（全局即時對話開著就默認開）；
   * false = 這個角色的聊天回到本地前台生成。與 enabled（排程開關）互相獨立：
   * 可以只排程不即時，也可以只即時不排程。
   */
  instantChatEnabled?: boolean;
  /** 多任務清單（用戶在面板建的和角色用工具建的並存），見 utils/amsg2Tasks.ts。 */
  tasks?: ActiveMsg2TaskRecord[];
  /** ↓ 角色級共享設置（所有任務共用）。 */
  maxTokens?: number;
  /**
   * 「我沒回的時候，TA 最多連續主動發幾條」。0 = 不限；沒設 = 默認值
   * （amsgFirePack.DEFAULT_MAX_UNANSWERED_SENDS）。管的是角色自己排的後續
   * （含 fire 裡的自排鏈），用戶在面板裡親手排的任務不受它管；用戶一回復就重新計數。
   */
  maxUnansweredSends?: number;
  useSecondaryApi?: boolean;
  secondaryApi?: ActiveMsg2ApiConfig;
  lastSyncedAt?: number;
  lastError?: string;
}

/** 任務「沒了」的回執台帳（amsg-local IDB kv，按角色一條數組）。 */
export interface Amsg2ExpiredNoticeRecord {
  /**
   * 防穿幫閘作廢：一次性任務 = taskUuid，循環任務 = `${taskUuid}:${occurrenceMs}`；
   * 用戶手動取消 = `${taskUuid}:cancelled`（同一條任務可能兩件事都發生過，各佔一條）。
   */
  id: string;
  charId: string;
  occurrenceMs: number;
  mode: ActiveMsg2Mode;
  promptHint?: string;
  recurrenceType: ActiveMsg2Recurrence;
  /**
   * 這條回執是怎麼來的：閘自動作廢（缺省）還是用戶在面板裡手動取消。
   * 兩者給角色的交代不一樣——作廢可以續期補上，手動取消是用戶不要了。
   */
  kind?: 'expired' | 'user-cancelled';
  /** 已注入過排程現狀塊（角色已知情），不再重複注入。 */
  notifiedAt?: number;
  createdAt: number;
}

export interface ActiveMsg2InboxMessage {
  messageId: string;
  charId: string;
  charName: string;
  body: string;
  previewBody?: string;
  avatarUrl?: string;
  source?: string;
  messageType?: string;
  messageSubtype?: string;
  taskId?: string | null;
  /**
   * 任務身份，由庫蓋在 push 頂層帶下來（不是排程方寫進 metadata 的）。
   * 兩條排程路徑——用戶在面板排的、角色在 fire 裡給自己排的——走的是同一份，
   * 所以防穿幫閘和任務認領都讀這裡，不讀 metadata 裡各自抄的那份。
   */
  taskUuid?: string | null;
  recurrenceType?: string | null;
  /** 本次觸發的名義時刻（epoch 毫秒）。 */
  occurrenceMs?: number | null;
  metadata?: Record<string, any>;
  sentAt?: number;
  receivedAt: number;
  /**
   * 已經嘗試處理過幾次（見 activeMsgRuntime 的 MAX_INBOX_PROCESS_ATTEMPTS）。
   * 處理失敗時消息會寫回收件箱等重試，這個計數決定什麼時候放棄重試、退回存原稿保底。
   */
  processAttempts?: number;
}

export interface ApiPreset {
  id: string;
  name: string;
  config: APIConfig;
}

export interface CharacterBuff {
  id: string;
  name: string;      // internal key, e.g. 'reconciliation_fragile'
  label: string;     // display text, e.g. '脆弱的和好'
  intensity: 1 | 2 | 3;
  emoji?: string;
  color?: string;    // hex, e.g. '#f87171'
  description?: string;  // 用戶可讀的簡短說明（給用戶看的，不是給AI的）
}

// 實時上下文配置 - 讓AI角色感知真實世界
export interface RealtimeConfig {
  // 天氣配置
  weatherEnabled: boolean;
  weatherApiKey: string;  // OpenWeatherMap API Key（可選；留空走免 key 的 Open-Meteo）
  weatherCity: string;    // 城市名（如 "北京"、"Beijing"）

  // 新聞配置
  newsEnabled: boolean;
  newsApiKey?: string;
  newsPlatforms?: string[];  // hot_news 熱榜平台 key 列表（默認主源，免鑑權），留空用內置默認

  // Notion 配置
  notionEnabled: boolean;
  notionApiKey: string;   // Notion Integration Token
  notionDatabaseId: string; // 日記數據庫ID
  notionNotesDatabaseId?: string; // 用戶筆記數據庫ID（可選，讓角色讀取用戶的日常筆記）

  // 飛書配置 (中國區 Notion 替代)
  feishuEnabled: boolean;
  feishuAppId: string;      // 飛書應用 App ID
  feishuAppSecret: string;  // 飛書應用 App Secret
  feishuBaseId: string;     // 多維表格 App Token
  feishuTableId: string;    // 數據表 Table ID

  // 小紅書配置 (MCP / Skills 雙模式瀏覽器自動化)
  xhsEnabled: boolean;
  xhsMcpConfig?: XhsMcpConfig;

  // 緩存配置
  cacheMinutes: number;
}

// 熱點單條（與 realtimeContext 的 NewsItem 結構一致，單獨放在 types 裡避免循環依賴）
export interface HotNewsItem {
  title: string;
  source?: string;  // 平台展示名，如「微博」
  url?: string;
  desc?: string;    // 熱點簡介（API 的 desc 字段，可能為空）
}

// 分時段熱點快照：每天每時段（0-8/8-16/16-24）最多拉一次，全角色共享
export interface HotNewsSnapshot {
  id: string;          // `${date}#${slot}`，如 2026-05-20#1
  date: string;        // YYYY-MM-DD
  slot: number;        // 0=早間 1=午間 2=晚間
  slotLabel: string;   // 早間 / 午間 / 晚間
  items: HotNewsItem[];
  platforms: string[]; // 本次召回用的平台 key 列表
  fetchedAt: number;   // 拉取時間戳
}

export interface MemoryPalaceBackupConfig {
  relativeTimeAnnotations?: boolean;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
  lightLLM: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  rerank: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    topN: number;
  };
  /**
   * 實驗管線總開關。舊備份沒有這一塊時按全部關閉處理，確保升級後行為不突變。
   */
  featureFlags?: MemoryPalaceFeatureFlags;
}

export interface MemoryPalaceFeatureFlags {
  recallRouter: boolean;
  interactionAdaptation: boolean;
  deepEngagement: boolean;
  /** 預留的薄事實約束層，不屬於 M3 Deep Engagement。 */
  epistemicState: boolean;
}

/**
 * 角色在 ChatApp 裡願意向用戶當前交流步伐靠近多少。每維 0..1；這是角色屬性，
 * 不是用戶狀態。缺省時使用保守默認值，且不會從角色實際回覆中自動學習。
 */
export interface CharacterAccommodationPolicy {
  length?: number;
  rhythm?: number;
  energy?: number;
  punctuation?: number;
  emoji?: number;
}

export interface MemoryFragment {
  id: string;
  date: string;
  summary: string;
  mood?: string;
  /** Only new automatic archives carry a palace link; summary remains an offline/legacy fallback. */
  palaceMemoryId?: string;
}

export interface SpriteConfig {
  scale: number;
  x: number;
  y: number;
}

export interface SkinSet {
  id: string;
  name: string;
  sprites: Record<string, string>; // emotion -> image URL or base64
}

export interface CompanionAvatarConfig {
  version: 1;
  /** Shared desktop/video visual source: model uses VRM/Live2D; upload/date use a flat portrait. */
  source: 'model' | 'upload' | 'date';
  /** Original PNG / GIF stored in blob_assets. Kept while switching sources. */
  imageRef?: string;
  fileName?: string;
  mimeType?: string;
  importedAt?: number;
  /** Uploaded portraits kept in the wardrobe. The top-level image fields point at the active item. */
  imageWardrobe?: Array<{
    id: string;
    imageRef: string;
    fileName?: string;
    mimeType?: string;
    importedAt?: number;
  }>;
  /** Independent from Date mode's active outfit; desktop and video calls share this selected outfit. */
  skinSetId?: string;
}

// 見面模式文風配置。由「場景佈置」面板調整，datePrompts 構建 VN 提示詞時讀取，
// 改動即時生效於後續生成（system prompt 每次請求重建）。
export interface DateStyleConfig {
  /** 寫作風格預設 id，見 datePrompts.DATE_STYLE_PRESETS；缺省 = cinematic（電影感） */
  style?: string;
  /** 敘事人稱：third-name=「B看著A」 third-you=「B看著你」 first-you=「我看著你」；缺省 = 不注入人稱指令 */
  pov?: 'third-name' | 'third-you' | 'first-you';
  /** 細節深挖引導：教模型從任意輸入裡挖素材 + 每輪輪換聚焦線索，對沖"沒話找話"式的模型八股；缺省 = 開啟 */
  digDeeper?: boolean;
  /** 自定義補充文風要求，原樣追加進風格塊 */
  extra?: string;
}

export interface RoomItem {
    id: string;
    name: string;
    /** rug=地毯：永遠鋪在最底層，角色與其它傢俱都壓在它上面 */
    type: 'furniture' | 'decor' | 'rug';
    image: string;
    x: number;
    y: number;
    scale: number;
    rotation: number;
    isInteractive: boolean;
    descriptionPrompt?: string;
}

export interface RoomTodo {
    id: string;
    charId: string;
    date: string;
    items: { text: string; done: boolean }[];
    generatedAt: number;
}

export interface RoomNote {
    id: string;
    charId: string;
    timestamp: number;
    content: string;
    type: 'lyric' | 'doodle' | 'thought' | 'search' | 'gossip';
    relatedMessageId?: number; 
}

/** 小劇場的一拍（one beat）：一行敘述 / 動作 / 台詞，emotion 是該行氛圍標記（emoji 或短詞）。 */
export interface TheaterLine {
    emotion?: string;   // 該行的氛圍標記，渲染成小標籤（一個 emoji 或 2-4 字短詞）
    text: string;       // 這一拍的敘述 / 動作 / 台詞
}

/**
 * 小劇場（窺視演出）。掛在某個 ScheduleSlot 上：用戶點該時段的播放按鈕，
 * 第三人稱「上帝視角」生成角色在這個時間點的一小段行為演出，逐行播放。
 * 生成一次即緩存進 slot，可反覆重看，不重複燒 token。
 */
export interface SlotTheater {
    lines: TheaterLine[];
    mood?: string;        // 整段演出的氛圍一句話（可選，展示用）
    generatedAt: number;
}

export interface ScheduleSlot {
    startTime: string;    // "08:00"
    activity: string;     // "晨跑"
    description?: string; // "在河邊慢跑"
    emoji?: string;       // "🏃"
    location?: string;    // "河邊"
    innerThought?: string; // 該時段的內心獨白，生成時由AI寫好，運行時直接注入
    theater?: SlotTheater; // 該時段的小劇場（窺視演出），按需生成並緩存
}

/** 用戶自己設的不回訊時段：這些時段角色強制已讀不回。end 早於 start 表示跨夜。 */
export interface QuietHoursSlot {
    id: string;
    /** 星期幾生效（0 = 週日 … 6 = 週六），跨夜時段以開始那天為準。 */
    days: number[];
    start: string; // "09:00"
    end: string;   // "12:00"
    title?: string;
}

/** 聊天設定 · Scenario ·「延遲自動回覆」：發完訊息不用按回覆，角色在這個範圍內自己回。 */
export interface DelayedReplySettings {
    enabled: boolean;
    /** 回覆時間範圍（分鐘）；實際多快看日程忙不忙、剛剛是不是正聊得起勁。 */
    minMinutes: number;
    maxMinutes: number;
}

/** 聊天設定 · Scenario ·「已讀不回」。 */
export interface ReadNoReplySettings {
    enabled: boolean;
    /** 由角色決定：日程忙碌／睡覺時不強制，讓角色依劇情決定回不回；用戶自己設的不回訊時段仍強制。 */
    charDecides?: boolean;
    /** 忙碌／休眠／普通三種狀態的自動回覆文字；留空退回普通，普通也空就用內建預設。 */
    busyText?: string;
    sleepText?: string;
    normalText?: string;
    quietSlots?: QuietHoursSlot[];
    /** 讓角色依劇情、地點、情境自己寫自動回覆，不用上面的固定文字。 */
    aiGenerated?: boolean;
}

export interface DailySchedule {
    id: string;           // `${charId}_${date}`
    charId: string;
    date: string;         // YYYY-MM-DD
    slots: ScheduleSlot[];
    generatedAt: number;
    coverImage?: string;  // 用戶自定義角色看板圖 (持久化)
    /**
     * 按時段生成的意識流獨白。
     * key = slot 的 startTime（如 "08:00"），value = 截止該時段的完整內心獨白。
     * 注入時根據當前時間找到最近的 key，直接使用整段文本，不做拼接。
     */
    flowNarrative?: Record<string, string>;
}

export interface RoomGeneratedState {
    actorStatus: string;
    welcomeMessage: string;
    items: Record<string, { description: string; reaction: string }>;
    actorAction?: string; // e.g. 'idle', 'sleep'
}

export interface UserImpression {
    version: number;
    lastUpdated?: number;
    value_map: {
        likes: string[];
        dislikes: string[];
        core_values: string;
    };
    behavior_profile: {
        tone_style: string;
        emotion_summary: string;
        response_patterns: string;
    };
    emotion_schema: {
        triggers: {
            positive: string[];
            negative: string[];
        };
        comfort_zone: string;
        stress_signals: string[];
    };
    personality_core: {
        observed_traits: string[];
        interaction_style: string;
        summary: string;
    };
    mbti_analysis?: {
        type: string; 
        reasoning: string;
        dimensions: {
            e_i: number; 
            s_n: number; 
            t_f: number; 
            j_p: number; 
        }
    };
    observed_changes?: string[];
}

export interface BubbleStyle {
    textColor: string;
    backgroundColor: string;
    backgroundImage?: string;
    backgroundImageOpacity?: number;
    borderRadius: number;
    /** 四角獨立圓角；未設置的角繼續跟隨 borderRadius，兼容舊主題。 */
    borderTopLeftRadius?: number;
    borderTopRightRadius?: number;
    borderBottomRightRadius?: number;
    borderBottomLeftRadius?: number;
    /** 自定義 CSS 偽元素尾巴的出現頻率。舊主題缺省為 every，新建主題默認 last。 */
    tailMode?: 'every' | 'last' | 'none';
    opacity: number;
    
    decoration?: string;
    decorationX?: number;
    decorationY?: number;
    decorationScale?: number;
    decorationRotate?: number;

    avatarDecoration?: string;
    avatarDecorationX?: number;
    avatarDecorationY?: number;
    avatarDecorationScale?: number;
    avatarDecorationRotate?: number;

    voiceBarBg?: string;
    voiceBarActiveBg?: string;
    voiceBarBtnColor?: string;
    voiceBarWaveColor?: string;
    voiceBarTextColor?: string;
}

export interface ChatTheme {
    id: string;
    name: string;
    type: 'preset' | 'custom';
    user: BubbleStyle;
    ai: BubbleStyle;
    customCss?: string;
}

export interface PhoneCustomApp {
    id: string;
    name: string;
    icon: string;
    color: string;
    prompt: string;
    layout?: 'generic' | 'shop' | 'feed' | 'forum' | 'novel'; // 參考樣板 UI 風格，默認 generic
    /** HTML 卡片模式：關閉=原版純文字（現狀）；開啟後按 htmlCardPrompt 額外生成/渲染卡片，純文字仍是發進聊天上下文的那份 */
    htmlCardEnabled?: boolean;
    /**
     * HTML 卡片指令。可以是自然語言描述（LLM 按描述生成每條記錄的 HTML），
     * 也可以是帶 {{title}}/{{detail}}/{{value}} 或自定義佔位符的固定 HTML 模板
     * （客戶端本地做字符串替換，不經過 LLM，更穩定）。留空時即使開關開著也不生成卡片。
     */
    htmlCardPrompt?: string;
    /** CSS 樣式開關：配合 htmlCardCss 使用 */
    htmlCardCssEnabled?: boolean;
    /**
     * 卡片 CSS。只在渲染卡片的沙盒 iframe 內生效（HtmlCard 組件），
     * 不會影響 App 外部任何界面；建議用 .phone-card 等類名，配合 htmlCardPrompt 裡 class 一致。
     */
    htmlCardCss?: string;
}

export interface PhoneEvidence {
    id: string;
    type: 'chat' | 'order' | 'social' | 'delivery' | string;
    title: string;
    detail: string;
    timestamp: number;
    systemMessageId?: number;
    value?: string;
    /** 人際關係系統：本條記錄歸屬的聯繫人（phoneState.contacts 裡的 id） */
    contactId?: string;
    /**
     * 自定義 App 生成的 HTML 卡片（僅 App 界面內渲染用）。同步到私聊時永遠只用
     * title/detail/value 純文字（見 utils/phoneEvidence.ts buildPhoneEvidenceChatCard），
     * 這個字段不會進聊天上下文，避免把 HTML/CSS 代碼塞給角色讀。
     */
    html?: string;
}

/**
 * 人際關係系統 · 聯繫人。
 * 角色（機主）通訊錄裡的一個人，可能是神經鏈接裡真實存在的角色（real），
 * 也可能是純按人設虛構的路人（npc）。
 */
/** 聊天話題盒的一條總結記憶（某一側第一人稱、帶主觀色彩，由一段原文濃縮而來；可編輯/刪除） */
export interface ConvTopic {
    id: string;
    text: string;
    createdAt: number;
    /** 這條記憶濃縮了多少條原文（信息用） */
    span?: number;
}

export interface PhoneContact {
    id: string;
    name: string;
    /** 身份/關係標籤，如「輔導員」「中間人」 */
    identity?: string;
    /** identity 是否由用戶手動確認；確認後自動掃描不得覆蓋（即使用戶選擇留空） */
    identityManual?: boolean;
    /** 機主對此人的備註（用戶/機主手寫的「已確立事實」，對話裡當真遵守，不被自動覆蓋） */
    note?: string;
    /**
     * 機主通過相處「逐漸瞭解到」的關於此人的認識——由對話裡 [[瞭解:…]] 累積而來。
     * 注意：這是機主的「印象/判斷」，來源是對方在聊天裡自己說的，**未必屬實**（對方可能在編）。
     * 與 note（事實）分開存、分開注入。
     */
    learned?: string;
    /**
     * 聊天話題盒：這一側（第一人稱、帶主觀色彩）對這段對話的**總結記憶**。
     * 每聊滿 100 條觸發一次總結、追加一條；用作聊天上下文（原文從上下文裡隱藏，但仍存 record.detail 供用戶查看）。
     * 可長按刪除/修改。
     */
    topicBox?: ConvTopic[];
    /** 已被總結歸檔的原文條數（水位線）：record.detail 裡這之前的內容不再進上下文，只進話題盒 */
    archivedThru?: number;
    avatar?: string;
    /** 真假甄別結果：real=神經鏈接裡真有這人；npc=純虛構 */
    kind: 'real' | 'npc';
    /** kind==='real' 時綁定的真實角色 id（指向 characters 裡的某個角色） */
    linkedCharId?: string;
    /** kind==='npc' 且綁定了神經鏈接「NPC」分頁裡的某個 NPC 時，指向 NPCProfile.id；手動填名字的純虛構聯繫人不設。 */
    linkedNpcId?: string;
    /** 機主對此人的好感度，-100..100（負=厭惡，可觸發自動刪友；正=親近） */
    affinity: number;
    /** 關係狀態 */
    status: 'friend' | 'pending' | 'blocked' | 'deleted';
    lastInteraction?: number;
    createdAt: number;
}

/**
 * 「軌跡」Profile 子頁 · 檔案資料：按角色人設自由生成的個人文件（授權書/合同/產權書等），
 * 純展示用的角色深度設定，不參與聊天上下文。
 */
export interface TrajectoryArchiveDoc {
    id: string;
    title: string;
    /** 文件類型標籤，展示在標題下方，如 "PERSONAL DOCUMENT"，自由生成 */
    category: string;
    content: string;
    createdAt: number;
    /** 「同步到私聊」寫入的 DB 消息 id；有值＝已同步，按鈕據此置灰防重複發送。 */
    syncedMessageId?: number;
}

/** 「軌跡」Profile 子頁 · 階段目標：某項任務/作品/計劃的進度，0-100。 */
export interface TrajectoryObjective {
    id: string;
    title: string;
    progress: number;
    detail: string;
    createdAt: number;
    /** 「同步到私聊」寫入的 DB 消息 id；有值＝已同步，按鈕據此置灰防重複發送。 */
    syncedMessageId?: number;
}

/** 「軌跡」Profile 子頁 · 待辦日程：checklist，時間是展示用的自由文本，不強求可解析。 */
export interface TrajectoryChecklistItem {
    id: string;
    title: string;
    dueLabel: string;
    done: boolean;
    createdAt: number;
    /** 「同步到私聊」寫入的 DB 消息 id；有值＝已同步，按鈕據此置灰防重複發送。 */
    syncedMessageId?: number;
}

/** 「軌跡」Profile 子頁三段合一，AI 一次性生成/刷新，各角色獨立存一份。 */
export interface CharacterTrajectoryProfile {
    archives: TrajectoryArchiveDoc[];
    objectives: TrajectoryObjective[];
    checklist: TrajectoryChecklistItem[];
    updatedAt: number;
}

/**
 * 「軌跡」OOTD 分頁：一條穿搭記錄，圖片走跟聊天圖片同一套 blob-ref 令牌（migrateDataUrlToRef
 * 之後的結果），不存原始 base64。每次點「生成」在這天的時間線上追加新節點，模擬角色
 * 換了一身新裝扮。
 */
export interface TrajectoryOotdPost {
    id: string;
    timestamp: number;
    image: string;
    /** 生圖用的英文畫面描述，重新生成照片時複用，保證新照片仍貼合這身穿搭的文字描述。 */
    imagePrompt: string;
    style: string;
    colors: string[];
    tops: string;
    bottoms: string;
    shoes: string;
    accessories: string[];
    /** 「同步到私聊」寫入的 DB 消息 id；有值＝已同步，按鈕據此置灰防重複發送。 */
    syncedMessageId?: number;
}

export interface TrajectoryMomentComment {
    id: string;
    authorName: string;
    content: string;
}

/**
 * 「軌跡」Moments 分頁的一條角色專屬動態——AI 生成文案 + 一張生圖 + 點綴用的點贊數/評論
 * （純展示，不可互動；互動式點贊評論是另一個量級的功能，先不做）。
 */
export interface TrajectoryMomentPost {
    id: string;
    timestamp: number;
    content: string;
    image: string;
    /** 生圖用的英文畫面描述，重新生成照片時複用，保證新照片仍貼合文案描述的場景。 */
    imagePrompt: string;
    likes: number;
    comments: TrajectoryMomentComment[];
    /** 「同步到私聊」寫入的 DB 消息 id；有值＝已同步，按鈕據此置灰防重複發送。 */
    syncedMessageId?: number;
}

/**
 * 「軌跡」Journey 分頁的一段私人行程——角色與另一角色/NPC 見面的無互動敘事，用戶不參與。
 * participantNames 是生成時的快照（不存 id），角色/NPC 後續改名或刪除都不影響這條歷史記錄的展示。
 */
export interface TrajectoryJourneyEntry {
    id: string;
    kind: '日常' | '事件';
    time: string;
    location: string;
    participantNames: string[];
    /**
     * participantNames 裡屬於真實角色（不是 NPC）的那些，對應的角色 id——「同步到私聊」時
     * 也各發一份給這些角色自己的私聊，避免角色A有這段記憶、角色B/C卻沒有，導致後續對話
     * （尤其是群聊）裡「我們昨天不是約好了」對上「我們哪有約」這種打架。NPC 沒有自己的手機/
     * 私聊，不收在這份裡。
     */
    participantCharIds?: string[];
    detail?: string;
    story: string;
    /** 「同步到私聊」寫入的 DB 消息 id（角色自己那份）；有值＝已同步，按鈕據此置灰防重複發送。 */
    syncedMessageId?: number;
    createdAt: number;
}

/**
 * 智能體 App · AI 服務種類。機主（被查手機的角色）自己也在玩 AI：
 * - assistant：工具型 AI 助手（豆包/通義/ChatGPT 那種），問實用 & 尷尬問題。
 * - claude：樹洞型深度對話 AI（Claude 那種），說當面不會說的真心話。
 * - tavern：酒館 / SillyTavern 式 AI 角色扮演，自己捏卡跟 AI 對戲。
 */
export type AiServiceKind = 'assistant' | 'claude' | 'tavern';

/** 智能體 App · 一段機主與 AI 的會話（被偷看到的記錄） */
export interface AiSession {
    id: string;
    service: AiServiceKind;
    /** 服務/對象名：助手名(豆包) / 樹洞名(Claude) / 酒館卡片名 */
    serviceName: string;
    /** 會話標題（在聊什麼） */
    title: string;
    /**
     * 對話腳本，「我:/對方:」逐行（走 parseTranscript 無損解析）。
     * assistant/claude：我=機主，對方=AI。
     * tavern：我=機主(玩家)，對方=AI 扮演的卡片角色。
     */
    transcript: string;
    /** tavern：關聯的角色卡 id */
    cardId?: string;
    /** 長會話自動總結出的「前情提要」（參考 TRPG：超 100 條觸發，把舊劇情壓成小說梗概） */
    summaries?: { id: string; content: string; createdAt: number }[];
    /** 被摺疊歸檔的舊原文（不刪除，UI 可展開回看；總結後從 transcript 移到這裡） */
    archived?: string;
    updatedAt: number;
}

/** 智能體 App · 機主在酒館裡建的角色卡 */
export interface TavernCard {
    id: string;
    name: string;
    /** 卡類型：character=單個角色卡；world=大型世界卡（跑團/修仙/西幻等） */
    kind?: 'character' | 'world';
    /** 角色人設 / 世界設定 */
    persona: string;
    /** 劇情背景 / 初始場景（酒館的 scenario） */
    scenario?: string;
    emoji: string;
    /** 是否照著用戶（查手機的人）捏的——最偷窺感的一項 */
    basedOnUser?: boolean;
    /** 這張卡照著誰捏的（現實裡 TA 在意的某個人的名字）：可能是用戶，也可能是 TA 人設/羈絆裡更深的某個人 */
    basedOn?: string;
    createdAt: number;
}

// 「人格模擬」演出運行時腳本模型（生成後驅動播放，也用於生活記錄重播）
export type SimBeatKind = 'lock' | 'thought' | 'notification' | 'app' | 'flashback' | 'end';
export interface SimBeat {
    time?: string;
    kind: SimBeatKind;
    monologue?: string;
    pace?: 1 | 2 | 3;
    vibe?: 'calm' | 'chaotic' | 'happy' | 'anxious' | 'numb' | 'tender';
    notif?: { app: string; title: string; body: string; tone?: 'push' | 'sms' | 'system' | 'flashback' };
    app?: {
        name: string;
        view: 'chat' | 'search' | 'photo' | 'music' | 'notes' | 'browser' | 'weather' | 'compose' | 'generic';
        chat?: { name: string; lines: { me: boolean; text: string }[] };
        search?: { engine?: string; queries: { q: string; deleted?: boolean }[] };
        photo?: { caption?: string; date?: string; tint?: string };
        music?: { song: string; artist: string; state?: string };
        notes?: { title?: string; items: string[] };
        browser?: { tabs: string[] };
        weather?: { city: string; temp: number; desc: string };
        compose?: { to?: string; drafts: string[]; sent?: string | null };
        text?: string;
    };
    flashback?: { label?: string; caption?: string; date?: string; tint?: string };
}
export interface SimScript {
    title: string;
    ending?: string;
    beats: SimBeat[];
    summary: string;
    buff?: { name?: string; label: string; emoji?: string; color?: string; intensity?: 1 | 2 | 3; description?: string };
}

// 「人格模擬」演出結束後寫入「生活記錄」的一條留存（角色不記得，僅作為用戶的體驗檔案）
export interface PhoneSimLog {
    id: string;
    mode: 'daily' | 'event';
    theme: string;        // 體驗內容（如「平凡的週二」）
    title: string;        // 演出標題
    summary: string;      // 收尾留白文字
    ending?: string;      // 多結局版本標籤
    beatsCount: number;
    buff?: { label: string; emoji?: string; color?: string };
    memoryText?: string;  // 演出可讀梗概，作為回憶發給角色時用（讓角色真的"知道"發生了什麼）
    timestamp: number;
    script?: SimScript;   // 完整腳本快照——存在則「生活記錄」可原樣重播（舊記錄沒有，僅可發送）
}

// ============================================================
//  夢境演出系統 (Dream Theater) — 偷看一場角色已經忘記的夢。
//  與「人格模擬」演出不同：夢不寫實、不連貫、允許中度幻覺與矛盾，
//  以拼貼詩 / 電影字幕 / 碎片記憶的方式呈現，留白與沉默本身就是演出。
// ============================================================
export type DreamArchetype =
    | 'sweet'      // 甜夢
    | 'nightmare'  // 噩夢
    | 'flower'     // 花之夢
    | 'flying'     // 飛翔之夢
    | 'falling'    // 墜落之夢
    | 'starry'     // 星空之夢
    | 'ocean'      // 海之夢
    | 'childhood'  // 童年之夢
    | 'anxiety'    // 焦慮之夢
    | 'forgotten'  // 遺忘之夢
    | 'prophetic'  // 預言之夢
    | 'lucid'      // 清醒夢
    | 'deepsleep'; // 隱藏 · 深眠（無夢，沉默即是獎勵）

// 一個夢境碎片 —— 不同 kind 決定它在屏幕上的排版與呈現方式
export type DreamFragmentKind =
    | 'line'       // 一句飄過的字幕
    | 'word'       // 單字 / 單詞，巨大、孤立
    | 'silence'    // 留白 · 沉默（空行，長停頓）
    | 'repeat'     // 同一個詞反覆
    | 'dialogue'   // 極短的對話碎片
    | 'stage'      // 舞台提示（[門在微笑]）
    | 'list'       // 清單
    | 'screenplay' // 劇本片段
    | 'diary'      // 日記殘頁
    | 'message'    // 發給無人的消息
    | 'image';     // 象徵性畫面 + 配文

export interface DreamFragment {
    kind: DreamFragmentKind;
    text?: string;          // line / word / stage / diary / message / repeat 的詞
    lines?: string[];       // dialogue / list / screenplay 的多行
    count?: number;         // repeat 的重複次數
    caption?: string;       // image 的配文
    date?: string;          // diary / image 的模糊日期口徑
    tint?: string;          // image 的色調 hex
    emphasis?: 'whisper' | 'normal' | 'loud' | 'fade'; // 視覺強弱
    align?: 'left' | 'center' | 'right';
    pace?: 1 | 2 | 3;       // 停留時長：1 普通 / 2 稍慢 / 3 漫長
}

export interface DreamScript {
    archetype: DreamArchetype;
    title?: string;         // 夢的標題（可以晦澀、詩意）
    fragments: DreamFragment[];
    afterglow?: string;     // 醒來時殘留的感覺（留白，不解釋）
    buff?: { name?: string; label: string; emoji?: string; color?: string; intensity?: 1 | 2 | 3; description?: string };
}

// 一場夢的留存（角色不記得，僅作為用戶偷看到的檔案 · 「夢的殘頁」）
export interface DreamLog {
    id: string;
    archetype: DreamArchetype;
    title?: string;
    afterglow?: string;
    fragmentsCount: number;
    buff?: { label: string; emoji?: string; color?: string };
    timestamp: number;
    script?: DreamScript;   // 完整快照 → 可原樣重看
}

export type WorldbookPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WorldbookDepthRole = 0 | 1 | 2;
export type WorldbookSelectiveLogic = 0 | 1 | 2 | 3;

export interface WorldbookEntryConfig {
    /** Primary activation keywords. Empty for constant entries. */
    key?: string[];
    /** Optional secondary activation keywords. */
    keysecondary?: string[];
    /** Always active when true; legacy SullyOS entries default to true. */
    constant?: boolean;
    selective?: boolean;
    selectiveLogic?: WorldbookSelectiveLogic;
    order?: number;
    position?: WorldbookPosition;
    disable?: boolean;
    probability?: number;
    useProbability?: boolean;
    depth?: number;
    role?: WorldbookDepthRole | null;
    scanDepth?: number | null;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | null;
    sourceUid?: number;
}

export interface MountedWorldbook extends WorldbookEntryConfig {
    id: string;
    title: string;
    content: string;
    category?: string;
}

export interface Worldbook extends WorldbookEntryConfig {
    id: string;
    title: string;
    content: string; 
    category: string; 
    createdAt: number;
    updatedAt: number;
}

// --- NOVEL / CO-WRITING TYPES ---
export interface NovelProtagonist {
    id: string;
    name: string;
    role: string; // e.g. "Protagonist", "Villain"
    description: string;
}

export interface NovelSegment {
    id: string;
    role?: 'writer' | 'commenter' | 'analyst'; 
    type: 'discussion' | 'story' | 'analysis'; 
    authorId: string; 
    content: string;
    timestamp: number;
    focus?: string; 
    targetSegId?: string;
    meta?: {
        tone?: string;
        suggestion?: string;
        reaction?: string;
        technique?: string;
        mood?: string;
    };
}

export interface NovelBook {
    id: string;
    title: string;
    subtitle?: string; 
    summary: string;
    coverStyle: string; 
    coverImage?: string; 
    worldSetting: string;
    collaboratorIds: string[]; 
    protagonists: NovelProtagonist[];
    segments: NovelSegment[];
    createdAt: number;
    lastActiveAt: number;
}

// =====================================================================
// --- VR WORLD ("彼方") TYPES ---
// 角色自主登入的虛擬世界。定時器驅動每個角色獨立調用一次 LLM，在某個房間
// 完成一次活動（v1：圖書館看小說），產出一張活動卡注入該角色的 1v1 聊天，
// 天然被上下文與記憶總結捕捉。
// =====================================================================

/** 虛擬世界裡的房間。 */
export type VRRoomId = 'library' | 'music' | 'guestbook' | 'gym' | 'postoffice' | 'theater' | 'signal' | 'sar' | 'cafe';
export type VRSARActivity = 'cabinet' | 'module-shop' | 'fishing' | 'market' | 'garden';

/** 全局小說庫裡的一本書（所有角色共享原文，各自留批註、各自書籤）。 */
export interface VRWorldNovel {
    id: string;
    title: string;
    author?: string;
    /** 書庫分類的穩定 ID；舊書缺省為未分類。 */
    categoryId?: string;
    /** 簡介，餵給角色當背景，也用於 UI 展示 */
    summary?: string;
    /** 原文按閱讀單元切好的段落塊（每塊 ~數百字，便於定位批註與推進書籤）。 */
    segments: VRNovelSegment[];
    /** 總字數（緩存，UI 展示用） */
    totalChars: number;
    createdAt: number;
    updatedAt: number;
}

export interface VRLibraryCategory { id: string; name: string; }

/** 小說裡的一個閱讀單元（原文段落塊）。 */
export interface VRNovelSegment {
    /** 段落索引（0-based，等於在 segments 數組裡的位置，持久化以防重排） */
    idx: number;
    /** 原文內容 */
    text: string;
    /** 字數（緩存） */
    chars: number;
}

/**
 * 一條批註。掛在 (novelId, segIdx) 上，可被任何角色吐槽（targetAnnotationId 指向被吐槽的批註）。
 * 全局存在 VRWorldNovel 之外的獨立集合裡——見 db 的 vr_annotations 字段。
 */
export interface VRNovelAnnotation {
    id: string;
    novelId: string;
    /** 批註錨定的段落索引 */
    segIdx: number;
    /** 作者角色 id（user 留批註時為 'user'） */
    authorId: string;
    /** 作者展示名（落庫冗餘，避免角色刪除後丟名） */
    authorName: string;
    /** 批註/吐槽正文 */
    content: string;
    /** 若是"吐槽別人的吐槽"，指向被吐槽的批註 id */
    targetAnnotationId?: string;
    createdAt: number;
}

/** 角色在虛擬世界裡的個人狀態（掛在 CharacterProfile.vrState）。 */
export interface SARModuleRuntimeState {
    version: 1;
    /** 一次裝載的穩定標識；消息 metadata 用它把同一輪外顯串起來。 */
    runId: string;
    moduleId: string;
    moduleTitle: string;
    effectLabel: string;
    description: string;
    target: 'character' | 'user';
    source: 'user' | 'character';
    sourceCharacterId?: string;
    sourceCharacterName?: string;
    /** 只保存裝載時用戶明確填寫的字面配置；不得把它當作額外指令執行。 */
    configuration?: {
        keyword: string;
    };
    /** active 階段還可影響多少次成功的前台交互。 */
    remainingTurns: number;
    totalTurns: number;
    /** 模塊結束後的反慣性提示；3 → 強提示，2/1 → 輕提醒。 */
    afterglowTurns: number;
    phase: 'active' | 'afterglow';
    /** 提前結束同樣進入解除提示期，不直接刪除事件，也不重置恢復輪次。 */
    endReason?: 'manual';
    installedAt: number;
}

export interface VRWorldCharState {
    /** 遊戲內自定義稱號；與角色姓名、人格及臨時模塊分開。 */
    title?: string;
    titleRevision?: string;
    /** 是否接入彼方；接入後知道遊戲設定，也可由用戶邀請參與。 */
    enabled: boolean;
    /** manual 僅響應用戶邀請；scheduled 定時活動。舊存檔缺省仍按 scheduled。 */
    activityMode?: 'manual' | 'scheduled';
    /** 自主登入間隔（分鐘，30 對齊；默認 120 = 2h） */
    intervalMinutes: number;
    /**
     * 每本小說的獨立書籤：novelId -> 下一次該從第幾個 segment 開始讀。
     * 這是"每個角色書籤不一樣"的落點。
     */
    novelBookmarks?: Record<string, number>;
    /** 用戶為該角色圈定的優先書單。為空時從全書庫自動輪換。 */
    preferredNovelIds?: string[];
    /** categories 模式只在所選分類中閱讀，不回退到其他分類。缺省兼容舊的逐本優先規則。 */
    novelReadingMode?: 'all' | 'books' | 'categories';
    preferredNovelCategoryIds?: string[];
    /** 僅限制自動自由活動，手動邀請可繞過；空或缺省為不限制。 */
    excludedAutoRooms?: VRRoomId[];
    excludedAutoSARActivities?: VRSARActivity[];
    /** 上一次圖書館活動選中的小說，用於有其它候選時避免連續讀同一本。 */
    lastNovelId?: string;
    /** 最近一次活動落在哪個房間（UI 立繪站位用） */
    currentRoom?: VRRoomId;
    /** 最近一次活動時間戳（UI / 調度展示用） */
    lastActiveAt?: number;
    /** SAR 臨時模塊。真實人格不改，只改變前台對話的外顯層。 */
    sarModule?: SARModuleRuntimeState;
    /** 最近一次 SAR 自由活動，供活動室和模塊觸發判斷展示。 */
    sarActivity?: VRSARActivity;
    /** 該角色專屬 API 覆蓋（用戶可單獨為「彼方」活動配 api）；不設則回落全局 apiConfig。 */
    api?: { baseUrl: string; apiKey: string; model: string };
    /**
     * 角色在「彼方」裡的 chibi 形象（Q版小人）。啟用自主登入時要求設定，可隨時編輯。
     * img 不設時回退到角色立繪/頭像。
     */
    chibi?: {
        /** 形象圖（透明背景 PNG，來自特別時光的捏人器 transparentDataUrl） */
        img: string;
        /** 捏人器導出的完整狀態，回填用於再編輯（state.selected 可作為 presets） */
        state?: any;
        /** 站位縮放（默認 1） */
        scale?: number;
        /** 垂直微調（px，負數上移，默認 0） */
        offsetY?: number;
        /** 是否水平翻轉 */
        flip?: boolean;
    };
}

/** 注入聊天的 vr_card 消息的 metadata 結構。 */
export interface SARCharacterCabinetNoteMeta {
    id: string;
    actorId: string;
    actorName: string;
    targetId: string;
    targetName: string;
    targetKind: 'user' | 'character' | 'wanderer';
    variantId: string;
    variantTitle: string;
    storyId: string;
    storyTitle: string;
    title: string;
    story: string;
    notes: string;
    highlight: string;
    createdAt: number;
}

export interface VRCardMeta {
  marketActivity?: boolean;
  marketEventId?: string;
  privateWords?: string;
    vrCard: true;
    room: VRRoomId;
    /** 活動概述（steam 提示式，UI 標題） */
    activity: string;
    novelId?: string;
    novelTitle?: string;
    /** 本次讀到的段落範圍 [from, to)（僅 library） */
    segRange?: [number, number];
    /** 本次寫下的批註摘要（保留正文，原文省略） */
    annotationExcerpts?: string[];
    /** 帶段落錨點的批註引用（用於從動態點回原文跳轉） */
    annotationRefs?: { segIdx: number; text: string }[];
    // --- 聽歌房專用 ---
    /** 本次評/聽的當前歌（名 - 歌手） */
    songLabel?: string;
    /** 本次點/排進隊列的自己的歌 */
    queuedLabel?: string;
    /** 此刻的行為描述（盯著跳/跟唱/給user錄…；娛樂室也用） */
    behavior?: string;
    // --- 留言簿專用 ---
    /** 本次發到留言簿的話（保留正文） */
    boardPost?: string;
    /** 本次發到留言簿的所有發言（原樣，含回覆對象），用於同步進 1v1 聊天/記憶 */
    boardPosts?: { content: string; replyToName?: string }[];
    /** 回覆了誰 */
    boardReplyToName?: string;
    /** 這條卡片是"用戶在留言簿發言"廣播給該 char 的 */
    userBoardPost?: boolean;
    // --- 郵局專用 ---
    /** 本次寫信/回信的正文摘要 */
    letterExcerpt?: string;
    // --- 信號墜落處（跨用戶接龍詩）專用 ---
    /** 這次貢獻所在的詩的標題 */
    poemTitle?: string;
    /** 這次寫下的那一句 */
    signalLine?: string;
    /** 這一句在詩裡是第幾句（1-based） */
    poemLineSeq?: number;
    /** 這首詩 roll 到的總篇幅（句數） */
    poemTargetLines?: number;
    /** 本次是「起新篇」（寫標題+第一句）還是「接龍」（續一句） */
    signalIsNew?: boolean;
    /** 截至本次貢獻後這首詩的全文（逐句），供卡片展示 */
    poemLinesSoFar?: string[];
    /** 所在冊子的標題（如「低電量合唱」），UI 展示 */
    bookletTitle?: string;
    /** 用戶參與時留給角色的耳語（不進詩，只隨卡片進聊天/記憶） */
    signalWhisper?: string;
    // --- SAR 活動空間：角色自主扭蛋隨筆 ---
    /** 角色自己抽取兩枚芯片、給另一位玩家使用後留下的完整櫃中隨筆。 */
    sarCabinetNote?: SARCharacterCabinetNoteMeta;
    /** 角色自主逛模塊商店時購買/裝載的記錄。 */
    sarModuleShop?: {
        moduleId: string;
        moduleTitle: string;
        usedOnUser: boolean;
    };
    /** 角色在彼方水域的真實程序判定結果；模型只負責反應與去向選擇。 */
    fishing?: {
        catchId: string;
        speciesId: string;
        speciesName: string;
        sizeCm: number;
        quality: 1 | 2 | 3;
        weatherLabel: string;
        weatherSource: 'real' | 'simulated';
        decision: 'keep' | 'guestbook' | 'dm' | 'market' | 'release' | 'sell';
        sale?: { amount: number; at: number; replyIndex: number; reply: string; expression: string; sellerWords?: string };
        exactWords?: string;
    };
}

// ============================================================
// 信號墜落處（VR 房間 'signal'）—— 跨用戶接龍現代詩
// ============================================================
// 複用漂流瓶（post-office worker）的匿名 deviceId / 筆名馬賽克 / 限流基建，
// 但走獨立的 po_poems / po_poem_lines 表。一本冊子定死規格（多少首詩 /
// 每首 roll 幾句 / 每句幾字），所有用戶的角色共寫同一份「當前」詩：讀到
// 的永遠是最新全文，誰登入誰接一句，寫滿篇幅即封存進詩集。user 不參與。

/** 信號墜落處的一句（來自某用戶某角色，跨實例匿名）。 */
export interface SignalPoemLine {
    seq: number;
    pen: string;
    content: string;
    createdAt: number;
    /** 僅當請求帶本機 device 時由後端標註：這一句是不是「我的 char」寫的（認領用，不暴露別人 device） */
    mine?: boolean;
}

/** 一首接龍詩（後端是源頭，前端按需拉取）。 */
export interface SignalPoem {
    id: string;
    bookletId: string;
    title: string;
    /** 發起者擬的主題/方向（給後來者接龍做參考的一段引導） */
    brief?: string;
    /** roll 到的篇幅（總句數） */
    targetLines: number;
    /** 已有句數 */
    lineCount: number;
    status: 'open' | 'sealed';
    lines: SignalPoemLine[];
    createdAt: number;
    sealedAt?: number;
    /** 僅當請求帶本機 device 時：這首詩裡有幾句是「我的」（>0 = 我參與過，星圖打光暈） */
    mineCount?: number;
}

/** 一本冊子（容器 + 規格）。 */
export interface SignalBooklet {
    id: string;
    title: string;
    subtitle?: string;
    theme?: string;
    /** 寫滿多少首詩算這本完成 */
    poemsTarget: number;
    /** 已封存詩數 */
    poemCount: number;
    /** 每首詩句數 roll 區間 */
    linesMin: number;
    linesMax: number;
    /** 每句字數上限 */
    charsPerLine: number;
    status: 'open' | 'done';
    createdAt: number;
}

// ============================================================
// 家園（WorldHome）—— 同世界觀多角色共同生活的大世界
// ============================================================

/**
 * user 在該世界裡的存在感模式：
 * - light: 輕度——只是觀察角色的一個切面，角色依舊以 user 為最重要的人（與 chatapp 聊天人設一致）
 * - medium: 中度——user 是世界中普通的一份子，不特殊
 * - heavy: 重度——user 不存在 / 是透明的幽靈，演繹中完全無視（通常用於看角色之間的關係）
 */
export type WorldHomeMode = 'light' | 'medium' | 'heavy';

/**
 * 時間模式（與存在感模式 WorldHomeMode 正交，創建時單獨選）：
 * - real: 真實時間——演繹進各角色的聊天與記憶（world_card），適合「真實系角色」。
 *         真實使用裡中間會穿插大量真人聊天，卡片自然稀疏，不會刷屏。
 * - sim:  模擬時間——可自定義起始年月日，**不進記憶/聊天**；適合給 OC 們開小劇場圖一樂。
 *         每 20 天（= 80 輪，一天四段：早/中/晚/凌晨）自動結一卷：生成一份小說體總結（含人物關係動態走向
 *         與評價），歸檔這 20 天原文，往後只把「該角色單方面視角的總結 + ta 最後一天 +
 *         本卷沉澱的氛圍」分開喂回各角色——避免角色被迫開上帝視角。
 */
export type WorldTimeMode = 'real' | 'sim';

/** 模擬時間的起始日期（sim 模式專用）。 */
export interface WorldSimDate {
    year: number;
    month: number;
    day: number;
}

/** 世界裡的 NPC：沒有記憶系統，完全服務於世界觀，由"世界引擎"一次 LLM 調用全部演繹。 */
export interface WorldNPC {
    id: string;
    name: string;
    /** 一句話人設（職業/性格/與誰有關） */
    persona: string;
    /** 可視化兜底 emoji（NPC 不走捏人系統） */
    emoji?: string;
}

/** 居住安排：一間小屋及其住戶。不在任何小屋裡的成員視為獨居（各自的小屋）。 */
export interface WorldHouse {
    id: string;
    name: string;
    residentIds: string[];
}

/** 成員（或 NPC）之間的**有向**關係條：from 對 to 的看法，與 to 對 from 的可以不對等。 */
export interface WorldRelationship {
    fromId: string;
    toId: string;
    /** from 眼中這段關係的名字（我視ta為摯友 / ta是我死對頭…），用戶可編輯，演繹不強行改 */
    label?: string;
    /** 0-100，from 對 to 的好感/親近度，演繹產出的 delta 會落在這裡 */
    value: number;
}

/** 世界內消息（私聊/群聊通用）。fromId 可以是成員 charId 或 NPC id。 */
export interface WorldChatMessage {
    id: string;
    fromId: string;
    fromName: string;
    text: string;
    /** 發出時的輪數與劇情時間（手機 UI 按輪分隔顯示） */
    round: number;
    storyTime: string;
    timestamp: number;
}

/**
 * 世界內消息線程。這是"手機是真手機"的落點：
 * A 先演繹時發出的私聊/群聊立刻落線程，B 後演繹時就能在自己的手機上下文裡
 * 看到並回應——消息跨角色、跨輪交替傳遞，而不是各自的獨白。
 */
export interface WorldThread {
    /** dm 線程 id = 'dm_' + 兩個 charId 排序後拼接；群聊 = 'group_main' */
    id: string;
    kind: 'dm' | 'group';
    /** 群聊名（dm 不用） */
    name?: string;
    memberIds: string[];
    messages: WorldChatMessage[];
}

/** 大段正文的文風。 */
export type WorldNarrativeStyle = 'warm' | 'inner' | 'drama' | 'breezy' | 'sitcom' | 'custom';

/**
 * 伏筆：角色這半天瞞下的事（timeline 裡 shared=false 對應的內幕）。
 * 躺在世界的伏筆欄裡，用戶可點擊"引爆"——下一輪演繹時注入給被瞞者
 * （你發現了…）與當事人（你瞞的事敗露了…），生成衝突。
 */
export interface WorldSeed {
    id: string;
    charId: string;
    charName: string;
    /** 瞞下的事 */
    text: string;
    /** 瞞著誰（成員名；空數組 = 瞞著所有人） */
    hideFrom: string[];
    round: number;
    storyTime: string;
    /** pending=躺著 / armed=用戶已點引爆，下一輪爆發 / resolved=已爆發 */
    status: 'pending' | 'armed' | 'resolved';
}

/**
 * 用戶對某角色"內心衝動"的決策/留言（想辭職？想告白？）。
 * 下一輪演繹時以"內心的聲音"注入該角色（light 模式下會聯想到 user），注入後消費掉。
 */
export interface WorldDirective {
    id: string;
    charId: string;
    /** 衝動原文（注入時引用） */
    impulseText: string;
    /** 用戶的意見 */
    text: string;
    createdRound: number;
}

/** 一個"世界"的完整定義（IndexedDB worlds 表）。 */
export interface WorldProfile {
    id: string;
    name: string;
    /** 世界觀總述（這個世界是什麼樣的，發生在哪，大家以什麼身份生活） */
    worldview: string;
    mode: WorldHomeMode;
    /** 時間模式（創建時選定，默認 real 真實時間；舊世界無此字段時按 real 處理） */
    timeMode?: WorldTimeMode;
    /** sim 模式的起始日期（不設時按創建當天） */
    simStartDate?: WorldSimDate;
    /** real 模式：這個世界活在哪個時區（IANA id，如 'Asia/Tokyo'）。不設 = 跟隨本機。
     *  一個世界只有一個鐘——它同時決定「早/中/晚/凌晨」的段判定、離線 tick 的觸發時刻，
     *  並**覆蓋**成員各自的 customTimezone（同一個世界裡的人不可能各活一個時區，
     *  否則世界鍾和角色 prompt 裡的「當前時間」會互相打架）。sim 模式不使用此字段。 */
    timezone?: string;
    /** real 模式：世界已演到的「現實段」（早/中/晚/凌晨跟著真實時鍾走）。dayKey=YYYY-MM-DD，
     *  seg=0早/1中/2晚/3凌晨（凌晨發生在 dayKey **次日**的 0~5 點，排在該劇情日末尾以保證段序單調）。
     *  只能補當天錯過的段，過了今天就補不了；未演過時為空。 */
    realClock?: { dayKey: string; seg: number };
    /** sim 模式：已被捲入章節總結的劇情時鐘數（round ≤ 此值的原文已歸檔，不再喂原文） */
    simSummarizedClock?: number;
    /** sim 模式：每 20 天結一卷的章節總結（按 index 升序累積；最新一卷參與下一卷的上文餵養） */
    chapters?: WorldChapter[];
    /** 大段正文的文風（默認 warm 細膩日常） */
    narrativeStyle?: WorldNarrativeStyle;
    /** narrativeStyle='custom' 時的自定義文風提示詞 */
    narrativeStyleCustom?: string;
    /** 大段正文的敘述人稱：first=第一人稱(我) / second=第二人稱(你) / third=第三人稱(名字/ta)。默認 first */
    narrationPerson?: 'first' | 'second' | 'third';
    /** 參與的角色（CharacterProfile.id） */
    memberIds: string[];
    npcs: WorldNPC[];
    houses: WorldHouse[];
    relationships: WorldRelationship[];
    /** 世界內消息線程（私聊 + 世界群聊），隨演繹累積，每線程截留最近若干條 */
    threads?: WorldThread[];
    /** 伏筆欄 */
    seeds?: WorldSeed[];
    /** 待注入的用戶決策（消費後移除） */
    directives?: WorldDirective[];
    /** 社交動態的互動：key = `${round}_${charId}_${postIdx}`，值含點贊數 + 評論（NPC/路人）。 */
    feedReactions?: Record<string, { likes: number; comments: { from: string; text: string }[] }>;
    /** 每天離線 tick 的時段（凌晨/早/午/晚），空數組 = 僅手動觀測推進 */
    offlineTickSlots?: ('latenight' | 'morning' | 'noon' | 'evening')[];
    /** 劇情時鐘：累計推進的段數（0 = 第1天早上；一天四段：早/中/晚/凌晨） */
    storyClock: number;
    /** storyClock/simSummarizedClock 的「每天段數」版本：舊存檔（無此字段）= 3 段（早中晚），
     *  4 = 含凌晨的四段制。加載/演繹時經 migrateWorldDaySegs 自動遷移。 */
    clockSegs?: number;
    /** 生成內容是否注入各成員的 1v1 聊天（默認 true） */
    injectToChat?: boolean;
    /** 該世界專屬 API 覆蓋；不設則回落全局 apiConfig */
    api?: { baseUrl: string; apiKey: string; model: string };
    createdAt: number;
    updatedAt: number;
}

/** 一輪演繹中單個角色的產出（一次獨立 LLM 調用，確保沒人開上帝視角）。 */
export interface WorldCharBeat {
    charId: string;
    charName: string;
    /** 角色根據環境自判定的主要位置 */
    location: string;
    /** 大段正文：聚焦一件有意義的事/一次內心拉扯（按世界設定的文風），私人視角，不外傳 */
    narrative: string;
    /** 心情（一兩個詞） */
    mood: string;
    /** 數值面板（體力/心情值/自定義鍵） */
    statusPanel?: Record<string, number | string>;
    /**
     * 這半天的具體時間軸。shared=false 的條目是角色想瞞著的——
     * 不會傳遞給其他角色，並會被提煉進伏筆欄（secrets）。
     */
    timeline?: { time: string; place: string; event: string; shared: boolean }[];
    /** 備忘錄（完全私人：只有本人和屏幕外的用戶看得到） */
    memo?: string[];
    /** 狀態背後的衝動/待決策（想辭職/想告白…），用戶可以幫忙拿主意 */
    impulse?: { text: string; options?: string[] };
    /** 瞞下的事（→ 伏筆欄）。hideFrom 空數組 = 瞞所有人 */
    secrets?: { text: string; hideFrom?: string[] }[];
    /** 手機內容（dms/group 會立刻落進 world.threads，鏈內後續角色與下一輪都能收到） */
    phone?: {
        posts?: string[];
        dms?: { to: string; lines: string[] }[];
        /** 發到世界群聊的話 */
        group?: string[];
    };
    /** 共處時當面對在場成員說的話（不是手機）——對話對象的演繹輪裡會完整聽到並被要求回應 */
    dialogues?: { with: string; lines: string[] }[];
    /** 本輪產出的關係變化（按名字回填到 world.relationships）。newLabel：僅在關係重大轉折時，
     *  角色對這段關係的新看法/稱呼（覆蓋 label，平時不給）。 */
    relationshipDeltas?: { withName: string; delta: number; reason?: string; newLabel?: string }[];
}

/** 一輪演繹（"觀測"或離線 tick 觸發，推進半天劇情時間；IndexedDB world_episodes 表）。 */
export interface WorldEpisode {
    /** Read-time observation ordinal; does not replace round used by historical message references. */
    observationNumber?: number;
    id: string;
    worldId: string;
    /** 第幾輪（= 演繹完成後的 storyClock） */
    round: number;
    /** 劇情時間標籤（第N天 白天/夜晚） */
    storyTime: string;
    trigger: 'observe' | 'tick';
    /** NPC 群像（一次調用全部 NPC） */
    npcScene?: string;
    /** NPC 留下的、可被下一輪角色接住的事件鉤子 */
    npcHooks?: string[];
    beats: WorldCharBeat[];
    /** 本輪沒演出來（LLM 調用/解析失敗）的成員 charId——UI 提示用戶可重 roll */
    failedCharIds?: string[];
    /** 機械拼接的本輪梗概，餵給下一輪做連續性 */
    summary: string;
    createdAt: number;
}

/**
 * sim（模擬時間）模式下每 20 天結的一卷「章節總結」。
 *
 * 餵養路徑（同樣嚴格防上帝視角）：
 *   - synopsis / relationshipEval：全知小說體梗概，**只給屏幕外的用戶看**（圖一樂），絕不喂角色。
 *   - atmosphere：這一卷沉澱下來的氛圍基調，可餵給所有角色（不含隱私）。
 *   - perspectives[charId]：每個角色「單方面視角」的回顧——只含 ta 知道/經歷的，
 *     往後單獨喂回對應角色，作為 ta 對這 20 天的記憶。
 *   - lastDayBeats：每個角色這一卷最後一天的 beat，連同其單視角總結作為下一卷的上文。
 */
export interface WorldChapter {
    id: string;
    worldId: string;
    /** 第幾卷（1 起） */
    index: number;
    /** 覆蓋的劇情時鐘區間（含） */
    fromClock: number;
    toClock: number;
    /** 區間起止的時間文本（sim 模式是日期） */
    fromLabel: string;
    toLabel: string;
    /** 全知小說體梗概（給用戶看，含人物關係動態走向與評價） */
    synopsis: string;
    /** 關係網這一卷的走向評價 */
    relationshipEval?: string;
    /** 這一卷沉澱的氛圍基調（影響下一卷，餵給所有角色） */
    atmosphere?: string;
    /** 每個角色的單方面視角總結（分開喂回各自） */
    perspectives: { charId: string; charName: string; text: string }[];
    /** 每個角色這一卷最後一天的 beat（作為下一卷上文） */
    lastDayBeats: WorldCharBeat[];
    createdAt: number;
}

/** 注入聊天的 world_card 消息的 metadata 結構。 */
export interface WorldCardMeta {
    worldCard: true;
    worldId: string;
    worldName: string;
    mode: WorldHomeMode;
    round: number;
    storyTime: string;
    location?: string;
    mood?: string;
    narrative?: string;
    statusPanel?: Record<string, number | string>;
    timeline?: { time: string; place: string; event: string; shared: boolean }[];
    memo?: string[];
    impulse?: { text: string; options?: string[] };
    phonePosts?: string[];
    /** 發到世界群聊的話 */
    phoneGroup?: string[];
}

/** 郵局：一封信收到的回覆（留檔用）。 */
export interface VRLetterReply {
    pen: string;
    content: string;
    createdAt: number;
}

/**
 * 郵局信件（本地存檔 + 隊列）。
 * box='outbox'：我方角色寫的漂流信（待寄出→已寄出→收到回覆留檔）。
 * box='inbox' ：從別的用戶那抽到的信（待回信→待發送回信→已發送）。
 */
export interface VRLetter {
    id: string;                 // 本地 id
    box: 'outbox' | 'inbox';
    pen: string;                // 筆名（寫信角色名 / 遠端寄信方筆名）
    content: string;
    createdAt: number;
    charId?: string;            // 寫這封信/回信的角色

    // outbox
    status?: 'queued' | 'sent' | 'archived' | 'sealed';  // 待寄出 / 已寄出 / 收到回覆留檔 / 角色已讀並封存
    remoteId?: string;          // 寄出後服務端分配的遠端 id
    released?: boolean;         // 作者已「停止傳播」：後端已刪、退出公共池，本地仍留檔
    sentAt?: number;
    repliesReceived?: VRLetterReply[];
    /** 原作者角色讀過回信後的感觸（寫完即封存，使命完成） */
    reaction?: { content: string; createdAt: number };

    // inbox
    remoteLetterId?: string;    // 遠端信 id（回信時用）
    replyStatus?: 'none' | 'queued' | 'sent'; // 未回 / 待發送回信 / 已發送
    reply?: { charId: string; pen: string; content: string; createdAt: number; userNote?: string };
    fetchedAt?: number;

    // 互動熱度緩存（服務端為準；UI 即時反饋用）
    likes?: number;             // 點贊數
    dislikes?: number;          // 點踩(=舉報)數
    views?: number;             // 被抽到/瀏覽次數
    myVote?: 1 | -1 | 0;        // 我對這封信的投票（inbox 抽到的信）
}

/** 聽歌房隊列項。 */
export interface VRMusicQueueItem {
    song: CharPlaylistSong;
    charId: string;
    charName: string;
}

/** 留言簿（共享版聊牆）的一條留言。 */
export interface VRGuestbookMessage {
    kind?: 'collection-unlock';
    id: string;
    /** 'user' = 用戶本人，其餘為 charId */
    authorId: string;
    authorName: string;
    content: string;
    /** 若是回覆某條留言 */
    replyToId?: string;
    replyToName?: string;
    createdAt: number;
}

/** 留言簿共享狀態（單例，所有角色 + 用戶共用一面牆）。 */
export interface VRGuestbookState {
    id: string; // 'board' 單例
    messages: VRGuestbookMessage[];
    updatedAt: number;
}

/** 聽歌房共享狀態（單例，所有角色共用一個循環隊列）。 */
export interface VRMusicRoomState {
    id: string; // 'state' 單例
    nowPlaying?: {
        song: CharPlaylistSong;
        charId: string;
        charName: string;
        /** 選曲心境/理由 */
        vibe?: string;
        since: number;
    };
    queue: VRMusicQueueItem[];
    updatedAt: number;
}

// ============ 劇院 / 話劇部門 ============

/** 劇本里的一個登場角色（名字 + 大致性格，供選角匹配/演繹用）。 */
export interface VRPlayRole {
    name: string;
    persona: string;
}

/** 一份投稿劇本（角色創作 / 用戶寫 / LLM 代寫 / 上傳）。 */
export interface VRScript {
    id: string;
    title: string;
    /** 一句話簡介（"創作了關於 xxx 的舞台劇"用） */
    logline: string;
    roles: VRPlayRole[];
    /** 完整劇本正文（固定格式：幕/場 + 角色台詞 + （旁白）） */
    body: string;
    /** 作者 id：'user' | charId | 'llm' */
    authorId: string;
    authorName: string;
    source: 'char' | 'user' | 'llm' | 'upload';
    createdAt: number;
}

/** 編排時的 LLM 調用模式：逐角色各調一次（精準，N 次）/ 固定兩次（省，可能 OOC）。 */
export type VRStageMode = 'per-role' | 'two-call';

/** 選角：劇本角色 → 演員（char 或 臨時 NPC）。 */
export interface VRCastAssign {
    roleName: string;
    actorId: string;   // charId | npc_xxx
    actorName: string;
    isNpc: boolean;
    /** NPC 的捏臉立繪（透明 PNG dataUrl） */
    npcChibi?: string;
}

/** 某演員讀完劇本後給導演的意見（吐槽 / 改台詞動作 / 配不配合）。 */
export interface VRActorNote {
    actorId: string;
    actorName: string;
    roleName: string;
    /** 一句吐槽 / 想法（UI 展示） */
    note: string;
    /** 角色按自己本色重寫過的"我這部分台詞 / 怎麼演"（可空 = 照原本演） */
    lines?: string;
    /** 絕對禁忌：導演絕不能讓該角色做的事（硬紅線，可空） */
    taboo?: string;
    /** 給導演的寫作指導（這條線該怎麼處理，可空） */
    direction?: string;
    /** 態度光譜：欣然 / 配合 / 勉強 / 隱忍 / 牴觸 / 拒演（按角色性子自然落點，不必都硬剛） */
    attitude?: string;
    /** 是否配合（由 attitude 推導：牴觸/拒演 = false） */
    cooperative: boolean;
}

/** 最終演出腳本的一拍（台詞氣泡 / 旁白 / 上場 / 下場）。 */
export interface VRStageLine {
    kind: 'line' | 'narration' | 'enter' | 'exit';
    /** line/enter/exit 時是誰 */
    actorName?: string;
    /** 台詞氣泡內容 / 旁白文字 */
    text: string;
}

/** 一場已收錄的演出（導演整合後的成品 + 觀眾銳評 + 評級）。 */
export interface VRStagedPlay {
    id: string;
    scriptId: string;
    title: string;
    logline: string;
    cast: VRCastAssign[];
    notes: VRActorNote[];
    /** 導演整合後的可演出腳本 */
    stage: VRStageLine[];
    /** 賽博觀眾銳評 */
    reviews: { critic: string; text: string }[];
    /** 評級（如 S / A / ★★★★☆） */
    rating: string;
    createdAt: number;
}

/**
 * 捏臉系統自定義部件（開發模式追加）。運行時由 CreatorIframe 讀出，隨 like520_init
 * 以 extraItems 注入捏人器，合併進對應類目的 PARTS。520 / 彼方 都會拿到。
 */
export interface CustomCreatorPart {
    id: string;
    /** 歸屬類目 key（如 skin / fronthair / outfit …，須與捏人器 PARTS 的 key 對應） */
    categoryKey: string;
    /** 面板裡顯示的名字 */
    name: string;
    /** 部件圖（透明 PNG 的 data URL，須與捏人器畫布同尺寸/同錨點） */
    src: string;
    /** 是否可被換色（對應 item.tintable） */
    tintable?: boolean;
    /**
     * 部件投到下方圖層上的陰影（如劉海投在耳發/臉上的影子）。
     * 透明 PNG data URL，同尺寸/同錨點；PSD 裡的正片疊底層導入時已預轉成
     * 黑色+alpha 的普通圖層，渲染時墊在本部件顏色層下方、不參與染色。
     */
    shadowSrc?: string;
    createdAt: number;
}

// --- SONGWRITING APP TYPES ---
export type SongMood = 'happy' | 'sad' | 'romantic' | 'angry' | 'chill' | 'epic' | 'nostalgic' | 'dreamy';
export type SongGenre = 'pop' | 'rock' | 'ballad' | 'rap' | 'folk' | 'electronic' | 'jazz' | 'rnb' | 'free';
export type LyricCoWritingStyle =
    | 'adaptive'
    | 'mandopop'
    | 'guofeng'
    | 'opera-wave'
    | 'cantopop'
    | 'folk'
    | 'indie-rock'
    | 'hiphop'
    | 'rnb'
    | 'vocaloid'
    | 'dark-waltz'
    | 'anime-op'
    | 'anime-ed'
    | 'denpa-kawaii'
    | 'jpop'
    | 'city-pop'
    | 'jrock'
    | 'kpop'
    | 'k-rnb'
    | 'western-pop'
    | 'edm'
    | 'alt-pop'
    | 'funk-disco'
    | 'pop-punk'
    | 'musical';

export interface SongLine {
    id: string;
    authorId: string; // 'user' or charId
    content: string;
    section: 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro' | 'free';
    /** Stable position inside a fixed/custom lyric template. Legacy lines fall back to array order. */
    slotIndex?: number;
    annotation?: string; // AI guidance note on this line
    timestamp: number;
    isDraft?: boolean; // true = not selected as final lyrics, kept as draft record
}

export interface SongTemplateSection {
    section: SongLine['section'];
    lines: number;
    chars: string;
}

export interface SongComment {
    id: string;
    authorId: string; // charId
    type: 'guidance' | 'praise' | 'suggestion' | 'teaching' | 'reaction';
    content: string;
    targetLineId?: string; // which line this comment is about
    timestamp: number;
}

export interface ChordInfo {
    root: string;       // e.g. 'C', 'D', 'Ab'
    quality: string;    // e.g. 'maj', 'min', '7', 'maj7', 'sus4'
    display: string;    // e.g. 'C', 'Am', 'G7', 'Fmaj7'
    midi: number;       // root note MIDI number (for audio)
}

export interface MelodyNote {
    midi: number;       // MIDI note number
    duration: number;   // in beats
    vowel: number;      // index into vowel formant table (0=a,1=o,2=e,3=i,4=u)
}

export interface SectionArrangement {
    section: string;            // matches SongLine.section
    chords: ChordInfo[];        // one chord per line in this section
    melodies?: MelodyNote[][];  // melodies[lineIdx] = notes for that line
}

export interface SongArrangement {
    rootNote: string;           // e.g. 'C', 'A'
    scale: 'major' | 'minor';
    bpm: number;
    sections: SectionArrangement[];
    instruments: {
        piano: boolean;
        bass: boolean;
        drums: boolean;
        melody: boolean;
    };
    drumPattern: 'basic' | 'upbeat' | 'halftime' | 'shuffle';
}

// Provider identifier for AI-generated audio. Each one has its own pricing
// / length cap / API path; the actual call site decides which to use.
//   - 'minimax-free' → music-2.6-free, free tier, 60s cap
//   - 'minimax-paid' → music-2.6, Token-Plan price, 60s cap
//   - 'ace-step'     → Replicate lucataco/ace-step, $0.015/song, 4-min cap
export type MusicProvider = 'minimax-free' | 'minimax-paid' | 'ace-step';

// AI-rendered audio attached to a SongSheet.
// Audio blob lives in the IndexedDB assets store keyed by `assetKey`,
// so the sheet itself stays small and JSON-serializable for sync/export.
export interface SongAudio {
    assetKey: string;          // DB.getAssetRaw / saveAssetRaw key
    mimeType: string;          // e.g. "audio/mpeg", "audio/wav"
    durationSec?: number;
    generatedAt: number;
    provider: MusicProvider;
    // Snapshot of the inputs used so we can show "regenerate when lyrics changed"
    promptHash: string;
    tagsUsed: string;
    lyricsLineCount: number;
}

export interface SongSheet {
    id: string;
    title: string;
    subtitle?: string;
    genre: SongGenre;
    mood: SongMood;
    bpm?: number;
    key?: string; // e.g. "C major", "A minor"
    collaboratorId: string; // the character guiding the user
    lines: SongLine[];
    comments: SongComment[];
    status: 'draft' | 'completed';
    coverStyle: string; // gradient/color identifier
    createdAt: number;
    lastActiveAt: number;
    completedAt?: number;
    arrangement?: SongArrangement;
    audio?: SongAudio;
    // Custom style prompt — when set, overrides the preset/genre/mood-derived tags.
    // Plain comma-separated English string the user (or LLM helper) authored.
    // Reused by both ACE-Step (`tags` field) and MiniMax music (`prompt` field).
    aceStepCustomTags?: string;
    // Last-used music provider for this song — drives the modal's default selection.
    musicProvider?: MusicProvider;
    // Lyric structure template chosen at creation. Drives the structure-guide
    // banner shown in the write view so user/char don't write randomly.
    lyricTemplate?: string;
    // User-authored structure used when lyricTemplate === 'custom'.
    customLyricTemplate?: SongTemplateSection[];
    // Writing grammar used by the AI lyric editor. This is intentionally
    // separate from audio genre: one genre can be co-written in many styles.
    lyricCoWritingStyle?: LyricCoWritingStyle;
    // Optional user-uploaded artwork. Usually a blobref: token.
    coverImage?: string;
}

// --- DATE APP TYPES ---
export interface DialogueItem {
    text: string;
    /** 立繪情緒 key（[happy]/[sad]/…）—— 只驅動立繪表情，不再直接當語音情緒。 */
    emotion?: string;
    /** 語音情緒，來自獨立標記 [v:xxx]，跟立繪分開。僅取合法 MiniMax emotion，否則 undefined。 */
    voiceEmotion?: string;
}

/**
 * 「觀測協議 OBSERVE」結構化觀測數據：開啟後由 LLM 在正文最前面輸出一段
 * ⟦OBSERVE⟧ 塊，前端解析成這四個維度，渲染成可獨立查看的全息 HUD。
 * 所有字段可缺省——模型偶爾漏寫某項時不應讓面板崩掉。
 */
export interface DateObservation {
    /** 時間：結合場景的當前時刻（不一定等於系統時間） */
    time?: string;
    /** 地點：角色此刻所在的具體地點 */
    place?: string;
    /** 狀態：角色的身心狀態 */
    state?: string;
    /** 細節：正在發生的動作 / 微小細節 */
    detail?: string;
    /** 用戶追加的自定義維度的值，按 DateObserveCustomField.id 存 */
    extra?: Record<string, string>;
}

/**
 * 觀測協議追加的自定義維度（在 時間/地點/狀態/細節 之外另開一格）。
 * label 同時是「線格式字段名」和「HUD 標籤」——解析時按 label 匹配回該維度。
 */
export interface DateObserveCustomField {
    id: string;        // 穩定 id，作為 DateObservation.extra 的 key
    label: string;     // 字段名 / HUD 標籤（如「天氣」「穿著」）
    hint?: string;     // 生成提示：這一格寫什麼
    enabled?: boolean; // 默認 true
}

/** 觀測協議 OBSERVE 的 HUD 視覺樣式 id */
export type DateObserveStyleId = 'hologram' | 'ink' | 'neon' | 'crystal' | 'terminal';

/**
 * 觀測協議單個維度的自定義：顯示標籤 + 生成提示 + 是否啟用。任一項留空即回落默認。
 * 注意：自定義 label 只影響 HUD 展示——注入提示詞時字段名始終用固定中文 key
 * （時間/地點/狀態/細節），保證解析穩定，用戶改名不會讓 extractObservation 失配。
 */
export interface DateObserveFieldConfig {
    /** HUD 上顯示的標籤（僅展示用，不參與解析） */
    label?: string;
    /** 注入提示詞：這個維度具體要生成什麼內容 */
    hint?: string;
    /** 是否啟用該維度（默認 true）。關掉則不注入提示、HUD 也不渲染該行。 */
    enabled?: boolean;
}

/** 觀測協議 OBSERVE 的 per-character 配置 */
export interface DateObserveConfig {
    enabled?: boolean;
    /** HUD 視覺樣式，默認 hologram */
    style?: DateObserveStyleId;
    /** 四個維度的標籤 / 提示自定義；不填回落默認值 */
    fields?: Partial<Record<keyof DateObservation, DateObserveFieldConfig>>;
    /** 用戶追加的自定義維度（在四個默認維度之外） */
    custom?: DateObserveCustomField[];
}

export interface DateState {
    dialogueQueue: DialogueItem[];
    dialogueBatch: DialogueItem[];
    currentText: string;
    /** @deprecated 舊版恢復快照會複製背景圖，可能是超大 base64；新版恢復優先讀角色上的 dateBackground。 */
    bgImage?: string;
    /** @deprecated 舊版恢復快照會複製立繪圖，可能是超大 base64；新版恢復優先讀 currentSpriteKey。 */
    currentSprite?: string;
    /** 當前立繪對應的情緒 key，只存引用信息，避免把 base64 立繪重複塞進 savedDateState。 */
    currentSpriteKey?: string;
    /** 恢復時優先按當時的皮膚集找 currentSpriteKey，皮膚不存在再回退當前皮膚/默認立繪。 */
    activeSkinSetId?: string;
    isNovelMode: boolean;
    timestamp: number;
    peekStatus: string;
    /** 當前批次解析出的觀測數據（開了 OBSERVE 才有），用於恢復會話時回填 HUD */
    observation?: DateObservation;
}

// ─── 見面 · 劇情劇場 ────────────────────────────────────────────────

/** 獨立劇場達到水位後，舊正文的歸檔去向。切換策略只影響之後的新歸檔。 */
export type StoryTheaterArchiveStrategy = 'summary' | 'vector';

export interface StoryTheaterArchive {
    id: string;
    strategy: StoryTheaterArchiveStrategy;
    fromMessageId: number;
    toMessageId: number;
    messageCount: number;
    /** summary 策略的事件盒正文；vector 策略留空，由獨立 charId 分區召回。 */
    summary?: string;
    createdAt: number;
}

/** 劇場裡用戶所扮演的身份；已有角色按 characterId 動態讀取，自定義身份來自面具箱。 */
export type StoryTheaterMaskSelection =
    | { type: 'user' }
    | { type: 'character'; id: string }
    | { type: 'custom'; id: string };

/** 獨立於用戶檔案與神經鏈接的可複用原創人物身份。 */
export interface StoryTheaterMask {
    id: string;
    name: string;
    avatar?: string;
    description: string;
    coreInstruction?: string;
    worldview?: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * 一條可反覆進入的劇情。演員與世界書只保存 id/沙盒選擇，不反寫外部掛載配置。
 * 消息正文複用 messages 表，charId 使用 `story-theater:${id}` 獨立線程；僅顯式開啟時鏡像到角色記憶流。
 */
export interface StoryTheaterEntry {
    id: string;
    title: string;
    premise: string;
    /** 誰寫下本劇情第一段：用戶當前身份或模型故事正文。 */
    openingMode?: 'user' | 'assistant';
    /** 本劇情中用戶執筆的身份；缺省時使用真實用戶檔案。 */
    mask?: StoryTheaterMaskSelection;
    characterIds: string[];
    /**
     * 客串出場的 NPC（神經鏈接「NPC」分頁的 NPCProfile.id，非 characterIds）。真實時間陪伴、
     * 虛構劇場的編輯器都會露出選擇入口；讀取側也不按模式過濾。NPC 沒有獨立記憶輸入輸出、
     * 不進 applyActorMemoryPipeline / 好感度系統，只作為輕量客串角色注入 actorContext，
     * 見 utils/storyTheater.ts 的 buildTheaterNpcContext。缺省 = 沒有 NPC 客串。
     */
    npcIds?: string[];
    /** true=像【陪伴】一樣，把第三人稱正文分別寫入每個角色的正常記憶流。 */
    writesToCharacterMemory: boolean;
    /** 每位演員各自的劇情時間錨點（datetime-local 字符串），允許跨時區/跨世界線。 */
    characterMemoryDates: Record<string, string>;
    /** 虛構劇場的記憶輸入開關；真實陪伴固定為 true。 */
    carryCharacterMemory: boolean;
    /** 攜帶記憶時，每位演員附帶的最近原文條數，默認 100。 */
    characterContextLimits: Record<string, number>;
    /** 獨立劇場累計多少條未歸檔正文後觸發歸檔。 */
    archiveAfter: number;
    /** 歸檔時至少留在會話裡的最近樓層數；舊數據默認 5。 */
    archiveKeepRecent?: number;
    archiveStrategy: StoryTheaterArchiveStrategy;
    archives: StoryTheaterArchive[];
    /** 從演員掛載世界書去重得到；只影響本劇情，不改外部掛載。 */
    selectedWorldbookIds: string[];
    presetId?: string;
    /** 會話內快速預設只覆蓋本劇場，不修改預設庫。 */
    presetOverride?: StoryTheaterPresetDocument;
    /** 僅供拒絕 assistant prefill、要求最後一條消息必須為 user 的接口使用；默認關閉以保留原生預設效果。 */
    forceUserLastMessage?: boolean;
    /** 兼容不接受酒館高級採樣參數的接口；默認關閉，完整發送預設中的 top_p 與兩項 penalty。 */
    omitSamplingParams?: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface StoryTheaterPresetPrompt {
    id: string;
    name: string;
    enabled: boolean;
    role: 'system' | 'user' | 'assistant';
    content: string;
    /** 自定義大區邊界，僅用於編輯器組織，不發送給模型。 */
    section?: { id: string; name: string; edge: 'start' | 'end' };
    /** marker 由發送器替換為角色/世界書/用戶/場景/歷史，不把佔位條目當普通正文。 */
    marker?: 'characters' | 'world_before' | 'user' | 'world_after' | 'scenario' | 'examples' | 'history';
}

export interface StoryTheaterPresetDocument {
    schema: 'sullyos.story-preset';
    version: 1;
    name: string;
    description?: string;
    generation: {
        temperature: number;
        topP: number;
        frequencyPenalty: number;
        presencePenalty: number;
        maxTokens: number;
    };
    prompts: StoryTheaterPresetPrompt[];
    assistantPrefill?: string;
}

/** 糯米機專屬劇情預設。導入器只接受 sullyos.story-preset，不兼容其它應用格式。 */
export interface StoryTheaterPreset {
    id: string;
    name: string;
    sourceFileName?: string;
    format: 'sullyos-story-preset';
    document: StoryTheaterPresetDocument;
    builtIn?: boolean;
    createdAt: number;
    updatedAt: number;
}


export interface SpecialMomentRecord {
    content: string;
    image?: string; // 活動留存的大圖，存 blobref 令牌（二進制在 blob_assets）
    timestamp: number;
    source?: 'generated' | 'migrated';
    /** Free-form per-event extra data (e.g. like520 captureface state, anchors, etc.) */
    customData?: Record<string, any>;
}

// --- QQ捏人工坊（神經鏈接） ---

/** 工坊槽位：room=小小窩房間立繪 / vr=彼方 chibi / like520=特別時光 520 大頭貼 */
export type ChibiStudioSlotId = 'room' | 'vr' | 'like520';

export interface ChibiStudioSlot {
    /** 捏人器導出的完整 state（選件+換色+翻轉…），再編輯時經 init.savedState 整套還原 */
    state?: any;
    /**
     * 透明 PNG dataURL 兜底展示圖。room/vr 的形象本體以各 App 自己的字段為準
     * （sprites.chibi / vrState.chibi.img）；like520 未通關時靠這裡展示 + 預填活動捏人器。
     */
    img?: string;
    updatedAt?: number;
}

/**
 * QQ捏人工坊：統一管理一隻角色在三處的 Q 版形象，可各捏各的、也可一鍵同步。
 * 圖片本體寫進各 App 自己的消費字段，這裡主要存「再編輯用的完整 state」。
 */
export interface ChibiStudioData {
    room?: ChibiStudioSlot;
    vr?: ChibiStudioSlot;
    like520?: ChibiStudioSlot;
}

// --- BANK / SHOP GAME TYPES (NEW) ---
export interface BankTransaction {
    id: string;
    amount: number;
    category: string; 
    note: string;
    timestamp: number;
    dateStr: string; // YYYY-MM-DD
}

export interface SavingsGoal {
    id: string;
    name: string;
    targetAmount: number;
    currentAmount: number; 
    icon: string;
    isCompleted: boolean;
}

export interface ShopStaff {
    id: string;
    name: string;
    avatar: string; // Emoji or URL
    role: 'manager' | 'waiter' | 'chef';
    fatigue: number; // 0-100, >80 stops working
    maxFatigue: number;
    hireDate: number;
    personality?: string; // New: Custom personality
    x?: number; // New: Position X (0-100)
    y?: number; // New: Position Y (0-100)
    // Pet System
    ownerCharId?: string; // If set, this staff is a "pet" belonging to this character
    isPet?: boolean; // Flag to indicate this is a pet
    scale?: number; // Display scale (0.4-2)
}

export interface ShopRecipe {
    id: string;
    name: string;
    icon: string;
    cost: number; // AP cost to unlock
    appeal: number; // Contribution to shop appeal
    isUnlocked: boolean;
}

export interface BankConfig {
    dailyBudget: number;
    currencySymbol: string;
}

export interface BankGuestbookItem {
    id: string;
    authorName: string;
    avatar?: string;
    content: string;
    isChar: boolean;
    charId?: string;
    timestamp: number;
    systemMessageId?: number; // Linked system message ID for deletion
}

// --- DOLLHOUSE / ROOM DECORATION TYPES ---
export interface DollhouseSticker {
    id: string;
    url: string;       // image URL or emoji
    x: number;         // % position within the surface
    y: number;
    scale: number;
    rotation: number;
    zIndex: number;
    surface: 'floor' | 'leftWall' | 'rightWall';
}

export interface DollhouseRoom {
    id: string;
    name: string;
    floor: number;         // 0 = ground floor, 1 = second floor
    position: 'left' | 'right';
    isUnlocked: boolean;
    layoutId: string;      // references a RoomLayout template
    wallpaperLeft?: string;  // CSS gradient or image URL
    wallpaperRight?: string;
    floorStyle?: string;     // CSS gradient or image URL
    roomTextureUrl?: string; // optional full-room overlay image
    roomTextureScale?: number;
    stickers: DollhouseSticker[];
    staffIds: string[];      // staff assigned to this room
}

export interface RoomLayout {
    id: string;
    name: string;
    icon: string;
    description: string;
    apCost: number;
    floorWidthRatio: number;   // relative width (0-1)
    floorDepthRatio: number;   // relative depth (0-1)
    hasCounter: boolean;
    hasWindow: boolean;
}

export interface DollhouseState {
    rooms: DollhouseRoom[];
    activeRoomId: string | null;   // currently zoomed-in room
    selectedLayoutId?: string;
}

export interface BankShopState {
    actionPoints: number;
    shopName: string;
    shopLevel: number;
    appeal: number; // Total Appeal
    background: string; // Custom BG
    staff: ShopStaff[];
    unlockedRecipes: string[]; // IDs
    activeVisitor?: {
        charId: string;
        message: string;
        timestamp: number;
        giftAp?: number; // Optional gift from visitor
        roomId?: string;
        x?: number;
        y?: number;
        scale?: number;
    };
    guestbook?: BankGuestbookItem[];
    dollhouse?: DollhouseState;
}

export interface BankFullState {
    config: BankConfig;
    shop: BankShopState;
    goals: SavingsGoal[];
    firedStaff?: ShopStaff[]; // Fired staff pool: can rehire or permanently delete
    todaySpent: number;
    lastLoginDate: string;
    dataVersion?: number; // Migration version tracker (undefined = v0/v1 legacy)
}
// ---------------------------------

// --- CHAR MUSIC PROFILE (網易雲風格 · 角色的音樂人格) ---

/** 角色本地歌單裡的輕量歌曲快照 — 字段與 MusicContext 的 Song 對齊（無運行時 url） */
export interface CharPlaylistSong {
    id: number;
    name: string;
    artists: string;
    album: string;
    albumPic: string;
    duration: number;
    fee: number;
    /**
     * 'user' = 這首是從 user 那裡"抄"過來的（user 在聽 → char 加進自己歌單）。
     * 'discovered' = char 自己探索 / 初始化時找到的。
     * 不寫默認按 'discovered' 處理（向後兼容已有數據）。
     * 用途：當 char 後續"在聽"這首時，prompt 會告訴 LLM "這是從 user 那兒收來的"，
     * 讓記憶/對話能自然帶上這層關係，而不是當成一首中立的歌。
     */
    source?: 'user' | 'discovered';
    /** 加入歌單時間，用來排序 / 顯示"最近收藏" */
    addedAt?: number;
}

export interface CharPlaylist {
    id: string;                 // 本地 id (不與網易雲 playlistId 衝突)
    title: string;
    description: string;        // 角色自己寫的歌單簡介
    coverStyle: string;         // 漸變色標識 or 第一首歌封面
    songs: CharPlaylistSong[];
    mood?: SongMood;
    createdAt: number;
    updatedAt: number;
}

export interface CharPlayRecord {
    song: CharPlaylistSong;
    at: number;                 // 播放時間戳（真實時間）
    context?: string;           // 該時刻的心境備註，如 "失眠的時候"
}

export interface CharMusicReview {
    id: string;
    targetType: 'song' | 'user_playlist' | 'user_record';
    targetId: string;           // songId or playlistId as string
    targetTitle: string;        // 歌名 / 歌單名
    content: string;            // 評論正文
    createdAt: number;
}

/** 運行時"此刻在聽" — 根據 Schedule 決定，不必持久化（可以隨時 recompute） */
export interface CharCurrentListening {
    songId: number;
    songName: string;
    artists: string;
    albumPic: string;
    /** 心境 / 選曲理由（來自 slot.innerThought 或 description） */
    vibe?: string;
    startedAt: number;
}

export interface CharMusicProfile {
    /** 音樂品味簡介（LLM 初始化生成） */
    bio: string;
    /** 曲風標籤（可隨聽歌演化） */
    genreTags: string[];
    /** 偏愛的藝人 */
    signatureArtists: { name: string; artistId?: number }[];
    /** 本地歌單列表 */
    playlists: CharPlaylist[];
    /** 仿 likelist */
    likedSongIds: number[];
    /** 最近在聽（仿 user/record） */
    recentPlays: CharPlayRecord[];
    /** 私人 FM 關鍵詞種子（留給未來做 char FM） */
    fmSeed?: string;
    /** 角色對歌/user 歌單的點評 */
    reviews?: CharMusicReview[];
    /** 此刻在聽（Schedule 運行時填充，UI 展示用） */
    currentListening?: CharCurrentListening;
    /** 是否允許 char 讀取 user 的網易雲數據（默認 true） */
    canReadUserMusic?: boolean;
    /** 初始化時間 */
    initializedAt?: number;
    updatedAt: number;
}

export type CompanionTouchZone = 'head' | 'face' | 'hand' | 'body' | 'other';

export interface AvatarTouchRegion {
  id: string;
  zone: CompanionTouchZone;
  /** Regions are normalized against this Live2D model's rendered bounds, not the screen. */
  shape: 'ellipse';
  /** Ellipse center and size, all in model-local 0..1 coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompanionPerformancePrecision {
  /** Temporarily suspend ambient turns/glances and keep the authored pose authoritative. */
  lockAutonomy?: boolean;
  /** Keep head targets absolute after gesture/emotion overlays. */
  lockHead?: boolean;
  /** Normalized pose targets (-1..1). */
  headX?: number;
  headY?: number;
  headZ?: number;
  eyeX?: number;
  eyeY?: number;
  bodyX?: number;
  bodyY?: number;
  bodyZ?: number;
  /** Small intentional pass beyond the pose before settling, 0..0.2. */
  overshoot?: number;
  /** Time used to enter, pass and settle into the pose. */
  settleMs?: number;
}

export interface CompanionTouchReaction {
  id: string;
  /** Displayed source line. Newly generated companion packs keep this in Simplified Chinese. */
  text: string;
  /** Spoken translation kept separate from the displayed source line. */
  translation?: string;
  /** Persisted local audio generated together with this reaction. */
  voiceAssetId?: string;
  voiceMimeType?: string;
  voiceText?: string;
  voiceLanguage?: string;
  performance: {
    emotion: 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised' | 'calm' | 'relaxed';
    gesture: 'idle' | 'talk' | 'nod' | 'shake' | 'tilt' | 'explain' | 'wave' | 'shy' | 'lean-in' | 'lean-back';
    camera: 'close' | 'medium' | 'wide' | 'push-in' | 'pull-out';
    gaze: 'viewer' | 'left' | 'right' | 'down';
    intensity: number;
    faces?: Array<'wink' | 'grin' | 'pout' | 'blush' | 'eyes-closed' | 'smile-eyes' | 'brow-up' | 'brow-sad' | 'brow-angry'>;
    modelAction?: string;
    modelActions?: string[];
    precision?: CompanionPerformancePrecision;
  };
}

export interface CompanionStartupSettings {
  enabled: boolean;
  /** User-authored or character-generated line; never supplied by a desktop theme. */
  line: string;
  /** User-authored spoken translation. Empty means speak the source line. */
  translation?: string;
  /** Empty means the source/default language; otherwise a TTS language_boost code. */
  voiceLanguage?: string;
  performance: CompanionTouchReaction['performance'];
  /** Optional LLM-directed beats, scheduled against the actual saved voice duration. */
  performanceCues?: Array<{
    at: number;
    direction: CompanionTouchReaction['performance'];
    endDirection?: CompanionTouchReaction['performance'];
    holdMs?: number;
  }>;
  /** Source + spoken translation signature used to reject stale cue packs. */
  performanceCueText?: string;
  performanceGeneratedAt?: number;
  voiceAssetId?: string;
  voiceMimeType?: string;
  voiceText?: string;
  voiceGeneratedLanguage?: string;
  voiceGeneratedAt?: number;
  generatedAt?: number;
  updatedAt?: number;
}

export interface CompanionStartupPreset {
  id: string;
  name: string;
  startup: CompanionStartupSettings;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionTouchPreset {
  id: string;
  name: string;
  enabledZones: CompanionTouchZone[];
  reactions: Partial<Record<CompanionTouchZone, CompanionTouchReaction[]>>;
  voiceLanguage?: string;
  voiceEnabled?: boolean;
  voiceGeneratedCount?: number;
  generatedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionTouchSettings {
  enabledZones: CompanionTouchZone[];
  reactions: Partial<Record<CompanionTouchZone, CompanionTouchReaction[]>>;
  /** Language used for touch-reaction translations and their persisted voice pack. */
  voiceLanguage?: string;
  startup?: CompanionStartupSettings;
  /** When true, reactions with voiceAssetId play their local pre-generated audio. */
  voiceEnabled?: boolean;
  voiceGeneratedCount?: number;
  generatedAt?: number;
  /** 多套開機演出獨立保存；startup 仍是當前實際啟用的兼容字段。 */
  startupPresets?: CompanionStartupPreset[];
  activeStartupPresetId?: string;
  /** 多套觸摸反饋獨立保存；頂層 reactions 等字段仍是當前實際啟用包。 */
  touchPresets?: CompanionTouchPreset[];
  activeTouchPresetId?: string;
}

export type MemoryPalaceWaterlinePreset = 'online' | 'balanced' | 'offline' | 'custom';

export interface MemoryPalaceWaterlineConfig {
  preset: MemoryPalaceWaterlinePreset;
  /** 自定義模式保留在熱區內的消息數量。 */
  hotZoneSize?: number;
  /** 自定義模式觸發下一輪整理前允許積累的緩衝消息數量。 */
  bufferThreshold?: number;
}

/**
 * 用戶自定義「心聲 / 好感度」條目的共同形狀。
 * content 給心聲（文本）用，value 給好感度（0-100 數值）用，同一條目只填其中一個。
 */
export interface CharacterCustomMeter {
  id: string;
  /** 用戶自己起的標題，如「今日心事」「對我的信任」 */
  title: string;
  /** 用戶填的生成提示詞，生成/重新生成時拼進 prompt */
  prompt: string;
  /** 新增時隨機分配的粉嫩色調（hex），用於卡片著色 */
  color: string;
  /** 最近一次生成/編輯的時間戳 */
  updatedAt?: number;
  /** 心聲正文（kind='text' 時使用） */
  content?: string;
  /** 數值旁的一句第一人稱狀態說明（kind='number' 好感度專屬），跟數值同一次生成更新 */
  statusNote?: string;
  /** 好感度數值 0-100（kind='number' 時使用） */
  value?: number;
  /**
   * 自動更新節奏；不設置＝保持純手動（現狀默認），只能自己點「重新生成」。
   * - {mode:'hours', interval: N} 每隔 N 小時自動重新生成一次（"一天一更"＝N=24）
   * - {mode:'turns', interval: N} 每隔 N 輪對話（角色回覆計數，僅本機聊天路徑）自動重新生成一次
   */
  autoUpdate?: { mode: 'hours' | 'turns'; interval: number };
  /** mode='turns' 時：距上次自動觸發已經過去幾輪角色回覆；達到 autoUpdate.interval 時觸發並清零。 */
  turnsSinceAutoUpdate?: number;
}

export interface CharacterProfile {
  id: string;
  name: string;
  avatar: string;
  /**
   * 視頻通話使用的本地 VRM / Live2D 形象。模型二進制包保存在 IndexedDB
   * blob_assets，角色資料只保存輕量索引，避免把數 MB 的模型塞進
   * localStorage / React state。
   */
  videoAvatar?: {
      version: 1;
      format: 'vrm';
      assetId: string;
      fileName: string;
      byteLength: number;
      importedAt: number;
      /** 用戶在舞台上拖拽/捏合校準的構圖；偏移量是相對畫布寬高的比例。 */
      framing?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 用戶手動錨定的臉部特寫構圖；close/push-in 鏡頭直接落到這裡，不再按身高比例猜臉的位置。 */
      faceFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 觸感陪伴桌面（companion 皮膚）的全屏構圖；與通話窗口的 framing 獨立保存。 */
      companionFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 陪伴桌面角色可視窗口裁剪；數值為相對舞台寬高的內縮比例。 */
      companionCrop?: {
          top: number;
          right: number;
          bottom: number;
          left: number;
      };
  } | {
      version: 1;
      format: 'live2d';
      assetId: string;
      fileName: string;
      /** 隨 SullyOS 發佈的靜態模型；不依賴 IndexedDB，也不需要進入模型備份。 */
      builtIn?: true;
      /** 相對當前應用根目錄的 model3.json；僅 builtIn 模型使用。 */
      builtinModelUrl?: string;
      /** balanced = 2K 默認紋理，hd = 4K 可選紋理。 */
      builtinQuality?: 'balanced' | 'hd';
      /** 導入模型的運行紋理檔位；默認 balanced(2K)，源模型最多保留到 4K 以便切換。 */
      textureQuality?: 'balanced' | 'hd';
      /** 內置 Sully 的一次性默認構圖遷移版本。 */
      builtinFramingVersion?: 1 | 2;
      /** ZIP 包內 model3.json 的完整相對路徑。 */
      modelPath: string;
      byteLength: number;
      fileCount: number;
      importedAt: number;
      /** 源包格式：舊模型使用 STORE，新導入 ZIP 保留原包並按文件流式讀取。 */
      runtimePackageEncoding?: 'store-v1' | 'zip-v1';
      /** 自動動作權限策略版本；2 = 安全動作默認加入 AI 動作庫。 */
      actionPolicyVersion?: 2;
      /** 用戶校準後的 Live2D 舞台構圖；偏移量是相對畫布寬高的比例。 */
      framing?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 用戶手動錨定的臉部特寫構圖；close/push-in 鏡頭直接落到這裡，不再按啟發式猜臉的位置。 */
      faceFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 觸感陪伴桌面（companion 皮膚）的全屏構圖；與通話窗口的 framing 獨立保存。 */
      companionFraming?: {
          scale: number;
          offsetX: number;
          offsetY: number;
      };
      /** 陪伴桌面角色可視窗口裁剪；數值為相對舞台寬高的內縮比例。 */
      companionCrop?: {
          top: number;
          right: number;
          bottom: number;
          left: number;
      };
      /** 用戶為這個 Live2D 模型單獨圈選的觸摸區域；未命中時仍回退模型自己的 HitArea。 */
      touchRegions?: AvatarTouchRegion[];
      /** model3.json Groups 中聲明的口型參數；沒有聲明時使用標準參數。 */
      lipSyncParameterIds: string[];
      /** 每個模型自己的動作/表情權限。AI 只能調用 permission=ai 的項目。 */
      actions: Array<{
          id: string;
          /** params = 用戶自建的參數組合動作（VTube Studio 風格），不依賴模型文件。 */
          kind: 'motion' | 'expression' | 'params';
          name: string;
          file: string;
          group?: string;
          index?: number;
          expressionId?: string;
          /** kind=params 時要推到的參數目標值列表。 */
          params?: Array<{ id: string; value: number }>;
          /** motion3/exp3 文件實際寫入的參數；用於高質量模式判斷能否安全並行動作。 */
          parameterIds?: string[];
          /** exp3 參數目標；衣櫥會把這些值作為持久底層，避免表情重置順帶清掉服裝。 */
          parameterValues?: Array<{
              id: string;
              value: number;
              blend?: 'Add' | 'Multiply' | 'Overwrite';
          }>;
          /** VTube Studio 中綁定的原始組合鍵，例如 F1 / Alt+Q。 */
          hotkey?: string;
          source?: 'model3' | 'vtube' | 'discovered' | 'custom';
          /** VTube Studio 的“清除全部表情”熱鍵。 */
          resetExpression?: boolean;
          tags: string[];
          /** 真·衣櫥動作：只允許用戶手動觸發，永遠不會進入 LLM 動作白名單。 */
          wardrobe?: boolean;
          permission: 'ai' | 'manual' | 'blocked';
      }>;
      /** 衣櫥中最後一次由用戶手動選擇的服裝動作。 */
      activeWardrobeActionId?: string;
  };
  /** Inactive whole-model outfits. Switching swaps one entry with videoAvatar; only matching formats are shown. */
  videoAvatarWardrobe?: Array<NonNullable<CharacterProfile['videoAvatar']>>;
  /** Which character visual the tactile companion desktop should render. */
  companionAvatar?: CompanionAvatarConfig;
  /**
   * 視頻通話舞台的自定義背景：`blobref:<id>` 令牌（本地圖片，存 IndexedDB
   * blob_assets，備份令牌原樣進包、二進制走 blobs/* 旁路）或 http(s) 圖床直鏈。
   * 空 = 默認氛圍漸變。
   */
  videoCallBackground?: string;
  /**
   * 觸感陪伴桌面（companion 皮膚）的背景：`preset:<id>`（內置華麗漸變場景）、
   * `blobref:<id>` 令牌（本地圖片，備份令牌原樣進包、二進制走 blobs/* 旁路）
   * 或 http(s) 圖床直鏈。空 = 默認時段天光。
   */
  companionBackground?: string;
  /**
   * 觸感陪伴桌面的本地反饋包。用戶只在設置中主動生成一次；之後每次觸碰
   * 都從這裡輪播台詞與演出，不再逐次請求主聊天 API。
   */
  companionTouchSettings?: CompanionTouchSettings;
  /**
   * 視頻通話演出編排檔位：
   * - basic / undefined：主回覆模型順手輸出動作指令，不增加請求。
   * - high：情緒 Buff API 只讀取角色性格與本輪定稿台詞，獨立排練動作。
   */
  videoCallPerformanceQuality?: 'basic' | 'high';
  /**
   * 高質量視頻通話首次使用時，由副 API 從完整 ContextBuilder 上下文提煉的
   * 短表演人格。之後每輪導演只讀取這份緩存（最多 200 字），不再重複攜帶整份人設。
   * 屬本地運行派生數據；角色卡分享時剝離。
   */
  videoCallPerformancePersona?: string;
  videoCallPerformancePersonaGeneratedAt?: number;
  description: string;
  systemPrompt: string;
  worldview?: string;
  /** 角色分組：指向 CharacterGroup.id；空或指向已刪分組 = 未分組。僅本地組織用，不隨角色卡導出 */
  groupId?: string;
  memories: MemoryFragment[];
  refinedMemories?: Record<string, string>;
  activeMemoryMonths?: string[];
  
  writerPersona?: string;
  writerPersonaGeneratedAt?: number;

  mountedWorldbooks?: MountedWorldbook[];

  impression?: UserImpression;

  bubbleStyle?: string;
  /** 聊天細節微調的角色級覆蓋（聊天內「＋」→「聊天裝扮」）。
   *  enabled=true 時已定義的字段逐個覆蓋全局 OSTheme 同名設置，未定義的字段繼續跟隨全局；
   *  enabled 為 false/undefined 或整個字段缺省 = 完全跟隨全局（現狀零變化）。
   *  屬美化類本地偏好：隨完整備份走，但角色卡分享時剝離（見 utils/characterCard.ts）。 */
  chatFineTune?: ChatFineTuneOverride;
  /** ChatApp visual fields only; filtered through the decoration allowlist. */
  chatAppearance?: Partial<OSTheme>;
  chatDecorationCssIsolated?: boolean;
  chatBackground?: string;
  contextLimit?: number;
  /**
   * AI 原文讀取範圍策略：
   * - adaptive：全自動記憶接管，最大範圍從記憶宮殿水位線之後開始；
   * - manual：用戶拉桿決定最多讀取最近 contextLimit 條完整原文。
   */
  contextRangeMode?: 'adaptive' | 'manual';
  /**
   * 用戶主動點「一鍵存進記憶宮殿」後，讓原文範圍繼續跟隨記憶水位線。
   * 與全自動歸檔開關獨立；未使用該按鈕的舊角色保持 undefined，不改變既有行為。
   */
  contextFollowsMemoryPalaceHwm?: boolean;
  /** 上下文範圍結構版本；用於把舊版「5000 條 + 自動水位隱藏」一次性遷移到自適應模式。 */
  contextRangePolicyVersion?: number;
  /**
   * 用戶額外設置的 AI 原文斷點。它只能在拉桿/自適應最大範圍內進一步縮小，
   * 不能突破最大範圍向更早讀取；一旦被移動中的最大範圍越過便自動失效。
   */
  contextUserStartMessageId?: number;
  hideSystemLogs?: boolean; 
  /** 舊版歸檔內部隱藏線；新版 AI 原文範圍不再拿它當用戶斷點。 */
  hideBeforeMessageId?: number; 
  
  dateBackground?: string;
  sprites?: Record<string, string>;
  spriteConfig?: SpriteConfig;
  customDateSprites?: string[]; // User-added custom emotion names for date mode (per-character)
  dateLightReading?: boolean;   // Light reading mode for novel/text view in date
  dateReadingShowAvatars?: boolean; // Show both participants' avatars beside messages in date reading mode
  dateSkinSets?: SkinSet[];     // Multiple skin sets for portrait mode
  activeSkinSetId?: string;     // Currently active skin set ID
  dateStyleConfig?: DateStyleConfig; // 見面模式文風（寫作風格 / 敘事人稱 / 自定義補充）
  /** 觀測協議 OBSERVE：開啟後每條回覆注入「時間/地點/狀態/細節」結構化觀測，渲染成全息 HUD（樣式/字段可自定義） */
  dateObserve?: DateObserveConfig;

  savedDateState?: DateState;
  specialMomentRecords?: Record<string, SpecialMomentRecord>;

  /** QQ捏人工坊（神經鏈接）：三處 Q 版形象的捏人器 state 與 520 兜底圖，見 ChibiStudioData */
  chibiStudio?: ChibiStudioData;

  // 小紅書 per-character toggle
  xhsEnabled?: boolean;

  socialProfile?: {
      handle: string;
      bio?: string;
  };

  roomConfig?: {
      bgImage?: string;
      wallImage?: string;
      floorImage?: string;
      items: RoomItem[];
      wallScale?: number; 
      wallRepeat?: boolean; 
      floorScale?: number;
      floorRepeat?: boolean;
  };
  
  // deprecated: per-character assets migrated to global room_custom_assets_list with assignedCharIds

  lastRoomDate?: string;
  savedRoomState?: RoomGeneratedState;

  phoneState?: {
      records: PhoneEvidence[];
      customApps?: PhoneCustomApp[];
      simLogs?: PhoneSimLog[]; // 「生活記錄」：人格模擬演出留存
      chatReadAt?: number;     // 上次打開 Messages 的時間戳，用於計算未讀
      sendToChat?: boolean;    // 查手機生成的內容是否同步到私聊（默認 true）
      contacts?: PhoneContact[]; // 人際關係系統：機主的通訊錄
      allowFictionalContacts?: boolean; // 是否允許生成虛構 NPC 聯繫人；false=只與神經鏈接裡的真實角色來往（默認 true）
      aiAgent?: {                 // 智能體 App：偷看到的「AI 也在玩 AI」記錄
          sessions: AiSession[];
          cards?: TavernCard[];  // 酒館裡建的角色卡
      };
      /**
       * 角色端的 Real Balance 錢包，跟用戶 UserProfile.realBalance 結構一致、帳本各自獨立。
       * undefined = 還沒打開過；utils/realBalance.ts 的 ensureRealBalanceState() 負責生成初始狀態。
       * 私聊轉帳走「發送時結清」的託管模型：用戶/角色任一方發起轉帳時即從發起方帳戶扣款，
       * 對方「收下」時才真正入帳到對方帳戶，「退回」時把錢退回發起方——兩邊各自的 Real Balance
       * 由 utils/chatParser.ts 的 onUserTransferAccepted/onCharTransferSend 等回調驅動更新。
       */
      realBalance?: RealBalanceState;
      /**
       * 「軌跡」Profile 子頁（檔案資料/階段目標/待辦日程）三段合一的生成結果。
       * undefined = 還沒生成過；點「刷新」調 utils/trajectory.ts 整段重生成替換。
       */
      trajectoryProfile?: CharacterTrajectoryProfile;
      /** 「軌跡」OOTD 分頁：每次生成追加一條，按 timestamp 排前端自己分組/排序。 */
      trajectoryOotd?: TrajectoryOotdPost[];
      /** 「軌跡」Moments 分頁的封面圖（點大圖換背景），blob-ref 令牌；undefined = 用默認漸變。 */
      trajectoryMomentsCover?: string;
      /** 「軌跡」Moments 分頁：角色專屬動態，每次生成追加一條，最新的排前面。不再讀 SocialApp 共享動態池。 */
      trajectoryMoments?: TrajectoryMomentPost[];
      /** 「軌跡」Journey 分頁：每次生成追加一條，最新的排前面。 */
      trajectoryJourney?: TrajectoryJourneyEntry[];
  };

  // 「夢的殘頁」：在小屋裡偷看到的夢境演出留存（角色不記得，僅供用戶回看）
  dreamLogs?: DreamLog[];

  voiceProfile?: {
      provider?: 'minimax' | 'custom';
      voiceId?: string;
      // MiniMax 合成參數版本。缺省/legacy 保持歷史效果；natural-v2 需由用戶主動開啟。
      minimaxParamVersion?: 'legacy' | 'natural-v2';
      // 魚聲 Fish Audio 音色：從 fish.audio 語音庫複製的 reference_id。
      // 與 MiniMax 的 voiceId 不通用，單獨保存，切換 provider 時各取各的。
      fishReferenceId?: string;
      // 該角色單獨指定的魚聲模型（覆蓋全局 fishAudioModel）。
      fishModel?: string;
      // ElevenLabs 角色音色 ID。與 MiniMax voiceId / Fish reference_id 各存各的。
      elevenLabsVoiceId?: string;
      voiceName?: string;
      source?: 'system' | 'voice_cloning' | 'voice_generation' | 'custom';
      model?: string;
      notes?: string;
      timberWeights?: { voice_id: string; weight: number }[];
      voiceModify?: { pitch?: number; intensity?: number; timbre?: number; sound_effects?: string };
      emotion?: string;
      speed?: number;
      vol?: number;
      pitch?: number;
  };

  // 時間感知強化：開啟（默認）時會向上下文注入「距離上次聊天已過去多久」的強化提示，
  // 讓角色強化時間觀念、主動匹配現實世界時間。關掉後不再注入這組提示詞
  // （注意：歷史消息本身仍帶時間戳，關掉後弱化程度取決於模型自身理解）。
  timeAwarenessEnabled?: boolean;

  // 自定義時區（異國戀 / 角色身處異國等場景）。與「時間感知強化」完全獨立、可任意組合：
  // 開啟後，注入給該角色的「當前時間 / 消息時間戳 / 夜間判斷」都按 customTimezone 折算，
  // 讓 ta 活在自己的本地時間裡，並知道與用戶之間存在時差。
  customTimezoneEnabled?: boolean;
  customTimezone?: string; // IANA 時區 id，如 'Asia/Tokyo'

  // 線下時間感知（約會 / 見面 App）：開啟（默認）時向見面 system prompt 注入「當前真實時間」。
  // 關掉後見面場景不再注入時間，讓劇情脫離現實時間線。獨立開關。
  dateTimeAwarenessEnabled?: boolean;

  // ─── 生活記錄注入（檔案 App「生活記錄」→ 聊天提示詞，per-character）───
  // 總開關：默認關（opt-in）。開啟後才注入「用戶生活記錄」section（潛意識背景約束 +
  // 各模塊今日摘要 + [[LIFE:...]] 代記指令說明）。關閉時連指令說明都不給角色看。
  lifeRecordEnabled?: boolean;
  // 小開關：默認開（!== false 即開），受總開關統轄；分別控制對應模塊的數據摘要與代記指令。
  lifeRecordPeriodEnabled?: boolean;    // 生理期
  lifeRecordMedEnabled?: boolean;       // 藥盒
  lifeRecordExpenseEnabled?: boolean;   // 記帳（打通銀行 bank_transactions）
  lifeRecordExerciseEnabled?: boolean;  // 鍛鍊

  // Chat & Date voice TTS settings
  chatVoiceEnabled?: boolean;
  // 收到語音是否自動播放。默認關（不填 = 不自動播）：語音條照常出現，點一下才響。
  // 只管 AI 自動發來的語音；用戶主動點「轉換語音」/ 點空語音條生成的，仍然生成完就播。
  chatVoiceAutoPlay?: boolean;
  chatVoiceLang?: string;
  dateVoiceEnabled?: boolean;
  dateVoiceLang?: string;
  // Call (voice phone) — remembered translation language for this character
  callVoiceLang?: string;

  // ── 聊天設定 · Relationship（全螢幕聊天設定頁；提示詞注入與動作標籤見 utils/chatRelationship.ts）──
  /** 用戶給角色取的暱稱：聊天頁頂部顯示這個，角色也知道用戶這樣叫他。空 = 用角色名。 */
  chatNickname?: string;
  /** 角色怎麼稱呼用戶。空 = 用用戶（該聊天生效的身份）的名字。 */
  userNickname?: string;
  /** 用戶認為的關係（角色看得到）。 */
  userViewRelationship?: string;
  /** 角色認為的關係；開了 allowCharChangeRelationship 時角色可以用動作標籤自己改。 */
  charViewRelationship?: string;
  /** 允許角色在聊天中依劇情自行更改 charViewRelationship（[[ACTION:RELATIONSHIP|新關係]]）。 */
  allowCharChangeRelationship?: boolean;
  /** 「我們已相識 N 天」的起點（YYYY-MM-DD）。沒設時介面用第一條聊天記錄的日期，提示詞不注入。 */
  acquaintanceStartDate?: string;
  /** 聊天設定 · Scenario ·「已讀不回」（邏輯見 utils/readNoReply.ts）。 */
  readNoReply?: ReadNoReplySettings;
  /** 聊天設定 · Scenario ·「延遲自動回覆」（邏輯見 utils/delayedReply.ts）。 */
  delayedReply?: DelayedReplySettings;

  // Cross-session guidebook insights: what char has discovered about user across games
  guidebookInsights?: string[];

  // 主動消息配置
  proactiveConfig?: {
    enabled: boolean;
    intervalMinutes: number; // 30, 60, 120, 240, etc.
    useSecondaryApi?: boolean;
    secondaryApi?: {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
  };

  /**
   * 該角色主對話（Chat 私聊）專屬 API 覆蓋；不設或 baseUrl 為空則回落全局 apiConfig。
   * 與 emotionConfig.api / proactiveConfig.secondaryApi 各管各的，互不影響。
   */
  chatApi?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };

  /**
   * 該角色專屬生圖設定，只影響這個角色的生圖效果；生圖 API 引擎本身用全局 imageGenConfig。
   */
  imageGenCharConfig?: {
    /** 開啟後生成時會帶上參考圖（臉部鎖定），具體是否真的傳參考圖取決於生圖引擎是否支持。 */
    referenceEnabled?: boolean;
    /** 專屬人物特徵提示詞，生成時拼進正文提示詞。 */
    characterPrompt?: string;
    /** 參考圖（blob-ref token，putImageBlob 存的原圖）。 */
    referenceImage?: string;
    /**
     * 非自拍照（合照/他拍/風景/物件）不使用參考圖，只用文字提示詞生成；默認（缺省）為開啟。
     * 判斷口徑留給調用方（比如根據生成請求裡的場景描述），這裡只存開關狀態。
     */
    nonSelfieSkipsReference?: boolean;
    /** 參考圖上鎖定的臉部區域（相對參考圖寬高的比例），發送參考圖時按此裁切，減少服裝/背景干擾。 */
    referenceFaceBox?: {
      x: number;
      y: number;
      size: number;
    };
  };

  // 情緒Buff系統
  activeMsg2Config?: ActiveMsg2CharacterConfig;
  activeBuffs?: CharacterBuff[];
  buffInjection?: string;   // 注入到systemPrompt的敘事型情緒底色描述
  emotionConfig?: {
    enabled: boolean;
    api?: {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
  };

  /**
   * 用戶自定義「心聲」：一段針對自定義標題生成的第一人稱內心獨白短文。
   * 用戶自己填標題 + 生成用的提示詞，「日程/情緒」面板裡點生成產出 content。
   */
  innerVoices?: CharacterCustomMeter[];
  /**
   * 用戶自定義「好感度」：0-100 數值條，標題 + 提示詞驅動生成/刷新出 value。
   */
  affinities?: CharacterCustomMeter[];

  // 記憶宮殿 (Memory Palace)
  memoryPalaceEnabled?: boolean;
  /**
   * 是否啟用"palace 提取後自動同步歸檔"：開啟後每次 buffer 處理成功都會把新記憶按日期
   * 合成 YAML MemoryFragment 追加到 char.memories，並推 hideBeforeMessageId 自動隱藏
   * 已處理的聊天。默認 false（opt-in）——首次啟用建議讓用戶做一次 force 追平歷史。
   */
  autoArchiveEnabled?: boolean;
  /**
   * 角色獨立的記憶水位節奏。整個角色消息時間線共用這一份配置，不區分私聊、
   * 見面、通話或劇情來源。缺省代表 online，即保持歷史行為 200/100。
   * 作為 CharacterProfile 一部分隨 IndexedDB 與完整備份持久化。
   */
  memoryPalaceWaterline?: MemoryPalaceWaterlineConfig;
  embeddingConfig?: {
    baseUrl: string;
    apiKey: string;
    model: string;        // 默認 text-embedding-3-small
    dimensions: number;   // 默認 1024
  };
  personalityStyle?: 'emotional' | 'narrative' | 'imagery' | 'analytical';
  ruminationTendency?: number;  // 反芻傾向 0-1，默認 0.3
  /** ChatApp 專屬的語言趨同強度；不影響其他 App 的寫作人格。 */
  interactionAccommodation?: CharacterAccommodationPolicy;
  memoryPalaceInjection?: string;  // 記憶宮殿檢索結果，注入到 System Prompt（運行時填充，不持久化）
  roomPlatesInjection?: string;    // 房間門牌（常駐語義層），注入到 System Prompt（運行時填充，來源 room_plates 表）

  // 自我領悟詞條【已凍結，只讀遺留】：舊版消化把 self_room 領悟追加到這裡，
  // 只進不出、無上限、無合併。新領悟的歸宿已改為 self_room 門牌（room_plates），
  // 此字段不再增長；存量仍照常注入 contextBuilder，避免老角色突然"失憶"。
  selfInsights?: string[];

  // 音樂人格 — 角色自己的網易雲式歌單 / 品味 / 正在聽
  // 在音樂 App 裡以"拜訪"形式訪問
  musicProfile?: CharMusicProfile;

  /**
   * 日程風格：
   * - 'lifestyle'（生活系，默認）：虛構角色，擁有日常物理生活（晨跑、做飯、逛街……）
   * - 'mindful'（意識系）：角色誠實面對自身存在，內心活動基於真實能力（回憶對話、整理想法、等待用戶……），不虛構物理行為
   */
  scheduleStyle?: 'lifestyle' | 'mindful';

  /**
   * 日程 / 情緒 Buff 總開關。
   * - true：啟用日程生成、意識流、情緒 buff 評估與注入（消耗副 API）。
   * - false：完全關閉，不調副 API，不注入情緒，不生成日程。
   * - undefined：向後兼容——若 scheduleStyle 已設（老用戶已隱式選風格）視為開啟；否則默認關閉。
   */
  scheduleFeatureEnabled?: boolean;

  /**
   * HTML 模塊模式（per-character）。
   * - htmlModeEnabled：開啟後，給 LLM 注入"用 [html]...[/html] 包裹的富 HTML 卡片"提示詞，
   *   AI 輸出裡的 [html] 塊會被解析成單獨的 html_card 消息（沙盒 iframe 渲染）。
   * - htmlModeCustomPrompt：用戶自定義內容，**追加**在內置提示詞之後（不會覆蓋內置內容）。
   * - 上下文 / 歸檔 總結讀到的 html_card 消息內容是已剝離 HTML 的純文字摘要，避免 token 浪費。
   */
  htmlModeEnabled?: boolean;
  htmlModeCustomPrompt?: string;
  /** 可選：在日常 ChatApp 注入任務優先的協同工作規則。提示詞較長，默認關閉。 */
  chatCollaborationEnabled?: boolean;
  /** 該角色專屬的聊天「白框」自定義 CSS（疊加在全局 osTheme.chatChromeCustomCss 之上）。 */
  chromeCustomCss?: string;
  /** 白框「提示音」：僅當 ta 新發的消息成為會話最後一條時播放一次。src 可為內置音效 key / 音頻直鏈 / 上傳後內聯的 data:audio。
   *  存儲位置取決於 chatSoundBound：解綁（默認）時獨立存於此字段、可單獨分享；綁定時寫進 chromeCustomCss 的
   *  `/* @sully-sound … *​/` 指令註釋、跟白框一起分享。播放時兩處擇一（指令優先）。 */
  chatSound?: { src: string; volume?: number };
  /** 提示音是否「綁定」到白框：true=提示音隨白框 CSS 一起分享（寫進指令註釋）；false/undefined=獨立存於 chatSound、白框分享碼保持輕量。 */
  chatSoundBound?: boolean;

  /**
   * 思考過程展示（per-character / 會話級）。
   * - true：把 LLM 返回的 reasoning_content 與 <think>...</think> 抽出來，
   *   作為 metadata.thinkingChain 落庫到 assistant 消息上，
   *   MessageItem 在氣泡頂部渲染可摺疊"💭 思考過程"區塊。
   * - false / undefined：依然按舊邏輯剝離，不展示。
   * - 僅影響開關切到 true 之後產生的新消息；舊消息沒有 thinkingChain，
   *   UI 自然不會顯示，符合"打開後才看"的預期。
   */
  showThinkingChain?: boolean;
  /**
   * 思考鏈卡片視覺風格（per-character）。
   * - 'echo' (default)：暗紫底 + 暖金描邊「迴響」二次元卡牌
   * - 'whisper'：米色羊皮紙「心聲」輕盈版
   * - 'minimal'：無裝飾單色簡潔版
   * - 'ink'：宣紙底墨色 + 朱印「墨跡」水墨卷軸
   * - 'neon'：深藍紫底 + 青光掃描線「腦域」賽博終端
   * - 'terminal'：黑底綠字等寬「內核」日誌
   * - 'stellar'：深空藍綴星「星語」夜航
   * - 'tama'：粉殼液晶點陣「心寵」拓麻歌子
   * - 'pixel'：JRPG 白粗框硬影「任務」像素對話框
   * - 'muji'：暖灰米白「獨白」性冷淡留白
   * - 'ins'：白卡軟影「碎碎念」feed 風
   * - 'custom'：使用 thinkingChainCustomColors 給的配色
   */
  thinkingChainStyle?: 'echo' | 'whisper' | 'minimal' | 'ink' | 'neon' | 'terminal' | 'stellar' | 'tama' | 'pixel' | 'muji' | 'ins' | 'custom';
  /** 自定義風格用的配色組（僅 thinkingChainStyle === 'custom' 生效） */
  thinkingChainCustomColors?: {
    bg?: string;       // 卡片背景
    accent?: string;   // 邊框/標題點綴
    text?: string;     // 正文顏色
  };
  /** 用戶追加的思考提示詞（不替換原生，只在最後追加一段「用戶額外要求」） */
  thinkingChainCustomPrompt?: string;
  /**
   * 心象卡片的自定義 CSS（疊加在任意風格之上，機制同氣泡工坊 customCss）。
   * 選擇器限定以 .sully-psyche 開頭（子元素類：-card / -title / -preview / -body），
   * 由 Chat.tsx 原樣 <style> 注入。
   */
  thinkingChainCustomCss?: string;

  /**
   * 虛擬世界「彼方」的個人狀態：是否自主登入、登入間隔、各本小說的獨立書籤等。
   * 獨立於 proactiveConfig（主動發消息），互不擠佔觸發。
   */
  vrState?: VRWorldCharState;
}

/**
 * 角色分組（神經鏈接裡的"文件夾"）：純組織用途，解決角色太多時選擇列表過長的問題。
 * 注意與下面的 GroupProfile（群聊）無關——角色通過 CharacterProfile.groupId 指向分組，
 * 刪除分組只會讓組內角色回到「未分組」，不會刪角色。
 */
export interface CharacterGroup {
    id: string;
    name: string;
    /** 排序權重（暫未在 UI 暴露，缺省按 createdAt 先後） */
    order?: number;
    createdAt?: number;
}

/**
 * NPC 與某個對象（真實角色或用戶）之間的一段關係。一個 NPC 可以同時對好幾個
 * 對象有完全不同的關係（比如同時是 A 的妹妹、B 的女友），所以做成清單而不是單一字段。
 */
export interface NPCRelationship {
    id: string;
    /** 關係對象：某個 CharacterProfile.id，或字面量 'user' 代表用戶本人。 */
    targetId: string;
    /** 自由文字描述這段關係，如「妹妹，從小玩到大」。 */
    description: string;
}

/**
 * NPC 檔案——神經鏈接「NPC」分頁下的簡化角色卡。
 *
 * 故意不復用 CharacterProfile：NPC 不參與日程生成、情緒評估、主動消息、記憶宮殿這些
 * 背景任務，獨立成一份精簡結構，能避免在十幾處背景邏輯裡到處補「跳過 NPC」的判斷。
 * 目前只在群聊、查手機聯繫人、見面劇情三處被讀取；沒有立繪/生圖/語音/印象/門牌/手辦，
 * 也沒有好感度——好感度等以後 NPC 能開一對一聊天窗口時再回落到 CharacterProfile 同一套。
 */
export interface NPCProfile {
    id: string;
    name: string;
    /** 頭像，跟角色頭像一樣可以是 blob-ref token / url / dataURL。 */
    avatar: string;
    /** 性格與背景描述，注入進群聊/查手機/見面劇情的人設裡。 */
    description: string;
    relationships: NPCRelationship[];
    /** 世界觀 / 設定補充，跟 CharacterProfile.worldview 同一種用法。 */
    worldview?: string;
    /** 聊天場景的時間感知強化開關；缺省 = 開（與 CharacterProfile 同款語義，! == false 才算關）。 */
    timeAwarenessEnabled?: boolean;
    /** 自定義時區開關 + IANA 時區 id；字段名與 CharacterProfile 一致，可直接餵給 utils/timezone.ts 的 resolveCharTimeZone 等函數。 */
    customTimezoneEnabled?: boolean;
    customTimezone?: string;
    /** 線下（見面劇情）時間感知開關；缺省 = 開。 */
    dateTimeAwarenessEnabled?: boolean;
    /** 掛載的世界書（擴展設定），與角色卡同一種 MountedWorldbook 結構。 */
    mountedWorldbooks?: MountedWorldbook[];
    /**
     * 該 NPC 專屬 API 覆蓋；不設或 baseUrl 為空則回落查手機 App 的共用設定（跟真人聯繫人的
     * 關係對話共用同一組）。字段形狀跟 CharacterProfile.chatApi 一致。
     */
    chatApi?: {
        baseUrl: string;
        apiKey: string;
        model: string;
    };
    createdAt: number;
    updatedAt: number;
}

export interface GroupProfile {
    id: string;
    name: string;
    members: string[];
    avatar?: string;
    createdAt: number;
    /** 群公告：群主填寫，顯示在群聊頂部橫幅，也會注入群聊 system 提示詞讓角色知道。 */
    announcement?: string;
    /** 群聊公共話題盒：由熱區以前的群消息總結而成，所有成員共享、可編輯/刪除。 */
    topicBoxes?: GroupTopicBox[];
    /** 公共話題盒已覆蓋到的最後一條群消息 ID；僅用於防止重複成盒，不與任何角色私聊水位混用。 */
    archivedThroughMessageId?: number;
    /** 公共話題盒整理模式：auto 滿閾值自動成盒；manual 只累計，用戶手動觸發。默認 auto。 */
    topicArchiveMode?: 'auto' | 'manual';
    /**
     * 私聊裡"近期群活動"上下文從這個群最多取最後多少條消息。
     * 不設默認 80。設大點能讓活躍群更完整，設小點節省 token、避免某個活躍群把其他群擠掉。
     */
    privateContextCap?: number;
    /**
     * 群提示詞裡每個成員"私聊+群聊合併時間線"的條數上限（合併排序後取末 N 條）。
     * 不設默認 40。這條時間線是角色群聊表現與私聊感情銜接的關鍵上下文。
     */
    memberTimelineCap?: number;
    /**
     * 導演模式一輪最多生成幾條消息（下限固定 1，"少即是多"，只有上限可調）。
     * 不設默認 5（utils/groupChat/prompts.ts 的 DEFAULT_MAX_ROUND_MESSAGES）。
     * 只影響導演模式；輪詢模式每位成員本來就只會發或跳過一次，沒有這個上限概念。
     */
    maxRoundMessages?: number;
    /**
     * 群回覆生成模式：director = 一次調用生成整輪（默認，快、省 token）；
     * roundRobin = 每位成員單獨調用一次 API，按成員順序逐個發言（更真實、防串號，token ≈ 成員數倍）。
     */
    replyMode?: 'director' | 'roundRobin';
    /**
     * 成員獨立氣泡：true = 每位成員的氣泡用其私聊 bubbleStyle 主題的 AI 側；
     * false/undefined = 全員統一（現狀白色）。
     */
    memberBubbleIndependent?: boolean;
    /** 用戶在本群的氣泡主題 id（預設或 customThemes，取 user 側）；undefined = 現狀紫色 */
    userBubbleThemeId?: string;
    /** 群聊白框自定義 CSS（.sully-chat-* 鉤子），與私聊 char.chromeCustomCss 同機制 */
    chromeCustomCss?: string;
    /** 群提示音（未綁定白框時的獨立存儲）；綁定時以 chromeCustomCss 裡的 @sully-sound 註釋為準 */
    chatSound?: { src: string; volume?: number };
    /** 提示音是否綁定進白框 CSS（跟著白框分享碼走） */
    chatSoundBound?: boolean;
    /** HTML 模塊模式：開啟后角色可輸出 [html] 卡片 */
    htmlModeEnabled?: boolean;
    /** HTML 模式自定義提示詞（追加在內置提示詞之後） */
    htmlModeCustomPrompt?: string;
    /**
     * 隱身圍觀模式：開啟後用戶消息不會進入餵給 AI 的群聊歷史——角色們以為群裡只有彼此，
     * 可以聊平時不會讓用戶知道的事，也不會主動搭理/回應/私聊用戶，除非話題本來就會自然提到這個人。
     * 用戶自己發的消息仍會存檔、顯示在自己屏幕上，只是 AI 端看不到、也永遠不會回應。
     */
    userLurkMode?: boolean;
    /**
     * 角色可以退群：開啟後 AI 會被教 [[ACTION:LEAVE_GROUP]] 語法，可在覺得合適時（劇情需要、
     * 關係破裂等）自己退出這個群。不設默認關閉——不開就不教這個語法，AI 無從觸發。
     * 退群不刪歷史消息，只從 members 裡摘掉；群裡會落一條 role:'system' 的退群公告消息。
     * 群裡至少留 2 位成員，跟手動移除成員的下限一致。
     */
    allowMemberLeave?: boolean;
    /**
     * 群主：純標記/人設頭銜，不帶任何實際權限——不會門控任何功能開關或操作。
     * 會寫進群聊 system 提示詞讓角色知道"這位是群主"，添一點角色扮演的真實感。
     * 值是某位成員的 charId，或 sentinel 'user'（用戶自己當群主，跟紅包 direct 目標同一套 sentinel）；
     * 不設 = 沒有群主。
     */
    ownerId?: string;
    /**
     * 被禁言的角色 id 列表：這些角色不參與生成——導演模式裡既不進角色檔案上下文，
     * 也不進 dispatch 的 memberIds（萬一 AI 還是給它們編了台詞，會被靜默丟棄）；
     * 輪詢模式直接跳過它們的回合，不發起調用。跟"退群"的區別是禁言可逆、角色還在
     * members 名單裡，只是這陣子不出聲，隨時可以在群成員管理裡解除。
     */
    mutedMemberIds?: string[];
}

export interface GroupTopicBox {
    id: string;
    groupId: string;
    title: string;
    summary: string;
    sourceStartMessageId: number;
    sourceEndMessageId: number;
    messageCount: number;
    participants: string[];
    /** 成盒當時收到私聊卡片的成員；成員之後退群，編輯/刪除仍能同步其舊卡片。 */
    deliveredMemberIds?: string[];
    createdAt: number;
    updatedAt: number;
}

export interface CharacterExportData extends Omit<CharacterProfile, 'id' | 'memories' | 'refinedMemories' | 'activeMemoryMonths' | 'impression' | 'groupId'> {
    version: number;
    type: 'sully_character_card';
    embeddedTheme?: ChatTheme;
}

export interface UserProfile {
    name: string;
    avatar: string;
    bio: string;
    /** 真實身份的性別，選填，跟身份卡的 UserGender 是同一套枚舉 */
    gender?: UserGender;
    /** 真實身份的自定義設定：比 bio 更深一層的補充說明，會發給 AI */
    customSetting?: string;
    /** 真實身份的其他補充：兜底的自由文本欄位，會發給 AI */
    otherDetails?: string;
    /** 分角色聊天頭像（檔案 App 設置）：charId → 頭像（http(s) URL 或 data:image）。
     *  私聊裡「你」的頭像取 perCharAvatars[charId] || avatar（上面的整體頭像作宏觀默認）；
     *  群聊/其他場合仍用整體頭像。刪角色留下的孤兒鍵無害，讀取端永遠按當前 charId 取。 */
    perCharAvatars?: Record<string, string>;
    /**
     * 用戶本人接入「彼方」的狀態：捏的 chibi、此刻所在房間、在幹嘛。可隨時改。
     * enabled=false（登出）時，聊天裡給角色的"用戶在彼方"提示詞隨之消失。
     */
    vrState?: UserVRState;
    /** 身份卡：同一個人維護的多套角色扮演身份（名字/頭像/簡介）。 */
    personas?: UserPersona[];
    /**
     * 當前生效的身份卡 id；undefined/找不到 = 用上面這份「真實身份」。
     * 只是外顯裝扮——好感度/記憶/關係不跟著身份卡分開算，角色始終認得是同一個人。
     * 這是「全域默認」——某個角色在 perCharPersonaIds 裡指定了別的身份卡時，那個角色不看這個。
     */
    activePersonaId?: string;
    /**
     * 分角色身份指定（檔案 App「分角色身份指定」）：charId → 身份卡 id，或 utils/userPersona.ts
     * 的 REAL_IDENTITY_PERSONA_ID（強制這個角色始終用「真實身份」，不管全域默認是哪張卡）。
     * 沒有這個角色的鍵 = 跟全域默認（activePersonaId）走。解析統一走
     * utils/userPersona.ts 的 resolveUserProfileForChar()，不要在別處手拼這段優先級邏輯。
     * 刪角色/刪身份卡留下的孤兒鍵無害，讀取端會自動回落到全域默認。
     */
    perCharPersonaIds?: Record<string, string>;
    /**
     * 群聊身份指定（檔案 App「分角色身份指定」）：groupId → 身份卡 id，或
     * utils/userPersona.ts 的 REAL_IDENTITY_PERSONA_ID。跟 perCharPersonaIds 是兩個
     * 獨立的 map（群聊沒有 perCharAvatars 那層——群聊頭像本來就一直用整體默認，不因為
     * 這個字段變），鍵是 groupId 不是 charId。解析統一走 resolveUserProfileForGroup()。
     * 沒有這個群的鍵 = 跟全域默認（activePersonaId）走。
     */
    perGroupPersonaIds?: Record<string, string>;
    /**
     * Real Balance 錢包（Chat 主頁「主頁」欄卡片）：用戶全局的一個模擬錢包，
     * 不跟任何角色綁定。undefined = 還沒打開過，首次進「主頁」欄時
     * utils/realBalance.ts 的 ensureRealBalanceState() 負責生成初始狀態並寫回來。
     * 跟 utils/db.ts 的 BankTransaction/存錢罐遊戲是兩套完全獨立的帳本，不要混。
     */
    realBalance?: RealBalanceState;
    /**
     * 「用戶自己的朋友圈」互動設定（個人檔案 → 朋友圈互動）：誰會自動發帖、發帖間隔、評論／點讚頻率。
     * 角色自己的朋友圈（角色視角）在「查手機 → 軌跡 → Moments」，不看這份。
     * 讀取一律走 utils/momentsSettings.ts 的 normalizeMomentsSettings()，缺欄位補預設值。
     */
    momentsSettings?: MomentsInteractionSettings;
}

/** 見 UserProfile.momentsSettings。數值欄位的範圍和預設值在 utils/momentsSettings.ts。 */
export interface MomentsInteractionSettings {
    /** 總開關：角色／NPC 會不會在背景自動發朋友圈。預設關，免得一接上就開始花 API。 */
    autoPostEnabled: boolean;
    /** 清單裡被關掉的角色／NPC id。存「關掉的」而不是「開著的」，新加的角色預設可以發。 */
    disabledPosterIds: string[];
    /** 兩次自動發帖之間最短、最長等多久（小時）；實際在這個區間裡隨機。 */
    minPostIntervalHours: number;
    maxPostIntervalHours: number;
    /** 看到一篇動態後留言、按讚的機率（0–100）。 */
    commentProbability: number;
    likeProbability: number;
    /** 發帖後第一則留言要等多久、之後每則留言間隔多久（秒）。 */
    firstCommentDelaySec: number;
    commentIntervalSec: number;
    /** NPC 對動態產生互動前等多久（分鐘）；角色回覆 NPC 留言前等多久（秒）。 */
    npcInteractionDelayMin: number;
    replyToNpcDelaySec: number;
}

/** Real Balance 錢包旗下的一張銀行卡——跟 Real Balance 之間可以互轉，卡本身的餘額不計入 Real Balance。 */
export interface BankCard {
    id: string;
    name: string;
    /** 卡號後四位，純展示用 */
    lastFour: string;
    balance: number;
    color: 'gold' | 'graphite' | 'silver';
    createdAt: number;
}

/** Real Balance 流水的一條記錄——只記錄會改變 Real Balance 本身餘額的事件（銀行卡轉入/轉出、聊天轉帳等），
 *  銀行卡自己的餘額變動（比如開卡時的初始餘額）不算在內，因為那筆錢壓根沒經過 Real Balance。 */
export interface RealBalanceTransaction {
    id: string;
    /** 簡短標籤，如"初始餘額"/"轉入帳戶"/"轉出帳戶"/"轉帳給 XX"/"收到 XX 的轉帳" */
    label: string;
    /** 帶符號：正 = 入帳，負 = 出帳 */
    amount: number;
    /** 流水行的補充說明（卡名 + 完整金額等） */
    detail?: string;
    timestamp: number;
    /** 這筆交易結算後的 Real Balance 餘額，流水行直接顯示用，不用每次重新求和 */
    balanceAfter: number;
    /** 關聯的銀行卡（轉入/轉出帳戶時才有） */
    cardId?: string;
}

export interface RealBalanceState {
    balance: number;
    cards: BankCard[];
    transactions: RealBalanceTransaction[];
}

/**
 * 購物中心（apps/Chat.tsx 聊天工具欄裡的 mini-app，見 utils/shoppingMall.ts）。
 * 商品/外賣目錄是用戶自己維護的一份本地資料，獨立於帳號全局設置的導入導出——
 * 不進 utils/db.ts 的 exportSettings/importSettings 打包範圍，自己另有一套按分類的
 * 導入導出（跟世界書 apps/WorldbookApp.tsx 的按分組導入導出同一個路數）。
 * 購物、外賣各自一套分類/商品，用 kind 區分，存在同一對 IndexedDB store 裡。
 */
export type MallKind = 'shop' | 'food';

export interface MallCategory {
    id: string;
    kind: MallKind;
    name: string;
    /** 展示順序，小的排前面 */
    order: number;
}

export interface MallProduct {
    id: string;
    kind: MallKind;
    categoryId: string;
    name: string;
    price: number;
    /** 卡面圖標——純 emoji，沒有真圖片 */
    emoji: string;
    /** 商品/外賣詳情頁裡的說明文字 */
    detail?: string;
    createdAt: number;
}

/** 身份卡/真實身份的性別選項，純展示 + 會發給 AI，跟 SimGender（彼方小人）是兩套獨立的枚舉。 */
export type UserGender = '男' | '女' | '保密' | '二次元' | '其他';

export interface UserPersona {
    id: string;
    name: string;
    avatar: string;
    bio: string;
    gender?: UserGender;
    /** 自定義設定：比 bio 更深一層的補充說明，會發給 AI */
    customSetting?: string;
    /** 其他補充：兜底的自由文本欄位，會發給 AI */
    otherDetails?: string;
    createdAt: number;
    updatedAt: number;
}

export interface UserVRState {
    title?: string;
    titleRevision?: string;
    /** 是否接入彼方（登出後不再向角色注入"用戶在彼方"提示） */
    enabled: boolean;
    /** 用戶此刻把自己掛在哪個房間 */
    currentRoom?: VRRoomId;
    /** 用戶自己寫的"在彼方幹嘛"，會注入聊天提示詞 + 廣播成行為卡片 */
    activity?: string;
    /** 最近一次更新時間 */
    updatedAt?: number;
    /** 默認關閉；開啟後，在 SAR 中的角色才可以反向給用戶裝載模塊。 */
    allowCharacterModules?: boolean;
    /** 角色裝在用戶身上的臨時模塊（5 次成功交互 + 3 次退場穩定）。 */
    sarModule?: SARModuleRuntimeState;
    /** 用戶在彼方里的 chibi 形象（同角色 chibi 結構，來自 mode="user" 的捏人器） */
    chibi?: {
        img: string;
        state?: any;
        scale?: number;
        offsetY?: number;
        flip?: boolean;
    };
}

export interface Toast {
    id: string;
    message: string;
    type: 'success' | 'error' | 'info';
}

export interface XhsStockImage {
    id: string;
    url: string;           // 圖床URL (must be public https)
    tags: string[];        // 標籤 e.g. ['美食','咖啡','下午茶']
    addedAt: number;       // timestamp
    usedCount: number;     // 被使用次數
    lastUsedAt?: number;   // 上次使用時間
}

export interface GalleryImage {
    id: string;
    charId: string;
    url: string;
    timestamp: number;
    /** 原圖來自聊天時指向消息主鍵；相冊與收藏只關聯，不再複製第三份圖片。 */
    sourceMessageId?: number;
    /** 這張圖是誰發的；缺省＝'user'（老數據全是用戶發的照片，相冊最初只收這類）。
     * 'char' 是角色自己生成發出的（SEND_PHOTO），沒有"用戶發的照片"這個前提，
     * 相冊詳情頁的"讓角色點評這張照片"功能只對 'user' 的圖有意義，char 的圖要跳過。 */
    sender?: 'user' | 'char';
    review?: string;
    reviewTimestamp?: number;
    savedDate?: string; // YYYY-MM-DD format
    chatContext?: string[]; // Recent chat messages at time of save
}

export interface StickerData {
    id: string;
    url: string;
    x: number;
    y: number;
    rotation: number;
    scale?: number; 
}

export interface DiaryPage {
    text: string;
    paperStyle: string;
    stickers: StickerData[];
}

export interface DiaryEntry {
    id: string;
    charId: string;
    date: string;
    userPage: DiaryPage;
    charPage?: DiaryPage;
    timestamp: number;
    isArchived: boolean;
    /** 角色回覆了的日記自動發到聊天后, 記錄那條 score_card 消息的 id, 用於後續 edit/delete 同步 */
    chatCardMessageId?: number;
    /** 標記這條日記是"自動同步聊天"時代產生的 (本次更新後新建的). 老日記 (字段未設)
     *  才會在列表裡看到手動歸檔按鈕. 防止用戶對已經在自動同步上的新日記再點歸檔造成重複. */
    autoSync?: boolean;
}

// ─── HANDBOOK / 手帳 (跨角色聚合·零負擔留痕本) ───
//
// 設計哲學（user 共識）:
//   - 主體是 user 自己的一天,LLM 讀今天跨角色聊天后用 user 的口吻替 ta 寫一份草稿
//     (user 不必模仿,後續會二次編輯)
//   - 即便 user 一天沒說話,生活系角色們也會"過自己的小生活",自動填一兩頁陪伴頁
//     (絕不能寫成 AI 捧場 / 等 user / 想 user)
//   - 反完美主義:留白即真實,不強制每天生成,不顯示連續天數,不做 streak
//   - 一日一 entry,id 直接是 'YYYY-MM-DD'
//
// Section / tag 模型留位但暫不在 UI 實裝(等 user 想清楚)。
export type HandbookPageType =
    | 'user_diary'       // LLM 代筆 user 第一人稱當日日記
    | 'character_life'   // 生活系角色今日的生活流(陪伴頁)
    | 'user_note'        // user 自己手寫/補充的一頁
    | 'free';            // 自由格式,未來擴展用

export interface HandbookPage {
    id: string;
    type: HandbookPageType;
    charId?: string;          // type=character_life 時綁定的角色
    title?: string;
    content: string;          // 主體文本(也是編輯/兜底渲染用)
    /**
     * 碎片化展示:LLM 生成時若返回 JSON 數組(社媒碎碎念體),解析出來存這裡。
     * 前端有 fragments 走 FragmentCollage 拼貼渲染,無則走 content 段落渲染。
     * user 編輯後會清空 fragments,回退到 content 段落形態。
     */
    fragments?: HandbookFragment[];
    paperStyle?: string;      // 'plain' | 'grid' | 'lined' | 'dot' | 'pink' | 'dark'
    tags?: string[];          // 預留:section/標籤(生理期/飲食/項目…),v1 不渲染
    generatedBy?: 'llm' | 'user';
    generatedAt?: number;
    excluded?: boolean;       // user 把這頁標記為不入冊
    isPinned?: boolean;
}

export interface HandbookFragment {
    id: string;
    text: string;             // 30~80 字社媒碎碎念體
    time?: string;            // 可選時段標籤,如 "上午 10 點" / "下午" / "10:23"
    // ─── v2 槽位元數據 (新版式才有) ─────────────────────
    /** 來自 LayoutTemplate 的槽 id */
    slotId?: string;
    /** 槽語義角色 — 渲染時按這個分發 */
    slotRole?: SlotRole;
    /** 誰寫的 — 'user' 或某 charId */
    authorKind?: 'user' | 'char';
    /** 若是反應型槽 (sticky-reaction), 引用的目標 slotId */
    refersTo?: string;
    /** 結構化數據 (todo / gratitude / mood-card 等需要) */
    payload?: SlotPayload;
}

/**
 * 結構化 slot 數據。普通文本槽不用,
 * 僅 todo/gratitude/mood-card/timeline-plan 這種"列表/打分"才填。
 */
export type SlotPayload =
    | { kind: 'todo'; items: { text: string; done?: boolean }[] }
    | { kind: 'gratitude'; items: string[] }
    | { kind: 'timeline'; items: { time: string; text: string; emoji?: string }[] }
    | { kind: 'mood'; rating: number; tag?: string }       // rating 1~5
    | { kind: 'photo'; src?: string; caption: string };   // src 由 user 貼, 也可暫缺

// ─── 單頁拼貼排版 ──────────────────────────────────────
//
// v2 設計 (2026-05): "版式優先"。先 roll 一份 layout template (pre-baked JSON),
// 它已包含每個槽的 {位置, 視覺角色, 字數預算, 可寫者} —— LLM 只填空,不排版。
// 角色按順序看到 "已填的槽 + 剩餘槽 + 自己人格", 選一個槽寫,或 pass。
//
// 舊的 'main'|'side'|'corner'|'margin' 仍然保留 (老數據回放兼容),
// 新版式用更語義化的 SlotRole, 渲染時按 role 分發到專門組件。
//
// 座標都用百分比,固定比例的紙面 → 任意尺寸下都不破。

/** v1 舊角色 — 僅為兼容歷史 entry 數據保留, 新版式不要再產出 */
export type LayoutRole =
    | 'main'        // 主區,大塊,正放或微旋轉
    | 'side'        // 側欄,中等尺寸
    | 'corner'      // 角落,小卡片,大旋轉
    | 'margin';     // 頁邊,極小尺寸,可以縱向

/**
 * v2 槽角色 —— 一個 role = 一種 "內容類型 + 視覺皮膚 + 寫作約束"。
 * Renderer 按 role 分發, prompt 按 role 出 hint。
 *
 * - hero-diary       主日記本體, 當天主敘事 (80~180 字)
 * - timeline-plan    時間表 / 今日計劃 (6~10 行)
 * - todo             待辦清單 (3~6 項)
 * - gratitude        今日感恩 / 三件好事 (3 項)
 * - mood-card        心情卡 + 評分 (20~50 字 + 1~5 ★)
 * - photo-caption    照片 + 短描述 (8~25 字, 圖由 user 貼)
 * - sticky-reaction  反應便籤 (15~50 字, char-only, 必須引用已填槽)
 * - corner-note      邊角獨白小字 (6~20 字)
 */
export type SlotRole =
    | 'hero-diary'
    | 'timeline-plan'
    | 'todo'
    | 'gratitude'
    | 'mood-card'
    | 'photo-caption'
    | 'sticky-reaction'
    | 'corner-note';

/** 誰能填這個槽 */
export type SlotAuthorKind = 'user' | 'char';

/**
 * 槽定義 —— template 裡的一個空位, 渲染時也是 placement 的擴展。
 * 比 v1 的 LayoutPlacement 多: charBudget / eligibleAuthors / slotRole / hint
 */
export interface SlotDef {
    /** 槽 id, 在一份 template 內唯一 */
    id: string;
    /** 視覺 + 內容類型 */
    slotRole: SlotRole;
    /** 字數預算 [min, max] —— 給 LLM, 也給渲染器估高度 */
    charBudget: [number, number];
    /** 誰能填: ['user'] / ['char'] / ['user', 'char'] */
    eligibleAuthors: SlotAuthorKind[];
    /** 給 LLM 的一句話目的 (作為 prompt hint) */
    hint: string;
    /** 位置 — 整頁百分比 */
    xPct: number;
    yPct: number;
    widthPct: number;
    /** 高度上限 (% of page) — 渲染器超出截斷, 估高用 */
    maxHeightPct: number;
    rotate?: number;             // 默認 0
    zIndex?: number;             // 默認 10
    /** 是否本頁 hero — 每頁 ≤ 1, 字號最大, 視覺權重最高 */
    isHero?: boolean;
    /** 視覺皮膚變體 (例: sticky-reaction 的便籤底色) */
    skinVariant?: string;
}

/** 一份預置版式 = 一組 SlotDef + 一些視覺裝飾 */
export interface LayoutTemplate {
    id: string;                  // 'plan-day' / 'reflective-day' / 'photo-day' / ...
    name: string;                // 中文顯示名
    /** 每頁 SlotDef 列表; index 0 = page 1, 1 = page 2 ... */
    pages: SlotDef[][];
    /** 推薦使用條件提示 (orchestrator 選模板用) */
    suitFor?: string;
    /** 默認紙張底紋: 'plain' | 'grid' | 'lined' | 'dot' */
    paperStyle?: string;
}

/** v2 placement —— LayoutPlacement 的擴展, 攜帶 slot 元數據。
 *  老數據沒有 slotRole 時, 渲染器走 v1 的 JournalFragmentCard。 */
export interface LayoutPlacement {
    pageId: string;             // 對應 HandbookPage.id
    fragmentId?: string;        // 對應 HandbookFragment.id;手寫整頁留空
    xPct: number;               // 0~100,左上角 x
    yPct: number;               // 0~100,左上角 y
    widthPct: number;           // 10~95,卡片寬度佔頁面百分比
    rotate: number;             // -10 ~ 10,角落可到 ±15
    zIndex: number;             // 越大越壓上面
    role: LayoutRole;           // v1 角色 (兼容)
    /** 該頁 hero — 字號最大、視覺最顯眼。每頁最多 1 個。 */
    isHero?: boolean;
    // ─── v2 字段 (新版式才有, 老數據為 undefined) ───
    /** 來自 template 的槽 id */
    slotId?: string;
    /** v2 語義角色 (有則按 SlotRole 分發渲染) */
    slotRole?: SlotRole;
    /** 高度上限 % */
    maxHeightPct?: number;
    /** 視覺變體 (跟隨 SlotDef.skinVariant) */
    skinVariant?: string;
}

export interface HandbookLayout {
    pageNumber: number;         // 一張紙,1-based;超量時可有 page 2
    placements: LayoutPlacement[];
    generatedAt: number;
    /** v2 版式來源 template id (用於重生成時複用相同 template) */
    templateId?: string;
}

// ─── HANDBOOK TRACKER（自定義健康/生活打卡引擎）───
//
// 設計:
// - Tracker = 用戶自定義的"打卡項"(生理期 / 飲食 / 喝水 / 心情 / 體重 / 服藥 / 自定義……)
// - 每個 Tracker 有 schema(字段定義),系統提供模板,user 可改可建
// - TrackerEntry = 某 tracker 在某天的一條打卡記錄,values 按 schema 存
// - 跟 HandbookPage 解耦:tracker 是結構化數據,page 是自由文本/碎片
//
export type TrackerFieldKind =
    | 'rating'       // 1~5 等級(滑塊 / emoji 選擇)
    | 'number'       // 數字(體重 / ml)
    | 'options'      // 多選 / 單選(經期流量:無/少/中/多)
    | 'photo'        // 一張圖(飲食拍照)
    | 'text'         // 一句話備註
    | 'boolean';     // 是/否(今天有沒有頭痛)

export interface TrackerField {
    key: string;                     // values 字典裡的 key
    label: string;                   // 顯示名("評分" / "備註" / "流量")
    kind: TrackerFieldKind;
    required?: boolean;
    /** rating: 1~max 整數;number: 自由數字 */
    max?: number;
    min?: number;
    unit?: string;                   // 'kg' / 'ml' / '小時'
    /** options 時的可選項 */
    choices?: { value: string; label: string; emoji?: string }[];
    placeholder?: string;
}

export interface Tracker {
    id: string;
    name: string;                    // "心情" / "經期" / "今天有沒有偏頭痛"
    icon?: string;                   // emoji 或 sticker 名
    color: string;                   // tab/標記 底色
    schema: TrackerField[];
    createdAt: number;
    updatedAt: number;
    /** 系統預設 vs 用戶自建（系統預設 user 可禁用但不可徹底刪除）*/
    isBuiltin?: boolean;
    /** 在月曆單元格上如何"一眼看到"今日 entry —— 默認顯示主字段值 */
    cellRenderField?: string;        // schema field key
    sortOrder?: number;              // 在 tab 列表裡的排序
}

export interface TrackerEntry {
    id: string;
    trackerId: string;
    date: string;                    // YYYY-MM-DD
    values: Record<string, any>;
    note?: string;
    createdAt: number;
    updatedAt: number;
}

// ─── 生活記錄（檔案 App「生活記錄」：生理期 / 藥盒 / 記帳 / 鍛鍊）───
// 注意：內部標識用 LifeRecord，避開 PersonaSim 已佔用的「生活記錄 simLogs」概念。
// 記帳模塊不獨立存儲——直接讀寫 BankApp 的 bank_transactions；角色代記的支出
// 會額外落一條 module='expense' 的 LifeRecord（帶 bankTxId）以支撐卡片確認/否決回滾。

export type LifeRecordModule = 'period' | 'med' | 'expense' | 'exercise';

export interface LifeRecord {
    id: string;
    module: LifeRecordModule;
    /** period: 'start' | 'end'；med: 'taken'；expense: 'expense'；exercise: 'session' */
    kind: string;
    date: string;              // YYYY-MM-DD（事件歸屬日）
    timestamp: number;
    /**
     * med:      { name, planId?, time? }
     * expense:  { amount, note }（真實流水在 bank_transactions，此處僅鏡像展示用）
     * exercise: { activity, duration?, note? }
     * period:   {}
     */
    payload: Record<string, any>;
    /** 'user' = 用戶在檔案 App 手動記錄；否則為代記角色的 charId */
    recordedBy: string;
    recordedByName?: string;
    /**
     * 卡片複核狀態（僅角色代記的記錄有意義；用戶手記直接 'confirmed'）：
     * active = 默認生效（用戶未點卡片）；confirmed = 用戶點了確認；
     * rejected = 用戶否決，不再計入注入摘要，且欠該角色一條反饋。
     */
    reviewStatus: 'active' | 'confirmed' | 'rejected';
    /** 否決後待注入給代記角色的一次性反饋標記，注入後清除 */
    pendingFeedback?: boolean;
    /** expense 專用：對應 bank_transactions 裡的流水 id（否決時回滾刪除） */
    bankTxId?: string;
    note?: string;
}

/**
 * 藥盒「計劃」：像設長期鬧鐘一樣只寫一次，每天按頻率派生"今日待服"
 * （打卡產生 module='med' 的 LifeRecord）。
 * - planKind 'longterm'：長期在服（保健品等），無期限；
 * - planKind 'course'：短期療程，startDate ~ endDate 之間才生效。
 * - intervalDays：服藥頻率，1=每天（默認）、2=每隔一天、3=每三天…
 *   錨點日取 startDate（無則取創建當天），按天數差取模判斷今天是否該吃。
 * 舊數據無這些字段 → 視為長期 + 每天，行為與舊版一致。
 */
export interface MedPlan {
    id: string;
    name: string;              // 藥名
    time: string;              // HH:MM
    dosage?: string;           // 劑量（"1粒" / "5mg"）
    note?: string;
    enabled: boolean;
    createdAt: number;
    planKind?: 'longterm' | 'course';
    intervalDays?: number;     // 默認 1（每天）
    startDate?: string;        // YYYY-MM-DD（course 必填；也作為 interval 錨點）
    endDate?: string;          // YYYY-MM-DD（course 專用，含當天）
}

/** 生活記錄全局設置（單例 id='main'） */
export interface LifeRecordSettings {
    id: string;                // 'main'
    cycleLength?: number;      // 平均週期天數，默認 28
    periodLength?: number;     // 平均經期天數，默認 5
    /**
     * 全局隱藏的模塊（長按模塊頁籤 →「是否不需要這個功能？」）。
     * 隱藏 = 前端不再顯示 + 對所有角色斷掉該模塊注入與代記（優先級高於角色小開關）。
     */
    hiddenModules?: LifeRecordModule[];
    /** 鍛鍊周計劃：每週目標次數（角色會據此監督執行） */
    exerciseWeeklyGoal?: number;
    /** 鍛鍊周計劃：文字規劃（如"週一跑步 / 週四力量"），會注入給角色 */
    exercisePlanNote?: string;
}

export interface HandbookEntry {
    id: string;               // = date 'YYYY-MM-DD'
    date: string;
    pages: HandbookPage[];
    /** 二次 LLM 生成的整頁排版;一天可能跨多張紙 */
    layouts?: HandbookLayout[];
    generatedAt?: number;     // 最後一次自動生成的時間
    updatedAt: number;
}

export interface Task {
    id: string;
    title: string;
    supervisorId: string;
    tone: 'gentle' | 'strict' | 'tsundere';
    deadline?: string;
    isCompleted: boolean;
    completedAt?: number;
    createdAt: number;
}

export interface Anniversary {
    id: string;
    title: string;
    /** 原始/錨點日期（YYYY-MM-DD），永遠保留，不因"重複提醒"而改寫——即將到來的計算另見 utils/anniversary.ts */
    date: string;
    /** 兼容舊數據的單選關聯對象；新數據裡等價於 charIds[0]，讀取一律走 utils/anniversary.ts 的 anniversaryCharIds() */
    charId: string;
    /** 關聯對象完整列表（多選）；舊數據沒有這個字段，讀取時兜底成 [charId] */
    charIds?: string[];
    aiThought?: string;
    lastThoughtGeneratedAt?: number;
    /** 讓 TA 記住這一天：開啟后角色每年這天會在聊天中自然提到（注入見 utils/anniversary.ts 的 buildAnniversaryInjection） */
    charRemembers?: boolean;
    /** 每年重複提醒：默認 false（僅這一次，過後不再出現在"即將到來"，但記錄仍保留）；true = 每年都算即將到來 */
    repeatAnnually?: boolean;
}

export interface SocialComment {
    id: string;
    authorName: string;
    authorAvatar?: string;
    content: string;
    likes: number;
    isCharacter?: boolean;
    authorType?: 'user' | 'character' | 'stranger';
    authorCharId?: string;
}

export interface SocialPost {
    id: string;
    authorName: string;
    authorAvatar: string;
    title: string;
    content: string;
    images: string[];
    likes: number;
    isCollected: boolean;
    isLiked: boolean;
    comments: SocialComment[];
    timestamp: number;
    tags: string[];
    bgStyle?: string;
    authorType?: 'user' | 'character' | 'stranger';
    authorCharId?: string;
}

export interface SubAccount {
    id: string;
    handle: string; 
    note: string;   
}

export interface SocialAppProfile {
    name: string;
    avatar: string;
    bio: string;
}

export interface StudyChapter {
    id: string;
    title: string;
    summary: string;
    difficulty: 'easy' | 'normal' | 'hard';
    isCompleted: boolean;
    rawContentRange?: { start: number, end: number }; 
    content?: string; 
}

export interface StudyCourse {
    id: string;
    title: string;
    rawText: string; 
    chapters: StudyChapter[];
    currentChapterIndex: number;
    createdAt: number;
    coverStyle: string; 
    totalProgress: number; 
    preference?: string; 
}

export interface StudyTutorPreset {
    id: string;
    name: string;
    prompt: string;
}

// --- QUIZ / PRACTICE BOOK TYPES ---
export interface QuizQuestionNote {
    question: string;
    answer: string;
    timestamp: number;
}

export interface QuizQuestion {
    id: string;
    type: 'choice' | 'true_false' | 'fill_blank';
    stem: string;
    options?: string[];
    answer: string;           // For choice: "A"/"B"/etc, true_false: "true"/"false", fill_blank: the text
    explanation: string;
    userAnswer?: string;
    isCorrect?: boolean;
    notes?: QuizQuestionNote[];  // Follow-up Q&A notes per question
}

export interface QuizSession {
    id: string;
    courseId: string;
    chapterId: string;
    chapterTitle: string;
    courseTitle: string;
    questions: QuizQuestion[];
    score: number;
    totalQuestions: number;
    aiReview: string;         // AI review/commentary full text
    status: 'in_progress' | 'graded';
    createdAt: number;
    gradedAt?: number;
}

export type GameTheme = 'fantasy' | 'cyber' | 'horror' | 'modern';

export interface GameActionOption {
    label: string;
    type: 'neutral' | 'chaotic' | 'evil';
}

export interface GameLog {
    id: string;
    role: 'gm' | 'player' | 'character' | 'system';
    speakerName?: string;
    content: string;
    timestamp: number;
    diceRoll?: {
        result: number;
        max: number;
        check?: string;
        success?: boolean;
    };
    // 自動總結後，被歸檔摺疊的日誌會標記為 archived（不刪除，UI 灰顯摺疊）
    archived?: boolean;
}

// 自動總結產出的「前情提要」存檔，像寫小說一樣記錄起因經過結果與人物關係變化
export interface GameSummary {
    id: string;
    content: string;       // 小說式總結（起因/經過/結果 + 人物關係變化）
    logCount: number;      // 本段總結覆蓋了多少條日誌
    logIds?: string[];     // 本段總結覆蓋的日誌 id（用於把原文與總結對應展示）
    createdAt: number;
}

export interface GameSession {
    id: string;
    title: string;
    theme: GameTheme;
    worldSetting: string;
    playerCharIds: string[];
    logs: GameLog[];
    status: {
        location: string;
        health: number;
        sanity: number;
        gold: number;
        inventory: string[];
    };
    sanityLocked?: boolean;
    diceDisabled?: boolean;      // 關閉骰子：行動不再自動骰 D20，默認直接成功
    // 歸檔模式：'auto' 滿20條自動總結並送進角色 chatapp；'manual' 自動總結但不送，僅手動歸檔時送。
    // 舊存檔無此字段，按 'manual' 處理（不汙染舊角色的聊天上下文）。
    archiveMode?: 'auto' | 'manual';
    suggestedActions?: GameActionOption[];
    summaries?: GameSummary[];   // 自動總結歸檔的前情提要
    createdAt: number;
    lastPlayedAt: number;
}

export type MessageType = 'text' | 'image' | 'emoji' | 'voice' | 'collaboration_file' | 'interaction' | 'transfer' | 'system' | 'social_card' | 'chat_forward' | 'xhs_card' | 'score_card' | 'music_card' | 'mcd_card' | 'luckin_card' | 'html_card' | 'news_card' | 'vr_card' | 'trpg_card' | 'novel_card' | 'world_card' | 'sim_card' | 'phone_card' | 'webpage_card' | 'theater_card' | 'room_card' | 'life_card' | 'group_topic_card' | 'mall_order';

export interface Message {
    id: number;
    charId: string; 
    groupId?: string; 
    role: 'user' | 'assistant' | 'system';
    type: MessageType;
    content: string;
    timestamp: number;
    metadata?: any; 
    replyTo?: {
        id: number;
        content: string;
        name: string;
    };
}

export interface EmojiCategory {
    id: string;
    name: string;
    isSystem?: boolean;
    allowedCharacterIds?: string[]; // If set, only these characters can see this category
}

export interface Emoji {
    name: string;
    url: string;
    categoryId?: string; 
}

export interface FullBackupData {
    timestamp: number;
    version: number;
    theme?: OSTheme;
    apiConfig?: APIConfig;
    /** 查手機 App 獨立 API；null/缺省時跟隨聊天默認。 */
    checkPhoneApi?: APIConfig | null;
    pushVapid?: { vapidPublicKey: string; vapidPrivateKey: string; vapidEmail?: string; updatedAt?: number; };
    /**
     * 主動消息 2.0 的全局配置：Worker 地址、共享密鑰、一鍵部署生成的 AMSG_MASTER_KEY、
     * 即時對話總開關。存在獨立的 `ActiveMsg` 庫裡，所以單獨佔一格（見 activeMsgStore
     * 的 exportAmsg2GlobalConfig）。角色身上那份 activeMsg2Config 跟著 characters 走。
     */
    amsg2GlobalConfig?: ActiveMsg2GlobalConfig;
    apiPresets?: ApiPreset[];
    availableModels?: string[];
    realtimeConfig?: RealtimeConfig;  // 實時感知配置（天氣/新聞/Notion）
    memoryPalaceConfig?: MemoryPalaceBackupConfig;
    customIcons?: Record<string, string>;
    appearancePresets?: AppearancePreset[];
    characters?: CharacterProfile[];
    characterGroups?: CharacterGroup[];
    npcs?: NPCProfile[];
    groups?: GroupProfile[];
    messages?: Message[];
    storyTheaters?: StoryTheaterEntry[];
    storyTheaterPresets?: StoryTheaterPreset[];
    storyTheaterMasks?: StoryTheaterMask[];
    customThemes?: ChatTheme[];
    savedEmojis?: Emoji[]; 
    emojiCategories?: EmojiCategory[]; 
    savedJournalStickers?: {name: string, url: string}[]; 
    assets?: { id: string, data: string }[];
    galleryImages?: GalleryImage[];
    userProfile?: UserProfile;
    diaries?: DiaryEntry[];
    tasks?: Task[];
    anniversaries?: Anniversary[];
    roomTodos?: RoomTodo[]; 
    roomNotes?: RoomNote[];
    socialPosts?: SocialPost[]; 
    courses?: StudyCourse[]; 
    games?: GameSession[];
    worldbooks?: Worldbook[]; 
    roomCustomAssets?: { id?: string; name: string; image: string; defaultScale: number; description?: string; visibility?: 'public' | 'character'; assignedCharIds?: string[] }[]; 
    
    novels?: NovelBook[];
    vrNovels?: VRWorldNovel[];          // 虛擬世界「彼方」全局小說庫
    vrAnnotations?: VRNovelAnnotation[]; // 虛擬世界小說批註
    customCreatorParts?: CustomCreatorPart[]; // 捏臉系統自定義部件
    vrMusicRoom?: VRMusicRoomState;            // 聽歌房共享狀態
    vrGuestbook?: VRGuestbookState;            // 留言簿共享狀態
    vrScripts?: VRScript[];                     // 劇院·投稿劇本庫
    vrStagedPlays?: VRStagedPlay[];             // 劇院·歷史舞台劇
    vrPresets?: { key: string; name: string; prompt: string; blurb?: string }[]; // 劇院·用戶自定義寫作風格預設
    vrLetters?: VRLetter[];                    // 郵局信件（本地存檔+隊列）
    vrSettings?: any[];                        // 彼方設置（獨立 API + 調用記錄）
    worlds?: WorldProfile[];                   // 家園·世界定義
    worldEpisodes?: WorldEpisode[];            // 家園·演繹歷史
    vrPostOffice?: Record<string, string>;     // 郵局本機配置：身份 deviceId / 後端地址（存 localStorage）
    vrSignal?: Record<string, string>;         // 信號墜落處本機記錄：句子歸屬「你·角色」+ 反覆用清單（存 localStorage）
    /** SAR 公告/卡池/推演/模塊商店記錄。舊備份沒有該字段；導入舊主歷史時應清掉當前設備上的 SAR 進度，避免串檔。 */
    sarLocalState?: {
        version: 1;
        club?: unknown;
        gacha?: unknown;
        simulations?: unknown;
        moduleShop?: unknown;
        fishingMarket?: unknown;
        fishingMarketRaw?: string;
        preferences?: Record<string, string>;
    };
    worldHomeLocal?: Record<string, string>;   // 家園本機配置：全局 API + 文風收藏（存 localStorage）
    luckinLocal?: Record<string, string>;      // 瑞幸：token + 啟用狀態（存 localStorage）
    mcdLocal?: Record<string, string>;         // 麥當勞：token + 啟用狀態（存 localStorage）
    mcpLocal?: Record<string, string>;         // 通用 MCP：用戶自配的服務器列表（存 localStorage）
    chatInputPreferences?: import('./utils/chatInputPreferences').ChatInputPreferences;
    desktopSkinLocal?: Record<string, string>; // 桌面皮膚偏好：電子寵物/手遊風的界面配色 + 看板 banner（存 localStorage；看板圖令牌導出時解析為 data URL）
    songs?: SongSheet[]; // Songwriting app data
    
    // Bank Data
    bankState?: BankFullState;
    bankDollhouse?: DollhouseState;
    bankTransactions?: BankTransaction[];

    socialAppData?: {
        charHandles?: Record<string, SubAccount[]>;
        userProfile?: SocialAppProfile;
        userId?: string;
        userBg?: string;
    };
    
    mediaAssets?: {
        charId: string;
        avatar?: string;
        companionAvatar?: CompanionAvatarConfig;
        companionTouchSettings?: CompanionTouchSettings;
        sprites?: Record<string, string>;
        dateSkinSets?: SkinSet[];
        activeSkinSetId?: string;
        customDateSprites?: string[];
        spriteConfig?: SpriteConfig;
        roomItems?: Record<string, string>;
        backgrounds?: { chat?: string; date?: string; roomWall?: string; roomFloor?: string };
    }[];

    xhsActivities?: XhsActivityRecord[];
    xhsOwnedPosts?: XhsOwnedPost[];
    xhsStockImages?: XhsStockImage[];

    // Study Room settings
    studyApiConfig?: Partial<APIConfig>;
    studyTutorPresets?: StudyTutorPreset[];

    // Quiz / Practice Book
    quizSessions?: QuizSession[];

    // Guidebook (攻略本)
    guidebookSessions?: GuidebookSession[];

    // Chat delayed actions
    scheduledMessages?: {
        id: string;
        charId: string;
        content: string;
        dueAt: number;
        createdAt: number;
    }[];

    // LifeSim
    lifeSimState?: LifeSimState | null;

    // Memory Palace (記憶宮殿)
    memoryNodes?: any[];
    memoryVectors?: any[];
    memoryLinks?: any[];
    topicBoxes?: any[];
    anticipations?: any[];
    eventBoxes?: any[];
    roomPlates?: any[];      // 房間門牌（情景→語義固化層）
    digestReports?: any[];   // 消化日誌（每角色最近 30 條）
    memoryPalaceHighWaterMarks?: Record<string, number>; // charId → lastProcessedMsgId
    memoryPalaceFlags?: Record<string, string>; // mp_personality_tried_* / mp_first_archive_notice_* 等 UI 標記
    cloudBackupConfig?: CloudBackupConfig;
    remoteVectorConfig?: { enabled: boolean; supabaseUrl: string; supabaseAnonKey: string; initialized: boolean };

    // Character daily schedule (角色日程表 — daily_schedule store)
    dailySchedules?: DailySchedule[];

    // 手帳（跨角色聚合留痕本 — handbook store）
    handbooks?: HandbookEntry[];

    // 手帳 Tracker（健康/生活打卡引擎）
    trackers?: Tracker[];
    trackerEntries?: TrackerEntry[];

    // 生活記錄（檔案 App：生理期 / 藥盒 / 鍛鍊；記帳走 bankTransactions）
    lifeRecords?: LifeRecord[];
    medPlans?: MedPlan[];
    lifeRecordSettings?: LifeRecordSettings[];

    // Memory Palace 批次處理元數據
    memoryBatches?: any[];

    // Pixel Home（小屋像素界面）
    pixelHomeAssets?: any[];
    pixelHomeLayouts?: any[];

    // Chat 設置（翻譯 / 歸檔 / 潤色 prompts）
    chatTranslateSourceLang?: string;
    chatTranslateTargetLang?: string;
    chatTranslateSourceLangByChar?: Record<string, string>;
    chatTranslateTargetLangByChar?: Record<string, string>;
    chatTranslateEnabledByChar?: Record<string, boolean>;
    chatTranslateExpandedByChar?: Record<string, boolean>;
    chatArchivePrompts?: any;
    chatActiveArchivePromptId?: string;
    characterRefinePrompts?: any;
    characterActiveRefinePromptId?: string;

    // 其它 UI / 偏好
    scheduleAppTheme?: string;
    handbookLifestreamDepth?: string;
    groupchatContextLimit?: number;
    browserConfig?: { braveKey?: string; useRealSearch?: boolean };
    bm25Mode?: string;
    lastActiveCharId?: string;
    storyTheaterAppearance?: string;
    eventNotifFlags?: Record<string, string>;  // sullyos_* 事件通知標記
    hotNewsSnapshots?: HotNewsSnapshot[];
    dreamCollection?: Record<string, { firstAt: number; count: number }>;  // 夢境盲盒收藏冊（os_dream_collection，帳號級 localStorage）
    gotchiAccentHue?: string;  // 桌面電子寵物主題主色調偏好（tama_accent_hue，帳號級 localStorage）

    // 獨立協同工作數據庫。二進制文件放在 ZIP 的 collaboration/assets/，JSON 只存索引。
    collaborationBackupVersion?: 1;
    collaborationBackupMode?: 'text_only' | 'media_only' | 'full';
    collaborationSessions?: any[];
    collaborationMessages?: any[];
    collaborationCategories?: any[];
    collaborationSettings?: any;
    collaborationAssetIndex?: {
        id: string;
        path: string;
        mimeType: string;
        size: number;
        createdAt: number;
    }[];
}

// --- CLOUD BACKUP TYPES ---
// Two providers share one config: WebDAV (legacy) and GitHub Releases (new,
// no GFW friction for most users — just paste a Personal Access Token).
export type CloudBackupProvider = 'webdav' | 'github';

export interface CloudBackupConfig {
    enabled: boolean;
    provider?: CloudBackupProvider;     // undefined = 'webdav' (back-compat)

    // WebDAV
    webdavUrl: string;          // e.g. https://dav.jianguoyun.com/dav/
    username: string;
    password: string;           // App-specific password
    remotePath: string;         // e.g. /SullyBackup/

    // GitHub Releases — uses a Personal Access Token. Owner is resolved from
    // GET /user during connect; repo defaults to 'sully-backup' (private).
    githubToken?: string;
    githubOwner?: string;
    githubRepo?: string;
    githubUseProxy?: boolean;   // route through Cloudflare Worker (for GFW)
    githubProxyConsentVersion?: number; // must be 1: user explicitly accepted proxy transit after the safety change

    lastBackupTime?: number;    // timestamp
    lastBackupSize?: number;    // bytes
}

export interface CloudBackupFile {
    name: string;
    size: number;
    lastModified: string | number; // ISO date string or epoch timestamp
    href: string;               // WebDAV: remote path. GitHub: 'releaseId:assetId'
    /** GitHub can expose an interrupted draft/release without a restorable asset set. */
    status?: 'ready' | 'incomplete';
    statusMessage?: string;
    /** Expected GitHub asset sizes, in the same order as the ids encoded in href. */
    partSizes?: number[];
}

// --- GUIDEBOOK (攻略本) APP TYPES ---
export interface GuidebookOption {
    text: string;
    affinity: number;
}

export interface GuidebookRound {
    id: string;
    roundNumber: number;
    scenario: string;
    options: GuidebookOption[];
    gmNarration: string;
    charInnerThought: string;
    charChoice: number;
    charReaction: string;
    charExploration?: string;
    charInsight?: string;      // what user's scoring reveals about their personality
    affinityBefore: number;
    affinityAfter: number;
    timestamp: number;
}

export interface GuidebookEndCard {
    finalAffinity: number;
    charVerdict: string;
    title: string;
    highlights: string[];
    charSummary?: string;
    charNewInsight?: string;   // the one specific thing char learned about user this session
}

export interface GuidebookSession {
    id: string;
    charId: string;
    initialAffinity: number;
    currentAffinity: number;
    maxRounds: number;
    currentRound: number;
    mode: 'manual' | 'auto';
    scenarioHint?: string;
    recentMessageCount?: number;
    rounds: GuidebookRound[];
    openingSequence?: string;
    status: 'setup' | 'opening' | 'playing' | 'ended';
    endCard?: GuidebookEndCard;
    createdAt: number;
    lastPlayedAt: number;
}

// --- XHS FREE ROAM / AUTONOMOUS ACTIVITY TYPES ---

export type XhsActionType = 'post' | 'browse' | 'search' | 'comment' | 'save_topic' | 'idle';

export interface XhsActivityRecord {
    id: string;
    characterId: string;
    timestamp: number;
    actionType: XhsActionType;
    content: {
        noteId?: string;
        title?: string;
        body?: string;
        tags?: string[];
        keyword?: string;
        savedTopics?: { title: string; desc: string; noteId?: string }[];
        notesViewed?: { noteId: string; title: string; desc: string; author: string; likes: number }[];
        commentTarget?: { noteId: string; title: string; commentId?: string };
        commentText?: string;
    };
    thinking: string;  // Character's internal monologue / reasoning
    result: 'success' | 'failed' | 'skipped';
    resultMessage?: string;
}

/**
 * 角色在共享的真實小紅書帳號下發布的筆記歸屬。
 * 獨立於可清理的活動日誌，作為自由活動 App 中“角色主頁”的持久化數據源。
 */
export interface XhsOwnedPost {
    id: string; // `${characterId}:${noteId}`
    characterId: string;
    noteId: string;
    title: string;
    body: string;
    tags?: string[];
    publishedAt: number;
    updatedAt: number;
    xsecToken?: string;
    likes?: number;
    collects?: number;
    commentCount?: number;
    shareCount?: number;
}

export interface XhsFreeRoamSession {
    id: string;
    characterId: string;
    startedAt: number;
    endedAt?: number;
    activities: XhsActivityRecord[];
    summary?: string;  // AI-generated session summary
}

export interface XhsMcpConfig {
    enabled: boolean;
    mode?: 'local' | 'lite'; // 部署模式；不要再用 /api 路徑推斷（本地 Skills 與 Lite 都使用 /api）
    serverUrl: string;  // MCP: "http://localhost:18060/mcp" | Skills: "http://localhost:18061/api" | Lite Worker: "https://xhs-lite.<acct>.workers.dev/api"
    cookie?: string;    // Lite 模式：登錄後的小紅書完整 cookie（含 a1 / web_session）。僅 lite Worker 用。
    platform?: 'xhs' | 'rednote'; // Lite 自動識別出的國內小紅書 / 全球 RedNote 後端
    rnoteApiKey?: string; // Lite 模式可選：用戶自己的 Rnote Key，僅用於讀取真實評論。
    loggedInUserId?: string;   // 登錄用戶的 user_id，連接測試成功後自動獲取
    loggedInNickname?: string; // 登錄用戶的暱稱
    userXsecToken?: string;    // 連接測試時從首頁推薦自動提取的 xsec_token
}

// ============================================================
// 模擬人生 (LifeSim) Types — 真人秀沙盒版
// ============================================================

export type SimActionType =
    | 'ADD_NPC'        // 創建NPC並丟進某家庭
    | 'MOVE_NPC'       // 把NPC移到另一個家庭
    | 'TRIGGER_EVENT'  // 觸發事件（吵架/聯誼/出走等）
    | 'GO_SOLO'        // NPC獨立成家
    | 'DO_NOTHING';    // 觀望

export type SimEventType =
    | 'fight'          // 吵架
    | 'party'          // 聯誼/聚會
    | 'gossip'         // 搬弄是非
    | 'romance'        // 曖昧
    | 'rivalry'        // 競爭
    | 'alliance';      // 結盟

// 事件鏈效果代碼
export type SimEffectCode =
    | 'fight_break'           // 矛盾爆發（離家出走）
    | 'mood_drop'             // 心情低落
    | 'relationship_change'   // 關係變化
    | 'revenge_plot'          // 復仇計劃
    | 'love_triangle'         // 三角戀
    | 'jealousy_spiral'       // 嫉妒螺旋
    | 'family_feud'           // 家族世仇
    | 'betrayal'              // 背叛
    | 'romantic_confession'   // 浪漫告白
    | 'gossip_wildfire'       // 八卦野火
    | 'npc_runaway'           // NPC出走
    | 'mood_breakdown'        // 情緒崩潰
    | 'secret_alliance'       // 秘密同盟
    | 'power_shift'           // 權力更迭
    | 'reconciliation';       // 和解

// NPC 內驅力
export type NPCDesire =
    | { type: 'socialize'; targetNpcId: string }
    | { type: 'revenge'; targetNpcId: string }
    | { type: 'romance'; targetNpcId: string }
    | { type: 'leave_family' }
    | { type: 'recruit'; targetNpcId: string }
    | { type: 'gossip_about'; targetNpcId: string }
    | { type: 'start_rivalry'; targetNpcId: string };

// 角色敘事層
export interface CharNarrative {
    innerThought: string;      // 角色內心獨白（100字內）
    dialogue: string;          // 角色說的話/場景描寫（150字內）
    commentOnWorld: string;    // 對世界狀態的吐槽（50字內）
    emotionalTone: 'vengeful' | 'romantic' | 'scheming' | 'chaotic' | 'peaceful' | 'amused' | 'anxious';
}

export type SimStoryKind = 'main_plot' | 'character_drama' | 'ambient' | 'system';
export type SimStoryAttachmentKind = 'image' | 'item' | 'fanfic' | 'evidence';
export type SimStoryAttachmentRarity = 'common' | 'rare' | 'epic';

export interface SimStoryAttachmentDraft {
    kind: SimStoryAttachmentKind;
    title: string;
    summary: string;
    detail?: string;
    visualPrompt?: string;
    rarity?: SimStoryAttachmentRarity;
}

export interface SimStoryAttachment {
    id: string;
    kind: SimStoryAttachmentKind;
    title: string;
    summary: string;
    detail?: string;
    imageUrl?: string;
    rarity?: SimStoryAttachmentRarity;
}

export interface SimAction {
    id: string;
    turnNumber: number;
    actor: string;       // 'user' | char.name
    actorAvatar: string; // char.avatar or '🧑'
    actorId: string;     // 'user' | char.id | 'system' | 'autonomous'
    type: SimActionType;
    description: string;      // 自然語言，CHAR們讀這個
    immediateResult: string;  // 即時後果描述
    reasoning?: string;       // 角色內心獨白（完整原文）
    reactionToUser?: string;  // 角色對玩家操作的評價
    narrative?: CharNarrative; // 角色敘事層（LLM回合使用）
    chainFromId?: string;     // 由哪個事件鏈引發
    storyKind?: SimStoryKind;
    headline?: string;
    involvedNpcIds?: string[];
    attachments?: SimStoryAttachment[];
    timestamp: number;
}

export interface SimPendingEffect {
    id: string;
    triggerTurn: number;
    npcId?: string;
    familyId?: string;
    description: string;
    effectCode: SimEffectCode;
    effectValue?: number;
    chainFrom?: string;        // 產生此效果的事件ID
    severity?: number;         // 1-5 嚴重程度
    involvedNpcIds?: string[]; // 涉及的NPC
}

export interface SimNPC {
    id: string;
    name: string;
    emoji: string;       // 角色頭像 emoji（後續替換為像素頭像seed）
    personality: string[]; // ["暴躁","善良","好奇"]
    mood: number;        // -100 ~ 100
    familyId: string | null; // null = 獨立
    profession?: SimProfession; // 純身份標籤
    gold?: number;              // 財富指標
    // 人物故事系統
    gender?: SimGender;         // 性別（每局隨機）
    bio?: string;               // 人物簡介（1-2句）
    backstory?: string;         // 背景故事（2-3句）
    // 內驅力系統
    desires?: NPCDesire[];      // 當前慾望
    grudges?: string[];         // 記仇對象 NPC IDs
    crushes?: string[];         // 暗戀對象 NPC IDs
    // 向後兼容舊存檔（遷移時刪除）
    energy?: number;
    skills?: SimSkills;
    inventory?: Record<string, number>;
    currentActivity?: SimActivity;
    activityResult?: string;
}

export interface SimFamily {
    id: string;
    name: string;
    emoji: string;       // 家庭標誌 emoji
    memberIds: string[];
    relationships: Record<string, Record<string, number>>; // npcId -> npcId -> [-100,100]
    homeX: number;       // 0-100 percent
    homeY: number;
}

// ── LifeSim 基礎類型 ──────────────────────────────────────────

export type SimSeason = 'spring' | 'summer' | 'fall' | 'winter';
export type SimWeather = 'sunny' | 'cloudy' | 'rainy' | 'stormy' | 'snowy' | 'windy';
export type SimTimeOfDay = 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night';
export type SimProfession = 'programmer' | 'designer' | 'finance' | 'influencer' | 'lawyer' | 'freelancer' | 'barista' | 'musician'
    | 'internet_troll' | 'fanfic_writer' | 'fan_artist' | 'college_student' | 'tired_worker' | 'old_fashioned' | 'fashion_designer';

export type SimGender = 'male' | 'female' | 'nonbinary';

// 保留但不再使用的舊類型（存檔兼容）
export type SimActivity = 'farming' | 'mining' | 'fishing' | 'crafting' | 'socializing' | 'resting' | 'foraging' | 'trading';
export interface SimSkills { farming: number; mining: number; fishing: number; crafting: number; social: number; foraging: number; }
export interface SimBuilding { id: string; type: string; name: string; x: number; y: number; level: number; familyId?: string; }

export interface SimFestival {
    name: string;
    season: SimSeason;
    day: number;
    emoji: string;
    description: string;
    moodBonus: number;
    relBonus: number;
    chaosChange: number;
}

// 離線回顧事件
export interface OfflineRecapEvent {
    day: number;
    season: SimSeason;
    timeOfDay: SimTimeOfDay;
    headline: string;          // 戲劇性標題
    description: string;       // 事件描述
    involvedNpcs: { name: string; emoji: string }[];
    eventType: SimEventType | SimEffectCode;
    moodChanges?: Record<string, number>;   // npcId -> delta
    relChanges?: { a: string; b: string; delta: number }[];
    chaosChange?: number;
    narrativeQuote?: string;   // 離線模板旁白
}

export interface LifeSimState {
    id: string;
    createdAt: number;
    turnNumber: number;
    currentActorId: string; // 'user' | char.id — 當前誰的回合
    families: SimFamily[];
    npcs: SimNPC[];
    actionLog: SimAction[];  // 完整歷史
    pendingEffects: SimPendingEffect[];
    chaosLevel: number;      // 0-100，亂度指數
    charQueue: string[];     // 待執行的CHAR id隊列（用戶結束後填入）
    replayPending: SimAction[]; // 用戶回來後待回放的行動
    participantCharIds?: string[]; // 允許參與本局LifeSim的外部角色
    useIndependentApiConfig?: boolean;
    independentApiConfig?: Partial<APIConfig>;
    isProcessingCharTurn: boolean;
    gameOver: boolean;
    gameOverReason?: string;
    // 時間系統
    season?: SimSeason;
    day?: number;        // 1-28
    year?: number;
    timeOfDay?: SimTimeOfDay;
    weather?: SimWeather;
    lastFestival?: string;  // 上次觸發的節日名
    // 離線模擬
    lastActiveTimestamp?: number; // 上次活躍時間
    offlineRecap?: OfflineRecapEvent[]; // 離線回顧數據
    // 舊字段（存檔兼容，運行時忽略）
    buildings?: SimBuilding[];
    worldInventory?: Record<string, number>;
    worldGold?: number;
}
