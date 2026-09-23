import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript helper has no type declarations.
import { findExternalLinks } from './check-lockfile-links.mjs';

const repoRoot = path.resolve(__dirname, '..');

describe('lockfile 本地依賴檢查', () => {
  it('倉庫當前的 pnpm-lock.yaml 是乾淨的', () => {
    const text = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(findExternalLinks(text)).toEqual([]);
  });

  it('抓得到指向倉庫外兄弟目錄的 link', () => {
    const lockfile = [
      'lockfileVersion: 9.0',
      '',
      'importers:',
      '',
      '  .:',
      '    devDependencies:',
      "      '@rei-standard/amsg-server':",
      '        specifier: link:../ReiStandard/packages/amsg-server',
      '        version: link:../ReiStandard/packages/amsg-server',
      '',
      'packages: {}',
    ].join('\n');

    const violations = findExternalLinks(lockfile);
    expect(violations).toHaveLength(2);
    expect(violations[0].importer).toBe('.');
    expect(violations[0].target).toBe('../ReiStandard/packages/amsg-server');
  });

  it('子包裡跳出倉庫根的 link 同樣算違規', () => {
    const lockfile = [
      'importers:',
      '',
      '  worker/amsg:',
      '    dependencies:',
      '      some-lib:',
      '        version: link:../../../some-lib',
      '',
      'packages: {}',
    ].join('\n');

    const violations = findExternalLinks(lockfile);
    expect(violations).toHaveLength(1);
    expect(violations[0].importer).toBe('worker/amsg');
  });

  it('倉庫內的 workspace 互鏈放行', () => {
    const lockfile = [
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      amsg:',
      '        version: link:worker/amsg',
      '',
      '  worker/amsg:',
      '    dependencies:',
      '      sullyos:',
      '        version: link:../..',
      '',
      'packages: {}',
    ].join('\n');

    expect(findExternalLinks(lockfile)).toEqual([]);
  });

  it('importers 段之外出現 link 字樣不誤報', () => {
    const lockfile = [
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      normal-lib:',
      '        version: 1.2.3',
      '',
      'snapshots:',
      '',
      '  fake-pkg@1.0.0:',
      '    resolution: link:../whatever',
    ].join('\n');

    expect(findExternalLinks(lockfile)).toEqual([]);
  });
});
