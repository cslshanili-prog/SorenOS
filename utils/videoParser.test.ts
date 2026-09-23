import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    isVideoShareUrl,
    formatStatCount,
    parseVideoShareUrl,
    getVideoParseKey,
    setVideoParseKey,
} from './videoParser';

// apizero flat=1 的真實響應結構（B站樣例，實測抓回來的字段裁剪版）。
const biliResponse = {
    code: 0,
    msg: '成功',
    data: {
        platform: 'bilibili',
        type: '視頻',
        title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
        video_url: 'https://upos-sz.bilivideo.com/xxx.mp4',
        cover_url: 'http://i1.hdslb.com/bfs/archive/cover.jpg',
        audio_url: '',
        imagelist: [],
        source: {
            platform: 'bilibili',
            platform_label: '嗶哩嗶哩',
            original_url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
            author_name: '索尼音樂中國',
        },
        stats: {
            author_name: '索尼音樂中國',
            author_avatar: 'https://i2.hdslb.com/bfs/face/avatar.jpg',
            like_count: 2777249,
            comment_count: 214525,
            share_count: 460335,
            play_count: 100876560,
            collect_count: 1460068,
            publish_time: '2020-01-01 07:43:23',
        },
        video_list: [],
    },
    request_id: 'test',
};

const mockFetch = (body: any, status = 200) => {
    const fn = vi.fn(async (..._args: any[]) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
};

beforeEach(() => {
    localStorage.removeItem('sully_video_parse_key_v1');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isVideoShareUrl', () => {
    it('識別主流視頻平台鏈接（含短鏈和子域）', () => {
        expect(isVideoShareUrl('https://v.douyin.com/iRNBho6u/')).toBe(true);
        expect(isVideoShareUrl('https://www.douyin.com/video/7231231231231231231')).toBe(true);
        expect(isVideoShareUrl('https://b23.tv/abc123')).toBe(true);
        expect(isVideoShareUrl('https://www.bilibili.com/video/BV1GJ411x7h7')).toBe(true);
        expect(isVideoShareUrl('https://v.kuaishou.com/xyz')).toBe(true);
        expect(isVideoShareUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
        expect(isVideoShareUrl('https://x.com/user/status/123')).toBe(true);
    });

    it('普通網頁 / 小紅書 / 非法輸入不命中', () => {
        expect(isVideoShareUrl('https://example.com/article')).toBe(false);
        expect(isVideoShareUrl('https://www.xiaohongshu.com/explore/abc')).toBe(false); // XHS 走專門卡片路徑
        expect(isVideoShareUrl('https://xhslink.com/abc')).toBe(false);
        expect(isVideoShareUrl('http://xhslink.cn/o/abc')).toBe(false);
        expect(isVideoShareUrl('not a url')).toBe(false);
        expect(isVideoShareUrl('')).toBe(false);
        // 域名後綴不能被前綴仿冒
        expect(isVideoShareUrl('https://fakedouyin.com/v/1')).toBe(false);
        expect(isVideoShareUrl('https://douyin.com.evil.com/v/1')).toBe(false);
    });
});

describe('formatStatCount', () => {
    it('萬 / 億縮寫，去掉 .0 尾巴', () => {
        expect(formatStatCount(2777249)).toBe('277.7萬');
        expect(formatStatCount(100876560)).toBe('1億');
        expect(formatStatCount(9999)).toBe('9999');
        expect(formatStatCount(10000)).toBe('1萬');
    });

    it('0 / 負數 / 非法值返回空串', () => {
        expect(formatStatCount(0)).toBe('');
        expect(formatStatCount(-5)).toBe('');
        expect(formatStatCount(undefined)).toBe('');
        expect(formatStatCount(NaN)).toBe('');
    });
});

describe('parseVideoShareUrl', () => {
    it('flat=1 響應映射成 ExtractedWebpage（含 video 附加字段）', async () => {
        mockFetch(biliResponse);
        const wp = await parseVideoShareUrl('https://b23.tv/abc123');
        expect(wp.title).toBe('【官方 MV】Never Gonna Give You Up - Rick Astley');
        expect(wp.finalUrl).toBe('https://www.bilibili.com/video/BV1GJ411x7h7');
        expect(wp.siteName).toBe('嗶哩嗶哩');
        expect(wp.image).toBe('http://i1.hdslb.com/bfs/archive/cover.jpg');
        expect(wp.content).toBe('');
        expect(wp.provider).toBe('apizero-video');
        expect(wp.video).toMatchObject({
            platform: 'bilibili',
            platformLabel: '嗶哩嗶哩',
            contentType: 'video',
            authorName: '索尼音樂中國',
            playCount: 100876560,
            likeCount: 2777249,
            publishTime: '2020-01-01 07:43:23',
        });
    });

    it('圖集（type=圖片 + imagelist）→ contentType image + 張數 + 首圖兜底封面', async () => {
        mockFetch({
            code: 0,
            data: {
                platform: 'douyin', type: '圖片', title: '九宮格', video_url: '', cover_url: '',
                imagelist: ['https://p1.example.com/1.jpg', 'https://p1.example.com/2.jpg'],
                source: { platform_label: '抖音', original_url: 'https://www.douyin.com/note/1' },
                stats: {},
            },
        });
        const wp = await parseVideoShareUrl('https://v.douyin.com/xyz/');
        expect(wp.video?.contentType).toBe('image');
        expect(wp.video?.imageCount).toBe(2);
        expect(wp.image).toBe('https://p1.example.com/1.jpg');
    });

    it('業務錯誤碼翻成人話並拋錯（4030 配額耗盡）', async () => {
        mockFetch({ code: 4030, msg: 'daily quota exceeded' });
        await expect(parseVideoShareUrl('https://b23.tv/abc')).rejects.toThrow(/配[额額]已耗[尽盡]/);
    });

    it('未知錯誤碼回落 API 自帶 msg', async () => {
        mockFetch({ code: 9999, msg: '奇怪的新錯誤' });
        await expect(parseVideoShareUrl('https://b23.tv/abc')).rejects.toThrow('奇怪的新錯誤');
    });

    it('空殼結果（無標題無視頻無圖）拋錯，讓調用方降級通用抓取', async () => {
        mockFetch({ code: 0, data: { platform: 'weibo', title: '', video_url: '', imagelist: [] } });
        await expect(parseVideoShareUrl('https://weibo.com/123')).rejects.toThrow('解析結果為空');
    });

    it('localStorage 裡的 key 會帶進請求參數', async () => {
        setVideoParseKey('  my-test-key  ');
        expect(getVideoParseKey()).toBe('my-test-key');
        const fn = mockFetch(biliResponse);
        await parseVideoShareUrl('https://b23.tv/abc123');
        const calledUrl = String(fn.mock.calls[0][0]);
        expect(calledUrl).toContain('key=my-test-key');
        expect(calledUrl).toContain('flat=1');
        setVideoParseKey('');
        expect(getVideoParseKey()).toMatch(/^sk_live_/); // 清空後回落項目方共享 key
    });
});
