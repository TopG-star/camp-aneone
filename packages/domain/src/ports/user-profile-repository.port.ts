import type {
  CommunicationStyle,
  SalutationMode,
  UserProfile,
} from "../entities.js";

export interface UserProfileUpsertInput {
  userId: string;
  preferredName: string | null;
  nickname: string | null;
  salutationMode?: SalutationMode;
  communicationStyle?: CommunicationStyle;
  timezone?: string;
}

export interface UserProfileRepository {
  findByUserId(userId: string): UserProfile | null;
  upsert(profile: UserProfileUpsertInput): UserProfile;
  deleteByUserId(userId: string): void;
}