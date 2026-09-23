/**
 * `cloudflare:workers` 的測試替身。
 *
 * 這個模塊名是 Workers 運行時提供的虛擬模塊：打包時由 scripts/build-workers.mjs 標成
 * external 交給運行時，但 vitest 跑在 node 上，解析不到就會讓整個測試文件加載失敗
 * （`Failed to load url cloudflare:workers`）。這裡給它一個最小實現，由 vitest.config.ts
 * 的 alias 指過來。
 *
 * 只還原真實基類那點行為：把 (ctx, env) 存成實例屬性。alarm 的調度不在這裡模擬——
 * 需要驗 alarm 行為的測試自己造 storage 替身，那樣斷言的是「設沒設 alarm」這件事本身，
 * 比在替身裡假裝一套定時器可靠。
 */
export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
