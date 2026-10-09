<script lang="ts">
import { prefersReducedMotion } from "svelte/motion";
import { scale } from "svelte/transition";
import { type SubmitFunction, enhance } from "$app/forms";
import type { PageProps } from "./$types";

let { data, form }: PageProps = $props();

// After a click, the action's result; on page load, the load function's.
const counter = $derived(form ?? data);

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
    // The action returns the new count, so skip rerunning `load`.
    await update({ refreshAll: false });
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
  <p class="eyebrow">Click counter</p>

  <div class="count" aria-live="polite">
    {#key counter.clicks}
      <span in:scale={{ start: 0.85, duration: prefersReducedMotion.current ? 0 : 220 }}>
        {counter.clicks.toLocaleString("en")}
      </span>
    {/key}
  </div>
  <p class="label">{counter.clicks === 1 ? "click" : "clicks"} so far</p>

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
    <ol class="path" aria-label="Request path, with each hop's time on the last request">
      <li class="node">SvelteKit</li>
      {#each counter.hops as hop (hop.to)}
        <li class="hop"><span class="ms">{hop.ms} ms</span></li>
        <li class="node">
          {#if hop.vendor}<span class="vendor">{hop.vendor}&nbsp;</span>{/if}{hop.to}
        </li>
      {/each}
    </ol>
    <p class="meta">
      Time per hop on the last request{#if data.region}&nbsp;· <span class="nowrap">{data.region}</span>{/if}
    </p>
  </footer>
</main>

<style>
  .card {
    padding: 40px clamp(20px, 6vw, 32px) 28px;
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
    container-type: inline-size;
    margin-top: 28px;
    padding-top: 20px;
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

  .node {
    flex: none;
    padding: 3px 7px;
    white-space: nowrap;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 999px;
  }

  /* An arrow drawn as a line with a chevron head, its time centered above it. */
  .hop {
    position: relative;
    flex: 1 1 0;
    min-width: 30px;
    height: 1px;
    margin: 0 4px;
    background: var(--muted);
  }

  .hop::after {
    content: "";
    position: absolute;
    top: -3px;
    right: 0;
    width: 6px;
    height: 6px;
    border-top: 1px solid var(--muted);
    border-right: 1px solid var(--muted);
    transform: rotate(45deg);
  }

  .ms {
    position: absolute;
    bottom: 5px;
    left: 50%;
    translate: -50% 0;
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--muted);
  }

  /* On the narrowest phones, "Upstash Redis" becomes "Redis" to keep one line. */
  @container (width < 270px) {
    .vendor {
      display: none;
    }
  }

  .nowrap {
    white-space: nowrap;
  }

  .meta {
    margin: 14px 0 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
