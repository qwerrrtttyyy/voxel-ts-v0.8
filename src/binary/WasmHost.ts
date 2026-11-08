/**
 * WASM 宿主预留口。
 * 未来把地形生成器 / mesher / 光照换成 Rust / C++ 编译产物时，
 * 只需 WebAssembly.instantiate 出来的 exports 实现同一个接口，
 * 主循环、World、PluginHost 全都不用改。
 */
export interface WasmModuleHandle {
  readonly id: string;
  readonly instance: WebAssembly.Instance;
  readonly memory?: WebAssembly.Memory;
  readonly exports: WebAssembly.Exports;
}

export class WasmHost {
  private readonly modules = new Map<string, WasmModuleHandle>();

  async load(
    id: string,
    bytes: ArrayBuffer | Uint8Array,
    imports: WebAssembly.Imports = {},
  ): Promise<WasmModuleHandle> {
    // 复制成独立的 ArrayBuffer，避开 SharedArrayBuffer / 视图偏移的类型歧义
    const source: ArrayBuffer = bytes instanceof Uint8Array
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      : bytes.slice(0);
    const { instance } = await WebAssembly.instantiate(source, imports);
    const exp = instance.exports;
    const memory = 'memory' in exp && exp.memory instanceof WebAssembly.Memory
      ? exp.memory
      : undefined;
    const handle: WasmModuleHandle = { id, instance, memory, exports: exp };
    this.modules.set(id, handle);
    return handle;
  }

  get(id: string): WasmModuleHandle | undefined {
    return this.modules.get(id);
  }

  ids(): string[] {
    return [...this.modules.keys()];
  }

  /** v0.6：释放单个模块句柄；实例本身由 GC 回收，这里只解除强引用 */
  unload(id: string): boolean {
    return this.modules.delete(id);
  }

  /** v0.6：全局释放，供 HMR / 世界切换调用，避免 modules Map 只增不减 */
  dispose(): void {
    this.modules.clear();
  }
}
