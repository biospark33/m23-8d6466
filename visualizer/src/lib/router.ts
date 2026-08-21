import { ref } from 'vue'

// Hash routes: #/ → sessions · #/<request_id> → waterfall · #/<request_id>/<phase_id> → phase panel open
export interface Route {
  requestId: string | null
  phaseId: string | null
}

function parse(): Route {
  const parts = window.location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
  return { requestId: parts[0] ?? null, phaseId: parts[1] ?? null }
}

const route = ref<Route>(parse())

window.addEventListener('hashchange', () => {
  route.value = parse()
})

export function useRoute() {
  return route
}

// Display name for the phase crumb — set by the trace view once phases load,
// since the phase_id in the URL is not the display name.
export const phaseCrumb = ref<string | null>(null)

export function hrefFor(requestId?: string | null, phaseId?: string | null): string {
  let h = '#/'
  if (requestId) h += encodeURIComponent(requestId)
  if (requestId && phaseId) h += `/${encodeURIComponent(phaseId)}`
  return h
}

export function navigate(requestId?: string | null, phaseId?: string | null): void {
  window.location.hash = hrefFor(requestId, phaseId)
}
