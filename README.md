# AnonChat 🕵️‍♂️💬

AnonChat is an **anonymous real-time chat and polling app** built with **Next.js 15 (App Router)**, **MongoDB**, **Tailwind CSS**, and **Server-Sent Events (SSE)**.  
It allows anyone to create or join chat rooms, send messages, run polls, and interact **without needing an account**.

---

## ✨ Features

- 🔒 **Anonymous Rooms** – anyone can create or join without login
- 👑 **Room Ownership** – first user becomes the room owner
- 💬 **Real-time Chat** – messages instantly broadcast to everyone
- 📊 **Polls & Voting** – room owners can create polls, users can vote
- 👥 **User Presence** – see who’s connected in real-time
- ⏳ **Auto Cleanup** – rooms are deleted if the owner leaves or no users remain
- 📡 **WebRTC Signaling** – basic signaling API for peer-to-peer features
- ⚡ **Server-Sent Events (SSE)** – lightweight real-time updates
- 🎨 **Modern UI** – styled with Tailwind + shadcn/ui components

---

## 🚀 Tech Stack

- [Next.js 15 (App Router)](https://nextjs.org/)
- [React 19](https://react.dev/)
- [MongoDB](https://www.mongodb.com/)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) for real-time updates

---

## 📂 Project Structure

```

.
├── lib/              # Database & utility functions
├── src/app/          # Next.js app (API + pages)
│   ├── api/room/     # API endpoints (rooms, messages, polls, signals, state, SSE)
│   ├── page.tsx      # Homepage
│   └── room/\[id]/    # Room page
├── src/components/   # Reusable UI components
├── public/           # Static assets
└── example.env       # Example environment variables

````

---

## ⚙️ Setup & Installation

### 1. Clone the repo
```bash
git clone https://github.com/MasFana/AnonChat.git
cd AnonChat
````

### 2. Install dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
# or
bun install
```

### 3. Configure environment variables

Copy `.env.example` → `.env.local` and update your MongoDB URI:

```
MONGODB_URI=mongodb://127.0.0.1:27017/chat_app
```

### 4. Run development server

```bash
npm run dev
```

Visit 👉 [http://localhost:3000](http://localhost:3000)

---

## 🛠 API Endpoints

### Rooms

* `POST /api/room` → create a new room (first user = owner)
* `GET /api/room` → list active rooms

### Join & Messages

* `POST /api/room/[id]/join` → join room
* `POST /api/room/[id]/message` → send message

### Polls

* `POST /api/room/[id]/poll` → create poll (owner only)
* `GET /api/room/[id]/poll` → list polls
* `POST /api/room/[id]/poll/[pollId]` → vote
* `PATCH /api/room/[id]/poll/[pollId]` → update (owner only)
* `DELETE /api/room/[id]/poll/[pollId]` → delete (owner only)

### Real-time & State

* `GET /api/room/[id]/sse` → subscribe to live updates
* `GET /api/room/[id]/state` → fetch current state
* `POST /api/room/[id]/signal` / `GET /api/room/[id]/signal` → signaling for WebRTC

---

## 🧹 Room Lifecycle

* A room is **created** when the first user joins.
* If the **owner disconnects**, the room is deleted after a short grace period.
* If **no users remain**, the room is immediately deleted.
* All messages, polls, and votes tied to a deleted room are also cleaned up.

---

## 📦 Deployment

The app is fully compatible with **Vercel** or any Node.js hosting provider.
For production, make sure you set:

```
MONGODB_URI=your-production-mongodb-uri
OWNER_AWAY_GRACE_MS=5000   # (optional) grace period before deleting room when owner leaves
```

---

## 📸 Screenshots (optional)

### Dashboard
![AnonChat Dashboard showing room creation and list of active rooms](./homepage.png)

### Room (Owner)
![Room view as owner with poll creation controls and participant list](./owner.png)

### Room (Client)
![Participant view with live messages, active poll, and presence indicators](./client.png)

---

## 🤝 Contributing

PRs are welcome! Feel free to fork and improve this project.

---
