/**
 * Cordis 风格内核验收：把论文的四条定理落成可执行断言。
 *   Theorem 16 恢复精确性 / Theorem 70 有序性
 *   Theorem 73 进展性   / Theorem 80 汇聚性
 * 另测逆元律、结合律、反应式共效应、失败隔离、父子级联、inertial 语义。
 *
 * 运行：esbuild tools/verify-cordis.ts --bundle --platform=node --format=cjs \
 *         --outfile=.verify-cordis.cjs --log-level=error && node .verify-cordis.cjs
 */
import { EffectStack, Kernel, type Component, type KernelSnapshot, type SettleReport } from '../src/kernel';

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  ${name}  · ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ok(cond: boolean, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg);
}

function eq(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(msg ?? `expected ${b}, got ${a}`);
}

const setter = (id: string, key: string, value: unknown, extra?: (ctx: unknown) => void): Component => ({
  id,
  apply(ctx) {
    ctx.set(key, value);
    extra?.(ctx);
  },
});

// ---------------------------------------------------------------- 逆元律 / 恢复精确性
test('效应栈：逆元律 + LIFO 逆序 + 状态精确恢复', () => {
  const s = { a: 0, b: 0, c: 0 };
  const log: string[] = [];
  const stack = new EffectStack();
  stack.effect('a', () => { s.a = 1; log.push('a+'); return () => { s.a = 0; log.push('a-'); }; });
  stack.effect('b', () => { s.b = 2; log.push('b+'); return () => { s.b = 0; log.push('b-'); }; });
  stack.effect('c', () => { s.c = 3; log.push('c+'); return () => { s.c = 0; log.push('c-'); }; });
  eq(stack.labels, ['a', 'b', 'c']);
  eq(stack.undo(), ['c', 'b', 'a']);
  eq(log, ['a+', 'b+', 'c+', 'c-', 'b-', 'a-']);
  eq(s, { a: 0, b: 0, c: 0 });
  stack.reset();
  eq(stack.size, 0);
  eq(stack.isUndone, false);
});

test('恢复精确性 T16：交错效应后只撤销 A，B 的绑定与效应保持不变', () => {
  const k = new Kernel();
  const log: string[] = [];
  k.register({
    id: 'A', provide: ['ka'],
    apply(ctx) {
      ctx.set('ka', 1);
      ctx.effect('A:work', () => { log.push('A+'); return () => log.push('A-'); });
    },
  });
  k.register({
    id: 'B', provide: ['kb'],
    apply(ctx) {
      ctx.set('kb', 2);
      ctx.effect('B:work', () => { log.push('B+'); return () => log.push('B-'); });
    },
  });
  k.settle();
  ok(k.fiberOf('A')!.isActive && k.fiberOf('B')!.isActive);
  k.unregister('A');
  k.settle();
  ok(!k.has('ka'), 'A 的绑定应被撤销');
  ok(k.has('kb'), 'B 的绑定不应被触碰');
  ok(log.includes('A-') && !log.includes('B-'), '只应执行 A 的逆');
  ok(k.fiberOf('B')!.isActive, 'B 应保持激活');
});

// ---------------------------------------------------------------- 有序性
test('有序性 T70：provider 的绑定在其所有 consumer 停用之后才释放', () => {
  const k = new Kernel();
  const order: string[] = [];
  k.register({
    id: 'P', provide: ['db'],
    apply(ctx) {
      ctx.set('db', 'conn');
      ctx.effect('P:down', () => () => order.push('P-down'));
    },
  });
  k.register({
    id: 'C', inject: ['db'],
    apply(ctx) {
      ctx.require('db');
      ctx.effect('C:down', () => () => order.push('C-down'));
    },
  });
  k.settle();
  ok(k.fiberOf('C')!.isActive, 'C 应在依赖满足后激活');
  k.unregister('P');
  k.settle();
  eq(order.slice(0, 2), ['C-down', 'P-down'], 'consumer 必须先于 provider 停用');
  ok(!k.has('db'));
  ok(!k.fiberOf('C')!.isActive);
});

// ---------------------------------------------------------------- 进展性
test('进展性 T73：乱序注册的链式依赖在有限步内收敛，provider 先激活', () => {
  const k = new Kernel();
  k.register({ id: 'C', inject: ['b'], apply(ctx) { ctx.require('b'); ctx.set('c', 1); } });
  k.register({ id: 'B', inject: ['a'], apply(ctx) { ctx.require('a'); ctx.set('b', 1); } });
  k.register({ id: 'A', apply(ctx) { ctx.set('a', 1); } });
  const report = k.settle();
  ok(report.quiescent, '应到达静止状态');
  ok(report.iterations > 0 && report.iterations <= 10, `迭代应有界，实际 ${report.iterations}`);
  ok(k.fiberOf('A')!.isActive && k.fiberOf('B')!.isActive && k.fiberOf('C')!.isActive);
  const a = report.activated;
  ok(a.indexOf('A') < a.indexOf('B') && a.indexOf('B') < a.indexOf('C'), '激活顺序须 A → B → C');
});

test('进展性 T73：环形依赖不死锁，双方在有限步内静止且保持未激活', () => {
  const k = new Kernel({ maxIterations: 32 });
  k.register({ id: 'A', inject: ['b'], provide: ['a'], apply(ctx) { ctx.set('a', 1); } });
  k.register({ id: 'B', inject: ['a'], provide: ['b'], apply(ctx) { ctx.set('b', 1); } });
  const report = k.settle();
  ok(report.quiescent, '环不应导致无限迭代');
  ok(report.iterations <= 5, `迭代 ${report.iterations}`);
  ok(!k.fiberOf('A')!.isActive && !k.fiberOf('B')!.isActive);
  ok(!k.has('a') && !k.has('b'));
});

test('进展性 T73：failed fiber 不被反复重激活', () => {
  const k = new Kernel({ maxIterations: 32 });
  let attempts = 0;
  k.register({ id: 'Boom', apply() { attempts++; throw new Error('boom'); } });
  const first = k.settle();
  eq(first.failed, ['Boom']);
  eq(attempts, 1);
  const second = k.settle();
  ok(second.quiescent && second.iterations === 0, '静止后不应再产生迭代');
  eq(attempts, 1, '失败组件不得被自动重试');
});

// ---------------------------------------------------------------- 汇聚性
test('汇聚性 T80：不同注册/注销调度顺序得到观察等价的终态', () => {
  const make = (): Record<string, Component> => ({
    A: { id: 'A', apply(ctx) { ctx.set('a', 1); } },
    B: { id: 'B', inject: ['a'], apply(ctx) { ctx.require('a'); ctx.set('b', 2); } },
    C: { id: 'C', inject: ['a', 'b'], apply(ctx) { ctx.require('a'); ctx.require('b'); ctx.set('c', 3); } },
  });
  const run = (order: string[]): KernelSnapshot => {
    const k = new Kernel();
    const comps = make();
    for (const id of order) k.register(comps[id]);
    k.settle();
    k.unregister('B');
    k.settle();
    k.register(comps.B); // 重新注册同一组件
    k.settle();
    return k.snapshot();
  };
  const s1 = run(['A', 'B', 'C']);
  const s2 = run(['C', 'A', 'B']);
  const s3 = run(['B', 'C', 'A']);
  eq(s1, s2, '注册顺序不应影响终态');
  eq(s2, s3, '注册顺序不应影响终态');
  eq(s1.active, ['A', 'B', 'C']);
});

test('汇聚性 T80：热插拔过的系统与从头静态装配的系统终态一致', () => {
  const build = (hot: boolean): KernelSnapshot => {
    const k = new Kernel();
    k.register({ id: 'P', apply(ctx) { ctx.set('db', 'v1'); } });
    k.register({ id: 'C', inject: ['db'], apply(ctx) { ctx.require('db'); ctx.set('out', 1); } });
    k.settle();
    if (hot) {
      k.unregister('P'); k.settle();
      k.register({ id: 'P', apply(ctx) { ctx.set('db', 'v2'); } }); k.settle();
      k.unregister('C'); k.settle();
      k.register({ id: 'C', inject: ['db'], apply(ctx) { ctx.require('db'); ctx.set('out', 1); } }); k.settle();
    }
    return k.snapshot();
  };
  eq(build(true), build(false));
});

// ---------------------------------------------------------------- 反应式共效应
test('反应式共效应：provider 换绑后 consumer 重解析并重激活', () => {
  const k = new Kernel();
  k.register({ id: 'P1', apply(ctx) { ctx.set('db', 'one'); } });
  k.register({ id: 'C', inject: ['db'], apply(ctx) { ctx.require('db'); } });
  k.settle();
  eq(k.fiberOf('C')!.resolution, { db: 'P1' });
  const g0 = k.fiberOf('C')!.generation;
  k.register({ id: 'P2', apply(ctx) { ctx.set('db', 'two'); } });
  k.settle();
  ok(k.fiberOf('C')!.generation > g0, '解析变化应触发重新激活');
  eq(k.fiberOf('C')!.resolution.db, 'P2');
  eq(k.lookup('db'), 'two');
});

test('反应式共效应：依赖消失时 consumer 自动停用，恢复后自动激活', () => {
  const k = new Kernel();
  k.register({ id: 'P', apply(ctx) { ctx.set('db', 1); } });
  k.register({ id: 'C', inject: ['db'], apply(ctx) { ctx.require('db'); } });
  k.settle();
  ok(k.fiberOf('C')!.isActive);
  k.unregister('P'); k.settle();
  ok(!k.fiberOf('C')!.isActive, '依赖缺失应保持非活跃而不崩溃');
  k.register({ id: 'P', apply(ctx) { ctx.set('db', 2); } }); k.settle();
  ok(k.fiberOf('C')!.isActive, '依赖恢复应自动激活');
});

test('bind 逆的归属保护：先提供者卸载不能删掉后来者的绑定', () => {
  const k = new Kernel();
  k.register({ id: 'A', apply(ctx) { ctx.set('k', 'a'); } });
  k.settle();
  k.register({ id: 'B', apply(ctx) { ctx.set('k', 'b'); } });
  k.settle();
  eq(k.lookup('k'), 'b');
  k.unregister('A'); k.settle();
  eq(k.lookup('k'), 'b', 'A 的逆不应删除 B 持有的绑定');
});

// ---------------------------------------------------------------- 失败隔离 / inertial / 组合
test('失败隔离：apply 抛错时撤销部分效应，且不波及兄弟与父', () => {
  const k = new Kernel();
  k.register({ id: 'Boom', apply(ctx) { ctx.set('x', 1); throw new Error('boom'); } });
  k.register({ id: 'Fine', apply(ctx) { ctx.set('y', 2); } });
  const report = k.settle();
  eq(report.failed, ['Boom']);
  ok(k.fiberOf('Fine')!.isActive, '兄弟组件应正常激活');
  ok(!k.has('x'), '失败前登记的部分效应必须被撤销');
  ok(k.has('y'));
  ok(k.fiberOf('Boom')!.error instanceof Error);
});

test('inertial 语义：过渡中的嵌套 settle 不重入、不破坏状态', () => {
  const k = new Kernel();
  let inner: SettleReport | null = null;
  k.register({ id: 'A', apply(ctx) { ctx.set('a', 1); inner = k.settle(); } });
  const outer = k.settle();
  ok(inner !== null);
  ok(!inner!.quiescent, '嵌套调用应被 inertial 挡回而非重入');
  ok(outer.quiescent);
  ok(k.fiberOf('A')!.isActive && k.has('a'));
});

test('空间可组合性：ctx.plugin 派生子 Context，父卸载级联子', () => {
  const k = new Kernel();
  k.register({
    id: 'Parent',
    apply(ctx) {
      ctx.plugin({ id: 'Child', apply(c) { c.set('childKey', 1); } });
      ctx.set('parentKey', 2);
    },
  });
  k.settle();
  ok(k.has('childKey') && k.has('parentKey'));
  ok(k.fiberOf('Parent/Child')!.isActive);
  k.unregister('Parent'); k.settle();
  ok(!k.has('childKey'), '子组件的绑定应随父级联释放');
  ok(!k.has('parentKey'));
});

test('结合律：嵌套子 Context 与平铺装配得到相同的可观察绑定', () => {
  const flat = new Kernel();
  flat.register(setter('P', 'a', 1));
  flat.register({ id: 'C', inject: ['a'], apply(ctx) { ctx.require('a'); ctx.set('b', 2); } });
  flat.settle();

  const nested = new Kernel();
  nested.register({
    id: 'Root',
    apply(ctx) {
      ctx.plugin(setter('P', 'a', 1));
      ctx.plugin({ id: 'C', inject: ['a'], apply(c) { c.require('a'); c.set('b', 2); } });
    },
  });
  nested.settle();
  eq(flat.lookup('a'), nested.lookup('a'));
  eq(flat.lookup('b'), nested.lookup('b'));
  ok(flat.has('a') && flat.has('b') && nested.has('a') && nested.has('b'));
});

test('Proxy 服务解析：ctx.svc.foo ≡ ctx.get("foo")', () => {
  const k = new Kernel();
  let seen: unknown = null;
  k.register({ id: 'P', apply(ctx) { ctx.set('foo', 42); } });
  k.register({ id: 'C', inject: ['foo'], apply(ctx) { seen = ctx.svc.foo; } });
  k.settle();
  eq(seen, 42);
});

test('幂等：静止后再次 settle 不产生任何激活/停用', () => {
  const k = new Kernel();
  k.register(setter('A', 'a', 1));
  k.settle();
  const again = k.settle();
  eq(again.activated, []);
  eq(again.deactivated, []);
  ok(again.quiescent && again.iterations === 0);
});

test('全局 dispose：按依赖顺序全部回滚并清空绑定', () => {
  const k = new Kernel();
  k.register(setter('P', 'db', 1));
  k.register({ id: 'C', inject: ['db'], apply(ctx) { ctx.require('db'); ctx.set('out', 1); } });
  k.settle();
  k.dispose();
  ok(!k.has('db') && !k.has('out'));
  ok(k.fiberIds.every((id) => k.fiberOf(id)!.state === 'disposed'));
});

test('声明式依赖：加载顺序不参与排序（配置顺序无语义）', () => {
  const run = (reverse: boolean): string[] => {
    const k = new Kernel();
    const comps: Component[] = [
      { id: 'Leaf', inject: ['mid'], apply(ctx) { ctx.require('mid'); } },
      { id: 'Mid', inject: ['root'], apply(ctx) { ctx.require('root'); ctx.set('mid', 1); } },
      { id: 'Root', apply(ctx) { ctx.set('root', 1); } },
    ];
    for (const c of reverse ? [...comps].reverse() : comps) k.register(c);
    k.settle();
    return k.snapshot().active;
  };
  eq(run(false), run(true));
  eq(run(false), ['Leaf', 'Mid', 'Root']);
});

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
