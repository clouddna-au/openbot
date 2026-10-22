import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CONVERSATION_UNREAD_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { type createRemoteReadRefresh, mergeRemoteUnreadIds, runTeamEffect } from "@openbot/team-client";
import { Effect } from "effect";
import { type RefObject, useCallback, useRef } from "react";
import { showFailureAlert, showWarningAlert } from "@/features/analytics/failure-reports";
import type { WorkspaceRequest } from "@/features/workspace/context/host-request-actions";
import { decodeConversationPage } from "@/features/workspace/model/conversation";
import { type MobileConversationStore, waitBeforeNextRead } from "@/features/workspace/model/conversation-store";
import type { LiveWorkspaceStore } from "@/features/workspace/model/live-workspace-store";
import { hasCapability, type ServerCapabilities } from "@/features/workspace/model/server-capabilities";
import { decodeConversationReads } from "@/features/workspace/model/workspace-records";
import type { MobileAgent, MobileWorkspaceContextValue } from "@/features/workspace/model/workspace-types";
import { currentText } from "@/shared/lib/text";

/**
 * The read state of the agent chats: the host's unread counts, and the read cursors that this phone
 * writes. Each returned function is stable for the session.
 */
export function useConversationReads({
  liveState,
  readRefresh,
  request,
  loadConversation,
  conversationStore,
  loadGeneration,
  removedServers,
  capabilities,
  activeServerId,
  agents,
}: {
  liveState: LiveWorkspaceStore;
  readRefresh: ReturnType<typeof createRemoteReadRefresh>;
  request: WorkspaceRequest;
  loadConversation: MobileWorkspaceContextValue["loadConversation"];
  conversationStore: MobileConversationStore;
  /** Changes when the app leaves or another server is selected, so older reads do not apply. */
  loadGeneration: RefObject<number>;
  removedServers: RefObject<Set<string>>;
  capabilities: ServerCapabilities;
  activeServerId: RefObject<string | null>;
  agents: RefObject<MobileAgent[]>;
}) {
  const readWrites = useRef(new Map<string, Promise<void>>());
  /** One read of the counts runs for each server, and `again` asks for one more read after it. */
  const readLoads = useRef(new Map<string, { promise: Promise<void>; again: boolean }>());
  /** The last message that this phone marked read for each `serverId\0agentId`. */
  const writtenReads = useRef(new Map<string, string>());
  /** Applies host read state. The Live Activity also shows the message counts. */
  const applyConversationReads = useCallback(
    (reads: Record<string, { unreadCount: number }>) => {
      liveState.update("unreadAgentIds", (current) => mergeRemoteUnreadIds(current, reads));
      liveState.update("unreadCounts", (current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(reads).map(([agentId, read]) => [agentId, read.unreadCount])),
      }));
    },
    [liveState],
  );

  const refreshConversationReads = useCallback(
    async (serverId = activeServerId.current) => {
      if (!serverId) return;
      const pending = readLoads.current.get(serverId);
      if (pending) {
        pending.again = true;
        return pending.promise;
      }
      const load = { again: false, promise: Promise.resolve() };
      load.promise = (async () => {
        do {
          if (load.again) await waitBeforeNextRead();
          load.again = false;
          await runTeamEffect(
            readRefresh.refresh(
              serverId,
              () =>
                Effect.tryPromise(() =>
                  request(
                    "GET",
                    TEAM_API_ROUTES.agents.conversationReads,
                    decodeConversationReads,
                    undefined,
                    serverId,
                  ),
                ),
              applyConversationReads,
              () => !removedServers.current.has(serverId),
            ),
          ).catch((error: unknown) => {
            if (!load.again) throw error;
          });
        } while (load.again);
      })().finally(() => {
        if (readLoads.current.get(serverId) === load) readLoads.current.delete(serverId);
      });
      readLoads.current.set(serverId, load);
      return load.promise;
    },
    [request, readRefresh, applyConversationReads, activeServerId, removedServers],
  );

  /**
   * Writes one agent's read cursor on `serverId` after its earlier writes. It rejects when the host refuses it.
   */
  const writeAgentRead = useCallback(
    (agentId: string, visibleMessageId?: string | null, serverId = activeServerId.current): Promise<void> => {
      if (!serverId) return Promise.resolve();
      // The chat asks again each time it shows the latest message. The same cursor changes nothing on the host.
      const written = `${serverId}\0${agentId}`;
      if (
        visibleMessageId &&
        writtenReads.current.get(written) === visibleMessageId &&
        !liveState.get().unreadAgentIds.includes(agentId)
      )
        return Promise.resolve();
      if (visibleMessageId) writtenReads.current.set(written, visibleMessageId);
      else writtenReads.current.delete(written);
      const isCurrentRead = readRefresh.invalidate(serverId);
      const generation = loadGeneration.current;
      liveState.update("unreadAgentIds", (current) =>
        visibleMessageId === null ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId),
      );
      const write = (readWrites.current.get(agentId) ?? Promise.resolve())
        .then(async () => {
          if (generation !== loadGeneration.current) return;
          const cached = conversationStore.get(agentId);
          // A window around a searched message does not hold the latest message.
          const snapshot =
            visibleMessageId !== undefined
              ? null
              : cached && !cached.detached
                ? cached
                : await loadConversation(agentId, serverId);
          if (generation !== loadGeneration.current) return;
          const throughMessageId = visibleMessageId !== undefined ? visibleMessageId : snapshot?.messages.at(-1)?.id;
          if (throughMessageId === undefined) return;
          const reads = await request(
            "POST",
            visibleMessageId === null
              ? TEAM_API_ROUTES.agent.conversationUnread(agentId)
              : TEAM_API_ROUTES.agent.conversationRead(agentId),
            (value) => decodeConversationReads({ [agentId]: value }),
            visibleMessageId === null ? {} : { throughMessageId },
            serverId,
          );
          if (generation === loadGeneration.current && isCurrentRead()) {
            readRefresh.invalidate(serverId);
            applyConversationReads(reads);
          }
        })
        .catch((error: unknown) => {
          if (visibleMessageId && writtenReads.current.get(written) === visibleMessageId)
            writtenReads.current.delete(written);
          if (generation === loadGeneration.current) void refreshConversationReads(serverId).catch(() => undefined);
          throw error;
        });
      // A failed write must not stop the next write for this agent.
      const settled = write.catch(() => undefined);
      readWrites.current.set(agentId, settled);
      void settled.finally(() => {
        if (readWrites.current.get(agentId) === settled) readWrites.current.delete(agentId);
      });
      return write;
    },
    [
      liveState,
      request,
      refreshConversationReads,
      loadConversation,
      activeServerId,
      loadGeneration,
      readRefresh,
      conversationStore,
      applyConversationReads,
    ],
  );

  const markAgentRead = useCallback(
    (agentId: string, visibleMessageId?: string | null, targetServerId?: string) => {
      const serverId = targetServerId ?? activeServerId.current;
      if (visibleMessageId === null && !hasCapability(capabilities, serverId, TEAM_CONVERSATION_UNREAD_CAPABILITY)) {
        showWarningAlert(
          "team",
          currentText().t("mobile.workspace.alert.updateRequiredTitle"),
          currentText().t("mobile.workspace.alert.updateRequiredUnread"),
        );
        return;
      }
      void writeAgentRead(agentId, visibleMessageId, serverId ?? undefined).catch((error: unknown) => {
        if (visibleMessageId === null)
          showFailureAlert(
            error,
            "settings",
            currentText().t("mobile.workspace.alert.markUnreadTitle"),
            currentText().t("mobile.workspace.alert.markUnreadBody"),
          );
      });
    },
    [activeServerId, capabilities, writeAgentRead],
  );

  /** Marks every unread agent of the active server read through its newest message. */
  const markAllRead = useCallback(async () => {
    const serverId = activeServerId.current;
    if (!serverId) return;
    // Only listed agents: a read of an id the host no longer knows creates that agent again.
    const listed = new Set(agents.current.filter((agent) => agent.serverId === serverId).map((agent) => agent.id));
    const unread = liveState.get().unreadAgentIds.filter((agentId) => listed.has(agentId));
    // A cached chat can be older than the read state, so each receipt uses the host's newest message.
    const results = await Promise.allSettled(
      unread.map(async (agentId) => {
        const page = await request(
          "GET",
          `${TEAM_API_ROUTES.agent.conversationPage(agentId)}?limit=1`,
          decodeConversationPage,
          undefined,
          serverId,
        );
        const latestId = page.messages.at(-1)?.id;
        if (latestId) await writeAgentRead(agentId, latestId, serverId);
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (!failure) return;
    // A later successful write discards the refresh of a refused one, so read the host state once more.
    await refreshConversationReads(serverId).catch(() => undefined);
    throw failure.reason;
  }, [activeServerId, agents, liveState, request, writeAgentRead, refreshConversationReads]);

  return { applyConversationReads, refreshConversationReads, markAgentRead, markAllRead };
}
