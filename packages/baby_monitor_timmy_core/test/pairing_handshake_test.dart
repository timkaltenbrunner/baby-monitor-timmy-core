import 'package:baby_monitor_timmy_core/baby_monitor_timmy_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('two peers complete the same pairing handshake', () {
    const handshake = PairingHandshake();
    final alice = handshake.generateLocalKey();
    final bob = handshake.generateLocalKey();

    final aliceResult = handshake.complete(
      localKey: alice,
      remotePublicKey: bob.publicKey,
    );
    final bobResult = handshake.complete(
      localKey: bob,
      remotePublicKey: alice.publicKey,
    );

    expect(aliceResult.pairingKey, bobResult.pairingKey);
    expect(aliceResult.sas, bobResult.sas);
    expect(aliceResult.pairData.channel, startsWith('sbm_'));
    expect(alice.publicKey, isNot(bob.publicKey));
  });
}
