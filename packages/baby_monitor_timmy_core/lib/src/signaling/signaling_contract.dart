abstract final class SignalingContract {
  static const sessionsCollection = 'sessions';
  static const candidatesBabyCollection = 'candidates_baby';
  static const candidatesParentCollection = 'candidates_parent';

  static const statusField = 'status';
  static const createdAtField = 'createdAt';
  static const updatedAtField = 'updatedAt';
  static const offerSdpField = 'offerSdp';
  static const answerSdpField = 'answerSdp';
  static const pairingDocKeyField = 'pairingDocKey';
  static const versionField = 'version';
  static const signalingClearedAtField = 'signalingClearedAt';

  /// In-session ICE-restart renegotiation round counters (optional, plaintext
  /// metadata). [iceRestartSeqField] is written only by the baby (offerer) and
  /// increments per renegotiation round; [iceRestartRequestSeqField] is written
  /// only by the parent (answerer) to request a round. Absent ⇒ treat as 0.
  static const iceRestartSeqField = 'iceRestartSeq';
  static const iceRestartRequestSeqField = 'iceRestartRequestSeq';

  /// Cross-network roam recovery (optional, plaintext). Written only by the
  /// parent on a WiFi<->cellular roam to ask the baby to recreate the session
  /// immediately (a fresh full reconnect) instead of a doomed in-session ICE
  /// restart — the relay can't be rebuilt in place across the roam. Monotonic;
  /// absent ⇒ treat as 0.
  static const recreateRequestSeqField = 'recreateRequestSeq';

  static const candidateField = 'candidate';
  static const sdpMidField = 'sdpMid';
  static const sdpMLineIndexField = 'sdpMLineIndex';
  static const timestampField = 'ts';

  static const waitingStatus = 'waiting';
  static const endedStatus = 'ended';
  static const connectedStatus = 'connected';
}
