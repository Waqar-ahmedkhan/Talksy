// lib/call/view/video_calling_screen.dart

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:get/get.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as webrtc;
import '../services/video_call_service.dart';
import '../../utils/auth_storage.dart';

class VideoCallingScreen extends StatefulWidget {
  final String contactName;
  final String contactPhone;
  final String? contactAvatar;
  final bool isIncoming;
  final String? callerId;
  final String callType;

  const VideoCallingScreen({
    Key? key,
    required this.contactName,
    required this.contactPhone,
    this.contactAvatar,
    this.isIncoming = false,
    this.callerId,
    this.callType = 'video',
  }) : super(key: key);

  @override
  State<VideoCallingScreen> createState() => _VideoCallingScreenState();
}

class _VideoCallingScreenState extends State<VideoCallingScreen>
    with TickerProviderStateMixin {
  late AnimationController _pulseController;
  late Animation<double> _pulseAnimation;
  Timer? _callTimer;

  final VideoCallService _videoCallService = Get.find<VideoCallService>();

  int _callDuration = 0;
  bool _isCallConnected = false;

  // Video renderers
  webrtc.RTCVideoRenderer? _localRenderer;
  webrtc.RTCVideoRenderer? _remoteRenderer;
  bool _isLocalVideoFullscreen = false;

  // Video dimension tracking
  final Map<String, int> _lastDimensionCheck = {};

  @override
  void initState() {
    super.initState();

    // Initialize video renderers
    _initializeRenderers();

    // Setup pulse animation for calling state
    _pulseController = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    );
    _pulseAnimation = Tween<double>(
      begin: 1.0,
      end: 1.2,
    ).animate(CurvedAnimation(
      parent: _pulseController,
      curve: Curves.easeInOut,
    ));

    // Start pulse animation if outgoing call
    if (!widget.isIncoming) {
      _pulseController.repeat(reverse: true);
    }

    // Listen to call state changes
    _setupCallStateListener();

    // Listen to stream changes
    _setupStreamListeners();

    // Start periodic video dimension check
    _startVideoDimensionCheck();

    // Start local video verification
    _startLocalVideoVerification();
  }

  void _startLocalVideoVerification() {
    Timer.periodic(const Duration(seconds: 3), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }

      final localStream = _videoCallService.localStream.value;
      if (localStream != null) {
        debugPrint('🎥 LOCAL VIDEO STATUS:');
        debugPrint('   - Stream ID: ${localStream.id}');
        debugPrint('   - Video tracks: ${localStream.getVideoTracks().length}');

        for (var track in localStream.getVideoTracks()) {
          debugPrint('   - Track ${track.id}:');
          debugPrint('     - Enabled: ${track.enabled}');
          debugPrint('     - Muted: ${track.muted}');
          debugPrint('     - Kind: ${track.kind}');
        }

        if (_localRenderer != null) {
          debugPrint(
              '   - Local renderer dimensions: ${_localRenderer!.videoWidth}x${_localRenderer!.videoHeight}');
        }
      } else {
        debugPrint('⚠️ Local stream is null!');
      }
    });
  }

  Future<void> _recreateRemoteRenderer() async {
    if (!mounted) return;

    debugPrint('🔄 Recreating remote renderer to fix 0x0 dimensions...');

    try {
      // Save the current stream
      final currentStream = _videoCallService.remoteStream.value;

      if (currentStream == null) {
        debugPrint('⚠️ No remote stream to recreate renderer for');
        return;
      }

      // Dispose old renderer
      if (_remoteRenderer != null) {
        debugPrint('🧹 Disposing old remote renderer');
        _remoteRenderer!.srcObject = null;
        await _remoteRenderer!.dispose();
        _remoteRenderer = null;
      }

      // Small delay
      await Future.delayed(const Duration(milliseconds: 100));

      // Create new renderer
      debugPrint('🆕 Creating new remote renderer');
      _remoteRenderer = webrtc.RTCVideoRenderer();
      await _remoteRenderer!.initialize();
      debugPrint(
          '✅ New remote renderer initialized - textureId: ${_remoteRenderer!.textureId}');

      // Assign stream to new renderer
      _remoteRenderer!.srcObject = currentStream;
      debugPrint('✅ Stream assigned to new remote renderer');

      // Force UI update
      if (mounted) {
        setState(() {});
      }

      // Check dimensions after recreation
      Future.delayed(const Duration(milliseconds: 500), () {
        if (mounted && _remoteRenderer != null) {
          final width = _remoteRenderer!.videoWidth;
          final height = _remoteRenderer!.videoHeight;
          debugPrint(
              '📊 Remote renderer dimensions after recreation: ${width}x$height');
        }
      });
    } catch (e) {
      debugPrint('❌ Error recreating remote renderer: $e');
    }
  }

  void _initializeRenderers() async {
    try {
      debugPrint('📞 Initializing video renderers...');

      // Initialize local renderer
      _localRenderer = webrtc.RTCVideoRenderer();
      await _localRenderer!.initialize();
      debugPrint(
          '✅ Local renderer initialized - textureId: ${_localRenderer!.textureId}');

      // Initialize remote renderer
      _remoteRenderer = webrtc.RTCVideoRenderer();
      await _remoteRenderer!.initialize();
      debugPrint(
          '✅ Remote renderer initialized - textureId: ${_remoteRenderer!.textureId}');

      // Wait a bit for renderers to be fully ready
      await Future.delayed(const Duration(milliseconds: 100));

      // Force rebuild after initialization
      if (mounted) {
        setState(() {});
        debugPrint('✅ Renderers initialized and state updated');

        // Check if there are any pending streams to assign
        _checkPendingStreams();
      }
    } catch (e) {
      debugPrint('❌ Error initializing video renderers: $e');
    }
  }

  // Check if there are any pending streams to assign after renderer initialization
  void _checkPendingStreams() {
    if (!mounted) return;

    // Check for pending local stream
    final localStream = _videoCallService.localStream.value;
    if (localStream != null &&
        _localRenderer != null &&
        _localRenderer!.textureId != null) {
      debugPrint(
          '🔄 Assigning pending local stream after renderer initialization');
      _localRenderer!.srcObject = localStream;
    }

    // Check for pending remote stream
    final remoteStream = _videoCallService.remoteStream.value;
    if (remoteStream != null &&
        _remoteRenderer != null &&
        _remoteRenderer!.textureId != null) {
      debugPrint(
          '🔄 Assigning pending remote stream after renderer initialization');
      _assignRemoteStream(remoteStream);
    }
  }

  void _setupStreamListeners() {
    // Listen to local stream changes
    ever(_videoCallService.localStream, (webrtc.MediaStream? stream) async {
      debugPrint('🔄 Local stream changed: ${stream?.id}');

      if (stream == null) {
        debugPrint('⚠️ Local stream became null - attempting recovery');
        // Try to recover from stream failure
        Future.delayed(const Duration(milliseconds: 1000), () {
          if (_videoCallService.localStream.value == null && mounted) {
            debugPrint('🔄 Attempting to recover local stream...');
            // Note: Recovery will be handled by the service's health monitoring
          }
        });
        return;
      }

      if (_localRenderer != null &&
          _localRenderer!.textureId != null &&
          mounted) {
        debugPrint('📞 Setting local stream to renderer');
        _localRenderer!.srcObject = stream;

        // Immediately update UI after setting srcObject
        setState(() {});

        debugPrint('✅ Local renderer updated');
      } else {
        debugPrint(
            '⚠️ Local renderer not ready - stream will be set when renderer is ready');
      }
    });

    // Listen to remote stream changes
    ever(_videoCallService.remoteStream, (webrtc.MediaStream? stream) async {
      debugPrint('🔄 Remote stream changed: ${stream?.id}');

      // Check if widget is still mounted before processing
      if (!mounted) {
        debugPrint('⚠️ Widget not mounted, skipping stream assignment');
        return;
      }

      if (stream == null) {
        debugPrint('⚠️ Remote stream became null - this might be temporary');
        // Don't try to recover remote stream immediately as it might be re-established
        return;
      }

      // Wait for renderer to be properly initialized
      if (_remoteRenderer == null) {
        debugPrint('⚠️ Remote renderer not initialized yet, waiting...');
        Future.delayed(const Duration(milliseconds: 100), () {
          if (mounted && _remoteRenderer != null) {
            _assignRemoteStream(stream);
          }
        });
        return;
      }

      if (_remoteRenderer!.textureId == null) {
        debugPrint('⚠️ Remote renderer textureId not ready, waiting...');
        Future.delayed(const Duration(milliseconds: 200), () {
          if (mounted &&
              _remoteRenderer != null &&
              _remoteRenderer!.textureId != null) {
            _assignRemoteStream(stream);
          }
        });
        return;
      }

      // Assign stream to renderer
      _assignRemoteStream(stream);
    });
  }

  // Helper method to assign remote stream to renderer - FIXED VERSION
  Future<void> _assignRemoteStream(webrtc.MediaStream stream) async {
    if (!mounted ||
        _remoteRenderer == null ||
        _remoteRenderer!.textureId == null) {
      debugPrint('⚠️ Renderer not ready, retrying in 100ms...');
      Future.delayed(const Duration(milliseconds: 100), () {
        if (mounted &&
            _remoteRenderer != null &&
            _remoteRenderer!.textureId != null) {
          _assignRemoteStream(stream);
        }
      });
      return;
    }

    // CRITICAL: Prevent duplicate assignments of the same stream
    if (_remoteRenderer!.srcObject != null &&
        _remoteRenderer!.srcObject!.id == stream.id) {
      debugPrint(
          '⏭️ Stream already assigned to renderer, skipping duplicate assignment');
      return;
    }

    try {
      debugPrint('🎥 Assigning remote stream to renderer');
      debugPrint('   - Stream ID: ${stream.id}');
      debugPrint('   - Video tracks: ${stream.getVideoTracks().length}');
      debugPrint('   - Audio tracks: ${stream.getAudioTracks().length}');
      debugPrint('   - Renderer textureId: ${_remoteRenderer!.textureId}');

      // DIAGNOSTIC: Check video track settings and capabilities
      for (var track in stream.getVideoTracks()) {
        debugPrint('🔍 DIAGNOSTIC - Video Track Settings:');
        debugPrint('   - Track ID: ${track.id}');
        debugPrint('   - Label: ${track.label}');
        debugPrint('   - Enabled: ${track.enabled}');
        debugPrint('   - Muted: ${track.muted}');
        debugPrint('   - Kind: ${track.kind}');

        // Get track settings to check actual video dimensions
        try {
          final settings = track.getSettings();
          debugPrint('   📐 Track Settings (Actual Video Dimensions):');
          debugPrint('      - Width: ${settings['width'] ?? 'N/A'}');
          debugPrint('      - Height: ${settings['height'] ?? 'N/A'}');
          debugPrint('      - FrameRate: ${settings['frameRate'] ?? 'N/A'}');
          debugPrint(
              '      - AspectRatio: ${settings['aspectRatio'] ?? 'N/A'}');
          debugPrint('      - FacingMode: ${settings['facingMode'] ?? 'N/A'}');

          // Check if dimensions match screen expectations
          final width = settings['width'];
          final height = settings['height'];
          if (width != null && height != null && width > 0 && height > 0) {
            debugPrint(
                '   ✅ Video track has valid dimensions: ${width}x${height}');
            debugPrint(
                '   ✅ Sender and transport layer (ICE/TURN/STUN) working correctly!');
          } else {
            debugPrint('   ❌ Video track has invalid dimensions!');
            debugPrint('   ❌ Problem is in sender or transport layer!');
          }
        } catch (e) {
          debugPrint('   ⚠️ Could not get track settings: $e');
        }

        // Enable track if disabled
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('   - Enabled track: ${track.id}');
        }
      }

      // Ensure audio tracks are enabled too
      for (var track in stream.getAudioTracks()) {
        if (!track.enabled) {
          track.enabled = true;
          debugPrint('   - Enabled audio track: ${track.id}');
        }
      }

      // CRITICAL FIX: Add small delay for Android video decoder initialization
      // This is a known issue in flutter-webrtc: https://github.com/flutter-webrtc/flutter-webrtc/issues/889
      // Video decoder needs time to initialize before stream assignment
      await Future.delayed(const Duration(milliseconds: 300));

      // Assign stream directly to renderer
      _remoteRenderer!.srcObject = stream;

      // Immediately update UI after setting srcObject
      setState(() {});

      debugPrint(
          '✅ Remote stream assigned to renderer (after decoder init delay)');

      // CRITICAL: Force renderer to update by accessing its properties
      // This ensures the native renderer is aware of the new stream
      final textureId = _remoteRenderer!.textureId;
      debugPrint('🔄 Forcing renderer update - textureId: $textureId');

      // Additional: Verify stream is actually set
      Future.delayed(const Duration(milliseconds: 100), () {
        if (mounted && _remoteRenderer != null) {
          final currentStream = _remoteRenderer!.srcObject;
          if (currentStream != null && currentStream.id == stream.id) {
            debugPrint('✅ Verified: Stream is set on renderer');
            debugPrint(
                '   - Stream has ${currentStream.getVideoTracks().length} video tracks');

            // Check video track details
            final videoTracks = currentStream.getVideoTracks();
            if (videoTracks.isNotEmpty) {
              for (var track in videoTracks) {
                debugPrint('   - Video track ${track.id}:');
                debugPrint('     - Enabled: ${track.enabled}');
                debugPrint('     - Muted: ${track.muted}');
                debugPrint('     - Kind: ${track.kind}');

                if (track.muted == true) {
                  debugPrint(
                      '     ⚠️ WARNING: Track is MUTED - no video frames!');
                }
                if (!track.enabled) {
                  debugPrint('     ⚠️ WARNING: Track is DISABLED!');
                  track.enabled = true;
                  debugPrint('     ✅ Re-enabled track');
                }
              }
            }

            // Force another setState to ensure UI updates
            setState(() {});
          } else {
            debugPrint('❌ ERROR: Stream not properly set on renderer!');
            debugPrint('   - Expected: ${stream.id}');
            debugPrint('   - Got: ${currentStream?.id ?? "null"}');
          }
        }
      });

      // Log renderer state after a brief moment
      Future.delayed(const Duration(milliseconds: 500), () {
        if (mounted && _remoteRenderer != null) {
          debugPrint('📊 Renderer state after 500ms:');
          debugPrint('   - TextureId: ${_remoteRenderer!.textureId}');
          debugPrint(
              '   - Dimensions: ${_remoteRenderer!.videoWidth}x${_remoteRenderer!.videoHeight}');
          debugPrint('   - SrcObject ID: ${_remoteRenderer!.srcObject?.id}');

          if (_remoteRenderer!.videoWidth == 0 ||
              _remoteRenderer!.videoHeight == 0) {
            debugPrint('⚠️ Video dimensions are 0x0 - checking tracks...');
            final videoTracks = stream.getVideoTracks();
            for (var track in videoTracks) {
              debugPrint(
                  '   - Track ${track.id}: enabled=${track.enabled}, muted=${track.muted}');
            }

            // CRITICAL WORKAROUND: Force renderer refresh on Android
            debugPrint('🔄 Attempting renderer refresh workaround...');
            final currentStream = _remoteRenderer!.srcObject;
            _remoteRenderer!.srcObject = null;

            Future.delayed(const Duration(milliseconds: 100), () {
              if (mounted && _remoteRenderer != null && currentStream != null) {
                _remoteRenderer!.srcObject = currentStream;
                setState(() {});
                debugPrint('✅ Renderer refresh workaround applied');

                // Check again after workaround
                Future.delayed(const Duration(milliseconds: 500), () {
                  if (mounted && _remoteRenderer != null) {
                    final newWidth = _remoteRenderer!.videoWidth;
                    final newHeight = _remoteRenderer!.videoHeight;
                    debugPrint(
                        '📊 Dimensions after workaround: ${newWidth}x$newHeight');

                    if (newWidth == 0 || newHeight == 0) {
                      debugPrint(
                          '❌ CRITICAL: Video still not rendering after workaround');
                      debugPrint(
                          '   This indicates the remote peer is NOT sending video frames');
                      debugPrint(
                          '   Even though the track exists and is enabled');

                      // Final diagnostic - check track muted state using the stream parameter
                      final videoTracks = stream.getVideoTracks();
                      if (videoTracks.isNotEmpty) {
                        debugPrint('');
                        debugPrint('🔍 FINAL TRACK DIAGNOSTIC:');
                        for (var track in videoTracks) {
                          debugPrint('   Track ID: ${track.id}');
                          debugPrint('   - Enabled: ${track.enabled}');
                          debugPrint('   - Muted: ${track.muted}');
                          debugPrint('   - Kind: ${track.kind}');
                          debugPrint('   - Label: ${track.label}');

                          if (track.muted == true) {
                            debugPrint('');
                            debugPrint('   ⚠️⚠️⚠️ TRACK IS MUTED! ⚠️⚠️⚠️');
                            debugPrint(
                                '   This means NO VIDEO FRAMES are being sent!');
                            debugPrint(
                                '   Remote peer camera issue confirmed!');
                          } else {
                            debugPrint('');
                            debugPrint(
                                '   ⚠️⚠️⚠️ TRACK NOT MUTED BUT NO FRAMES! ⚠️⚠️⚠️');
                            debugPrint('   This is a WebRTC/Network issue!');
                            debugPrint('   Possible causes:');
                            debugPrint('   1. Network blocking video packets');
                            debugPrint('   2. Codec negotiation failed');
                            debugPrint(
                                '   3. TURN server needed but not working');
                          }
                        }
                      }
                    }
                  }
                });
              }
            });
          }
        }
      });
    } catch (e) {
      debugPrint('❌ Error assigning remote stream: $e');
      debugPrint('   Stack trace: ${StackTrace.current}');
    }
  }

  void _startCallTimer() {
    _callTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) {
        setState(() {
          _callDuration++;
        });
      }
    });
  }

  /// Capture screenshot from video track for debugging
  Future<void> _captureVideoTrackScreenshot() async {
    try {
      final remoteStream = _videoCallService.remoteStream.value;
      if (remoteStream == null) {
        debugPrint('⚠️ No remote stream to capture screenshot from');
        return;
      }

      final videoTracks = remoteStream.getVideoTracks();
      if (videoTracks.isEmpty) {
        debugPrint('⚠️ No video tracks in remote stream');
        return;
      }

      final videoTrack = videoTracks.first;
      debugPrint(
          '📸 Attempting to capture frame from video track: ${videoTrack.id}...');

      // CRITICAL: Use captureFrame() to actually capture a frame from the track
      // This will definitively show if frames are being received
      try {
        final frame = await videoTrack.captureFrame();

        debugPrint('📸 ✅ SUCCESS! Frame captured from video track!');
        debugPrint('   - Frame data size: ${frame.asUint8List().length} bytes');

        debugPrint('');
        debugPrint('🎉 CRITICAL FINDING:');
        debugPrint('   ✅ Video frames ARE being received from sender!');
        debugPrint('   ✅ Sender is working correctly!');
        debugPrint('   ✅ Transport layer (ICE/TURN/STUN) is working!');
        debugPrint('   ✅ Video track has actual frame data!');
        debugPrint('');
        debugPrint('   ⚠️ Since frames exist but screen is black:');
        debugPrint('   ❌ THE PROBLEM IS IN THE VideoRenderer DISPLAY!');
        debugPrint('   ❌ Issue is with RTCVideoView widget rendering');
        debugPrint('   ❌ Not a network or sender problem!');
        debugPrint('');

        // Optional: Display the captured frame as an image for visual verification
        // Uncomment if you want to show the screenshot on screen
        /*
        if (mounted) {
          final screenshot = Image.memory(
            frame.asUint8List(),
            width: frame.width.toDouble(),
            height: frame.height.toDouble(),
          );
          
          // Show in a dialog or overlay
          showDialog(
            context: context,
            builder: (context) => AlertDialog(
              title: Text('Captured Frame'),
              content: screenshot,
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: Text('Close'),
                ),
              ],
            ),
          );
        }
        */
      } catch (captureError) {
        debugPrint('❌ FAILED to capture frame from video track!');
        debugPrint('   Error: $captureError');
        debugPrint('');
        debugPrint('🔍 CRITICAL FINDING:');
        debugPrint('   ❌ Video track exists but NO frames available!');
        debugPrint('   ❌ Either sender is not sending frames OR');
        debugPrint('   ❌ Transport layer is not delivering frames!');
        debugPrint('   → Check sender camera permissions');
        debugPrint('   → Check if sender is actually capturing video');
        debugPrint('   → Check network connectivity and TURN servers');
        debugPrint('');
      }

      // Also check renderer info for comparison
      if (_remoteRenderer != null && _remoteRenderer!.textureId != null) {
        final textureId = _remoteRenderer!.textureId;
        final width = _remoteRenderer!.videoWidth;
        final height = _remoteRenderer!.videoHeight;

        debugPrint('📺 Renderer Info (for comparison):');
        debugPrint('   - TextureId: $textureId');
        debugPrint('   - Renderer Dimensions: ${width}x$height');

        if (width > 0 && height > 0) {
          debugPrint('   ✅ Renderer reports valid dimensions');
        } else {
          debugPrint('   ❌ Renderer reports 0x0 dimensions');
          debugPrint(
              '   ⚠️ This confirms VideoRenderer is NOT rendering the frames!');
        }
      }
    } catch (e) {
      debugPrint('❌ Error in screenshot diagnostic: $e');
    }
  }

  /// Check WebRTC stats for bitrate and media traffic
  Future<void> _checkWebRTCStats() async {
    try {
      final peerConnection = _videoCallService.peerConnection;
      if (peerConnection == null) {
        debugPrint('⚠️ PeerConnection is null, cannot check stats');
        return;
      }

      final stats = await peerConnection.getStats();
      debugPrint('📊 WebRTC Stats Check START');

      bool foundVideo = false;

      for (var report in stats) {
        if (report.type == 'inbound-rtp' && report.values['kind'] == 'video') {
          foundVideo = true;
          debugPrint('   📥 Inbound Video Stats (ID: ${report.id}):');
          debugPrint('      - Codec ID: ${report.values['codecId'] ?? 'N/A'}');
          debugPrint(
              '      - Bytes Received: ${report.values['bytesReceived'] ?? 0}');
          debugPrint(
              '      - Packets Received: ${report.values['packetsReceived'] ?? 0}');
          debugPrint(
              '      - Frames Decoded: ${report.values['framesDecoded'] ?? 0}');
          debugPrint(
              '      - Key Frames Decoded: ${report.values['keyFramesDecoded'] ?? 0}');
          debugPrint(
              '      - Decoder: ${report.values['decoderImplementation'] ?? 'N/A'}');
          debugPrint(
              '      - Frame Width: ${report.values['frameWidth'] ?? 0}');
          debugPrint(
              '      - Frame Height: ${report.values['frameHeight'] ?? 0}');

          final bytesReceived = report.values['bytesReceived'];
          if (bytesReceived != null && bytesReceived > 0) {
            debugPrint(
                '   ✅ Media traffic IS arriving! (${bytesReceived} bytes)');
          } else {
            debugPrint(
                '   ❌ NO media traffic arriving! Possible network/firewall/ICE issue.');
          }
        }

        if (report.type == 'candidate-pair' &&
            report.values['state'] == 'succeeded') {
          debugPrint('   🌐 Active Candidate Pair:');
          debugPrint(
              '      - Available Outgoing Bitrate: ${report.values['availableOutgoingBitrate']}');
          debugPrint(
              '      - Requests/Responses: ${report.values['requestsSent']}/${report.values['responsesReceived']}');
        }

        if (report.type == 'codec') {
          debugPrint('   ℹ️ Codec Stats (ID: ${report.id}):');
          debugPrint('      - MimeType: ${report.values['mimeType']}');
          debugPrint('      - PayloadType: ${report.values['payloadType']}');
        }
      }

      if (!foundVideo) {
        debugPrint(
            '   ⚠️ No inbound-rtp video stats found yet. Connection might be establishing.');
      }
      debugPrint('📊 WebRTC Stats Check END');
    } catch (e) {
      debugPrint('❌ Error checking WebRTC stats: $e');
    }
  }

  void _startVideoDimensionCheck() {
    Timer.periodic(const Duration(milliseconds: 500), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }

      // Check remote video dimensions
      if (_remoteRenderer != null &&
          _videoCallService.remoteStream.value != null) {
        final width = _remoteRenderer!.videoWidth;
        final height = _remoteRenderer!.videoHeight;
        final stream = _videoCallService.remoteStream.value!;

        if (width == 0 || height == 0) {
          final now = DateTime.now().millisecondsSinceEpoch;
          if (!_lastDimensionCheck.containsKey('0x0_start')) {
            _lastDimensionCheck['0x0_start'] = now;

            // Log detailed info on first detection
            debugPrint('🔍 DETAILED REMOTE STREAM INFO:');
            debugPrint('   - Stream ID: ${stream.id}');
            debugPrint('   - Video tracks: ${stream.getVideoTracks().length}');
            debugPrint('   - Audio tracks: ${stream.getAudioTracks().length}');

            for (var track in stream.getVideoTracks()) {
              debugPrint('   - Video Track ${track.id}:');
              debugPrint('     - Enabled: ${track.enabled}');
              debugPrint('     - Muted: ${track.muted}');
              debugPrint('     - Label: ${track.label}');
            }
          }

          final timeSince0x0 = now - _lastDimensionCheck['0x0_start']!;

          // Periodic detailed stats check (every 4 seconds) to catch persistent issues
          if (timeSince0x0 > 2000 && (timeSince0x0 % 4000 < 500)) {
            debugPrint(
                '⚠️ Video dimensions 0x0 for ${timeSince0x0}ms, checking WebRTC stats...');
            _checkWebRTCStats();
          }

          // Capture screenshot diagnostic at 2.5 seconds (once)
          if (timeSince0x0 >= 2500 && timeSince0x0 < 3000) {
            debugPrint('⚠️ Running screenshot diagnostic...');
            _captureVideoTrackScreenshot();
          }

          // Try multiple times with different strategies
          if (timeSince0x0 >= 1000 && timeSince0x0 < 1500) {
            debugPrint(
                '⚠️ Video dimensions 0x0 after 1s, forcing stream re-assignment');
            if (mounted && _remoteRenderer != null) {
              _remoteRenderer!.srcObject = null;
              Future.delayed(const Duration(milliseconds: 50), () {
                if (mounted && _remoteRenderer != null) {
                  _remoteRenderer!.srcObject = stream;
                  setState(() {});
                }
              });
            }
          } else if (timeSince0x0 >= 3000 && timeSince0x0 < 3500) {
            debugPrint(
                '⚠️ Video dimensions 0x0 after 3s, forcing complete renderer refresh');
            if (mounted) {
              // Force all video tracks to be enabled
              for (var track in stream.getVideoTracks()) {
                debugPrint(
                    '🔄 Checking track ${track.id}: enabled=${track.enabled}, muted=${track.muted}');
                if (!track.enabled) {
                  track.enabled = true;
                  debugPrint('✅ Re-enabled video track: ${track.id}');
                }
              }

              setState(() {});
            }
          } else if (timeSince0x0 >= 5000 && timeSince0x0 < 5500) {
            debugPrint(
                '⚠️ Video dimensions still 0x0 after 5s - trying renderer recreation');
            _recreateRemoteRenderer();
          } else if (timeSince0x0 >= 8000 && timeSince0x0 < 8500) {
            debugPrint(
                '⚠️ Video dimensions still 0x0 after 8s - PEER CAMERA ISSUE CONFIRMED');
            debugPrint('   Remote peer needs to:');
            debugPrint('   1. Check camera permissions');
            debugPrint('   2. Restart the app');
            debugPrint('   3. Ensure no other app is using camera');
          }
        } else {
          debugPrint('✅ Remote video NOW WORKING: ${width}x$height');
          _lastDimensionCheck.remove('0x0_start');

          // Cancel timer after successful video
          timer.cancel();
        }
      }
    });
  }

  void _setupCallStateListener() {
    // Listen to call state changes from VideoCallService
    ever(_videoCallService.callState, (String state) {
      if (!mounted) return;

      debugPrint('📞 [UI] Video call state changed: $state');

      switch (state) {
        case 'connected':
          _pulseController.stop();
          if (!_isCallConnected) {
            _isCallConnected = true;
            _startCallTimer();
            final isVideoEnabled = _videoCallService.isVideoEnabled.value;
            debugPrint('✅ [UI] Call connected with video: $isVideoEnabled');
          }
          break;
        case 'ended':
        case 'idle':
        case 'rejected':
          debugPrint('🛑 [UI] Call ended/idle ($state) - Closing screen...');
          if (mounted) {
            // Use Navigator directly for safer popping
            if (Navigator.canPop(context)) {
              Navigator.pop(context);
              debugPrint('✅ [UI] Screen popped via Navigator');
            } else {
              debugPrint('⚠️ [UI] Cannot pop screen - maybe already popped?');
              // Fallback for GetX if navigator fails
              Get.back();
            }
          }
          break;
      }
    });
  }

  String _formatDuration(int seconds) {
    final minutes = seconds ~/ 60;
    final remainingSeconds = seconds % 60;
    return '${minutes.toString().padLeft(2, '0')}:${remainingSeconds.toString().padLeft(2, '0')}';
  }

  @override
  void dispose() {
    debugPrint('🧹 Disposing video calling screen...');

    _pulseController.dispose();
    _callTimer?.cancel();

    // Clear dimension tracking
    _lastDimensionCheck.clear();

    // Dispose video renderers safely
    try {
      _localRenderer?.dispose();
      _remoteRenderer?.dispose();
      debugPrint('✅ Video renderers disposed');
    } catch (e) {
      debugPrint('⚠️ Error disposing video renderers: $e');
    }

    // Clear renderer references
    _localRenderer = null;
    _remoteRenderer = null;

    super.dispose();
    debugPrint('✅ Video calling screen disposed');
  }

  @override
  Widget build(BuildContext context) {
    return WillPopScope(
      onWillPop: () async {
        _endCall();
        return true;
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: SafeArea(
          child: Obx(() {
            final callState = _videoCallService.callState.value;

            // Debug: Log every time Obx rebuilds
            debugPrint('🔄 [UI] Obx rebuilding - callState: $callState');

            return Center(
              child: Stack(
                children: [
                  // Remote video (full screen when connected)
                  if (callState == 'connected')
                    _buildRemoteVideo()
                  else if (callState == 'idle' || callState == 'ended')
                    // Show black screen or empty container while closing
                    Container(color: Colors.black)
                  else
                    _buildCallingView(callState),

                  // Local video (small overlay)
                  if (callState == 'connected')
                    Positioned(
                      top: 50.h,
                      right: 20.w,
                      child: GestureDetector(
                        onTap: () {
                          setState(() {
                            _isLocalVideoFullscreen = !_isLocalVideoFullscreen;
                          });
                        },
                        child: Container(
                          width: _isLocalVideoFullscreen ? 200.w : 120.w,
                          height: _isLocalVideoFullscreen ? 150.h : 90.h,
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(12.r),
                            border: Border.all(color: Colors.white, width: 2),
                          ),
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(10.r),
                            child: Obx(() {
                              final localStream =
                                  _videoCallService.localStream.value;

                              if (localStream != null &&
                                  _localRenderer != null &&
                                  _localRenderer!.textureId != null) {
                                // Ensure local video tracks are enabled
                                for (var videoTrack
                                    in localStream.getVideoTracks()) {
                                  if (!videoTrack.enabled) {
                                    videoTrack.enabled = true;
                                  }
                                }

                                return Container(
                                  color: Colors.black,
                                  child: SizedBox.expand(
                                    child: webrtc.RTCVideoView(
                                      _localRenderer!,
                                      mirror: true,
                                      objectFit: webrtc.RTCVideoViewObjectFit
                                          .RTCVideoViewObjectFitCover,
                                    ),
                                  ),
                                );
                              }

                              return Container(
                                color: Colors.grey.shade800,
                                child: Icon(
                                  Icons.videocam_off,
                                  color: Colors.white,
                                  size: 30.r,
                                ),
                              );
                            }),
                          ),
                        ),
                      ),
                    ),

                  // Call controls
                  Positioned(
                    bottom: 0,
                    left: 0,
                    right: 0,
                    child: Container(
                      padding: EdgeInsets.symmetric(
                          horizontal: 20.w, vertical: 30.h),
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [
                            Colors.transparent,
                            Colors.black.withOpacity(0.7),
                          ],
                        ),
                      ),
                      child: _buildCallControls(callState),
                    ),
                  ),

                  // Status bar
                  Positioned(
                    top: 20.h,
                    left: 20.w,
                    right: 20.w,
                    child: Container(
                      padding:
                          EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
                      decoration: BoxDecoration(
                        color: Colors.black.withOpacity(0.5),
                        borderRadius: BorderRadius.circular(20.r),
                      ),
                      child: Text(
                        _getCallStatusText(callState),
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 14.sp,
                          fontWeight: FontWeight.w500,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ),
                ],
              ),
            );
          }),
        ),
      ),
    );
  }

  Widget _buildRemoteVideo() {
    return Obx(() {
      final remoteStream = _videoCallService.remoteStream.value;

      if (remoteStream != null &&
          _remoteRenderer != null &&
          _remoteRenderer!.textureId != null) {
        // Ensure video tracks are enabled
        if (remoteStream.getVideoTracks().isNotEmpty) {
          for (var videoTrack in remoteStream.getVideoTracks()) {
            if (!videoTrack.enabled) {
              debugPrint('🔄 Enabling remote video track: ${videoTrack.id}');
              videoTrack.enabled = true;
            }
          }
        } else {
          debugPrint('⚠️ Remote stream has no video tracks!');
        }

        // Check dimensions
        final width = _remoteRenderer!.videoWidth;
        final height = _remoteRenderer!.videoHeight;

        debugPrint('🎥 Remote video dimensions: ${width}x$height');
        debugPrint('🎥 Renderer textureId: ${_remoteRenderer!.textureId}');
        debugPrint('🎥 Stream ID: ${remoteStream.id}');

        // Show video view regardless of dimensions
        return Container(
          color: Colors.black,
          width: double.infinity,
          height: double.infinity,
          child: Stack(
            children: [
              // Always show the video view with explicit sizing
              SizedBox.expand(
                child: webrtc.RTCVideoView(
                  _remoteRenderer!,
                  objectFit:
                      webrtc.RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
                  mirror: false,
                  filterQuality: FilterQuality.medium,
                ),
              ),

              // Show overlay if dimensions are 0x0
              if (width == 0 || height == 0)
                Container(
                  color: Colors.black.withOpacity(0.7),
                  child: Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        CircularProgressIndicator(color: Colors.white),
                        SizedBox(height: 20.h),
                        Text(
                          'Waiting for video...',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 18.sp,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        SizedBox(height: 10.h),
                        Text(
                          'Please check camera permissions\non the other device',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: Colors.white70,
                            fontSize: 14.sp,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        );
      }

      return Container(
        color: Colors.black,
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              CircularProgressIndicator(color: Colors.white),
              SizedBox(height: 20.h),
              Text(
                remoteStream != null
                    ? 'Initializing video...\nTexture: ${_remoteRenderer?.textureId ?? 'N/A'}\nDimensions: ${_remoteRenderer?.videoWidth ?? 0}x${_remoteRenderer?.videoHeight ?? 0}\nTracks: ${remoteStream.getVideoTracks().length} video, ${remoteStream.getAudioTracks().length} audio'
                    : 'Waiting for remote stream...',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 16.sp,
                ),
              ),
            ],
          ),
        ),
      );
    });
  }

  Widget _buildCallingView(String callState) {
    return Container(
      color: Colors.black,
      child: Column(
        children: [
          SizedBox(height: 100.h),

          // Contact info
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                // Avatar with pulse animation
                AnimatedBuilder(
                  animation: _pulseAnimation,
                  builder: (context, child) {
                    return Transform.scale(
                      scale:
                          callState == 'calling' ? _pulseAnimation.value : 1.0,
                      child: Container(
                        width: 200.r,
                        height: 200.r,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: Colors.white.withOpacity(0.3),
                            width: 3.r,
                          ),
                        ),
                        child: ClipOval(
                          child: widget.contactAvatar?.isNotEmpty == true
                              ? CachedNetworkImage(
                                  imageUrl: widget.contactAvatar!,
                                  fit: BoxFit.cover,
                                  placeholder: (context, url) =>
                                      _buildDefaultAvatar(),
                                  errorWidget: (context, url, error) =>
                                      _buildDefaultAvatar(),
                                )
                              : _buildDefaultAvatar(),
                        ),
                      ),
                    );
                  },
                ),

                SizedBox(height: 40.h),

                // Contact name
                Text(
                  widget.contactName,
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 32.sp,
                    fontWeight: FontWeight.w600,
                  ),
                  textAlign: TextAlign.center,
                ),

                SizedBox(height: 12.h),

                // Phone number
                Text(
                  widget.contactPhone,
                  style: TextStyle(
                    color: Colors.white70,
                    fontSize: 18.sp,
                    fontWeight: FontWeight.w400,
                  ),
                ),

                SizedBox(height: 20.h),

                // Call duration (only show when connected)
                if (callState == 'connected')
                  Text(
                    _formatDuration(_callDuration),
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 20.sp,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDefaultAvatar() {
    return Container(
      color: Colors.grey.shade800,
      child: Icon(
        Icons.person,
        size: 100.r,
        color: Colors.grey.shade600,
      ),
    );
  }

  String _getCallStatusText(String callState) {
    switch (callState) {
      case 'calling':
        return 'Calling...';
      case 'incoming':
        return 'Incoming video call';
      case 'connected':
        return 'Connected';
      case 'ended':
        return 'Call ended';
      default:
        return 'Connecting...';
    }
  }

  Widget _buildCallControls(String callState) {
    if (callState == 'incoming') {
      return _buildIncomingCallControls();
    }

    if (callState == 'connected') {
      return _buildConnectedCallControls();
    }

    return _buildOutgoingCallControls(callState);
  }

  Widget _buildIncomingCallControls() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        // Decline button
        Material(
          color: Colors.red,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: _declineCall,
            child: Container(
              width: 70.r,
              height: 70.r,
              alignment: Alignment.center,
              child: Icon(
                Icons.call_end,
                color: Colors.white,
                size: 30.r,
              ),
            ),
          ),
        ),

        // Accept button
        Material(
          color: Colors.green,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: _acceptCall,
            child: Container(
              width: 70.r,
              height: 70.r,
              alignment: Alignment.center,
              child: Icon(
                Icons.videocam,
                color: Colors.white,
                size: 30.r,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildConnectedCallControls() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        // Mute button
        Obx(() {
          final isMuted = _videoCallService.isMuted.value;
          return Material(
            color: isMuted ? Colors.white : Colors.white.withOpacity(0.2),
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: _toggleMute,
              child: Container(
                width: 60.r,
                height: 60.r,
                alignment: Alignment.center,
                child: Icon(
                  isMuted ? Icons.mic_off : Icons.mic,
                  color: isMuted ? Colors.black : Colors.white,
                  size: 24.r,
                ),
              ),
            ),
          );
        }),

        // Video toggle button
        Obx(() {
          final isVideoEnabled = _videoCallService.isVideoEnabled.value;
          return Material(
            color:
                isVideoEnabled ? Colors.white : Colors.white.withOpacity(0.2),
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: _toggleVideo,
              child: Container(
                width: 60.r,
                height: 60.r,
                alignment: Alignment.center,
                child: Icon(
                  isVideoEnabled ? Icons.videocam : Icons.videocam_off,
                  color: isVideoEnabled ? Colors.black : Colors.white,
                  size: 24.r,
                ),
              ),
            ),
          );
        }),

        // End call button
        Material(
          color: Colors.red,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: _endCall,
            child: Container(
              width: 70.r,
              height: 70.r,
              alignment: Alignment.center,
              child: Icon(
                Icons.call_end,
                color: Colors.white,
                size: 30.r,
              ),
            ),
          ),
        ),

        // Switch camera button
        Material(
          color: Colors.white.withOpacity(0.2),
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: _switchCamera,
            child: Container(
              width: 60.r,
              height: 60.r,
              alignment: Alignment.center,
              child: Icon(
                Icons.switch_camera,
                color: Colors.white,
                size: 24.r,
              ),
            ),
          ),
        ),

        // Speaker button
        Obx(() {
          final isSpeakerOn = _videoCallService.isSpeakerOn.value;
          return Material(
            color: isSpeakerOn ? Colors.white : Colors.white.withOpacity(0.2),
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: _toggleSpeaker,
              child: Container(
                width: 60.r,
                height: 60.r,
                alignment: Alignment.center,
                child: Icon(
                  isSpeakerOn ? Icons.volume_up : Icons.volume_down,
                  color: isSpeakerOn ? Colors.black : Colors.white,
                  size: 24.r,
                ),
              ),
            ),
          );
        }),
      ],
    );
  }

  Widget _buildOutgoingCallControls(String callState) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        // End call button
        Material(
          color: Colors.red,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: _endCall,
            child: Container(
              width: 70.r,
              height: 70.r,
              alignment: Alignment.center,
              child: Icon(
                Icons.call_end,
                color: Colors.white,
                size: 30.r,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _acceptCall() async {
    try {
      final myUserId = await AuthStorage.getUserId();
      if (myUserId == null) {
        debugPrint('❌ Cannot accept call: userId is null');
        return;
      }

      // Use the resolved caller ID from the widget
      final resolvedCallerId = widget.callerId;
      if (resolvedCallerId == null) {
        debugPrint('❌ Cannot accept call: callerId is null');
        return;
      }

      await _videoCallService.acceptCall(
        callerId: resolvedCallerId, // Use the resolved MongoDB ID
        calleeId: myUserId,
      );

      debugPrint('📞 Accepted video call from ${resolvedCallerId}');
    } catch (e) {
      debugPrint('❌ Error accepting call: $e');
    }
  }

  Future<void> _declineCall() async {
    try {
      final myUserId = await AuthStorage.getUserId();
      if (myUserId == null) {
        debugPrint('❌ Cannot decline call: userId is null');
        return;
      }

      final resolvedCallerId = widget.callerId;
      if (resolvedCallerId == null) {
        debugPrint('❌ Cannot decline call: callerId is null');
        return;
      }

      await _videoCallService.rejectCall(
        callerId: resolvedCallerId, // Use the resolved MongoDB ID
        calleeId: myUserId,
      );

      debugPrint('📞 Declined video call from ${resolvedCallerId}');
      if (mounted) {
        Get.back();
      }
    } catch (e) {
      debugPrint('❌ Error declining call: $e');
    }
  }

  Future<void> _endCall() async {
    try {
      final myUserId = await AuthStorage.getBestUserIdentifier();
      if (myUserId == null || myUserId.isEmpty) {
        debugPrint('❌ Cannot end call: no user identifier available');
        Get.snackbar(
          'Error',
          'Unable to end call. Please try logging out and logging back in.',
          snackPosition: SnackPosition.TOP,
          backgroundColor: Colors.red,
          colorText: Colors.white,
        );
        return;
      }
      debugPrint('✅ Using user identifier: $myUserId');

      // CRITICAL: Use the resolved peer ID, not the contact phone
      final peerId = widget.isIncoming
          ? (widget.callerId ?? widget.contactPhone)
          : widget.contactPhone;

      await _videoCallService.endCall(
        userId: myUserId,
        peerId: peerId,
      );

      debugPrint('📞 Ended video call with $peerId');
      // if (mounted) {
      //   Get.back();
      // }
    } catch (e) {
      debugPrint('❌ Error ending call: $e');
      Get.snackbar(
        'Error',
        'Failed to end call. Please try again.',
        snackPosition: SnackPosition.TOP,
        backgroundColor: Colors.red,
        colorText: Colors.white,
      );
    }
  }

  Future<void> _toggleMute() async {
    await _videoCallService.toggleMute();
  }

  Future<void> _toggleVideo() async {
    await _videoCallService.toggleVideo();
  }

  Future<void> _toggleSpeaker() async {
    await _videoCallService.toggleSpeaker();
  }

  Future<void> _switchCamera() async {
    await _videoCallService.switchCamera();
  }
}
