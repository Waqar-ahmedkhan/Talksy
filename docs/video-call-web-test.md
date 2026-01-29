# Web Video Call Test Harness (Talksy)

This document describes the working web test page and how to verify video streaming end-to-end.

## What is working
- A web test page that uses the existing Socket.IO signaling and WebRTC flow.
- Minimal UI for quick testing with diagnostics.
- Optional test mode that avoids MongoDB user IDs.

## Files
- `src/public/video-call.html`
- `src/public/video-call.css`
- `src/public/video-call.js`
- `src/sockets/videoCallingSockets.js`

## Prerequisites
- Node server running on `http://localhost:5000`
- MongoDB running OR test mode enabled (see below)
- Two browser windows (or incognito) for two users
- HTTPS required if testing from a mobile device (camera/mic will be blocked on HTTP)

## Test Mode (no DB IDs required)
Add to `.env`:
```
VIDEO_TEST_MODE=true
VIDEO_TEST_IDS=test-user-1,test-user-2
```

Restart server.

## Step-by-step test
1) Start server:
   ```
   npm start
   ```
2) Open the test page in two browsers:
   - `http://localhost:5000/video-call.html`
3) In window A, click `Use test-user-1` and Join.
4) In window B, click `Use test-user-2` and Join.
5) Click `Direct Test Call (1 ⇄ 2)` in either window.
6) Accept in the other window.
7) Confirm:
   - Local preview shows camera.
   - Remote video tile shows the other user.
   - Diagnostics show ICE connected and candidate counts > 0.

## Diagnostics panel
The call screen shows:
- `Signaling` state
- `ICE` state
- `Connection` state
- `Gathering` state
- `ICE Candidates` count
- `Remote Tracks` count

## Common fixes if video does not appear
- **ICE stays "checking" or "failed":** You need a TURN server. Mobile networks often require TURN even if STUN works on desktop.
- **Candidates = 0:** ICE is not being sent/received. Check socket events and IDs.
- **Remote tracks = 0:** Offer/answer or track setup problem on sender.
- **Works on desktop but fails on mobile:** Use HTTPS and TURN.

## Signaling events used
- `join`
- `request_online_users` → `online_users`
- `call_user` → `incoming_call`
- `accept_call` → `call_accepted`
- `ice_candidate`
- `end_call` → `call_ended`
