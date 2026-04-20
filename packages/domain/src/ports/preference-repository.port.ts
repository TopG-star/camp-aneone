import type { Preference } from "../entities.js";

export interface PreferenceRepository {
  get(key: string): string | null;
  set(key: string, value: string): Preference;
  getAll(): Preference[];
  delete(key: string): void;
}
