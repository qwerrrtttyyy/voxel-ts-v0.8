import type { EventMap } from './EventMap';
import type { EventBus } from './EventBus';
import type { Engine, UpdateFn, UpdateOptions, RenderFn, RenderOptions } from './Engine';
import type { ServiceRegistry, ServiceOptions, ServiceToken } from './ServiceRegistry';
import type { ConfigStore, ConfigNamespace } from './ConfigStore';
import type { BlockDef, BlockRegistry } from '../world/BlockRegistry';
import type { TilePainter, TextureAtlas } from '../render/TextureAtlas';
import type { BinaryHandler, BinaryHub } from '../binary/BinaryHub';
import { EffectStack } from '../kernel/Effect';
import type { PluginEventKey } from './brands';
import { AUDIT } from './tokens';
import type { AuditRule } from './audit';


export interface ScopeDeps {
  events: EventBus;
  engine: Engine;
  services: ServiceRegistry;
  config: ConfigStore;
  blocks: BlockRegistry;
  atlas: TextureAtlas;
  binary: BinaryHub;
}

/**
 * 每个插件独享的「资源作用域」。
 *
 * v0.5：底层从裸 `disposers[]` 换成 Cordis `EffectStack`——每一条注册都是
 * 一个「带逆的效应」，卸载时 LIFO 逆序精确回滚（恢复精确性 T16 覆盖全部插件）。
 * EffectStack 自带失败隔离（单个逆抛错不阻断其余）与幂等（undone 标志），
 * 因此对外 API 与可观察行为与旧实现完全一致。
 *
 * 传入共享 `EffectStack`（通常是该插件在统一 Kernel 里对应 Fiber 的效应栈）时，
 * 插件的全部资源直接进入 Cordis 可逆内核：Kernel 停用组件即精确回滚这些资源。
 */
export class PluginScope {
  readonly effects: EffectStack;
  readonly cfg: ConfigNamespace;
  private counter = 0;

  constructor(
    readonly owner: string,
    private readonly deps: ScopeDeps,
    effects?: EffectStack,
  ) {
    this.cfg = deps.config.namespace(owner);
    this.effects = effects ?? new EffectStack();
  }

  /** 登记任意清理函数；fn 本身就是该资源的逆（EffectStack.effect 期望返回逆） */
  track(fn: void | (() => void)): void {
    if (typeof fn === 'function') {
      const label = `scope:${this.owner}#${this.counter++}`;
      this.effects.effect(label, () => fn);
    }
  }

  on<K extends keyof EventMap>(type: K, fn: (payload: EventMap[K]) => void): void {
    this.track(this.deps.events.on(type, fn));
  }

  onDynamic(type: PluginEventKey, fn: (payload: unknown) => void): void {
    this.track(this.deps.events.onDynamic(type, fn));
  }

  /**
   * v0.8：第三方插件注册自己的审批规则。
   * 规则随插件作用域走 —— 卸载时 EffectStack 自动注销，不留孤儿规则。
   */
  audit(rule: AuditRule): void {
    const registry = this.deps.services.tryGet(AUDIT);
    if (!registry) throw new Error('[scope] 深度审批插件未启用，无法注册规则');
    this.track(registry.register(rule));
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    this.deps.events.emit(type, payload);
  }

  /** v0.6：自动注入 label，Engine 的耗时画像可按插件 id 聚合 */
  update(fn: UpdateFn, opts?: UpdateOptions): void {
    this.track(this.deps.engine.onUpdate(fn, {
      ...opts,
      label: opts?.label ?? `${this.owner}:update#${this.counter}`,
    }));
  }

  render(fn: RenderFn, opts?: RenderOptions): void {
    this.track(this.deps.engine.onRender(fn, {
      ...opts,
      label: opts?.label ?? `${this.owner}:render#${this.counter}`,
    }));
  }

  service<T>(token: ServiceToken<T>, value: T, opts: ServiceOptions = {}): void {
    this.track(this.deps.services.provide(token, value, { ...opts, owner: this.owner }));
  }

  onService<T>(token: ServiceToken<T>, fn: (value: T | undefined) => void): void {
    this.track(this.deps.services.onChange(token, fn));
  }

  /** 命名空间贴图，返回可直接填进 BlockDef.faces 的 key；重复调用幂等 */
  tile(local: string, paint: TilePainter): string {
    const key = this.deps.atlas.define(this.owner, local, paint);
    this.track(() => this.deps.atlas.releaseKey(key));
    return key;
  }

  /** 命名空间方块，返回自动分配的 id；重复调用幂等（热重载安全） */
  block(local: string, def: Omit<BlockDef, 'id' | 'name'> & { id?: number }): number {
    const id = this.deps.blocks.define(this.owner, local, def);
    this.track(() => this.deps.blocks.release(id));
    return id;
  }

  /** 插件私有二进制段，tag 由 owner 派生，冲突在注册期就报 */
  binary<T>(local: number, handler: Omit<BinaryHandler<T>, 'tag'> & { tag?: number }): number {
    const tag = handler.tag ?? this.deps.binary.claimTag(this.owner, local);
    this.track(this.deps.binary.register<T>({ ...handler, tag, owner: this.owner }));
    return tag;
  }

  /** DOM 监听也纳入作用域，卸载时自动解绑 */
  dom(
    target: EventTarget,
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    target.addEventListener(type, fn, opts);
    this.track(() => target.removeEventListener(type, fn, opts));
  }

  config<T>(key: string, fallback: T): T {
    return this.cfg.get(key, fallback);
  }

  get resourceCount(): number { return this.effects.size; }

  dispose(): void {
    // EffectStack.undo() 自带幂等与失败隔离，等价于旧的 disposed 标志 + try/catch
    this.effects.undo();
  }
}
