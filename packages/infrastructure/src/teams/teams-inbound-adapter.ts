import type {
  InboundItem,
  InboundItemRepository,
  TeamsMessage,
  TeamsPort,
} from "@oneon/domain";

export interface TeamsInboundAdapterConfig {
  inboundItemRepo: Pick<InboundItemRepository, "search">;
}

const DEFAULT_SEARCH_LIMIT = 100;
const UNKNOWN_CHANNEL = "(unknown)";

interface TeamsInboundRawPayload {
  id?: string;
  channelName?: string | null;
  createdDateTime?: string;
}

export class TeamsInboundAdapter implements TeamsPort {
  private readonly inboundItemRepo: Pick<InboundItemRepository, "search">;

  constructor(config: TeamsInboundAdapterConfig) {
    this.inboundItemRepo = config.inboundItemRepo;
  }

  async searchMessages(
    query: string,
    options?: {
      channelName?: string;
      since?: string;
    },
  ): Promise<TeamsMessage[]> {
    const rows = this.inboundItemRepo.search({
      query,
      source: "teams",
      limit: DEFAULT_SEARCH_LIMIT,
    });

    const normalizedChannel = normalizeChannelFilter(options?.channelName);
    const sinceEpochMs = toEpochMs(options?.since);

    return rows
      .map(mapInboundItemToTeamsMessage)
      .filter((message) => {
        if (!normalizedChannel) {
          return true;
        }
        return message.channelName.toLowerCase() === normalizedChannel;
      })
      .filter((message) => {
        if (sinceEpochMs === null) {
          return true;
        }
        const createdAtEpochMs = toEpochMs(message.createdAt);
        return createdAtEpochMs !== null && createdAtEpochMs >= sinceEpochMs;
      });
  }
}

function mapInboundItemToTeamsMessage(item: InboundItem): TeamsMessage {
  const payload = parseRawPayload(item.rawJson);
  const createdAt = toEpochMs(payload?.createdDateTime) !== null
    ? (payload?.createdDateTime as string)
    : item.receivedAt;

  return {
    id: payload?.id ?? item.externalId,
    channelName: normalizeChannelName(payload?.channelName),
    from: item.from,
    subject: item.subject,
    bodyPreview: item.bodyPreview,
    createdAt,
  };
}

function parseRawPayload(rawJson: string): TeamsInboundRawPayload | null {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as TeamsInboundRawPayload;
  } catch {
    return null;
  }
}

function normalizeChannelName(channelName: string | null | undefined): string {
  if (!channelName || channelName.trim().length === 0) {
    return UNKNOWN_CHANNEL;
  }
  return channelName.trim();
}

function normalizeChannelFilter(channelName: string | undefined): string | null {
  if (!channelName || channelName.trim().length === 0) {
    return null;
  }
  return channelName.trim().toLowerCase();
}

function toEpochMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : epoch;
}
