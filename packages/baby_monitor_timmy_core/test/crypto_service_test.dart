import 'package:baby_monitor_timmy_core/baby_monitor_timmy_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('CryptoService', () {
    test('generateSecureCode uses the expected alphabet', () {
      final codePattern = RegExp(r'^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$');

      for (var i = 0; i < 50; i++) {
        expect(CryptoService.generateSecureCode(), matches(codePattern));
      }
    });

    test('derive helpers are deterministic and stable', () {
      final meetingKey = CryptoService.deriveMeetingKey('ABCD');
      final documentKey = CryptoService.deriveDocumentKey('pairing-key');

      expect(CryptoService.deriveMeetingKey('ABCD'), meetingKey);
      expect(CryptoService.deriveDocumentKey('pairing-key'), documentKey);
      expect(meetingKey, hasLength(64));
      expect(documentKey, hasLength(64));
      expect(CryptoService.deriveChannel(documentKey),
          'sbm_${documentKey.substring(0, 8)}');
    });

    test('normalizeCode strips separators and uppercases', () {
      expect(CryptoService.normalizeCode(' ab-c 2d '), 'ABC2D');
      expect(CryptoService.normalizeCode('o0i1'), 'O0I1');
    });

    test('encrypt and decrypt roundtrip with the same pairing key', () {
      const pairingKey = 'pairing-key-123';
      const plaintext = '{"offer":"encrypted"}';

      final ciphertext = CryptoService.encrypt(plaintext, pairingKey);

      expect(ciphertext, isNot(plaintext));
      expect(CryptoService.decrypt(ciphertext, pairingKey), plaintext);
      expect(
        () => CryptoService.decrypt(ciphertext, 'different-pairing-key'),
        throwsA(anything),
      );
    });
  });
}
