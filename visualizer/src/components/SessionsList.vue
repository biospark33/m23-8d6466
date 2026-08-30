<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { SessionSummary } from '../lib/types'
import { fetchSessions } from '../lib/api'
import { usePoller } from '../lib/poll'
import { ts } from '../lib/format'
import SessionCard from './SessionCard.vue'

const sessions = shallowRef<SessionSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let inflight = false
/** Bumped on every archive-mode change. A tick started under an earlier
 *  generation belongs to the mode active when it was FIRED, not the mode
 *  active when it RESOLVES — comparing generations lets a settling request
 *  tell whether its response is still the selected view. */
let generation = 0

/** Which side of the archive flag is listed. The archived side is the only
 *  place a mis-archived run can be reached to put it back. */
const showArchived = ref(false)

function toggleArchived() {
  showArchived.value = !showArchived.value
  generation++
  sessions.value = []
  loaded.value = false
  void tick()
}

const poller = usePoller(() => void tick())

async function tick() {
  if (inflight) return
  inflight = true
  const gen = generation
  try {
    const result = await fetchSessions(showArchived.value)
    // The archive mode changed while this fetch was in flight: `result` is
    // for the OLD mode. Drop it rather than let it flash in as the new
    // mode's view; `finally` below schedules a fresh tick for the current one.
    if (gen !== generation) return
    sessions.value = result
    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
    poller.onSuccess()
  } catch (err) {
    if (gen !== generation) return
    apiError.value = err instanceof Error ? err.message : String(err)
    poller.onFailure()
  } finally {
    inflight = false
    // toggleArchived's own tick() call, fired while this one was still in
    // flight, was a no-op under the `inflight` guard above — so once the
    // stale request settles, this is the only thing that starts the refresh
    // for the mode the user actually selected.
    if (gen !== generation) void tick()
  }
}

onMounted(() => {
  void tick()
  poller.start()
})

onUnmounted(poller.stop)

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
      <button
        type="button"
        class="archived-toggle"
        :aria-pressed="showArchived"
        @click="toggleArchived"
      >
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
