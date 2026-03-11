# UX Amendment Document — Session 8

**Date:** 2026-03-10
**Scope:** Dashboard amendments for self-learning system observability, economic governance, system health, and epic-level visibility
**Source findings:** COMP-020 through COMP-024 (missing UX paths), 10X-008 (burn rate prediction), FAIL-020/ADR-023 (health circuit breaker), ARCH10X-002 (channel abstraction), ARCH10X-006 (throughput visualization)
**Amends:** `ux-design-specification.md` sections: Agent Performance Dashboard Surface, AmbientHeader component, Dashboard Copilot, Component Strategy
**Adds:** Learning Effectiveness Panel, Burn Rate Prediction Panel, System Health Indicator, Epic Progress View, Channel Status Panel

---

## Section 1: Amendment Preamble

### Dashboard Philosophy Revision

The existing UX specification describes the dashboard as a "developer operations control plane" providing "visibility, control, and trust over an autonomous multi-agent coding factory." This remains correct but incomplete. Session 7 and Session 8 synthesis revealed a missing dimension: **the dashboard must also answer whether the autonomous system is improving over time.**

**Revised dashboard philosophy:**

The dashboard is an **observation and steering surface for an autonomous self-learning system.** The developer's relationship to the factory is analogous to a plant manager monitoring an automated production line -- not a supervisor reviewing every unit of work, but an operator watching throughput, yield rates, and maintenance burden to confirm the system is running well and getting better.

Three questions drive all dashboard design decisions, in priority order:

1. **Is the system working?** Stories progressing through the pipeline, agents healthy, budgets on track. Answered by existing surfaces: story cards, pipeline progress, factory vitals, cost attribution.

2. **Is it getting better?** Maintenance burden decreasing over time, learning records accumulating and proving effective, fewer fix loops per story as the overlay gets richer. Answered by NEW surfaces: Learning Effectiveness Panel, historical performance trends.

3. **When does it need me?** Escalations only -- budget breach, unresolvable conflict, ambiguous spec, system health degradation. Answered by REVISED surfaces: escalation banners, system health indicator, burn rate predictions.

**Primary metric visible everywhere:** The maintenance burden trend (maintenance fixes per story, trailing 20-story average) appears as a sparkline in the header bar. This single metric answers "is the system getting smarter?" at a glance. A declining trend means the learning system is working. A flat or rising trend means something needs architectural attention.

**Design principle addition (Experience Principle 8):**

8. **Autonomy-aware density.** The dashboard optimizes for the 95% case where nothing needs developer attention. Key health metrics are always visible but unobtrusive. Investigation surfaces exist but are hidden behind progressive disclosure. The default state communicates "everything is fine, the system is learning" through visual calm -- uniform colors, declining trend lines, green indicators. Anomalies break the calm and draw the eye.

---

## Section 2: Revised Performance Dashboard

### Amendment target: Agent Performance Dashboard Surface (line 1516 of ux-design-specification.md)

The existing Performance Dashboard Surface defines the Performance Card Component, Tier Badge Design, ELO Trend Sparklines, Calibration Curve Visualization, Credit Balance Display, Performance Overview Panel, Tier Override Modal, and Interaction Patterns. Session 7's Completeness Checker identified 5 missing UX paths (COMP-020 through COMP-024). All 5 are addressed below.

Additionally, per Session 8 synthesis (ECON-001, ECON-002): the Credit Balance Display and per-agent monthly budget bar are **removed** from the Performance Card. Credits and per-agent budgets have been eliminated from the system design. Replace those visual elements with per-story cost attribution (read-only, informational) displayed elsewhere in the story card.

---

### 2a. Empty State Guidance (resolves COMP-020)

**Problem:** The existing specification defines an empty state as a single line: "No performance data yet -- ratings populate after first story completion." This is insufficient for a data-dependent system that needs 3+ completed stories before performance insights become meaningful.

**Revised empty state specification:**

The Performance Overview Panel has three progressive empty states based on story completion count:

**State 1: Zero completed stories (fresh install)**

```
+----------------------------------------------------------+
|  Performance Overview                                     |
|  ---------------------------------------------------------|
|                                                           |
|    [sparkline ghost]  [bar ghost]  [score ghost]          |
|    Agent Scores       Domain ELO    Calibration           |
|                                                           |
|    [sparkline ghost]  [bar ghost]  [trend ghost]          |
|    Fix-Loop Rate      Tier Dist.    Maintenance           |
|                                                           |
|  The learning system is collecting data.                  |
|  Performance insights will appear after 3 completed       |
|  stories.                                                 |
|                                                           |
|  Stories completed: 0 of 3 needed for initial insights    |
|  [|||                                          ]          |
|                                                           |
+----------------------------------------------------------+
```

**Visual specification:**
- Six ghost/skeleton cards arranged in a 3x2 grid, each 200x120px
- Each ghost card has a `text-muted` label beneath it describing what will appear: "Agent Scores", "Domain ELO", "Calibration", "Fix-Loop Rate", "Tier Distribution", "Maintenance Trend"
- Ghost cards use the skeleton shimmer animation (`bg-secondary` with a 2-second `linear-gradient` sweep from left to right at 30% `bg-elevated` opacity), consistent with existing dashboard loading pattern
- Progress indicator: horizontal bar, `bg-secondary` background, `status-blue` fill, showing completion fraction (0/3, 1/3, 2/3)
- Text uses `text-secondary` color, centered below the ghost grid
- No "no data" dead ends -- every empty panel shows what will appear and when

**State 2: 1-2 completed stories (partial data)**

```
+----------------------------------------------------------+
|  Performance Overview                                     |
|  ---------------------------------------------------------|
|                                                           |
|    Agent Scores (preliminary)                             |
|    Builder-01   0.72  (1 story)                           |
|    Reviewer-01  0.85  (2 stories)                         |
|                                                           |
|    [bar ghost]  [trend ghost]  [calibration ghost]        |
|    Domain ELO   Maintenance     Calibration               |
|                                                           |
|  Collecting data: 2 of 3 stories complete.                |
|  Domain ratings and trend analysis need 1 more story.     |
|  [|||||||||||||||||||||                        ]          |
|                                                           |
+----------------------------------------------------------+
```

**Visual specification:**
- Panels with sufficient data (composite scores need only 1 story) render with real data, marked "(preliminary)" in `text-muted`
- Panels without sufficient data remain as ghost cards with the label showing what is needed: "Needs 3 stories", "Needs 5 domain-specific stories"
- Progress bar updates: `status-blue` fill advances proportionally
- Preliminary scores display with a dashed left border (`border-dashed`, `text-secondary`) instead of the solid tier-colored border used for stable scores

**State 3: 3+ completed stories (full data)**

All ghost cards replaced with real panels. The progress indicator disappears. Standard Performance Overview renders. No transition animation -- on the page load where the third story completes, the dashboard renders the full performance view directly.

**Individual Performance Card empty state:**

When a specific agent has no completed stories yet (newly spawned mid-epic):

```
+--------------------------------------------+
|  Builder-04          Tier 1 (default)       |
|  ----------------------------------------- |
|                                             |
|  No performance data for this agent.        |
|  Ratings will appear after this agent       |
|  completes its first story.                 |
|                                             |
|  Current assignment: Story QDS-47 (Dev)     |
|                                             |
+--------------------------------------------+
```

- Show the agent's current assignment if one exists
- Tier badge shows "T1" in `text-tertiary` with "(default)" label
- No score, no sparklines, no calibration chart

---

### 2b. Tier Transition Visuals (resolves COMP-021)

**Problem:** The existing spec defines static tier badges but no visual treatment for the moment of tier change (promotion or demotion), no transition history, and no hysteresis indicator.

**Note:** Per Session 7 recommendation (SCOPE-001), tier behavioral effects (layers 4-6 of the performance system) are Growth phase. However, the data collection and visualization for tiers is MVP. These visuals are specified now for Growth implementation but the data structures and component shells are created in MVP.

**Tier promotion visual:**

When an agent's tier increases after a story completion:

1. The tier badge on the Performance Card and Performance Overview grid card animates:
   - Old badge fades out (200ms, `opacity 1 -> 0`)
   - New badge fades in with a single `status-green` ring pulse (400ms ease-out, `box-shadow: 0 0 0 4px` at 50% opacity, then 0)
   - Badge settles to new tier icon and color
   - Total animation duration: 600ms
   - `prefers-reduced-motion`: instant swap, static `status-green` 2px outline for 2 seconds

2. A transition record appears in the Performance Card's Session History section:

```
  Tier History
  T3 -> T4  after Story 47  (ELO: 1382, Mar 8)    [green up-arrow]
  T2 -> T3  after Story 31  (ELO: 1355, Mar 3)    [green up-arrow]
  T1 -> T2  after Story 12  (ELO: 1310, Feb 22)   [green up-arrow]
```

   - Each record shows: old tier, new tier, triggering story, ELO at transition, date
   - Records use `text-secondary` with a `status-green` up-arrow icon (12px) for promotions
   - Maximum 10 most recent transitions displayed; "Show all" link if more exist
   - Records are scrollable within a fixed 120px height container

**Tier demotion visual:**

When an agent's tier decreases (per COMP-001 demotion criteria: ELO drops below threshold-50 for 3 consecutive stories):

1. Badge animation:
   - Old badge pulses once with `status-amber` ring (400ms)
   - Old badge fades out, new badge fades in (same timing as promotion)
   - New badge settles with an `status-amber` left border accent (2px) that fades after 5 seconds
   - `prefers-reduced-motion`: instant swap, static `status-amber` 2px outline for 3 seconds

2. Transition record uses `status-amber` down-arrow icon:

```
  T4 -> T3  after Story 62  (ELO: 1298, Mar 10)   [amber down-arrow]
```

**Hysteresis indicator (resolves PERV-009):**

When an agent's ELO is within the hysteresis band (within 50 points of a tier boundary), the Performance Card shows a hysteresis status line:

```
  ELO: 1338  (Tier 3 boundary: 1350)
  In dwell period: 2 of 3 stories before tier change eligible
  [||||||||||||||||          ] 2/3
```

- Displayed below the Domain Ratings section in the expanded Performance Card
- Text in `text-muted`
- Small progress bar (100px wide, 4px height): `bg-secondary` background, `status-amber` fill
- Only appears when the agent is within the hysteresis band; hidden otherwise
- Tooltip on the progress bar: "Tier transitions require 3 consecutive stories above (promotion) or below (demotion) the threshold to prevent tier thrashing."

---

### 2c. Historical Performance Trend View (resolves COMP-022)

**Problem:** The existing spec shows only the last 10 session results as pass/fail dots and a simple ELO sparkline per domain. No historical view for composite score trends, fix-loop rate trends, or maintenance fix trends.

**Specification:**

Add a "Trends" tab to the Performance Overview Panel. The Performance Overview Panel gains two tabs: "Overview" (existing grid view) and "Trends" (new). Tab switching uses the same pattern as existing dashboard tabs (48px tab bar, `border-b-2` active indicator in `status-blue`, `text-primary` active / `text-secondary` inactive).

**Trends tab layout:**

```
+----------------------------------------------------------+
|  Performance Overview     [Overview] [Trends]             |
|  ---------------------------------------------------------|
|  Time range: [7d] [30d] [90d] [All]                       |
|                                                           |
|  Agent Composite Scores                                   |
|  +----------------------------------------------------+  |
|  |   1.0 |                                             |  |
|  |       |     ___----                                 |  |
|  |   0.7 |  --/       \___---  Builder-01              |  |
|  |       |                      ----  Reviewer-01      |  |
|  |   0.4 |                                             |  |
|  |       |___---   Scout-01                            |  |
|  |   0.0 |_________________________________________|  |  |
|  |        Story 1        Story 10       Story 20       |  |
|  +----------------------------------------------------+  |
|                                                           |
|  Fix-Loop Rate (per story)                                |
|  +----------------------------------------------------+  |
|  |   3   |  *                                          |  |
|  |       |     *   *                                   |  |
|  |   1   |          *  *     *                         |  |
|  |       |                *     *  *  *  *  0          |  |
|  |   0   |_________________________________________|  |  |
|  +----------------------------------------------------+  |
|                                                           |
|  Maintenance Fix Rate (per story)                    KEY  |
|  +----------------------------------------------------+  |
|  |   4   |  *  *                                       |  |
|  |       |        *                                    |  |
|  |   2   |           *  *                              |  |
|  |       |                 *  *     *                  |  |
|  |   0   |                       *  *  *  *  0         |  |
|  +----------------------------------------------------+  |
|  THE key metric: should decline as the system learns      |
|                                                           |
|  Codebase Maintenance Heatmap                             |
|  src/pipeline/    [|||||||||||||        ] 12 fixes        |
|  src/agents/      [||||||               ]  6 fixes        |
|  src/overlay/     [||||                 ]  4 fixes        |
|  src/gateway/     [||                   ]  2 fixes        |
|  tests/           [|                    ]  1 fix          |
|                                                           |
+----------------------------------------------------------+
```

**Chart specifications:**

**Agent Composite Scores chart:**
- Line chart, one line per agent, colored by agent role (Builder = `status-blue`, Reviewer = `status-green`, Scout = `status-amber`, QA = `#a78bfa` purple-400)
- X-axis: story number (not date), with date shown on hover tooltip
- Y-axis: composite score 0.00 to 1.00
- Data points: composite score per story for each agent
- Hover tooltip: "Builder-01: 0.78 (Story 47, Mar 8)"
- Line stroke: 2px, with 4px circle markers at each data point
- Chart height: 200px, full width of the panel content area
- If an agent participated in fewer stories than the range, its line starts at the first story it participated in
- Legend: agent names listed to the right of the chart, each with a color-coded circle

**Fix-Loop Rate chart:**
- Scatter plot with trend line overlay
- X-axis: story number
- Y-axis: number of fix-loop iterations for that story (integer, 0+)
- Data points: 6px filled circles in `status-amber`
- Trend line: 2px dashed line in `text-secondary`, computed as 5-story rolling average
- Chart height: 160px
- Annotation: if the trend line slope is negative, a `text-muted` label reads "Declining" with a green down-arrow; if flat or positive, label reads "Needs attention" with an amber right-arrow or red up-arrow

**Maintenance Fix Rate chart:**
- Same visual treatment as Fix-Loop Rate chart but with `status-red` data points
- This is the most important chart on the entire dashboard -- add a subtle `border-l-2` in `status-blue` accent to visually distinguish it
- Below the chart: a one-line annotation in `text-secondary`: "This is the primary indicator of learning effectiveness. A declining trend means the system is learning."

**Codebase Maintenance Heatmap:**
- Horizontal bar chart showing directories ranked by maintenance fix count within the selected time range
- Top 10 directories shown; "Show all" link if more exist
- Bar color: gradient from `status-amber` (few fixes) to `status-red` (many fixes), using 3 steps: 1-3 fixes = `status-amber`, 4-7 = `#f97316` (orange-500), 8+ = `status-red`
- Bar width: proportional to fix count, maximum width = panel content width
- Each bar labeled with directory path (left) and fix count (right)
- Clicking a directory bar filters the Fix-Loop Rate and Maintenance Fix Rate charts to show only stories that touched that directory

**Time range selector:**
- Segmented button group in the top-right of the Trends tab
- Options: "7d", "30d", "90d", "All"
- Default: "30d"
- Active segment: `bg-elevated` with `text-primary`; inactive: `bg-secondary` with `text-secondary`
- Clicking a segment re-renders all charts with the corresponding time window
- "7d" and "30d" are date-based; "All" shows all historical data from the first story
- If the selected range has fewer than 3 data points, show a `text-muted` message below the chart: "Not enough data for this time range. Try a wider range."

---

### 2d. Error States (resolves COMP-023)

**Problem:** The existing spec defines a generic error boundary pattern ("Same error boundary pattern as other dashboard panels") without specifying what performance-system-specific errors look like or what information they convey.

**Performance data corruption error:**

Triggered when: `pipeline.db` performance tables fail integrity checks, or performance data export produces inconsistent results.

```
+----------------------------------------------------------+
|  Performance Overview                                     |
|  ---------------------------------------------------------|
|                                                           |
|  [warning icon]  Performance data is being rebuilt.       |
|                                                           |
|  Scores may be approximate for the next few stories       |
|  while the system recomputes ratings from raw hook data.  |
|                                                           |
|  What happened: Integrity check detected inconsistent     |
|  scoring records for 3 agents.                            |
|                                                           |
|  What's affected: Composite scores and domain ratings     |
|  may show stale values until rebuild completes.           |
|                                                           |
|  What the system is doing: Recomputing from source        |
|  hook results. Estimated: 5-10 minutes.                   |
|                                                           |
|  Developer action needed: No. Stories continue normally.  |
|                                                           |
+----------------------------------------------------------+
```

**Visual specification:**
- Warning icon: triangle with exclamation mark, `status-amber`, 24px
- Header text: `text-primary`, 16px, semibold
- Body text: `text-secondary`, 14px
- Four-line information structure: What happened / What's affected / What the system is doing / Developer action needed
- Background: `bg-secondary` with `border-l-4 border-amber-500`
- This replaces the normal Performance Overview content but does NOT block other dashboard surfaces

**ELO recalculation notice:**

Triggered when: the scoring algorithm is updated (versioned epoch, per COMP-009), causing all historical ratings to be reprocessed.

```
+----------------------------------------------------------+
|  [recalc icon]  Recalculating ratings after algorithm     |
|  update.                                                  |
|                                                           |
|  Current ratings are estimates. Final ratings will be     |
|  available when reprocessing completes.                   |
|                                                           |
|  Reprocessing story 47 of 312...                          |
|  [||||||||||||||||                             ] 15%      |
|                                                           |
|  Developer action needed: No.                             |
+----------------------------------------------------------+
```

**Visual specification:**
- Recalc icon: circular arrow, `status-blue`, 20px
- Progress bar: `bg-secondary` background, `status-blue` fill, 4px height, full width
- Progress text: `text-muted`, "Reprocessing story N of M..."
- This banner appears ABOVE the Performance Overview content, not replacing it (see 2e for how existing data is shown during recalc)

**Learning system unavailable:**

Triggered when: the learning record synthesis, pattern mining, or overlay enrichment subsystems fail to respond.

```
+----------------------------------------------------------+
|  [offline icon]  Learning system offline.                 |
|                                                           |
|  Stories will continue processing but without overlay     |
|  enrichment from learning records. Fix-loop rates may     |
|  temporarily increase.                                    |
|                                                           |
|  What happened: Learning record synthesis failed to       |
|  respond within 5 seconds.                                |
|                                                           |
|  What's affected: New stories will not receive learning   |
|  overlays. Existing stories in progress are unaffected.   |
|                                                           |
|  What the system is doing: Retrying every 60 seconds.     |
|  Last retry: 30 seconds ago.                              |
|                                                           |
|  Developer action needed: No, unless this persists for    |
|  more than 30 minutes.  [View System Health]              |
|                                                           |
+----------------------------------------------------------+
```

**Visual specification:**
- Offline icon: circle with diagonal line, `status-red`, 20px
- "[View System Health]" is a text link in `status-blue` that navigates to the System Health Indicator (Section 5)
- Background: `bg-secondary` with `border-l-4 border-red-500`
- If the learning system recovers, the banner transitions to a recovery confirmation ("Learning system reconnected. Overlay enrichment resumed.") in `status-green` border for 30 seconds, then disappears

**Error state component:**

All three error states use a shared `PerformanceAlert` component:

```typescript
interface PerformanceAlertProps {
  severity: 'warning' | 'info' | 'error';
  icon: 'warning' | 'recalc' | 'offline';
  title: string;
  sections: {
    label: string;   // "What happened", "What's affected", etc.
    content: string;
  }[];
  progress?: {
    current: number;
    total: number;
    label: string;   // "Reprocessing story 47 of 312..."
  };
  actionNeeded: boolean;
  actionLink?: {
    label: string;
    target: string;  // route or panel identifier
  };
}
```

- `severity: 'warning'` -> `border-amber-500` left border
- `severity: 'info'` -> `border-blue-500` left border
- `severity: 'error'` -> `border-red-500` left border
- Component is rendered at the top of the Performance Overview Panel, pushing content down (not overlaying)
- Multiple alerts stack vertically, ordered by severity (error > warning > info)
- Each alert is independently dismissable via an "x" button (top-right, `text-muted`, 16px). Dismissing hides the alert for the current session. If the underlying condition persists, the alert reappears on next page load.

---

### 2e. Loading States During ELO Recalculation (resolves COMP-024)

**Problem:** No specification for how the Performance Dashboard behaves while ELO ratings are being recomputed. Should the dashboard show stale data, block, or show a loading indicator?

**Specification: Non-blocking with stale data indicators.**

During ELO recalculation, the dashboard remains fully functional. All panels continue to render. Panels that contain recalculating data show three visual modifications:

1. **Inline loading indicator:** A small (16px) circular spinner appears in the top-right corner of each affected panel, alongside a "Recalculating..." label in `text-muted`, 12px.

2. **Stale data dimming:** Current values are shown at 60% opacity (`opacity-60`). This signals "this data is present but may not be final." The data remains readable and interactive.

3. **Last-updated timestamp:** Below each affected value, a `text-muted` timestamp: "Last updated: 4 minutes ago" in 11px. This timestamp updates every 30 seconds to reflect the growing staleness.

**Which panels are affected:**
- Performance Card: composite score, domain ratings, calibration curve
- Performance Overview grid: all agent scores and tier badges
- Trends tab: all charts (they use historical data being reprocessed)

**Which panels are NOT affected (and render normally):**
- Session History pass/fail dots (these are factual, not rating-dependent)
- Tier History records (historical, already committed)
- The recalculation progress banner (Section 2d)

**Progress indicator in panel:**

```
  Domain Ratings              [spinner] Recalculating...
  backend-api    ████████░░  1450 ↑     (opacity: 60%)
  frontend-react ██████░░░░  1280 →     (opacity: 60%)
  Last updated: 4 minutes ago
```

**Completion behavior:** When recalculation completes:
1. Spinner disappears
2. Values update to final ratings (animated number transition, 300ms)
3. Opacity returns to 100% (200ms transition)
4. "Last updated" timestamp disappears
5. Recalculation progress banner (from 2d) transitions to a brief confirmation: "Ratings updated." in `status-green`, auto-dismisses after 5 seconds

**Reduced motion:** Spinner replaced with static "..." text. No animated number transition -- values snap to final.

---

## Section 3: Learning Effectiveness Panel (NEW)

**Source:** Session 8 synthesis requirement. This is the most important new dashboard surface. It answers the second core question: "Is the system getting smarter?"

**Location:** Bottom drawer of the main dashboard view, below the story card grid. Collapsed by default. Toggle via a "Learning" tab in a new bottom drawer tab bar (see Section 10 for layout).

**Drawer behavior:**
- Collapsed: a thin (40px) tab bar is visible at the bottom of the viewport, with tabs "Learning" and "Economics"
- Click "Learning" tab: drawer slides up to 400px height (320ms ease-out), pushing story card grid content area up
- Drawer height is resizable via drag handle (range: 280px-600px). Height preference persisted in localStorage.
- Drawer can be collapsed by clicking the active tab again, pressing Escape, or dragging the handle to minimum
- Drawer remains open across story card interactions (expanding a story card does not collapse the drawer)
- When the drawer is open, the story card grid scrolls independently above it (two independent scroll regions)

---

### 3a. Maintenance Burden Trend

**The primary chart of the Learning Effectiveness Panel.**

```
+----------------------------------------------------------+
|  Learning Effectiveness               [7d] [30d] [90d]   |
|  ---------------------------------------------------------|
|                                                           |
|  Maintenance Burden Trend                                 |
|  Fixes per story, trailing average                        |
|  +----------------------------------------------------+  |
|  |   5 |                                               |  |
|  |     | [###]                                         |  |
|  |   3 | [###][===]                                    |  |
|  |     |      [===][###]                               |  |
|  |   1 |           [===][---]                          |  |
|  |     |                [---][---][---]   0.4          |  |
|  |   0 |_________________________________________|    |  |
|  |      S1   S5   S10  S15  S20  S25  S30             |  |
|  +----------------------------------------------------+  |
|  [###] Preventable  [===] Systemic  [---] Unforeseeable  |
|                                                           |
+----------------------------------------------------------+
```

**Chart specification:**
- Stacked area chart, 3 categories:
  - **Preventable** (`status-red` at 40% opacity): fixes that the learning system could have prevented with existing knowledge. These trending to zero = the system is learning.
  - **Systemic** (`status-amber` at 40% opacity): fixes that indicate architectural issues. Flagged for developer attention. Tag: "architectural attention recommended" on stories with systemic fixes.
  - **Unforeseeable** (`text-tertiary` at 40% opacity): fixes due to novel requirements or external changes. Expected to remain roughly constant.
- X-axis: story number
- Y-axis: number of maintenance fixes
- Trend line: 5-story rolling average, overlaid as a 2px solid line in `text-primary`
- Chart height: 200px, full width of the drawer content area
- Annotation below chart: if the "Preventable" area is trending toward zero, show "Learning system is converging -- preventable fixes declining" in `status-green`. If "Systemic" is rising, show "Systemic fixes increasing -- consider architectural review" in `status-amber`.
- Time range selector shared with Section 2c: same "[7d] [30d] [90d] [All]" segmented control, affecting all charts in the drawer

---

### 3b. Learning Records Feed

**A filterable list of learning records showing what the system has learned and its impact.**

```
+----------------------------------------------------------+
|  Recent Learning Records           [Filter: All areas v]  |
|  ---------------------------------------------------------|
|                                                           |
|  [green dot] auth/jwt-validation pattern                  |
|  Learned from: Story 42 (fix-loop)                        |
|  Category: Error handling  |  Area: src/auth/             |
|  Applied to 8 subsequent stories                          |
|  Impact: Stories touching auth had 40% fewer fix loops    |
|  after this learning was added                            |
|  -------------------------------------------------------- |
|                                                           |
|  [blue dot] webhook retry-with-backoff pattern            |
|  Learned from: Story 38 (maintenance fix)                 |
|  Category: Integration  |  Area: src/payments/            |
|  Applied to 3 subsequent stories                          |
|  Impact: Measuring (fewer than 5 applications)            |
|  -------------------------------------------------------- |
|                                                           |
|  [amber dot] test isolation for database fixtures         |
|  Learned from: Story 45 (review finding)                  |
|  Category: Testing  |  Area: tests/                       |
|  Applied to 1 subsequent story                            |
|  Impact: Too early to measure                             |
|  -------------------------------------------------------- |
|                                                           |
|  Showing 3 of 47 records  [Load more]                     |
|                                                           |
+----------------------------------------------------------+
```

**Specification:**
- List layout with 20 records per page, "Load more" button for pagination
- Each record is a card (full width, `bg-secondary`, 1px `border-default` border, 12px padding)

**Record card content:**
- **Status dot** (8px circle, left-aligned):
  - Green: learning has measurably reduced fix loops/maintenance (5+ applications, positive impact)
  - Blue: learning is being applied but impact is not yet measurable (<5 applications)
  - Amber: learning was recently added (<3 stories since)
  - Red: learning was applied but did not prevent the expected issue (false positive pattern -- see 3d)
- **Title:** pattern name or description, `text-primary`, 14px, semibold
- **Source line:** "Learned from: Story N (source type)" in `text-secondary`, 13px. Source types: fix-loop, maintenance fix, review finding, cross-story pattern
- **Metadata line:** "Category: X | Area: path/" in `text-muted`, 12px
- **Application count:** "Applied to N subsequent stories" in `text-secondary`, 13px
- **Impact line:** quantified impact if available, or "Too early to measure" / "Measuring" in `text-muted`

**Filter controls:**
- **Area filter:** dropdown populated from codebase directory tree. Options: "All areas", then each top-level `src/` directory. Selecting filters the list to records whose area matches.
- **Type filter:** dropdown with options: "All types", "Fix-loop", "Maintenance", "Review", "Cross-story pattern"
- **Impact filter:** dropdown with options: "All", "Proven effective", "Measuring", "Too early", "Ineffective"
- Filters are additive (AND logic). Active filters shown as removable pills below the filter bar.

---

### 3c. Overlay Enrichment Depth

**A chart showing how much learning content is being injected into agent overlays per story.**

```
+----------------------------------------------------------+
|  Overlay Enrichment                                       |
|  ---------------------------------------------------------|
|                                                           |
|  Learning records injected per story                      |
|  +----------------------------------------------------+  |
|  |  20 |                          ___----====          |  |
|  |     |              ___----====                      |  |
|  |  10 |     ___----/                                  |  |
|  |     | __/                                           |  |
|  |   0 |_________________________________________|    |  |
|  +----------------------------------------------------+  |
|  Should increase, then plateau as learnings saturate      |
|                                                           |
|  Context Budget Allocation (current story avg)            |
|  [Learnings: 35%||||||||][Enforcement: 45%|||||||||]     |
|  [Skills: 15%||||][Other: 5%||]                          |
|  of the 50% context budget reserved for overlay           |
|                                                           |
+----------------------------------------------------------+
```

**Learning records per story chart:**
- Line chart, single line in `status-blue`
- X-axis: story number
- Y-axis: count of learning records injected into the overlay for that story
- Expected shape: rising curve that plateaus (logistic growth pattern)
- Chart height: 120px
- Annotation: if the curve is still rising, show "Learning overlay growing" in `status-blue`. If plateaued for 10+ stories, show "Learning overlay saturated -- system has captured available patterns" in `status-green`.

**Context budget allocation bar:**
- Horizontal stacked bar, full width, 24px height
- Four segments with distinct colors:
  - Learnings: `status-blue` -- learning records injected into the overlay
  - Enforcement: `status-green` -- hook enforcement rules, gate criteria
  - Skills: `#a78bfa` (purple-400) -- agent skill definitions, superpowers rules
  - Other: `text-tertiary` -- metadata, attribution tags, context scaffolding
- Each segment labeled with category name and percentage
- Hover tooltip per segment: "Learnings: 4,200 tokens (35% of overlay budget)"
- Below the bar: "of the 50% context budget reserved for overlay" in `text-muted`, 12px

---

### 3d. Pattern Knowledge Map

**A visual representation of discovered cross-story patterns and their effectiveness.**

```
+----------------------------------------------------------+
|  Pattern Knowledge Map                                    |
|  ---------------------------------------------------------|
|                                                           |
|  Discovered Patterns (12 active)                          |
|                                                           |
|  payments --> webhooks           confidence: 0.92         |
|  [green badge: prevented 4 fix loops]                     |
|  Evidence: 7 stories  |  Last applied: Story 48          |
|                                                           |
|  auth --> session-management     confidence: 0.85         |
|  [green badge: prevented 2 fix loops]                     |
|  Evidence: 5 stories  |  Last applied: Story 46          |
|                                                           |
|  database --> migrations         confidence: 0.71         |
|  [blue badge: measuring impact]                           |
|  Evidence: 3 stories  |  Last applied: Story 44          |
|                                                           |
|  api-routes --> validation       confidence: 0.45         |
|  [amber badge: under review -- low confidence]            |
|  Evidence: 2 stories  |  Last applied: Story 40          |
|                                                           |
+----------------------------------------------------------+
```

**Specification:**

The Pattern Knowledge Map displays discovered cross-story dependency patterns -- relationships between codebase areas that, when a story modifies area A, area B frequently also requires changes.

**Pattern card layout:**
- Each pattern is a full-width card, `bg-secondary`, 8px padding
- **Relationship line:** "areaA --> areaB" in `text-primary`, 14px, monospace font. Arrow is a literal `-->` string, not an icon.
- **Confidence score:** right-aligned on the same line, `text-secondary`, "confidence: 0.XX"
- **Status badge:**
  - Green: pattern has demonstrably prevented fix loops. Badge text: "prevented N fix loops"
  - Blue: pattern is applied but impact not yet confirmed. Badge text: "measuring impact"
  - Amber: pattern has low confidence (<0.60) or mixed results. Badge text: "under review -- low confidence"
  - Red: pattern was applied but the expected relationship did not hold (false positive). Badge text: "flagged for removal"
- **Evidence line:** "Evidence: N stories | Last applied: Story M" in `text-muted`, 12px

**Sorting:** patterns sorted by confidence score descending by default. Alternative sorts: "By impact" (prevented fix loops count), "By recency" (last applied story), "By area" (alphabetical by first area).

**Interaction:** Clicking a pattern card expands it inline (200ms) to show:
- List of specific stories that contributed evidence for this pattern
- The specific learning records that encode this pattern
- A "Remove pattern" button (requires confirmation: "This pattern will no longer be injected into overlays. Remove?") in `text-muted`, for patterns flagged as false positives

---

## Section 4: Burn Rate Prediction Panel (NEW)

**Source:** 10X-008 opportunity. Resolves the gap between current cost tracking (FR37, what has been spent) and projected cost (what will be spent by story completion).

**Location:** Bottom drawer, "Economics" tab (second tab in the bottom drawer tab bar, next to "Learning").

---

### 4a. Per-Story Burn Rate

```
+----------------------------------------------------------+
|  Economics                            [Active] [History]   |
|  ---------------------------------------------------------|
|                                                           |
|  Active Story Burn Rates                                  |
|                                                           |
|  Story 14: Implement user auth                            |
|  Phase: Development (turn 4 of ~8)                        |
|  $2.30 spent   projected $4.80   budget $5.00             |
|  [||||||||||||||||||||||||||||||||||||||||||        ] 96%  |
|  Rate: $0.58/turn  |  Status: On track (amber)            |
|  -------------------------------------------------------- |
|                                                           |
|  Story 15: Add pagination to API                          |
|  Phase: BMAD Review                                       |
|  $1.10 spent   projected $2.40   budget $5.00             |
|  [||||||||||||||||||                               ] 48%  |
|  Rate: $0.55/turn  |  Status: On track (green)            |
|  -------------------------------------------------------- |
|                                                           |
|  Story 16: Webhook integration                            |
|  Phase: Fix Loop (iteration 2)                            |
|  $4.20 spent   projected $7.10   budget $5.00             |
|  [||||||||||||||||||||||||||||||||||||||||||||||||||] 142% |
|  Rate: $0.70/turn  |  Status: PROJECTED BREACH (red)      |
|  -------------------------------------------------------- |
|                                                           |
+----------------------------------------------------------+
```

**Per-story burn rate card specification:**

Each active story gets a card in the Economics panel:

- **Story header:** story number + title, `text-primary`, 14px, semibold
- **Phase line:** current phase name, turn count if applicable (Dev/BMAD have turns), `text-secondary`, 13px
- **Cost summary line:** three values inline:
  - "spent" amount: actual cost to date, `text-primary`, monospace
  - "projected" amount: estimated total at completion, `text-secondary`, monospace. Projection formula: `spent + (rate_per_turn * estimated_remaining_turns)`. Estimated remaining turns = median turns for this phase type from historical data, minus turns completed.
  - "budget" amount: per-story budget ceiling from FR38, `text-muted`, monospace
- **Progress bar:** horizontal bar, 8px height, full card width
  - Fill color: determined by projected/budget ratio:
    - `status-green`: projected <= 60% of budget
    - `status-amber`: projected > 60% and <= 90% of budget
    - `status-red`: projected > 90% of budget
  - If projected exceeds budget, bar extends beyond 100% with the overflow section in `status-red` at 30% opacity, clipped at 150% visual width
  - Percentage label right-aligned: "96%" in `text-secondary`
- **Rate line:** "$X.XX/turn" in `text-muted` | status label
  - Status labels: "On track (green)" / "On track (amber)" / "PROJECTED BREACH (red)"
  - "PROJECTED BREACH" uses `status-red`, bold

**Projected breach alert:**

When a story's projected cost exceeds 80% of budget (configurable threshold):

1. The story's burn rate card gains a `border-l-4 border-amber-500` left accent
2. At 100%+ projected: border changes to `border-red-500`
3. An escalation banner appears in the header bar (see Section 9b)
4. If Telegram/channel notifications are configured, a notification is sent (one-time, not repeated until threshold changes)

The 80% threshold is configurable in factory settings. The UX does not expose threshold configuration -- it is set via `.qds/config/economics.yaml`.

---

### 4b. Historical Cost Trend

```
+----------------------------------------------------------+
|  Cost Per Story (historical)                              |
|  +----------------------------------------------------+  |
|  |  $8 |  *                                            |  |
|  |     |     *        *                                |  |
|  |  $4 |        *  *     *  *  *                       |  |
|  |     |                       *  *  *  $2.40 avg      |  |
|  |  $0 |_________________________________________|    |  |
|  |      S1   S5   S10  S15  S20  S25  S30             |  |
|  +----------------------------------------------------+  |
|  Average cost trending downward: system learning          |
|  reduces fix loops and rework.                            |
|                                                           |
+----------------------------------------------------------+
```

- Scatter plot with trend line
- X-axis: story number
- Y-axis: total cost per story (dollars)
- Data points: 6px circles in `status-blue`
- Trend line: 2px dashed, `text-secondary`, linear regression
- Chart height: 160px
- Annotation: if trend slope is negative, "Average cost declining -- system learning reduces rework" in `status-green`. If flat or positive, "Cost stable/rising -- investigate fix-loop patterns" in `status-amber`.
- Current trailing average shown as a label at the end of the trend line: "$2.40 avg" in `text-primary`

---

### 4c. Active vs History Toggle

The Economics panel has two sub-views, toggled by a segmented control in the panel header:

- **Active:** shows per-story burn rate cards for currently running stories (default)
- **History:** shows the historical cost trend chart + a table of completed story costs

History table columns: Story #, Title, Duration, Total Cost, Budget, Fix Loops, Cost/Turn. Sortable by any column. Default sort: most recent first.

---

## Section 5: System Health Indicator (NEW)

**Source:** ADR-023 (System Health Circuit Breaker), FAIL-020 (multi-system failure detection).

**Location:** AmbientHeader component (always visible).

---

### 5a. Top-Level Health Badge

**Amendment to AmbientHeader component (line 1190 of ux-design-specification.md).**

Add a system health badge to the AmbientHeader, positioned between the ambient color strip and the factory vitals numbers.

**Revised AmbientHeader content:** Status color tint overlay, **system health badge**, 3 vitals numbers (active/shipped/cost), **maintenance trend sparkline**, Active Experiment text, co-dev indicator.

**Revised AmbientHeader props:**

```typescript
interface AmbientHeaderProps {
  aggregateStatus: 'green' | 'amber' | 'red' | 'neutral';
  systemHealth: 'green' | 'amber' | 'red';
  systemHealthDetail?: SystemHealthDetail;
  storiesActive: number;
  storiesShipped: number;
  costToday: number;
  maintenanceTrendSparkline: number[];  // last 20 stories, fixes per story
  activeExperiment?: string;
  codevCount?: number;
}

interface SystemHealthDetail {
  status: 'green' | 'amber' | 'red';
  degradedSubsystems: string[];
  circuitBreakerActive: boolean;
  issueStartedAt?: string;  // ISO timestamp
  description?: string;
}
```

**Health badge visual specification:**

A 32px circular badge with three states:

| State | Visual | Meaning |
|-------|--------|---------|
| Green | Filled circle, `status-green`, subtle pulse every 30 seconds (2px ring, 50% opacity, 1s ease-out) | All subsystems nominal |
| Amber | Filled circle, `status-amber`, no pulse, static | 1-2 subsystems degraded; stories still running |
| Red | Filled circle, `status-red`, continuous slow pulse (3s cycle, `opacity 0.6 -> 1.0 -> 0.6`) | Circuit breaker active; new stories paused |

- `prefers-reduced-motion`: no pulse for green, no pulse for red (static filled circle with color)
- Positioned left of the factory vitals numbers, with 16px horizontal margin
- Tooltip on hover (300ms delay): green = "All systems operational", amber = "Degraded: [subsystem names]", red = "Circuit breaker active: new stories paused. [subsystem names]"

**Badge accessibility:**
- `role="status"`, `aria-live="assertive"` (health changes are critical)
- `aria-label="System health: [green/amber/red]. [description if not green]"`

---

### 5b. Health Detail Expandable

Clicking the health badge opens an expandable detail panel that drops down from the header bar (200ms slide-down, `bg-secondary`, full viewport width, 8px horizontal padding, `shadow-lg` bottom edge).

**Green state detail:**

```
+----------------------------------------------------------+
|  System Health: All Operational                    [x]    |
|  ---------------------------------------------------------|
|                                                           |
|  Subsystems                          Uptime               |
|  Overstory (agents)     [green dot]  99.98% (7d)         |
|  Pi SDK (model calls)   [green dot]  99.95% (7d)         |
|  pipeline.db             [green dot]  100.0% (7d)         |
|  attribution.db          [green dot]  100.0% (7d)         |
|  Gateway                 [green dot]  99.99% (7d)         |
|  Gate scripts            [green dot]  100.0% (7d)         |
|  Learning system         [green dot]  99.90% (7d)         |
|                                                           |
|  [7d] [30d]  No incidents in the last 7 days.             |
|                                                           |
+----------------------------------------------------------+
```

**Amber state detail:**

```
+----------------------------------------------------------+
|  System Health: Degraded                           [x]    |
|  ---------------------------------------------------------|
|                                                           |
|  [amber dot] Pi SDK (model calls)                         |
|  Issue started: 12 minutes ago                            |
|  API response times elevated (avg 2.4s, normal < 500ms)   |
|  Impact: Story processing slower. No data loss.           |
|  System response: Automatic retry with backoff active.    |
|  Developer action: None required unless this persists     |
|  beyond 30 minutes.                                       |
|  -------------------------------------------------------- |
|                                                           |
|  All other subsystems operational.                        |
|                                                           |
|  Uptime (7d):  Overstory 99.98%  |  pipeline.db 100%     |
|                attribution.db 100%  |  Gateway 99.99%     |
|                Gate scripts 100%  |  Learning 99.90%      |
|                Pi SDK 98.2% (affected)                     |
|                                                           |
+----------------------------------------------------------+
```

**Red state detail (circuit breaker active):**

```
+----------------------------------------------------------+
|  System Health: Circuit Breaker Active             [x]    |
|  ---------------------------------------------------------|
|                                                           |
|  NEW STORIES PAUSED                                       |
|  In-progress stories continue but may experience delays.  |
|                                                           |
|  Affected subsystems:                                     |
|                                                           |
|  [red dot] Pi SDK (model calls)                           |
|  Issue: API returning 503 errors. 47 of 50 calls failed.  |
|  Started: 8 minutes ago                                   |
|                                                           |
|  [red dot] Learning system                                |
|  Issue: Synthesis timed out. Learning overlay unavailable. |
|  Started: 6 minutes ago                                   |
|                                                           |
|  [amber dot] pipeline.db                                  |
|  Issue: Write latency elevated (possible disk I/O).       |
|  Started: 7 minutes ago                                   |
|                                                           |
|  System response: Circuit breaker activated after 3       |
|  subsystems reported failures within 60 seconds.          |
|  Auto-recovery will be attempted every 2 minutes.         |
|  Last attempt: 45 seconds ago (failed).                   |
|                                                           |
|  Developer action: Monitor. If this persists beyond       |
|  15 minutes, check infrastructure (disk, network, API     |
|  provider status).                                        |
|                                                           |
+----------------------------------------------------------+
```

**Detail panel specification:**
- Background: `bg-secondary`
- Close button: "x" in top-right, `text-muted`, 16px
- Clicking anywhere outside the panel also closes it
- Escape key closes it
- Subsystem list uses the same four-line structure as error states in Section 2d (What happened / Impact / System response / Developer action)
- Healthy subsystems shown in a compact single-line format with green dot and uptime percentage
- Affected subsystems shown in expanded multi-line format with full context

**Subsystem list (7 subsystems monitored):**
1. **Overstory (agents)** -- Overstory process health, agent lifecycle
2. **Pi SDK (model calls)** -- LLM API connectivity and response times
3. **pipeline.db** -- pipeline database read/write health
4. **attribution.db** -- cost attribution database health
5. **Gateway** -- HTTP gateway for dashboard SSE and API
6. **Gate scripts** -- BMAD/QA gate script execution health
7. **Learning system** -- learning record synthesis, pattern mining, overlay enrichment

**Uptime display:**
- Time range toggle: "[7d] [30d]" segmented control
- Per-subsystem uptime as percentage with 2 decimal places
- Uptime below 99.5% highlighted in `status-amber`; below 95% in `status-red`

---

### 5c. Maintenance Trend Sparkline in Header

**New element in AmbientHeader.**

A 60x20px sparkline showing the maintenance fixes per story for the last 20 stories, positioned to the right of the factory vitals numbers.

**Specification:**
- Data: array of 20 numbers (maintenance fix count per story)
- Stroke: 1.5px, colored by trend direction:
  - Declining: `status-green`
  - Flat: `text-secondary`
  - Rising: `status-amber`
- Fill: same color at 10% opacity below the line
- No axis labels (too small)
- Tooltip on hover: "Maintenance trend: X.X fixes/story avg (last 20 stories). [Declining/Flat/Rising]"
- If fewer than 5 stories completed, sparkline is not rendered (too few data points). In its place: "..." in `text-muted`.

**Accessibility:** `role="img"`, `aria-label="Maintenance trend sparkline: [declining/flat/rising], average X.X fixes per story over last 20 stories"`

---

## Section 6: Epic Progress View (NEW)

**Source:** Session 8 synthesis requirement. The developer needs epic-level visibility beyond individual stories.

**Location:** New route: `/epic/:id`. Accessible from:
1. A breadcrumb in the story card header: "Epic: Payment System Overhaul > Story 14: Webhook Integration"
2. An "Epics" link in the main navigation bar (positioned after "Performance Overview")
3. Copilot: "show me epic progress" navigates to this view

---

### 6a. Epic List View (`/epics`)

```
+----------------------------------------------------------+
|  Epics                                                    |
|  ---------------------------------------------------------|
|                                                           |
|  Payment System Overhaul                     IN PROGRESS  |
|  8 of 12 stories complete  |  $28.40 spent               |
|  [||||||||||||||||||||||||||||||||              ] 67%      |
|  12 learning records accumulated                          |
|  -------------------------------------------------------- |
|                                                           |
|  User Authentication Refactor                 COMPLETED   |
|  6 of 6 stories complete  |  $14.20 total                |
|  [||||||||||||||||||||||||||||||||||||||||||||||||] 100%   |
|  8 learning records accumulated                           |
|  -------------------------------------------------------- |
|                                                           |
+----------------------------------------------------------+
```

**Epic list card specification:**
- Full-width card, `bg-secondary`, 12px padding
- **Title:** epic name, `text-primary`, 16px, semibold
- **Status badge:** right-aligned, same line as title
  - "IN PROGRESS": `status-blue` background at 15% opacity, `status-blue` text
  - "COMPLETED": `status-green` background at 15% opacity, `status-green` text
  - "PENDING": `text-tertiary` background at 15% opacity, `text-tertiary` text
- **Progress line:** "X of Y stories complete | $Z.ZZ spent" in `text-secondary`, 13px
- **Progress bar:** 6px height, `bg-elevated` background, `status-blue` fill (or `status-green` if 100%)
- **Learning line:** "N learning records accumulated" in `text-muted`, 12px
- Click: navigates to Epic Detail View (`/epic/:id`)

---

### 6b. Epic Detail View (`/epic/:id`)

```
+----------------------------------------------------------+
|  < Back to Epics                                          |
|  Payment System Overhaul                                  |
|  8 of 12 stories complete  |  $28.40 of $60.00 budget    |
|  12 learning records accumulated, applied to 8 stories    |
|  ---------------------------------------------------------|
|                                                           |
|  Story Timeline                                           |
|  ---------------------------------------------------------|
|  S1 [=============================] Completed  $2.10      |
|  S2 [=========================]     Completed  $1.90      |
|  S3   [blocked by S1]=============] Completed  $3.40      |
|  S4 [==================]            Completed  $2.80      |
|  S5     [blocked by S2/S3]=========] Completed  $2.40     |
|  S6 [=======================]       Completed  $1.60      |
|  S7       [blocked by S5]====]       Completed  $4.20     |
|  S8 [==============================] Completed  $3.10     |
|  S9            [blocked by S7]===>   In Progress $2.30    |
|  S10                [blocked by S8]  Pending               |
|  S11                                 Pending               |
|  S12                [blocked by S9]  Pending               |
|  ---------------------------------------------------------|
|                                                           |
|  Epic Economics                                           |
|  Total spent: $28.40  |  Projected total: $42.80          |
|  Budget: $60.00  |  Projected utilization: 71%            |
|  [||||||||||||||||||||||||||||||||||           ] 71%       |
|                                                           |
|  Epic Learning                                            |
|  12 learning records accumulated from this epic.          |
|  Applied to 8 subsequent stories within this epic.        |
|  Cross-epic: 3 records also applied to other epics.       |
|                                                           |
+----------------------------------------------------------+
```

**Epic header:**
- Back navigation: "< Back to Epics" link in `status-blue`, top-left
- Epic title: `text-primary`, 20px, semibold
- Summary line: "X of Y stories complete | $Z.ZZ of $B.BB budget" in `text-secondary`, 14px
- Learning summary: "N learning records accumulated, applied to M stories" in `text-muted`, 13px

**Story Timeline (Gantt-style):**

- Horizontal bar chart, one row per story
- Each row: 32px height, 4px vertical gap between rows
- **Story label:** left column, fixed 120px width, "S1", "S2" etc. with story title on hover tooltip
- **Bar:** starts at the story's start position, extends to completion or current progress
  - Completed: `status-green` fill, full width to completion
  - In Progress: `status-blue` fill, partial width with animated right edge (subtle 2px pulse)
  - Pending: `bg-elevated` fill, dashed border
  - Fix Loop: `status-amber` fill with striped pattern (45-degree repeating gradient)
- **Dependencies:** thin lines (1px, `text-tertiary`) connecting the end of a blocking story to the start of the blocked story. Lines use a simple right-angle path (horizontal then vertical then horizontal).
  - Dependency labels: "blocked by S1" in `text-muted`, 10px, positioned at the start of the blocked story's bar
- **Cost:** right column, fixed 80px width, showing total cost (completed) or current cost (in progress) or blank (pending)
- **Status:** right column, fixed 100px width, status label in appropriate color

**Bar interaction:**
- Hover: tooltip shows full story title, duration, cost, current phase, fix-loop count
- Click: navigates to the story detail view in the main dashboard (same as clicking a story card)

**Epic Economics section:**
- Total spent / Projected total / Budget on one line, `text-secondary`, monospace
- Projected utilization percentage
- Progress bar: same color logic as per-story burn rate (green < 60%, amber 60-90%, red > 90%)
- Projection uses the per-story burn rate model (Section 4) summed across remaining stories

**Epic Learning section:**
- Count of learning records generated from stories in this epic
- Count of stories within the epic that received learning overlays from earlier stories in the same epic
- Count of records that were also applied to stories in OTHER epics (cross-pollination indicator)
- "View learning records" link navigates to the Learning Effectiveness Panel (Section 3b) pre-filtered to this epic

**Completion metric:**
- Show "X of Y stories complete" as the primary progress indicator
- Do NOT show estimated completion dates or velocity-based time projections. The system processes stories at varying rates depending on complexity, and any time estimate would be misleading.
- If the developer asks the copilot "when will this epic finish?", the copilot responds with: "At the current average rate of N stories per day, the remaining M stories would take approximately D days. However, story complexity varies significantly -- this is a rough estimate, not a commitment."

---

## Section 7: Channel Status (NEW)

**Source:** ADR-022 (Generalized Channel Abstraction). Specified now for Growth phase implementation.

**Location:** Accessible from the System Health detail panel (Section 5b) as an expandable subsection, and from factory settings.

**Condition:** This panel only renders if multi-channel abstraction (ADR-022) is adopted. If only Telegram is configured (MVP), the existing Telegram Notification Surface specification (line 1646 of ux-design-specification.md) applies unchanged.

---

### 7a. Channel List

```
+----------------------------------------------------------+
|  Notification Channels                                    |
|  ---------------------------------------------------------|
|                                                           |
|  Telegram              [green dot] Connected              |
|  Last message: 4 minutes ago  |  Errors: 0 (7d)          |
|  Developer: Steve (registered)                            |
|  -------------------------------------------------------- |
|                                                           |
|  Slack                  [gray dot] Not configured          |
|  [Configure]                                              |
|  -------------------------------------------------------- |
|                                                           |
|  Email                  [gray dot] Not configured          |
|  [Configure]                                              |
|  -------------------------------------------------------- |
|                                                           |
|  Dashboard              [green dot] Always active          |
|  -------------------------------------------------------- |
|                                                           |
+----------------------------------------------------------+
```

**Channel card specification:**
- Full-width card, `bg-secondary`, 8px padding
- **Channel name:** `text-primary`, 14px, semibold
- **Status dot:** 8px circle
  - `status-green`: connected and operational
  - `status-amber`: connected but experiencing delivery issues
  - `status-red`: disconnected or authentication expired
  - `text-tertiary`: not configured
- **Status label:** "Connected" / "Degraded" / "Disconnected" / "Not configured" in `text-secondary`
- **Metadata line (connected channels only):** "Last message: X ago | Errors: N (7d)" in `text-muted`, 12px
- **Registration line (connected channels only):** "Developer: [name] (registered)" in `text-muted`, 12px
- **Configure button (unconfigured channels):** `bg-elevated` button, `text-primary`, 13px. Clicking opens factory settings for that channel.
- Dashboard channel is always present, always green, not configurable

---

### 7b. Notification Routing Summary

```
+----------------------------------------------------------+
|  Notification Routing                                     |
|  ---------------------------------------------------------|
|                                                           |
|  Critical (circuit breaker, all-agent crash):             |
|    -> All connected channels                              |
|                                                           |
|  Warning (budget breach, stall, BMAD critical finding):   |
|    -> Telegram + Dashboard                                |
|                                                           |
|  Info (story completed, phase transition):                |
|    -> Dashboard only                                      |
|                                                           |
|  Morning summary:                                         |
|    -> Telegram (configurable time: 08:00)                 |
|                                                           |
+----------------------------------------------------------+
```

- Three routing tiers displayed as a simple list
- Each tier shows severity name, examples in parentheses in `text-muted`, and the target channels
- Target channels listed with arrow prefix: "-> channel1 + channel2"
- This is read-only in the dashboard. Routing configuration is managed in `.qds/config/notifications.yaml`.

---

## Section 8: Revised Copilot Interactions

**Amendment target: Dashboard Copilot section (line 107 of ux-design-specification.md).**

The existing copilot specification defines Ask, Investigate, and Act modes. This amendment adds new capabilities that leverage the self-learning system's data.

---

### 8a. New Copilot Capabilities

Add the following to the "Copilot use cases" table:

| Scenario | Mode | Copilot Behavior |
|----------|------|------------------|
| "Why did this story hit a fix loop?" | Investigate | Navigates to the story's expanded view, identifies the fix-loop iteration, queries learning records for gaps that could have prevented the issue. Presents: "Story 14 entered a fix loop because the webhook retry pattern was not in the learning overlay. This pattern was discovered in Story 38 but was added to the overlay AFTER Story 14 started. If Story 14 ran today, it would receive this learning automatically." |
| "What has the system learned about auth?" | Investigate | Opens the Learning Effectiveness Panel, filters learning records to area "src/auth/". Presents: "The system has 4 learning records about auth: [list]. These have been applied to 12 stories. Impact: stories touching auth have had 40% fewer fix loops since these learnings were added." |
| "Show me the maintenance trend for payments" | Investigate | Navigates to the Trends tab (Section 2c), filters the Codebase Maintenance Heatmap to "src/payments/". Presents: "Payments had 8 maintenance fixes in the first 20 stories, declining to 1 in the last 10 stories. The system has 3 active patterns for payments: [list]." |
| "What would break if I change webhook-handler.ts?" | Investigate | Queries the Pattern Knowledge Map (Section 3d) for patterns involving the file's directory. Presents: "Based on 7 stories of evidence, changes to src/payments/webhook-handler.ts are 92% correlated with needing updates to src/payments/retry-logic.ts and src/notifications/webhook-events.ts. Consider including these files in the story scope." |
| "How much will this epic cost?" | Ask | Queries the Epic Economics data (Section 6b). Presents: "Epic 'Payment System Overhaul' has spent $28.40 across 8 completed stories. Projected total for remaining 4 stories: $14.40 (based on average $3.60/story). Projected total: $42.80 against $60.00 budget (71% utilization)." |
| "Is the system healthy?" | Ask | Reads the System Health Indicator state. Presents the current status, any degraded subsystems, uptime percentages. If all green: "All 7 subsystems operational. Uptime above 99.9% across the board for the last 7 days." |
| "Why is Story 16 over budget?" | Investigate | Navigates to the Economics panel (Section 4), expands Story 16's burn rate card. Traces the cost breakdown: "Story 16 entered a fix loop at phase 3 (2 iterations, $1.40 additional cost) and BMAD review required 3 turns instead of the typical 1 ($0.90 additional). Total overhead from rework: $2.30, which pushed the story $2.10 over its $5.00 budget." |

---

### 8b. Copilot Action Registry Additions

Add the following to the `useCopilotAction` hook registry:

```typescript
// Learning Effectiveness Panel actions
'openLearningPanel': () => void;           // Opens bottom drawer, Learning tab
'filterLearningRecords': (area: string) => void;
'showPatternKnowledge': () => void;

// Economics Panel actions
'openEconomicsPanel': () => void;          // Opens bottom drawer, Economics tab
'showBurnRate': (storyId: string) => void;
'showCostTrend': () => void;

// Performance Trends actions
'openPerformanceTrends': () => void;       // Switches to Trends tab in Performance Overview
'setTimeRange': (range: '7d' | '30d' | '90d' | 'all') => void;
'filterByCodebaseArea': (path: string) => void;

// System Health actions
'openHealthDetail': () => void;            // Opens health detail panel
'showSubsystemStatus': (subsystem: string) => void;

// Epic actions
'navigateToEpic': (epicId: string) => void;
'navigateToEpics': () => void;

// Investigation helpers
'traceLearningGap': (storyId: string) => Promise<LearningGapAnalysis>;
'queryCodebaseKnowledge': (filePath: string) => Promise<PatternMatch[]>;
'projectStoryCost': (storyId: string) => Promise<CostProjection>;
```

Each action follows the existing copilot orchestration pattern: 300ms between navigation steps, visual highlighting of affected elements, abort on failure with error report in chat.

---

## Section 9: Interaction Patterns

### 9a. Autonomous Operation View (Default State)

**This is the state the developer sees 95% of the time.**

The dashboard in steady state shows:

**Header bar (AmbientHeader):**
- Ambient color: green tint (15% opacity `status-green` overlay on `bg-primary`)
- System health badge: green, subtle 30-second pulse
- Factory vitals: "4 active | 2 shipped | $6.42"
- Maintenance trend sparkline: declining, `status-green` stroke
- No Active Experiment (or if active: "Week 1/2: Overlay budget rebalance")

**Main grid:**
- Story cards in uniform green-bordered state
- All pipeline dots progressing normally
- No stall indicators, no escalation banners

**Bottom drawer:**
- Collapsed (40px tab bar visible: "Learning" | "Economics")
- Tabs show subtle badge counts: "Learning (3 new)" if learning records were added since last view

**Copilot:**
- Collapsed to thin strip (or expanded if developer prefers, persisted in localStorage)
- No pending investigation

**Visual language for steady state:** The default state communicates "everything is fine" through visual uniformity. All cards look the same. All borders are the same color. The sparkline trends downward. The health badge is green. The developer registers this in under 1 second and returns to their own work.

**Steady-state interaction budget:** The developer spends 5-10 seconds per check, 10+ times per day. Total daily dashboard interaction in steady state: under 2 minutes.

---

### 9b. Escalation View

**When the system needs developer attention, the dashboard shifts to highlight the specific issue.**

Escalations are triggered by:
1. Budget breach (projected or actual) -- from Section 4
2. System health degradation (amber or red) -- from Section 5
3. Stall requiring human input (existing spec)
4. BMAD critical finding requiring decision (existing spec)
5. All-agent crash / unrecoverable failure (existing spec)

**Escalation banner:**

A full-width banner slides down from below the AmbientHeader (200ms slide-down). Multiple banners stack vertically, newest on top.

```
+----------------------------------------------------------+
|  [amber header bar -- ambient color shifts to amber]      |
|  [system health: green]  4 active | 2 shipped | $6.42    |
+----------------------------------------------------------+
|  Story 16 projected to exceed budget.                     |
|  $4.20 spent, projected $7.10 (budget: $5.00)            |
|  [Increase Budget to $8] [Stop Story] [Investigate]       |
+----------------------------------------------------------+
|  [story card grid continues below]                        |
```

**Banner specification:**
- Background: `bg-secondary` with `border-l-4` in severity color (amber for warning, red for critical)
- Content: one-line summary of the issue, one-line context, action buttons
- **Action buttons:** presented as clear choices, not requiring investigation:
  - Primary action: `bg-elevated` button with `text-primary`, 13px, semibold. The most likely resolution.
  - Secondary actions: `bg-secondary` border buttons with `text-secondary`
  - "Investigate" always present as the last option -- navigates to the relevant detail view
- Banner is dismissable only by taking an action or clicking "Dismiss" (which acknowledges without acting). Dismissed banners do not reappear for the same escalation.
- Maximum 3 banners visible. If 4+ escalations active, banners collapse to: "4 items need your attention [View all]"
- The ambient color strip shifts to match the highest-severity active escalation (red > amber > green)

**After resolution:**
- Banner slides up (200ms)
- Ambient color strip returns to green (or to the next-highest active escalation color)
- If the action was taken from the banner (not from investigation), a brief confirmation toast appears: "Budget increased to $8 for Story 16" (auto-dismiss 5 seconds)

---

### 9c. Investigation View

**When the developer CHOOSES to look deeper, via copilot or drill-down.**

Investigation is not an escalation -- it is a voluntary deep-dive. The developer clicks "Investigate" on a banner, drills down from a story card, or asks the copilot a question.

**Investigation context panel:**

When investigating a specific story, the expanded story detail (existing Layer 4) gains additional tabs:

| Tab | Content | Source |
|-----|---------|--------|
| Agents | Existing agent panels with xterm.js | Existing spec |
| Pipeline | Existing phase detail with gate checklists | Existing spec |
| Performance | Agent performance cards for this story's agents | Section 2 |
| Cost | Burn rate card for this story, turn-by-turn cost breakdown | Section 4 |
| Learning | Learning records applied to this story, learning records generated from this story | Section 3b |
| Timeline | Chronological event log: phase transitions, hook results, fix-loop entries, cost events | New |

**Timeline tab specification:**
- Vertical event log, newest at top
- Each event: timestamp (left, `text-muted`, 70px), event icon (16px), event description (`text-secondary`, 13px)
- Event types and icons:
  - Phase transition: blue right-arrow
  - Hook pass: green checkmark
  - Hook fail: red X
  - Fix-loop entry: amber circular arrow
  - Cost event: dollar sign in `text-muted`
  - Learning record applied: blue lightbulb
  - Stall detected: amber warning triangle
  - Agent spawn/respawn: neutral person icon
- Events are clickable where applicable: clicking a hook result expands to show the hook output; clicking a learning record opens the record detail in the Learning Effectiveness Panel

---

## Section 10: Dashboard Layout Amendments

### Revised Layout Structure

**Amendment to existing layout specification.**

The existing dashboard layout is: header bar + main grid + right sidebar copilot. This amendment adds the bottom drawer and new navigation routes.

**Revised viewport composition:**

```
+----------------------------------------------------------+
|  AmbientHeader (48px, fixed)                              |
|  [health badge] [vitals] [maintenance sparkline] [exp]    |
+----------------------------------------------------------+
|  [Escalation banners, if any, variable height]            |
+----------------------------------------------------------+
|                                          |                |
|  Main Content Area                       |  Copilot       |
|  (scrollable)                            |  (300px,       |
|                                          |   resizable,   |
|  Story card grid (existing)              |   collapsible)  |
|  OR Performance Overview (tab)           |                |
|  OR Epic View (route)                    |                |
|                                          |                |
|                                          |                |
+----------------------------------------------------------+
|  Bottom Drawer Tab Bar (40px, fixed)                      |
|  [Learning] [Economics]                                   |
+----------------------------------------------------------+
|  Bottom Drawer Content (0-600px, expandable)              |
|  Learning Effectiveness / Economics panels                |
+----------------------------------------------------------+
```

**Main navigation:**

The existing spec references "main navigation (alongside Factory Overview, Agent Windows, Story Pipeline)." Amend to add:

| Navigation Item | Route | Content |
|----------------|-------|---------|
| Factory Overview | `/` (default) | Story card grid, factory vitals, existing dashboard |
| Performance | `/performance` | Performance Overview with Overview and Trends tabs (revised, Section 2) |
| Epics | `/epics` | Epic list view (Section 6a) |
| Epic Detail | `/epic/:id` | Epic detail view (Section 6b) |

Navigation bar is a horizontal tab bar below the AmbientHeader, 40px height, `bg-secondary`. Active tab: `border-b-2 border-blue-500`, `text-primary`. Inactive: `text-secondary`. Navigation does not change the bottom drawer state or copilot state.

**Bottom drawer behavior:**
- The drawer tab bar is always visible at the bottom of the viewport (fixed position), 40px height
- Tabs: "Learning" and "Economics", styled same as main navigation tabs
- Clicking a tab opens the drawer to its persisted height (default 400px). Clicking the active tab again collapses it.
- Drawer content scrolls independently from main content
- Drawer is available on ALL routes (Factory Overview, Performance, Epics). Its content is global, not page-specific.
- When the drawer is open, the main content area's available height is reduced by the drawer height. The main content area does not overlap with the drawer -- they are stacked vertically.
- Keyboard: Escape closes the drawer. No keyboard shortcut to open (accessed via click or copilot).

**AmbientHeader additions (from Section 5):**
- System health badge: between ambient color strip and factory vitals
- Maintenance trend sparkline: after factory vitals numbers, before Active Experiment text

**Revised AmbientHeader visual layout (left to right):**

```
[ambient color tint across full width]
[health badge 32px] [16px gap] [4 active | 2 shipped | $6.42] [16px gap] [sparkline 60x20px] [16px gap] [Active Experiment text] [flex spacer] [co-dev indicator]
```

---

### Component Inventory Additions

Add the following components to the Component Strategy section of the UX spec:

#### PerformanceAlert

**Purpose:** Error/warning/info banner for performance system states.
**Content:** Severity icon, title, structured information sections, optional progress bar, optional action link.
**States:** Warning (amber border), Info (blue border), Error (red border).
**Props:** See Section 2d type definition.
**Accessibility:** `role="alert"` for error severity, `role="status"` for info/warning. `aria-live="assertive"` for error, `aria-live="polite"` for others.

#### LearningEffectivenessPanel

**Purpose:** Bottom drawer content showing maintenance burden trend, learning records feed, overlay enrichment depth, pattern knowledge map.
**Content:** Four sub-panels arranged vertically, scrollable.
**States:** Default (data loaded), empty (fewer than 3 stories), loading (initial data fetch).
**Props:** `timeRange: '7d' | '30d' | '90d' | 'all'`, `areaFilter?: string`, `typeFilter?: string`.
**Accessibility:** `role="region"`, `aria-label="Learning effectiveness analysis"`. Charts have `role="img"` with descriptive `aria-label`.

#### BurnRatePanel

**Purpose:** Bottom drawer content showing per-story burn rates and historical cost trend.
**Content:** Active story burn rate cards and historical cost chart.
**States:** Active view (running stories), History view (completed stories).
**Props:** `view: 'active' | 'history'`, `stories: StoryBurnRate[]`.
**Accessibility:** `role="region"`, `aria-label="Cost and budget analysis"`. Progress bars have `aria-valuenow`, `aria-valuemin`, `aria-valuemax`.

#### SystemHealthBadge

**Purpose:** Circular badge in AmbientHeader showing overall system health.
**Content:** Colored circle with optional pulse animation.
**States:** Green (nominal), amber (degraded), red (circuit breaker active).
**Props:** `status: 'green' | 'amber' | 'red'`, `detail?: SystemHealthDetail`.
**Accessibility:** `role="status"`, `aria-live="assertive"`, `aria-label` describing current health state.

#### SystemHealthDetail

**Purpose:** Expandable panel from health badge showing subsystem statuses.
**Content:** Subsystem list with status dots, uptime percentages, issue descriptions.
**States:** Green (all operational), amber (partial degradation), red (circuit breaker).
**Props:** `subsystems: SubsystemStatus[]`, `uptimeRange: '7d' | '30d'`.
**Accessibility:** `role="dialog"`, `aria-label="System health details"`. Each subsystem has `role="listitem"` with status description.

#### EpicCard

**Purpose:** Epic summary card in the Epic list view.
**Content:** Epic title, story progress, cost, learning records count.
**States:** In Progress (`status-blue` accent), Completed (`status-green` accent), Pending (`text-tertiary` accent).
**Props:** `epic: Epic`, `onClick: (epicId: string) => void`.
**Accessibility:** `role="article"`, `aria-label="Epic: [title], [X] of [Y] stories complete"`.

#### EpicTimeline

**Purpose:** Gantt-style horizontal bar chart showing story timeline within an epic.
**Content:** Story bars, dependency lines, status colors, cost labels.
**States:** Default (data loaded), empty (no stories).
**Props:** `stories: EpicStory[]`, `dependencies: Dependency[]`.
**Accessibility:** `role="img"`, `aria-label="Epic story timeline"`. Individual stories are not focusable within the chart (use the story list below for keyboard access).

#### MaintenanceSparkline

**Purpose:** Small sparkline in AmbientHeader showing maintenance trend.
**Content:** 60x20px line chart of last 20 stories' maintenance fix counts.
**States:** Declining (green), flat (gray), rising (amber), insufficient data (hidden).
**Props:** `data: number[]`, `trend: 'declining' | 'flat' | 'rising'`.
**Accessibility:** `role="img"`, `aria-label` describing trend direction and average.

#### BottomDrawer

**Purpose:** Expandable drawer at the bottom of the viewport containing Learning and Economics panels.
**Content:** Tab bar + panel content area.
**States:** Collapsed (tab bar only, 40px), expanded (280-600px).
**Props:** `activeTab: 'learning' | 'economics' | null`, `height: number`.
**Accessibility:** `role="complementary"`, `aria-label="Analysis panels"`. Tab bar uses `role="tablist"` with `role="tab"` per tab and `aria-selected`.

#### EscalationBanner

**Purpose:** Full-width banner showing an issue requiring developer attention.
**Content:** Issue summary, context, action buttons.
**States:** Warning (amber), critical (red), acknowledged (dimmed).
**Props:** `severity: 'warning' | 'critical'`, `title: string`, `context: string`, `actions: Action[]`.
**Accessibility:** `role="alert"`, `aria-live="assertive"` for critical, `aria-live="polite"` for warning. Action buttons are keyboard-focusable with clear labels.

---

### Amended Keyboard Shortcuts

Add to the existing keyboard shortcut table:

| Key | Action |
|-----|--------|
| `Escape` | (amended) Collapse expanded story / close copilot / close bottom drawer / close health detail -- in that priority order |
| `L` | Toggle bottom drawer Learning tab (new) |
| `E` | Toggle bottom drawer Economics tab (new) |

Growth keyboard additions (not implemented in MVP):
- `H` -- toggle system health detail panel
- `P` -- switch to Performance view
- `G` -- switch to Epics view

---

## Cross-Reference: Finding Resolution Traceability

| Finding ID | Section | Resolution |
|------------|---------|------------|
| COMP-020 | 2a | Empty state guidance with progressive ghost cards and progress indicator |
| COMP-021 | 2b | Tier transition animations, transition history, hysteresis indicator |
| COMP-022 | 2c | Historical performance trend view with sparklines, fix-loop rate, maintenance rate, codebase heatmap |
| COMP-023 | 2d | Three specific error states with four-line information structure |
| COMP-024 | 2e | Non-blocking recalculation with stale data indicators and inline spinners |
| 10X-008 | 4 | Burn rate prediction panel with per-story projections and historical cost trend |
| FAIL-020 / ADR-023 | 5 | System health indicator with green/amber/red states, subsystem detail, circuit breaker visualization |
| ARCH10X-002 | 7 | Channel status panel for multi-channel abstraction (Growth) |
| ARCH10X-006 | 5c, 2c | Sparkline algorithms applied to maintenance trend and performance trends |
| ECON-001 | 2 (removal) | Credit balance and per-agent budget bar removed from Performance Card |
| ECON-002 | 4 | Per-story burn rate replaces per-agent budget as the economic visualization |
| PERV-009 | 2b | Hysteresis indicator visualized in Performance Card |
| Session 8 synthesis | 1, 3, 6, 8, 9, 10 | Dashboard philosophy revision, Learning Effectiveness Panel, Epic Progress View, copilot learning capabilities, interaction patterns, layout amendments |

---

*Generated as Deliverable 3 of Session 8 super-system synthesis. Amends ux-design-specification.md. All panel specifications are concrete and implementable -- no "consider adding" recommendations.*
