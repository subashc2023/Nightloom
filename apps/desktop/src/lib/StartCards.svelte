<script lang="ts">
  /**
   * The Mac's Start cards (nightshift item 763, H5), from Home's store: over the box in Home's chat and
   * first in the Needs-you view. Read when shown and every 15 s while shown — the read is also the look
   * that starts Home's queued read-only chats.
   */
  import { untrack } from "svelte";
  import StartCard from "./StartCard.svelte";
  import RouteHeld from "./RouteHeld.svelte";
  import { routeText } from "./homeRoutes";
  import { dismissRoute, home, refreshRoutes, setRouteDraft, startRoute } from "./home.svelte";

  $effect(() => {
    untrack(() => void refreshRoutes());
    const t = setInterval(() => void refreshRoutes(), 15_000);
    return () => clearInterval(t);
  });
</script>

{#each home.cards as route (route.id)}
  <StartCard
    {route}
    text={routeText(route, home.routeDrafts)}
    busy={home.routeBusy === route.id}
    problem={home.routeProblems[route.id] ?? null}
    ontext={(t) => setRouteDraft(route.id, t)}
    onstart={(pick) => void startRoute(route.id, pick)}
    ondismiss={() => void dismissRoute(route.id)}
  />
{/each}
{#each home.heldRoutes as route (route.id)}
  <RouteHeld {route} />
{/each}
