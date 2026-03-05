# HushLine

Real-time chat with persistent messages and user accounts. Built with Node.js, Express, Socket.io, and SQLite.

## Features
- **Accounts** — register/login with username + password, JWT auth, stays logged in
- **Persistent messages** — all messages saved to SQLite, fully loaded when you rejoin
- **Community rooms** — built-in public rooms (general, music, tech, creative, random)
- **User rooms** — anyone can create their own room with a description
- **Online presence** — live list of who's in the room
- **Typing indicators + date separators**

## Deploy to Railway

### 1. Push to GitHub
Push this folder to a GitHub repo.

### 2. Deploy
Go to railway.app → New Project → Deploy from GitHub → select your repo.

### 3. Add a Persistent Volume (IMPORTANT for saving messages)
Without this, the database resets on every redeploy.
- In your Railway project → your service → Volumes tab
- Add a volume mounted at: /app/data
- Add environment variable: DATA_DIR=/app/data

### 4. Set JWT Secret
In your service Variables, add:
  JWT_SECRET=some-long-random-secret-string-here

### 5. Done!
Your app will be live at the generated .up.railway.app URL.

## Run Locally

npm install
npm start

Then open http://localhost:3000
Data is saved to ./data/hushline.db
