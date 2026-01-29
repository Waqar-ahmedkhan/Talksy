# Flutter Video Call Issues (Backend Mismatch Summary)

This document lists the concrete mismatch risks found in `video_call_service (1).dart` and `video_calling_screen.dart`.

## Step-by-step Flutter implementation (matches backend)
Follow this exact order to avoid call setup and video issues.

### 1) Normalize and store user IDs
- Backend accepts:
  - MongoDB ObjectId (24 hex), or
  - E.164 phone with `+` (example: `+923001234567`)
- If you have `03xxxxxxxxx`, normalize before emitting:
  - `03xxxxxxxxx` → `+92xxxxxxxxxx`

### 2) Connect socket and join
```
videoSocket = IO.io(
  baseUrl,
  IO.OptionBuilder()
      .setPath('/video-socket')
      .setTransports(['websocket'])
      .enableForceNewConnection()
      .build(),
);

videoSocket.onConnect((_) {
  videoSocket.emit('join', userId);
});
```

### 3) Call (caller flow)
1. Create local media:
   - `getUserMedia({ video: true, audio: true })`
2. Create `RTCPeerConnection` with STUN/TURN:
   - Include TURN for mobile networks.
3. Add local tracks **before** creating offer.
4. `createOffer` → `setLocalDescription`.
5. Emit `call_user`:
```
videoSocket.emit('call_user', {
  'callerId': callerMongoIdOrE164,
  'calleeId': calleeMongoIdOrE164,
  'offer': { 'type': offer.type, 'sdp': offer.sdp },
  'callType': 'video',
});
```

### 4) Incoming call (callee flow)
1. On `incoming_call`, **store IDs**:
   - `callerUserId = data['callerUserId']`
   - `calleeUserId = data['calleeUserId']` (or your own ID)
2. Create local media (if not already created).
3. `setRemoteDescription(offer)`.
4. `createAnswer` → `setLocalDescription`.
5. Emit `accept_call`:
```
videoSocket.emit('accept_call', {
  'callerId': callerUserId,
  'calleeId': myUserId,
  'answer': { 'type': answer.type, 'sdp': answer.sdp },
});
```

### 5) ICE candidates (both sides)
1. On local ICE:
```
peerConnection.onIceCandidate = (candidate) {
  if (candidate == null) return;
  videoSocket.emit('ice_candidate', {
    'candidate': {
      'candidate': candidate.candidate,
      'sdpMid': candidate.sdpMid,
      'sdpMLineIndex': candidate.sdpMLineIndex,
    },
    'toUserId': peerUserId,
  });
};
```
2. On remote ICE:
```
videoSocket.on('ice_candidate', (data) async {
  final c = data['candidate'];
  await peerConnection.addCandidate(
    RTCIceCandidate(c['candidate'], c['sdpMid'], c['sdpMLineIndex']),
  );
});
```

### 6) Call accepted (caller)
On `call_accepted`:
```
await peerConnection.setRemoteDescription(
  RTCSessionDescription(answer['sdp'], answer['type']),
);
```

### 7) Remote video rendering
- Use `onTrack` and set `remoteStream`:
```
peerConnection.onTrack = (event) {
  if (event.streams.isNotEmpty) {
    remoteStream.value = event.streams[0];
  }
};
```

### 8) End call
Always send resolved IDs:
```
videoSocket.emit('end_call', {
  'userId': myUserId,
  'peerId': peerUserId,
});
```

## TURN for mobile (recommended)
STUN-only often fails on 4G/5G networks.
Add TURN credentials:
```
const iceServers = [
  { 'urls': 'stun:stun.l.google.com:19302' },
  { 'urls': 'turn:your.turn.server:3478', 'username': 'user', 'credential': 'pass' },
];
```

## Common failure symptoms
- **ICE stuck checking:** TURN missing or blocked network.
- **Remote tracks = 0:** Offer/answer order wrong or tracks not added.
- **ICE candidates = 0:** Wrong IDs in signaling or socket not connected.
- **Connected but black video:** Sender camera permissions or tracks muted.

## Must-match backend payloads
- `join`: `userId` (Mongo ID or E.164)
- `call_user`: `{ callerId, calleeId, offer, callType }`
- `incoming_call`: `{ callerUserId, calleeUserId, offer, callType }`
- `accept_call`: `{ callerId, calleeId, answer }`
- `ice_candidate`: `{ candidate, toUserId }`
- `end_call`: `{ userId, peerId }`

## Critical issues
1) **Wrong IDs sent to backend**
   - Backend only accepts Mongo IDs or E.164 numbers (`+923...`).
   - Flutter often uses raw phone values like `03...`.
   - This causes:
     - `call_user` rejected
     - `accept_call` rejected
     - ICE candidates dropped

2) **Ignoring `callerUserId` from server**
   - Backend sends both:
     - `callerId` (may be phone or display)
     - `callerUserId` (MongoDB ID)
   - Flutter uses `callerId` for `currentCallerUserId`.
   - ICE and accept/reject then target wrong ID.

3) **ICE candidates sent to wrong peer**
   - `onIceCandidate` uses `currentCalleeUserId/currentCallerUserId`.
   - These can be phone or not resolved.
   - Server drops ICE (`VIDEO_ICE_DROP`).

## Where this happens in Flutter
- `video_call_service (1).dart`
  - `incoming_call` handler
    - Uses `callerId` instead of `callerUserId`.
  - `initiateVideoCall()`
    - Sends `calleeId` and `callerId` without ensuring Mongo IDs.
  - `acceptCall()` / `rejectCall()`
    - Depends on caller/callee IDs passed from UI.
  - `onIceCandidate`
    - Uses `currentCallerUserId/currentCalleeUserId` that may be phone.
- `video_calling_screen.dart`
  - `_endCall()` uses `contactPhone` which can be invalid ID format.

## Required alignment with backend
- Always store and send **resolved MongoDB IDs** (or E.164 `+92...`).
- Use `callerUserId` and `calleeUserId` from server payloads for signaling.
- Keep `callerId` only for display.

## Quick fixes to implement
1) In `incoming_call`, store:
   - `currentCallerUserId = data['callerUserId']`
   - `currentCalleeUserId = data['calleeUserId']` (or self)
2) In `accept_call` payload, send `callerId = callerUserId`.
3) In `call_user` payload, send MongoDB IDs only.
4) Normalize phone numbers to E.164 before emitting to server.
5) For `end_call`, always send MongoDB IDs.

## Checklist for developer
- [ ] Socket path `/video-socket`
- [ ] `join` uses Mongo ID or E.164
- [ ] `call_user` uses Mongo ID or E.164
- [ ] `accept_call` uses Mongo ID or E.164
- [ ] `ice_candidate.toUserId` uses Mongo ID or E.164
- [ ] HTTPS for mobile testing
- [ ] TURN configured for mobile networks
