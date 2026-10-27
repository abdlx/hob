# Interface organization plan

Status: proposed design and implementation sequence. The broader redesign has not been implemented.

## Outcome

Make everyday tasks easy to locate and complete without searching down long pages. Keep the current warm visual language, with stronger hierarchy, more usable space, and consistent interactions across skills, memories, models, providers, apps, automation, and settings.

## What needs to change

The current interface has several concrete sources of clutter:

- `ChatScreen.tsx` keeps the bot directory and activity inspector around management pages, reducing their usable width.
- `WorkspaceViews.tsx` gives management screens a shared page scroller and a 960px content limit. `HermesSettings.tsx` then adds another category rail inside that constrained space.
- Models, credentials, custom endpoints, and provider accounts stack in the same settings section.
- Skills, skill proposals, memory files, and learning policy appear in overlapping Workshop and Settings surfaces.
- Toolsets, memory providers, channels, and models often start with a selector, concealing the available items and their status.
- Editing a memory expands a form below the collection. Skill review requires copying a proposal ID from native output into a separate input.
- Settings search filters category descriptions rather than taking the user directly to an individual control.

## 1. Give management screens their own workspace

Use a compact global navigation rail. Chat keeps its bot directory and conversation inspector. Knowledge, Apps, Automations, Files, Activity, and Settings use the available workspace width.

Every management screen follows the same structure:

1. Persistent header: breadcrumb, page title, visible bot scope, search, primary action.
2. Short local navigation: only the tabs relevant to that area.
3. Searchable collection or focused settings content.
4. Item detail when selected, with its own clear heading and actions.

Keep the selected bot explicit. Device preferences, bot settings, and deployment settings must be labeled with their actual scope. A searchable bot picker preserves the current choice across areas; changing scope must handle unsaved edits.

On phones, the collection opens into a full-screen detail view with a Back action. Preserve the query, filters, and collection position when returning.

## 2. Give each feature one home

| Main destination | Contents |
| --- | --- |
| Chat | Bot directory, conversations, group chats |
| Knowledge | Skills, Memories, Reviews |
| Automations | Goals, Heartbeats, Schedules; run history inside each item |
| Apps | Installed apps, Discover, MCP connections, Messaging channels |
| Activity | Runs, outstanding approvals, failures, bot exchanges |
| Files | Artifacts, media, workspace files |
| Settings | General, Bot identity, Models, Providers, Permissions, System |

Settings navigation groups its pages under General, Selected bot, and System. Link to Knowledge, Apps, and Automations when relevant instead of maintaining duplicate editors. Existing navigation URLs should redirect to their new homes.

## 3. Design each collection for its content

| Surface | Collection | Clicking an item |
| --- | --- | --- |
| Skills | Compact cards with name, short purpose, enabled state, and provenance when available. Search and Enabled / Disabled filters. Keep Reviews in a separate tab with a count. | Skill detail/editor with Overview, Instructions, and supporting files. Review a proposal from its card, with the exact revision and diff. |
| Memories | Searchable library grouped by source. Show a title and short excerpt; distinguish USER.md, MEMORY.md, and any supported external records. | Reading/editing pane. Longer documents get a dedicated editor with Find and a persistent save bar. |
| Models | Current model summary, then a searchable catalog with provider and supported capability filters. Show only metadata supplied by the native catalog. | Model detail with available metadata, connected provider, and a clear Use model action. |
| Providers | Provider tiles showing Connected, Needs setup, or Unavailable. Separate connected providers from the available catalog. | A focused connection flow for API key, supported sign-in, or custom endpoint. Saved credentials remain masked. |
| Plugins/apps | Retain the app grid. Separate Installed and Discover. Keep status and one-line purpose visible. | Existing detail modal, refined into Overview, Capabilities, Configuration, and Activity where supported. |
| MCP and channels | Connection cards with service identity, status, and connected bot. | Focused configuration and connection diagnostics. |
| Goals, heartbeats, schedules | Compact cards grouped by Running, Scheduled, Paused, or Needs attention. | One item's configuration and run history. Schedule choices use readable presets, with the native expression in Advanced. |
| Settings | Small, named groups of related controls. Place common controls first; show relevant advanced fields within their owning section. | Toggles for booleans, segmented choices for a few options, search for large catalogs, focused forms for complex changes. |

External memory records and structured proposal details depend on the native interfaces available. Preserve truthful supported states; any missing API needed for a richer view must be identified before promising that interaction.

## 4. Make finding and changing things consistent

- Global search / command palette searches destinations and indexed setting labels. Results show the exact destination and bot scope; opening one reveals and focuses the relevant control. Never index stored secrets.
- Each collection has persistent search, relevant filters, item counts, and pagination or bounded loading. Large catalogs must not become one endless stack.
- Persist the selected tab and encode shareable navigation, filters, and item selection in the URL where appropriate. Browser Back restores context.
- Keep one clear primary action per view. Place secondary actions in a consistent menu; show actions such as Enable only when their meaning and target are clear.
- Use short status badges with text, predictable card sizes, readable typography, and consistent spacing. Surface detailed help beside the relevant field or inside its detail view.
- Show a persistent save/cancel bar when a form has edits, plus pending and failure states. Navigation must not discard a draft silently.
- Show connection, configuration, and readiness as distinct states where the backend distinguishes them.
- Preserve capability consent, revision checks, approval decisions, and per-bot isolation through the new layouts.

## 5. Implement in this order

1. **Workspace foundation:** management layout, visible scope header, grouped navigation, direct routes, search behavior, and shared collection/detail components. Establish desktop and phone examples before migrating every screen.
2. **Models and providers:** split the stacked setup page into a model browser and provider connection flows. This removes a major source of form clutter early.
3. **Knowledge:** separate Skills, Memories, and Reviews; move edits into focused views; remove duplicate entry points and the proposal-ID workflow where native structured data permits.
4. **Apps and connections:** carry the plugin grid pattern through MCP and channels; standardize item details and status displays.
5. **Automation and remaining settings:** separate heartbeat, goal, and schedule configuration; group settings and add direct field search.
6. **Polish and workflow verification:** check density, keyboard navigation, mobile behavior, loading/error states, navigation restoration, and existing native operations.

Complete each area as a usable flow before moving to the next. Avoid leaving a collection with the old editor embedded below it.

## Acceptance targets

- At 1366×768, a section's search, key filters, scope, and primary action are visible without scrolling.
- Common tasks take at most two selections from their section home. Test changing a model, connecting a provider, editing a memory, enabling a skill, and pausing a heartbeat.
- Search finds an individual setting and opens its owner directly.
- Large collections remain usable with 100+ items; finding one item does not require scrolling through all of them.
- Closing detail restores the collection's query, filters, and position.
- At 390×844, there is no horizontal page overflow and save actions remain reachable.
- Keyboard users can search, select, edit, save, cancel, and return; dialogs restore focus and status is understandable without color.
- Existing install, authentication, credential, native approval, memory, scheduling, and model-selection behavior remains functional and profile-scoped.

These are implementation targets to verify with workflows and screenshots, not claims about the current interface.
