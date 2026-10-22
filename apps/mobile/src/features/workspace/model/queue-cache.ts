import type { AgentEvent } from "@openbot/contracts/ipc";
import { hashKey, type QueryClient } from "@tanstack/react-query";
import { waitBeforeNextRead } from "@/features/workspace/model/conversation-store";
import { queryKeys } from "@/features/workspace/model/query-keys";

type QueueEvent = Extract<AgentEvent, { type: "queue-changed" | "queue-invalidated" }>;

/** The queue refresh that runs for each query key. `again` asks for one more read after the read that runs. */
const refreshes = new WeakMap<QueryClient, Map<string, { again: boolean; promise: Promise<void> }>>();

export async function applyMobileQueueEvent(client: QueryClient, serverId: string, event: QueueEvent): Promise<void> {
  const agentId = event.type === "queue-changed" ? event.snapshot.agentId : event.agentId;
  const queryKey = queryKeys.chatQueue(serverId, agentId);
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (event.type === "queue-invalidated" && query?.isActive()) return refreshOpenQueue(client, queryKey);
  // Cancel even the first pending read. Invalidation alone can reuse a read that
  // started before the mutation and install an old queue after the event.
  await client.cancelQueries({ queryKey });
  if (event.type === "queue-changed") client.setQueryData(queryKey, event.snapshot);
  else await client.invalidateQueries({ queryKey });
}

/**
 * The host sends a notice for each change of a turn and answers about one request at a time, so one
 * read of a queue runs at a time. A read that runs can show the queue from before the notice, so one
 * more read follows it after a short wait, also for a burst of notices.
 */
function refreshOpenQueue(client: QueryClient, queryKey: readonly unknown[]): Promise<void> {
  let byKey = refreshes.get(client);
  if (!byKey) {
    byKey = new Map();
    refreshes.set(client, byKey);
  }
  const key = hashKey(queryKey);
  const pending = byKey.get(key);
  if (pending) {
    pending.again = true;
    return pending.promise;
  }
  const refresh = { again: false, promise: Promise.resolve() };
  refresh.promise = (async () => {
    let started = client.isFetching({ queryKey, exact: true }) > 0;
    do {
      refresh.again = started;
      started = false;
      // `cancelRefetch: false` waits for a read that runs instead of sending one more beside it.
      await client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
      if (refresh.again) await waitBeforeNextRead();
    } while (refresh.again && client.getQueryCache().find({ queryKey, exact: true })?.isActive());
  })().finally(() => {
    if (byKey.get(key) === refresh) byKey.delete(key);
  });
  byKey.set(key, refresh);
  return refresh.promise;
}
