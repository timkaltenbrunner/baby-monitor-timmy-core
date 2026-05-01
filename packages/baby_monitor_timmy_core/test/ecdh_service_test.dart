import 'package:baby_monitor_timmy_core/baby_monitor_timmy_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('EcdhService', () {
    test('both parties derive the same shared secret and pairing key', () {
      final alice = EcdhService.generateKeyPair();
      final bob = EcdhService.generateKeyPair();

      final aliceShared = EcdhService.computeSharedSecret(
        alice.privateKey,
        bob.publicKey,
      );
      final bobShared = EcdhService.computeSharedSecret(
        bob.privateKey,
        alice.publicKey,
      );

      expect(aliceShared, bobShared);
      expect(
        EcdhService.derivePairingKey(aliceShared),
        EcdhService.derivePairingKey(bobShared),
      );
    });

    test('public keys survive encode and decode', () {
      final pair = EcdhService.generateKeyPair();
      final encoded = EcdhService.encodePublicKey(pair.publicKey);
      final decoded = EcdhService.decodePublicKey(encoded);

      expect(EcdhService.encodePublicKey(decoded), encoded);
    });

    test('SAS is identical on both devices', () {
      final alice = EcdhService.generateKeyPair();
      final bob = EcdhService.generateKeyPair();
      final alicePub = EcdhService.encodePublicKey(alice.publicKey);
      final bobPub = EcdhService.encodePublicKey(bob.publicKey);

      final aliceShared = EcdhService.computeSharedSecret(
        alice.privateKey,
        bob.publicKey,
      );
      final bobShared = EcdhService.computeSharedSecret(
        bob.privateKey,
        alice.publicKey,
      );

      expect(
        EcdhService.deriveSas(aliceShared, alicePub, bobPub),
        EcdhService.deriveSas(bobShared, bobPub, alicePub),
      );
    });
  });
}
