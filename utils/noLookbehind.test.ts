/**
 * 迴歸守衛: 禁止正則後行斷言 (?<=) / (?<!) 混回源碼與 bundle 產物。
 *
 * 為什麼: iOS Safari <16.4 (WebKit/JSC) 不支持 lookbehind, 舊設備上 new RegExp('(?<=…)')
 *   直接拋 "Invalid regular expression: invalid group specifier name", 被聊天兜底 catch
 *   包成錯誤氣泡彈給用戶。詳見 utils/lookbehindFree.test.ts。
 *
 * 怎麼測: 掃源碼目錄 + worker bundle 產物。先剝註釋 (我們在註釋裡大量用 (?<=…) 做說明,
 *   不能誤傷), 再檢測剩餘代碼是否含 lookbehind。命中即 fail, 報出文件:行號。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = join(__dirname, '..');
const SRC_DIRS = ['utils', 'hooks', 'apps', 'components', 'worker'];
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.mjs']);
const SKIP_FILE = /(lookbehindFree\.test\.ts|noLookbehind\.test\.ts)$/;
const SKIP_DIR = /node_modules|\.worktrees|dist/;
const BUNDLE_FILES = [
  'public/sw-keep-alive.js',
];
const LOOKBEHIND = /\(\?<[=!]/;

/** 粗剝 // 行註釋和 塊註釋, 避免誤傷註釋裡的 (?<=…) 說明文字。不需完整 parser。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (SKIP_DIR.test(full)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (SRC_EXT.has(extname(name)) && !SKIP_FILE.test(full) && !/\.bundle\.js$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('no-lookbehind 守衛', () => {
  it('源碼 (剝註釋後) 不含正則後行斷言', () => {
    const offenders: string[] = [];
    for (const dir of SRC_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const stripped = stripComments(readFileSync(file, 'utf8'));
        stripped.split('\n').forEach((line, i) => {
          if (LOOKBEHIND.test(line)) {
            offenders.push(`${file.replace(ROOT + '/', '')}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders, `發現 lookbehind (舊 iOS 會炸):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('worker bundle 產物不含正則後行斷言 (改完源碼記得跑 build:workers)', () => {
    const offenders: string[] = [];
    for (const rel of BUNDLE_FILES) {
      let src: string;
      try {
        src = readFileSync(join(ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      if (LOOKBEHIND.test(src)) offenders.push(rel);
    }
    expect(offenders, `bundle 含 lookbehind, 需重新 build:\n${offenders.join('\n')}`).toEqual([]);
  });
});
