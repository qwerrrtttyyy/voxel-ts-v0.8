export type Unregister = () => void;

/**
 * 类型安全的 ServiceToken：编译期携带 T 与字面量 id，运行期只是字符串 id。
 *
 * v0.8 两处 TS 加固：
 *  - `__type: (v: T) => T` 让 T 同时出现在参数与返回位置 → **不变 (invariant)**。
 *    旧的 `__type?: T` 是协变的，`ServiceToken<Dog>` 能冒充 `ServiceToken<Animal>`，
 *    `services.get(ANIMAL)` 拿到类型不符的值却编译通过。
 *  - `private __nominal` 让令牌成为名义类型：对象字面量 `{ id, description }`
 *    不再能伪造 ServiceToken 绕过注册表。
 */
export class ServiceToken<T, Id extends string = string> {
  declare readonly __type: (value: T) => T;
  private readonly __nominal!: void;
  constructor(readonly id: Id, readonly description = '') {}
}

/** 反查令牌的字面量 id，供编译期能力映射使用 */
export type TokenIdOf<T> = T extends { readonly id: infer I extends string } ? I : never;

export interface ServiceOptions {
  /** 数值大的实现胜出；同优先级时后注册者胜出（后加载的插件可覆盖核心） */
  priority?: number;
  owner?: string;
}

interface Entry {
  value: unknown;
  priority: number;
  owner: string;
  seq: number;
}

/**
 * 插件之间「提供 / 消费能力」的唯一通道。
 * 第三方插件不用改 PluginContext、不用改 main.ts，就能暴露自己的服务：
 *
 *   export const PHYSICS = new ServiceToken<IPhysics>('mypack.physics');
 *   scope.service(PHYSICS, new MyPhysics());
 *   // 别的插件：ctx.services.tryGet(PHYSICS)
 *
 * 内置策略（mesher / generator / collision）也全部走这里，
 * 因此「换实现」= provide 一个更高优先级的实现，世界自动响应变更。
 */
export class ServiceRegistry {
  private readonly entries = new Map<string, Entry[]>();
  /** v0.8：见过的全部令牌（含「被查询但当前无实现」的），审批据此区分缺失与未装配 */
  private readonly known = new Set<string>();
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  /** 上一次实际广播出去的生效值，用于按值去重，避免重复注册触发全量重建 */
  private readonly lastNotified = new Map<string, unknown>();
  /** v0.6：可选的生命周期事件出口，补齐 EventMap 里声明已久的 'service:changed' */
  private readonly events?: import('./EventBus').EventBus;
  private seq = 0;

  constructor(events?: import('./EventBus').EventBus) { this.events = events; }

  provide<T>(token: ServiceToken<T>, value: T, opts: ServiceOptions = {}): Unregister {
    this.known.add(token.id);
    const list = this.entries.get(token.id) ?? [];
    const entry: Entry = {
      value,
      priority: opts.priority ?? 0,
      owner: opts.owner ?? 'anonymous',
      seq: this.seq++,
    };
    list.push(entry);
    this.entries.set(token.id, list);
    this.notify(token.id);
    return () => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.entries.delete(token.id);
      this.notify(token.id);
    };
  }

  /** 取当前生效实现，缺失直接抛错 */
  get<T>(token: ServiceToken<T>): T {
    const v = this.tryGet(token);
    if (v === undefined) throw new Error(`[Services] ${token.id} not provided`);
    return v;
  }

  tryGet<T>(token: ServiceToken<T>): T | undefined {
    this.known.add(token.id);
    const list = this.entries.get(token.id);
    if (!list || list.length === 0) return undefined;
    const top = list.reduce((a, b) =>
      b.priority > a.priority || (b.priority === a.priority && b.seq > a.seq) ? b : a,
    );
    return top.value as T;
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.tryGet(token) !== undefined;
  }

  /** 实现被替换 / 移除时回调，参数是最新的生效值 */
  onChange<T>(token: ServiceToken<T>, fn: (value: T | undefined) => void): Unregister {
    this.known.add(token.id);
    let set = this.listeners.get(token.id);
    if (!set) { set = new Set(); this.listeners.set(token.id, set); }
    const wrapped = (v: unknown): void => fn(v as T | undefined);
    set.add(wrapped);
    return () => { set!.delete(wrapped); if (set!.size === 0) this.listeners.delete(token.id); };
  }

  owners<T>(token: ServiceToken<T>): string[] {
    this.known.add(token.id);
    return (this.entries.get(token.id) ?? []).map((e) => e.owner);
  }

  tokens(): string[] {
    return [...this.entries.keys()];
  }

  /** v0.8：审批用只读快照 —— 含「被查询过但当前无实现」的令牌 */
  inspect(): Array<{ id: string; owners: string[]; provided: boolean }> {
    return [...this.known].map((id) => ({
      id,
      owners: (this.entries.get(id) ?? []).map((e) => e.owner),
      provided: (this.entries.get(id)?.length ?? 0) > 0,
    }));
  }

  private notify(id: string): void {
    const list = this.entries.get(id);
    const top = list?.length
      ? list.reduce((a, b) =>
          b.priority > a.priority || (b.priority === a.priority && b.seq > a.seq) ? b : a,
        )
      : undefined;
    const current = top?.value;
    // 生效值没变（同实例重复 provide / 被更高优先级遮蔽）就不广播。
    if (this.lastNotified.has(id) && Object.is(this.lastNotified.get(id), current)) return;
    this.lastNotified.set(id, current);
    this.events?.emit('service:changed', {
      tokenId: id,
      owner: top?.owner,
      action: top ? 'provided' : 'removed',
    });
    const set = this.listeners.get(id);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(current); }
      catch (err) { console.error(`[Services] onChange for "${id}" threw`, err); }
    }
  }
}
