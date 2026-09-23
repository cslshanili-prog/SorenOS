#!/usr/bin/env node
/**
 * XHS Bridge Server — Node HTTP 橋接 xiaohongshu-skills Python CLI
 *
 * 適配 xiaohongshu-skills 新架構（2026-05 之後）：
 * - cli.py 不再通過 Chrome 遠程調試端口（--remote-debugging-port=9222）
 * - 改為通過 "XHS Bridge" 瀏覽器擴展 + bridge_server.py（WebSocket :9333）
 * - cli.py 每次調用會自動拉起 bridge_server.py、自動打開 Chrome
 *
 * 前端 (SullyOS) 仍然通過 REST API 調用本服務，本服務 spawn Python CLI 並返回 JSON。
 * REST API 的 endpoint / 入參 / 出參與舊版完全兼容，前端無需改動。
 *
 * 依賴:
 *   - xiaohongshu-skills 新版（含 extension/ 目錄）
 *   - "XHS Bridge" Chrome 擴展（在 chrome://extensions/ 加載已解壓擴展 → extension/）
 *   - uv (Python 包管理器)
 *
 * 用法:
 *   node scripts/xhs-bridge.mjs                                    # 默認端口 18061
 *   node scripts/xhs-bridge.mjs --port 19000                       # 自定義端口
 *   node scripts/xhs-bridge.mjs --skills-dir /path/to/skills       # 自定義 skills 目錄
 *   node scripts/xhs-bridge.mjs --bridge-url ws://localhost:9333   # 自定義擴展 bridge 地址
 *
 * 前端 Server URL 設為: http://localhost:18061/api
 *
 * 兼容性: --chrome-host / --chrome-port / --account 仍可傳入，但會被忽略。
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const PORT = parseInt(getArg('--port', '18061'), 10);
const BRIDGE_URL = getArg('--bridge-url', ''); // 空字符串 = 用 cli.py 默認 (ws://localhost:9333)

// Auto-detect skills directory
function findSkillsDir() {
    const explicit = getArg('--skills-dir', '');
    if (explicit) return explicit;
    const candidates = [
        join(__dirname, '..', 'xiaohongshu-skills'),
        join(__dirname, '..', 'xiaohongshu-skills-main'),
        join(process.cwd(), 'xiaohongshu-skills'),
        join(process.cwd(), 'xiaohongshu-skills-main'),
    ];
    for (const dir of candidates) {
        if (existsSync(join(dir, 'scripts', 'cli.py'))) {
            console.log(`[bridge] Auto-detected skills dir: ${dir}`);
            return dir;
        }
    }
    return join(__dirname, '..', 'xiaohongshu-skills');
}
const SKILLS_DIR = findSkillsDir();
const CLI_PATH = join(SKILLS_DIR, 'scripts', 'cli.py');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== CLI Runner ====================

/**
 * 執行 xiaohongshu-skills CLI 命令，返回 JSON 結果。
 * 注意：新版 cli.py 不接受 --host/--port/--account，只接受 --bridge-url + command。
 */
function runCli(command, cliArgs = []) {
    return new Promise((resolve, reject) => {
        const fullArgs = [
            CLI_PATH,
            ...(BRIDGE_URL ? ['--bridge-url', BRIDGE_URL] : []),
            command,
            ...cliArgs,
        ];

        console.log(`[bridge] $ uv run python ${fullArgs.join(' ')}`);

        const proc = spawn('uv', ['run', 'python', ...fullArgs], {
            cwd: SKILLS_DIR,
            env: { ...process.env },
            // 首次調用會拉起 bridge_server.py + 等待擴展連接，時間會略久
            timeout: 180_000,
        });

        const stdout = [];
        const stderr = [];

        proc.stdout.on('data', (d) => stdout.push(d));
        proc.stderr.on('data', (d) => stderr.push(d));

        proc.on('close', (code) => {
            const out = Buffer.concat(stdout).toString().trim();
            const err = Buffer.concat(stderr).toString().trim();

            if (err) console.log(`[bridge] stderr: ${err.slice(0, 800)}`);
            console.log(`[bridge] stdout (${out.length} chars): ${out.slice(0, 300)}`);
            console.log(`[bridge] exit code: ${code}`);

            if (out) {
                try {
                    resolve({ code, data: JSON.parse(out) });
                    return;
                } catch {
                    resolve({ code, data: out });
                    return;
                }
            }

            if (code === 0) {
                console.warn(`[bridge] WARNING: CLI exited 0 but produced no output for: ${command}`);
                resolve({ code, data: { success: true, empty: true, warning: 'CLI returned no data' } });
            } else if (code === 1) {
                reject(new Error('未登錄，請先登錄小紅書'));
            } else {
                reject(new Error(err || `CLI 退出碼: ${code}`));
            }
        });

        proc.on('error', (e) => {
            reject(new Error(`無法啟動 CLI: ${e.message}. 請確保已安裝 uv 和 xiaohongshu-skills`));
        });
    });
}

/**
 * 帶重試的 CLI 執行：專用於 comment/reply 等操作
 * XHS 反爬機制：如果剛打開過筆記詳情（get-feed-detail），再用同一 xsec_token
 * 打開同一筆記會被臨時封鎖（"筆記不可訪問"/"當前筆記暫時無法瀏覽"）。
 * 等幾秒後重試通常可以成功。
 */
async function runCliWithRetry(command, cliArgs, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await runCli(command, cliArgs);
            const errMsg = result.data?.error || '';
            if (errMsg.includes('不可訪問') || errMsg.includes('無法瀏覽') || errMsg.includes('暫時無法')) {
                if (attempt < maxRetries) {
                    const waitSec = 5 + attempt * 3;
                    console.log(`[bridge] ${command}: 筆記暫時不可訪問，等 ${waitSec}s 後重試 (${attempt + 1}/${maxRetries})...`);
                    await sleep(waitSec * 1000);
                    continue;
                }
            }
            return result;
        } catch (e) {
            if (attempt < maxRetries && (e.message.includes('不可訪問') || e.message.includes('無法瀏覽'))) {
                const waitSec = 5 + attempt * 3;
                console.log(`[bridge] ${command}: 異常 - 筆記不可訪問，等 ${waitSec}s 後重試 (${attempt + 1}/${maxRetries})...`);
                await sleep(waitSec * 1000);
                continue;
            }
            throw e;
        }
    }
}

function writeTempFile(content, prefix = 'xhs-') {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const path = join(dir, 'content.txt');
    writeFileSync(path, content, 'utf-8');
    return path;
}

function cleanupTempFile(path) {
    try { unlinkSync(path); } catch { /* ignore */ }
}

// ==================== xsec_token 緩存 ====================
// 新版 cli.py 強制要求 get-feed-detail / post-comment / like-feed 等帶 --xsec-token。
// 從 search/list-feeds 的響應裡把 token 緩存下來，調用方沒傳時回退到緩存。

const xsecTokenCache = new Map();

function cacheTokensFromFeeds(feeds) {
    if (!Array.isArray(feeds)) return;
    for (const f of feeds) {
        if (!f || typeof f !== 'object') continue;
        const card = f.noteCard || f.note_card;
        const id = f.id || f.noteId || f.note_id || card?.noteId || card?.note_id;
        const token = f.xsecToken || f.xsec_token || card?.xsecToken || card?.xsec_token;
        if (id && token) xsecTokenCache.set(id, token);
    }
}

function resolveXsecToken(feedId, providedToken) {
    if (providedToken) return providedToken;
    const cached = xsecTokenCache.get(feedId);
    if (cached) console.log(`[bridge] xsec_token 命中緩存: ${feedId}`);
    return cached || '';
}

// ==================== Route Handlers ====================

const handlers = {
    'check-login': async (_body) => runCli('check-login'),

    'search': async (body) => {
        const cliArgs = ['--keyword', body.keyword || ''];
        if (body.sort_by) cliArgs.push('--sort-by', body.sort_by);
        if (body.note_type) cliArgs.push('--note-type', body.note_type);
        if (body.publish_time) cliArgs.push('--publish-time', body.publish_time);
        if (body.search_scope) cliArgs.push('--search-scope', body.search_scope);
        if (body.location) cliArgs.push('--location', body.location);
        const result = await runCli('search-feeds', cliArgs);
        cacheTokensFromFeeds(result.data?.feeds);
        return result;
    },

    'list-feeds': async (_body) => {
        const result = await runCli('list-feeds');
        cacheTokensFromFeeds(result.data?.feeds);
        return result;
    },

    'get-feed-detail': async (body) => {
        const feedId = body.feed_id;
        const xsecToken = resolveXsecToken(feedId, body.xsec_token);
        if (!xsecToken) {
            return { code: 0, data: { error: '缺少 xsec_token。請先調用 search 或 list-feeds 獲取 token，或在調用時顯式傳入 xsec_token。' } };
        }
        const cliArgs = ['--feed-id', feedId, '--xsec-token', xsecToken];
        if (body.load_all_comments) cliArgs.push('--load-all-comments');
        if (body.click_more_replies) cliArgs.push('--click-more-replies');
        return runCli('get-feed-detail', cliArgs);
    },

    'post-comment': async (body) => {
        const xsecToken = resolveXsecToken(body.feed_id, body.xsec_token);
        if (!xsecToken) {
            return { code: 1, data: { error: '缺少 xsec_token，評論失敗' } };
        }
        return runCliWithRetry('post-comment', [
            '--feed-id', body.feed_id,
            '--xsec-token', xsecToken,
            '--content', body.content,
        ]);
    },

    'reply-comment': async (body) => {
        const xsecToken = resolveXsecToken(body.feed_id, body.xsec_token);
        if (!xsecToken) {
            return { code: 1, data: { error: '缺少 xsec_token，回覆失敗' } };
        }
        const cliArgs = ['--feed-id', body.feed_id, '--xsec-token', xsecToken, '--content', body.content];
        if (body.comment_id) cliArgs.push('--comment-id', body.comment_id);
        if (body.user_id) cliArgs.push('--user-id', body.user_id);
        return runCliWithRetry('reply-comment', cliArgs);
    },

    'like-feed': async (body) => {
        const xsecToken = resolveXsecToken(body.feed_id, body.xsec_token);
        if (!xsecToken) {
            return { code: 1, data: { error: '缺少 xsec_token，點贊失敗' } };
        }
        const cliArgs = ['--feed-id', body.feed_id, '--xsec-token', xsecToken];
        if (body.unlike) cliArgs.push('--unlike');
        return runCli('like-feed', cliArgs);
    },

    'favorite-feed': async (body) => {
        const xsecToken = resolveXsecToken(body.feed_id, body.xsec_token);
        if (!xsecToken) {
            return { code: 1, data: { error: '缺少 xsec_token，收藏失敗' } };
        }
        const cliArgs = ['--feed-id', body.feed_id, '--xsec-token', xsecToken];
        if (body.unfavorite) cliArgs.push('--unfavorite');
        return runCli('favorite-feed', cliArgs);
    },

    'user-profile': async (body) => {
        const userId = body.user_id;
        const xsecToken = body.xsec_token || '';
        if (!xsecToken) {
            return {
                code: 0,
                data: {
                    error: '缺少 xsec_token。新版 xiaohongshu-skills 強制要求 user-profile 帶 token，請從 search/list-feeds 結果或他人主頁鏈接中提取後傳入。',
                },
            };
        }
        return runCli('user-profile', ['--user-id', userId, '--xsec-token', xsecToken]);
    },

    'publish': async (body) => {
        const titleFile = writeTempFile(body.title || '');
        const contentFile = writeTempFile(body.content || '');
        const cliArgs = ['--title-file', titleFile, '--content-file', contentFile];

        if (body.images?.length) {
            for (const img of body.images) cliArgs.push('--images', img);
        }
        if (body.tags?.length) {
            for (const tag of body.tags) cliArgs.push('--tags', tag);
        }
        if (body.visibility) cliArgs.push('--visibility', body.visibility);

        try {
            return await runCli('publish', cliArgs);
        } finally {
            cleanupTempFile(titleFile);
            cleanupTempFile(contentFile);
        }
    },

    'publish-video': async (body) => {
        const titleFile = writeTempFile(body.title || '');
        const contentFile = writeTempFile(body.content || '');
        const cliArgs = [
            '--title-file', titleFile,
            '--content-file', contentFile,
            '--video', body.video,
        ];

        if (body.tags?.length) {
            for (const tag of body.tags) cliArgs.push('--tags', tag);
        }
        if (body.visibility) cliArgs.push('--visibility', body.visibility);

        try {
            return await runCli('publish-video', cliArgs);
        } finally {
            cleanupTempFile(titleFile);
            cleanupTempFile(contentFile);
        }
    },

    'long-article': async (body) => {
        const titleFile = writeTempFile(body.title || '');
        const contentFile = writeTempFile(body.content || '');
        const cliArgs = ['--title-file', titleFile, '--content-file', contentFile];

        if (body.images?.length) {
            for (const img of body.images) cliArgs.push('--images', img);
        }

        try {
            return await runCli('long-article', cliArgs);
        } finally {
            cleanupTempFile(titleFile);
            cleanupTempFile(contentFile);
        }
    },

    'login': async (_body) => runCli('login'),
    'get-qrcode': async (_body) => runCli('get-qrcode'),
    'delete-cookies': async (_body) => runCli('delete-cookies'),
};

// ==================== HTTP Server ====================

createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path === '/api/health' || path === '/health') {
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', backend: 'xiaohongshu-skills', mode: 'extension-bridge' }));
        return;
    }

    const match = path.match(/^\/api\/(.+)$/);
    if (!match) {
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. Use /api/<command>' }));
        return;
    }

    const command = match[1];
    const handler = handlers[command];

    if (!handler) {
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown command: ${command}. Available: ${Object.keys(handlers).join(', ')}` }));
        return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        let body = {};
        if (chunks.length > 0) {
            try {
                body = JSON.parse(Buffer.concat(chunks).toString());
            } catch {
                res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
            }
        }

        try {
            const result = await handler(body);
            res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.data));
        } catch (e) {
            console.error(`[bridge] Error in ${command}:`, e.message);
            const status = e.message.includes('未登錄') ? 401 : 500;
            res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    });
}).listen(PORT, () => {
    console.log(`XHS Bridge Server started`);
    console.log(`  Listen:     http://localhost:${PORT}/api`);
    console.log(`  Skills dir: ${SKILLS_DIR}`);
    console.log(`  CLI path:   ${CLI_PATH}`);
    console.log(`  Mode:       Extension Bridge`);
    if (BRIDGE_URL) console.log(`  Bridge URL: ${BRIDGE_URL}`);

    if (!existsSync(CLI_PATH)) {
        console.error(`\n[WARNING] cli.py not found at: ${CLI_PATH}`);
        console.error(`  The bridge will start but CLI commands will fail.`);
        console.error(`  Please check your --skills-dir path or place xiaohongshu-skills in the parent directory.`);
    } else if (!existsSync(join(SKILLS_DIR, 'scripts', 'bridge_server.py'))) {
        console.error(`\n[WARNING] 檢測到 OLD VERSION xiaohongshu-skills！`);
        console.error(`  ${SKILLS_DIR}\\scripts\\ 裡沒有 bridge_server.py，說明這是舊版（CDP 架構）。`);
        console.error(`  本 bridge 是為新版（擴展架構）寫的，調舊 cli.py 會出現：`);
        console.error(`    - 自動彈出空白 Chrome 讓你掃碼登錄`);
        console.error(`    - 發佈/評論等操作用舊 DOM 選擇器，小紅書改版後會失敗`);
        console.error(`  請從 https://github.com/autoclaw-cc/xiaohongshu-skills 用 Code → Download ZIP 拿最新源碼`);
        console.error(`  （Release 頁的 zip 不包含 extension/，是坑）然後整個覆蓋到 ${SKILLS_DIR}\\`);
    }

    console.log(`\nAvailable endpoints:`);
    for (const cmd of Object.keys(handlers)) {
        console.log(`  POST /api/${cmd}`);
    }
    console.log(`\nSet your server URL to: http://localhost:${PORT}/api`);
    console.log(`\nNotes:`);
    console.log(`  - cli.py 會在首次請求時自動啟動 bridge_server.py 和打開 Chrome`);
    console.log(`  - 確保 "XHS Bridge" 瀏覽器擴展已在 Chrome 加載並啟用`);
    console.log(`  - 擴展加載方式: chrome://extensions/ → 開發者模式 → 加載已解壓擴展 → 選 extension/ 目錄`);
});
