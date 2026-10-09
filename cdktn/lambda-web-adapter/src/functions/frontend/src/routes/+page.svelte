<script lang="ts">
import { prefersReducedMotion } from "svelte/motion";
import { scale } from "svelte/transition";
import { type SubmitFunction, enhance } from "$app/forms";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// Most clicks finish before the indicator would appear, so they never flash it;
// once it appears, it stays long enough to read.
const SHOW_AFTER_MS = 300;
const SHOW_AT_LEAST_MS = 400;

let submitting = $state(false);
let busy = $state(false);

const count: SubmitFunction = () => {
  submitting = true;
  let shownAt = 0;
  const timer = setTimeout(() => {
    busy = true;
    shownAt = performance.now();
  }, SHOW_AFTER_MS);

  return async ({ update }) => {
    await update();
    clearTimeout(timer);
    if (busy) {
      const left = SHOW_AT_LEAST_MS - (performance.now() - shownAt);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    }
    busy = false;
    submitting = false;
  };
};

const path = ["SvelteKit", "Hono", "Upstash Redis"];
</script>

<main class="card">
  <p class="eyebrow">Click counter</p>

  <div class="count" aria-live="polite">
    {#key data.clicks}
      <span in:scale={{ start: 0.85, duration: prefersReducedMotion.current ? 0 : 220 }}>
        {data.clicks.toLocaleString("en")}
      </span>
    {/key}
  </div>
  <p class="label">{data.clicks === 1 ? "click" : "clicks"} so far</p>

  <form method="POST" use:enhance={count}>
    <!-- Disabled at once against double submits, but styled as busy only once `busy`. -->
    <button type="submit" disabled={submitting} aria-busy={busy}>
      {#if busy}
        <span class="spinner" aria-hidden="true"></span>
        Counting…
      {:else}
        Add your click
      {/if}
    </button>
  </form>

  <footer>
    <ol class="path" aria-label="Request path">
      {#each path as hop, i (hop)}
        {#if i > 0}<li class="arrow" aria-hidden="true">→</li>{/if}
        <li class="hop">{hop}</li>
      {/each}
    </ol>
    <p class="meta">
      Backend round trip {data.roundTripMs} ms{#if data.region}&nbsp;· {data.region}{/if}
    </p>
  </footer>
</main>

<style>
  .card {
    width: 100%;
    max-width: 380px;
    padding: 40px 32px 28px;
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: var(--shadow);
  }

  .eyebrow {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .count {
    margin-top: 12px;
    font-size: 5rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }

  .count > span {
    display: inline-block;
  }

  .label {
    margin: 8px 0 28px;
    color: var(--muted);
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
    background: var(--button);
    border: none;
    border-radius: 12px;
    cursor: pointer;
    transition:
      background-color 150ms ease,
      transform 100ms ease;
  }

  button:hover:not([aria-busy="true"]) {
    background: var(--button-hover);
  }

  button:active:not([aria-busy="true"]) {
    transform: scale(0.98);
  }

  button:focus-visible {
    outline: 2px solid var(--button);
    outline-offset: 3px;
  }

  button[aria-busy="true"] {
    cursor: progress;
    opacity: 0.75;
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

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }

    button {
      transition: none;
    }
  }

  footer {
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }

  .path {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
  }

  .hop {
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
  }

  .arrow {
    color: var(--muted);
  }

  .meta {
    margin: 10px 0 0;
    font-size: 0.75rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
