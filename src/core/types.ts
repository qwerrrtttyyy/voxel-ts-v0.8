import type * as THREE from 'three';
import type { EventBus } from './EventBus';
import type { Engine } from './Engine';
import type { Input } from './Input';
import type { Ui } from './Ui';
import type { PluginScope } from './PluginScope';
import type { ServiceRegistry } from './ServiceRegistry';
import type { ConfigStore, ConfigNamespace } from './ConfigStore';
import type { BlockRegistry } from '../world/BlockRegistry';
import type { World } from '../world/World';
import type { TextureAtlas } from '../render/TextureAtlas';
import type { BinaryHub } from '../binary/BinaryHub';
import type { WasmHost } from '../binary/WasmHost';
import type { PrivilegedCapability } from './Sandbox';

/** 插件能在运行时操作宿主的最小接口（避免插件直接依赖 PluginHost 实现） */
export interface IPluginHost {
  use(plugin: Plugin): void;
  useMany(plugins: readonly Plugin[]): void;
  mount(plugin: Plugin): Promise<void>;
  unmount(id: string): Promise<void>;
  reload(id: string): Promise<void>;
  enable(id: string): Promise<void>;
  /** v0.6：与 enable 对称；函数体同步执行，不 await 也不会残留状态 */
  disable(id: string): Promise<void>;
  isLoaded(id: string): boolean;
  loadedIds(): string[];
  list(): string[];
  capabilities(name?: string): string[];
  /**
   * v0.6：停用 / 卸载某插件会被连带停用的已加载插件（不含自身）。
   * 菜单开关据此给出可预览的影响面，不再让用户「点一下才发现停了一串」。
   */
  impactOf(id: string): string[];
}

/**
 * 插件能看到的全部世界。
 * 固定字段只放「基础设施」，业务能力一律走 services / events / scope，
 * 因此新增能力不需要再改这个接口。
 */
export interface PluginContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly events: EventBus;
  readonly input: Input;
  readonly engine: Engine;
  readonly ui: Ui;
  readonly blocks: BlockRegistry;
  readonly world: World;
  readonly atlas: TextureAtlas;
  readonly binary: BinaryHub;
  readonly wasm: WasmHost;
  /** 插件间服务注册 / 策略替换 */
  readonly services: ServiceRegistry;
  readonly config: ConfigStore;
  /** 当前插件专属：自动清理作用域，卸载时一键释放所有注册 */
  readonly scope: PluginScope;
  /** 当前插件 id（scope 里所有资源自动带这个 owner） */
  readonly pluginId: string;
  /** 当前插件的私有配置命名空间 */
  readonly cfg: ConfigNamespace;
  /** 宿主自身，支持运行时热插拔 */
  readonly host: IPluginHost;
  /** 查询哪些插件声明了某能力 */
  capabilities(name: string): string[];
  log(...args: unknown[]): void;
}

/** 插件清单元数据：主菜单「插件仓库」据此渲染，运行时远程插件同样带上 */
export interface PluginMeta {
  /** 展示名 */
  readonly label: string;
  readonly description: string;
  /** 分类标签，用于分组 */
  readonly category: 'core' | 'world' | 'gameplay' | 'render' | 'extension' | 'community' | 'remote';
  readonly author?: string;
  /** 是否默认启用（false 时用户可在仓库里手动开） */
  readonly defaultEnabled?: boolean;
  /** 内核必需：仓库里锁定开关，禁止卸载 */
  readonly required?: boolean;
  /** 图标用的短文本（1~2 个字符，不用图片资源） */
  readonly badge?: string;
}

export interface Plugin {
  readonly id: string;
  readonly version: string;
  /** v0.3：可选清单元数据，不提供时由 catalog 兜底生成 */
  readonly meta?: PluginMeta;
  /** 硬依赖：插件 id，或 `cap:能力名`（由 provides 声明） */
  readonly dependencies?: readonly string[];
  /** 可选依赖：缺失时静默降级，不阻止启动 */
  readonly optionalDependencies?: readonly string[];
  /** 本插件提供的能力名，供 `cap:` 依赖解析 */
  readonly provides?: readonly string[];
  /** 同一拓扑层级内的启动顺序，小的先跑；默认 0 */
  readonly priority?: number;
  /** 只用 scope / services 注册资源时，不需要写 dispose */
  setup(ctx: PluginContext): void | Promise<void>;
  /** 需要手动释放外部资源时才写；host 会在 scope.dispose 之后调用 */
  dispose?(): void;
  /**
   * v0.6：仅运行时热加载插件（url / source）需要声明的特权能力。
   * 默认只能注册命名空间资源、订阅事件、跑循环、读世界；申请 scene /
   * renderer / world.write / host.mutate 等会在安装期校验，未声明则 setup
   * 访问对应字段直接抛错。内置与扩展插件不经过沙箱，保持完全权限。
   */
  readonly requiredCapabilities?: readonly PrivilegedCapability[];
}
