import 'package:pointycastle/export.dart';

import 'ecdh_service.dart';
import 'pairing_model.dart';

class LocalPairingKey {
  const LocalPairingKey({
    required this.privateKey,
    required this.publicKey,
  });

  final ECPrivateKey privateKey;
  final String publicKey;
}

class PairingHandshakeResult {
  const PairingHandshakeResult({
    required this.pairingKey,
    required this.sas,
  });

  final String pairingKey;
  final int sas;

  PairData get pairData => PairData(pairingKey: pairingKey);
}

class PairingHandshake {
  const PairingHandshake();

  LocalPairingKey generateLocalKey() {
    final keyPair = EcdhService.generateKeyPair();
    return LocalPairingKey(
      privateKey: keyPair.privateKey,
      publicKey: EcdhService.encodePublicKey(keyPair.publicKey),
    );
  }

  PairingHandshakeResult complete({
    required LocalPairingKey localKey,
    required String remotePublicKey,
  }) {
    final remote = EcdhService.decodePublicKey(remotePublicKey);
    final sharedSecret = EcdhService.computeSharedSecret(
      localKey.privateKey,
      remote,
    );
    return PairingHandshakeResult(
      pairingKey: EcdhService.derivePairingKey(sharedSecret),
      sas: EcdhService.deriveSas(
        sharedSecret,
        localKey.publicKey,
        remotePublicKey,
      ),
    );
  }
}
