import type { AIBackend } from "@chorus/core";

/** Lookup for available backends. The orchestrator resolves by id only. */
export class BackendRegistry {
  private readonly backends = new Map<string, AIBackend>();

  register(backend: AIBackend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: string): AIBackend {
    const b = this.backends.get(id);
    if (!b) throw new Error(`Unknown backend: ${id}`);
    return b;
  }

  has(id: string): boolean {
    return this.backends.has(id);
  }

  ids(): string[] {
    return [...this.backends.keys()];
  }
}
