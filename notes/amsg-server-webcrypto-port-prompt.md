# 交接 prompt：把 amsg-server 的 `/cloudflare` 路徑改成純 Web Crypto（去掉 node `crypto`）

> 這份是給在 **ReiStandard** 倉庫（`packages/rei-standard-amsg/server`）裡幹活的實例看的，自包含，
> 不依賴別處上下文。目標只有一個：讓單用戶 / Cloudflare（`@rei-standard/amsg-server/cloudflare`）
> 那條路徑不再 import node 的 `crypto`，從而能像 `amsg-instant` 一樣打成**免兼容開關（無
> `nodejs_compat`）的自包含單文件 bundle**，供用戶直接粘進 Cloudflare Dashboard。

## 背景（為什麼要改）

`amsg-instant` 早已全 Web Crypto，所以它的 bundle 粘進 Dashboard 免開任何 flag。但
`amsg-server/cloudflare` 裡**載荷 AES 加密**還在用 node `crypto`（`createCipheriv` 等），
導致 esbuild 純 `platform=neutral` 打包直接報 `Could not resolve "crypto"`，粘進 Dashboard
必須額外開 `nodejs_compat`。把它港到 Web Crypto 後，這個開關就不需要了。

推送簽名那半（`lib/webpush-webcrypto.js`）本來就是 Web Crypto，不用動。

## 精確範圍（import 圖已追乾淨）

單用戶 / cloudflare 入口鏈：`cloudflare/single-user-worker.js` → `single-user.js` →
`tenant/single-user-context.js`（乾淨，無 crypto）+ 各 handler + `lib/run-tick.js` +
`lib/message-processor.js` + `adapters/d1.js`。這條鏈裡**只有下面幾處還掛 node `crypto`**：

**要改的：**
1. `server/src/server/lib/encryption.js` —— 主體。`createCipheriv/createDecipheriv`
   （AES-256-GCM）+ `createHash('sha256')`（派生 key）+ `randomBytes`。
2. `server/src/server/lib/message-processor.js` —— 第 22 行 `import { randomUUID } from 'crypto'`。
3. `server/src/server/handlers/schedule-message.js` —— 第 9 行 `import { randomUUID } from 'crypto'`。

**明確不要動（多租戶專用，不在 cloudflare import 圖裡，已確認）：**
- `server/src/server/tenant/token.js`（`createHmac/timingSafeEqual`，HMAC tenant token）
- `server/src/server/tenant/blob-store.js`（Netlify Blob KEK 的 AES）
- `server/src/server/tenant/context.js`（多租戶 context 的 hash/random）

> 這三個還用 node crypto 沒關係——它們只被 Netlify/Neon 多租戶主入口(`index.js`)拉，
> `/cloudflare` 入口不 import 它們，所以不影響 cloudflare bundle 的免 flag 目標。

## 任務 1：port `lib/encryption.js` 到 Web Crypto（★ 兼容是命門）

保持 **5 個導出的函數名、參數、返回結構、線格式逐字節不變**，只把實現從 node crypto 換成
`globalThis.crypto.subtle`。**所有 5 個導出都會變成 `async`**（SubtleCrypto 是異步的）。

### ★★ 必須注意的兼容陷阱 ★★

- **authTag 位置**：Node 的 GCM 把密文和 16 字節 authTag **分開**返回（`cipher.getAuthTag()`）；
  Web Crypto 的 `subtle.encrypt` 把 authTag **拼在密文尾部**。所以：
  - 加密後：把 `subtle.encrypt` 結果的**最後 16 字節切出來當 authTag**，前面當密文。
  - 解密前：把密文和 authTag **重新拼起來**再餵給 `subtle.decrypt`。
  - `tagLength: 128`（=16 字節）。
- **IV 長度保持原樣**：`encryptPayload` 用 **12** 字節 IV，`encryptForStorage` 用 **16** 字節 IV。
  別統一成 12，否則老數據解不開。Web Crypto 的 AES-GCM 兩種長度都接受。
- **編碼保持原樣**：payload 格式用**標準 base64**（原來 `Buffer.toString('base64')`）；storage 格式
  用 **hex**、冒號分隔 `iv:authTag:data`。
- **key 派生保持原樣**：`sha256(masterKey + userId)` 的 hex，`slice(0, 64)`（32 字節 = AES-256 key）。

### 參考實現（可直接用）

`lib/webcrypto-utils.js` 已導出 `utf8` / `utf8Decode` / `randomBytes` / `concatBytes`。還需要 hex 和
標準 base64 的編解碼——先查 `@rei-standard/amsg-shared` 有沒有現成的，沒有就加到 `webcrypto-utils.js`
（那兒本就是"runtime-neutral 編碼 helper"的家），別用 `Buffer`（免 flag bundle 裡沒有）。

```js
/**
 * Encryption utility library (Web Crypto 版)
 * AES-256-GCM，request/response 與 storage 加密，跑在任何有 globalThis.crypto.subtle 的運行時。
 */
import { utf8, utf8Decode, randomBytes, concatBytes } from './webcrypto-utils.js';

const subtle = globalThis.crypto.subtle;
const TAG_LEN = 16; // AES-GCM auth tag 字節數（tagLength:128）

// —— 編碼 helper（若 shared/webcrypto-utils 已有則複用）——
function bytesToHex(b) { let s=''; for (let i=0;i<b.length;i++) s+=b[i].toString(16).padStart(2,'0'); return s; }
function hexToBytes(h) { const o=new Uint8Array(h.length/2); for (let i=0;i<o.length;i++) o[i]=parseInt(h.substr(i*2,2),16); return o; }
function bytesToBase64(b) { let s=''; for (let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
function base64ToBytes(s) { const bin=atob(s); const o=new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) o[i]=bin.charCodeAt(i); return o; }

async function importAesKey(hexKey) {
  return subtle.importKey('raw', hexToBytes(hexKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** sha256(masterKey+userId) 的 hex，取前 64 字符（= 32 字節 AES-256 key）。*/
export async function deriveUserEncryptionKey(userId, masterKey) {
  const digest = await subtle.digest('SHA-256', utf8(masterKey + userId));
  return bytesToHex(new Uint8Array(digest)).slice(0, 64);
}

/** 加密 API 載荷（AES-256-GCM，base64）。返回 { iv, authTag, encryptedData }。*/
export async function encryptPayload(payload, encryptionKey) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const iv = randomBytes(12);
  const key = await importAesKey(encryptionKey);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8(plaintext)));
  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(sealed.slice(sealed.length - TAG_LEN)),
    encryptedData: bytesToBase64(sealed.slice(0, sealed.length - TAG_LEN)),
  };
}

/** 解密客戶端加密的請求體（AES-256-GCM，base64）。*/
export async function decryptPayload(encryptedPayload, encryptionKey) {
  const { iv, authTag, encryptedData } = encryptedPayload;
  const key = await importAesKey(encryptionKey);
  const sealed = concatBytes(base64ToBytes(encryptedData), base64ToBytes(authTag));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), tagLength: 128 }, key, sealed);
  return JSON.parse(utf8Decode(plain));
}

/** 加密入庫（AES-256-GCM，hex，格式 iv:authTag:encryptedData）。*/
export async function encryptForStorage(text, encryptionKey) {
  const iv = randomBytes(16);
  const key = await importAesKey(encryptionKey);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8(text)));
  const data = sealed.slice(0, sealed.length - TAG_LEN);
  const tag = sealed.slice(sealed.length - TAG_LEN);
  return `${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(data)}`;
}

/** 從入庫格式解密。*/
export async function decryptFromStorage(encryptedText, encryptionKey) {
  const [ivHex, tagHex, dataHex] = encryptedText.split(':');
  const key = await importAesKey(encryptionKey);
  const sealed = concatBytes(hexToBytes(dataHex), hexToBytes(tagHex));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex), tagLength: 128 }, key, sealed);
  return utf8Decode(plain);
}
```

## 任務 2：兩處 `randomUUID` 去掉 node crypto

- `lib/message-processor.js`：刪 `import { randomUUID } from 'crypto'`，改從 `./webcrypto-utils.js`
  引現成的 `randomUUID`。
- `handlers/schedule-message.js`：刪 `import { randomUUID } from 'crypto'`，改從 `../lib/webcrypto-utils.js`
  引 `randomUUID`。

## 任務 3：把 async 漣漪補齊（★ 別漏 await）

`encryption.js` 的 5 個導出變 async 後，**所有調用點都要 `await`**，且外層函數必須是 async。
注意 `encryption.js` 同時被多租戶主入口和 cloudflare 入口共用，所以要**全倉改，不只單用戶**。
已知調用點（逐個確認外層 async + 加 await）：

- `handlers/get-user-key.js` — `deriveUserEncryptionKey`
- `handlers/schedule-message.js` — `deriveUserEncryptionKey` / `decryptPayload` / `encryptForStorage`
- `handlers/update-message.js` — `deriveUserEncryptionKey` / `decryptPayload` / `encryptForStorage` / `decryptFromStorage`
- `handlers/messages.js` — `deriveUserEncryptionKey` / `decryptFromStorage` / `encryptPayload`
- `lib/run-tick.js` — `deriveUserEncryptionKey` / `decryptFromStorage`
- `lib/message-processor.js` — `deriveUserEncryptionKey` / `decryptFromStorage`

兜底：改完跑全套測試（下），漏 await 會以 "解密拿到 Promise / JSON.parse 報錯" 的形式炸出來。

## 任務 4：加回歸測試（把兼容釘死）

測試跑在 Node（既有 node `crypto` 也有 `globalThis.crypto.subtle`，Node ≥ 19），所以可以做
**跨實現互通測試**，無需硬編碼 fixture：

1. **跨實現互通（最重要，釘線格式）**：用 node 的 `crypto` 按老寫法（aes-256-gcm、12/16 字節 IV、
   分離 authTag）造密文 → 斷言新的 `decryptPayload` / `decryptFromStorage` 能解出原文；反向再來一遍
   （新 `encryptPayload/encryptForStorage` 產的密文 → 用 node `crypto` 解）。兩種格式都覆蓋。
   > 這條測試的意義：任何人以後改了算法/IV 長/編碼/authTag 處理，它就掛。是防迴歸的守衛。
2. **派生 key 等價**：node `createHash('sha256').update(masterKey+userId).digest('hex').slice(0,64)`
   與新 `deriveUserEncryptionKey` 輸出逐字符相等。
3. **round-trip**：`encrypt* → decrypt*` 原樣還原（含中文、含 emoji、空串邊界）。
4. **篡改即拋**：改一個字節的密文/authTag，`decrypt*` 必須 reject（GCM 校驗生效）。

## 驗收標準（都過才算完）

1. `grep -rE "from '(node:)?crypto'" server/src` 結果裡**只剩** `tenant/token.js`、
   `tenant/blob-store.js`、`tenant/context.js`（多租戶），單用戶/cloudflare 鏈裡一個不剩。
2. cloudflare 入口能純 neutral 打包、無 `Could not resolve "crypto"`：
   ```bash
   # 在裝了本包的目錄跑（worker.js 內容見下方"消費端"）：
   npx esbuild worker.js --bundle --format=esm --target=es2022 \
     --platform=neutral --conditions=worker,browser,import,default --outfile=/tmp/amsg-neutral.js
   # 期望：exit 0，且 grep -c 'node:' /tmp/amsg-neutral.js 結果為 0
   ```
   其中 `worker.js` = `import { createSingleUserCloudflareWorker, createWebCryptoWebPush } from
   '@rei-standard/amsg-server/cloudflare'; export default createSingleUserCloudflareWorker(...)`。
3. 全套 server 測試通過（含多租戶，確保 async 漣漪沒漏）。
4. 版本 +1、發 next tag（當前 npm 上 `next` = `2.6.0-next.1`，本次發 `2.6.0-next.2` 或你定），
   `exports` 的 `./cloudflare` 子路徑不變。

## 交付後（SullyOS 下游收口，不用你管，僅供瞭解）

SullyOS 會：升 `@rei-standard/amsg-server` 到新 next（僅構建期 devDep）→ 加 `worker/amsg/src/index.ts`
薄入口 → 進 `scripts/build-workers.mjs` 清單產免 flag 單文件 → 全局 Modal 加「複製 Worker 代碼」按鈕。
你這邊只要保證 `/cloudflare` 免 node crypto、能純 neutral 打包即可。
