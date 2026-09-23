import { beforeEach, expect, it } from 'vitest';
import { SAR_FACILITY_IDS, SAR_FACILITY_GUIDES, sarFacilityGuideKey } from './vrWorld/sarFacilityGuides';
import { collectSARLocalBackup, restoreSARLocalBackup } from './vrWorld/sarBackup';
import { sarGreetingExpression } from './vrWorld/sarGreetingExpression';
import { SAR_EXPRESSIONS, type SARExpression } from './vrWorld/sarArt';
beforeEach(() => localStorage.clear());
it('七處引導的完成狀態跟隨 SAR 備份，舊備份不會殘留另一台設備的完成標記', () => {
    for (const id of SAR_FACILITY_IDS) localStorage.setItem(sarFacilityGuideKey(id), 'done');
    const backup = collectSARLocalBackup(); localStorage.clear();
    restoreSARLocalBackup(JSON.parse(JSON.stringify(backup)), { replaceMissing: true });
    for (const id of SAR_FACILITY_IDS) expect(localStorage.getItem(sarFacilityGuideKey(id))).toBe('done');
    restoreSARLocalBackup(undefined, { replaceMissing: false });
    expect(localStorage.getItem(sarFacilityGuideKey('water'))).toBe('done');
    restoreSARLocalBackup(undefined, { replaceMissing: true });
    for (const id of SAR_FACILITY_IDS) expect(localStorage.getItem(sarFacilityGuideKey(id))).toBeNull();
});
it('恐龍和釣魚歸艾文；其他設施歸凱恩，扭蛋說明清楚區分兩池與去處', () => {
    for (const id of SAR_FACILITY_IDS) expect(SAR_FACILITY_GUIDES[id].npc).toBe(['water', 'garden'].includes(id) ? 'aiven' : 'caian');
    const steps = SAR_FACILITY_GUIDES.gacha.steps.map(step => step.text).join('');
    expect(steps).toContain('獨立抽'); expect(steps).toContain('組裝櫃'); expect(steps).toContain('鑄造');
});
it.each(['caian', 'aiven'] as const)('%s 日常三句只用可用表情，並避免連續三句一個表情', npc => {
    const lines = npc === 'caian' ? ['早上好！', '今天天氣不錯呢！', '今天就好好休息吧！'] : ['早上水比較安靜。', '水面有點亮。', '今天還是可以釣魚。'];
    const expressions: SARExpression[] = [];
    lines.forEach((line, index) => expressions.push(sarGreetingExpression(npc, line, index, expressions.at(-1))));
    expect(new Set(expressions).size).toBeGreaterThan(1);
    expect(expressions).not.toContain('embarrassed');
    for (const expression of expressions) expect(SAR_EXPRESSIONS[npc]).toContain(expression);
});
