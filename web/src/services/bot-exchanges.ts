import type { BotExchange } from '../components/BotExchanges';

export const exchangePeer = (exchange: BotExchange, profile: string) => exchange.from === profile ? exchange.to : exchange.from;

/** Keep one link to the shared pair history, even when the direction changes. */
export function exchangeThreads(rows: BotExchange[], profile: string) {
  const pairs = new Map<string, BotExchange>();
  for (const row of rows) {
    const peer = exchangePeer(row, profile);
    if (peer && (!pairs.has(peer) || pairs.get(peer)!.createdAt < row.createdAt)) pairs.set(peer, row);
  }
  return [...pairs.values()];
}

export function exchangeMessages(rows: BotExchange[]) {
  return rows.flatMap(record => [
    { record, part: 'request' as const, at: record.createdAt },
    { record, part: 'reply' as const, at: record.replyAt || record.updatedAt || record.createdAt },
  ]).sort((left, right) => left.at - right.at);
}
