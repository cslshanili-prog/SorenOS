import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReplySnapshotContent } from './applyAssistantPostProcessing';
import { isBlobRef } from './blobRef';

// 角色回覆裡帶 [[QUOTE: ...]] 時，會把「被引用的那條」的內容快照寫進 replyTo.content。
//
// 這裡原來是無腦截前 10 個字。圖片改存 `blobref:<id>` 令牌之後，這 10 個字**正好**是
// `blobref:b_` —— 令牌前綴加上 SDK 生成 id 的第一個字符。
//
// messages 表是 Blob 孤兒清理的引用面（utils/blobGc.ts 把每條消息 JSON.stringify 後
// 交給 SDK 掃）。SDK 從這半截前綴提取出來的短 id 是它生成的**每一個** id 的公共前綴，
// 於是它的邊界歧義安全閥判定「引用面像是被截斷過，不安全」→ 整庫豁免，一個 Blob 都不刪，
// 而且不報任何錯（宿主唯一能察覺的信號是 runGc 返回值裡的 keptBoundary）。
//
// 也就是說：一條引用回覆落到圖片消息上，就能把整個孤兒清理靜默關掉。

const BLOB_TOKEN = 'blobref:b_0123456789abcdef';
const DATA_URL = 'data:image/png;base64,' + 'A'.repeat(400);
const HTTP_URL = 'https://cdn.example.com/emoji/aaaaaaaaaaaa.png';

describe('引用回覆的內容快照', () => {
    it('fixture 用的確實是 SDK 認的令牌形態', () => {
        expect(isBlobRef(BLOB_TOKEN)).toBe(true);
        // 這就是坑本身：截 10 個字 = 每個 SDK id 的公共前綴
        expect(BLOB_TOKEN.slice(0, 10)).toBe('blobref:b_');
    });

    it('引用一條 blobref 圖片消息，寫進快照的不是被截斷的令牌', () => {
        const snapshot = buildReplySnapshotContent({ type: 'image', content: BLOB_TOKEN });
        expect(snapshot).not.toContain('blobref');
        expect(snapshot).toBe('[圖片]');
    });

    it('沒標 type、值本身是令牌時也認得出來（兜底分支會取到任意最後一條 user 消息）', () => {
        const snapshot = buildReplySnapshotContent({ content: BLOB_TOKEN });
        expect(snapshot).not.toContain('blobref');
        expect(snapshot).toBe('[圖片]');
    });

    it('舊的 data: / 圖床 URL 一樣不進快照', () => {
        expect(buildReplySnapshotContent({ type: 'image', content: DATA_URL })).toBe('[圖片]');
        expect(buildReplySnapshotContent({ content: DATA_URL })).toBe('[圖片]');
        expect(buildReplySnapshotContent({ content: HTTP_URL })).toBe('[圖片]');
    });

    it('表情包給自己的佔位符', () => {
        expect(buildReplySnapshotContent({ type: 'emoji', content: BLOB_TOKEN })).toBe('[表情包]');
    });

    it('普通文字還是老樣子：長的截 10 個字，短的原樣', () => {
        expect(buildReplySnapshotContent({ type: 'text', content: '今天天氣真好我們出去走走吧' })).toBe('今天天氣真好我們出去...');
        expect(buildReplySnapshotContent({ type: 'text', content: '好呀' })).toBe('好呀');
    });
});

describe('引用解析的調用點', () => {
    const source = readFileSync(path.resolve(__dirname, './applyAssistantPostProcessing.ts'), 'utf8');

    it('resolveQuoteTarget 走快照函數，不再自己截 10 個字', () => {
        expect(source).toContain('content: buildReplySnapshotContent(targetMsg)');
        expect(source).not.toMatch(/targetMsg\.content\.slice\(0,\s*10\)\s*\+\s*'\.\.\.'/);
    });

    it('文件裡沒有別的地方往 replyTo 裡塞裸截斷的 content', () => {
        // replyTo 只有 aiReplyTarget / chunkReplyTarget 兩個來源，都出自 resolveQuoteTarget
        const producers = source.match(/=\s*resolveQuoteTarget\(/g) || [];
        expect(producers).toHaveLength(2);
        expect(source).not.toMatch(/replyTo:\s*\{/);
    });
});

// ─── 用戶側：自己引用一條圖片消息 ────────────────────────────────────────────
//
// 上面那套只管角色回覆。用戶在輸入框裡點「回覆」再發出去，走的是各 App 自己的落庫代碼，
// 一直是把被引用消息的 content 原樣抄進快照——圖片消息抄進去的就是 `blobref:b_...` 令牌，
// 於是氣泡裡、相冊詳情裡都會明晃晃印著一串令牌，孤兒清理那邊也照樣被截斷前綴噎住。

const readSource = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('私聊（apps/Chat.tsx）的用戶引用', () => {
    const source = readSource('../apps/Chat.tsx');

    it('落庫的快照經過 buildReplySnapshotContent，不再原樣抄 content', () => {
        expect(source).toContain('content: buildReplySnapshotContent(replyTarget)');
        expect(source).not.toMatch(/replyTo\s*=\s*\{[\s\S]{0,200}content:\s*replyTarget\.content\b/);
    });

    it('輸入框上方的「正在回覆」條也不再裸截 10 個字', () => {
        expect(source).not.toMatch(/replyTarget\.content\.slice\(0,\s*10\)/);
    });

    it('存相冊的聊天上下文對圖片/表情消息用佔位符', () => {
        expect(source).not.toContain('${sender}: ${m.content.substring(0, 100)}');
        expect(source).toMatch(/buildReplySnapshotContent\(m\)[\s\S]{0,120}m\.content\.substring\(0, 100\)/);
    });

    it('存相冊失敗不拖垮發消息：saveGalleryImage 被 try 包住', () => {
        // 輸入框在這一步之前已經清空，放任它拋出去就是「圖片發著發著沒了」
        const calls = source.match(/DB\.saveGalleryImage\(/g) || [];
        const guarded = source.match(/try\s*\{\s*await DB\.saveGalleryImage\(/g) || [];
        expect(guarded.length).toBeGreaterThan(0);
        expect(calls).toHaveLength(guarded.length);
    });

    it('拼出來的相冊上下文長成「小明: [圖片]」', () => {
        const line = `小明: ${buildReplySnapshotContent({ type: 'image', content: BLOB_TOKEN })}`;
        expect(line).toBe('小明: [圖片]');
    });
});

describe('群聊（apps/GroupChat.tsx）的用戶引用', () => {
    const source = readSource('../apps/GroupChat.tsx');

    it('落庫的快照經過 buildReplySnapshotContent', () => {
        expect(source).toContain('content: buildReplySnapshotContent(replyTarget)');
        expect(source).not.toMatch(/replyTo\s*=\s*\{[\s\S]{0,200}content:\s*replyTarget\.content\b/);
    });

    it('氣泡裡的引用預覽顯示前先換佔位符', () => {
        expect(source).toContain('buildReplySnapshotContent({ content: msg.replyTo.content })');
        expect(source).not.toMatch(/msg\.replyTo\.content\.slice\(0,\s*10\)/);
    });

    it('輸入框上方的「正在回覆」條也不再裸截 10 個字', () => {
        expect(source).not.toMatch(/replyTarget\.content\.slice\(0,\s*10\)/);
    });
});

describe('私聊氣泡（components/chat/MessageItem.tsx）的引用預覽', () => {
    const source = readSource('../components/chat/MessageItem.tsx');

    it('歷史裡已經存下的令牌快照，顯示前換成佔位符', () => {
        expect(source).toMatch(/replyPreview\s*=\s*m\.replyTo[\s\S]{0,300}buildReplySnapshotContent/);
        expect(source).not.toMatch(/const replyPreview = m\.replyTo \? stripJunk\(m\.replyTo\.content\) : '';/);
    });

    it('媒體判定複用 utils/blobRef 的 isImageValue，沒有另起一份', () => {
        expect(source).toMatch(/import \{[^}]*isImageValue[^}]*\} from '\.\.\/\.\.\/utils\/blobRef'/);
        expect(source).not.toMatch(/const isMediaValue\s*=/);
    });
});

// ─── 讀端漏網的兩處令牌 ──────────────────────────────────────────────────────

describe('通話舞台的兜底頭像（components/call/VRMVideoCallStage.tsx）', () => {
    const source = readSource('../components/call/VRMVideoCallStage.tsx');

    it('沒配 VRM 模型時的兜底頭像走 TokenImg，不是裸 <img>', () => {
        // fallbackAvatar 傳的是 char.avatar，上傳的頭像已經是 blobref 令牌
        expect(source).toContain('<TokenImg value={fallbackAvatar}');
        expect(source).not.toMatch(/<img\s+src=\{fallbackAvatar\}/);
    });

    it('確實 import 了 TokenImg', () => {
        expect(source).toMatch(/import TokenImg from '\.\.\/os\/TokenImg'/);
    });
});

describe('桌面陪伴的主色提取（components/os/CompanionHome.tsx）', () => {
    const source = readSource('../components/os/CompanionHome.tsx');

    it('頭像先解析成可加載 URL 再取色，不把令牌直接餵給 new Image()', () => {
        expect(source).toContain('useBlobRefUrl(character?.avatar)');
        expect(source).toContain('hueFromImage(avatarImageUrl)');
    });

    it('文件裡每一處取色的入參都是解析後的 URL', () => {
        const args = [...source.matchAll(/hueFromImage\(([^)]*)\)/g)].map(m => m[1].trim());
        expect(args.length).toBeGreaterThan(0);
        expect(args.every(arg => arg === 'avatarImageUrl' || arg === 'backgroundImageUrl')).toBe(true);
    });
});
