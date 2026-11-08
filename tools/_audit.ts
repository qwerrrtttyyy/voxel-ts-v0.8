import { EventBus } from '../src/core/EventBus';
import { BinaryHub } from '../src/binary/BinaryHub';
import { BlockRegistry, AIR_ID } from '../src/world/BlockRegistry';
import { World } from '../src/world/World';
import type { IGenerator } from '../src/world/IGenerator';

const flat = (id: number): IGenerator => ({ id: 'flat', surfaceY: () => 5, blockAt: (_x, y, _z, s) => y <= s ? id : AIR_ID });

console.log('=== A. 方块 id 释放后的世界数据（修正观测口径） ===');
{
  const blocks = new BlockRegistry();
  const world = new World(blocks, new EventBus());
  const stone = blocks.define('pack.a', 'stone', { opaque: true, solid: true, all: 'x' });
  world.setGenerator(flat(stone));
  world.pregenerate();
  const before = world.getBlock(3, 3, 3);
  blocks.release(stone);
  const afterRelease = world.getBlock(3, 3, 3);
  const dirtyAfterRelease = world.pendingDirty;
  const lava = blocks.define('pack.b', 'lava', { opaque: true, solid: true, all: 'y' });
  const afterReuse = world.getBlock(3, 3, 3);
  console.log(JSON.stringify({ before, afterRelease, afterReuse, dirtyAfterRelease,
    registryNameForId: blocks.get(stone).name, reusedId: lava,
    verdict: afterRelease === AIR_ID && afterReuse === AIR_ID ? '世界体素已清洗，无幽灵替换' : '仍存在幽灵替换' }));
}

console.log('=== B. 信封 CRC 篡改检测 ===');
{
  const hub = new BinaryHub();
  const payload = new Uint8Array([1, 2, 3, 4, 5]).buffer as ArrayBuffer;
  const buf = hub.encode([{ tag: 0x1234, payload }]);
  const ok = hub.decode(buf).length;
  const copy = buf.slice(0);
  new Uint8Array(copy)[8] ^= 0x01; // 篡改 body（非尾部 CRC）
  let caught = '';
  try { hub.decode(copy); } catch (e) { caught = (e as Error).message; }
  console.log(JSON.stringify({ normalSegments: ok, tamperError: caught, hasFromEnvelope: typeof (World.prototype as any).fromEnvelope === 'function' }));
}

console.log('=== C. 插件生命周期事件实际发出的 phase ===');
{
  const src = require('fs').readFileSync('src/core/PluginHost.ts', 'utf8');
  const phases = [...src.matchAll(/phase:\s*'([^']+)'/g)].map((m: any) => m[1]);
  console.log(JSON.stringify({ emittedPhases: [...new Set(phases)] }));
}
