# Flutter Video Call Integration Guide

This guide explains how to update your Flutter application to correctly receive the TURN server configuration from your optimized backend and establish reliable mobile-to-mobile video calls.

## 1. Dependencies

Ensure you have the following packages in your `pubspec.yaml`:

```yaml
dependencies:
  flutter_webrtc: ^0.10.8 # Check for latest version
  socket_io_client: ^2.0.0
```

## 2. Managing Socket Connection & ICE Config

You need to listen for the `ice_config` event _before_ creating your peer connection.

### `VideoCallService.dart` (Example)

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:flutter_webrtc/flutter_webrtc.dart';

class VideoCallService {
  late IO.Socket socket;

  // Default fallback (STUN only)
  Map<String, dynamic> _iceConfiguration = {
    'iceServers': [
      {'urls': 'stun:stun.l.google.com:19302'},
    ]
  };

  void initSocket(String userId) {
    socket = IO.io('YOUR_BACKEND_URL', <String, dynamic>{
      'transports': ['websocket'],
      'path': '/video-socket',
      'autoConnect': false,
    });

    socket.connect();

    socket.onConnect((_) {
      print('Connected to video socket');
      socket.emit('join', userId);
    });

    // CRITICAL: Listen for ICE config from backend
    socket.on('ice_config', (data) {
      print('Received ICE Config from backend: $data');
      if (data != null && data is List) {
        _iceConfiguration = {
          'iceServers': data
        };
      }
    });

    // ... other listeners (incoming_call, ice_candidate, etc.)
  }

  Future<void> startCall(String calleeId) async {
    // initialize peer connection with the received configuration
    RTCPeerConnection pc = await createPeerConnection(_iceConfiguration);

    // ... rest of your WebRTC setup (addStream, createOffer, etc.)
  }

  Future<void> acceptCall(dynamic incomingOffer) async {
     // initialize peer connection with the received configuration
    RTCPeerConnection pc = await createPeerConnection(_iceConfiguration);

    // ... rest of answer logic
  }
}
```

## 3. Handling ICE Candidates

Ensure you are sending and receiving ICE candidates correctly. The backend is optimized to relay them immediately.

```dart
    // When creating PeerConnection
    pc.onIceCandidate = (candidate) {
      if (candidate == null) return;
      socket.emit('ice_candidate', {
        'candidate': {
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMlineIndex,
        },
        'toUserId': peerId, // The ID of the person you are entering the call with
      });
    };

    // Listening for remote candidates
    socket.on('ice_candidate', (data) async {
      if (pc != null) {
        final candidate = RTCIceCandidate(
          data['candidate']['candidate'],
          data['candidate']['sdpMid'],
          data['candidate']['sdpMLineIndex'],
        );
        await pc.addCandidate(candidate);
      }
    });
```

## 4. Troubleshooting Checklist

- **Logs**: Check your Flutter debug console. You MUST see "Received ICE Config from backend" containing the `turn:global.turn.twilio.com` URL.
- **Network**: Testing on the same WiFi often works even without TURN. To verify TURN, disable WiFi on one device and use mobile data.
- **Blocked Ports**: Ensure your specific network isn't blocking UDP port 3478.
