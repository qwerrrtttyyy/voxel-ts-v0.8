import type { Fiber } from './Fiber';
import type { Kernel, Component } from './Registry';

/**
 * Cordis 风格上下文。
 *
 * - 服务不是「持有引用」，而是每次 `get(key)` 走 kernel 的反应式解析器；
 *   绑定出现 / 消失 / 换 provider 时，声明了 `inject` 的 Fiber 会被重算并重激活。
 * - `set()` / `effect()` 全部登记逆函数，卸载时由 Fiber 的效应栈 LIFO 回滚。
 * - `plugin()` 派生子 Context，子 Fiber 的生命周期由父级联（空间可组合性）。
 */
export class Context {
  constructor(
    readonly kernel: Kernel,
    readonly fiber: Fiber,
  ) {}

  /** 反应式读取：返回当前绑定值，缺失为 undefined */
  get<T>(key: string): T | undefined {
    return this.kernel.lookup<T>(key);
  }

  /**
   * 读取并断言存在。
   * 单值服务走 lookup；cap: 能力键没有单值绑定，以「确定性代表 provider」
   * 作为存在性见证返回 —— 于是 `inject: ['g']` + `require('g')` 在
   * 「至少一个贡献者活跃」时成立，且见证值与 fiber.resolution 完全一致。
   */
  require<T>(key: string): T {
    const value = this.get<T>(key);
    if (value !== undefined) return value;
    const rep = this.kernel.capRepresentative(key);
    if (rep !== null) return rep as T;
    throw new Error(`[Context] ${this.fiber.id} requires missing service "${key}"`);
  }

  /** 提供绑定；逆函数只在「仍由本 provider 持有」时删除，避免误删后来者 */
  set<T>(key: string, value: T): void {
    this.fiber.effects.effect(`set:${key}`, () => this.kernel.bind(key, value, this.fiber.id));
  }

  /**
   * 声明一个能力贡献（cap: 多提供者语义）。与 set 的单值覆盖不同，
   * 多个组件 claim 同一 key 会共存；逆函数只移除本组件自己的贡献。
   */
  claim(key: string): void {
    this.fiber.effects.effect(`cap:${key}`, () => this.kernel.claimCap(key, this.fiber.id));
  }

  /** 任意可逆副作用 */
  effect(label: string, fn: () => void | (() => void)): void {
    this.fiber.effects.effect(label, fn);
  }

  /** 派生子 Context：注册子组件，并把「卸载子组件」登记为父的一个逆 */
  plugin(component: Component): Fiber {
    const id = `${this.fiber.id}/${component.id}`;
    const fiber = this.kernel.registerAs(id, component, this.fiber);
    this.fiber.effects.effect(`child:${id}`, () => () => this.kernel.unregister(id));
    return fiber;
  }

  /** 语法糖：Cordis 的 Proxy 服务解析，`ctx.svc.foo` ≡ `ctx.get('foo')` */
  get svc(): Record<string, unknown> {
    const kernel = this.kernel;
    return new Proxy({}, {
      get: (_target, key) => (typeof key === 'string' ? kernel.lookup(key) : undefined),
      has: (_target, key) => (typeof key === 'string' ? kernel.has(key) : false),
    });
  }
}
