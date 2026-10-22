import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { AGENT_TASKS_ROUTES } from "@openbot/contracts/team-protocol/agent-tasks-v1";

/**
 * The reads that fill lists, counts and photos for many agents at once. The rpc channel keeps its
 * order, so a request goes out only after every frame before it. These reads wait on the phone,
 * a few at a time, and the requests of the screen that the user looks at go out before them.
 */
const BACKGROUND_READS: readonly { method: string; route: RegExp }[] = [
  { method: "POST", route: new RegExp(`^${AGENT_TASKS_ROUTES.list}$`) },
  { method: "GET", route: new RegExp(`^${TEAM_API_ROUTES.analytics}$`) },
  { method: "GET", route: /^\/v1\/agents\/[^/]+\/(avatar|routines|routines\/[^/]+\/runs)$/ },
];

/** The background reads that one server has sent and that have no answer yet. */
const BACKGROUND_READS_IN_FLIGHT = 2;

export function isBackgroundRead(method: string, path: string): boolean {
  const route = path.split("?", 1)[0] ?? path;
  return BACKGROUND_READS.some((read) => read.method === method && read.route.test(route));
}

/** Runs at most `limit` tasks at a time, in the order they arrive. */
function createRequestLimiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // The slot goes to the next task directly, so a new task cannot take it first.
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/**
 * The requests of one server, in the order that the user needs them. The host answers about one
 * request at a time, so a request that waits on the phone lets the requests of a higher lane go first.
 * - `foreground`: what the screens ask for, such as the chat that the user opened. It never waits.
 * - `prefetch`: the chats that load before they open. A read waits while a foreground request has no answer.
 * - `background`: the reads of `isBackgroundRead`. They wait until the prefetch ends, then go a few at a time.
 */
export function createRequestLanes() {
  let foreground = 0;
  let prefetches = 0;
  const waiting = new Set<() => void>();
  const wake = () => {
    for (const check of [...waiting]) check();
  };
  const until = (ready: () => boolean) =>
    ready()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const check = () => {
            if (!ready()) return;
            waiting.delete(check);
            resolve();
          };
          waiting.add(check);
        });
  const backgroundSlots = createRequestLimiter(BACKGROUND_READS_IN_FLIGHT);
  return {
    async foreground<T>(task: () => Promise<T>): Promise<T> {
      foreground += 1;
      try {
        return await task();
      } finally {
        foreground -= 1;
        wake();
      }
    },
    async prefetchRead<T>(task: () => Promise<T>): Promise<T> {
      await until(() => foreground === 0);
      return task();
    },
    background<T>(task: () => Promise<T>): Promise<T> {
      return backgroundSlots(async () => {
        await until(() => prefetches === 0);
        return task();
      });
    },
    /** Background reads wait until `run` ends, also when it fails. */
    async prefetch(run: () => Promise<unknown>): Promise<void> {
      prefetches += 1;
      try {
        await run();
      } finally {
        prefetches -= 1;
        wake();
      }
    },
  };
}
