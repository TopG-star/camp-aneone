import type { User } from "../entities.js";

export interface UserRepository {
  findById(id: string): User | null;
  findByEmail(email: string): User | null;
  upsert(user: { id: string; email: string }): User;
  list(): User[];
  delete(id: string): void;
}
