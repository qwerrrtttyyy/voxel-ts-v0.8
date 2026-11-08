import type { Plugin, PluginContext, IPluginHost } from './types';
import type { ServiceToken, ServiceOptions } from './ServiceRegistry';
import type { PluginScope } from './PluginScope';
import type { PluginEventKey } from './brands';

/**
 * 运行时插件沙箱（v0.6）。
 *
 * 内置 / 扩展 / 构建期社区插件是「随构建一起交付的可信代码」，仍拿到完整
 * PluginContext；只有 `url` / `source` 两类运行时热加载插件经过这里包装。
 * 默认能力只覆盖「注册自己的方块/贴图/二进制段、订阅事件、跑循环、弹 toast」，
 * 想拿 scene / renderer / 写世界 / 顶掉核心策略 / 卸载别的插件，必须在插件
 * 对象上显式声明 requiredCapabilities，安装期就会校验并给出明确错误。
 *
 * 这不是浏览器级安全隔离（同 realm 仍可通过原型链逃逸），而是把「误操作 /
 * 随手破坏核心」挡在 API 边界之外，并让菜单能如实标注插件来源与权限。
 */

/** 默认授予：命名空间资源 + 只读观察 + 受限事件，足够写绝大多数玩法插件 */
export const DEFAULT_CAPABILITIES = [
  'tile', 'block', 'binary.segment', 'event', 'update', 'render',
  'config', 'ui', 'log', 'services.read', 'world.read', 'host.read',
] as const;

/** 需要插件显式申请的能力；未申请时访问对应字段直接抛错 */
export const PRIVILEGED_CAPABILITIES = [
  'scene', 'camera', 'renderer', 'wasm',
  'services.provide', 'world.write', 'host.mutate', 'binary.raw',
] as const;

export type PrivilegedCapability = (typeof PRIVILEGED_CAPABILITIES)[number];

/**
 * 安装期校验：能力声明的拼写错误要在「点安装」时就报出来，
 * 而不是等到插件第一次 setup 才炸在半初始化状态里。
 */
export function validateCapabilities(plugin: Plugin): string[] {
  const requested = plugin.requiredCapabilities ?? [];
  const unknown = requested.filter(
    (c) => !(PRIVILEGED_CAPABILITIES as readonly string[]).includes(c),
  );
  if (unknown.length) {
    throw new Error(`[sandbox] ${plugin.id} 申请了未知能力：${unknown.join(', ')}`);
  }
  return [...requested];
}

/** 保护中的服务令牌：远程插件永远不能 provide，避免顶掉核心策略或外壳服务 */
const PROTECTED_SERVICE = /^(core|cordis|voxel)\./;
/** 允许远程插件广播的事件（自定义事件走 emitDynamic，另有前缀限制） */
const SAFE_EVENTS = new Set([
  'game:toast', 'stats:changed', 'game:mode', 'time:changed',
  'inventory:changed', 'save:changed', 'block:broken', 'block:placed',
]);
const RESERVED_EVENT_PREFIX = /^(world|plugin|chunk|service|save):/;

function denied(what: string, hint: string): never {
  throw new Error(`[sandbox] ${what} 未授权（${hint}）`);
}

/**
 * v0.8：`Pick<T, K[number]>` 取代 `Partial<T>` —— 投影出来的视图里
 * 每个键都是**必需**且保留原方法泛型，第三方拿不到「可能 undefined」的宽松类型。
 */
function readonlyView<T extends object, K extends readonly (keyof T)[]>(
  obj: T, keys: K,
): Pick<T, K[number]> {
  const out = {} as Record<keyof T, unknown>;
  for (const k of keys) {
    const v = obj[k];
    out[k] = typeof v === 'function'
      ? (v as unknown as (...a: unknown[]) => unknown).bind(obj)
      : v;
  }
  return out as Pick<T, K[number]>;
}

/**
 * 把完整 PluginContext 投影成受限视图。返回的 Proxy 对任何未列字段抛错，
 * 而不是静默给 undefined —— 插件作者能立刻看到「缺哪个能力」。
 */
export function createSandboxContext(
  ctx: PluginContext,
  pluginId: string,
  requested: readonly string[] = [],
): PluginContext {
  const unknown = requested.filter((c) => !(PRIVILEGED_CAPABILITIES as readonly string[]).includes(c));
  if (unknown.length) {
    throw new Error(`[sandbox] ${pluginId} 申请了未知能力：${unknown.join(', ')}`);
  }
  const allowed = new Set<string>(requested);
  const has = (c: PrivilegedCapability): boolean => allowed.has(c);
  const deny = (c: PrivilegedCapability) => (): never =>
    denied(c, `${pluginId} 需声明 requiredCapabilities: ['${c}']`);

  /** 类型化事件与动态事件共用一套白名单；动态事件仍不许伪造核心前缀 */
  const emitSafe = (type: unknown, payload: unknown, dynamic: boolean): void => {
    if (typeof type !== 'string') return;
    if (!dynamic && !SAFE_EVENTS.has(type)) {
      throw new Error(`[sandbox] ${pluginId} 不能广播核心事件 ${type}`);
    }
    if (RESERVED_EVENT_PREFIX.test(type)) {
      throw new Error(`[sandbox] ${pluginId} 不能伪造 ${type} 事件`);
    }
    if (dynamic) ctx.events.emitDynamic(type as PluginEventKey, payload);
    else ctx.events.emit(type as 'game:toast', payload as { text: string; kind: 'info' | 'good' | 'warn' | 'achievement' });
  };

  // scope 本身已是「命名空间 + 自动清理」的安全 API，只需收紧 service / emit
  const rawScope = ctx.scope;
  const scope = new Proxy(rawScope, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (prop === 'service') {
        return <T>(token: ServiceToken<T>, value: T, opts: ServiceOptions = {}): void => {
          if (!has('services.provide')) deny('services.provide')();
          if (PROTECTED_SERVICE.test(token.id)) {
            throw new Error(`[sandbox] ${pluginId} 不能替换核心服务 ${token.id}`);
          }
          if ((opts.priority ?? 0) > 0) {
            throw new Error(`[sandbox] ${pluginId} 不能以正优先级覆盖已有策略`);
          }
          target.service(token, value, opts);
        };
      }
      if (prop === 'emit' || prop === 'emitDynamic') {
        return (type: unknown, payload: unknown): void =>
          emitSafe(type, payload, prop === 'emitDynamic');
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as PluginScope;

  const services = {
    ...readonlyView(ctx.services, ['get', 'tryGet', 'has', 'owners', 'tokens', 'onChange'] as const),
    provide: has('services.provide')
      ? (token: ServiceToken<unknown>, value: unknown, opts: ServiceOptions = {}): void => {
          if (PROTECTED_SERVICE.test(token.id)) {
            throw new Error(`[sandbox] ${pluginId} 不能替换核心服务 ${token.id}`);
          }
          ctx.services.provide(token, value, opts);
        }
      : deny('services.provide'),
  };

  const world = {
    ...readonlyView(ctx.world, [
      'getBlock', 'isSolid', 'isOpaque', 'groundY', 'highestSolidY', 'surfaceY',
      'keys', 'getChunk', 'forEach', 'generatorId', 'pendingDirty',
    ] as const),
    get bounds() { return ctx.world.bounds; },
    setBlock: has('world.write') ? ctx.world.setBlock.bind(ctx.world) : deny('world.write'),
    setGenerator: has('world.write') ? ctx.world.setGenerator.bind(ctx.world) : deny('world.write'),
    pregenerate: has('world.write') ? ctx.world.pregenerate.bind(ctx.world) : deny('world.write'),
    toEnvelope: has('world.write') ? ctx.world.toEnvelope.bind(ctx.world) : deny('world.write'),
  };

  const blocks = {
    ...readonlyView(ctx.blocks, ['get', 'tileOf', 'labelOf', 'all', 'byName', 'byLocal', 'ownerCount'] as const),
    define: deny('world.write'), register: deny('world.write'), release: deny('world.write'),
  };

  const atlas = {
    ...readonlyView(ctx.atlas, ['tilePixels', 'uvRect'] as const),
    define: deny('world.write'), releaseKey: deny('world.write'),
  };

  const binary = {
    ...readonlyView(ctx.binary, ['names', 'owners', 'has', 'validate'] as const),
    register: has('binary.raw') ? ctx.binary.register.bind(ctx.binary) : deny('binary.raw'),
    claimTag: has('binary.raw') ? ctx.binary.claimTag.bind(ctx.binary) : deny('binary.raw'),
    decode: has('binary.raw') ? ctx.binary.decode.bind(ctx.binary) : deny('binary.raw'),
  };

  const host: Partial<IPluginHost> = {
    ...readonlyView(ctx.host, ['list', 'loadedIds', 'isLoaded', 'capabilities', 'impactOf'] as const),
    mount: has('host.mutate') ? ctx.host.mount.bind(ctx.host) : deny('host.mutate'),
    unmount: has('host.mutate') ? ctx.host.unmount.bind(ctx.host) : deny('host.mutate'),
    reload: has('host.mutate') ? ctx.host.reload.bind(ctx.host) : deny('host.mutate'),
    enable: has('host.mutate') ? ctx.host.enable.bind(ctx.host) : deny('host.mutate'),
    disable: has('host.mutate') ? ctx.host.disable.bind(ctx.host) : deny('host.mutate'),
  };

  const input = {
    get state() { return ctx.input.state; },
    get sensitivity() { return ctx.input.sensitivity; },
    get allowFly() { return ctx.input.allowFly; },
    isDown: ctx.input.isDown.bind(ctx.input),
  };
  const engine = {
    get fps() { return ctx.engine.fps; },
    get time() { return ctx.engine.time; },
    get errorCount() { return ctx.engine.errorCount; },
    get updateCount() { return ctx.engine.updateCount; },
    get renderCount() { return ctx.engine.renderCount; },
  };
  const events = {
    ...readonlyView(ctx.events, ['on', 'onDynamic', 'listenerCount'] as const),
    emit: (type: string, payload: unknown): void => emitSafe(type, payload, false),
    emitDynamic: (type: PluginEventKey, payload: unknown): void => emitSafe(type, payload, true),
  };

  const view: Record<string, unknown> = {
    scope, services, world, blocks, atlas, binary, host, input, engine, events,
    ui: readonlyView(ctx.ui, [
      'setHud', 'setTarget', 'setClock', 'setHotbarVisible',
      'setLocked', 'setTint', 'toast', 'renderHotbar', 'onStart',
    ] as const),
    cfg: ctx.cfg,
    config: ctx.config,
    pluginId: ctx.pluginId,
    log: ctx.log,
    capabilities: ctx.capabilities,
  };
  for (const c of ['scene', 'camera', 'renderer', 'wasm'] as const) {
    Object.defineProperty(view, c, {
      enumerable: true,
      get: has(c as PrivilegedCapability)
        ? () => ctx[c]
        : () => deny(c as PrivilegedCapability)(),
    });
  }

  return new Proxy(view, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor') {
        return Reflect.get(target, prop);
      }
      if (!(prop in target)) {
        throw new Error(`[sandbox] ${pluginId} 访问了未开放的上下文字段 ${String(prop)}`);
      }
      return Reflect.get(target, prop);
    },
    has: (t, p) => Reflect.has(t, p),
  }) as unknown as PluginContext;
}

/**
 * 包装运行时插件：声明（id / provides / dependencies / priority）完全不变，
 * 只把 setup 收到的 ctx 换成受限视图。宿主与清单无需知道沙箱细节。
 */
export function createSandboxedPlugin(plugin: Plugin, origin: string): Plugin {
  const requested = plugin.requiredCapabilities ?? [];
  const originalSetup = plugin.setup;
  return {
    ...plugin,
    meta: plugin.meta
      ? {
          ...plugin.meta,
          description: `[受限沙箱 · ${origin === 'pasted source' ? '粘贴源码' : '远程 URL'}] ${plugin.meta.description}`,
        }
      : undefined,
    setup(ctx: PluginContext): void | Promise<void> {
      const safe = createSandboxContext(ctx, plugin.id, requested);
      return originalSetup.call(plugin, safe);
    },
  };
}
