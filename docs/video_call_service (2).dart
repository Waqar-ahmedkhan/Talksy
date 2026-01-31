// lib/call/services/video_call_service.dart

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as webrtc;
import 'package:get/get.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:just_audio/just_audio.dart';
import '../../utils/api_constants.dart';
import '../../utils/auth_storage.dart';
import '../../chat/services/notification_service.dart';
import '../view/video_calling_screen.dart';
import 'call_notification_service.dart';

class VideoCallService extends GetxService {
  static VideoCallService get to => Get.find();

  // Socket connection
  IO.Socket? videoSocket;

  // WebRTC
  webrtc.RTCPeerConnection? peerConnection;

  // Make streams reactive with Rx
  final Rx<webrtc.MediaStream?> localStream = Rx<webrtc.MediaStream?>(null);
  final Rx<webrtc.MediaStream?> remoteStream = Rx<webrtc.MediaStream?>(null);

  final List<webrtc.RTCIceCandidate> _pendingCandidates = [];

  // Configuration with STUN and TURN servers for better connectivity
  // Configuration with Enhanced STUN and TURN servers for better connectivity
  final Map<String, dynamic> configuration = {
    'iceServers': [
      // Google STUN servers (Primary - High Availability)
      {'urls': 'stun:stun.l.google.com:19302'},
      {'urls': 'stun:stun1.l.google.com:19302'},
      {'urls': 'stun:stun2.l.google.com:19302'},
      {'urls': 'stun:stun3.l.google.com:19302'},
      {'urls': 'stun:stun4.l.google.com:19302'},
    ],
    'iceCandidatePoolSize': 10,
    'sdpSemantics': 'unified-plan', // Use modern WebRTC standard
    'iceTransportPolicy': 'all', // Allow both direct P2P and TURN relay
    'bundlePolicy': 'max-bundle', // Bundle audio/video on same connection
    'rtcpMuxPolicy': 'require', // Multiplex RTP and RTCP on same port
  };

  // State management
  final RxString callState = 'idle'.obs;
  final Rx<String?> currentCallerId = Rx<String?>(null);
  final Rx<String?> currentCalleeId = Rx<String?>(null);
  final Rx<String?> currentCallerUserId = Rx<String?>(null);
  final Rx<String?> currentCalleeUserId = Rx<String?>(null);

  // Connection retry management
  int _connectionRetryCount = 0;
  static const int _maxRetryAttempts = 3;
  bool _isReconnecting = false; // Track lifecycle-driven reconnections
  final RxList<String> onlineUsers = <String>[].obs;
  final RxBool isMuted = false.obs;
  final RxBool isVideoEnabled = true.obs;
  final RxBool isSpeakerOn = false.obs;
  final RxString callType = 'video'.obs;

  // Prefixed logger for video diagnostics
  void _v(String msg) {
    debugPrint('[Track video] ' + msg);
  }

  // Ringtone player
  final AudioPlayer _ringtonePlayer = AudioPlayer();

  /// Initialize the service
  Future<VideoCallService> init() async {
    await initVideoSocket();
    await _initRingtone();
    return this;
  }

// Ensure media directions are sendrecv where we have local tracks.
  String _ensureSendRecv(String sdp,
      {bool forceVideo = true, bool forceAudio = true}) {
    try {
      final lines = sdp.split('\r\n');
      String? current;
      for (int i = 0; i < lines.length; i++) {
        final l = lines[i];
        if (l.startsWith('m=video '))
          current = 'video';
        else if (l.startsWith('m=audio ')) current = 'audio';

        if (l == 'a=recvonly' || l == 'a=sendonly') {
          if ((current == 'video' && forceVideo) ||
              (current == 'audio' && forceAudio)) {
            lines[i] = 'a=sendrecv';
          }
        } else if (l == 'a=inactive') {
          if ((current == 'video' && forceVideo) ||
              (current == 'audio' && forceAudio)) {
            lines[i] = 'a=sendrecv';
          }
        }
      }
      return lines.join('\r\n');
    } catch (e) {
      debugPrint('⚠️ _ensureSendRecv failed: $e');
      return sdp;
    }
  }

  /// Initialize ringtone
  Future<void> _initRingtone() async {
    try {
      await _ringtonePlayer.setLoopMode(LoopMode.one);
      debugPrint('✅ Video ringtone initialized');
    } catch (e) {
      debugPrint('❌ Error initializing video ringtone: $e');
    }
  }

  /// Play outgoing ringback tone (non-blocking)
  Future<void> _playRingback() async {
    try {
      _ringtonePlayer.setAsset('assets/sounds/ringback.mp3').then((_) {
        return _ringtonePlayer.play();
      }).catchError((e) {
        debugPrint('⚠️ Could not play video ringback: $e');
      });
      debugPrint('🔔 Video ringback started...');
    } catch (e) {
      debugPrint('⚠️ Error initiating ringback: $e');
    }
  }

  /// Play incoming ringtone (non-blocking)
  Future<void> _playIncomingRingtone() async {
    try {
      _ringtonePlayer.setAsset('assets/sounds/ringtone.mp3').then((_) {
        return _ringtonePlayer.play();
      }).catchError((e) {
        debugPrint('⚠️ Could not play video incoming ringtone: $e');
      });
      debugPrint('🔔 Video incoming ringtone started...');
    } catch (e) {
      debugPrint('⚠️ Error initiating incoming ringtone: $e');
    }
  }

  /// Stop ringtone
  Future<void> _stopRingtone() async {
    try {
      await _ringtonePlayer.stop();
      debugPrint('🔕 Video ringtone stopped');
    } catch (e) {
      debugPrint('⚠️ Error stopping video ringtone: $e');
    }
  }

  /// Initialize video socket connection
  Future<void> initVideoSocket() async {
    try {
      final userId = await AuthStorage.getBestUserIdentifier() ?? '';
      if (userId.isEmpty) {
        _v('❌ Cannot init video socket: userId is empty');
        return;
      }

      _v('🔧 Initializing Video Socket for userId: $userId');

      // Check if we're reconnecting during an active call
      final isActiveCall = callState.value == 'calling' ||
          callState.value == 'connected' ||
          callState.value == 'incoming';

      if (isActiveCall) {
        _v('🔄 Reconnecting socket during active call - preserving call state');
        _isReconnecting = true;
      }

      // Disconnect old socket gracefully if it exists
      if (videoSocket != null) {
        _v('🔄 Disconnecting old socket...');
        videoSocket?.dispose();
        videoSocket = null;

        // Wait a moment for cleanup
        await Future.delayed(const Duration(milliseconds: 100));
      }

      // Parse URI to ensure clean URL (no :0 port for ngrok)
      final uri = Uri.parse(ApiConstants.baseUrl);
      String cleanUrl;
      if (uri.hasPort && uri.port != 80 && uri.port != 443) {
        cleanUrl = '${uri.scheme}://${uri.host}:${uri.port}';
      } else {
        cleanUrl = '${uri.scheme}://${uri.host}';
      }
      _v('🔧 Video Socket Clean URL: $cleanUrl');

      // ✅ 1) Normalize user ID (Step 1 of checklist)
      final normalizedUserId = _normalizeId(userId);

      videoSocket = IO.io(
        cleanUrl,
        IO.OptionBuilder()
            .setPath('/video-socket')
            .setTransports(['websocket', 'polling'])
            .enableReconnection()
            .setReconnectionAttempts(30)
            .setReconnectionDelay(2000)
            .setTimeout(20000)
            .disableAutoConnect()
            .enableForceNewConnection()
            .setExtraHeaders({
              'Accept': 'application/json',
              'userId': normalizedUserId, // Send normalized ID in headers too
              'ngrok-skip-browser-warning': 'true',
              'User-Agent': 'FlutterApp',
            })
            .build(),
      );

      _setupSocketListeners(normalizedUserId);
      videoSocket?.connect();

      // Reset reconnection flag after successful connection
      if (_isReconnecting) {
        _v('🔄 Waiting for socket to connect...');
        await Future.delayed(const Duration(milliseconds: 500));
        _isReconnecting = false;
        _v('✅ Socket reconnected - call state preserved');
      }

      _v('✅ Video socket initialized for: $normalizedUserId');
    } catch (e) {
      _v('❌ Error initializing video socket: $e');
      _isReconnecting = false; // Reset flag on error
    }
  }

  // ✅ Helper to normalize IDs (Backend Step 1)
  String _normalizeId(String id) {
    // If it looks like a Mongo ID (24 hex chars), return as is
    final mongoIdRegExp = RegExp(r'^[0-9a-fA-F]{24}$');
    if (mongoIdRegExp.hasMatch(id)) {
      return id;
    }

    // If it's a phone number
    // Strip all non-digits first (except +)
    // If starts with 03, replace with +923
    // If already starts with +92, keep it
    if (id.startsWith('03') && id.length == 11) {
      return '+92${id.substring(1)}';
    }

    // If it's just numbers but no 03 prefix but looks like Pakistani number
    // This is user-specific logic, but complying with '03xxxxxxxxx -> +92xxxxxxxxxx' rule
    return id;
  }

  /// Setup all socket event listeners
  void _setupSocketListeners(String userId) {
    if (videoSocket == null) return;

    videoSocket!.onConnect((_) {
      _v('✅ Video socket connected, joining with userId: $userId');
      // ✅ 2) Connect socket and join (Backend Step 2)
      // Backend expects: videoSocket.emit('join', userId);
      // Previous code sent: {'userId': userId} - FIXED
      videoSocket!.emit('join', userId);
    });

    // ✅ Listen for DYNAMIC ICE CONFIGURATION from Backend
    // This allows the server to send updated TURN credentials without app updates
    videoSocket!.on('ice_config', (data) {
      _v('🔐 Received Secure ICE Configuration from Server');
      _v('📝 Raw config data: $data');

      if (data is List) {
        // Convert the dynamic list to List<Map<String, dynamic>>
        final List<Map<String, dynamic>> newIceServers = [];

        // 1. Always add Google STUN servers (Base layer - High Availability)
        newIceServers.add({'urls': 'stun:stun.l.google.com:19302'});
        newIceServers.add({'urls': 'stun:stun1.l.google.com:19302'});
        newIceServers.add({'urls': 'stun:stun2.l.google.com:19302'});
        newIceServers.add({'urls': 'stun:stun3.l.google.com:19302'});
        newIceServers.add({'urls': 'stun:stun4.l.google.com:19302'});

        // 2. Add Backend Servers (TURN/STUN)
        int backendServerCount = 0;
        for (var item in data) {
          if (item is Map) {
            newIceServers.add(Map<String, dynamic>.from(item));
            backendServerCount++;
          }
        }

        configuration['iceServers'] = newIceServers;
        _v('✅ ICE Servers updated. Total servers: ${newIceServers.length} (Backend: $backendServerCount)');

        // Verify TURN presence
        final hasTurn =
            newIceServers.any((s) => s['urls'].toString().contains('turn:'));
        if (hasTurn) {
          _v('✅ TURN Server detected in configuration');
        } else {
          _v('⚠️ WARNING: No TURN server detected in backend config! Mobile data calls may fail.');
        }

        // Log all servers for verification
        for (var s in newIceServers) {
          _v('   - Server: ${s['urls']}');
        }
      } else {
        _v('⚠️ Invalid ICE config format received: $data');
      }
    });

    videoSocket!.onDisconnect((_) {
      _v('🔴 Video socket disconnected');

      // Skip ending call if this is a lifecycle-driven reconnection
      if (_isReconnecting) {
        _v('🔄 Socket disconnected for reconnection - preserving call state');
        return;
      }

      // Properly end the call before setting state to ended
      if (callState.value == 'calling' || callState.value == 'connected') {
        _v('📞 Call was active, sending end_call signal...');
        final peerId = currentCalleeUserId.value ?? currentCallerUserId.value;

        if (peerId != null) {
          // Use stored user ID from current state
          final currentUserId =
              currentCallerUserId.value ?? currentCalleeUserId.value;
          if (currentUserId != null) {
            _v('📞 Emitting endCall to peer=$peerId');
            endCall(userId: currentUserId, peerId: peerId);
          }
        }
      }

      // Always stop any playing ringback/ringtone on disconnect
      _stopRingtone();

      callState.value = 'ended';
    });

    videoSocket!.onError((error) {
      _v('❌ Video socket error: $error');
    });

    videoSocket!.onAny((event, data) {
      _v('🔍 [SOCKET_EVENT] $event → $data');

      // CRITICAL: Check if call_accepted is coming but not being caught
      if (event == 'call_accepted') {
        _v('⚠️⚠️⚠️ call_accepted event detected in onAny!');
        debugPrint(
            '⚠️ This means the event IS coming but may not be caught by the specific listener');
      }
    });

    videoSocket!.on('online_users', (data) {
      _v('👥 Online users received: $data');
      if (data is List) {
        onlineUsers.value = data.map((e) => e.toString()).toList();
        _v('👥 Parsed online users: ${onlineUsers.toList()}');
      }
    });

    videoSocket!.on('calling', (data) {
      _v('📞 Video calling confirmation: $data');
      if (data != null && data is Map<String, dynamic>) {
        callState.value = 'calling';
        callType.value = data['callType'] ?? 'video';

        debugPrint('');
        _v('📞 ========================================');
        _v('📞 CALLER: Now in CALLING state');
        _v('📞 ========================================');
        _v('📞 Socket connected: ${videoSocket?.connected}');
        _v('📞 Socket ID: ${videoSocket?.id}');
        _v('📞 Waiting for callee to accept...');
        _v('📞 Will receive call_accepted event when accepted');
        debugPrint('');

        // Start ringback for outgoing video call
        _playRingback();
      }
    });

    videoSocket!.on('incoming_call', (data) async {
      _v('📞 Video incoming call received: $data');
      if (data != null && data is Map<String, dynamic>) {
        // ✅ 4) Incoming call (callee flow) - Backend Check 2
        // Backend sends: callerId (display) AND callerUserId (MongoID)
        final callerIdDisplay = data['callerId'] as String;
        final callerUserId =
            data['callerUserId'] as String; // Needs to be there
        final calleeUserId =
            data['calleeUserId'] as String?; // Backend provides this too

        final offer = data['offer'] as Map<String, dynamic>;
        final callType = data['callType'] as String? ?? 'video';
        final callerName = data['callerName'] as String? ?? callerIdDisplay;
        final callerPhone = data['callerPhone'] as String? ?? callerIdDisplay;

        currentCallerId.value = callerIdDisplay; // For UI
        callState.value = 'incoming';
        this.callType.value = callType;

        // Set user IDs early so ICE candidates can be sent during 'incoming'
        try {
          final selfId = await AuthStorage.getBestUserIdentifier();
          final normalizedSelfId = _normalizeId(selfId ?? '');

          currentCallerUserId.value = callerUserId; // Store remote MongoID
          // ✅ Prioritize calleeUserId from server if available (Quick fix 1)
          currentCalleeUserId.value = calleeUserId ?? normalizedSelfId;

          _v('📞 IDs set on incoming: callerUserId=${currentCallerUserId.value}, calleeUserId=${currentCalleeUserId.value}');
        } catch (e) {
          _v('⚠️ Could not set IDs on incoming: $e');
        }

        // Play incoming ringtone when incoming call is received
        await _playIncomingRingtone();

        // Show incoming call notification (WhatsApp style)
        try {
          final notificationService = Get.find<CallNotificationService>();
          await notificationService.showIncomingCallNotification(
            callerId: callerIdDisplay,
            callerName: callerName,
            callerPhone: callerPhone,
            isVideoCall: true,
          );
          _v('✅ Video call notification shown for: $callerName');
        } catch (e) {
          _v('❌ Error showing video call notification: $e');
        }

        await _createPeerConnection(isCaller: false);
        await peerConnection?.setRemoteDescription(
          webrtc.RTCSessionDescription(offer['sdp'], offer['type']),
        );
        _v('✅ Remote description set for incoming call');
        await _processPendingCandidates(); // Process buffered candidates

        _showIncomingCallScreen(
          callerId: callerIdDisplay,
          callerUserId: callerUserId,
          callType: callType,
        );
      }
    });

    videoSocket!.on('call_accepted', (data) async {
      debugPrint('');
      _v('🎉🎉🎉 ========================================');
      _v('🎉 CALL_ACCEPTED EVENT RECEIVED (CALLER SIDE)');
      _v('🎉🎉🎉 ========================================');
      _v('📞 Data: $data');
      _v('📞 Current call state BEFORE: ${callState.value}');
      debugPrint('');

      if (data != null && data is Map<String, dynamic>) {
        final answer = data['answer'] as Map<String, dynamic>;
        final callType = data['callType'] as String? ?? 'video';

        _v('📞 Answer SDP received: ${answer['sdp']?.toString().substring(0, 100)}...');
        _v('📞 Answer type: ${answer['type']}');

        // Stop ringtone when call is accepted
        await _stopRingtone();
        _v('🔕 Ringtone stopped');

        // End incoming call notification and show ongoing call notification
        try {
          final notificationService = Get.find<CallNotificationService>();
          await notificationService.endAllCallNotifications();
          _v('✅ Video incoming call notification ended');
        } catch (e) {
          _v('❌ Error ending video call notification: $e');
        }

        _v('📞 Setting remote description...');
        await peerConnection?.setRemoteDescription(
          webrtc.RTCSessionDescription(answer['sdp'], answer['type']),
        );
        _v('✅ Remote description set successfully');
        await _processPendingCandidates(); // Process buffered candidates

        // CRITICAL: Set state to connected AFTER setting remote description
        // This ensures UI updates properly
        _v('📞 Changing call state to connected...');
        callState.value = 'connected';
        this.callType.value = callType;
        _v('✅✅✅ Call state changed to: ${callState.value}');
        _v('✅✅✅ CALLER SHOULD NOW SEE CONNECTED SCREEN!');

        // CRITICAL: Force immediate stream update for UI
        forceStreamUpdate();

        // CRITICAL: Verify transceivers after setting remote description
        _v('📞 Verifying transceivers after answer...');
        final transceivers = await peerConnection!.getTransceivers();
        debugPrint('📞 Total transceivers: ${transceivers.length}');

        for (var t in transceivers) {
          _v('📞 Transceiver ${t.mid}:');
          _v('   - Has sender track: ${t.sender.track != null}');
          _v('   - Has receiver track: ${t.receiver.track != null}');

          if (t.receiver.track != null) {
            final track = t.receiver.track!;
            _v('   - Receiving ${track.kind} track: ${track.id}');
            _v('   - Track enabled: ${track.enabled}');
            _v('   - Track muted: ${track.muted}');

            if (track.kind == 'video' && track.muted == true) {
              debugPrint('⚠️ WARNING: Remote video track is MUTED!');
              debugPrint(
                  '   This means the remote peer is not sending video frames');
            }
          }
        }

        // Additional stream update after transceiver check
        Future.delayed(const Duration(milliseconds: 300), () {
          forceStreamUpdate();
          _v('🔄 Second stream update triggered');
        });
      }
    });

    videoSocket!.on('call_rejected', (data) async {
      _v('📞 Video call rejected: $data');
      if (data != null && data is Map<String, dynamic>) {
        // Stop ringtone when call is rejected
        await _stopRingtone();

        // End call notification
        try {
          final notificationService = Get.find<CallNotificationService>();
          await notificationService.endAllCallNotifications();
          _v('✅ Video call notification ended on rejection');
        } catch (e) {
          _v('❌ Error ending video call notification: $e');
        }

        callState.value = 'ended';
        _resetCallState();
        Get.snackbar('Call Rejected', 'User declined your call');
      }
    });

    videoSocket!.on('call_ended', (data) async {
      _v('📞 Video call ended: $data');
      if (data != null && data is Map<String, dynamic>) {
        // Stop ringtone when call ends
        await _stopRingtone();

        // End call notification
        try {
          final notificationService = Get.find<CallNotificationService>();
          await notificationService.endAllCallNotifications();
          _v('✅ Video call notification ended');
        } catch (e) {
          _v('❌ Error ending video call notification: $e');
        }

        callState.value = 'ended';
        final reason = data['reason'] ?? 'ended';

        _resetCallState();

        if (reason == 'offline') {
          Get.snackbar('Call Ended', 'User went offline');
        } else if (reason == 'disconnected') {
          Get.snackbar('Call Ended', 'User disconnected');
        } else {
          Get.snackbar('Call Ended', 'Call was ended');
        }
      }
    });

    videoSocket!.on('ice_candidate', (data) async {
      _v('📞 ICE candidate received: $data');
      if (data != null && data is Map<String, dynamic>) {
        final candidateData = data['candidate'] as Map<String, dynamic>;
        final candidate = webrtc.RTCIceCandidate(
          candidateData['candidate'],
          candidateData['sdpMid'],
          candidateData['sdpMLineIndex'],
        );

        if (peerConnection != null) {
          if (await peerConnection!.getRemoteDescription() != null) {
            _v('📞 Adding ICE candidate immediately');
            await peerConnection!.addCandidate(candidate);
          } else {
            _v('⏳ Buffering ICE candidate (remote description not set)');
            _pendingCandidates.add(candidate);
          }
        }
      }
    });

    videoSocket!.on('call_error', (data) async {
      _v('❌ Video call error: $data');
      if (data != null && data is Map<String, dynamic>) {
        final error = data['error'] ?? 'Unknown error';

        // ✅ WhatsApp-style: Ignore offline errors, let call continue ringing
        if (error.toLowerCase().contains('offline') ||
            error.toLowerCase().contains('not found') ||
            error.toLowerCase().contains('unavailable')) {
          _v('⚠️ User appears offline, but continuing call (WhatsApp style)');
          _v('⚠️ Will timeout after 60 seconds if no answer');

          // Show notification but DON'T end call
          Get.snackbar(
            'Calling...',
            'Ringing... (User may be offline)',
            snackPosition: SnackPosition.TOP,
            backgroundColor: Colors.blue.shade700,
            colorText: Colors.white,
            duration: Duration(seconds: 3),
          );
          return; // Don't end the call
        }

        // For other errors, end the call
        callState.value = 'ended';

        // End call notification on error
        try {
          final notificationService = Get.find<CallNotificationService>();
          await notificationService.endAllCallNotifications();
          _v('✅ Video call notification ended on error');
        } catch (e) {
          _v('❌ Error ending notification on call error: $e');
        }

        _resetCallState();
        Get.snackbar('Call Error', error);
      }
    });

    videoSocket!.on('user_busy', (data) async {
      _v('📞 User busy: $data');
      callState.value = 'ended';

      // End call notification when user is busy
      try {
        final notificationService = Get.find<CallNotificationService>();
        await notificationService.endAllCallNotifications();
        _v('✅ Video call notification ended - user busy');
      } catch (e) {
        _v('❌ Error ending notification on user busy: $e');
      }

      _resetCallState();
      Get.snackbar('User Busy', 'User is currently busy');
    });
    videoSocket!.on('join_call_room', (data) {
      _v('📞 Joined video call room: $data');
      callState.value = 'connected';
      // Stop any ringback if still playing
      _stopRingtone();
    });

    // ✅ NEW: Handle call_no_answer event (user offline - WhatsApp style)
    videoSocket!.on('call_no_answer', (data) {
      debugPrint('📞 ========================================');
      _v('📞 VIDEO CALL NO ANSWER EVENT RECEIVED (User Offline)');
      _v('📞 Data: $data');
      debugPrint('📞 ========================================');

      if (data is Map<String, dynamic>) {
        final status = data['status'];
        final message = data['message'];

        _v('📞 Status: $status');
        _v('📞 Message: $message');

        // Show user-friendly message (WhatsApp style)
        // Don't end call - let it ring for 60 seconds
        Get.snackbar(
          'Calling...',
          message ??
              'User is currently unavailable. They will see a missed call notification.',
          snackPosition: SnackPosition.TOP,
          backgroundColor: Colors.orange.shade700,
          colorText: Colors.white,
          duration: Duration(seconds: 5),
          icon: Icon(Icons.phone_missed, color: Colors.white),
        );

        _v('📞 Continuing to ring for full 60 seconds (WhatsApp style)');
        // Keep showing "Calling..." screen - let timeout handle it
      }
    });
  }

  // Process any buffered ICE candidates
  Future<void> _processPendingCandidates() async {
    if (_pendingCandidates.isEmpty) return;

    _v('⏳ Processing ${_pendingCandidates.length} buffered ICE candidates...');
    for (final candidate in _pendingCandidates) {
      await peerConnection?.addCandidate(candidate);
    }
    _pendingCandidates.clear();
    _v('✅ Buffered ICE candidates processed');
  }

  void requestOnlineUsers() {
    debugPrint('📞 Requesting online users');
    videoSocket?.emit('request_online_users');
  }

  void forceStreamUpdate() {
    debugPrint('🔄 Forcing stream update');
    if (remoteStream.value != null) {
      final stream = remoteStream.value;
      remoteStream.value = null;
      Future.delayed(const Duration(milliseconds: 50), () {
        remoteStream.value = stream;
      });
    }
  }

  // Add method to validate stream health
  bool _isStreamValid(webrtc.MediaStream? stream) {
    if (stream == null) return false;

    try {
      // Check if stream is still active
      final tracks = stream.getTracks();
      if (tracks.isEmpty) return false;

      // Check if any track is still active
      for (var track in tracks) {
        if (track.enabled) {
          return true;
        }
      }
      return false;
    } catch (e) {
      debugPrint('❌ Error validating stream: $e');
      return false;
    }
  }

  // Add method to recover from stream failures
  Future<void> _recoverFromStreamFailure() async {
    debugPrint('🔄 Attempting to recover from stream failure...');

    // Check if we need to recreate local stream
    if (localStream.value == null || !_isStreamValid(localStream.value)) {
      debugPrint('🔄 Recreating local stream...');
      try {
        final stream = await webrtc.navigator.mediaDevices.getUserMedia({
          'audio': true,
          'video': {
            'facingMode': 'user',
            'width': {'min': 320, 'ideal': 640, 'max': 1280},
            'height': {'min': 240, 'ideal': 480, 'max': 720},
            'frameRate': {'min': 15, 'ideal': 30, 'max': 30},
          }
        });

        // Add new stream to peer connection
        if (peerConnection != null) {
          stream.getTracks().forEach((track) {
            peerConnection!.addTrack(track, stream);
          });
        }

        localStream.value = stream;
        debugPrint('✅ Local stream recreated successfully');
      } catch (e) {
        debugPrint('❌ Failed to recreate local stream: $e');
        // Show user-friendly error message
        Get.snackbar(
          'Camera Error',
          'Unable to access camera. Please check permissions and try again.',
          snackPosition: SnackPosition.TOP,
          backgroundColor: Colors.red,
          colorText: Colors.white,
        );
      }
    }

    // For remote stream, we need to wait for it to be re-established
    // This usually happens automatically when the peer reconnects
    debugPrint('🔄 Waiting for remote stream to be re-established...');
  }

  // Add method to handle stream errors gracefully
  void _handleStreamError(String errorType, String errorMessage) {
    debugPrint('❌ Stream error: $errorType - $errorMessage');

    switch (errorType) {
      case 'local_stream_null':
        debugPrint('🔄 Local stream became null - attempting recovery');
        Future.delayed(const Duration(milliseconds: 1000), () {
          if (localStream.value == null) {
            _recoverFromStreamFailure();
          }
        });
        break;
      case 'remote_stream_null':
        debugPrint('⚠️ Remote stream became null - this might be temporary');
        // Don't try to recover remote stream immediately
        break;
      case 'stream_disposed':
        debugPrint('⚠️ Stream was disposed unexpectedly');
        if (_shouldPreventStreamDisposal()) {
          debugPrint(
              '🛡️ Stream disposal was prevented - call is still active');
        }
        break;
      default:
        debugPrint('❌ Unknown stream error: $errorType');
    }
  }

  // Add method to monitor stream health
  void _startStreamHealthMonitoring() {
    Timer.periodic(const Duration(seconds: 5), (timer) {
      if (callState.value == 'connected') {
        // Check local stream health
        if (localStream.value == null || !_isStreamValid(localStream.value)) {
          debugPrint('⚠️ Local stream health check failed');
          _handleStreamError('local_stream_null', 'Local stream is not valid');
        }

        // Check remote stream health
        if (remoteStream.value == null) {
          debugPrint('⚠️ Remote stream is null during health check');
          _handleStreamError('remote_stream_null', 'Remote stream is null');
        } else if (!_isStreamValid(remoteStream.value)) {
          debugPrint('⚠️ Remote stream health check failed');
          _handleStreamError(
              'remote_stream_invalid', 'Remote stream is not valid');
        }
      } else {
        // Stop monitoring if call is not active
        timer.cancel();
      }
    });
  }

  // Add method to stabilize streams
  void _stabilizeStreams() {
    debugPrint('🔧 Stabilizing streams...');

    // Ensure local stream is stable
    if (localStream.value != null) {
      final stream = localStream.value!;
      debugPrint('🔧 Local stream ID: ${stream.id}');
      debugPrint('🔧 Local stream tracks: ${stream.getTracks().length}');

      // Ensure all tracks are enabled
      for (var track in stream.getTracks()) {
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('🔧 Enabled local track: ${track.id}');
        }
      }
    }

    // Ensure remote stream is stable
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;
      debugPrint('🔧 Remote stream ID: ${stream.id}');
      debugPrint('🔧 Remote stream tracks: ${stream.getTracks().length}');

      // Ensure all tracks are enabled
      for (var track in stream.getTracks()) {
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('🔧 Enabled remote track: ${track.id}');
        }
      }
    }
  }

  Future<void> forceVideoTrackActivation() async {
    debugPrint('🎥 Forcing video track activation');
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;
      for (var track in stream.getVideoTracks()) {
        debugPrint('🎥 Activating video track: ${track.id}');
        debugPrint('🎥 Track kind: ${track.kind}');
        debugPrint('🎥 Track enabled before: ${track.enabled}');

        // Force track to be enabled - NO TOGGLING
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('✅ Enabled video track: ${track.id}');
        }

        debugPrint('🎥 Video track state after activation:');
        debugPrint('   Enabled: ${track.enabled}');
        debugPrint('   Kind: ${track.kind}');
      }

      // Force a stream refresh with delay to ensure renderer is ready
      Future.delayed(const Duration(milliseconds: 200), () {
        remoteStream.refresh();
      });

      // Additional delay and retry
      Future.delayed(const Duration(milliseconds: 500), () {
        if (remoteStream.value != null) {
          debugPrint('🔄 Retrying video track activation after delay');
          for (var track in remoteStream.value!.getVideoTracks()) {
            if (!track.enabled) {
              debugPrint('⚠️ Track was disabled, re-enabling: ${track.id}');
              track.enabled = true;
            }
          }
          remoteStream.refresh();
        }
      });
    } else {
      debugPrint('❌ Cannot force video activation: remote stream is null');
    }
  }

  // Add method to force video frame production - simplified without toggling
  Future<void> forceVideoFrameProduction() async {
    debugPrint('🎬 Forcing video frame production (simplified)');
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;
      debugPrint('🎬 Remote stream ID: ${stream.id}');
      debugPrint('🎬 Video tracks count: ${stream.getVideoTracks().length}');

      for (var track in stream.getVideoTracks()) {
        debugPrint('🎬 Processing video track: ${track.id}');
        debugPrint('🎬 Track kind: ${track.kind}');
        debugPrint('🎬 Track enabled: ${track.enabled}');

        // Simply ensure track is enabled - NO TOGGLING
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('✅ Enabled video track: ${track.id}');
        }

        debugPrint('🎬 Video track ${track.id} ensured to be enabled');
      }

      // Force multiple stream refreshes
      for (int i = 0; i < 3; i++) {
        remoteStream.refresh();
        await Future.delayed(const Duration(milliseconds: 100));
      }

      debugPrint(
          '🎬 Stream refreshed multiple times to force frame production');
    } else {
      debugPrint('❌ Cannot force frame production: remote stream is null');
    }
  }

  // Add method to ensure video track is enabled (no stopping/restarting)
  Future<void> restartVideoTrack() async {
    debugPrint('🔄 Ensuring video track is enabled (no restart)');
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;
      final videoTracks = stream.getVideoTracks();

      if (videoTracks.isNotEmpty) {
        final track = videoTracks.first;
        debugPrint('🔄 Checking video track: ${track.id}');
        debugPrint('🔄 Track enabled: ${track.enabled}');

        // Simply ensure it's enabled - NEVER stop the track
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('✅ Enabled video track: ${track.id}');
        }

        // Force stream refresh
        remoteStream.refresh();
        debugPrint('🔄 Stream refreshed');
      }
    }
  }

  // Method to ensure remote video track is enabled
  Future<void> forceRemoteVideoRestart() async {
    debugPrint('🔄 Ensuring remote video track is enabled');
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;

      // Get all video tracks
      final videoTracks = stream.getVideoTracks();
      debugPrint('🔄 Found ${videoTracks.length} video tracks to check');

      for (var track in videoTracks) {
        debugPrint('🔄 Checking video track: ${track.id}');
        debugPrint('🔄 Track enabled: ${track.enabled}');

        // Simply ensure it's enabled - NO TOGGLING
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('✅ Enabled video track: ${track.id}');
        }
      }

      // Force stream refresh
      remoteStream.refresh();
      debugPrint('🔄 Remote stream refreshed');
    }
  }

  // Method to check if remote peer is sending video
  void checkRemoteVideoStatus() {
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;
      debugPrint('🔍 Remote video status check:');
      debugPrint('   Stream ID: ${stream.id}');
      debugPrint('   Video tracks: ${stream.getVideoTracks().length}');

      for (var track in stream.getVideoTracks()) {
        debugPrint('   Track ${track.id}:');
        debugPrint('     Kind: ${track.kind}');
        debugPrint('     Enabled: ${track.enabled}');
      }
    } else {
      debugPrint('❌ Remote stream is null - no video available');
    }
  }

  // Method to force video constraints relaxation
  Future<void> relaxVideoConstraints() async {
    debugPrint('🎥 Relaxing video constraints to force frame production');

    // This method can be called to try different video constraints
    // if the current ones are too restrictive
    debugPrint('🎥 Current video constraints might be too restrictive');
    debugPrint('🎥 Consider checking remote peer\'s camera permissions');
    debugPrint('🎥 Remote peer might need to restart their camera');
  }

  // Method to optimize video constraints for better frame production
  Future<void> optimizeVideoConstraints() async {
    debugPrint('🎥 Optimizing video constraints for better frame production');

    if (localStream.value != null) {
      final stream = localStream.value!;
      final videoTracks = stream.getVideoTracks();

      for (var track in videoTracks) {
        debugPrint('🎥 Optimizing video track: ${track.id}');

        // Try to apply optimal constraints
        try {
          // Force track to be enabled and active
          track.enabled = true;

          // Apply constraints that might help with frame production
          await track.applyConstraints({
            'width': {'ideal': 640, 'max': 1280},
            'height': {'ideal': 480, 'max': 720},
            'frameRate': {'ideal': 30, 'max': 30},
            'facingMode': 'user',
          });

          debugPrint('✅ Video constraints optimized for track: ${track.id}');
        } catch (e) {
          debugPrint('⚠️ Error optimizing video constraints: $e');
        }
      }
    }
  }

  // Method to prevent track disposal
  void preventTrackDisposal() {
    debugPrint('🛡️ Preventing track disposal');
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;
      debugPrint('🛡️ Remote stream is alive: ${stream.id}');

      for (var track in stream.getVideoTracks()) {
        debugPrint('🛡️ Video track ${track.id} is enabled: ${track.enabled}');
        // Ensure track stays enabled
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('🛡️ Re-enabled video track: ${track.id}');
        }
      }

      // Keep stream alive by refreshing
      remoteStream.refresh();
      debugPrint('🛡️ Stream refreshed to prevent disposal');
    }
  }

  // Method to prevent premature stream disposal
  bool _shouldPreventStreamDisposal() {
    // Don't dispose streams if call is still active
    return callState.value == 'connected' ||
        callState.value == 'calling' ||
        callState.value == 'incoming';
  }

  // Method to safely dispose streams only when appropriate
  Future<void> _safeDisposeStreams() async {
    if (_shouldPreventStreamDisposal()) {
      debugPrint('🛡️ Preventing stream disposal - call is still active');
      return;
    }

    debugPrint('🧹 Safely disposing streams...');

    // Dispose local stream
    if (localStream.value != null) {
      try {
        final stream = localStream.value!;
        for (var track in stream.getTracks()) {
          try {
            track.stop();
          } catch (e) {
            debugPrint('⚠️ Error stopping track ${track.id}: $e');
          }
        }
        await stream.dispose();
        localStream.value = null;
        debugPrint('✅ Local stream safely disposed');
      } catch (e) {
        debugPrint('⚠️ Error disposing local stream: $e');
      }
    }

    // Dispose remote stream
    if (remoteStream.value != null) {
      try {
        final stream = remoteStream.value!;
        for (var track in stream.getTracks()) {
          try {
            track.stop();
          } catch (e) {
            debugPrint('⚠️ Error stopping track ${track.id}: $e');
          }
        }
        await stream.dispose();
        remoteStream.value = null;
        debugPrint('✅ Remote stream safely disposed');
      } catch (e) {
        debugPrint('⚠️ Error disposing remote stream: $e');
      }
    }
  }

  // Method to diagnose remote video issues
  void diagnoseRemoteVideoIssues() {
    debugPrint('🔍 Diagnosing remote video issues...');
    if (remoteStream.value != null) {
      final stream = remoteStream.value!;
      debugPrint('🔍 Remote stream analysis:');
      debugPrint('   Stream ID: ${stream.id}');
      debugPrint('   Video tracks: ${stream.getVideoTracks().length}');
      debugPrint('   Audio tracks: ${stream.getAudioTracks().length}');

      for (var track in stream.getVideoTracks()) {
        debugPrint('   Video track ${track.id}:');
        debugPrint('     Kind: ${track.kind}');
        debugPrint('     Enabled: ${track.enabled}');
        debugPrint('     ID: ${track.id}');
      }

      debugPrint('🔍 Possible issues:');
      debugPrint('   1. Remote peer camera not working');
      debugPrint('   2. Remote peer camera permissions not granted');
      debugPrint('   3. Remote peer camera being used by another app');
      debugPrint('   4. WebRTC codec negotiation failed');
      debugPrint('   5. Network issues affecting video transmission');
    } else {
      debugPrint('❌ Remote stream is null - no video available');
    }
  }

  /// Check if running on emulator
  Future<bool> _checkIfEmulator() async {
    try {
      // Check for common emulator properties
      if (defaultTargetPlatform == TargetPlatform.android) {
        // Android emulator detection
        // Note: In production, you might want to use device_info_plus package
        // for more accurate detection
        return false; // For now, assume real device
      } else if (defaultTargetPlatform == TargetPlatform.iOS) {
        // iOS simulator detection
        return false; // For now, assume real device
      }
      return false;
    } catch (e) {
      debugPrint('Error checking if emulator: $e');
      return false;
    }
  }

  Future<void> _handleConnectionFailure() async {
    _connectionRetryCount++;
    debugPrint(
        '📞 Connection failure attempt $_connectionRetryCount/$_maxRetryAttempts');

    if (_connectionRetryCount < _maxRetryAttempts) {
      debugPrint('📞 Attempting to recreate peer connection...');
      try {
        await peerConnection?.close();
        peerConnection = null;
        await Future.delayed(const Duration(seconds: 2));
        await _createPeerConnection(isCaller: localStream.value != null);

        if (callState.value == 'calling' || callState.value == 'connected') {
          debugPrint('📞 Attempting to re-establish call connection...');
        }
      } catch (e) {
        debugPrint('❌ Error during connection retry: $e');
        if (_connectionRetryCount >= _maxRetryAttempts) {
          debugPrint('📞 Max retry attempts reached, ending call');
          callState.value = 'ended';
        }
      }
    } else {
      debugPrint('📞 Max retry attempts reached, ending call');
      callState.value = 'ended';
    }
  }

  /// Create WebRTC peer connection
  Future<void> _createPeerConnection({bool isCaller = true}) async {
    try {
      debugPrint('📞 Creating peer connection...');
      // Only request camera/mic for caller. Callee will create local stream after accept.
      webrtc.MediaStream? stream;
      if (isCaller) {
        debugPrint('📞 Requesting camera and microphone access (caller)...');

        // Create local stream with optimized constraints for better compatibility
        // Use lower resolution for emulator compatibility
        final isEmulator = await _checkIfEmulator();

        // ✅ FIX: Force lower resolution (VGA) for everyone to ensure Emulator compatibility
        // High-res (720p/1080p) from Mobile often breaks Emulator decoding
        stream = await webrtc.navigator.mediaDevices.getUserMedia({
          'audio': {
            'echoCancellation': true,
            'noiseSuppression': true,
            'autoGainControl': true,
          },
          'video': {
            'facingMode': 'user',
            'width': {'ideal': 640, 'max': 640}, // Cap at 640x480
            'height': {'ideal': 480, 'max': 480},
            'frameRate': {'ideal': 20, 'max': 30},
          }
        });

        debugPrint('📞 Local stream created successfully');
        debugPrint(
            '📞 Local stream tracks: ${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio');

        // Debug and ensure local video tracks are enabled
        for (var track in stream.getVideoTracks()) {
          debugPrint('📞 Local video track:');
          debugPrint('   ID: ${track.id}');
          debugPrint('   Kind: ${track.kind}');
          debugPrint('   Label: ${track.label}');
          debugPrint('   Enabled BEFORE: ${track.enabled}');
          debugPrint('   Muted: ${track.muted}');

          // Ensure track is enabled
          track.enabled = true;

          debugPrint('   Enabled AFTER: ${track.enabled}');

          // CRITICAL: Check if track is actually producing frames
          if (track.muted == true) {
            debugPrint('   ⚠️ WARNING: Local video track is MUTED!');
            debugPrint('   This means camera is not producing frames!');
            debugPrint('   Possible causes:');
            debugPrint('   1. Camera hardware issue');
            debugPrint('   2. Camera in use by another app');
            debugPrint('   3. Camera permission not fully granted');
          }
        }

        // Update the reactive stream
        localStream.value = stream;
        debugPrint('📞 Local stream set in reactive variable');
      } else {
        debugPrint('📞 Skipping local getUserMedia for callee until accept');
      }

      // Create peer connection
      debugPrint('📞 Creating peer connection...');

      // LOG ACTIVE CONFIGURATION
      debugPrint('📞 Active ICE Configuration:');
      if (configuration['iceServers'] is List) {
        for (var server in configuration['iceServers']) {
          debugPrint('   - ${server['urls']}');
        }
      } else {
        debugPrint('⚠️ ICE Configuration is not a list!');
      }

      peerConnection = await webrtc.createPeerConnection(configuration);
      debugPrint('📞 Peer connection created successfully');

      // Attach local tracks via transceivers with codec preferences
      if (localStream.value != null) {
        // Attach local tracks via transceivers with codec preferences
        // ROBUST FIX: Use addTransceiver with explicit SendRecv direction
        // This ensures the SDP is correctly set to sendrecv and associates the track with the stream
        debugPrint(
            '📞 Attaching local tracks via addTransceiver (explicit SendRecv)...');

        for (final track in stream!.getTracks()) {
          try {
            await peerConnection!.addTransceiver(
              track: track,
              init: webrtc.RTCRtpTransceiverInit(
                direction: webrtc.TransceiverDirection.SendRecv,
                streams: [
                  stream
                ], // Critical for Unified Plan to associate track with stream
                // No sendEncodings - let WebRTC choose defaults to avoid "invalid dimensions"
              ),
            );
            debugPrint(
                '✅ Added transceiver for track: ${track.id} (${track.kind})');
          } catch (e) {
            debugPrint('⚠️ Failed adding transceiver: $e');
          }
        }

        // Verify all transceivers after adding
        final transceivers = await peerConnection!.getTransceivers();
        debugPrint('📞 Total transceivers configured: ${transceivers.length}');
        for (var transceiver in transceivers) {
          if (transceiver.sender.track != null) {
            debugPrint(
                '   - Sending ${transceiver.sender.track!.kind} track: ${transceiver.sender.track!.id}');
          }
        }
      }
      // REMOVED: Manual RecvOnly transceivers for callee
      // WebRTC will automatically create receivers when setRemoteDescription is called with the Offer.
      // This simplifies the logic and reduces state mismatch errors.
      debugPrint(
          '📞 Waiting for Offer to establish receivers (standard WebRTC behavior)');

      // Setup onTrack handler for receiving remote tracks
      peerConnection!.onTrack = (webrtc.RTCTrackEvent event) async {
        debugPrint('📞 Remote track received: ${event.track.kind}');
        _v('📞 Track ID: ${event.track.id}');
        _v('📞 Streams in event: ${event.streams.length}');
        _v('📞 Track label: ${event.track.label}');
        _v('📞 Track enabled: ${event.track.enabled}, muted: ${event.track.muted}');
        // Try to log track settings (resolution/framerate) if supported on platform
        try {
          final dynTrack = event.track as dynamic;
          final settings = await dynTrack.getSettings();
          debugPrint('📐 Track settings: $settings');
        } catch (_) {}

        // Enable the track immediately
        event.track.enabled = true;

        // CRITICAL FIX: Handle streams properly
        if (event.streams.isNotEmpty) {
          final stream = event.streams[0];
          _v('📞 Track received WITH stream: ${stream.id}');

          // Ensure all tracks are enabled
          for (var track in stream.getTracks()) {
            track.enabled = true;
          }

          // Update the stream (triggers UI update)
          remoteStream.value = stream;
          _v('✅ Remote stream updated: video=${stream.getVideoTracks().length}, audio=${stream.getAudioTracks().length}');
        } else {
          // Track received without an associated stream - create one manually
          _v('⚠️ Track received WITHOUT stream - creating MediaStream manually');
          try {
            final manual = await webrtc.createLocalMediaStream(
                'remote-stream-${DateTime.now().millisecondsSinceEpoch}');
            manual.addTrack(event.track);
            // Ensure the new track is enabled
            event.track.enabled = true;
            // Update reactive remote stream
            remoteStream.value = manual;
            _v('✅ Manual remote stream created: video=${manual.getVideoTracks().length}, audio=${manual.getAudioTracks().length}');
          } catch (e) {
            _v('❌ Failed to create manual remote stream: $e');
          }
        }
      };

      // Additional listener for addStream (fallback for older WebRTC implementations)
      peerConnection!.onAddStream = (webrtc.MediaStream stream) {
        _v('📞 Remote stream via onAddStream');

        for (var track in stream.getTracks()) {
          track.enabled = true;
        }

        remoteStream.value = stream;
      };

      // Listen for ICE candidates
      peerConnection!.onIceCandidate = (webrtc.RTCIceCandidate? candidate) {
        if (candidate != null && callState.value != 'ended') {
          debugPrint('📞 ICE candidate generated: ${candidate.candidate}');

          String? targetUserId;

          // Logic: Send to the OTHER party
          if (isCaller) {
            // I am the Caller -> Send to Callee
            targetUserId = currentCalleeUserId.value;
          } else {
            // I am the Callee -> Send to Caller
            targetUserId = currentCallerUserId.value;
          }

          debugPrint(
              '📞 Sending ICE candidate to peer (isCaller=$isCaller): $targetUserId');
          debugPrint(
              '📞 IDs: Caller=${currentCallerUserId.value}, Callee=${currentCalleeUserId.value}');

          if (targetUserId != null) {
            debugPrint('📞 Sending ICE candidate to user ID: $targetUserId');
            try {
              sendIceCandidate(
                toUserId: targetUserId,
                candidate: {
                  'candidate': candidate.candidate,
                  'sdpMid': candidate.sdpMid,
                  'sdpMLineIndex': candidate.sdpMLineIndex,
                },
              );
            } catch (e) {
              debugPrint('❌ Error sending ICE candidate: $e');
            }
          } else {
            debugPrint('❌ No target user ID for ICE candidate');
            debugPrint('❌ Current caller ID: ${currentCallerUserId.value}');
            debugPrint('❌ Current callee ID: ${currentCalleeUserId.value}');
          }
        }
      };

      // Listen for connection state changes
      peerConnection!.onConnectionState =
          (webrtc.RTCPeerConnectionState state) {
        _v('📞 Connection state: $state');
        if (state ==
            webrtc.RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
          callState.value = 'connected';
          _v('📞 Peer connection established successfully');
          webrtc.Helper.setSpeakerphoneOn(true);

          // CRITICAL: Comprehensive diagnostics for remote tracks
          Future.delayed(const Duration(milliseconds: 1000), () {
            _v('🔍 ========== REMOTE TRACK DIAGNOSTICS ==========');

            // Check remote stream
            if (remoteStream.value != null) {
              final stream = remoteStream.value!;
              _v('✅ Remote stream exists: ${stream.id}');
              _v('   - Video tracks: ${stream.getVideoTracks().length}');
              _v('   - Audio tracks: ${stream.getAudioTracks().length}');

              for (var track in stream.getVideoTracks()) {
                _v('   📹 Video track ${track.id}:');
                _v('      - Enabled: ${track.enabled}');
                _v('      - Muted: ${track.muted}');
                _v('      - Label: ${track.label}');
              }

              for (var track in stream.getAudioTracks()) {
                debugPrint('   🔊 Audio track ${track.id}:');
                debugPrint('      - Enabled: ${track.enabled}');
                debugPrint('      - Muted: ${track.muted}');
              }
            } else {
              debugPrint('❌ Remote stream is NULL!');
            }

            // Check receivers
            if (peerConnection != null) {
              peerConnection!.getReceivers().then((receivers) {
                _v('📊 Total receivers: ${receivers.length}');
                for (var receiver in receivers) {
                  if (receiver.track != null) {
                    _v('   - Receiver track: ${receiver.track!.kind}');
                    _v('     - ID: ${receiver.track!.id}');
                    _v('     - Enabled: ${receiver.track!.enabled}');
                    _v('     - Muted: ${receiver.track!.muted}');
                  } else {
                    _v('   - Receiver has NULL track!');
                  }
                }

                // Check transceivers
                peerConnection!.getTransceivers().then((transceivers) {
                  _v('📊 Total transceivers: ${transceivers.length}');
                  for (var transceiver in transceivers) {
                    _v('   - Transceiver: ${transceiver.mid}');
                    if (transceiver.receiver.track != null) {
                      _v('     - Has track: ${transceiver.receiver.track!.kind}');
                      _v('     - Track enabled: ${transceiver.receiver.track!.enabled}');
                    }
                  }
                  _v('🔍 ========== END DIAGNOSTICS ==========');
                });
              });
            }

            // Check if remote stream is null
            if (remoteStream.value == null) {
              _v('⚠️ CRITICAL: Remote stream is NULL after connection!');
              _v('   This means onTrack event did not fire!');
            } else {
              _v('✅ Remote stream exists: ${remoteStream.value!.id}');
            }
          });

          // Start stream health monitoring
          _startStreamHealthMonitoring();

          // Stabilize streams to prevent nullification
          _stabilizeStreams();

          // Optimize video constraints for better frame production
          Future.delayed(const Duration(milliseconds: 200), () {
            optimizeVideoConstraints();
          });

          // Ensure streams are still valid after connection
          Future.delayed(const Duration(milliseconds: 500), () {
            if (localStream.value == null) {
              debugPrint(
                  '⚠️ Local stream is null after connection - attempting recovery');
              _recoverFromStreamFailure();
            }
          });
        } else if (state ==
                webrtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
            state ==
                webrtc.RTCPeerConnectionState
                    .RTCPeerConnectionStateDisconnected) {
          _v('📞 Connection failed or disconnected, attempting to reconnect...');

          if (state ==
              webrtc.RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
            _v('📞 Connection failed - attempting to recreate peer connection...');
            _handleConnectionFailure();
          } else if (state ==
              webrtc
                  .RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
            debugPrint(
                '📞 Connection disconnected - will attempt to reconnect...');
            // Don't immediately dispose streams on disconnection
            // They might be re-established
          } else if (state ==
              webrtc.RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
            debugPrint('📞 Peer connection closed - remote peer disconnected');
            // Handle abrupt disconnection
            if (callState.value == 'connected' ||
                callState.value == 'calling') {
              debugPrint('📞 Remote peer disconnected abruptly, ending call');
              callState.value = 'ended';
            }
          }
        }
      };

      // Listen for ICE connection state changes
      peerConnection!.onIceConnectionState =
          (webrtc.RTCIceConnectionState state) {
        debugPrint('📞 ICE Connection State Changed: $state');
        // Add granular logging for debugging
        if (state == webrtc.RTCIceConnectionState.RTCIceConnectionStateFailed) {
          debugPrint('❌❌❌ ICE Connection FAILED');
          debugPrint('   This usually means NAT traversal failed.');
          debugPrint('   Possible causes:');
          debugPrint(
              '   1. Strict Firewall blocking UDP traffic on one or both sides.');
          debugPrint('   2. STUN servers failed to resolve public IP.');
          debugPrint(
              '   3. TURN server is required but not configured or unreachable.');
          debugPrint(
              '   4. Symmetric NAT detected (Difficult for P2P without TURN).');

          Get.snackbar(
            'Connection Failed',
            'Could not establish direct connection. Retrying...',
            backgroundColor: Colors.red,
            colorText: Colors.white,
          );
        } else if (state ==
            webrtc.RTCIceConnectionState.RTCIceConnectionStateDisconnected) {
          debugPrint(
              '⚠️ ICE Connection DISCONNECTED - potentially switching networks or signal loss.');
        } else if (state ==
            webrtc.RTCIceConnectionState.RTCIceConnectionStateConnected) {
          debugPrint(
              '✅ ICE Connection ESTABLISHED - Direct P2P or Relay successful!');
        } else if (state ==
            webrtc.RTCIceConnectionState.RTCIceConnectionStateChecking) {
          debugPrint('🔄 ICE Checking - Negotiating candidates...');
        }
      };

      // Listen for signaling state changes
      peerConnection!.onSignalingState = (webrtc.RTCSignalingState state) {
        debugPrint('📞 Signaling state: $state');
      };
    } catch (e) {
      debugPrint('❌ Error creating peer connection: $e');
      Get.snackbar('Error', 'Failed to access camera or microphone');
    }
  }

  /// Initiate video call
  Future<void> initiateVideoCall({
    required String callerId,
    required String calleeId,
    String? calleeName,
    String? calleeFcmToken, // FCM token for push notifications
  }) async {
    try {
      // ✅ Normalize IDs for backend (Step 3 of checklist)
      final normalizedCallerId = _normalizeId(callerId);
      final normalizedCalleeId = _normalizeId(calleeId);

      debugPrint(
          '📞 Initiating video call from $normalizedCallerId to $normalizedCalleeId');

      _connectionRetryCount = 0;

      debugPrint('📞 Setting user IDs for ICE candidates:');
      debugPrint('   Caller ID: $normalizedCallerId');
      debugPrint('   Callee ID: $normalizedCalleeId');

      currentCallerUserId.value = normalizedCallerId;
      currentCalleeUserId.value = normalizedCalleeId;

      debugPrint('📞 User IDs set in reactive variables:');
      debugPrint('   currentCallerUserId: ${currentCallerUserId.value}');
      debugPrint('   currentCalleeUserId: ${currentCalleeUserId.value}');
      callState.value = 'calling';
      callType.value = 'video';
      // Start outgoing video call ringtone immediately (WhatsApp style)
      await _playRingback();

      // 📲 Send direct FCM notification for offline users (like message notifications)
      if (calleeFcmToken != null && calleeFcmToken.isNotEmpty) {
        try {
          final callerPhone =
              await AuthStorage.getPhoneNumber() ?? normalizedCallerId;
          final callerName = calleeName ?? callerPhone;
          final notificationService = NotificationService();
          final callId = DateTime.now().millisecondsSinceEpoch.toString();
          await notificationService.sendCallNotification(
            token: calleeFcmToken,
            callerName: callerName,
            callType: 'video',
            callId: callId,
            callerId: normalizedCallerId,
          );
          debugPrint('📲 Direct FCM video call notification sent successfully');
        } catch (e) {
          debugPrint('⚠️ Failed to send direct FCM notification: $e');
        }
      } else {
        debugPrint(
            '⚠️ No FCM token available for callee, skipping notification');
      }

      await _createPeerConnection(isCaller: true);

      // CRITICAL: Ensure transceivers are properly configured before creating offer
      final transceivers = await peerConnection!.getTransceivers();
      debugPrint(
          '📞 Transceivers after _createPeerConnection: ${transceivers.length}');

      // Verify each transceiver has a sending track
      for (var t in transceivers) {
        debugPrint(
            '📞 Caller transceiver: ${t.mid}, sender: ${t.sender.track != null}, receiver: ${t.receiver.track != null}');
        if (t.sender.track != null) {
          final track = t.sender.track!;
          debugPrint('   - Sending ${track.kind} track: ${track.id}');
          debugPrint('   - Track enabled: ${track.enabled}');
          debugPrint('   - Track muted: ${track.muted}');

          // Force enable the track
          track.enabled = true;
        }
      }

      // Ensure we have both audio and video transceivers
      if (transceivers.length < 2) {
        debugPrint(
            '⚠️ WARNING: Only ${transceivers.length} transceivers found, expected 2');
        debugPrint('📞 This may cause remote video to not work');
      }

      debugPrint('📞 Creating offer with optimized constraints...');
      var offer = await peerConnection!.createOffer({
        'offerToReceiveAudio': true,
        'offerToReceiveVideo': true,
        'voiceActivityDetection': true,
        'iceRestart': false, // Don't restart ICE unless needed
      });
      debugPrint('📞 Offer created');

      // CRITICAL CHECK: Ensure SDP is not null
      if (offer.sdp == null || offer.sdp!.isEmpty) {
        throw Exception('Generated Offer SDP is null or empty!');
      }

      debugPrint(
          '📞 Offer SDP: ${offer.sdp?.substring(0, 200)}...'); // Log first 200 chars

      debugPrint('📞 Setting local description with codec preferences...');
      // Prefer VP8 over H264 to avoid MTK H264 encoder issues
      // Also ensure proper media direction
      // Safe SDP Munging
      webrtc.RTCSessionDescription finalOffer = offer;
      try {
        var mungedSdp = offer.sdp!;

        // Ensure sendrecv for both audio and video
        // mungedSdp =
        //    _ensureSendRecv(mungedSdp, forceVideo: true, forceAudio: true);

        // Force VP8 codec
        // mungedSdp = _preferVp8(mungedSdp);

        // Verify munging didn't break anything
        if (mungedSdp.isEmpty) {
          debugPrint(
              '⚠️ Munging resulted in empty SDP! Reverting to original.');
          finalOffer = offer;
        } else {
          finalOffer = webrtc.RTCSessionDescription(mungedSdp, offer.type);
        }
      } catch (e) {
        debugPrint(
            '⚠️ Failed to prepare offer SDP: $e. Reverting to original.');
        finalOffer = offer;
      }

      try {
        await peerConnection!.setLocalDescription(finalOffer);
        debugPrint('📞 Local description set successfully');
      } catch (e) {
        debugPrint('❌ Failed to set local description: $e');

        // If modified failed, try original as last resort
        if (finalOffer != offer) {
          debugPrint('🔄 Retrying with original unmodified offer...');
          await peerConnection!.setLocalDescription(offer);
          finalOffer = offer;
          debugPrint('✅ Original offer set successfully on retry');
        } else {
          rethrow;
        }
      }

      // Use the actually set description for sending via signaling
      final descriptionToSend = await peerConnection!.getLocalDescription();
      if (descriptionToSend == null) {
        throw Exception('Local description is null after setting!');
      }
      debugPrint('📞 Local description to send recovered successfully');

      final callData = {
        'callerId':
            normalizedCallerId, // MongoDB user ID - server uses this for matching
        'calleeId': normalizedCalleeId, // Use actual callee ID from parameter
        'offer': {
          'sdp': descriptionToSend.sdp,
          'type': descriptionToSend.type,
        },
        'callType': 'video'
      };

      debugPrint('📞 Requesting latest online users...');
      videoSocket?.emit('request_online_users');
      await Future.delayed(const Duration(milliseconds: 500));

      debugPrint('📞 Emitting video call_user event...');
      debugPrint('📞 Call data being sent: $callData');
      videoSocket?.emit('call_user', callData);
      debugPrint('📞 Emitted video call_user event successfully');

      _showVideoCallingScreen(
        contactName: calleeName ?? normalizedCalleeId,
        contactPhone: normalizedCalleeId,
        isIncoming: false,
      );

      // 60 second timeout like WhatsApp
      Timer(const Duration(seconds: 60), () {
        if (callState.value == 'calling') {
          debugPrint(
              '📞 Call timeout - no response from callee after 60 seconds');

          // Stop ringback before ending call
          _stopRingtone();

          callState.value = 'ended';

          // End call notification on timeout
          try {
            final notificationService = Get.find<CallNotificationService>();
            notificationService.endAllCallNotifications();
            debugPrint('✅ Video call notification ended on timeout');
          } catch (e) {
            debugPrint('❌ Error ending notification on timeout: $e');
          }

          _resetCallState();
          Get.snackbar('Call Ended', 'No answer');
          Get.back();
        }
      });
    } catch (e) {
      debugPrint('❌ Error initiating video call: $e');
      callState.value = 'ended';
    }
  }

  Future<void> acceptCall({
    required String callerId,
    required String calleeId,
  }) async {
    try {
      // ✅ Normalize IDs for backend (Step 4 of checklist)
      final normalizedCallerId = _normalizeId(callerId);
      final normalizedCalleeId = _normalizeId(calleeId);

      debugPrint('📞 ============================================');
      debugPrint('📞 ACCEPTING VIDEO CALL');
      debugPrint('📞 Caller ID: $normalizedCallerId');
      debugPrint('📞 Callee ID: $normalizedCalleeId');
      debugPrint('📞 Local stream exists: ${localStream.value != null}');
      if (localStream.value != null) {
        debugPrint(
            '📞 Local video tracks: ${localStream.value!.getVideoTracks().length}');
        debugPrint(
            '📞 Local audio tracks: ${localStream.value!.getAudioTracks().length}');
      }
      debugPrint('📞 ============================================');

      // ✅ CRITICAL: Stop ringtone immediately when accepting call
      await _stopRingtone();
      debugPrint('🔕 Video ringtone stopped on accept');

      // ✅ CRITICAL: Dismiss incoming call notification immediately
      try {
        final notificationService = Get.find<CallNotificationService>();
        await notificationService.endAllCallNotifications();
        debugPrint('✅ Video incoming call notification dismissed on accept');
      } catch (e) {
        debugPrint('❌ Error dismissing notification on accept: $e');
      }

      // CRITICAL: Set user IDs for ICE candidates to match callData
      currentCallerUserId.value = normalizedCallerId;
      currentCalleeUserId.value = normalizedCalleeId;

      debugPrint('📞 User IDs set for ICE candidates in acceptCall:');
      debugPrint('   currentCallerUserId: ${currentCallerUserId.value}');
      debugPrint('   currentCalleeUserId: ${currentCalleeUserId.value}');

      callState.value = 'connected';
      debugPrint('✅ Callee call state changed to: connected');

      // CRITICAL: Force immediate UI update for callee
      forceStreamUpdate();

      // CRITICAL: Ensure we have transceivers and attach local tracks before creating answer
      final transceivers = await peerConnection!.getTransceivers();
      debugPrint('📞 Transceivers before answer: ${transceivers.length}');

      // Ensure callee has a local stream; if missing, create it now (after accept)
      if (localStream.value == null) {
        try {
          final isEmulator = await _checkIfEmulator();
          final newStream = await webrtc.navigator.mediaDevices.getUserMedia({
            'audio': {
              'echoCancellation': true,
              'noiseSuppression': true,
              'autoGainControl': true,
            },
            'video': isEmulator
                ? {
                    'facingMode': 'user',
                    'width': {'ideal': 640},
                    'height': {'ideal': 480},
                    'frameRate': {'ideal': 15},
                  }
                : {
                    'facingMode': 'user',
                    'width': {'min': 320, 'ideal': 640, 'max': 1280},
                    'height': {'min': 240, 'ideal': 480, 'max': 720},
                    'frameRate': {'min': 15, 'ideal': 24, 'max': 30},
                    'aspectRatio': 1.777,
                  }
          });
          // Enable tracks
          for (var t in newStream.getTracks()) {
            t.enabled = true;
          }
          localStream.value = newStream;
          debugPrint('📞 Callee local stream created on accept');
        } catch (e) {
          debugPrint('❌ Failed to create callee local stream on accept: $e');
        }
      }

      // CRITICAL FIX: Use standard addTrack method
      if (localStream.value != null) {
        final stream = localStream.value!;
        debugPrint('📞 Adding local tracks to peer connection...');

        // Simply add tracks - WebRTC will attach them to the existing transceivers created by the Offer
        for (var track in stream.getTracks()) {
          try {
            await peerConnection!.addTrack(track, stream);
            debugPrint('✅ Added local track: ${track.id} (${track.kind})');
          } catch (e) {
            debugPrint('⚠️ Error adding local track ${track.id}: $e');
          }
        }

        debugPrint('✅ Local tracks added to peer connection');
      } else {
        debugPrint('⚠️ WARNING: No local stream available for callee!');
        debugPrint('📞 This will cause remote video to be 0x0');
      }

      var answer = await peerConnection!.createAnswer({
        'offerToReceiveAudio': true,
        'offerToReceiveVideo': true,
        'voiceActivityDetection': true,
      });

      // CRITICAL CHECK: Ensure SDP is not null
      if (answer.sdp == null || answer.sdp!.isEmpty) {
        throw Exception('Generated Answer SDP is null or empty!');
      }

      // CRITICAL: Check if answer has SSRC entries for video
      final originalSdp = answer.sdp ?? '';
      if (!originalSdp.contains('a=ssrc') || !originalSdp.contains('m=video')) {
        debugPrint('⚠️ WARNING: Answer SDP missing SSRC entries!');
        debugPrint('📞 This means local tracks are not properly attached');
      }

      // Safe SDP Munging for Answer
      webrtc.RTCSessionDescription finalAnswer = answer;
      try {
        var munged = originalSdp;
        // Always force sendrecv for both audio and video
        // munged = _ensureSendRecv(munged, forceVideo: true, forceAudio: true);

        // Force VP8 codec in Answer too
        // munged = _preferVp8(munged);

        if (munged.isEmpty) {
          debugPrint(
              '⚠️ Munging resulted in empty SDP! Reverting to original.');
          finalAnswer = answer;
        } else {
          finalAnswer = webrtc.RTCSessionDescription(munged, answer.type);
        }
      } catch (e) {
        debugPrint('⚠️ Failed to munge SDP: $e. Reverting to original.');
        finalAnswer = answer;
      }

      try {
        await peerConnection!.setLocalDescription(finalAnswer);
        debugPrint('📞 Answer local description set successfully');
      } catch (e) {
        debugPrint('❌ Failed to set local description: $e');

        // If modified failed, try original as last resort
        if (finalAnswer != answer) {
          debugPrint('🔄 Retrying with original unmodified answer...');
          await peerConnection!.setLocalDescription(answer);
          finalAnswer = answer;
          debugPrint('✅ Original answer set successfully on retry');
        } else {
          rethrow;
        }
      }

      // Use the actually set description for sending
      final descriptionToSend = await peerConnection!.getLocalDescription();
      if (descriptionToSend == null) {
        throw Exception('Local description is null after setting!');
      }
      debugPrint('📞 Answer created');
      debugPrint(
          '📞 Answer SDP: ${descriptionToSend.sdp?.substring(0, 200)}...');

      // Log if video SSRC is present
      if (descriptionToSend.sdp!.contains('a=ssrc') &&
          descriptionToSend.sdp!.contains('m=video')) {
        debugPrint('✅ Answer contains SSRC entries for video');
      } else {
        debugPrint('❌ CRITICAL: Answer missing SSRC entries for video!');
      }

      final acceptData = {
        'callerId':
            normalizedCallerId, // MongoDB user ID - server uses this for matching
        'calleeId': normalizedCalleeId, // Use actual callee ID from parameter
        'answer': {
          'sdp': descriptionToSend.sdp,
          'type': descriptionToSend.type,
        }
      };

      debugPrint('');
      debugPrint('📤📤📤 ========================================');
      debugPrint('📤 EMITTING accept_call EVENT TO SERVER');
      debugPrint('📤📤📤 ========================================');
      debugPrint(
          '📤 Caller ID (will receive call_accepted): $normalizedCallerId');
      debugPrint('📤 Callee ID (this device): $normalizedCalleeId');
      debugPrint('📤 Answer SDP length: ${answer.sdp?.length ?? 0}');
      debugPrint('📤 Socket connected: ${videoSocket?.connected}');
      debugPrint('📤 Socket ID: ${videoSocket?.id}');
      debugPrint('');

      if (videoSocket?.connected != true) {
        debugPrint('❌❌❌ CRITICAL: Socket is NOT connected!');
        debugPrint('❌ Cannot emit accept_call event!');
        debugPrint('❌ Reconnecting socket...');
        videoSocket?.connect();
        await Future.delayed(const Duration(seconds: 2));
      }

      videoSocket?.emit('accept_call', acceptData);
      debugPrint('✅ accept_call event emitted to server');
      debugPrint(
          '⏳ Waiting for caller ($normalizedCallerId) to receive call_accepted event...');
      debugPrint('');
      debugPrint('🔍 If caller does NOT receive call_accepted:');
      debugPrint('   1. Check server logs for accept_call event');
      debugPrint(
          '   2. Check if server is emitting call_accepted to correct user');
      debugPrint('   3. Check caller socket connection status');
    } catch (e) {
      debugPrint('❌ Error accepting call: $e');
    }
  }

  Future<void> rejectCall({
    required String callerId,
    required String calleeId,
  }) async {
    try {
      // ✅ Normalize IDs (Consistency)
      final normalizedCallerId = _normalizeId(callerId);
      final normalizedCalleeId = _normalizeId(calleeId);

      debugPrint('📞 Rejecting video call from $normalizedCallerId');

      // ✅ CRITICAL: Stop ringtone when rejecting call
      await _stopRingtone();
      debugPrint('🔕 Video ringtone stopped on reject');

      // ✅ CRITICAL: Dismiss incoming call notification immediately
      try {
        final notificationService = Get.find<CallNotificationService>();
        await notificationService.endAllCallNotifications();
        debugPrint('✅ Video incoming call notification dismissed on reject');
      } catch (e) {
        debugPrint('❌ Error dismissing notification on reject: $e');
      }

      callState.value = 'ended';

      final rejectData = {
        'callerId': normalizedCallerId,
        'calleeId': normalizedCalleeId,
      };

      videoSocket?.emit('reject_call', rejectData);
      debugPrint('📞 Emitted reject_call event');

      _resetCallState();
    } catch (e) {
      debugPrint('❌ Error rejecting call: $e');
    }
  }

  Future<void> endCall({
    required String userId,
    required String peerId,
  }) async {
    try {
      debugPrint('📞 Ending video call between $userId and $peerId');

      // CRITICAL: Stop ringtone when ending call
      await _stopRingtone();

      // ✅ 5) Normalize IDs for end_call (Backend requirement)
      // Always ensure we are sending MongoID or E.164, never raw '03...'
      final normalizedUserId = _normalizeId(userId);
      final normalizedPeerId = _normalizeId(peerId);

      callState.value = 'ended';

      final endData = {
        'userId': normalizedUserId,
        'peerId': normalizedPeerId,
      };

      debugPrint('📞 Emitting end_call event with normalized IDs: $endData');
      videoSocket?.emit('end_call', endData);
      debugPrint('📞 Emitted end_call event');

      _resetCallState();
    } catch (e) {
      debugPrint('❌ Error ending call: $e');
    }
  }

  void sendIceCandidate({
    required String toUserId,
    required Map<String, dynamic> candidate,
  }) {
    debugPrint('📞 Sending ICE candidate to $toUserId');

    final iceCandidateData = {
      'candidate': candidate,
      'toUserId': toUserId,
    };

    if (videoSocket?.connected == true) {
      videoSocket?.emit('ice_candidate', iceCandidateData);
    } else {
      debugPrint(
          '❌ CRITICAL: Socket disconnected! Cannot send ICE candidate to $toUserId');
    }
  }

  Future<void> toggleMute() async {
    if (localStream.value != null) {
      final audioTrack = localStream.value!.getAudioTracks().first;
      audioTrack.enabled = !audioTrack.enabled;
      isMuted.value = !audioTrack.enabled;
      debugPrint('📞 Mute toggled: ${isMuted.value}');
    }
  }

  Future<void> toggleVideo() async {
    if (localStream.value != null) {
      final videoTrack = localStream.value!.getVideoTracks().first;
      videoTrack.enabled = !videoTrack.enabled;
      isVideoEnabled.value = videoTrack.enabled;
      debugPrint('📞 Video toggled: ${isVideoEnabled.value}');
    }
  }

  Future<void> toggleSpeaker() async {
    isSpeakerOn.value = !isSpeakerOn.value;
    if (localStream.value != null) {
      await webrtc.Helper.setSpeakerphoneOn(isSpeakerOn.value);
      debugPrint('📞 Speaker toggled: ${isSpeakerOn.value}');
    }
  }

  Future<void> switchCamera() async {
    if (localStream.value != null) {
      final videoTrack = localStream.value!.getVideoTracks().first;
      await videoTrack.switchCamera();
      debugPrint('📞 Camera switched');
    }
  }

  void _showIncomingCallScreen(
      {required String callerId, // Display ID
      required String callerUserId, // Mongo ID
      required String callType}) {
    debugPrint(
        '📞 Showing incoming video call screen for: $callerId (User: $callerUserId)');

    // Use Get.to instead of Get.dialog for immediate display
    Get.to(
      () => VideoCallingScreen(
        contactName: callerId,
        contactPhone: callerId,
        isIncoming: true,
        callerId: callerUserId, // Pass MongoID here!
        callType: callType,
      ),
      transition: Transition.fadeIn,
      duration: const Duration(milliseconds: 100),
    );
  }

  void _showVideoCallingScreen({
    required String contactName,
    required String contactPhone,
    bool isIncoming = false,
  }) {
    debugPrint('📞 Showing video calling screen for: $contactName');

    Get.to(() => VideoCallingScreen(
          contactName: contactName,
          contactPhone: contactPhone,
          isIncoming: isIncoming,
          callType: 'video',
        ));
  }

  // video_call_service.dart mein ye changes karo:

  Future<void> _resetCallState() async {
    debugPrint('🧹 Resetting call state...');

    currentCallerId.value = null;
    currentCalleeId.value = null;
    currentCallerUserId.value = null;
    currentCalleeUserId.value = null;
    callState.value = 'idle';
    isMuted.value = false;
    isVideoEnabled.value = true;
    isSpeakerOn.value = false;
    callType.value = 'video';
    _connectionRetryCount = 0;

    // Close peer connection first
    if (peerConnection != null) {
      try {
        await peerConnection!.close();
        debugPrint('✅ Peer connection closed');
      } catch (e) {
        debugPrint('⚠️ Error closing peer connection: $e');
      }
      peerConnection = null;
    }

    // Use safe disposal method
    await _safeDisposeStreams();

    // Small delay to ensure cleanup
    await Future.delayed(const Duration(milliseconds: 200));

    debugPrint('✅ Video call state reset completed');
  }

  @override
  void onClose() {
    _resetCallState();
    videoSocket?.dispose();
    super.onClose();
  }
}

// --- SDP Utilities ---
// Reorder m=video payloads to put VP8 first, keeping other codecs afterwards.
// Reorder m=video payloads to put VP8 first, and remove others if possible to ensure compatibility
String _preferVp8(String sdp) {
  try {
    final lines = sdp.split('\r\n');
    final videoMLineIndex = lines.indexWhere((l) => l.startsWith('m=video '));
    if (videoMLineIndex == -1) return sdp; // no video

    // Map codec name -> payload types from rtpmap
    final Map<String, List<String>> codecPts = {};
    final RegExp rtpmap = RegExp(r'^a=rtpmap:(\d+)\s+([^/]+)');
    for (final l in lines) {
      final m = rtpmap.firstMatch(l);
      if (m != null) {
        final pt = m.group(1)!;
        final name = m.group(2)!.toUpperCase();
        codecPts.putIfAbsent(name, () => []).add(pt);
      }
    }

    // Parse current m=video payload list
    final parts = lines[videoMLineIndex].split(' ');
    if (parts.length < 4) return sdp; // malformed
    final header = parts.sublist(0, 3).join(' ');
    final payloads = parts.sublist(3);

    final reordered = <String>[];
    final seen = <String>{};

    // 1. Add VP8 payloads first (Preferred for Emulator)
    final vp8Pts = codecPts['VP8'] ?? [];
    for (final pt in vp8Pts) {
      if (payloads.contains(pt) && seen.add(pt)) reordered.add(pt);
    }

    // 2. Add VP9 payloads
    final vp9Pts = codecPts['VP9'] ?? [];
    for (final pt in vp9Pts) {
      if (payloads.contains(pt) && seen.add(pt)) reordered.add(pt);
    }

    // 3. Add H264 payloads (Important fallback for Mobile)
    final h264Pts = codecPts['H264'] ?? [];
    for (final pt in h264Pts) {
      if (payloads.contains(pt) && seen.add(pt)) reordered.add(pt);
    }

    // 4. Add remaining payloads (H265, RTX, etc.)
    for (final pt in payloads) {
      if (!seen.contains(pt)) {
        reordered.add(pt);
      }
    }

    if (reordered.isEmpty) {
      debugPrint('⚠️ No codecs found to reorder! Keeping original.');
      return sdp;
    }

    debugPrint('🔧 Preferred Codec Order: ${reordered.join(' ')}');
    lines[videoMLineIndex] = '$header ${reordered.join(' ')}';
    return lines.join('\r\n');
  } catch (e) {
    debugPrint('⚠️ _preferVp8 failed: $e');
    return sdp;
  }
}
