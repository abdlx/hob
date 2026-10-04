# OpenMuse Web UI & API Integration Guide

This UI is built with **React 19**, **Vite 8**, **Tailwind CSS v4**, **TypeScript**, and **Lucide Icons**. It reproduces the OpenMuse `/chat` interface with a dark theme and clean API abstraction layer.

---

## 1. Routing & Entry Point
- **Route**: `/chat` is the primary chat screen.
- Root path `/` automatically redirects to `/chat`.
- All routes are wired in [`src/App.tsx`](file:///D:/code/github-projects/Mused%20-%20OpenMuse/web/src/App.tsx).

---

## 2. Architecture & API Abstraction

All data and network operations are decoupled through the Service Layer:

```
[UI Components]
  ├── LeftSidebar (Navigation icons)
  ├── ChatHeader (Chats drawer toggle, invite, panel collapse)
  ├── ChatMessageList & ChatMessageItem (Markdown, assistant cards, user bronze pills)
  ├── ChatInput (Floating pill, multiline auto-expand, slash context menu)
  ├── RightPanel (Dogesh profile, 4-tab switcher, Today's timeline, Security, Stats, Skills)
  └── ChatsDrawer (Session switcher & new conversation)
          │
          ▼
[State Layer: ChatContext] (`src/context/ChatContext.tsx`)
          │
          ▼
[Service Layer: ChatApiClient] (`src/services/api.ts`)
          │
          ├── [Mock Mode: Initial UI state matching reference screenshot]
          └── [Real Mode: REST / SSE streaming endpoints]
```

---

## 3. Connecting to the Live Backend API

### Environment Variables
Create a `.env` (or `.env.local`) file inside `web/`:

```env
# Point to your Hermes / OpenClaw / Muse Gateway server
VITE_API_BASE_URL=http://localhost:8000

# Set to 'false' to switch from mock fixtures to live HTTP/SSE
VITE_USE_MOCK_API=false
```

### API Endpoints Expected by [`chatApi`](file:///D:/code/github-projects/Mused%20-%20OpenMuse/web/src/services/api.ts):

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/sessions` | Fetch list of chat sessions |
| `POST` | `/api/sessions` | Create a new session `{ title, agentId }` |
| `GET` | `/api/sessions/:id/messages` | Get message history for a session |
| `POST` | `/api/sessions/:id/turns` | Send user message. Supports SSE streaming response (`text/event-stream` or chunked transfer) |
| `GET` | `/api/agent` | Get current agent profile (Dogesh, status, model) |
| `PATCH` | `/api/agent` | Update agent settings or avatar |
| `GET` | `/api/tasks` | Fetch activity timeline cards ("Today", "Yesterday") |
| `POST` | `/api/tasks` | Add or update a background task |
| `GET` | `/api/security/approvals` | List pending/past tool execution approvals |
| `POST` | `/api/security/approvals/:id` | Resolve approval `{ decision: 'approved' \| 'rejected' }` |
| `GET` | `/api/stats` | Gateway context window %, memory, turn latency |

---

## 4. Running the Web App

In `web/`:

```bash
# Start development server
npm run dev

# Run type check and production build
npm run build

# Preview production build locally
npm run preview
```
