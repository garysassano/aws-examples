<script lang="ts">
import { onMount, untrack } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { fly } from "svelte/transition";
import { type SubmitFunction, enhance } from "$app/forms";
import hono from "../assets/hono.svg";
import svelte from "../assets/svelte.svg";
import upstashRedis from "../assets/upstash-redis.svg";
import type { PageProps } from "./$types";

let { data, form }: PageProps = $props();

// After a click, the action's result; on page load, the load function's.
const counter = $derived(form ?? data);

const ICONS: Record<string, string> = { SvelteKit: svelte, Hono: hono, Redis: upstashRedis };

// Most clicks finish before the indicator would appear, so they never flash it;
// once it appears, it stays long enough to read.
const SHOW_AFTER_MS = 300;
const SHOW_AT_LEAST_MS = 400;

let submitting = $state(false);
let busy = $state(false);

// One floating "+1" per successful click, removed when its animation ends.
let bumps = $state<number[]>([]);
let nextBump = 0;

// Each successful click sends a packet of light along the arrows, one hop after
// the other, lighting each head as it arrives. Packets run independently, so a burst
// of clicks shows as a stream rather than restarting or queueing one animation.
// A packet is removed on a timer, which also works when one finishes before the page
// hydrates.
const HOP_MS = 420;
const HOP_GAP_MS = 320;
const MAX_PACKETS = 4;

// A page load sends nothing, so it plays no packet, unless the page is itself the
// result of an increment: a form submission without JavaScript, where `form` holds
// the action's result.
// Only the initial value matters; later results send their own packets.
let packets = $state<number[]>(untrack(() => form) ? [0] : []);
let nextPacket = 1;

const packetMs = () => HOP_MS + HOP_GAP_MS * (counter.hops.length - 1) + 50;

function removeLater(id: number) {
  setTimeout(() => (packets = packets.filter((packet) => packet !== id)), packetMs());
}

function sendPacket() {
  if (prefersReducedMotion.current || packets.length >= MAX_PACKETS) return;
  const id = nextPacket++;
  packets.push(id);
  removeLater(id);
}

onMount(() => {
  if (packets.length) removeLater(0);
});

const count: SubmitFunction = () => {
  submitting = true;
  let shownAt = 0;
  const timer = setTimeout(() => {
    busy = true;
    shownAt = performance.now();
  }, SHOW_AFTER_MS);

  return async ({ result, update }) => {
    // The action returns the new count, so skip rerunning `load`.
    await update({ refreshAll: false });
    if (result.type === "success") {
      bumps.push(nextBump++);
      sendPacket();
    }
    clearTimeout(timer);
    if (busy) {
      const left = SHOW_AT_LEAST_MS - (performance.now() - shownAt);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    }
    busy = false;
    submitting = false;
  };
};
</script>

<main class="card">
  <header>
    <p class="eyebrow">Click counter</p>
    {#if data.region}
      <p class="chip"><span class="dot" aria-hidden="true"></span>{data.region}</p>
    {/if}
  </header>

  <div class="count" aria-live="polite">
    {#key counter.clicks}
      <span in:fly={{ y: 14, duration: prefersReducedMotion.current ? 0 : 260 }}>
        {counter.clicks.toLocaleString("en")}
      </span>
    {/key}
  </div>
  <p class="label">{counter.clicks === 1 ? "click" : "clicks"} so far</p>

  <form method="POST" use:enhance={count}>
    <div class="action">
      {#each bumps as id (id)}
        <span
          class="bump"
          aria-hidden="true"
          onanimationend={() => (bumps = bumps.filter((bump) => bump !== id))}>+1</span
        >
      {/each}
      <!-- Disabled at once against double submits, but styled as busy only once `busy`. -->
      <button type="submit" disabled={submitting} aria-busy={busy}>
        {#if busy}
          <span class="spinner" aria-hidden="true"></span>
          Counting…
        {:else}
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add your click
        {/if}
      </button>
    </div>
  </form>

  <footer>
    <ol
      class="path"
      aria-label="Request path, with each hop's time on the last request"
      style:--hop="{HOP_MS}ms"
      style:--hop-gap="{HOP_GAP_MS}ms"
    >
      {@render node("SvelteKit")}
      {#each counter.hops as hop, i (hop.to)}
        {@const from = i === 0 ? "SvelteKit" : counter.hops[i - 1].to}
        <li class="hop" style:--i={i}>
          <span class="ms" title="{from} → {hop.to} on the last request">{hop.ms} ms</span>
          <span class="line">
            {#each packets as id (id)}<span class="packet" aria-hidden="true"></span>{/each}
          </span>
          <span class="head" aria-hidden="true">
            <svg width="9" height="12" viewBox="0 0 9 12"><path d="M1.5 1.5 7 6 1.5 10.5" /></svg>
            {#each packets as id (id)}
              <svg class="flash" width="9" height="12" viewBox="0 0 9 12">
                <path d="M1.5 1.5 7 6 1.5 10.5" />
              </svg>
            {/each}
          </span>
        </li>
        {@render node(hop.to, hop.vendor)}
      {/each}
    </ol>
  </footer>
</main>

{#snippet node(name: string, vendor?: string)}
  <li class="node">
    {#if ICONS[name]}<img class="logo" src={ICONS[name]} alt="" width="12" height="12" />{/if}
    {#if vendor}<span class="vendor">{vendor}</span>{/if}{name}
  </li>
{/snippet}

<style>
  .card {
    position: relative;
    padding: 28px clamp(20px, 6vw, 32px) 24px;
    text-align: center;
    background: var(--surface);
    border-radius: 24px;
    box-shadow:
      inset 0 1px 0 var(--highlight),
      var(--shadow);
    backdrop-filter: blur(18px) saturate(1.4);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .eyebrow {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 3px 9px;
    font-size: 0.6875rem;
    color: var(--muted);
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 999px;
  }

  .dot {
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 50%;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }

  .count {
    margin-top: 28px;
    font-size: clamp(4rem, 18vw, 5.5rem);
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.05em;
    font-variant-numeric: tabular-nums;
  }

  .count > span {
    display: inline-block;
    padding: 0 0.04em 0.06em;
    color: transparent;
    background: linear-gradient(180deg, var(--count-from), var(--count-to));
    background-clip: text;
  }

  .label {
    margin: 8px 0 28px;
    color: var(--muted);
  }

  .action {
    position: relative;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 14px 20px;
    font: inherit;
    font-weight: 600;
    color: var(--button-text);
    background: linear-gradient(180deg, var(--button-from), var(--button-to));
    border: none;
    border-radius: 14px;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.25),
      0 10px 24px -10px var(--glow);
    cursor: pointer;
    transition:
      transform 150ms ease,
      box-shadow 150ms ease,
      filter 150ms ease;
  }

  button svg path {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  button:hover:not([aria-busy="true"]) {
    transform: translateY(-1px);
    filter: brightness(1.06);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.25),
      0 14px 30px -10px var(--glow);
  }

  button:active:not([aria-busy="true"]) {
    transform: translateY(0) scale(0.98);
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  button[aria-busy="true"] {
    cursor: progress;
    opacity: 0.8;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* A "+1" that rises from the button and fades out. */
  .bump {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 1;
    font-weight: 800;
    color: var(--accent);
    pointer-events: none;
    animation: bump 700ms ease-out forwards;
  }

  @keyframes bump {
    from {
      opacity: 1;
      translate: -50% 0;
    }
    to {
      opacity: 0;
      translate: -50% -36px;
    }
  }

  footer {
    container-type: inline-size;
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }

  /* Nodes keep their width and the arrows share what is left. */
  .path {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 14px 0 0;
    list-style: none;
    font-size: 0.6875rem;
  }

  /* Above the arrows, so packets emerge from under their source pill. */
  .node {
    position: relative;
    z-index: 1;
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    white-space: nowrap;
    background: var(--surface-solid);
    border: 1px solid var(--border);
    border-radius: 999px;
  }

  .logo {
    display: block;
    width: 12px;
    height: 12px;
    object-fit: contain;
  }

  /* An arrow: a line that fades in from its source and a chevron head, with the
     hop's time centered above it. */
  .hop {
    position: relative;
    display: flex;
    flex: 1 1 0;
    align-items: center;
    min-width: 32px;
    margin: 0 4px;
    color: var(--muted);
  }

  .line {
    position: relative;
    flex: 1;
    height: 2.5px;
    border-radius: 2px;
    background: linear-gradient(to right, transparent, currentColor 65%);
  }

  .head {
    position: relative;
    flex: none;
    display: grid;
    margin-left: -2px;
  }

  .head > svg {
    grid-area: 1 / 1;
    display: block;
  }

  .head path {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* A packet: a comet that crosses each hop in turn, its glowing head trailing a
     streak of light half as long as the line. */
  .packet {
    --length: 55%;
    position: absolute;
    top: 50%;
    left: calc(-1 * var(--length));
    width: var(--length);
    height: 3px;
    margin-top: -1.5px;
    border-radius: 2px;
    background: linear-gradient(to right, transparent, var(--accent));
    opacity: 0;
    animation: travel var(--hop) ease-in-out calc(var(--i) * var(--hop-gap)) both;
  }

  .packet::after {
    content: "";
    position: absolute;
    top: 50%;
    right: -2px;
    width: 7px;
    height: 5px;
    margin-top: -2.5px;
    border-radius: 3px;
    background: var(--accent);
    box-shadow: 0 0 10px 2px color-mix(in srgb, var(--accent) 60%, transparent);
  }

  /* At 85% the head reaches the end of the line, where the arrowhead flashes. */
  @keyframes travel {
    15% {
      opacity: 1;
    }
    85% {
      left: calc(100% - var(--length));
      opacity: 1;
    }
    to {
      left: calc(100% - var(--length) + 4px);
      opacity: 0;
    }
  }

  /* A lit copy of the head that flashes as the packet arrives. Both share one
     duration and delay, so the flash peaks as the packet reaches the tip. */
  .head .flash {
    opacity: 0;
    animation: arrive var(--hop) calc(var(--i) * var(--hop-gap)) both;
  }

  .head .flash path {
    stroke: var(--accent);
  }

  @keyframes arrive {
    70% {
      opacity: 0;
      translate: 0;
    }
    88% {
      opacity: 1;
      translate: 2px 0;
    }
    to {
      opacity: 0;
      translate: 0;
    }
  }

  .ms {
    position: absolute;
    /* 6px clear of the line, which runs through the arrow's middle. */
    bottom: calc(50% + 6px);
    left: 50%;
    translate: -50% 0;
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--muted);
  }

  /* Narrow cards drop the logos, then shorten "Upstash Redis" to "Redis", to keep
     the path on one line. */
  @container (width < 340px) {
    .logo {
      display: none;
    }

    .node {
      padding: 3px 7px;
    }
  }

  @container (width < 270px) {
    .vendor {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    button,
    .spinner {
      transition: none;
      animation-duration: 2s;
    }

    .packet,
    .head .flash {
      display: none;
    }

    .bump {
      animation-duration: 400ms;
    }

    @keyframes bump {
      to {
        opacity: 0;
        translate: -50% 0;
      }
    }
  }
</style>
