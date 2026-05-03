import 'package:flutter_test/flutter_test.dart';
import 'package:baby_monitor_timmy_core/baby_monitor_timmy_core.dart';

void main() {
  const pairingKey =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  TurnGrant sampleGrant() => TurnGrant(
        grantId: 'grant-abc',
        channel: 'sbm_12345678',
        allowedRole: 'parent',
        iceServers: const [
          {
            'urls': ['turn:example.com:3478?transport=udp'],
            'username': 'u',
            'credential': 'c',
          },
        ],
        issuedAt: DateTime.utc(2026, 5, 3, 12, 0, 0),
        expiresAt: DateTime.utc(2026, 5, 3, 12, 5, 0),
        mobileNonce: 'nonce-xyz',
        webNonce: 'web-nonce-abc',
        accessId: 'access-123',
        providerHint: 'local',
      );

  group('TurnGrant', () {
    test('round-trips through JSON', () {
      final original = sampleGrant();
      final restored = TurnGrant.fromJson(original.toJson());
      expect(restored.grantId, original.grantId);
      expect(restored.channel, original.channel);
      expect(restored.allowedRole, original.allowedRole);
      expect(restored.iceServers, original.iceServers);
      expect(restored.issuedAt, original.issuedAt);
      expect(restored.expiresAt, original.expiresAt);
      expect(restored.mobileNonce, original.mobileNonce);
      expect(restored.webNonce, original.webNonce);
      expect(restored.accessId, original.accessId);
      expect(restored.providerHint, original.providerHint);
      expect(restored.version, TurnGrant.currentVersion);
    });

    test('encrypt/decrypt round-trip with pairingKey', () {
      final original = sampleGrant();
      final ciphertext = original.encrypt(pairingKey);
      expect(ciphertext, isNotEmpty);
      expect(ciphertext, isNot(contains('grant-abc')));

      final restored = TurnGrant.decrypt(ciphertext, pairingKey);
      expect(restored.grantId, 'grant-abc');
      expect(restored.iceServers.first['username'], 'u');
    });

    test('decrypt with wrong key throws', () {
      final ciphertext = sampleGrant().encrypt(pairingKey);
      expect(
        () => TurnGrant.decrypt(ciphertext, 'f' * 64),
        throwsA(anything),
      );
    });

    test('rejects payloads without typeTag', () {
      final json = sampleGrant().toJson()..['type'] = 'something-else';
      expect(() => TurnGrant.fromJson(json), throwsFormatException);
    });

    test('rejects future schema versions', () {
      final json = sampleGrant().toJson()
        ..['version'] = TurnGrant.currentVersion + 1;
      expect(() => TurnGrant.fromJson(json), throwsFormatException);
    });

    test('isCurrentlyValid honors expiresAt and notBefore', () {
      final grant = TurnGrant(
        grantId: 'g',
        channel: 'sbm_xx',
        allowedRole: 'any',
        iceServers: const [],
        issuedAt: DateTime.utc(2026, 1, 1),
        notBefore: DateTime.utc(2026, 1, 2),
        expiresAt: DateTime.utc(2026, 1, 3),
        mobileNonce: 'n',
        webNonce: 'w',
      );
      expect(
          grant.isCurrentlyValid(now: DateTime.utc(2026, 1, 1, 12)), isFalse);
      expect(grant.isCurrentlyValid(now: DateTime.utc(2026, 1, 2, 12)), isTrue);
      expect(grant.isCurrentlyValid(now: DateTime.utc(2026, 1, 3, 1)), isFalse);
    });

    test('pairingDocKey matches CryptoService.deriveDocumentKey', () {
      expect(
        TurnGrant.pairingDocKey(pairingKey),
        CryptoService.deriveDocumentKey(pairingKey),
      );
    });

    test('firestoreBody includes lookup key, ciphertext and TTLs', () {
      final body =
          TurnGrant.firestoreBody(pairingKey: pairingKey, grant: sampleGrant());
      expect(body['pairingDocKey'], TurnGrant.pairingDocKey(pairingKey));
      expect(body['encryptedPayload'], isA<String>());
      expect(body['expiresAtMillis'], isA<int>());
      expect(body['createdAtMillis'], isA<int>());
      expect(body['version'], TurnGrant.currentVersion);
    });

    test('randomId is URL-safe and ~22 chars', () {
      final id = TurnGrant.randomId();
      expect(id.length, greaterThanOrEqualTo(20));
      expect(RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(id), isTrue);
      // Two consecutive ids must not collide.
      expect(id, isNot(TurnGrant.randomId()));
    });
  });
}
