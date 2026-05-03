abstract final class WebAccessContract {
  static const pairAccessCollection = 'pair_access';

  static const pairingDocKeyField = 'pairingDocKey';
  static const uidField = 'uid';
  static const roleField = 'role';
  static const allowedRoleField = 'allowedRole';
  static const webSessionIdField = 'webSessionId';
  static const webNonceField = 'webNonce';
  static const mobileUidField = 'mobileUid';
  static const createdAtField = 'createdAt';
  static const expiresAtField = 'expiresAt';
  static const authorizedAtField = 'authorizedAt';

  static const mobileRole = 'mobile';
  static const webRole = 'web';
  static const anyAllowedRole = 'any';
  static const babyAllowedRole = 'baby';
  static const parentAllowedRole = 'parent';

  static String documentId({
    required String pairingDocKey,
    required String uid,
  }) =>
      '${pairingDocKey}_$uid';
}
