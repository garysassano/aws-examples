<script lang="ts">
// Ships its own font, so the page looks the same on every platform.
import "@fontsource-variable/inter";
import "../app.css";
import type { LayoutProps } from "./$types";

let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <title>Click Counter</title>
</svelte:head>

{@render children()}
