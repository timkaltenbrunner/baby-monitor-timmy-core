import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:pointycastle/export.dart';

/// Elliptic Curve Diffie-Hellman key exchange using P-256 (secp256r1).
///
/// Used for secure pairing: ECDH public keys are exchanged over Firebase,
/// private keys never leave the device. Both sides compute the same shared
/// secret from which the pairing key and SAS are derived.
class EcdhService {
  static final _domainParams = ECCurve_secp256r1();

  /// Generate a new ECDH key pair (P-256).
  static AsymmetricKeyPair<ECPublicKey, ECPrivateKey> generateKeyPair() {
    final secureRandom = FortunaRandom();
    final seedBytes = Uint8List(32);
    final rng = Random.secure();
    for (int i = 0; i < 32; i++) {
      seedBytes[i] = rng.nextInt(256);
    }
    secureRandom.seed(KeyParameter(seedBytes));

    final keyGen = ECKeyGenerator()
      ..init(ParametersWithRandom(
        ECKeyGeneratorParameters(_domainParams),
        secureRandom,
      ));

    final pair = keyGen.generateKeyPair();
    return AsymmetricKeyPair(
      pair.publicKey as ECPublicKey,
      pair.privateKey as ECPrivateKey,
    );
  }

  /// Encode a public key as base64url (compressed point, 33 bytes → 44 chars).
  static String encodePublicKey(ECPublicKey publicKey) {
    final compressed = publicKey.Q!.getEncoded(true);
    return base64Url.encode(compressed).replaceAll('=', '');
  }

  /// Decode a base64url-encoded public key back to [ECPublicKey].
  static ECPublicKey decodePublicKey(String encoded) {
    final padded = encoded + '=' * ((4 - encoded.length % 4) % 4);
    final bytes = base64Url.decode(padded);
    final point = _domainParams.curve.decodePoint(bytes);
    return ECPublicKey(point, _domainParams);
  }

  /// Compute the ECDH shared secret (32 bytes).
  static Uint8List computeSharedSecret(
    ECPrivateKey myPrivateKey,
    ECPublicKey remotePublicKey,
  ) {
    final agreement = ECDHBasicAgreement()..init(myPrivateKey);
    final secret = agreement.calculateAgreement(remotePublicKey);
    return _bigIntToBytes(secret, 32);
  }

  /// Derive a 2-digit SAS (Short Authentication String) from the shared secret
  /// and both public keys. Including public keys binds the SAS to the specific
  /// key exchange transcript, providing stronger MITM detection.
  static int deriveSas(
    Uint8List sharedSecret,
    String myPubKeyEncoded,
    String remotePubKeyEncoded,
  ) {
    final sorted = [myPubKeyEncoded, remotePubKeyEncoded]..sort();
    final data = utf8.encode('sas:${sorted[0]}:${sorted[1]}:') + sharedSecret;
    final hash = sha256.convert(data);
    return (hash.bytes[0] << 8 | hash.bytes[1]) % 100;
  }

  /// Derive the persistent pairing key (64-char hex) from the ECDH shared secret.
  /// This is stored in secure storage and used for all session encryption.
  static String derivePairingKey(Uint8List sharedSecret) {
    final hash = sha256.convert(utf8.encode('pair:') + sharedSecret);
    return hash.toString();
  }

  /// Convert BigInt to fixed-length byte array (big-endian, left-padded).
  static Uint8List _bigIntToBytes(BigInt value, int length) {
    final result = Uint8List(length);
    var v = value;
    for (int i = length - 1; i >= 0; i--) {
      result[i] = (v & BigInt.from(0xFF)).toInt();
      v >>= 8;
    }
    return result;
  }
}
