import 'dart:convert';

import 'crypto_service.dart';

/// Persistent pairing data derived from ECDH key exchange.
///
/// The [pairingKey] is a 64-char hex string (256-bit) derived from the
/// ECDH shared secret. It is the root of all session-level key derivations.
/// The short 4-char code used during pairing is ephemeral and NOT stored.
class PairData {
  final String pairingKey;

  PairData({required this.pairingKey});

  String get documentKey => CryptoService.deriveDocumentKey(pairingKey);

  String get channel => CryptoService.deriveChannel(documentKey);

  factory PairData.fromJson(Map<String, dynamic> json) {
    if (json.containsKey('pairingKey')) {
      return PairData(pairingKey: json['pairingKey'] as String);
    }
    throw const FormatException('Legacy pairing format — re-pair required');
  }

  Map<String, dynamic> toJson() => {'pairingKey': pairingKey};

  String encode() => jsonEncode(toJson());

  static PairData? tryDecode(String encoded) {
    try {
      return PairData.fromJson(jsonDecode(encoded) as Map<String, dynamic>);
    } on FormatException {
      return null;
    }
  }

  String encryptData(String plaintext) =>
      CryptoService.encrypt(plaintext, pairingKey);

  String decryptData(String ciphertext) =>
      CryptoService.decrypt(ciphertext, pairingKey);
}
