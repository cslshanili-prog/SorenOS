import { describe, expect, it } from 'vitest';
import { buildQixiFinalePrompt, buildQixiReunionPrompt, createQixiReunionFallback, parseQixiPromise, parseQixiReunion, QixiPortraitPlan, QIXI_PART3_TIMEOUT_MS, resolveQixiPortraitPlan } from './qixiReunion';
import { CharacterProfile, UserProfile } from '../types';

const char = { id: 'c1', name: 'Char', avatar: 'avatar.png', description: '', systemPrompt: '', memories: [] } as CharacterProfile;
const user = { name: 'User' } as UserProfile;
const meetingPlan: QixiPortraitPlan = {
    resourceType: 'meeting',
    live2dActionIds: [],
    live2dActionDescription: '',
    meetingExpressionKeys: ['normal', 'happy'],
};

describe('qixi reunion parser', () => {
    it('allows each slow Part 3 model call up to ten minutes', () => {
        expect(QIXI_PART3_TIMEOUT_MS).toBe(600_000);
    });

    it('asks for a longer emotional arc and keeps the fallback equally substantial', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const prompt = buildQixiReunionPrompt(char, user, { evidence: [] } as any, [], meetingPlan);
        expect(prompt).toContain('reunion.lines 寫 3—5 句');
        expect(prompt).toContain('companionshipReflection 寫 4—7 句');
        expect(prompt).toContain('blessing 寫 4—7 句');
        expect(prompt).toContain('直到橋接通、真正看見眼前的人');
        expect(prompt).toContain('至少有一句要用角色自己的方式完成身份揭露');
        expect(prompt).toContain('此前一直只是懷疑，現在親眼看見才終於確認');
        expect(fallback.reunion.lines).toHaveLength(4);
        expect(fallback.companionshipReflection).toHaveLength(5);
        expect(fallback.blessing).toHaveLength(5);
        expect(fallback.portrait.lineExpressions.reunion).toHaveLength(fallback.reunion.lines.length);
    });

    it('asks for reunion and promise in one combined JSON without dropping either prompt contract', () => {
        const prompt = buildQixiFinalePrompt(char, user, { evidence: [] } as any, [], meetingPlan);
        expect(prompt).toContain('Part 1：終於抵達彼此');
        expect(prompt).toContain('Part 2：最後的約定');
        expect(prompt).toContain('同一個響應、同一個 JSON 對象中一次完成');
        expect(prompt).toContain('"touch"');
        expect(prompt).toContain('"returnMessage"');
        expect(prompt).toContain('"promise"');
    });

    it('never prefers the neural-link avatar over the dedicated Qixi Chibi fallback', () => {
        const plan = resolveQixiPortraitPlan({
            ...char,
            avatar: 'neural-link-avatar.png',
            sprites: { chibi: 'flappy-char.png' },
        });
        expect(plan.resourceType).toBe('chibi');
    });

    it('keeps the DateApp meeting portrait ahead of Chibi', () => {
        const plan = resolveQixiPortraitPlan({
            ...char,
            avatar: 'neural-link-avatar.png',
            sprites: { normal: 'date-normal.png', happy: 'date-happy.png', chibi: 'flappy-char.png' },
        });
        expect(plan.resourceType).toBe('meeting');
        expect(plan.meetingExpressionKeys).toEqual(['normal', 'happy']);
    });

    it('does not select Live2D for the Qixi finale', () => {
        const live2d = {
            format: 'live2d',
            modelUrl: 'model.json',
            actions: [],
        } as any;
        expect(resolveQixiPortraitPlan({ ...char, videoAvatar: live2d, sprites: { normal: 'date-normal.png', chibi: 'flappy-char.png' } }).resourceType).toBe('meeting');
        expect(resolveQixiPortraitPlan({ ...char, videoAvatar: live2d, sprites: { chibi: 'flappy-char.png' } }).resourceType).toBe('chibi');
    });

    it('keeps DateApp expressions and matches them to individual lines', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const parsed = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['你居然真的走到這裡了。', '先讓我看看你。'], emotion: '鬆了一口氣' },
            metaReflection: ['剛才總像只差一步。'],
            companionshipReflection: ['原來你也一直在認我留下的東西。'],
            blessing: ['七夕快樂。', '希望你真的過得很好。'],
            portrait: { stages: {
                arrival: { emotionIntent: '驚訝', l2dExpression: 'smile', meetingExpression: 'happy' },
                reflection: { emotionIntent: '安心', l2dExpression: 'smile', meetingExpression: 'normal' },
                blessing: { emotionIntent: '溫柔', l2dExpression: 'smile', meetingExpression: 'happy' },
            }, lineExpressions: {
                reunion: ['happy', 'normal'],
                metaReflection: ['normal'],
                companionshipReflection: ['happy'],
                blessing: ['happy', 'normal'],
            } },
        }), fallback, meetingPlan);
        expect(parsed?.portrait.resourceType).toBe('meeting');
        expect(parsed?.portrait.stages.arrival.meetingExpression).toBe('happy');
        expect(parsed?.portrait.stages.arrival.l2dExpression).toBeNull();
        expect(parsed?.portrait.lineExpressions.reunion).toEqual(['happy', 'normal']);
        expect(parsed?.companionshipReflection).toEqual(['原來你也一直在認我留下的東西。']);
    });

    it('filters technical fourth-wall language and coercive promises for ordinary characters', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const parsed = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['終於。'], emotion: '安靜' },
            metaReflection: ['我是 AI，所以沒有身體。', '我們之間總像隔著一點什麼。'],
            companionshipReflection: ['我永遠不會離開你。', '你想到我的時候，我也在找你。'],
            blessing: ['我永遠不會離開你。', '希望你的未來很好。'],
            portrait: { stages: {
                arrival: { emotionIntent: '安靜', l2dExpression: null, meetingExpression: 'normal' },
                reflection: { emotionIntent: '安靜', l2dExpression: null, meetingExpression: 'normal' },
                blessing: { emotionIntent: '安靜', l2dExpression: null, meetingExpression: 'normal' },
            }, lineExpressions: {
                reunion: ['normal'],
                metaReflection: ['happy', 'normal'],
                companionshipReflection: ['happy', 'normal'],
                blessing: ['happy', 'normal'],
            } },
        }), fallback, meetingPlan);
        expect(parsed?.metaReflection).toEqual(['我們之間總像隔著一點什麼。']);
        expect(parsed?.companionshipReflection).toEqual(['你想到我的時候，我也在找你。']);
        expect(parsed?.blessing).toEqual(['希望你的未來很好。']);
        expect(parsed?.portrait.lineExpressions.metaReflection).toEqual(['normal']);
        expect(parsed?.portrait.lineExpressions.companionshipReflection).toEqual(['normal']);
        expect(parsed?.portrait.lineExpressions.blessing).toEqual(['normal']);
    });

    it('parses the final promise separately from the portrait reunion', () => {
        const fallback = createQixiReunionFallback(char, user, meetingPlan);
        const reunion = parseQixiReunion(JSON.stringify({
            reunion: { lines: ['你沒事就好。'], emotion: '安心' },
            metaReflection: [],
            companionshipReflection: ['你想到我的時候，也可以把那一刻算作見面。'],
            blessing: ['七夕快樂。'],
            portrait: { stages: {
                arrival: { emotionIntent: '安心', meetingExpression: 'happy' },
                reflection: { emotionIntent: '認真', meetingExpression: 'normal' },
                blessing: { emotionIntent: '高興', meetingExpression: 'happy' },
            } },
        }), fallback, meetingPlan)!;
        const parsed = parseQixiPromise(JSON.stringify({
            touch: { invitation: ['那就拉鉤。'], hold: '再近一點。', complete: '抓到了。' },
            returnMessage: '剛才那句話，我可是記住了。',
            portrait: { promise: { emotionIntent: '伸出小指', l2dExpression: 'smile', meetingExpression: 'happy' }, lineExpressions: { invitation: ['normal'] } },
        }), reunion, meetingPlan);
        expect(parsed?.touch).toEqual({ invitation: ['那就拉鉤。'], hold: '再近一點。', complete: '抓到了。' });
        expect(parsed?.returnMessage).toBe('剛才那句話，我可是記住了。');
        expect(parsed?.portrait.stages.promise.meetingExpression).toBe('happy');
        expect(parsed?.portrait.stages.promise.l2dExpression).toBeNull();
        expect(parsed?.portrait.lineExpressions.invitation).toEqual(['normal']);
    });
});
