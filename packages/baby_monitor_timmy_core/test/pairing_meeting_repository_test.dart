import 'package:baby_monitor_timmy_core/baby_monitor_timmy_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('PairingMeetingRepository', () {
    test('new meeting point payload replaces stale pubkeys and status', () {
      final data = PairingMeetingRepository.createMeetingPointData(
        uid: 'current-device',
        publicKey: 'current-pubkey',
      );

      expect(data[PairingContract.pubkeysField], {
        'current-device': 'current-pubkey',
      });
      expect(data.containsKey(PairingContract.statusField), isFalse);
      expect(data.containsKey(PairingContract.peerTypeField), isFalse);
      expect(data.containsKey(PairingContract.webUidField), isFalse);
      expect(data.containsKey(PairingContract.webSessionIdField), isFalse);
    });

    test('web meeting point payload contains only current web metadata', () {
      final data = PairingMeetingRepository.createMeetingPointData(
        uid: 'web-device',
        publicKey: 'web-pubkey',
        peerType: PairingContract.webCompanionPeerType,
        webSessionId: 'web-session',
      );

      expect(data[PairingContract.pubkeysField], {
        'web-device': 'web-pubkey',
      });
      expect(
        data[PairingContract.peerTypeField],
        PairingContract.webCompanionPeerType,
      );
      expect(data[PairingContract.webUidField], 'web-device');
      expect(data[PairingContract.webSessionIdField], 'web-session');
      expect(data.containsKey(PairingContract.statusField), isFalse);
    });
  });
}
