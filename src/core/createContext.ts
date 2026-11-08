import * as THREE from 'three';

import { BinaryHub } from '../binary/BinaryHub';
import { WasmHost } from '../binary/WasmHost';
import { ConfigStore } from './ConfigStore';
import { EventBus } from './EventBus';
import { Engine } from './Engine';
import { Input } from './Input';
import { PluginHost } from './PluginHost';
import { PluginGraph } from './PluginGraph';
import { Kernel } from '../kernel';
import type { IPluginHost, PluginContext } from './types';
import { ServiceRegistry } from './ServiceRegistry';
import { Ui } from './Ui';
import { FAR, FIXED_STEP, FOV, NEAR } from '../config';
import { TextureAtlas } from '../render/TextureAtlas';
import { BlockRegistry } from '../world/BlockRegistry';
import { World } from '../world/World';

export interface CoreBundle {
  ctx: PluginContext;
  host: PluginHost;
  core: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    events: EventBus;
    engine: Engine;
    services: ServiceRegistry;
    config: ConfigStore;
    blocks: BlockRegistry;
    world: World;
    atlas: TextureAtlas;
    binary: BinaryHub;
    wasm: WasmHost;
    /** v0.5：插件组件与世界组件共用的唯一 Cordis 内核 */
    kernel: Kernel;
    graph: PluginGraph;
  };
}

/**
 * 统一装配点。main.ts 不再手工 new 十几个对象，
 * 新增核心基础设施只改这里（而且插件无需感知）。
 */
export function createContext(canvas: HTMLCanvasElement): CoreBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // v0.3：柔和的高光压缩，让昼夜明暗过渡更像真实相机而不是硬切
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, NEAR, FAR);

  const events = new EventBus();
  const input = new Input(canvas);
  const engine = new Engine(FIXED_STEP);
  const ui = new Ui();
  const blocks = new BlockRegistry();
  const world = new World(blocks, events);
  const atlas = new TextureAtlas();
  const binary = new BinaryHub();
  const wasm = new WasmHost();
  const services = new ServiceRegistry(events);
  const config = new ConfigStore();

  // v0.5：单一共享内核。PluginHost 的插件组件与 CordisWorldPlugin 的世界组件
  // 全部登记进同一个 Kernel —— 一套 inject/provide 编排、一次 snapshot 看全生态。
  const kernel = new Kernel();
  const graph = new PluginGraph(kernel);

  const core = {
    renderer, scene, camera, events, engine, services, config,
    blocks, world, atlas, binary, wasm, input, ui, kernel, graph,
  };

  const deps = { events, engine, services, config, blocks, atlas, binary };
  let ctx!: PluginContext;
  const host = new PluginHost(() => ctx, deps, graph);

  ctx = {
    scene, camera, renderer, events, input, engine, ui,
    blocks, world, atlas, binary, wasm, services, config,
    scope: null as unknown as PluginContext['scope'], // 每个插件拿到的是自己的 view
    pluginId: 'core',
    cfg: config.namespace('core'),
    host: host as IPluginHost,
    capabilities: (name: string) => host.capabilities(name),
    log: (...args: unknown[]) => console.info('[voxel]', ...args),
  };

  return { ctx, host, core: core as CoreBundle['core'] };
}
