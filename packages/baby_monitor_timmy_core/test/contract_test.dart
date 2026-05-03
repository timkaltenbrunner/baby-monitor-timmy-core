import 'package:baby_monitor_timmy_core/baby_monitor_timmy_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('pairing and signaling contracts expose the documented collection names',
      () {
    expect(PairingContract.pairingCodesCollection, 'pairing_codes');
    expect(PairingContract.pairingsCollection, 'pairings');
    expect(SignalingContract.sessionsCollection, 'sessions');
    expect(SignalingContract.candidatesBabyCollection, 'candidates_baby');
    expect(SignalingContract.candidatesParentCollection, 'candidates_parent');
    expect(WebClientSessionContract.sessionsCollection, 'web_client_sessions');
    expect(WebClientSessionContract.mobilesCollection, 'web_client_mobiles');
  });
}
