import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:encrypt/encrypt.dart' as enc;

/// Cryptographic operations for secure pairing.
///
/// - 4-character alphanumeric code as Firebase meeting point
/// - SHA-256 hashes for Firestore keys (code/pairingKey never sent to backend)
/// - AES-256-GCM encryption/decryption of signaling data
class CryptoService {
  static const _codeLength = 4;
  static const _codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

  /// Generate a cryptographically secure 4-character pairing code.
  static String generateSecureCode() {
    final rng = Random.secure();
    return String.fromCharCodes(
      List.generate(
        _codeLength,
        (_) => _codeChars.codeUnitAt(rng.nextInt(_codeChars.length)),
      ),
    );
  }

  /// Derive the Firebase meeting key from the short code.
  /// Used as the Firestore document key for ECDH public key exchange.
  static String deriveMeetingKey(String shortCode) {
    final bytes = utf8.encode('meet:$shortCode');
    return sha256.convert(bytes).toString(); // 64-char hex
  }

  /// Derive the Firestore document key from the pairing key.
  /// Used for persistent pairings and session routing.
  static String deriveDocumentKey(String pairingKey) {
    final bytes = utf8.encode('doc:$pairingKey');
    return sha256.convert(bytes).toString(); // 64-char hex
  }

  /// Derive the Firestore channel name from the document key.
  static String deriveChannel(String documentKey) {
    return 'sbm_${documentKey.substring(0, 8)}';
  }

  /// Strip non-alphanumeric chars and uppercase for code normalization.
  static String normalizeCode(String input) {
    return input.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase().trim();
  }

  /// Derive the AES-256 encryption key from the pairing key.
  static Uint8List _deriveEncryptionKey(String pairingKey) {
    final bytes = utf8.encode('enc:$pairingKey');
    return Uint8List.fromList(sha256.convert(bytes).bytes);
  }

  /// Encrypt a string with AES-256-GCM using a key derived from the pairing key.
  /// Returns a base64-encoded string containing IV + ciphertext + tag.
  static String encrypt(String plaintext, String pairingKey) {
    final keyBytes = _deriveEncryptionKey(pairingKey);
    final key = enc.Key(keyBytes);
    final iv = enc.IV.fromSecureRandom(12); // 96-bit IV for GCM
    final encrypter = enc.Encrypter(enc.AES(key, mode: enc.AESMode.gcm));
    final encrypted = encrypter.encrypt(plaintext, iv: iv);

    // Prepend IV to ciphertext for self-contained decryption
    final combined = Uint8List(iv.bytes.length + encrypted.bytes.length);
    combined.setAll(0, iv.bytes);
    combined.setAll(iv.bytes.length, encrypted.bytes);
    return base64Encode(combined);
  }

  /// Decrypt a base64-encoded AES-256-GCM ciphertext using the pairing key.
  static String decrypt(String ciphertext, String pairingKey) {
    final keyBytes = _deriveEncryptionKey(pairingKey);
    final key = enc.Key(keyBytes);
    final combined = base64Decode(ciphertext);

    final iv = enc.IV(Uint8List.fromList(combined.sublist(0, 12)));
    final encryptedBytes = combined.sublist(12);
    final encrypter = enc.Encrypter(enc.AES(key, mode: enc.AESMode.gcm));
    return encrypter.decrypt(enc.Encrypted(encryptedBytes), iv: iv);
  }
}
