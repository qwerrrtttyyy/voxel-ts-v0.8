export type UpdateFn = (dt: number) => void;
export type RenderFn = (alpha: number, elapsed: number) => void;
export type Unregister = () => void;

/** 显式阶段，取代「谁最后注册谁最后跑」的隐式约定 */
export type UpdatePhase = 'input' | 'simulate' | 'late';
export type RenderPhase = 'before' | 'main' | 'after';

export interface ScheduleOptions<P extends string> {
  phase?: P;
  /** 同阶段内升序执行，数字小的先跑；默认 0 */
  priority?: number;
  /**
   * v0.6：每 N 次 tick 执行一次，默认 1。
   * 低频插件（HUD、统计、环境动画）不必每帧空转，是插件机最直接的省电开关。
   */
  every?: number;
  /** v0.6：回调统计标签；PluginScope 会自动注入插件 id，便于按插件聚合耗时 */
  label?: string;
  /** v0.6：单次执行超过该毫秒数记一次慢回调，默认 16ms（0 关闭统计告警） */
  budgetMs?: number;
}

export type UpdateOptions = ScheduleOptions<UpdatePhase>;
export type RenderOptions = ScheduleOptions<RenderPhase>;

/** 单个回调的累计耗时画像，供 HUD / 自检 / 插件市场观测 */
export interface CallbackStat {
  label: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  slow: number;
}

const UPDATE_ORDER: readonly UpdatePhase[] = ['input', 'simulate', 'late'];
const RENDER_ORDER: readonly RenderPhase[] = ['before', 'main', 'after'];

interface Task<T> {
  fn: T;
  phase: string;
  priority: number;
  seq: number;
  every: number;
  tick: number;
  /** v0.6：被跳过的 tick 的 dt 累加，低频回调收到真实经过时间 */
  pendingDt: number;
  label: string;
  budgetMs: number;
}

/**
 * 固定步长 update + 每帧 render 的主循环。
 * 阶段 + 优先级让插件可以声明位置，不用再靠注册顺序碰运气。
 *
 * v0.6 性能加固：
 *  - 回调列表用「脏标记 + 快照」：注册/注销时才复制，不再每帧 `[...list]` 分配数组
 *  - `every` 让低频插件跨帧跳过，回调根本不进调用栈
 *  - 逐回调计时画像（calls / total / max / slow），慢插件第一时间可见
 *  - 单个回调异常仍被隔离，且 finally 保证 rAF 永不断链
 */
export class Engine {
  private readonly updates: Task<UpdateFn>[] = [];
  private readonly renders: Task<RenderFn>[] = [];
  private updateSnap: Task<UpdateFn>[] = [];
  private renderSnap: Task<RenderFn>[] = [];
  private dirtyU = true;
  private dirtyR = true;
  private raf = 0;
  private last = -1;
  private accumulator = 0;
  private elapsed = 0;
  private frames = 0;
  private fpsTimer = 0;
  private _fps = 0;
  private running = false;
  private seq = 0;
  private errorHandler: ((err: unknown, where: string) => void) | null = null;
  /** 累计被隔离的回调异常数，便于 HUD / 自检观测 */
  private _errorCount = 0;
  private readonly stats = new Map<string, CallbackStat>();

  constructor(private readonly step: number) {}

  /** 注册统一错误上报；未注册时退化为 console.error */
  setErrorHandler(fn: ((err: unknown, where: string) => void) | null): void {
    this.errorHandler = fn;
  }

  get errorCount(): number { return this._errorCount; }

  /** 按标签聚合的回调耗时画像（返回副本，调用方可安全持有） */
  get callbackStats(): CallbackStat[] {
    return [...this.stats.values()].map((s) => ({ ...s }));
  }

  resetStats(): void { this.stats.clear(); }

  /**
   * 单个回调隔离执行 + 计时。插件架构下任何一个第三方回调抛错，
   * 都不允许中断同一帧的其余回调，更不允许中断 rAF 调度。
   */
  /** v0.8：泛型 Task 取代 `Task<unknown>` + 双重 `as`，编译期保证 fn 与任务同型 */
  private invoke<T>(task: Task<T>, fn: () => void, where: string): void {
    const t0 = performance.now();
    try { fn(); }
    catch (err) {
      this._errorCount++;
      if (this.errorHandler) {
        try { this.errorHandler(err, where); } catch { /* 上报器本身也不能拖垮循环 */ }
      } else {
        console.error(`[Engine] ${where} threw`, err);
      }
    } finally {
      const ms = performance.now() - t0;
      let s = this.stats.get(task.label);
      if (!s) {
        s = { label: task.label, calls: 0, totalMs: 0, maxMs: 0, slow: 0 };
        this.stats.set(task.label, s);
      }
      s.calls++;
      s.totalMs += ms;
      if (ms > s.maxMs) s.maxMs = ms;
      if (task.budgetMs > 0 && ms > task.budgetMs) {
        s.slow++;
        if (s.slow === 1) console.warn(`[Engine] 慢回调 ${task.label}: ${ms.toFixed(2)}ms`);
      }
    }
  }

  onUpdate(fn: UpdateFn, opts: UpdateOptions = {}): Unregister {
    return this.add(this.updates, fn, opts.phase ?? 'simulate', opts, UPDATE_ORDER);
  }

  onRender(fn: RenderFn, opts: RenderOptions = {}): Unregister {
    return this.add(this.renders, fn, opts.phase ?? 'main', opts, RENDER_ORDER);
  }

  get fps(): number { return this._fps; }
  get time(): number { return this.elapsed; }
  get updateCount(): number { return this.updates.length; }
  get renderCount(): number { return this.renders.length; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    this.accumulator = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private add<T>(
    list: Task<T>[],
    fn: T,
    phase: string,
    opts: ScheduleOptions<string>,
    order: readonly string[],
  ): Unregister {
    const isUpdate = order === UPDATE_ORDER;
    const task: Task<T> = {
      fn,
      phase,
      priority: opts.priority ?? 0,
      seq: this.seq++,
      every: Math.max(1, Math.floor(opts.every ?? 1)),
      tick: 0,
      pendingDt: 0,
      label: opts.label ?? `${isUpdate ? 'update' : 'render'}#${this.seq}`,
      budgetMs: opts.budgetMs ?? 16,
    };
    list.push(task);
    list.sort((a, b) =>
      order.indexOf(a.phase as never) - order.indexOf(b.phase as never)
      || a.priority - b.priority
      || a.seq - b.seq,
    );
    this.markDirty(isUpdate);
    return () => {
      const i = list.indexOf(task);
      if (i >= 0) list.splice(i, 1);
      this.markDirty(isUpdate);
    };
  }

  private markDirty(isUpdate: boolean): void {
    if (isUpdate) this.dirtyU = true;
    else this.dirtyR = true;
  }

  private snapshots(): void {
    if (this.dirtyU) { this.updateSnap = [...this.updates]; this.dirtyU = false; }
    if (this.dirtyR) { this.renderSnap = [...this.renders]; this.dirtyR = false; }
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    // finally 保证下一帧一定被调度：即便 Engine 自身逻辑抛错，主循环也不会冻结。
    try {
      if (this.last < 0) this.last = now;

      let dt = (now - this.last) / 1000;
      this.last = now;
      if (dt > 0.1) dt = 0.1;

      this.elapsed += dt;
      this.accumulator += dt;
      this.frames++;
      this.fpsTimer += dt;
      if (this.fpsTimer >= 0.5) {
        this._fps = Math.round(this.frames / this.fpsTimer);
        this.frames = 0;
        this.fpsTimer = 0;
      }

      this.snapshots();

      let steps = 0;
      while (this.accumulator >= this.step && steps < 8) {
        for (const t of this.updateSnap) {
          t.tick++;
          t.pendingDt += this.step;
          if (t.every > 1 && t.tick % t.every !== 0) continue;
          const dt = t.pendingDt;
          t.pendingDt = 0;
          this.invoke(t, () => t.fn(dt), 'update');
        }
        this.accumulator -= this.step;
        steps++;
      }
      if (steps === 8) this.accumulator = 0;

      const alpha = this.accumulator / this.step;
      for (const t of this.renderSnap) {
        t.tick++;
        if (t.every > 1 && t.tick % t.every !== 0) continue;
        this.invoke(t, () => t.fn(alpha, this.elapsed), 'render');
      }
    } finally {
      if (this.running) this.raf = requestAnimationFrame(this.frame);
    }
  };
}
