// utils/amsgDetachedWorkers.test.ts
// 守的是「斷開之後還找得回去」：清空 / 更換 Worker 地址都不再動雲端那份數據，所以舊地址
// 是用戶回去清理的唯一線索——本地不記的話，那台 worker 上的任務會一直跑下去，而用戶連
// 該填哪個地址都不知道。
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  forgetDetachedWorker,
  readDetachedWorkers,
  rememberDetachedWorker,
} from './amsgDetachedWorkers';

const A = 'https://amsg-a.example.dev';
const B = 'https://amsg-b.example.dev';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('斷開過的 Worker 備忘', () => {
  it('記下地址和斷開時間，最近斷開的排在前面', () => {
    rememberDetachedWorker(A);
    vi.advanceTimersByTime(1000);
    rememberDetachedWorker(B);

    expect(readDetachedWorkers().map((r) => r.url)).toEqual([B, A]);
    expect(readDetachedWorkers()[0].detachedAt).toBe(Date.now());
  });

  it('同一個地址反覆斷開只留最新那次', () => {
    rememberDetachedWorker(A);
    vi.advanceTimersByTime(60_000);
    rememberDetachedWorker(A);

    const records = readDetachedWorkers();
    expect(records).toHaveLength(1);
    expect(records[0].detachedAt).toBe(Date.now());
  });

  it('空地址不記（沒填過地址的人沒有可斷開的東西）', () => {
    rememberDetachedWorker('');
    rememberDetachedWorker('   ');
    rememberDetachedWorker(undefined);

    expect(readDetachedWorkers()).toEqual([]);
  });

  it('只留最近 5 條', () => {
    for (let i = 0; i < 8; i += 1) {
      rememberDetachedWorker(`https://w${i}.example.dev`);
      vi.advanceTimersByTime(1000);
    }

    const records = readDetachedWorkers();
    expect(records).toHaveLength(5);
    expect(records[0].url).toBe('https://w7.example.dev');
  });

  it('清乾淨之後能劃掉，劃完不留空殼', () => {
    rememberDetachedWorker(A);
    forgetDetachedWorker(A);

    expect(readDetachedWorkers()).toEqual([]);
    expect(localStorage.getItem('amsg2_detached_workers_v1')).toBeNull();
  });

  it('存的內容壞了當沒有，不往外拋', () => {
    localStorage.setItem('amsg2_detached_workers_v1', '{不是 JSON');
    expect(readDetachedWorkers()).toEqual([]);

    localStorage.setItem('amsg2_detached_workers_v1', '[{"url":123},{"detachedAt":1}]');
    expect(readDetachedWorkers()).toEqual([]);
  });
});
