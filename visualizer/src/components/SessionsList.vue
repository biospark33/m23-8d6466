<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { SessionSummary } from '../lib/types'
import { fetchSessions } from '../lib/api'
import { ts } from '../lib/format'
import SessionCard from './SessionCard.vue'

const sessions = shallowRef<SessionSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

/** Which side of the archive flag is listed. The archived side is the only
 *  place a mis-archived run can be reached to put it back. */
const showArchived = ref(false)

function toggleArchived() {
  showArchived.value = !showArchived.value
  sessions.value = []
  loaded.value = false
  void tick()
}

const POLL_MS = 500
const MAX_POLL_MS = 30_000
/** Consecutive failed ticks — backs the poll off so a dead api is not hammered
 *  twice a second for as long as the tab stays open. */
let fails = 0

function stopPolling() {
  clearInterval(timer)
  timer = undefined
}

function startPolling(ms: number = POLL_MS) {
  stopPolling()
  timer = setInterval(() => void tick(), ms)
}

async function tick() {
  if (inflight) return
  inflight = true
  try {
    sessions.value = await fetchSessions(showArchived.value)
    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
    if (fails) {
      fails = 0
      // Re-arm only if a timer is still live: a tick that resolves after
      // onUnmounted would otherwise install an interval nothing ever clears.
      if (timer) startPolling()
    }
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
    fails++
    if (timer) startPolling(Math.min(POLL_MS * 2 ** Math.min(fails, 6), MAX_POLL_MS))
  } finally {
    inflight = false
  }
}

onMounted(() => {
  void tick()
  startPolling()
})

onUnmounted(stopPolling)

/** Optimistic removal; an empty id means the write failed, so re-sync instead. */
function onArchived(requestId: string) {
  if (!requestId) {
    void tick()
    return
  }
  sessions.value = sessions.value.filter((s) => s.request_id !== requestId)
}

const ordered = computed(() =>
  sessions.value.toSorted((a, b) => (ts(b.started_at) || 0) - (ts(a.started_at) || 0)),
)
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div class="list-head dim">
      <span v-if="ordered.length">{{ ordered.length }} {{ showArchived ? 'archived runs' : 'runs' }}</span>
      <button type="button" class="archived-toggle" @click="toggleArchived">
        {{ showArchived ? 'show active' : 'show archived' }}
      </button>
    </div>

    <div v-if="ordered.length" class="cards">
      <SessionCard
        v-for="s in ordered"
        :key="s.request_id"
        :session="s"
        :now-ms="nowMs"
        @archived="onArchived"
      />
    </div>
    <div v-else-if="loaded" class="empty-state">
      {{ showArchived ? 'nothing archived' : 'no sessions yet — run a request to see it here' }}
    </div>
    <div v-else-if="!apiError" class="empty-state">loading sessions…</div>
  </div>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
}

.list-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 16px 24px 0;
  font-size: 16px;
}

.archived-toggle {
  margin-left: auto;
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.cards {
  /* Uniform grid: every card the same width and (fixed in SessionCard) height,
     independent of content. */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(460px, 1fr));
  gap: 18px;
  padding: 16px 24px 28px;
}





</style>
