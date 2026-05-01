import { Router, type Request, type Response } from "express";
import {
  CommunicationStyleSchema,
  DEFAULT_USER_PROFILE_SETTINGS,
  SalutationModeSchema,
  type UserProfileSettings,
  type UserProfilePatch,
  UpdateUserProfileRequestSchema,
} from "@oneon/contracts";
import type {
  UserProfile,
  UserProfileRepository,
  Logger,
} from "@oneon/domain";

export interface ProfileRouteDeps {
  userProfileRepo: UserProfileRepository;
  logger: Logger;
}

const SALUTATION_MODES = SalutationModeSchema.options;
const COMMUNICATION_STYLES = CommunicationStyleSchema.options;

export function createProfileRouter(deps: ProfileRouteDeps): Router {
  const router = Router();
  const { userProfileRepo, logger } = deps;

  router.get("/", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const profile = userProfileRepo.findByUserId(userId);
      const settings = profile ? toSettings(profile) : { ...DEFAULT_USER_PROFILE_SETTINGS };

      res.status(200).json({ profile: settings });
    } catch (error) {
      logger.error("Failed to get user profile", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const parsedRequest = UpdateUserProfileRequestSchema.safeParse(req.body);
      if (!parsedRequest.success) {
        res.status(400).json({
          error: formatZodIssue(parsedRequest.error.issues[0]),
        });
        return;
      }
      const payload = parsedRequest.data.profile;

      const existing = userProfileRepo.findByUserId(userId);
      const nextProfile: UserProfileSettings = existing
        ? toSettings(existing)
        : { ...DEFAULT_USER_PROFILE_SETTINGS };

      if (Object.prototype.hasOwnProperty.call(payload, "preferredName")) {
        const parsed = parseNullableText(payload.preferredName, "preferredName");
        if (!parsed.ok) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        nextProfile.preferredName = parsed.value;
      }

      if (Object.prototype.hasOwnProperty.call(payload, "nickname")) {
        const parsed = parseNullableText(payload.nickname, "nickname");
        if (!parsed.ok) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        nextProfile.nickname = parsed.value;
      }

      if (Object.prototype.hasOwnProperty.call(payload, "salutationMode")) {
        if (
          typeof payload.salutationMode !== "string" ||
          !SALUTATION_MODES.includes(payload.salutationMode)
        ) {
          res.status(400).json({
            error:
              'salutationMode must be one of "sir", "sir_with_name", or "nickname"',
          });
          return;
        }
        nextProfile.salutationMode = payload.salutationMode;
      }

      if (Object.prototype.hasOwnProperty.call(payload, "communicationStyle")) {
        if (
          typeof payload.communicationStyle !== "string" ||
          !COMMUNICATION_STYLES.includes(payload.communicationStyle)
        ) {
          res.status(400).json({
            error:
              'communicationStyle must be one of "formal", "friendly", "concise", or "technical"',
          });
          return;
        }
        nextProfile.communicationStyle = payload.communicationStyle;
      }

      if (Object.prototype.hasOwnProperty.call(payload, "timezone")) {
        if (typeof payload.timezone !== "string" || payload.timezone.trim() === "") {
          res.status(400).json({ error: "timezone must be a non-empty string" });
          return;
        }
        nextProfile.timezone = payload.timezone.trim();
      }

      if (nextProfile.salutationMode === "nickname" && !nextProfile.nickname) {
        res.status(400).json({
          error: 'nickname is required when salutationMode is "nickname"',
        });
        return;
      }

      const saved = userProfileRepo.upsert({
        userId,
        preferredName: nextProfile.preferredName,
        nickname: nextProfile.nickname,
        salutationMode: nextProfile.salutationMode,
        communicationStyle: nextProfile.communicationStyle,
        timezone: nextProfile.timezone,
      });

      res.status(200).json({ profile: toSettings(saved) });
    } catch (error) {
      logger.error("Failed to update user profile", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function toSettings(profile: UserProfile): UserProfileSettings {
  return {
    preferredName: profile.preferredName,
    nickname: profile.nickname,
    salutationMode: profile.salutationMode,
    communicationStyle: profile.communicationStyle,
    timezone: profile.timezone,
  };
}

function parseNullableText(
  value: UserProfilePatch["preferredName"] | UserProfilePatch["nickname"],
  field: "preferredName" | "nickname",
):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== "string") {
    return { ok: false, error: `${field} must be a string or null` };
  }

  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function formatZodIssue(issue: {
  path: Array<string | number>;
  message: string;
} | undefined): string {
  if (!issue) {
    return "Invalid profile payload";
  }

  const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
  return `${path}: ${issue.message}`;
}
