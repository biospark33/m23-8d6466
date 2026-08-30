<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { EventRow, SessionSummary } from '../lib/types'
import { archiveSession, drainEvents } from '../lib/api'
import { usePoller } from '../lib/poll'
import { axisTicks, fmtDate, ts } from '../lib/format'
import { timelineRows } from '../lib/timeline'
import { hrefFor } from '../lib/router'
import StatusChip from './StatusChip.vue'
import StatChip from './StatChip.vue'
import PhaseDots from './PhaseDots.vue'

const props = defineProps<{ session: SessionSummary; nowMs: number }>()
const emit = defineEmits<{ archived: [requestId: string] }>()

/** True in the "show archived" listing — the same button then UN-archives. */
const isArchived = computed(() => Number(props.session.archived ?? 0) === 1)

// The card is an <a>; the button lives inside it, so the click must not
// navigate. Told the parent optimistically — the poll would take up to half a
// second to drop the card, and a triage click should feel instant.
//
// Every archive has its inverse on the same control: in the archived listing
// this writes archived=false, so a mis-click is undone from the UI instead of
// by hand-editing SQLite.
async function archive(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  const next = !isArchived.value
  emit('archived', props.session.request_id)
  try {
    await archiveSession(props.session.request_id, next)
  } catch {
    emit('archived', '')   // signals the parent to re-sync from the server
  }
}

// Each card tails its own event stream: one full fetch when it first comes
// into view, then the same rowid-cursor poll as the trace view — but only
// while the run is live AND the card is on screen.
const events = shallowRef<EventRow[]>([])
let cursor = 0
let inflight = false
// A pull requested while one was in flight. Dropping it stranded a card that
// scrolled away mid-drain and back: the returning `startFeed` hit `inflight`
// and returned, the in-flight drain then finished early (it had seen the card
// leave), and for a session that is no longer `running` the poller never
// restarts — so a finished card sat half-drained until a reload.
let pendingPull = false

// F026: /api/sessions answers with up to 200 rows and the list renders every
// one, so mounting the list used to fire 200 event drains at once — each a
// chain of up to 50 paged requests — at a server that is usually reached
// through an ssh forward. A viewport holds about a dozen cards. Nothing off
// screen is worth a request, so the feed is gated on visibility: the observer
// starts it, scrolling away stops it (mid-drain too, through `isCurrent`), and
// scrolling back resumes from the cursor already reached.
const cardEl = ref<HTMLElement | null>(null)
const visible = ref(false)
let observer: IntersectionObserver | undefined

const poller = usePoller(() => void pull())

async function pull() {
  if (inflight) {
    pendingPull = true
    return
  }
  inflight = true
  try {
    const drained = await drainEvents(
      props.session.request_id,
      cursor,
      undefined,
      () => visible.value,
    )
    cursor = drained.cursor
    // Rows drained before the card scrolled away are still this card's own
    // events — keeping them means the return trip renders instantly.
    if (drained.rows.length) events.value = [...events.value, ...drained.rows]
    poller.onSuccess()
    if (props.session.status !== 'running' || !visible.value) poller.stop()
  } catch {
    /* the list view surfaces api errors; a card just backs off and retries */
    poller.onFailure()
  } finally {
    inflight = false
    if (pendingPull) {
      pendingPull = false
      void pull()
    }
  }
}

/** Start (or resume) the feed for a card the operator can actually see. */
function startFeed() {
  void pull()
  if (props.session.status === 'running' && !poller.active()) poller.start()
}

onMounted(() => {
  // No IntersectionObserver (a non-browser render) means no visibility signal
  // to gate on — fall back to the unconditional feed rather than to no feed.
  if (typeof IntersectionObserver === 'undefined') {
    visible.value = true
    startFeed()
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      const now = entries.some((e) => e.isIntersecting)
      if (now === visible.value) return
      visible.value = now
      if (now) startFeed()
      else poller.stop()
    },
    // A little ahead of the scroll, so a card is loaded by the time it lands.
    { rootMargin: '250px' },
  )
  if (cardEl.value) observer.observe(cardEl.value)
})

onUnmounted(() => {
  observer?.disconnect()
  poller.stop()
})

watch(
  () => props.session.status,
  (status) => {
    if (!visible.value) return
    if (status === 'running' && !poller.active()) poller.start()
    // On the transition out of running the timer goes unconditionally — a pull
    // that short-circuits on `inflight` must not leave it firing forever — and
    // one last pull drains the tail (the in-flight one, if any, drains it).
    else if (status !== 'running') {
      poller.stop()
      void pull()
    }
  },
)

const running = computed(() => props.session.status === 'running')

const range = computed(() => {
  const s = props.session
  let t0 = ts(s.started_at)
  if (!Number.isFinite(t0)) {
    t0 = Math.min(...events.value.map((e) => ts(e.started_at)).filter(Number.isFinite))
  }
  if (!Number.isFinite(t0)) t0 = props.nowMs
  let t1 = running.value ? props.nowMs : ts(s.ended_at)
  if (!Number.isFinite(t1)) {
    t1 = Math.max(...events.value.map((e) => ts(e.started_at)).filter(Number.isFinite))
  }
  if (!Number.isFinite(t1)) t1 = t0 + 1000
  return { t0, span: Math.max(t1 - t0, 1000) }
})

const ticks = computed(() => axisTicks(range.value.span, 5))

// F027: dot geometry and — the point — the per-row span budget live in
// src/lib/timeline.ts, where they are tested. A card row emits at most one
// span per percentage column instead of one per event.
const rows = computed(() =>
  timelineRows({
    phases: props.session.phases,
    agents: props.session.agents,
    events: events.value,
    t0: range.value.t0,
    span: range.value.span,
    running: running.value,
  }),
)

const durationMs = computed(() => {
  const s = props.session
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = running.value ? props.nowMs : ts(s.ended_at)
  return (Number.isFinite(end) ? end : props.nowMs) - start
})

// Cards are a fixed size, so the timeline region fits exactly MAX_VISIBLE_ROWS
// row slots. A roster that overflows spends one slot on the "+N more" line and
// shows MIN_VISIBLE_ROWS agents in the rest — never fewer than three, so a
// five-agent chain still reads as a chain rather than as a pair and a count.
const MAX_VISIBLE_ROWS = 4
const MIN_VISIBLE_ROWS = 3

const overflowing = computed(() => rows.value.length > MAX_VISIBLE_ROWS)

const visibleRows = computed(() =>
  overflowing.value ? rows.value.slice(0, MIN_VISIBLE_ROWS) : rows.value,
)

const hiddenRowCount = computed(() =>
  overflowing.value ? rows.value.length - MIN_VISIBLE_ROWS : 0,
)
</script>

<template>
  <a ref="cardEl" class="card" :class="session.status" :href="hrefFor(session.request_id)">
    <button
      class="card-archive"
      type="button"
      :title="isArchived ? 'Unarchive — put this run back in review' : 'Archive — remove this run from review'"
      :aria-label="isArchived ? 'Unarchive run' : 'Archive run'"
      @click="archive"
    >
      {{ isArchived ? '↺' : '×' }}
    </button>
    <span class="card-id">{{ session.request_id }}</span>
    <span class="card-req" :title="session.request ?? ''">{{ session.request }}</span>

    <div v-if="rows.length" class="tl">
      <div class="tl-axis">
        <span class="tl-gutter" />
        <span class="tl-scale">
          <span
            v-for="(t, i) in ticks"
            :key="i"
            class="tl-tick"
            :class="{ edge: t.pct === 0 }"
            :style="{ left: `${t.pct}%` }"
            >{{ t.label }}</span
          >
        </span>
      </div>
      <div v-for="row in visibleRows" :key="row.owner" class="tl-row">
        <span class="tl-agent" :style="{ color: row.color }" :title="row.title">{{
          row.owner
        }}</span>
        <span class="tl-track">
          <span
            v-for="dot in row.dots"
            :key="dot.id"
            class="tl-dot"
            :class="{ latest: dot.latest }"
            :style="{ left: `${dot.xPct}%`, background: dot.color }"
            :title="dot.title"
          />
        </span>
      </div>
      <div v-if="hiddenRowCount" class="tl-more dim">+{{ hiddenRowCount }} more agents</div>
    </div>
    <div v-else class="tl tl-empty faint">no agent activity yet</div>

    <div class="card-foot">
      <span class="foot-status">
        <StatusChip :status="session.status ?? 'unknown'" />
        <PhaseDots :phases="session.phases" />
      </span>
      <span class="dim">{{ fmtDate(session.started_at) }}</span>
    </div>
    <div class="card-stats">
      <StatChip kind="cost" :value="session.total_cost" />
      <StatChip kind="runtime" :value="durationMs" />
      <StatChip kind="tokens" :value="session.total_tokens" />
    </div>
  </a>
</template>

<style scoped>
.card {
  /* Uniform size: the grid fixes the width, this fixes the height — content
     clamps and truncates rather than resizing the card. Grew by one 40px row
     slot when the timeline went from three to four. */
  height: 420px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 22px;
  position: relative;          /* anchors the archive button */
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  overflow: hidden;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.card-archive {
  /* Top-right of the card, out of the text flow so nothing reflows around it. */
  position: absolute;
  top: 10px;
  right: 12px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dim);
  font-family: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}

/* Hidden until the card is hovered — 50 cards should read as runs, not as a
   wall of close buttons. Focus reveals it too, so keyboards are not excluded. */
.card:hover .card-archive,
.card-archive:focus-visible {
  opacity: 1;
}

.card-archive:hover {
  background: rgba(255, 111, 103, 0.16);
  color: #ff6f67;
}

.card:hover {
  border-color: rgba(148, 163, 255, 0.45);
  box-shadow: 0 10px 34px rgba(148, 163, 255, 0.12);
  transform: translateY(-2px);
}

.card.running {
  border-color: rgba(108, 182, 255, 0.6);
  box-shadow: 0 0 22px rgba(108, 182, 255, 0.16);
}

.card.fail {
  border-color: rgba(255, 111, 103, 0.6);
}

/* Text rows must never absorb flex shrink — the fixed-height card squeezes
   overflow into .tl (which clips), not into the text. */
.card-id {
  flex: none;
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 700;
  color: var(--purple);
}

.card-req {
  flex: none;
  font-size: 16px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl {
  display: flex;
  flex-direction: column;
  margin-top: 4px;
  /* Fixed region: axis (28 + 6) + four 40px row slots, roster size or not.
     Four slots is what lets three agents show alongside a "+N more" line. */
  height: 194px;
  flex: none;
  overflow: hidden;
}

.tl-more {
  display: flex;
  align-items: center;
  height: 40px;
  padding-left: 96px;
  font-size: 16px;
}

.tl-axis {
  display: flex;
  align-items: flex-end;
  height: 28px;
  margin-bottom: 6px;
}

.tl-gutter,
.tl-agent {
  flex: none;
  /* Wide enough for full agent names (planner, builder, documenter). */
  width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 8px;
}

.tl-scale {
  position: relative;
  flex: 1;
  height: 100%;
  border-bottom: 1px solid var(--border);
}

.tl-tick {
  position: absolute;
  bottom: 4px;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 16px;
  color: var(--faint);
  white-space: nowrap;
}

.tl-tick.edge {
  transform: none;
}

.tl-row {
  display: flex;
  align-items: center;
  height: 40px;
}

.tl-agent {
  font-size: 16px;
  color: var(--dim);
}

.tl-track {
  position: relative;
  flex: 1;
  height: 100%;
  border-bottom: 1px solid var(--border-soft);
}

.tl-dot {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.tl-dot.latest {
  width: 13px;
  height: 13px;
  box-shadow: 0 0 10px currentColor;
  animation: pulse 1.4s ease-in-out infinite;
}

.tl-empty {
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: auto;
  font-size: 16px;
}

.foot-status {
  display: inline-flex;
  align-items: center;
  gap: 14px;
}

.card-stats {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
