abstract final class WebClientSessionContract {
  static const sessionsCollection = 'web_client_sessions';
  static const mobilesCollection = 'web_client_mobiles';

  static const statusField = 'status';
  static const activeStatus = 'active';
  static const revokedStatus = 'revoked';
  static const expiredStatus = 'expired';

  static const mobileUidField = 'mobileUid';
  static const webUidField = 'webUid';
  static const webSessionIdField = 'webSessionId';
  static const pairingDocKeyField = 'pairingDocKey';
  static const leaseExpiresAtField = 'leaseExpiresAt';
  static const maxExpiresAtField = 'maxExpiresAt';
  static const activeWebUidField = 'activeWebUid';
  static const activeWebSessionIdField = 'activeWebSessionId';
}
