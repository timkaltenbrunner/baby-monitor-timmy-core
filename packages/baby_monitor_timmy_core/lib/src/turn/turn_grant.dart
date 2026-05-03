import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

import '../pairing/crypto_service.dart';

/// A short-lived TURN credential bundle that the premium mobile app issues
/// to a paired Web Companion peer.
///
/// **Design contract (locked in `docs/web-app-concept.md`):**
/// - Web App Check + premium gate live on the mobile side; the web peer never
///   calls `getTurnCredentials` directly.
/// - The mobile peer fetches credentials, builds a [TurnGrant], encrypts the
///   serialized JSON with the shared `pairingKey` (AES-256-GCM via
///   [CryptoService.encrypt]) and writes the ciphertext to a separate
///   Firestore collection (`/turn_grants/{grantId}`).
/// - The web peer locates its grant via the public-but-secret-by-derivation
///   field [pairingDocKey] = `SHA-256("doc:" + pairingKey)` (the same
///   derivation already used for the session document key) and decrypts it
///   with the same `pairingKey`.
/// - Grants are short-lived ([expiresAt]), single-session-bound ([channel])
///   and replay-protected ([grantId] + [mobileNonce]).
class TurnGrant {
  /// Schema version for forward compatibility.
  static const int currentVersion = 1;

  /// Stable type discriminator written into the encrypted payload to
  /// detect mis-decoded ciphertexts early.
  static const String typeTag = 'timmy-web-turn-grant';

  TurnGrant({
    required this.grantId,
    required this.channel,
    required this.allowedRole,
    required this.iceServers,
    required this.issuedAt,
    required this.expiresAt,
    required this.mobileNonce,
    this.notBefore,
    this.providerHint,
    this.version = currentVersion,
  });

  /// Random unique grant identifier. Doubles as the Firestore document id
  /// and provides a single-use anchor.
  final String grantId;

  /// Session channel the grant is bound to (`sbm_<docKeyPrefix>`).
  final String channel;

  /// Which WebRTC role the web peer is allowed to assume.
  /// Allowed values: `baby`, `parent`, `any`.
  final String allowedRole;

  /// ICE servers (RTCIceServer.toMap()-compatible) the web peer must use.
  /// Must already include the TURN provider's username/credential.
  final List<Map<String, dynamic>> iceServers;

  final DateTime issuedAt;
  final DateTime expiresAt;
  final DateTime? notBefore;

  /// Random nonce supplied by the mobile peer; web peer SHOULD echo this
  /// in its first signaling message so the mobile can detect replays.
  final String mobileNonce;

  /// Optional provider name hint (`local`, `cloudflare`) for diagnostics.
  final String? providerHint;

  final int version;

  bool isCurrentlyValid({DateTime? now}) {
    final ts = now ?? DateTime.now();
    if (notBefore != null && ts.isBefore(notBefore!)) return false;
    return ts.isBefore(expiresAt);
  }

  Map<String, dynamic> toJson() => {
        'type': typeTag,
        'version': version,
        'grantId': grantId,
        'channel': channel,
        'allowedRole': allowedRole,
        'iceServers': iceServers,
        'issuedAt': issuedAt.toUtc().toIso8601String(),
        'expiresAt': expiresAt.toUtc().toIso8601String(),
        if (notBefore != null) 'notBefore': notBefore!.toUtc().toIso8601String(),
        'mobileNonce': mobileNonce,
        if (providerHint != null) 'providerHint': providerHint,
      };

  factory TurnGrant.fromJson(Map<String, dynamic> json) {
    final type = json['type'];
    if (type != typeTag) {
      throw const FormatException('Not a Timmy web TURN grant');
    }
    final version = (json['version'] as num?)?.toInt() ?? currentVersion;
    if (version > currentVersion) {
      throw FormatException('Unsupported TURN grant version: $version');
    }
    final servers = (json['iceServers'] as List)
        .cast<Map>()
        .map((m) => Map<String, dynamic>.from(m))
        .toList();
    return TurnGrant(
      grantId: json['grantId'] as String,
      channel: json['channel'] as String,
      allowedRole: json['allowedRole'] as String,
      iceServers: servers,
      issuedAt: DateTime.parse(json['issuedAt'] as String),
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      notBefore: json['notBefore'] is String
          ? DateTime.parse(json['notBefore'] as String)
          : null,
      mobileNonce: json['mobileNonce'] as String,
      providerHint: json['providerHint'] as String?,
      version: version,
    );
  }

  /// Encrypts this grant with the shared [pairingKey] using AES-256-GCM.
  String encrypt(String pairingKey) =>
      CryptoService.encrypt(jsonEncode(toJson()), pairingKey);

  /// Decrypts a ciphertext produced by [encrypt] back into a [TurnGrant].
  static TurnGrant decrypt(String ciphertext, String pairingKey) {
    final plain = CryptoService.decrypt(ciphertext, pairingKey);
    return TurnGrant.fromJson(jsonDecode(plain) as Map<String, dynamic>);
  }

  /// Generates a 16-byte URL-safe random id, suitable for [grantId] and
  /// [mobileNonce].
  static String randomId() {
    final rng = Random.secure();
    final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
  }

  /// Stable Firestore lookup key: `SHA-256("doc:" + pairingKey)` — identical
  /// to the per-pairing document key already used by the existing pairing
  /// flow. Knowing it requires knowing the `pairingKey`, so the value
  /// itself is suitable as a Firestore "where" filter without leaking
  /// secrets.
  static String pairingDocKey(String pairingKey) =>
      CryptoService.deriveDocumentKey(pairingKey);

  /// Builds the Firestore document body the mobile peer should write.
  ///
  /// `expiresAtMillis` is exposed in clear text so the server-side TTL
  /// cleanup (and the web peer's "skip stale grant" filter) can work
  /// without touching the encrypted payload.
  static Map<String, dynamic> firestoreBody({
    required String pairingKey,
    required TurnGrant grant,
  }) {
    return {
      'pairingDocKey': pairingDocKey(pairingKey),
      'encryptedPayload': grant.encrypt(pairingKey),
      'expiresAtMillis': grant.expiresAt.toUtc().millisecondsSinceEpoch,
      'createdAtMillis': DateTime.now().toUtc().millisecondsSinceEpoch,
      'version': grant.version,
    };
  }
}

/// Defensive helper: derive the same Firestore lookup key from a SHA-256
/// hash without re-using [CryptoService] when the caller only has the raw
/// bytes (kept for API symmetry; not used yet).
@Deprecated('Use TurnGrant.pairingDocKey')
String pairingDocKeyFromBytes(List<int> bytes) =>
    sha256.convert(bytes).toString();
