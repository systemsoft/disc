import { writable, derived } from 'svelte/store';
import type { SchemaType } from '$lib/api/client';
import { discAPI } from '$lib/api/client';

// Store for all schema types
export const schemaTypes = writable<SchemaType[]>([]);

// Store for selected type
export const selectedType = writable<SchemaType | null>(null);

// Loading state
export const schemaLoading = writable(false);

// Error state
export const schemaError = writable<string | null>(null);

// Derived store for type names
export const typeNames = derived(
  schemaTypes,
  ($schemaTypes) => $schemaTypes.map(t => t.name).sort()
);

// Load schema from server
export async function loadSchema() {
  schemaLoading.set(true);
  schemaError.set(null);
  
  try {
    const types = await discAPI.getSchema();
    schemaTypes.set(types);
    
    if (types.length > 0) {
      selectedType.set(types[0]);
    }
  } catch (error) {
    schemaError.set(error instanceof Error ? error.message : 'Failed to load schema');
  } finally {
    schemaLoading.set(false);
  }
}

// Select a type by name
export function selectTypeByName(name: string) {
  schemaTypes.subscribe(types => {
    const type = types.find(t => t.name === name);
    if (type) {
      selectedType.set(type);
    }
  })();
}