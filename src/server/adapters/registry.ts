import type { SourceAdapter } from "./types.js";

/**
 * Provider registry: maps a provider id -> its adapter instance.
 * Adapters self-register on import (see ./index.ts).
 */
const registry = new Map<string, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
  if (registry.has(adapter.provider)) {
    throw new Error(`Adapter already registered for provider "${adapter.provider}"`);
  }
  registry.set(adapter.provider, adapter);
}

export function getAdapter(provider: string): SourceAdapter | undefined {
  return registry.get(provider);
}

export function requireAdapter(provider: string): SourceAdapter {
  const adapter = registry.get(provider);
  if (!adapter) {
    throw new Error(
      `No adapter registered for provider "${provider}". Did you forget to import it in adapters/index.ts?`,
    );
  }
  return adapter;
}

export function listAdapters(): SourceAdapter[] {
  return [...registry.values()];
}

export function listProviders(): string[] {
  return [...registry.keys()];
}
