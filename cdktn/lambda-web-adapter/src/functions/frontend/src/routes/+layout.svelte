<script lang="ts">
import "@fontsource-variable/roboto-flex";
import "../app.css";
import type { LayoutProps } from "./$types";

let { children }: LayoutProps = $props();
</script>

{@render children()}
