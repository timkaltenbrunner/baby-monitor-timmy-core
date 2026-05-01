import 'package:baby_monitor_timmy_core/baby_monitor_timmy_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('PairData', () {
    test('encode and tryDecode roundtrip', () {
      final pairData = PairData(pairingKey: '0123456789abcdef');

      final decoded = PairData.tryDecode(pairData.encode());

      expect(decoded, isNotNull);
      expect(decoded!.pairingKey, pairData.pairingKey);
      expect(decoded.documentKey,
          CryptoService.deriveDocumentKey(pairData.pairingKey));
      expect(decoded.channel, CryptoService.deriveChannel(decoded.documentKey));
    });

    test('legacy payloads fail gracefully', () {
      expect(PairData.tryDecode('{"legacy":true}'), isNull);
    });

    test('encryptData and decryptData delegate to CryptoService', () {
      final pairData = PairData(pairingKey: 'persistent-pairing-key');
      const plaintext = 'hello timmy';

      final ciphertext = pairData.encryptData(plaintext);

      expect(ciphertext, isNot(plaintext));
      expect(pairData.decryptData(ciphertext), plaintext);
    });
  });
}
