// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// Tailwind 補丁 B 案（plans/todo.md 第 1 項）
describe('Tailwind 安靜下來才整份重做', () => {
    it('掛號期間畫面一安靜就重新指定一次原始設定；head 裡的變動不算；過了期間不再做', async () => {
        vi.useFakeTimers();
        const raw = { theme: {} };
        const writes: unknown[] = [];
        (window as any).__sorenTailwindConfig = raw;
        (window as any).tailwind = { set config(v: unknown) { writes.push(v); }, get config() { return raw; } };
        const mod = await import('./tailwindRepair');
        mod.installTailwindRepair();

        // 開機那一次：安靜 350ms 後重做
        vi.advanceTimersByTime(400);
        expect(writes).toEqual([raw]);

        // 畫面一直在變就先不做，停下來才做
        const box = document.createElement('div');
        document.body.appendChild(box);
        await Promise.resolve();
        vi.advanceTimersByTime(200);
        box.className = 'w-3 h-3';
        await Promise.resolve();
        vi.advanceTimersByTime(200);
        expect(writes.length).toBe(1);
        vi.advanceTimersByTime(200);
        expect(writes.length).toBe(2);

        // Tailwind 自己把 CSS 寫回 <head>，不會讓它自己觸發自己
        const style = document.createElement('style');
        document.head.appendChild(style);
        await Promise.resolve();
        vi.advanceTimersByTime(400);
        expect(writes.length).toBe(2);

        // 開機的 10 秒過了：畫面再變也不做；切 App 才再掛號
        vi.advanceTimersByTime(11_000);
        box.className = 'w-4';
        await Promise.resolve();
        vi.advanceTimersByTime(400);
        expect(writes.length).toBe(2);
        mod.noteAppSwitchForTailwind();
        vi.advanceTimersByTime(400);
        expect(writes.length).toBe(3);
        expect(mod.tailwindRepairCount()).toBe(3);
        vi.useRealTimers();
    });
});
