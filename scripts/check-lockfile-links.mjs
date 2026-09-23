/**
 * 檢查 pnpm-lock.yaml 裡有沒有指向倉庫外的本地依賴（link:../xxx）。
 *
 * 背景：本地聯調時把依賴臨時改成 `link:../ReiStandard` 這種兄弟目錄引用，
 * 一旦跟著 lockfile 提交上去，Netlify / CI 的 `--frozen-lockfile` 安裝會直接失敗
 * （那個目錄只存在於本地機器上）。
 *
 * 判定規則：把 link 目標按所屬 importer 目錄解析一次，
 * 解析後仍跳出倉庫根目錄的才算違規。
 * 倉庫內的 workspace 互鏈（`.` ↔ `worker/*`）是正常寫法，放行。
 *
 * 用法：
 *   node scripts/check-lockfile-links.mjs            # 檢查 ./pnpm-lock.yaml
 *   node scripts/check-lockfile-links.mjs 某個.yaml   # 檢查指定文件
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 從 lockfile 文本里找出所有指向倉庫外的 link 依賴。
 * @param {string} lockfileText pnpm-lock.yaml 的完整內容
 * @returns {{ line: number, importer: string, target: string, raw: string }[]}
 */
export function findExternalLinks(lockfileText) {
  const violations = [];
  let inImporters = false;
  let currentImporter = '.';

  lockfileText.split('\n').forEach((line, index) => {
    // 進入 importers: 段
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      currentImporter = '.';
      return;
    }
    // 碰到下一個頂層鍵（packages: / snapshots: ...）就離開 importers 段
    if (inImporters && /^[^\s#]/.test(line)) {
      inImporters = false;
    }
    if (!inImporters) return;

    // 縮進 2 空格的鍵是 importer 目錄，形如 `  .:` 或 `  worker/amsg:`
    const importerMatch = line.match(/^ {2}(\S.*?):\s*$/);
    if (importerMatch) {
      currentImporter = importerMatch[1].replace(/['"]/g, '');
      return;
    }

    const linkMatch = line.match(/link:(\S+)/);
    if (!linkMatch) return;

    const target = linkMatch[1].replace(/['"]/g, '');
    const resolved = path.posix.normalize(path.posix.join(currentImporter, target));
    if (resolved.startsWith('..')) {
      violations.push({
        line: index + 1,
        importer: currentImporter,
        target,
        raw: line.trim(),
      });
    }
  });

  return violations;
}

function main() {
  const lockfilePath = process.argv[2] ?? 'pnpm-lock.yaml';
  let text;
  try {
    text = readFileSync(lockfilePath, 'utf8');
  } catch {
    console.error(`讀不到 ${lockfilePath}，跳過檢查。`);
    process.exit(0);
  }

  const violations = findExternalLinks(text);
  if (violations.length === 0) {
    console.log(`${lockfilePath} 乾淨，沒有指向倉庫外的本地依賴。`);
    return;
  }

  console.error(`${lockfilePath} 裡有 ${violations.length} 處指向倉庫外的本地依賴：\n`);
  for (const v of violations) {
    console.error(`  第 ${v.line} 行（importer: ${v.importer}）: ${v.raw}`);
  }
  console.error(
    '\n這種引用只在你自己機器上有效，裝依賴時會因為找不到目錄而失敗。' +
      '\n把依賴改回正常的版本號（例如 npm 上的版本），重新 pnpm install 生成 lockfile 再提交。',
  );
  process.exit(1);
}

// 直接執行時才跑檢查，被 import 時只導出函數
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
