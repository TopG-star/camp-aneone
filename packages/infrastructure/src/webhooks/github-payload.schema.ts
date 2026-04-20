import { z } from "zod";

// ── Pull Request webhook event ─────────────────────────────

export const githubPRPayloadSchema = z.object({
  action: z.string().min(1),
  number: z.number().int().positive(),
  pull_request: z.object({
    id: z.number().int(),
    number: z.number().int().positive(),
    title: z.string().default("(no title)"),
    state: z.string().min(1),
    user: z
      .object({ login: z.string().min(1) })
      .nullable()
      .default(null),
    html_url: z.string().url(),
    body: z.string().nullable().default(null),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  }),
  repository: z.object({
    full_name: z.string().min(1),
  }),
  sender: z.object({
    login: z.string().min(1),
  }),
});

export type GitHubPRPayload = z.infer<typeof githubPRPayloadSchema>;

// ── Issue webhook event ────────────────────────────────────

export const githubIssuePayloadSchema = z.object({
  action: z.string().min(1),
  issue: z.object({
    id: z.number().int(),
    number: z.number().int().positive(),
    title: z.string().default("(no title)"),
    state: z.string().min(1),
    user: z
      .object({ login: z.string().min(1) })
      .nullable()
      .default(null),
    html_url: z.string().url(),
    body: z.string().nullable().default(null),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  }),
  repository: z.object({
    full_name: z.string().min(1),
  }),
  sender: z.object({
    login: z.string().min(1),
  }),
});

export type GitHubIssuePayload = z.infer<typeof githubIssuePayloadSchema>;
