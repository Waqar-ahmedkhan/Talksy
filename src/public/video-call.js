const loginScreen = document.getElementById('loginScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const callScreen = document.getElementById('callScreen');

const userIdInput = document.getElementById('userIdInput');
const loginBtn = document.getElementById('loginBtn');
const quickUserA = document.getElementById('quickUserA');
const quickUserB = document.getElementById('quickUserB');
const refreshBtn = document.getElementById('refreshBtn');
const calleeIdInput = document.getElementById('calleeIdInput');
const startCallBtn = document.getElementById('startCallBtn');
const directTestCallBtn = document.getElementById('directTestCallBtn');
const endCallBtn = document.getElementById('endCallBtn');
const endCallBtnCall = document.getElementById('endCallBtnCall');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const incomingCallBox = document.getElementById('incomingCallBox');
const incomingCaller = document.getElementById('incomingCaller');
const onlineList = document.getElementById('onlineList');
const statusText = document.getElementById('statusText');
const callStatus = document.getElementById('callStatus');
const cameraSelect = document.getElementById('cameraSelect');
const micSelect = document.getElementById('micSelect');
const startPreviewBtn = document.getElementById('startPreviewBtn');
const stopPreviewBtn = document.getElementById('stopPreviewBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const previewVideo = document.getElementById('previewVideo');
const previewStatus = document.getElementById('previewStatus');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remoteLabel = document.getElementById('remoteLabel');
const diagSignaling = document.getElementById('diagSignaling');
const diagIce = document.getElementById('diagIce');
const diagConnection = document.getElementById('diagConnection');
const diagGathering = document.getElementById('diagGathering');
const diagCandidates = document.getElementById('diagCandidates');
const diagRemoteTracks = document.getElementById('diagRemoteTracks');

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
};

const updateRtcConfig = (newIceServers) => {
  if (Array.isArray(newIceServers) && newIceServers.length > 0) {
    rtcConfig.iceServers = newIceServers;
    console.log('[RTC_CONFIG] Updated ICE servers:', rtcConfig.iceServers);
  }
};

let socket = null;
let userId = null;
let onlineUsers = [];
let peerConnection = null;
let localStream = null;
let previewStream = null;
let peerSignalId = null;
let incomingOffer = null;
let incomingDisplay = null;
let isMicMuted = false;
let isCamDisabled = false;
let previewDeviceIds = { videoId: '', audioId: '' };
let candidateCount = 0;
let remoteTrackCount = 0;

const setScreen = (screen) => {
  loginScreen.classList.toggle('is-active', screen === 'login');
  lobbyScreen.classList.toggle('is-active', screen === 'lobby');
  callScreen.classList.toggle('is-active', screen === 'call');
};

const updateStatus = (text, color) => {
  statusText.textContent = text;
  statusText.style.color = color;
};

const updateCallStatus = (text) => {
  callStatus.textContent = text;
};

const resetDiagnostics = () => {
  candidateCount = 0;
  remoteTrackCount = 0;
  if (diagSignaling) diagSignaling.textContent = '-';
  if (diagIce) diagIce.textContent = '-';
  if (diagConnection) diagConnection.textContent = '-';
  if (diagGathering) diagGathering.textContent = '-';
  if (diagCandidates) diagCandidates.textContent = '0';
  if (diagRemoteTracks) diagRemoteTracks.textContent = '0';
};

const updatePreviewStatus = (text) => {
  previewStatus.textContent = text;
};

const setPreviewControls = (active) => {
  stopPreviewBtn.disabled = !active;
  toggleMicBtn.disabled = !active;
  toggleCamBtn.disabled = !active;
  startPreviewBtn.disabled = active;
};

const resetCallState = (sendEnd = false) => {
  if (sendEnd && peerSignalId) {
    socket?.emit('end_call', { userId, peerId: peerSignalId });
  }

  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
    peerConnection = null;
  }

  const sharedPreview = previewStream && localStream && previewStream === localStream;
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (sharedPreview) {
    stopPreview();
  }

  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  peerSignalId = null;
  incomingOffer = null;
  incomingDisplay = null;
  remoteLabel.textContent = 'Remote';

  endCallBtn.disabled = true;
  endCallBtnCall.disabled = true;
  updateCallStatus('Idle');
  incomingCallBox.classList.remove('is-active');

  setScreen('lobby');
  resetDiagnostics();
};

const stopPreview = () => {
  if (previewStream) {
    previewStream.getTracks().forEach((track) => track.stop());
    previewStream = null;
  }
  previewVideo.srcObject = null;
  updatePreviewStatus('No local media');
  setPreviewControls(false);
  isMicMuted = false;
  isCamDisabled = false;
  toggleMicBtn.textContent = 'Mute Mic';
  toggleCamBtn.textContent = 'Disable Cam';
  previewDeviceIds = { videoId: '', audioId: '' };
};

const populateDeviceOptions = async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((device) => device.kind === 'videoinput');
  const audioInputs = devices.filter((device) => device.kind === 'audioinput');

  cameraSelect.innerHTML = '';
  micSelect.innerHTML = '';

  videoInputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Camera ${index + 1}`;
    cameraSelect.appendChild(option);
  });

  audioInputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    micSelect.appendChild(option);
  });
};

const startPreviewWithSelection = async () => {
  const videoId = cameraSelect.value;
  const audioId = micSelect.value;

  if (previewStream) {
    previewStream.getTracks().forEach((track) => track.stop());
  }

  previewStream = await navigator.mediaDevices.getUserMedia({
    video: videoId ? { deviceId: { exact: videoId } } : true,
    audio: audioId ? { deviceId: { exact: audioId } } : true,
  });
  previewDeviceIds = { videoId, audioId };
  previewVideo.srcObject = previewStream;
  updatePreviewStatus('Previewing');
  setPreviewControls(true);
};

const renderOnlineUsers = () => {
  onlineList.innerHTML = '';
  onlineUsers.forEach((id) => {
    const item = document.createElement('li');
    item.textContent = id;
    item.addEventListener('click', () => {
      calleeIdInput.value = id;
    });
    onlineList.appendChild(item);
  });
};

const setupPeerConnection = () => {
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.ontrack = (event) => {
    remoteTrackCount += event.streams[0]?.getTracks().length || 1;
    if (diagRemoteTracks) {
      diagRemoteTracks.textContent = String(remoteTrackCount);
    }
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && peerSignalId) {
      candidateCount += 1;
      if (diagCandidates) {
        diagCandidates.textContent = String(candidateCount);
      }
      socket.emit('ice_candidate', {
        candidate: event.candidate,
        toUserId: peerSignalId,
      });
    }
  };

  peerConnection.onsignalingstatechange = () => {
    if (diagSignaling) {
      diagSignaling.textContent = peerConnection.signalingState;
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (diagIce) {
      diagIce.textContent = peerConnection.iceConnectionState;
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (diagConnection) {
      diagConnection.textContent = peerConnection.connectionState;
    }
  };

  peerConnection.onicegatheringstatechange = () => {
    if (diagGathering) {
      diagGathering.textContent = peerConnection.iceGatheringState;
    }
  };
};

const startLocalMedia = async (targetVideo, reusePreview) => {
  if (reusePreview && previewStream) {
    localStream = previewStream;
  } else {
    const videoId = cameraSelect.value;
    const audioId = micSelect.value;
    localStream = await navigator.mediaDevices.getUserMedia({
      video: videoId ? { deviceId: { exact: videoId } } : true,
      audio: audioId ? { deviceId: { exact: audioId } } : true,
    });
  }

  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMicMuted;
  });
  localStream.getVideoTracks().forEach((track) => {
    track.enabled = !isCamDisabled;
  });

  localVideo.srcObject = localStream;
  if (targetVideo) {
    targetVideo.srcObject = localStream;
  }
};

loginBtn.addEventListener('click', () => {
  const id = userIdInput.value.trim();
  if (!id) {
    alert('Enter a valid user id or phone.');
    return;
  }

  userId = id;
  socket = io({ path: '/video-socket' });

  socket.on('connect', () => {
    updateStatus('Online', '#12b886');
    socket.emit('join', userId);
    socket.emit('request_online_users');
  });

  socket.on('disconnect', () => {
    updateStatus('Offline', '#a82b1c');
    resetCallState(false);
  });

  socket.on('online_users', (users) => {
    onlineUsers = (users || []).filter((id) => id && id !== userId);
    renderOnlineUsers();
  });

  socket.on('incoming_call', (data) => {
    incomingOffer = data.offer;
    incomingDisplay = data.callerId || data.callerUserId || 'Unknown';
    peerSignalId = data.callerUserId || data.callerId;
    incomingCaller.textContent = incomingDisplay;
    incomingCallBox.classList.add('is-active');
    updateCallStatus('Incoming call...');
  });

  socket.on('call_accepted', async (data) => {
    try {
      peerSignalId = data.calleeUserId || data.calleeId || peerSignalId;
      remoteLabel.textContent = peerSignalId || 'Remote';
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
      updateCallStatus('Connected');
      setScreen('call');
      endCallBtn.disabled = false;
      endCallBtnCall.disabled = false;
    } catch (err) {
      console.error('Failed to set remote description', err);
      alert('Call setup failed.');
      resetCallState(true);
    }
  });

  socket.on('ice_candidate', async (data) => {
    if (!peerConnection || !data?.candidate) return;
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error('Failed to add ICE candidate', err);
    }
  });

  socket.on('call_rejected', (data) => {
    alert(`Call rejected by ${data.calleeId || 'peer'}.`);
    resetCallState(false);
  });

  socket.on('user_busy', (data) => {
    alert(`User ${data.calleeId || 'peer'} is busy.`);
    resetCallState(false);
  });

  socket.on('call_error', (data) => {
    alert(`Call error: ${data.error || 'Unknown error'}.`);
    resetCallState(false);
  });

  socket.on('call_ended', (data) => {
    const source = data.fromUserId || data.callerId || data.calleeId || 'peer';
    alert(`Call ended by ${source}.`);
    resetCallState(false);
  });

  setScreen('lobby');
  updateStatus('Online', '#12b886');
  updateCallStatus('Idle');
  stopPreview();
  resetDiagnostics();
});

quickUserA.addEventListener('click', () => {
  userIdInput.value = 'test-user-1';
});

quickUserB.addEventListener('click', () => {
  userIdInput.value = 'test-user-2';
});

refreshBtn.addEventListener('click', () => {
  socket?.emit('request_online_users');
});

startPreviewBtn.addEventListener('click', async () => {
  try {
    await startPreviewWithSelection();
    await populateDeviceOptions();
  } catch (err) {
    console.error('Failed to start preview', err);
    alert('Failed to start preview. Check camera permissions.');
  }
});

stopPreviewBtn.addEventListener('click', stopPreview);

toggleMicBtn.addEventListener('click', () => {
  if (!previewStream && !localStream) return;
  isMicMuted = !isMicMuted;
  const targetStream = localStream || previewStream;
  targetStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMicMuted;
  });
  toggleMicBtn.textContent = isMicMuted ? 'Unmute Mic' : 'Mute Mic';
});

toggleCamBtn.addEventListener('click', () => {
  if (!previewStream && !localStream) return;
  isCamDisabled = !isCamDisabled;
  const targetStream = localStream || previewStream;
  targetStream.getVideoTracks().forEach((track) => {
    track.enabled = !isCamDisabled;
  });
  toggleCamBtn.textContent = isCamDisabled ? 'Enable Cam' : 'Disable Cam';
});

cameraSelect.addEventListener('change', async () => {
  if (!previewStream) return;
  try {
    await startPreviewWithSelection();
  } catch (err) {
    console.error('Failed to switch camera', err);
  }
});

micSelect.addEventListener('change', async () => {
  if (!previewStream) return;
  try {
    await startPreviewWithSelection();
  } catch (err) {
    console.error('Failed to switch mic', err);
  }
});

startCallBtn.addEventListener('click', async () => {
  const target = calleeIdInput.value.trim();
  if (!target || target === userId) {
    alert('Enter a valid peer id or phone.');
    return;
  }

  try {
    peerSignalId = target;
    updateCallStatus('Calling...');
    resetDiagnostics();
    await startLocalMedia(localVideo, true);
    setupPeerConnection();
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('call_user', {
      callerId: userId,
      calleeId: target,
      offer: peerConnection.localDescription,
    });

    endCallBtn.disabled = false;
    endCallBtnCall.disabled = false;
    setScreen('call');
  } catch (err) {
    console.error('Failed to start call', err);
    alert('Failed to start call.');
    resetCallState(false);
  }
});

directTestCallBtn.addEventListener('click', () => {
  if (!userId) {
    alert('Login first.');
    return;
  }
  const target = userId === 'test-user-1' ? 'test-user-2' : 'test-user-1';
  calleeIdInput.value = target;
  startCallBtn.click();
});

acceptCallBtn.addEventListener('click', async () => {
  if (!incomingOffer || !peerSignalId) return;

  try {
    updateCallStatus('Connecting...');
    resetDiagnostics();
    await startLocalMedia(localVideo, true);
    setupPeerConnection();
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });

    await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingOffer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('accept_call', {
      callerId: peerSignalId,
      calleeId: userId,
      answer: peerConnection.localDescription,
    });

    incomingCallBox.classList.remove('is-active');
    remoteLabel.textContent = peerSignalId || incomingDisplay || 'Remote';
    updateCallStatus('Connected');
    endCallBtn.disabled = false;
    endCallBtnCall.disabled = false;
    setScreen('call');
  } catch (err) {
    console.error('Failed to accept call', err);
    alert('Failed to accept call.');
    resetCallState(false);
  }
});

rejectCallBtn.addEventListener('click', () => {
  if (peerSignalId) {
    socket.emit('reject_call', {
      callerId: peerSignalId,
      calleeId: userId,
    });
  }
  incomingCallBox.classList.remove('is-active');
  incomingOffer = null;
  incomingDisplay = null;
});

endCallBtn.addEventListener('click', () => resetCallState(true));
endCallBtnCall.addEventListener('click', () => resetCallState(true));

if (navigator.mediaDevices?.enumerateDevices) {
  navigator.mediaDevices
    .enumerateDevices()
    .then(populateDeviceOptions)
    .catch(() => {});
}
