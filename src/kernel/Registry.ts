import { Context } from './Context';
import { Fiber, type Resolution } from './Fiber';

/**
 * 组件 = 一个声明了「需要什么 / 提供什么」的纯函数。
 * 与常见插件系统不同：加载顺序**不参与**排序，顺序完全由 inject / provide
 * 推导出的依赖图决定（Config 里的书写顺序无语义）。
 */
export interface Component {
  readonly id: string;
  readonly inject?: readonly string[];
  readonly provide?: readonly string[];
  /** 逻辑分组（如 'plugin' / 'world'），仅供快照与门面分类，不参与排序 */
  readonly group?: string;
  readonly apply: (ctx: Context) => void;
}

interface Binding {
  value: unknown;
  provider: string;
}

export interface SettleReport {
  iterations: number;
  activated: string[];
  deactivated: string[];
  failed: string[];
  quiescent: boolean;
}

/** 观察等价用的规范化快照：只保留可观察状态，不含内部调度字段 */
export interface KernelSnapshot {
  active: string[];
  failed: string[];
  bindings: Array<[string, string]>;
  resolutions: Array<[string, string]>;
}

interface Plan {
  readonly id: string;
  readonly target: Resolution;
  readonly satisfiable: boolean;
  readonly changed: boolean;
  readonly deactivate: boolean;
  readonly activate: boolean;
}

/**
 * 反应式共效应内核。
 *
 * 四条可验证性质（对应论文 Theorem 16 / 70 / 73 / 80）：
 *  1. 恢复精确性：每个 Fiber 独享效应栈，undo(A) 不动 B 的绑定与效应。
 *  2. 有序性：停用按依赖深度降序（consumer 先），provider 的绑定在
 *     所有解析到它的 consumer 停用之前不会消失。
 *  3. 进展性：单轮用 committed 快照（inertial），每轮 dirty 严格收缩，
 *     有限名 + 无环依赖 ⇒ 必在有限步内到达静止（quiescent）。
 *  4. 汇聚性：终态只由最终绑定集合与 inject 声明决定，与调度顺序无关。
 *  另：失败即失败卸载 —— apply 抛错时撤销已执行的部分效应，标记 failed，
 *  不波及兄弟与父组件。
 */
export class Kernel {
  private readonly components = new Map<string, Component>();
  /** 持久化定义：disable 只移出活动表，enable 可以原样装回 */
  private readonly specs = new Map<string, Component>();
  private readonly fibers = new Map<string, Fiber>();
  private readonly bindings = new Map<string, Binding>();
  /**
   * 能力多提供者绑定：key → 贡献者集合。
   * 与单值 bindings 正交：`cap:` 依赖的语义是「至少一个提供者存在即可满足」，
   * 而 ctx.set() 的策略槽语义是「后写覆盖、按 provider 归属撤销」。
   * claimCap 的逆登记在 Fiber 效应栈里，停用组件时自动从集合移除。
   */
  private readonly caps = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private settling = false;
  private readonly maxIterations: number;

  constructor(opts: { maxIterations?: number } = {}) {
    this.maxIterations = opts.maxIterations ?? 256;
  }

  get componentIds(): string[] { return [...this.components.keys()]; }
  get fiberIds(): string[] { return [...this.fibers.keys()]; }
  fiberOf(id: string): Fiber | undefined { return this.fibers.get(id); }

  /** 登记组件；不立即激活，由 settle() 统一按依赖满足情况编排 */
  register(component: Component): Fiber {
    return this.registerAs(component.id, component, null);
  }

  /**
   * 休眠声明：登记定义 + Fiber，但既不进活动表、也不标脏。
   * 供「声明与启用分离」的宿主使用（如插件 use() 与 mount() 是两个时机），
   * 之后由 enable() 激活。幂等：重复声明返回同一个 Fiber。
   */
  declare(component: Component): Fiber {
    const id = component.id;
    const existing = this.fibers.get(id);
    if (existing) return existing;
    const spec: Component = { ...component, id };
    this.specs.set(id, spec);
    const fiber = new Fiber(id, spec.inject ?? [], null);
    this.fibers.set(id, fiber);
    return fiber;
  }

  /** 注册为某个父 Fiber 的子组件（ctx.plugin 用） */
  registerAs(id: string, component: Component, parent: Fiber | null): Fiber {
    if (this.components.has(id)) throw new Error(`[Kernel] component "${id}" already registered`);
    const spec: Component = { ...component, id };
    this.components.set(id, spec);
    this.specs.set(id, spec);
    const fiber = new Fiber(id, spec.inject ?? [], parent?.id ?? null);
    this.fibers.set(id, fiber);
    if (parent) parent.children.push(fiber);
    this.dirty.add(id);
    return fiber;
  }

  /** 注销组件；有序性由 settle 的停用顺序保证，这里只标记待停用集合 */
  unregister(id: string): void {
    if (!this.components.has(id)) return;
    for (const other of this.fibers.values()) {
      if (other.id === id) continue;
      if (Object.values(other.resolution).includes(id)) this.dirty.add(other.id);
    }
    this.dirty.add(id);
    this.components.delete(id);
  }

  /** 组件开关：停用走有序卸载，启用按依赖重新收敛；定义永久保留可反复切换 */
  isEnabled(id: string): boolean { return this.components.has(id); }

  disable(id: string, silent = false): void {
    if (!this.components.has(id)) return;
    this.unregister(id);
    this.settle();
    if (!silent) this.notifyObservers();
  }

  enable(id: string, silent = false): void {
    const spec = this.specs.get(id);
    if (!spec || this.components.has(id)) return;
    this.components.set(id, spec);
    // 重新加入的 provider 可能改变任何 consumer 的解析，全量重算最稳妥
    for (const fiberId of this.fibers.keys()) this.dirty.add(fiberId);
    this.settle();
    if (!silent) this.notifyObservers();
  }

  /**
   * silent=true 供插件宿主同步启用态：插件不是世界组件，其开关不应触发
   * onChange → 世界重建。世界组件（方块包 / 地形阶段）仍走默认全量通知。
   */
  setEnabled(id: string, enabled: boolean, silent = false): void {
    if (enabled) this.enable(id, silent); else this.disable(id, silent);
  }

  get enabledIds(): string[] { return [...this.components.keys()].sort(); }
  get specIds(): string[] { return [...this.specs.keys()].sort(); }

  /** 订阅组件拓扑 / 绑定变化（世界重建用），返回退订函数 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notifyObservers(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch (err) { console.warn('[Kernel] onChange listener threw', err); }
    }
  }

  /** 绑定一个 key，返回其逆（仅当仍由本 provider 持有才删除） */
  bind(key: string, value: unknown, provider: string): () => void {
    this.bindings.set(key, { value, provider });
    this.notifyKey(key);
    return () => {
      const current = this.bindings.get(key);
      if (current && current.provider === provider) {
        this.bindings.delete(key);
        this.notifyKey(key);
      }
    };
  }

  has(key: string): boolean {
    return this.bindings.has(key) || (this.caps.get(key)?.size ?? 0) > 0;
  }
  lookup<T>(key: string): T | undefined {
    const binding = this.bindings.get(key);
    return binding ? (binding.value as T) : undefined;
  }

  /**
   * 能力 key 的确定性代表：活跃贡献者里字典序最小者。
   * 只由「当前活跃集合」决定，与 claim 先后、激活顺序、调度顺序全部无关
   * —— 这是汇聚性 T80 的关键。没有活跃贡献者时返回 null。
   *
   * 供 Context.require() 作为「能力存在」的见证值（cap: 没有单值绑定，
   * lookup 恒为 undefined，故需要独立通道），也供宿主查询当前代表。
   */
  capRepresentative(key: string): string | null {
    return this.representativeOf(this.caps.get(key));
  }

  /** 从贡献者集合里挑确定性代表：过滤已注销者后取字典序最小 */
  private representativeOf(set: ReadonlySet<string> | undefined): string | null {
    if (!set || set.size === 0) return null;
    // 过滤掉「已 unregister 但尚未 settle 停用」的贡献者（其 claim 逆还未执行），
    // 保证代表只反映真正在活动表里的 provider，与 resolve 的单值分支口径一致。
    const active = [...set].filter((p) => this.components.has(p)).sort();
    return active[0] ?? null;
  }

  /**
   * 声明一个能力（cap:）贡献者。与单值 bind 不同，多个组件可共享同一 key：
   * 每个贡献者的逆登记在自己的 Fiber 效应栈里，停用时只移除自己，
   * 因此「关掉一个 generator，另一个还在」不会打断依赖者 —— 这正是插件
   * `provides: ['generator']` / `cap:generator` 的真实语义。
   */
  claimCap(key: string, provider: string): () => void {
    let set = this.caps.get(key);
    if (!set) { set = new Set<string>(); this.caps.set(key, set); }
    set.add(provider);
    this.notifyKey(key);
    return () => {
      const cur = this.caps.get(key);
      if (!cur) return;
      cur.delete(provider);
      if (cur.size === 0) this.caps.delete(key);
      this.notifyKey(key);
    };
  }

  /** 某能力的全部贡献者（已按 id 排序，稳定） */
  capProviders(key: string): string[] {
    const set = this.caps.get(key);
    return set ? [...set].sort() : [];
  }

  private notifyKey(key: string): void {
    for (const fiber of this.fibers.values()) {
      if (fiber.inject.includes(key)) this.dirty.add(fiber.id);
    }
  }

  /** 依赖闭包查询：停用 roots 时，所有（传递）依赖它们的组件，按依赖深度降序 */
  dependents(roots: readonly string[]): string[] {
    const target = new Set(roots);
    // consumer → 它当前解析到的 providers
    const edges = new Map<string, string[]>();
    for (const fiber of this.fibers.values()) {
      edges.set(fiber.id, Object.values(fiber.resolution).filter((p): p is string => !!p));
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, providers] of edges) {
        if (target.has(id)) continue;
        if (providers.some((p) => target.has(p))) { target.add(id); changed = true; }
      }
    }
    const depth = this.depths(target);
    return [...target].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0) || a.localeCompare(b));
  }

  /**
   * 某 key 在「本轮 caps 快照」下是否由至少一个活跃组件提供。
   * 返回**确定性代表**（活跃集合字典序最小），而非「首次 claim 者」：
   * 新增/移除非代表 provider 不改变返回值，因此依赖者的 resolution 稳定，
   * 既不会因同伴抖动反复 deactivate/reactivate（activate 会 reset 效应栈），
   * 也保证不同激活顺序的最终解析一致 —— 汇聚性 T80。
   */
  private capSatisfied(key: string, caps: ReadonlyMap<string, ReadonlySet<string>>): string | null {
    return this.representativeOf(caps.get(key));
  }

  private resolve(
    fiber: Fiber,
    committed: ReadonlyMap<string, Binding>,
    caps: ReadonlyMap<string, ReadonlySet<string>>,
  ): Resolution {
    const result: Record<string, string | null> = {};
    for (const key of fiber.inject) {
      const binding = committed.get(key);
      // 已注销的 provider 即使在 committed 快照里也视为「不可用」：
      // 否则 consumer 会在同一轮里看不到依赖消失，从而晚于 provider 停用（破坏有序性）。
      if (binding) {
        result[key] = this.components.has(binding.provider) ? binding.provider : null;
      } else {
        result[key] = this.capSatisfied(key, caps);
      }
    }
    return result;
  }

  private static same(a: Resolution, b: Resolution): boolean {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => a[k] === b[k]);
  }

  /**
   * 依赖深度：沿「已生效的 resolution」指向 provider，值越大越下游。
   * 用已生效而非本轮目标解析，才能在 provider 注销的那一轮仍正确表达
   * 「C 依赖 P」这条既有边，从而保证 consumer 先停用。
   */
  private depths(ids: Set<string>): Map<string, number> {
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const visit = (id: string): number => {
      const cached = depth.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0; // 环：防御性截断（进展性假设无环）
      visiting.add(id);
      let max = 0;
      for (const provider of Object.values(this.fibers.get(id)?.resolution ?? {})) {
        if (provider && provider !== id && ids.has(provider)) max = Math.max(max, 1 + visit(provider));
      }
      visiting.delete(id);
      depth.set(id, max);
      return max;
    };
    for (const id of ids) visit(id);
    return depth;
  }

  /**
   * 迭代到静止。单轮用同一份 committed 绑定快照（inertial 语义：
   * 过渡开始后，即使依赖状态又变，本轮也不会中途切换目标）。
   */
  settle(): SettleReport {
    // inertial：正在过渡时不重入；新的 dirty 留到调用方下一次 settle
    if (this.settling) {
      return { iterations: 0, activated: [], deactivated: [], failed: [], quiescent: false };
    }
    this.settling = true;
    const report: SettleReport = {
      iterations: 0, activated: [], deactivated: [], failed: [], quiescent: false,
    };
    try {
      while (this.dirty.size > 0 && report.iterations < this.maxIterations) {
        report.iterations++;
        const round = [...this.dirty];
        this.dirty.clear();
        const idSet = new Set(round);
        const committed = new Map(this.bindings);
        // 能力集合同样取快照（inertial）：本轮激活新声明的 cap 不影响本轮已解析的目标，
        // 但 claimCap 的 notifyKey 会把依赖者标 dirty，下一轮自然收敛。
        const capsSnapshot = new Map([...this.caps].map(([k, v]) => [k, new Set(v)] as const));

        const plans: Plan[] = [];
        for (const id of round) {
          const fiber = this.fibers.get(id);
          if (!fiber || fiber.state === 'disposed') continue;
          const target = this.resolve(fiber, committed, capsSnapshot);
          const satisfiable = Object.values(target).every((v) => v !== null);
          const exists = this.components.has(id);
          const changed = !Kernel.same(fiber.resolution, target);
          const deactivate = fiber.isActive && (!satisfiable || changed || !exists);
          // failed 不自动重试（保持失败态直到解析结果变化），否则会无限重激活，破坏进展性
          const activate = exists && satisfiable && (changed || fiber.state === 'inactive');
          plans.push({ id, target, satisfiable, changed, deactivate, activate });
        }

        const depth = this.depths(idSet);
        const byDepthDesc = (a: Plan, b: Plan): number =>
          (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) || a.id.localeCompare(b.id);
        const byDepthAsc = (a: Plan, b: Plan): number =>
          (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.id.localeCompare(b.id);

        // 有序性：先按依赖深度降序停用（consumer 先于 provider），再升序激活（provider 先）
        for (const plan of [...plans].filter((p) => p.deactivate).sort(byDepthDesc)) {
          const fiber = this.fibers.get(plan.id);
          if (!fiber) continue;
          fiber.effects.undo();
          fiber.state = 'inactive';
          fiber.resolution = {};
          fiber.committed = {};
          report.deactivated.push(plan.id);
        }
        for (const plan of [...plans].filter((p) => p.activate).sort(byDepthAsc)) {
          const fiber = this.fibers.get(plan.id);
          const component = this.components.get(plan.id);
          if (!fiber || !component) continue;
          this.activate(fiber, component, plan.target, report);
        }
        for (const plan of plans) {
          const fiber = this.fibers.get(plan.id);
          if (fiber && !fiber.isActive) fiber.resolution = plan.target;
        }
      }
      report.quiescent = this.dirty.size === 0 && report.iterations < this.maxIterations;
      return report;
    } finally {
      this.settling = false;
    }
  }

  private activate(fiber: Fiber, component: Component, target: Resolution, report: SettleReport): void {
    fiber.effects.reset();
    fiber.generation++;
    fiber.resolution = target;
    fiber.committed = target;
    fiber.error = undefined;
    const ctx = new Context(this, fiber);
    try {
      component.apply(ctx);
      fiber.state = 'active';
      report.activated.push(fiber.id);
    } catch (err) {
      // 失败即失败卸载：撤销已执行的部分效应，错误留在 fiber 上，不波及兄弟 / 父
      fiber.effects.undo();
      fiber.state = 'failed';
      fiber.error = err;
      report.failed.push(fiber.id);
    }
  }

  /** 可观察状态：用于汇聚性断言（不同调度顺序应得到相同快照） */
  snapshot(): KernelSnapshot {
    const canonical = (r: Resolution): string =>
      Object.entries(r).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v ?? '-'}`).join(',');
    return {
      active: [...this.fibers.values()].filter((f) => f.isActive).map((f) => f.id).sort(),
      failed: [...this.fibers.values()].filter((f) => f.state === 'failed').map((f) => f.id).sort(),
      bindings: [
        ...[...this.bindings.entries()].map(([k, b]) => [k, b.provider] as [string, string]),
        ...[...this.caps.entries()].map(([k, s]) => [k, [...s].sort().join('+')] as [string, string]),
      ].sort(([a], [b]) => a.localeCompare(b)),
      resolutions: [...this.fibers.values()].filter((f) => f.isActive)
        .map((f) => [f.id, canonical(f.resolution)] as [string, string])
        .sort(([a], [b]) => a.localeCompare(b)),
    };
  }

  /** 全局卸载：按依赖深度降序停用，保证 provider 最后释放 */
  dispose(): void {
    for (const id of this.fibers.keys()) this.dirty.add(id);
    this.components.clear();
    this.settle();
    for (const fiber of this.fibers.values()) {
      if (fiber.effects.size > 0) fiber.effects.undo();
      fiber.state = 'disposed';
    }
    this.bindings.clear();
    this.caps.clear();
    this.dirty.clear();
    this.specs.clear();
    this.listeners.clear();
  }
}
