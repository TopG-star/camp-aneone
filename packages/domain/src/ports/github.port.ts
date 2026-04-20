export interface GitHubNotification {
  id: string;
  reason: string;
  subject: { title: string; type: string; url: string };
  repository: string;
  updatedAt: string;
  unread: boolean;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  state: string;
  author: string;
  repo: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPort {
  listNotifications(options?: {
    all?: boolean;
    participating?: boolean;
  }): Promise<GitHubNotification[]>;

  listPullRequests(options?: {
    state?: string;
    author?: string;
    repo?: string;
  }): Promise<GitHubPullRequest[]>;
}
