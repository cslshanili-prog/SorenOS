import { describe, it, expect } from 'vitest';
import {
    buildTrajectoryProfilePrompt, parseTrajectoryProfile, toggleTrajectoryChecklistItem, groupTrajectoryChecklistByBatch,
    createTrajectoryArchiveDoc, createTrajectoryObjective, createTrajectoryChecklistItem,
    buildTrajectoryOotdPrompt, parseTrajectoryOotdDraft, createTrajectoryOotdPost, groupTrajectoryOotdByDate,
    buildTrajectoryMomentsPrompt, parseTrajectoryMomentDraft, createTrajectoryMomentPost,
    buildTrajectoryJourneyPrompt, createTrajectoryJourneyEntry,
} from './trajectory';

describe('buildTrajectoryProfilePrompt', () => {
    it('不帶 existing 時不出現"已經有這些條目"提示', () => {
        const prompt = buildTrajectoryProfilePrompt('角色設定塊');
        expect(prompt).not.toContain('已經有這些條目');
        expect(prompt).toContain('archives');
        expect(prompt).toContain('objectives');
        expect(prompt).toContain('checklist');
    });

    it('帶 existing 時列出已有標題防重複', () => {
        const existing = {
            archives: [createTrajectoryArchiveDoc({ title: '產權證明書', category: 'PERSONAL DOCUMENT', content: 'x' })],
            objectives: [createTrajectoryObjective({ title: '完成協奏曲', progress: 60, detail: 'x' })],
            checklist: [createTrajectoryChecklistItem({ title: '買罐頭', dueLabel: '明天' })],
            updatedAt: Date.now(),
        };
        const prompt = buildTrajectoryProfilePrompt('角色設定塊', existing);
        expect(prompt).toContain('已經有這些條目了');
        expect(prompt).toContain('產權證明書');
        expect(prompt).toContain('完成協奏曲');
        expect(prompt).toContain('買罐頭');
    });
});

describe('parseTrajectoryProfile', () => {
    it('解析完整合法 JSON', () => {
        const result = parseTrajectoryProfile({
            archives: [{ title: '老城區別墅產權證明書', category: 'PERSONAL DOCUMENT', content: '茲證明……' }],
            objectives: [{ title: '完成《流光》鋼琴協奏曲', progress: 65, detail: '融入雨聲採樣' }],
            checklist: [{ title: '去老城舊物店拿磁帶', dueLabel: '明天 15:00', done: false }],
        });
        expect(result.archives).toHaveLength(1);
        expect(result.archives[0]).toMatchObject({ title: '老城區別墅產權證明書', category: 'PERSONAL DOCUMENT' });
        expect(result.objectives[0]).toMatchObject({ title: '完成《流光》鋼琴協奏曲', progress: 65 });
        expect(result.checklist[0]).toMatchObject({ title: '去老城舊物店拿磁帶', dueLabel: '明天 15:00', done: false });
        expect(result.updatedAt).toBeGreaterThan(0);
    });

    it('progress 是字符串數字時能糾錯成 number', () => {
        const result = parseTrajectoryProfile({ objectives: [{ title: 'x', progress: '80', detail: '' }] });
        expect(result.objectives[0].progress).toBe(80);
    });

    it('progress 超出 0-100 範圍時夾在邊界內', () => {
        const result = parseTrajectoryProfile({ objectives: [{ title: 'x', progress: 150, detail: '' }] });
        expect(result.objectives[0].progress).toBe(100);
        const result2 = parseTrajectoryProfile({ objectives: [{ title: 'y', progress: -10, detail: '' }] });
        expect(result2.objectives[0].progress).toBe(0);
    });

    it('缺 title 的條目被過濾掉', () => {
        const result = parseTrajectoryProfile({
            archives: [{ category: 'X', content: 'no title' }],
            objectives: [{ progress: 50 }],
            checklist: [{ dueLabel: '明天' }],
        });
        expect(result.archives).toHaveLength(0);
        expect(result.objectives).toHaveLength(0);
        expect(result.checklist).toHaveLength(0);
    });

    it('category/dueLabel 缺省時給合理兜底', () => {
        const result = parseTrajectoryProfile({
            archives: [{ title: '一份文件', content: 'x' }],
            checklist: [{ title: '一件事' }],
        });
        expect(result.archives[0].category).toBe('PERSONAL DOCUMENT');
        expect(result.checklist[0].dueLabel).toBe('待安排');
    });

    it('完全不是對象/是 null 時返回三個空數組，不拋錯', () => {
        expect(parseTrajectoryProfile(null)).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
        expect(parseTrajectoryProfile('garbage')).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
        expect(parseTrajectoryProfile(undefined)).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
    });

    it('archives/objectives/checklist 不是數組時當作空處理', () => {
        const result = parseTrajectoryProfile({ archives: 'not an array', objectives: null, checklist: 42 });
        expect(result).toEqual(expect.objectContaining({ archives: [], objectives: [], checklist: [] }));
    });
});

describe('toggleTrajectoryChecklistItem', () => {
    it('切換指定 id 的 done，其餘條目不變', () => {
        const item1 = createTrajectoryChecklistItem({ title: 'A', dueLabel: '今天', done: false });
        const item2 = createTrajectoryChecklistItem({ title: 'B', dueLabel: '明天', done: true });
        const profile = { archives: [], objectives: [], checklist: [item1, item2], updatedAt: Date.now() };

        const toggled = toggleTrajectoryChecklistItem(profile, item1.id);
        expect(toggled.checklist.find(c => c.id === item1.id)?.done).toBe(true);
        expect(toggled.checklist.find(c => c.id === item2.id)?.done).toBe(true);

        const toggledBack = toggleTrajectoryChecklistItem(toggled, item2.id);
        expect(toggledBack.checklist.find(c => c.id === item2.id)?.done).toBe(false);
    });

    it('不存在的 id 不改變任何條目', () => {
        const item1 = createTrajectoryChecklistItem({ title: 'A', dueLabel: '今天' });
        const profile = { archives: [], objectives: [], checklist: [item1], updatedAt: Date.now() };
        const result = toggleTrajectoryChecklistItem(profile, 'not-exist');
        expect(result.checklist).toEqual(profile.checklist);
    });
});

describe('groupTrajectoryChecklistByBatch', () => {
    it('同一分鐘內生成的幾條歸為一批，批次間按時間新到舊排', () => {
        const batch1a = new Date('2026-09-20T09:00:12').getTime();
        const batch1b = new Date('2026-09-20T09:00:47').getTime();
        const batch2 = new Date('2026-09-19T15:30:00').getTime();
        const items = [
            { ...createTrajectoryChecklistItem({ title: 'A', dueLabel: '今天' }), createdAt: batch1a },
            { ...createTrajectoryChecklistItem({ title: 'B', dueLabel: '明天' }), createdAt: batch1b },
            { ...createTrajectoryChecklistItem({ title: 'C', dueLabel: '後天' }), createdAt: batch2 },
        ];
        const grouped = groupTrajectoryChecklistByBatch(items);
        expect(grouped).toHaveLength(2);
        expect(grouped[0].items.map(i => i.title)).toEqual(['B', 'A']);
        expect(grouped[1].items.map(i => i.title)).toEqual(['C']);
        expect(grouped[0].timestamp).toBeGreaterThan(grouped[1].timestamp);
    });

    it('空數組返回空分組', () => {
        expect(groupTrajectoryChecklistByBatch([])).toEqual([]);
    });
});

describe('buildTrajectoryOotdPrompt', () => {
    it('不帶 existing 時不出現"最近穿過"提示', () => {
        const prompt = buildTrajectoryOotdPrompt('角色設定塊');
        expect(prompt).not.toContain('最近穿過');
        expect(prompt).toContain('imagePrompt');
    });

    it('imagePrompt 說明統一走鏡子自拍風格，但要求細節每次不同', () => {
        const prompt = buildTrajectoryOotdPrompt('角色設定塊');
        expect(prompt).toContain('穿衣鏡前用手機自拍');
        expect(prompt).toContain('每次都要不一樣');
    });

    it('不傳 timeContext 時不出現時間相關提示', () => {
        const prompt = buildTrajectoryOotdPrompt('角色設定塊');
        expect(prompt).not.toContain('現在是');
        expect(prompt).toContain('必須符合上面給出的當下時間');
    });

    it('傳了 timeContext 時原樣帶上，且要求穿搭符合當下時間/日程', () => {
        const prompt = buildTrajectoryOotdPrompt('角色設定塊', undefined, '### 當前時間 (Now)\n現在是 2026年9月21日 週一 深夜 23:40。');
        expect(prompt).toContain('現在是 2026年9月21日 週一 深夜 23:40');
        expect(prompt).toContain('不合常理的搭配');
    });

    it('timeContext 是空字符串/全空白時當作沒傳', () => {
        expect(buildTrajectoryOotdPrompt('角色設定塊', undefined, '')).not.toContain('現在是');
        expect(buildTrajectoryOotdPrompt('角色設定塊', undefined, '   ')).not.toContain('現在是');
    });

    it('帶 existing 時列出最近的搭配防重複', () => {
        const existing = [createTrajectoryOotdPost({ style: '休閒', colors: [], tops: '白襯衫', bottoms: '牛仔褲', shoes: '', accessories: [], imagePrompt: 'x' }, 'img-token')];
        const prompt = buildTrajectoryOotdPrompt('角色設定塊', existing);
        expect(prompt).toContain('最近穿過這些搭配了');
        expect(prompt).toContain('白襯衫+牛仔褲');
    });
});

describe('parseTrajectoryOotdDraft', () => {
    it('解析完整合法 JSON', () => {
        const draft = parseTrajectoryOotdDraft({
            style: '休閒', colors: ['米白色', '杏色'], tops: '杏色亞麻襯衫', bottoms: '米白亞麻褲',
            shoes: '小白鞋', accessories: ['帆布包'], imagePrompt: 'a young woman in linen shirt',
        });
        expect(draft).toMatchObject({ style: '休閒', colors: ['米白色', '杏色'], tops: '杏色亞麻襯衫', bottoms: '米白亞麻褲', shoes: '小白鞋', accessories: ['帆布包'], imagePrompt: 'a young woman in linen shirt' });
    });

    it('缺 imagePrompt 時返回 null（沒法生圖，整條作廢）', () => {
        expect(parseTrajectoryOotdDraft({ style: '休閒', tops: '白襯衫' })).toBeNull();
        expect(parseTrajectoryOotdDraft({ imagePrompt: '' })).toBeNull();
    });

    it('style 缺省時兜底"日常"，colors/accessories 不是數組時當空數組', () => {
        const draft = parseTrajectoryOotdDraft({ imagePrompt: 'x', colors: 'not array', accessories: null });
        expect(draft).toMatchObject({ style: '日常', colors: [], accessories: [] });
    });

    it('不是對象/null 時返回 null', () => {
        expect(parseTrajectoryOotdDraft(null)).toBeNull();
        expect(parseTrajectoryOotdDraft('garbage')).toBeNull();
        expect(parseTrajectoryOotdDraft(undefined)).toBeNull();
    });
});

describe('groupTrajectoryOotdByDate', () => {
    it('同一天的多條按時間新到舊分在一組，組間按日期新到舊排', () => {
        const day1 = new Date('2026-09-15T09:32:00').getTime();
        const day1Later = new Date('2026-09-15T21:22:00').getTime();
        const day2 = new Date('2026-09-14T10:02:00').getTime();
        const posts = [
            { ...createTrajectoryOotdPost({ style: 'a', colors: [], tops: '', bottoms: '', shoes: '', accessories: [], imagePrompt: 'x' }, 'i1'), timestamp: day1 },
            { ...createTrajectoryOotdPost({ style: 'b', colors: [], tops: '', bottoms: '', shoes: '', accessories: [], imagePrompt: 'x' }, 'i2'), timestamp: day1Later },
            { ...createTrajectoryOotdPost({ style: 'c', colors: [], tops: '', bottoms: '', shoes: '', accessories: [], imagePrompt: 'x' }, 'i3'), timestamp: day2 },
        ];
        const grouped = groupTrajectoryOotdByDate(posts);
        expect(grouped).toHaveLength(2);
        expect(grouped[0].dateKey).toBe('2026-09-15');
        expect(grouped[0].posts.map(p => p.timestamp)).toEqual([day1Later, day1]);
        expect(grouped[1].dateKey).toBe('2026-09-14');
    });

    it('空數組返回空分組', () => {
        expect(groupTrajectoryOotdByDate([])).toEqual([]);
    });
});

describe('buildTrajectoryMomentsPrompt', () => {
    it('帶上最近發過的內容做防重複提示', () => {
        const existing = [
            createTrajectoryMomentPost({ content: '今天去海邊了，風好大', likes: 10, comments: [], imagePrompt: 'x' }, 'i1'),
        ];
        const prompt = buildTrajectoryMomentsPrompt('role block', existing);
        expect(prompt).toContain('今天去海邊了，風好大');
    });

    it('沒有歷史記錄時不含防重複提示', () => {
        const prompt = buildTrajectoryMomentsPrompt('role block');
        expect(prompt).not.toContain('最近發過這些內容了');
    });
});

describe('parseTrajectoryMomentDraft', () => {
    it('正常解析全部字段', () => {
        const draft = parseTrajectoryMomentDraft({
            content: '今天天氣正好', likes: 128,
            comments: [{ authorName: '路人甲', content: '好美的天氣！' }],
            imagePrompt: 'a sunny street scene',
        });
        expect(draft).toEqual({
            content: '今天天氣正好', likes: 128,
            comments: [{ authorName: '路人甲', content: '好美的天氣！' }],
            imagePrompt: 'a sunny street scene',
        });
    });

    it('缺 content 或 imagePrompt 時返回 null', () => {
        expect(parseTrajectoryMomentDraft({ imagePrompt: 'x' })).toBeNull();
        expect(parseTrajectoryMomentDraft({ content: 'x' })).toBeNull();
    });

    it('likes 不是數字、comments 不是數組時兜底', () => {
        const draft = parseTrajectoryMomentDraft({ content: 'x', imagePrompt: 'x', likes: 'not a number', comments: 'not array' });
        expect(draft).toMatchObject({ likes: 0, comments: [] });
    });

    it('comments 裡缺 authorName 的兜底"路人"，缺 content 的條目被過濾掉', () => {
        const draft = parseTrajectoryMomentDraft({
            content: 'x', imagePrompt: 'x',
            comments: [{ content: '有內容沒名字' }, { authorName: '只有名字沒內容' }],
        });
        expect(draft?.comments).toEqual([{ authorName: '路人', content: '有內容沒名字' }]);
    });

    it('不是對象/null 時返回 null', () => {
        expect(parseTrajectoryMomentDraft(null)).toBeNull();
        expect(parseTrajectoryMomentDraft('garbage')).toBeNull();
        expect(parseTrajectoryMomentDraft(undefined)).toBeNull();
    });
});

describe('createTrajectoryMomentPost', () => {
    it('draft + image 拼成完整記錄，每條評論都分配了 id', () => {
        const post = createTrajectoryMomentPost({
            content: '今天天氣正好', likes: 128,
            comments: [{ authorName: '路人甲', content: '好美的天氣！' }],
            imagePrompt: 'x',
        }, 'image-token');
        expect(post.content).toBe('今天天氣正好');
        expect(post.image).toBe('image-token');
        expect(post.likes).toBe(128);
        expect(post.comments).toHaveLength(1);
        expect(post.comments[0].id).toBeTruthy();
        expect(post.comments[0].authorName).toBe('路人甲');
        expect(post.syncedMessageId).toBeUndefined();
    });
});

describe('buildTrajectoryJourneyPrompt', () => {
    it('列出參與者名字與描述，正文不出現"用戶"字樣的硬編碼提示之外的用戶身份', () => {
        const prompt = buildTrajectoryJourneyPrompt('角色設定塊', {
            kind: '日常', time: '今晚八點', location: '老城區咖啡館',
            participants: [{ name: 'Miles', description: '爵士樂手，TA 的老朋友' }],
            detail: '聊起了即興專場',
        });
        expect(prompt).toContain('Miles');
        expect(prompt).toContain('爵士樂手，TA 的老朋友');
        expect(prompt).toContain('今晚八點');
        expect(prompt).toContain('老城區咖啡館');
        expect(prompt).toContain('聊起了即興專場');
        expect(prompt).toContain('絕對不能出現用戶');
    });

    it('沒有參與者時給出獨自經歷的兜底措辭', () => {
        const prompt = buildTrajectoryJourneyPrompt('角色設定塊', { kind: '事件', time: '', location: '', participants: [] });
        expect(prompt).toContain('獨自經歷');
    });

    it('沒有補充細節時不出現"補充細節"這行', () => {
        const prompt = buildTrajectoryJourneyPrompt('角色設定塊', { kind: '日常', time: 'x', location: 'y', participants: [] });
        expect(prompt).not.toContain('補充細節');
    });
});

describe('createTrajectoryJourneyEntry', () => {
    it('組裝出完整的記錄，補充細節的首尾空白被裁掉', () => {
        const entry = createTrajectoryJourneyEntry({
            kind: '事件', time: '明天', location: '海邊', participantNames: ['Aven', 'Swan'],
            detail: '  聊聊新專輯  ', story: '這是一段生成的敘事。',
        });
        expect(entry).toMatchObject({
            kind: '事件', time: '明天', location: '海邊', participantNames: ['Aven', 'Swan'],
            detail: '聊聊新專輯', story: '這是一段生成的敘事。',
        });
        expect(entry.id).toMatch(/^traj-jn-/);
        expect(entry.createdAt).toBeGreaterThan(0);
        expect(entry.syncedMessageId).toBeUndefined();
    });

    it('沒有補充細節（空字符串/未傳）時 detail 是 undefined', () => {
        const entry1 = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], story: 'x', detail: '  ' });
        expect(entry1.detail).toBeUndefined();
        const entry2 = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], story: 'x' });
        expect(entry2.detail).toBeUndefined();
    });

    it('participantCharIds 有值時原樣帶上；未傳或空數組時是 undefined（不落一個空數組）', () => {
        const withIds = createTrajectoryJourneyEntry({
            kind: '日常', time: '', location: '', participantNames: ['Aven'], participantCharIds: ['char-aven'], story: 'x',
        });
        expect(withIds.participantCharIds).toEqual(['char-aven']);
        const withoutIds = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], story: 'x' });
        expect(withoutIds.participantCharIds).toBeUndefined();
        const emptyIds = createTrajectoryJourneyEntry({ kind: '日常', time: '', location: '', participantNames: [], participantCharIds: [], story: 'x' });
        expect(emptyIds.participantCharIds).toBeUndefined();
    });
});
