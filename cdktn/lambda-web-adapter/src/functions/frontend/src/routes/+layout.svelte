<script lang="ts">
import "../app.css";
import type { LayoutProps } from "./$types";

let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <title>Click Counter</title>
</svelte:head>

{@render children()}
