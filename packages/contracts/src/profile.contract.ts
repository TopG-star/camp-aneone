import { z } from "zod";

export const SalutationModeSchema = z.enum([
  "sir",
  "sir_with_name",
  "nickname",
]);

export type SalutationMode = z.infer<typeof SalutationModeSchema>;

export const CommunicationStyleSchema = z.enum([
  "formal",
  "friendly",
  "concise",
  "technical",
]);

export type CommunicationStyle = z.infer<typeof CommunicationStyleSchema>;

export const UserProfileSettingsSchema = z.object({
  preferredName: z.string().nullable(),
  nickname: z.string().nullable(),
  salutationMode: SalutationModeSchema,
  communicationStyle: CommunicationStyleSchema,
  timezone: z.string().min(1),
});

export type UserProfileSettings = z.infer<typeof UserProfileSettingsSchema>;

export const UserProfileResponseSchema = z.object({
  profile: UserProfileSettingsSchema,
});

export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;

export const UserProfilePatchSchema = UserProfileSettingsSchema.partial();

export type UserProfilePatch = z.infer<typeof UserProfilePatchSchema>;

export const UpdateUserProfileRequestSchema = z.object({
  profile: UserProfilePatchSchema,
});

export type UpdateUserProfileRequest = z.infer<
  typeof UpdateUserProfileRequestSchema
>;

export const DEFAULT_USER_PROFILE_SETTINGS: UserProfileSettings = {
  preferredName: null,
  nickname: null,
  salutationMode: "sir_with_name",
  communicationStyle: "friendly",
  timezone: "UTC",
};
