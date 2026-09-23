import { describe, expect, it } from 'vitest';
import { parseGeneratedImpression } from './impressionGeneration';

const profile = {
    version: 3, lastUpdated: 1,
    value_map: { likes: ['畫畫'], dislikes: [], core_values: '我欣賞她的真誠' },
    behavior_profile: { tone_style: '溫柔', emotion_summary: '平靜', response_patterns: '認真傾聽' },
    emotion_schema: { triggers: { positive: [], negative: [] }, comfort_zone: '花園', stress_signals: [] },
    personality_core: { observed_traits: ['認真'], interaction_style: '朋友', summary: '我很珍惜她' },
    mbti_analysis: { type: 'INFP', reasoning: '善於感受', dimensions: { e_i: 30, s_n: 70, t_f: 80, j_p: 50 } },
    observed_changes: ['開始分享日常'],
};
const completion = (content: any, finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }] });

describe('generated impression recovery', () => {
    it('accepts plain JSON, fences, text blocks and a result wrapper', () => {
        const json = JSON.stringify(profile);
        for (const content of [json, `說明：\n\`\`\`JSON\n${json}\n\`\`\``, [{ type: 'text', text: json }], JSON.stringify({ result: profile })]) {
            expect(parseGeneratedImpression(completion(content)).personality_core.summary).toBe(profile.personality_core.summary);
        }
    });
    it('repairs unescaped quotes and trailing commas without changing the note', () => {
        const bad = JSON.stringify(profile).replace('我很珍惜她', '我記得她說"還不夠好"，其實她很好').replace('"observed_changes":["開始分享日常"]}', '"observed_changes":["開始分享日常",],}');
        expect(parseGeneratedImpression(completion(bad)).personality_core.summary).toBe('我記得她說"還不夠好"，其實她很好');
    });
    it('rejects an unterminated string and partial schema with an actionable error', () => {
        for (const content of [JSON.stringify(profile).slice(0, -9), '{"personality_core":{"summary":"一半', '{"personality_core":{"summary":"只有總結"}}', '{}']) {
            expect(() => parseGeneratedImpression(completion(content))).toThrow('原有印象未修改');
        }
    });
    it('preserves apostrophes and punctuation while repairing literal newlines and trailing commas', () => {
        const summary = "我記得她說 don't give up, }，也記得\n第二句話";
        const json = JSON.stringify({ ...profile, personality_core: { ...profile.personality_core, summary } })
            .replace('\\n', '\n').replace(/}$/, ',}');
        expect(parseGeneratedImpression(completion(json)).personality_core.summary).toBe(summary);
    });
    it('does not mistake reasoning-only output for a final impression', () => {
        expect(() => parseGeneratedImpression({ choices: [{ message: { content: '', reasoning_content: JSON.stringify(profile) } }] })).toThrow('沒有返回印象正文');
    });
    it('rejects token-limited and filtered responses even when the JSON looks usable', () => {
        expect(() => parseGeneratedImpression(completion(JSON.stringify(profile), 'length'))).toThrow('長度上限');
        expect(() => parseGeneratedImpression(completion(JSON.stringify(profile), 'content_filter'))).toThrow('服務商攔截');
    });
});
