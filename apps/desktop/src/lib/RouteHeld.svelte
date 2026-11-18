<script lang="ts">
  /**
   * A route of Home's that waits on something other than him (item 763 H5's review): its project is not
   * open on the Mac, or a night run is going in it. One quiet line under the Start cards saying where it
   * goes and why it has not started; it goes when it starts. Mac and phone.
   */
  import { heldLine, type HomeRoute } from "./homeRoutes";
  let { route }: { route: HomeRoute } = $props();
</script>

<p class="route-held" data-route-held={route.id}>{heldLine(route)}</p>

<style>
  .route-held {
    margin: 6px 0;
    padding: 6px 10px;
    border: 1px dashed var(--line2);
    border-radius: 8px;
    font-family: var(--sans);
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
</style>
