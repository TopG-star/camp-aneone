export interface TeamsMessage {
  id: string;
  channelName: string;
  from: string;
  subject: string;
  bodyPreview: string;
  createdAt: string;
}

export interface TeamsPort {
  searchMessages(query: string, options?: {
    channelName?: string;
    since?: string;
  }): Promise<TeamsMessage[]>;
}
