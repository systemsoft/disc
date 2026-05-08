import type { SchemaTypeDescription } from "$lib/api/client";
import { discAPI } from "$lib/api/client";
import { derived, get, writable } from "svelte/store";

export const schemaTypes = writable<SchemaTypeDescription[]>([]);
export const selectedType = writable<SchemaTypeDescription | null>(null);
export const schemaLoading = writable(false);
export const schemaError = writable<string | null>(null);

export const typeNames = derived(
  schemaTypes,
  $schemaTypes => $schemaTypes.map(t => t.name).sort()
);

export async function loadSchema() {
  schemaLoading.set(true);
  schemaError.set(null);

  try {
    const description = await discAPI.getSchema();
    schemaTypes.set(description.types);

    if (description.types.length > 0) {
      selectedType.set(description.types[0]);
    }
  } catch (error) {
    schemaError.set(
      error instanceof Error ? error.message : "Failed to load schema"
    );
  } finally {
    schemaLoading.set(false);
  }
}

// Select a type by name.
//
// P1-26: previously this called schemaTypes.subscribe(...)() — which is
// idiomatic Svelte only when the returned unsubscribe function is captured
// and later called. Invoking the outer IIFE just tossed the unsubscribe
// away so every call leaked a listener. `get()` reads the current value
// without subscribing.
export function selectTypeByName(name: string) {
  const types = get(schemaTypes);
  const type = types.find(t => t.name === name);
  if (type) {
    selectedType.set(type);
  }
}
