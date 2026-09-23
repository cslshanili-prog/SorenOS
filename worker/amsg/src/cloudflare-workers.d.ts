/**
 * `cloudflare:workers` 是 Workers 運行時自帶的內置模塊，不從 node_modules 解析
 * （打包時由 scripts/build-workers.mjs 標成 external，交給運行時提供）。
 *
 * 這裡只聲明本倉庫真正用到的那一小塊：一個 Durable Object 基類和 alarm 相關的兩個
 * storage 方法。不引 @cloudflare/workers-types 整包是因為那會動 lockfile，而目前
 * 需要的就這麼幾個成員，自己寫清楚反而更看得懂。用到新成員時往這裡補。
 */
declare module 'cloudflare:workers' {
  export interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    /** 當前掛著的 alarm 時間戳；沒有則為 null。 */
    getAlarm(): Promise<number | null>;
    /** 設定 alarm；同一個對象同時只能掛一個，重複設會覆蓋。 */
    setAlarm(scheduledTime: number | Date): Promise<void>;
  }

  export interface DurableObjectState {
    storage: DurableObjectStorage;
  }

  /** 繼承它才能用 RPC（`stub.yourMethod()`）；傳統寫法只能走 `stub.fetch()`。 */
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    protected ctx: DurableObjectState;
    protected env: Env;
  }
}
